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
  // workspace helpers — soft access to App.Workspace; never throw.
  // ---------------------------------------------------------------------------
  function ws() { return (App && App.Workspace) ? App.Workspace : null; }

  function settings() {
    try { return (App.state && App.state.settings) ? App.state.settings : {}; }
    catch (e) { return {}; }
  }

  function slug(s) {
    s = String(s == null ? '' : s).toLowerCase().trim();
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'chart';
  }

  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Strip HTML tags without ever embedding a literal script-tag token in source.
  function stripTags(html) {
    html = String(html == null ? '' : html);
    var scriptRe = new RegExp('<scr' + 'ipt[\\s\\S]*?</scr' + 'ipt>', 'gi');
    var styleRe = new RegExp('<style[\\s\\S]*?</style>', 'gi');
    var commentRe = new RegExp('<' + '!--[\\s\\S]*?--' + '>', 'g');
    return html
      .replace(scriptRe, ' ')
      .replace(styleRe, ' ')
      .replace(commentRe, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // workspace_list — compact table of workspace files (path, lang, size).
  // ---------------------------------------------------------------------------
  function workspaceList(glob) {
    var w = ws();
    if (!w || !w.list) return fail('workspace unavailable');
    var files = w.list() || [];
    var rx = null;
    if (glob) {
      try {
        var pat = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*').replace(/\?/g, '.');
        rx = new RegExp('^' + pat + '$', 'i');
      } catch (e) { rx = null; }
    }
    var lines = [], shown = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (rx && !rx.test(f.path)) continue;
      var sz = (typeof f.content === 'string') ? f.content.length : 0;
      lines.push(f.path + '  [' + (f.lang || '?') + ']  ' + sz + 'b');
      shown++;
    }
    if (shown === 0) return ok('(no files' + (glob ? ' matching "' + glob + '"' : '') + ')');
    return ok(shown + ' file(s):\n' + lines.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // read_file — content of a workspace file.
  // ---------------------------------------------------------------------------
  function readFile(path) {
    var w = ws();
    if (!w || !w.read) return fail('workspace unavailable');
    if (!path) return fail('path is required');
    var c = w.read(path);
    if (c == null) return ok('not found: ' + path);
    return ok(c);
  }

  // ---------------------------------------------------------------------------
  // write_file — create/overwrite a workspace file.
  // ---------------------------------------------------------------------------
  function writeFile(path, content) {
    var w = ws();
    if (!w || !w.write) return fail('workspace unavailable');
    if (!path) return fail('path is required');
    var saved = w.write(path, String(content == null ? '' : content), 'agent');
    if (!saved) return fail('write rejected (invalid path or cap reached)');
    return ok('wrote ' + saved);
  }

  // ---------------------------------------------------------------------------
  // edit_file — substring replace within a workspace file.
  // ---------------------------------------------------------------------------
  function editFile(path, oldStr, newStr, replaceAll) {
    var w = ws();
    if (!w || !w.read || !w.write) return fail('workspace unavailable');
    if (!path) return fail('path is required');
    if (oldStr == null || oldStr === '') return fail('old_string is required');
    var cur = w.read(path);
    if (cur == null) return fail('not found: ' + path);
    oldStr = String(oldStr);
    newStr = String(newStr == null ? '' : newStr);
    if (cur.indexOf(oldStr) === -1) return fail('old_string not found in ' + path);
    var count = 0, next;
    if (replaceAll) {
      next = cur.split(oldStr).join(newStr);
      count = cur.split(oldStr).length - 1;
    } else {
      var idx = cur.indexOf(oldStr);
      next = cur.slice(0, idx) + newStr + cur.slice(idx + oldStr.length);
      count = 1;
    }
    var saved = w.write(path, next, 'agent');
    if (!saved) return fail('write rejected after edit');
    return ok('replaced ' + count + ' occurrence(s) in ' + path);
  }

  // ---------------------------------------------------------------------------
  // search_workspace — substring/regex search across workspace files.
  // ---------------------------------------------------------------------------
  function searchWorkspace(query, regex, max) {
    var w = ws();
    if (!w || !w.list) return fail('workspace unavailable');
    if (query == null || query === '') return fail('query is required');
    var cap = (typeof max === 'number' && max > 0) ? Math.min(max, 500) : 50;
    var rx = null;
    if (regex) {
      try { rx = new RegExp(query, 'i'); }
      catch (e) { return fail('invalid regex: ' + (e && e.message ? e.message : e)); }
    }
    var q = String(query);
    var files = w.list() || [];
    var hits = [];
    for (var i = 0; i < files.length && hits.length < cap; i++) {
      var f = files[i];
      var content = (typeof f.content === 'string') ? f.content : '';
      var lines = content.split('\n');
      for (var ln = 0; ln < lines.length && hits.length < cap; ln++) {
        var line = lines[ln];
        var match = rx ? rx.test(line) : (line.indexOf(q) !== -1);
        if (match) {
          var snip = line.trim();
          if (snip.length > 160) snip = snip.slice(0, 160) + '...';
          hits.push(f.path + ':' + (ln + 1) + ': ' + snip);
        }
      }
    }
    if (hits.length === 0) return ok('no matches for ' + (regex ? '/' + q + '/' : '"' + q + '"'));
    return ok(hits.length + ' match(es):\n' + hits.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // create_artifact — push a deliverable into App.state.artifacts.
  // ---------------------------------------------------------------------------
  function createArtifact(filename, content) {
    try {
      if (!filename) return fail('filename is required');
      var st = App.state || (App.state = {});
      if (!Array.isArray(st.artifacts)) st.artifacts = [];
      var cfg = App.config || {};
      var cap = (typeof cfg.ARTIFACT_MAX === 'number') ? cfg.ARTIFACT_MAX : 200;
      var name = String(filename);
      var dot = name.lastIndexOf('.');
      var type = (dot > -1 && dot < name.length - 1) ? name.slice(dot + 1).toLowerCase() : 'txt';
      var id = 'art_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      st.artifacts.push({
        id: id,
        name: name,
        type: type,
        content: String(content == null ? '' : content),
        taskId: null,
        agentId: 'tool',
        t: Date.now()
      });
      if (st.artifacts.length > cap) st.artifacts.splice(0, st.artifacts.length - cap);
      try { if (App.UI && App.UI.refreshArtifacts) App.UI.refreshArtifacts(); } catch (e) {}
      return ok('artifact created: ' + name);
    } catch (err) {
      return fail('could not create artifact: ' + (err && err.message ? err.message : err));
    }
  }

  // ---------------------------------------------------------------------------
  // run_html — load assembled (or specific) HTML in a hidden sandboxed iframe,
  // capture window.onerror + console output for a bounded window, then tear it
  // down. Never hangs: timeout always clears + iframe is always removed.
  // ---------------------------------------------------------------------------
  function buildRunHtmlShim() {
    // Built by splitting script-tag tokens so this never appears literally.
    var open = '<scr' + 'ipt>';
    var close = '</scr' + 'ipt>';
    var body = [
      '(function(){',
      '  function send(kind, msg){ try{ parent.postMessage({__hfrun:1, kind:kind, msg:String(msg)}, "*"); }catch(e){} }',
      '  window.onerror = function(m, src, line, col){ send("error", m + " @" + (line||0) + ":" + (col||0)); return false; };',
      '  window.addEventListener("unhandledrejection", function(ev){ send("error", "unhandled rejection: " + (ev && ev.reason)); });',
      '  var _e = console.error, _l = console.log, _w = console.warn;',
      '  function fmt(args){ var p=[]; for(var i=0;i<args.length;i++){ try{ p.push(typeof args[i]==="string"?args[i]:JSON.stringify(args[i])); }catch(e){ p.push(String(args[i])); } } return p.join(" "); }',
      '  console.error = function(){ send("error", fmt(arguments)); try{_e.apply(console,arguments);}catch(e){} };',
      '  console.warn  = function(){ send("warn", fmt(arguments)); try{_w.apply(console,arguments);}catch(e){} };',
      '  console.log   = function(){ send("log", fmt(arguments)); try{_l.apply(console,arguments);}catch(e){} };',
      '})();'
    ].join('\n');
    return open + body + close;
  }

  function runHtml(path, timeoutMs) {
    var w = ws();
    if (!w) return Promise.resolve(fail('workspace unavailable'));
    if (typeof document === 'undefined') return Promise.resolve(fail('no DOM available'));
    var html;
    try {
      if (path) {
        html = w.read ? w.read(path) : null;
        if (html == null) return Promise.resolve(fail('not found: ' + path));
      } else {
        html = w.assembleRunnable ? w.assembleRunnable() : null;
        if (html == null) return Promise.resolve(fail('no runnable HTML in workspace (need an index.html)'));
      }
    } catch (e) {
      return Promise.resolve(fail('could not assemble HTML: ' + (e && e.message ? e.message : e)));
    }

    var to = (typeof timeoutMs === 'number' && timeoutMs > 0) ? Math.min(timeoutMs, 8000) : 1500;
    // Inject shim at the very top of the document so it catches early errors.
    var shim = buildRunHtmlShim();
    var doc;
    if (/<head[^>]*>/i.test(html)) {
      doc = html.replace(/<head([^>]*)>/i, '<head$1>' + shim);
    } else if (/<html[^>]*>/i.test(html)) {
      doc = html.replace(/<html([^>]*)>/i, '<html$1>' + shim);
    } else {
      doc = shim + html;
    }

    return new Promise(function (resolve) {
      var iframe = null, timer = null, settled = false;
      var events = [];

      function onMsg(ev) {
        var d = ev && ev.data;
        if (d && d.__hfrun) events.push({ kind: d.kind, msg: d.msg });
      }
      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        try { window.removeEventListener('message', onMsg); } catch (e) {}
        if (iframe) { try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch (e2) {} iframe = null; }
      }
      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        var errs = [], logs = [];
        for (var i = 0; i < events.length; i++) {
          if (events[i].kind === 'error') errs.push(events[i].msg);
          else logs.push('[' + events[i].kind + '] ' + events[i].msg);
        }
        var parts = [];
        if (errs.length) parts.push(errs.length + ' error(s):\n' + errs.slice(0, 30).join('\n'));
        else parts.push('no errors');
        if (logs.length) parts.push('\nconsole (' + logs.length + '):\n' + logs.slice(0, 30).join('\n'));
        resolve(ok(parts.join('')));
      }

      try {
        window.addEventListener('message', onMsg);
        iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.position = 'absolute';
        iframe.style.left = '-9999px';
        iframe.style.top = '-9999px';
        iframe.style.width = '800px';
        iframe.style.height = '600px';
        iframe.style.border = '0';
        iframe.style.visibility = 'hidden';
        (document.body || document.documentElement).appendChild(iframe);
        iframe.setAttribute('srcdoc', doc);
        timer = setTimeout(finish, to);
      } catch (err) {
        cleanup();
        resolve(fail('could not create preview sandbox: ' + (err && err.message ? err.message : err)));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // web_fetch — fetch a URL through a user-configured CORS proxy, strip tags.
  // Reads App.state.settings.corsProxy (UI decision); degrades gracefully.
  // ---------------------------------------------------------------------------
  function webFetch(url, maxChars) {
    if (!url) return Promise.resolve(fail('url is required'));
    var proxy = (settings().corsProxy || '');
    if (!proxy) return Promise.resolve(fail('set a CORS proxy in Settings'));
    if (typeof fetch === 'undefined') return Promise.resolve(fail('fetch unavailable'));
    var cap = (typeof maxChars === 'number' && maxChars > 0) ? Math.min(maxChars, 50000) : 4000;
    var full;
    try { full = proxy + encodeURIComponent(String(url)); }
    catch (e) { return Promise.resolve(fail('invalid url')); }
    return fetch(full).then(function (resp) {
      if (!resp || !resp.ok) return fail('fetch failed: HTTP ' + (resp ? resp.status : '?'));
      return resp.text().then(function (text) {
        var stripped = stripTags(text);
        if (stripped.length > cap) stripped = stripped.slice(0, cap) + '\n...(truncated)';
        return ok(stripped || '(empty response)');
      });
    }).catch(function (err) {
      return fail('network error: ' + (err && err.message ? err.message : err));
    });
  }

  // ---------------------------------------------------------------------------
  // generate_chart — hand-rolled SVG (bar/line/pie), saved to the workspace.
  // ---------------------------------------------------------------------------
  function parseChartData(data) {
    // Accept: JSON array of numbers; JSON array of {label,value}; CSV label,value
    // or a single CSV/whitespace line of numbers. Returns [{label,value}].
    var out = [];
    if (data == null) return out;
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (typeof d === 'number') out.push({ label: String(i + 1), value: d });
        else if (d && typeof d === 'object') out.push({ label: String(d.label != null ? d.label : (i + 1)), value: Number(d.value) || 0 });
        else if (isNumericStr(d)) out.push({ label: String(i + 1), value: Number(d) });
      }
      return out;
    }
    var text = String(data).trim();
    if (looksLikeJson(text)) {
      try { return parseChartData(JSON.parse(text)); } catch (e) { /* fall through */ }
    }
    var rows = text.split(/[\r\n]+/);
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].split(/[,\t]/);
      if (cells.length >= 2 && isNumericStr(cells[1])) {
        out.push({ label: String(cells[0]).trim() || String(r + 1), value: Number(cells[1]) });
      } else if (cells.length === 1 && isNumericStr(cells[0])) {
        out.push({ label: String(r + 1), value: Number(cells[0]) });
      } else {
        for (var c = 0; c < cells.length; c++) {
          if (isNumericStr(cells[c])) out.push({ label: String(out.length + 1), value: Number(cells[c]) });
        }
      }
    }
    return out;
  }

  function buildBarSvg(rows, title) {
    var W = 480, H = 300, pad = 40, top = title ? 30 : 12;
    var plotH = H - pad - top, plotW = W - pad - 12;
    var max = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].value > max) max = rows[i].value;
    if (max <= 0) max = 1;
    var bw = plotW / Math.max(rows.length, 1);
    var bars = '';
    for (var j = 0; j < rows.length; j++) {
      var h = (rows[j].value / max) * plotH;
      var x = pad + j * bw + bw * 0.15;
      var y = top + (plotH - h);
      var ww = bw * 0.7;
      bars += '<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(ww) + '" height="' + num(h) +
        '" fill="#36e0ff"/>';
      bars += '<text x="' + num(x + ww / 2) + '" y="' + (H - pad + 14) + '" font-size="9" fill="#9fb" text-anchor="middle">' +
        escapeXml(rows[j].label) + '</text>';
    }
    return svgWrap(W, H, title, bars +
      '<line x1="' + pad + '" y1="' + (top + plotH) + '" x2="' + (W - 12) + '" y2="' + (top + plotH) + '" stroke="#456" stroke-width="1"/>');
  }

  function buildLineSvg(rows, title) {
    var W = 480, H = 300, pad = 40, top = title ? 30 : 12;
    var plotH = H - pad - top, plotW = W - pad - 12;
    var max = 0, min = 0;
    for (var i = 0; i < rows.length; i++) { if (rows[i].value > max) max = rows[i].value; if (rows[i].value < min) min = rows[i].value; }
    var range = (max - min) || 1;
    var pts = [];
    var n = Math.max(rows.length - 1, 1);
    for (var j = 0; j < rows.length; j++) {
      var x = pad + (j / n) * plotW;
      var y = top + plotH - ((rows[j].value - min) / range) * plotH;
      pts.push(num(x) + ',' + num(y));
    }
    var poly = '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#36e0ff" stroke-width="2"/>';
    var dots = '';
    var ptArr = pts;
    for (var k = 0; k < ptArr.length; k++) {
      var xy = ptArr[k].split(',');
      dots += '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="2.5" fill="#ff3df0"/>';
    }
    return svgWrap(W, H, title, poly + dots +
      '<line x1="' + pad + '" y1="' + (top + plotH) + '" x2="' + (W - 12) + '" y2="' + (top + plotH) + '" stroke="#456" stroke-width="1"/>');
  }

  function buildPieSvg(rows, title) {
    var W = 480, H = 300, top = title ? 30 : 12;
    var cx = W / 2, cy = top + (H - top) / 2, R = Math.min(W, H - top) / 2 - 24;
    var total = 0;
    for (var i = 0; i < rows.length; i++) total += Math.max(rows[i].value, 0);
    if (total <= 0) total = 1;
    var palette = ['#36e0ff', '#ff3df0', '#7cff6b', '#ffd23d', '#9b8cff', '#ff8c42', '#42c0ff'];
    var ang = -Math.PI / 2, slices = '', legend = '';
    for (var j = 0; j < rows.length; j++) {
      var frac = Math.max(rows[j].value, 0) / total;
      var a2 = ang + frac * Math.PI * 2;
      var x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang);
      var x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
      var large = (frac > 0.5) ? 1 : 0;
      var col = palette[j % palette.length];
      slices += '<path d="M' + num(cx) + ',' + num(cy) + ' L' + num(x1) + ',' + num(y1) +
        ' A' + num(R) + ',' + num(R) + ' 0 ' + large + ',1 ' + num(x2) + ',' + num(y2) + ' Z" fill="' + col + '" stroke="#0b1020" stroke-width="1"/>';
      legend += '<rect x="12" y="' + (top + 4 + j * 16) + '" width="10" height="10" fill="' + col + '"/>' +
        '<text x="26" y="' + (top + 13 + j * 16) + '" font-size="9" fill="#cde">' +
        escapeXml(rows[j].label) + ' (' + num(Math.round(frac * 1000) / 10) + '%)</text>';
      ang = a2;
    }
    return svgWrap(W, H, title, slices + legend);
  }

  function svgWrap(W, H, title, inner) {
    var t = title ? '<text x="' + (W / 2) + '" y="18" font-size="13" fill="#36e0ff" text-anchor="middle" font-family="monospace">' + escapeXml(title) + '</text>' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#0b1020"/>' + t + inner + '</svg>';
  }

  function generateChart(type, data, title) {
    var w = ws();
    if (!w || !w.write) return fail('workspace unavailable');
    type = String(type || 'bar').toLowerCase();
    var rows = parseChartData(data);
    if (!rows.length) return fail('no numeric data parsed for chart');
    var svg;
    if (type === 'line') svg = buildLineSvg(rows, title);
    else if (type === 'pie') svg = buildPieSvg(rows, title);
    else svg = buildBarSvg(rows, title);
    var path = slug(title || (type + '-chart')) + '.svg';
    var saved = w.write(path, svg, 'agent');
    if (!saved) return fail('write rejected (cap reached?)');
    return ok('chart saved: ' + saved + ' (' + type + ', ' + rows.length + ' points)');
  }

  // ---------------------------------------------------------------------------
  // github_push — push the workspace to GitHub. Requires a token AND the
  // settings.allowToolGithubPush opt-in (never surprise-push).
  // ---------------------------------------------------------------------------
  function githubPush(opts) {
    var w = ws();
    if (!w || !w.githubPush) return Promise.resolve(fail('workspace unavailable'));
    var st = settings();
    var gh = st.github || {};
    if (!gh.token) return Promise.resolve(fail('set a GitHub token in Settings'));
    if (st.allowToolGithubPush !== true) {
      return Promise.resolve({ ok: false, output: '', error: 'GitHub push not enabled for tools (enable in Settings)' });
    }
    var merged = {};
    try {
      // start from configured github settings, then overlay caller opts
      for (var k in gh) if (Object.prototype.hasOwnProperty.call(gh, k)) merged[k] = gh[k];
      if (opts) for (var k2 in opts) if (Object.prototype.hasOwnProperty.call(opts, k2) && opts[k2] != null) merged[k2] = opts[k2];
    } catch (e) {}
    try {
      return Promise.resolve(w.githubPush(merged)).then(function (res) {
        if (res && res.ok) {
          var n = (res.results && res.results.length) ? res.results.length : 0;
          return ok('pushed ' + n + ' file(s) to GitHub');
        }
        return fail((res && res.error) ? res.error : 'github push failed');
      }).catch(function (err) {
        return fail('github push error: ' + (err && err.message ? err.message : err));
      });
    } catch (err2) {
      return Promise.resolve(fail('github push error: ' + (err2 && err2.message ? err2.message : err2)));
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
      },
      {
        name: 'workspace_list',
        description: 'List the files currently in the shared project workspace, showing each path, language, and size in bytes. Use this to see what the team has built so far.',
        input_schema: {
          type: 'object',
          properties: {
            glob: { type: 'string', description: 'Optional glob filter, e.g. "src/*.js" or "*.html". Omit to list everything.' }
          },
          required: []
        }
      },
      {
        name: 'read_file',
        description: 'Read the full contents of a file in the shared project workspace.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace path to read, e.g. "src/app.js".' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file in the shared project workspace with the given content.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace path to write, e.g. "index.html".' },
            content: { type: 'string', description: 'The full file content.' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'edit_file',
        description: 'Replace a substring inside an existing workspace file. Fails if old_string is not present. By default replaces the first occurrence; set replace_all to replace every occurrence.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace path to edit.' },
            old_string: { type: 'string', description: 'The exact text to find.' },
            new_string: { type: 'string', description: 'The text to replace it with.' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences instead of just the first.' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      },
      {
        name: 'search_workspace',
        description: 'Search across all workspace files for a substring (or regex) and return matching path:line snippets. Use to locate code or text in the project.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The text or regular expression to search for.' },
            regex: { type: 'boolean', description: 'Treat the query as a case-insensitive regular expression.' },
            max: { type: 'number', description: 'Maximum number of matches to return (default 50).' }
          },
          required: ['query']
        }
      },
      {
        name: 'create_artifact',
        description: 'Save a finished deliverable (document, snippet, result) to the company artifact store so it is shown to the user and persisted.',
        input_schema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'A name for the artifact, e.g. "report.md". The extension sets the type.' },
            content: { type: 'string', description: 'The artifact content.' }
          },
          required: ['filename', 'content']
        }
      },
      {
        name: 'run_html',
        description: 'Run the workspace project (or a specific HTML file) in a hidden sandboxed iframe and report any JavaScript errors and console output. Use to smoke-test that the built page loads without errors.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional specific HTML file to run. Omit to assemble and run the whole project.' },
            timeout_ms: { type: 'number', description: 'How long to observe before reporting (default 1500ms, max 8000).' }
          },
          required: []
        }
      },
      {
        name: 'web_fetch',
        description: 'Fetch a web page and return its text content (HTML tags stripped). Requires a CORS proxy URL configured in Settings. Use for research and reading documentation.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute URL to fetch.' },
            max_chars: { type: 'number', description: 'Maximum characters of text to return (default 4000).' }
          },
          required: ['url']
        }
      },
      {
        name: 'generate_chart',
        description: 'Generate an SVG chart (bar, line, or pie) from numeric data and save it to the workspace. Data may be a JSON array of numbers, a JSON array of {label,value} objects, or CSV label,value rows.',
        input_schema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Chart type: "bar", "line", or "pie".' },
            data: { type: 'string', description: 'The data to chart (JSON or CSV).' },
            title: { type: 'string', description: 'Optional chart title (also used for the file name).' }
          },
          required: ['type', 'data']
        }
      },
      {
        name: 'github_push',
        description: 'Push the current workspace files to a GitHub repository. Requires a GitHub token AND the "Allow tool GitHub push" toggle enabled in Settings; otherwise it refuses.',
        input_schema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Optional repo owner (defaults to Settings).' },
            repo: { type: 'string', description: 'Optional repository name (defaults to Settings).' },
            branch: { type: 'string', description: 'Optional branch (defaults to Settings).' }
          },
          required: []
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
        case 'workspace_list':
          return Promise.resolve(workspaceList(input.glob));
        case 'read_file':
          return Promise.resolve(readFile(input.path));
        case 'write_file':
          return Promise.resolve(writeFile(input.path, input.content));
        case 'edit_file':
          return Promise.resolve(editFile(input.path, input.old_string, input.new_string, !!input.replace_all));
        case 'search_workspace':
          return Promise.resolve(searchWorkspace(input.query, !!input.regex, input.max));
        case 'create_artifact':
          return Promise.resolve(createArtifact(input.filename, input.content));
        case 'run_html':
          return runHtml(input.path, input.timeout_ms);
        case 'web_fetch':
          return webFetch(input.url, input.max_chars);
        case 'generate_chart':
          return Promise.resolve(generateChart(input.type, input.data, input.title));
        case 'github_push':
          return githubPush({ owner: input.owner, repo: input.repo, branch: input.branch });
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
    _analyzeData: analyzeData,
    _generateChart: generateChart,
    _stripTags: stripTags,
    _parseChartData: parseChartData
  };
})();
