// =============================================================================
// tools.js  ->  App.Tools
// PIXEL AI COMPANY ("NEON//WORKS") — sandboxed, time-limited BROWSER TOOLS that
// LLM workers can call (Anthropic tool-use format). Pure, self-contained, with
// NO access to App state or the DOM from within executed code.
//
// LOAD ORDER: after markdown.js, before pixelart.js. NO deps on other modules
// except a soft read of App.config.TOOLS_ENABLED + App.state.settings.
//
// CONTRACT:
//   App.Tools.specs()            -> [ {name, description, input_schema}, ... ]
//                                    (Anthropic-format client tool definitions)
//   App.Tools.run(name, input)   -> Promise<{ok, output, error?}>
//   App.Tools.enabled()          -> boolean (config flag && settings allow)
//
// TOOLS:
//   calc(expression)        -> safe arithmetic evaluation (no scope, validated)
//   run_js(code)            -> run JS in a Web Worker w/ hard timeout (~2s),
//                              capturing console.* + the returned value
//   analyze_data(text)      -> parse CSV/JSON, summarize rows/cols + numeric
//                              column min/max/mean
//
// SAFETY: every tool is sandboxed and time-limited; nothing here ever hangs,
// touches App/DOM from executed user code, or throws into the rAF loop.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  var WORKER_TIMEOUT_MS = 2000; // hard cap for run_js execution

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  function ok(output) { return { ok: true, output: String(output == null ? '' : output) }; }
  function fail(error) {
    var e = (error && error.message) ? error.message : String(error == null ? 'error' : error);
    return { ok: false, output: '', error: e };
  }

  function num(n) {
    // Compact numeric formatting: integers stay integers, floats trimmed.
    if (!isFinite(n)) return String(n);
    if (Math.floor(n) === n) return String(n);
    return String(Math.round(n * 1e6) / 1e6);
  }

  // ---------------------------------------------------------------------------
  // calc — safe arithmetic. Whitelist characters, then evaluate in an empty
  // scope. No identifiers (no Math, no names) are allowed through the regex, so
  // there is no way to reach globals/scope; we additionally call with no `this`.
  // Supports + - * / % ( ) and decimal / exponent (e) numbers.
  // ---------------------------------------------------------------------------
  var CALC_RE = /^[\s0-9eE.+\-*/%()]+$/;

  function calc(expr) {
    expr = String(expr == null ? '' : expr).trim();
    if (!expr) return fail('empty expression');
    if (expr.length > 1000) return fail('expression too long');
    if (!CALC_RE.test(expr)) return fail('expression contains invalid characters (only numbers and + - * / % ( ) . e are allowed)');
    // Guard against 'e' used as a bare identifier (e.g. "e+1"): must be digit-e-digit.
    // Strip valid scientific notation, then ensure no stray letters remain.
    var stripped = expr.replace(/\d(?:\.\d+)?[eE][+\-]?\d+/g, '0');
    if (/[eE]/.test(stripped)) return fail('invalid use of exponent notation');
    var fn, result;
    try {
      // Indirect, scope-free evaluation. Input is character-whitelisted above.
      fn = new Function('"use strict"; return (' + expr + ');');
      result = fn.call(null);
    } catch (err) {
      return fail('could not evaluate: ' + (err && err.message ? err.message : err));
    }
    if (typeof result !== 'number' || !isFinite(result)) {
      return fail('result is not a finite number');
    }
    return ok(num(result));
  }

  // ---------------------------------------------------------------------------
  // run_js — execute arbitrary JS in a throwaway Web Worker with a hard timeout.
  // Captures console.log/info/warn/error output and the final returned value.
  // The Worker has no DOM and no access to App; it is terminated unconditionally
  // when done or on timeout, so it can never hang the page.
  // ---------------------------------------------------------------------------
  function buildWorkerSource() {
    // The Worker body. Kept as a plain string so it can be Blob-ified.
    // It wraps user code in a function, redirects console, runs it, and posts
    // back { logs, result }. ASCII only; no control bytes.
    return [
      'self.onmessage = function (ev) {',
      '  var code = ev.data && ev.data.code;',
      '  var logs = [];',
      '  function fmt(a) {',
      '    try {',
      '      if (typeof a === "string") return a;',
      '      if (a === undefined) return "undefined";',
      '      return JSON.stringify(a);',
      '    } catch (e) { return String(a); }',
      '  }',
      '  function rec(level) {',
      '    return function () {',
      '      var parts = [];',
      '      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));',
      '      logs.push((level ? "[" + level + "] " : "") + parts.join(" "));',
      '    };',
      '  }',
      '  var console = { log: rec(""), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("") };',
      '  self.console = console;',
      '  var result, errMsg = null;',
      '  try {',
      '    var fn = new Function("console", "\\"use strict\\";" + code);',
      '    result = fn(console);',
      '  } catch (e) {',
      '    errMsg = (e && e.message) ? e.message : String(e);',
      '  }',
      '  var resultStr;',
      '  try {',
      '    if (result === undefined) resultStr = "undefined";',
      '    else if (typeof result === "string") resultStr = result;',
      '    else resultStr = JSON.stringify(result);',
      '  } catch (e2) { resultStr = String(result); }',
      '  self.postMessage({ logs: logs, result: resultStr, error: errMsg });',
      '};'
    ].join('\n');
  }

  function runJs(code) {
    code = String(code == null ? '' : code);
    if (!code.trim()) return Promise.resolve(fail('empty code'));
    if (code.length > 100000) return Promise.resolve(fail('code too long'));

    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return Promise.resolve(fail('Web Worker sandbox is unavailable in this environment'));
    }

    return new Promise(function (resolve) {
      var worker = null, url = null, timer = null, settled = false;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
        if (url) { try { URL.revokeObjectURL(url); } catch (e2) {} url = null; }
      }
      function done(res) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      }

      try {
        var blob = new Blob([buildWorkerSource()], { type: 'application/javascript' });
        url = URL.createObjectURL(blob);
        worker = new Worker(url);
      } catch (err) {
        cleanup();
        resolve(fail('could not create sandbox: ' + (err && err.message ? err.message : err)));
        return;
      }

      worker.onmessage = function (ev) {
        var d = ev.data || {};
        var logs = (d.logs && d.logs.length) ? d.logs.join('\n') : '';
        if (d.error) {
          var out = logs ? (logs + '\n') : '';
          done({ ok: false, output: out, error: d.error });
          return;
        }
        var pieces = [];
        if (logs) pieces.push(logs);
        pieces.push('=> ' + (d.result == null ? 'undefined' : d.result));
        done(ok(pieces.join('\n')));
      };

      worker.onerror = function (e) {
        var msg = (e && e.message) ? e.message : 'worker error';
        try { e.preventDefault && e.preventDefault(); } catch (ignore) {}
        done(fail(msg));
      };

      timer = setTimeout(function () {
        done(fail('execution timed out after ' + WORKER_TIMEOUT_MS + 'ms'));
      }, WORKER_TIMEOUT_MS);

      try {
        worker.postMessage({ code: code });
      } catch (err2) {
        done(fail('could not start sandbox: ' + (err2 && err2.message ? err2.message : err2)));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // analyze_data — parse CSV or JSON text, return a summary: row/column counts
  // and, for each numeric column, min/max/mean. Auto-detects format.
  // ---------------------------------------------------------------------------
  function looksLikeJson(text) {
    var t = text.trim();
    return t.charAt(0) === '{' || t.charAt(0) === '[';
  }

  // Minimal RFC-4180-ish CSV row parser (handles quoted fields, escaped quotes,
  // embedded commas/newlines). Returns array of rows, each an array of strings.
  function parseCsv(text) {
    var rows = [], row = [], field = '', i = 0, c, inQuotes = false;
    var n = text.length;
    while (i < n) {
      c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    // flush trailing field/row
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  function isNumericStr(s) {
    if (s == null) return false;
    s = String(s).trim();
    if (s === '') return false;
    return !isNaN(Number(s)) && isFinite(Number(s));
  }

  function summarizeColumns(headers, records) {
    // records: array of objects keyed by header
    var lines = [];
    for (var h = 0; h < headers.length; h++) {
      var key = headers[h];
      var vals = [];
      for (var r = 0; r < records.length; r++) {
        var v = records[r][key];
        if (isNumericStr(v)) vals.push(Number(v));
      }
      if (vals.length === 0) {
        lines.push('  ' + key + ': non-numeric (' + records.length + ' values)');
        continue;
      }
      var min = vals[0], max = vals[0], sum = 0;
      for (var k = 0; k < vals.length; k++) {
        if (vals[k] < min) min = vals[k];
        if (vals[k] > max) max = vals[k];
        sum += vals[k];
      }
      var mean = sum / vals.length;
      lines.push('  ' + key + ': numeric n=' + vals.length +
        ' min=' + num(min) + ' max=' + num(max) + ' mean=' + num(mean));
    }
    return lines;
  }

  function analyzeData(text) {
    text = String(text == null ? '' : text);
    if (!text.trim()) return fail('empty data');
    if (text.length > 2000000) return fail('data too large (max 2MB)');

    try {
      if (looksLikeJson(text)) {
        var data = JSON.parse(text);
        var arr;
        if (Array.isArray(data)) {
          arr = data;
        } else if (data && typeof data === 'object') {
          // Single object, or an object wrapping an array — try to find an array.
          var inner = null;
          for (var kk in data) {
            if (data.hasOwnProperty(kk) && Array.isArray(data[kk])) { inner = data[kk]; break; }
          }
          arr = inner || [data];
        } else {
          return ok('JSON scalar value: ' + JSON.stringify(data));
        }
        if (arr.length === 0) return ok('JSON array is empty (0 rows).');

        // Collect union of keys across object rows.
        var allObjects = true, headerSet = {};
        for (var a = 0; a < arr.length; a++) {
          if (arr[a] && typeof arr[a] === 'object' && !Array.isArray(arr[a])) {
            for (var hk in arr[a]) if (arr[a].hasOwnProperty(hk)) headerSet[hk] = true;
          } else { allObjects = false; }
        }
        if (!allObjects) {
          // Array of scalars: treat as one numeric column.
          var recs = [];
          for (var s = 0; s < arr.length; s++) recs.push({ value: arr[s] });
          var out0 = ['JSON array of ' + arr.length + ' scalar values (1 column):'];
          out0 = out0.concat(summarizeColumns(['value'], recs));
          return ok(out0.join('\n'));
        }
        var headers = Object.keys(headerSet);
        var out1 = ['JSON: ' + arr.length + ' rows, ' + headers.length + ' columns.',
          'Columns:'];
        out1 = out1.concat(summarizeColumns(headers, arr));
        return ok(out1.join('\n'));
      }

      // CSV path
      var rows = parseCsv(text);
      if (rows.length === 0) return fail('no rows parsed');
      var headerRow = rows[0];
      var body = rows.slice(1);
      // Build records keyed by header.
      var records = [];
      for (var b = 0; b < body.length; b++) {
        // skip fully empty trailing rows
        var rr = body[b];
        var allEmpty = true;
        for (var e = 0; e < rr.length; e++) { if (String(rr[e]).trim() !== '') { allEmpty = false; break; } }
        if (allEmpty) continue;
        var obj = {};
        for (var ci = 0; ci < headerRow.length; ci++) obj[headerRow[ci]] = rr[ci];
        records.push(obj);
      }
      var out2 = ['CSV: ' + records.length + ' rows, ' + headerRow.length + ' columns.',
        'Columns:'];
      out2 = out2.concat(summarizeColumns(headerRow, records));
      return ok(out2.join('\n'));
    } catch (err) {
      return fail('could not parse data: ' + (err && err.message ? err.message : err));
    }
  }

  // ---------------------------------------------------------------------------
  // public: enabled()
  // ---------------------------------------------------------------------------
  function enabled() {
    try {
      var cfg = App.config || {};
      var cfgOn = (cfg.TOOLS_ENABLED === undefined) ? true : !!cfg.TOOLS_ENABLED;
      if (!cfgOn) return false;
      var st = App.state || {};
      var settings = st.settings || {};
      // settings.toolsEnabled is optional; only disables when explicitly false.
      if (settings.toolsEnabled === false) return false;
      return true;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------------------
  // public: specs() — Anthropic tool-use definitions.
  // ---------------------------------------------------------------------------
  function specs() {
    return [
      {
        name: 'calc',
        description: 'Evaluate a mathematical arithmetic expression and return the numeric result. ' +
          'Supports + - * / % parentheses and decimal/scientific numbers. Use for any precise arithmetic.',
        input_schema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'The arithmetic expression to evaluate, e.g. "(3 + 4) * 2 / 7".' }
          },
          required: ['expression']
        }
      },
      {
        name: 'run_js',
        description: 'Run a snippet of sandboxed JavaScript in an isolated Web Worker (no DOM, no network) ' +
          'with a hard ~2s timeout. Returns captured console output and the value of the final expression ' +
          '(use a trailing return or console.log). Use for computation, string/data processing, or quick logic checks.',
        input_schema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript source to execute. End with `return <value>;` to capture a result.' }
          },
          required: ['code']
        }
      },
      {
        name: 'analyze_data',
        description: 'Parse CSV or JSON text and return summary statistics: number of rows and columns, and for ' +
          'each numeric column the count, min, max, and mean. Format (CSV vs JSON) is auto-detected.',
        input_schema: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'The raw CSV or JSON text to analyze.' }
          },
          required: ['data']
        }
      }
    ];
  }

  // ---------------------------------------------------------------------------
  // public: run(name, input) -> Promise<{ok, output, error?}>
  // ---------------------------------------------------------------------------
  function run(name, input) {
    try {
      input = input || {};
      switch (name) {
        case 'calc':
          return Promise.resolve(calc(input.expression !== undefined ? input.expression : input.expr));
        case 'run_js':
          return runJs(input.code !== undefined ? input.code : input.js);
        case 'analyze_data':
          return Promise.resolve(analyzeData(input.data !== undefined ? input.data : input.text));
        default:
          return Promise.resolve(fail('unknown tool: ' + name));
      }
    } catch (err) {
      return Promise.resolve(fail('tool execution error: ' + (err && err.message ? err.message : err)));
    }
  }

  // ---------------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------------
  App.Tools = {
    specs: specs,
    run: run,
    enabled: enabled,
    // exposed for testing / direct use:
    _calc: calc,
    _runJs: runJs,
    _analyzeData: analyzeData
  };
})();
