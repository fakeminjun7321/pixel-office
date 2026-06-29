// =============================================================================
// selfimprove.js  ->  App.SelfImprove
// PIXEL AI COMPANY ("NEON//WORKS") -- HUMAN-IN-THE-LOOP SELF-IMPROVEMENT engine.
//
// The running app (served on GitHub Pages / localhost, where src/*.js are also
// served) reads ITS OWN source, asks the model for ONE concrete, safe, high-value
// improvement, rewrites the target module(s) via minimal find/replace edits,
// rebuilds index.html IN-BROWSER (replicating build.sh exactly), VALIDATES every
// changed module, and produces a plan with diffs for the UI to render.
//
// SAFETY (PINNED):
//   - NOTHING auto-deploys. run() only proposes + builds a candidate. deploy()
//     pushes to GitHub ONLY when the UI calls it on an explicit user click.
//   - A bad edit MUST be caught: run() sets allValid=false and SKIPS the rebuild
//     when ANY target fails validation. deploy() REFUSES when !allValid or when
//     GitHub is not configured. The app cannot brick itself silently.
//
// LOAD ORDER: after share, before ui. Depends on App.config (SRC_MODULES,
//   MODULE_DESCRIPTIONS, SELF_IMPROVE_* prompts), App.API.stream, App.Workspace
//   (diffLines + githubPush), App.state.settings. No DOM. DEFENSIVE: every public
//   method guards network/DOM/JSON and never throws into the rAF loop.
//
// CONTRACT:
//   fetchSource()                 -> Promise<{ok,modules,shell,styles,error?}>
//   propose(hint)                 -> Promise<{improvement,rationale,targets[],plan}>
//   rewrite(name,content,plan)    -> Promise<{edits:[{find,replace}],summary}>
//   applyEdits(content,edits)     -> {content,applied[],rejected[]}
//   validate(name,content)        -> {ok,errors[]}
//   rebuildIndex({modules,shell,styles}) -> indexHtml String
//   diff(oldC,newC)               -> App.Workspace.diffLines(oldC,newC)
//   run(hint)                     -> Promise<{ok,improvement,rationale,files[],
//                                              indexHtml,allValid,error?}>
//   deploy(plan)                  -> Promise<{ok,error?}>
//
// IMPORTANT (single-file inlining hazard): this module BUILDS HTML strings that
//   contain script tags. A literal closing/opening script tag, or an HTML comment
//   marker, in a JS string breaks the single-file inlining of THIS module. Every
//   such token is SPLIT ('</scr'+'ipt>', '<scr'+'ipt>', '<'+'!--'). The build
//   hazard check (grep over src/*.js for those tokens) must stay empty here.
// =============================================================================

window.App = window.App || {};

(function () {
  'use strict';

  var App = window.App;

  function CFG() { return App.config || {}; }
  function SETTINGS() {
    try {
      return (App.state && App.state.settings) ? App.state.settings : {};
    } catch (e) { return {}; }
  }

  // ---------------------------------------------------------------------------
  // The canonical module load order. Mirrors build.sh + config.SRC_MODULES. We
  // prefer config.SRC_MODULES (single source of truth) and fall back to this
  // literal so a partial build still has a sane order. 'selfimprove' sits before
  // 'ui' exactly as in build.sh.
  // ---------------------------------------------------------------------------
  var FALLBACK_MODULES = [
    'config', 'i18n', 'markdown', 'tools', 'workspace', 'pixelart', 'world',
    'api', 'store', 'agents', 'orchestrator', 'graph', 'palette', 'onboarding',
    'audio', 'share', 'selfimprove', 'ui', 'main'
  ];

  function moduleList() {
    try {
      var arr = CFG().SRC_MODULES;
      if (Array.isArray(arr) && arr.length) {
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var n = String(arr[i] == null ? '' : arr[i]).trim();
          if (n) out.push(n);
        }
        if (out.length) return out;
      }
    } catch (e) {}
    return FALLBACK_MODULES.slice();
  }

  // ---------------------------------------------------------------------------
  // FETCH HELPERS -- resolve src files against the current document so this works
  // on GitHub Pages / localhost (served context). On file:// there is no server
  // so the fetch fails -> we surface a clear error rather than throwing.
  // ---------------------------------------------------------------------------
  function srcUrl(rel) {
    try {
      var base = (typeof location !== 'undefined' && location.href) ? location.href : '';
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  }

  function fetchText(rel) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof fetch !== 'function') { reject(new Error('fetch unavailable')); return; }
        fetch(srcUrl(rel), { method: 'GET', cache: 'no-store' })
          .then(function (resp) {
            if (!resp || !resp.ok) {
              reject(new Error('HTTP ' + (resp ? resp.status : '?') + ' for ' + rel));
              return;
            }
            return resp.text().then(function (txt) { resolve(String(txt == null ? '' : txt)); });
          })
          .catch(function (err) { reject(err || new Error('fetch failed: ' + rel)); });
      } catch (e) {
        reject(e || new Error('fetch failed: ' + rel));
      }
    });
  }

  // fetchSource() -> Promise<{ok, modules:{name:content}, shell, styles, error?}>
  //   Fetch every module's src plus shell.html + styles.css. ANY failure (e.g.
  //   file:// with no server) resolves {ok:false, error:'...needs a served...'}.
  function fetchSource() {
    return new Promise(function (resolve) {
      try {
        var names = moduleList();
        var jobs = [];
        for (var i = 0; i < names.length; i++) {
          (function (nm) {
            jobs.push(
              fetchText('src/' + nm + '.js').then(function (txt) {
                return { kind: 'module', name: nm, content: txt };
              })
            );
          })(names[i]);
        }
        jobs.push(fetchText('src/shell.html').then(function (txt) {
          return { kind: 'shell', content: txt };
        }));
        jobs.push(fetchText('src/styles.css').then(function (txt) {
          return { kind: 'styles', content: txt };
        }));

        Promise.all(jobs).then(function (results) {
          var modules = {};
          var shell = '';
          var styles = '';
          for (var j = 0; j < results.length; j++) {
            var r = results[j];
            if (!r) continue;
            if (r.kind === 'module') modules[r.name] = r.content;
            else if (r.kind === 'shell') shell = r.content;
            else if (r.kind === 'styles') styles = r.content;
          }
          resolve({ ok: true, modules: modules, shell: shell, styles: styles });
        }).catch(function (err) {
          resolve({
            ok: false, modules: {}, shell: '', styles: '',
            error: 'self-improve needs a served context (GitHub Pages or localhost), not file:// (' +
                   ((err && err.message) ? err.message : 'fetch failed') + ')'
          });
        });
      } catch (e) {
        resolve({
          ok: false, modules: {}, shell: '', styles: '',
          error: 'self-improve needs a served context (GitHub Pages or localhost), not file://'
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // STREAM WRAPPER -- App.API.stream is callback-based; wrap it in a Promise that
  //   resolves with the accumulated text. Builds creds/model opts EXACTLY like the
  //   orchestrator (apiKey/openaiKey/geminiKey from settings + an explicit model).
  // ---------------------------------------------------------------------------
  function streamText(model, system, userContent) {
    return new Promise(function (resolve, reject) {
      try {
        if (!App.API || typeof App.API.stream !== 'function') {
          reject(new Error('API unavailable'));
          return;
        }
        var settings = SETTINGS();
        var acc = '';
        var settled = false;
        function done(val) { if (!settled) { settled = true; resolve(val); } }
        function fail(err) { if (!settled) { settled = true; reject(err || new Error('stream error')); } }

        App.API.stream({
          apiKey: settings.apiKey,
          openaiKey: settings.openaiKey,
          geminiKey: settings.geminiKey,
          model: model,
          system: system,
          messages: [{ role: 'user', content: String(userContent == null ? '' : userContent) }],
          onText: function (d) { try { acc += String(d == null ? '' : d); } catch (e) {} },
          onDone: function (res) {
            var txt = (res && typeof res.text === 'string' && res.text) ? res.text : acc;
            done(String(txt == null ? '' : txt));
          },
          onError: function (err) {
            fail(err instanceof Error ? err : new Error((err && err.message) ? err.message : 'stream error'));
          }
        });
      } catch (e) {
        reject(e || new Error('stream failed'));
      }
    });
  }

  function bossModel() {
    var s = SETTINGS();
    return s.bossModel || CFG().BOSS_MODEL || 'claude-opus-4-8';
  }
  function workerModel() {
    var s = SETTINGS();
    return s.defaultModel || CFG().DEFAULT_MODEL || 'claude-sonnet-4-6';
  }

  // ---------------------------------------------------------------------------
  // STRICT-JSON PARSING -- tolerant of code fences / smart quotes / trailing
  //   commas, mirroring orchestrator.parsePlan's forgiving cleanup. Returns the
  //   parsed object or null. Never throws.
  // ---------------------------------------------------------------------------
  function parseJsonObject(raw) {
    try {
      if (raw == null) return null;
      var s = String(raw);
      s = s.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/i, '');
      var first = s.indexOf('{');
      var last = s.lastIndexOf('}');
      if (first === -1 || last === -1 || last < first) return null;
      var body = s.slice(first, last + 1);
      body = body.replace(/,(\s*[}\]])/g, '$1');                 // trailing commas
      body = body.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); // smart quotes
      var obj = null;
      try { obj = JSON.parse(body); }
      catch (e) {
        var bal = braceBalancedPrefix(body);
        if (bal) { try { obj = JSON.parse(bal); } catch (e2) { obj = null; } }
      }
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
      return null;
    }
  }

  function braceBalancedPrefix(str) {
    var depth = 0, end = -1, inStr = false, esc = false;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return (end !== -1) ? str.slice(0, end + 1) : null;
  }

  function strOr(v, fallback) {
    if (v == null) return fallback || '';
    var s = String(v).trim();
    return s || (fallback || '');
  }

  // ---------------------------------------------------------------------------
  // MODULE DESCRIPTIONS digest -- name + one-line purpose for every module (NOT
  //   the full content). Prefer config.MODULE_DESCRIPTIONS; fall back to a bare
  //   list so propose() still works on a partial build.
  // ---------------------------------------------------------------------------
  function moduleDescriptionsText() {
    var names = moduleList();
    var desc = CFG().MODULE_DESCRIPTIONS || {};
    var lines = [];
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      var d = '';
      try { if (desc && desc[nm] != null) d = String(desc[nm]).trim(); } catch (e) {}
      lines.push('- ' + nm + (d ? (': ' + d) : ''));
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // propose(hint) -> Promise<{improvement, rationale, targets:[names], plan}>
  //   ONE boss-model call. system = SELF_IMPROVE_PROPOSE_SYSTEM, user = the module
  //   descriptions + optional hint. targets normalized to 1-3 EXISTING module names.
  // ---------------------------------------------------------------------------
  function propose(hint) {
    return new Promise(function (resolve, reject) {
      try {
        var sys = CFG().SELF_IMPROVE_PROPOSE_SYSTEM;
        if (!sys) { reject(new Error('SELF_IMPROVE_PROPOSE_SYSTEM missing')); return; }
        var names = moduleList();
        var nameSet = {};
        for (var i = 0; i < names.length; i++) nameSet[names[i]] = true;

        var hintStr = strOr(hint, '');
        var user =
          'These are the modules that make up THIS app (each line: module name + one-line purpose).\n' +
          'Pick exactly ONE concrete, safe, high-value improvement and name 1-3 target module(s) to edit.\n\n' +
          'MODULES:\n' + moduleDescriptionsText() +
          (hintStr ? ('\n\nUSER HINT (optional steer):\n' + hintStr) : '') +
          '\n\nReply with the STRICT JSON described in your instructions now.';

        streamText(bossModel(), sys, user).then(function (raw) {
          var obj = parseJsonObject(raw);
          if (!obj) { reject(new Error('proposal JSON unreadable')); return; }

          // normalize targets -> 1-3 EXISTING module names, de-duped, order kept.
          var targets = [];
          var seen = {};
          var src = Array.isArray(obj.targets) ? obj.targets : [];
          for (var j = 0; j < src.length; j++) {
            var nm = strOr(src[j], '');
            if (!nm) continue;
            if (!nameSet[nm]) continue;        // must exist in SRC_MODULES
            if (seen[nm]) continue;
            seen[nm] = true;
            targets.push(nm);
            if (targets.length >= 3) break;
          }
          if (!targets.length) { reject(new Error('proposal named no valid target modules')); return; }

          resolve({
            improvement: strOr(obj.improvement, 'Improvement'),
            rationale: strOr(obj.rationale, ''),
            targets: targets,
            plan: strOr(obj.plan, '')
          });
        }).catch(function (err) {
          reject(err || new Error('propose failed'));
        });
      } catch (e) {
        reject(e || new Error('propose failed'));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // rewrite(name, currentContent, plan) -> Promise<{edits:[{find,replace}], summary}>
  //   ONE worker-model call. system = SELF_IMPROVE_REWRITE_PREAMBLE + the full
  //   current content of the target + the plan. Returns STRICT JSON edits where
  //   each find is a VERBATIM, exactly-once substring of the current file.
  // ---------------------------------------------------------------------------
  function rewrite(name, currentContent, plan) {
    return new Promise(function (resolve, reject) {
      try {
        var pre = CFG().SELF_IMPROVE_REWRITE_PREAMBLE;
        if (!pre) { reject(new Error('SELF_IMPROVE_REWRITE_PREAMBLE missing')); return; }
        var content = String(currentContent == null ? '' : currentContent);
        var sys = pre +
          '\n\nThe module you are editing is: ' + String(name || '?') + ' (src/' + String(name || '?') + '.js).';

        var user =
          'IMPROVEMENT PLAN (what to change in THIS module):\n' + strOr(plan, '(no plan text)') +
          '\n\nFULL CURRENT CONTENT OF src/' + String(name || '?') + '.js (between the markers):\n' +
          '<<<<<<<<<< BEGIN FILE\n' + content + '\n>>>>>>>>>> END FILE\n\n' +
          'Produce the minimal find/replace edits. Each "find" MUST be copied verbatim from the file above ' +
          'and occur EXACTLY once. Reply with the STRICT JSON described in your instructions now.';

        streamText(workerModel(), sys, user).then(function (raw) {
          var obj = parseJsonObject(raw);
          if (!obj) { reject(new Error('rewrite JSON unreadable')); return; }
          var edits = [];
          var src = Array.isArray(obj.edits) ? obj.edits : [];
          for (var i = 0; i < src.length; i++) {
            var e = src[i];
            if (!e || typeof e !== 'object') continue;
            if (typeof e.find !== 'string' || !e.find.length) continue;
            var rep = (typeof e.replace === 'string') ? e.replace : String(e.replace == null ? '' : e.replace);
            edits.push({ find: e.find, replace: rep });
          }
          resolve({ edits: edits, summary: strOr(obj.summary, '') });
        }).catch(function (err) {
          reject(err || new Error('rewrite failed'));
        });
      } catch (e) {
        reject(e || new Error('rewrite failed'));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // applyEdits(currentContent, edits) -> {content, applied:[], rejected:[]}
  //   For each edit, apply ONLY when the find occurs EXACTLY once (split length
  //   === 2). Otherwise reject (with a reason). NEVER partial-match. Edits apply
  //   sequentially against the evolving content.
  // ---------------------------------------------------------------------------
  function applyEdits(currentContent, edits) {
    var content = String(currentContent == null ? '' : currentContent);
    var applied = [];
    var rejected = [];
    try {
      var list = Array.isArray(edits) ? edits : [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        var find = (typeof e.find === 'string') ? e.find : '';
        var replace = (typeof e.replace === 'string') ? e.replace
          : String(e.replace == null ? '' : e.replace);
        if (!find) {
          rejected.push({ find: find, replace: replace, reason: 'empty find' });
          continue;
        }
        var parts = content.split(find);
        if (parts.length === 2) {
          content = parts[0] + replace + parts[1];   // exactly-once replace
          applied.push({ find: find, replace: replace });
        } else if (parts.length < 2) {
          rejected.push({ find: find, replace: replace, reason: 'find not present' });
        } else {
          rejected.push({ find: find, replace: replace, reason: 'find occurs ' + (parts.length - 1) + ' times (must be exactly once)' });
        }
      }
    } catch (e) {
      // leave content as-is; surface nothing destructive
    }
    return { content: content, applied: applied, rejected: rejected };
  }

  // ---------------------------------------------------------------------------
  // validate(name, content) -> {ok, errors:[]}
  //   For .js modules: (1) syntax check via new Function(content); (2) HAZARD
  //   check for a literal closing-script tag or HTML comment marker (these break
  //   single-file inlining); (3) empty check. ok = errors.length === 0.
  //   Hazard regexes are built so THIS file contains no raw tokens itself.
  // ---------------------------------------------------------------------------
  var SCRIPT_CLOSE_RE = new RegExp('<\\/scr' + 'ipt', 'i');
  var SCRIPT_OPEN_RE = new RegExp('<scr' + 'ipt', 'i');
  var COMMENT_OPEN_RE = new RegExp('<' + '!--');

  function validate(name, content) {
    var errors = [];
    try {
      var c = String(content == null ? '' : content);
      if (!c.trim()) {
        errors.push('empty');
        return { ok: false, errors: errors };
      }
      // syntax: compile as a function body (classic <script> semantics).
      try {
        // eslint-disable-next-line no-new-func
        new Function(c);
      } catch (e) {
        errors.push('syntax: ' + ((e && e.message) ? e.message : 'parse error'));
      }
      // hazard: a real closing/opening script tag or HTML comment marker literal
      // breaks single-file inlining (the HTML tokenizer closes the inlined block).
      if (SCRIPT_CLOSE_RE.test(c)) errors.push('hazard literal: closing script tag (split it, e.g. "</scr"+"ipt>")');
      else if (SCRIPT_OPEN_RE.test(c)) errors.push('hazard literal: opening script tag (split it, e.g. "<scr"+"ipt>")');
      if (COMMENT_OPEN_RE.test(c)) errors.push('hazard literal: HTML comment marker (split it, e.g. "<"+"!--")');
    } catch (e) {
      errors.push('validate error: ' + ((e && e.message) ? e.message : 'unknown'));
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------------------------------------------------------------------------
  // rebuildIndex({modules, shell, styles}) -> indexHtml String
  //   Replicate build.sh EXACTLY: doctype + html(lang ko) + head(meta charset,
  //   meta viewport, title from document.title, style) + body(shell + one
  //   script block per module in SRC_MODULES order). Script tags are SPLIT so
  //   this builder source never contains a raw token.
  // ---------------------------------------------------------------------------
  function htmlTitle() {
    try {
      if (typeof document !== 'undefined' && document.title) return String(document.title);
    } catch (e) {}
    return 'PIXEL AI COMPANY';
  }

  function rebuildIndex(parts) {
    try {
      var p = parts || {};
      var modules = (p.modules && typeof p.modules === 'object') ? p.modules : {};
      var shell = String(p.shell == null ? '' : p.shell);
      var styles = String(p.styles == null ? '' : p.styles);
      var names = moduleList();

      var SO = '<scr' + 'ipt>';
      var SC = '</scr' + 'ipt>';
      var NL = '\n';

      // Mirror build.sh EXACTLY for byte-identical output: each echo'd line gets a
      // single trailing newline; cat'd file contents (styles/shell/module code) are
      // appended VERBATIM (they already carry their own trailing newline), so no
      // extra blank lines creep in and `bash build.sh` reproduces this file 1:1.
      var out = '';
      out += '<!DOCTYPE html>' + NL;
      out += '<html lang="ko">' + NL;
      out += '<head>' + NL;
      out += '<meta charset="utf-8">' + NL;
      out += '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">' + NL;
      out += '<title>' + htmlTitle() + '</title>' + NL;
      out += '<style>' + NL;
      out += styles;                       // cat (verbatim, keeps its trailing newline)
      out += '</style>' + NL;
      out += '</head>' + NL;
      out += '<body>' + NL;
      out += shell;                        // cat (verbatim)
      for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        var code = (typeof modules[nm] === 'string') ? modules[nm] : null;
        if (code == null) continue;        // skip absent modules (optional feature files)
        out += SO + NL;
        out += code;                       // cat (verbatim)
        out += SC + NL;
      }
      out += '</body>' + NL;
      out += '</html>' + NL;
      return out;
    } catch (e) {
      return '';
    }
  }

  // diff(oldC, newC) -> reuse App.Workspace.diffLines (LCS line diff).
  function diff(oldC, newC) {
    try {
      if (App.Workspace && typeof App.Workspace.diffLines === 'function') {
        return App.Workspace.diffLines(oldC, newC);
      }
    } catch (e) {}
    return [];
  }

  // ---------------------------------------------------------------------------
  // run(hint) -> Promise<{ok, improvement, rationale, files[], indexHtml,
  //                        allValid, error?}>
  //   Orchestrate: fetch -> propose -> rewrite each target -> applyEdits ->
  //   validate -> rebuildIndex (ONLY if every changed file is valid). Returns the
  //   plan for the UI. Does NOT deploy. SAFETY: allValid=false + NO rebuild when
  //   any target fails validation.
  // ---------------------------------------------------------------------------
  function run(hint) {
    return new Promise(function (resolve) {
      function fail(msg) {
        resolve({ ok: false, improvement: '', rationale: '', files: [], indexHtml: '', allValid: false, error: msg });
      }
      try {
        fetchSource().then(function (src) {
          if (!src || !src.ok) {
            fail((src && src.error) || 'self-improve needs a served context (GitHub Pages or localhost), not file://');
            return;
          }
          propose(hint).then(function (prop) {
            var targets = (prop && Array.isArray(prop.targets)) ? prop.targets : [];
            // keep only targets we actually fetched (defensive).
            var valid = [];
            for (var ti = 0; ti < targets.length; ti++) {
              if (typeof src.modules[targets[ti]] === 'string') valid.push(targets[ti]);
            }
            if (!valid.length) { fail('no fetchable target modules in proposal'); return; }

            // rewrite each target sequentially (bounded; gentle on rate limits).
            var files = [];
            var changedModules = {};   // name -> newContent for rebuild

            function step(idx) {
              if (idx >= valid.length) { finalize(); return; }
              var name = valid[idx];
              var oldContent = String(src.modules[name] == null ? '' : src.modules[name]);
              rewrite(name, oldContent, prop.plan).then(function (rw) {
                var res = applyEdits(oldContent, (rw && rw.edits) || []);
                var newContent = res.content;
                var v = validate(name, newContent);
                // a file with zero applied edits is effectively unchanged -> flag as invalid
                // so the user is not asked to deploy a no-op (and so the proposal is honest).
                if (!res.applied.length) {
                  v = { ok: false, errors: v.errors.concat(['no edits applied (all ' + res.rejected.length + ' rejected)']) };
                }
                files.push({
                  name: name,
                  path: 'src/' + name + '.js',
                  oldContent: oldContent,
                  newContent: newContent,
                  diff: diff(oldContent, newContent),
                  valid: v,
                  applied: res.applied,
                  rejected: res.rejected,
                  summary: (rw && rw.summary) || ''
                });
                if (v.ok) changedModules[name] = newContent;
                step(idx + 1);
              }).catch(function (err) {
                // record a failed file so the UI shows what went wrong; allValid -> false.
                files.push({
                  name: name,
                  path: 'src/' + name + '.js',
                  oldContent: oldContent,
                  newContent: oldContent,
                  diff: [],
                  valid: { ok: false, errors: ['rewrite failed: ' + ((err && err.message) ? err.message : 'error')] },
                  applied: [],
                  rejected: [],
                  summary: ''
                });
                step(idx + 1);
              });
            }

            function finalize() {
              var allValid = files.length > 0;
              for (var fi = 0; fi < files.length; fi++) {
                if (!files[fi].valid || !files[fi].valid.ok) { allValid = false; break; }
              }
              var indexHtml = '';
              // SAFETY: only rebuild when EVERY changed file is valid.
              if (allValid) {
                // merge changed modules over the fetched originals for the rebuild.
                var merged = {};
                for (var k in src.modules) {
                  if (Object.prototype.hasOwnProperty.call(src.modules, k)) merged[k] = src.modules[k];
                }
                for (var c in changedModules) {
                  if (Object.prototype.hasOwnProperty.call(changedModules, c)) merged[c] = changedModules[c];
                }
                indexHtml = rebuildIndex({ modules: merged, shell: src.shell, styles: src.styles });
                // final guard: the assembled index must be non-empty.
                if (!indexHtml) allValid = false;
              }
              resolve({
                ok: true,
                improvement: (prop && prop.improvement) || '',
                rationale: (prop && prop.rationale) || '',
                files: files,
                indexHtml: indexHtml,
                allValid: allValid
              });
            }

            step(0);
          }).catch(function (err) {
            fail('propose failed: ' + ((err && err.message) ? err.message : 'error'));
          });
        }).catch(function (err) {
          fail('fetch failed: ' + ((err && err.message) ? err.message : 'error'));
        });
      } catch (e) {
        fail((e && e.message) ? e.message : 'self-improve failed');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // deploy(plan) -> Promise<{ok, error?}>
  //   REFUSES unless plan.allValid AND github (token+owner+repo) is configured.
  //   Pushes the changed src/<name>.js files (newContent) + index.html
  //   (plan.indexHtml) via App.Workspace.githubPush. NEVER auto-called; the UI
  //   invokes this on an explicit user click, then reloads on success.
  // ---------------------------------------------------------------------------
  function deploy(plan) {
    return new Promise(function (resolve) {
      try {
        if (!plan || typeof plan !== 'object') {
          resolve({ ok: false, error: 'no plan' });
          return;
        }
        if (!plan.allValid) {
          resolve({ ok: false, error: 'plan is not valid — refusing to deploy' });
          return;
        }
        if (!plan.indexHtml) {
          resolve({ ok: false, error: 'no rebuilt index.html — refusing to deploy' });
          return;
        }
        var gh = (SETTINGS().github) || {};
        var token = strOr(gh.token, '');
        var owner = strOr(gh.owner, '');
        var repo = strOr(gh.repo, '');
        var branch = strOr(gh.branch, '') || 'main';
        if (!token || !owner || !repo) {
          resolve({ ok: false, error: 'GitHub not configured (token/owner/repo required)' });
          return;
        }
        if (!App.Workspace || typeof App.Workspace.githubPush !== 'function') {
          resolve({ ok: false, error: 'workspace push unavailable' });
          return;
        }

        // Build the list of files to push: each VALID changed module + index.html.
        var files = Array.isArray(plan.files) ? plan.files : [];
        var toPush = [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (!f || !f.valid || !f.valid.ok) continue;
          if (!f.path || typeof f.newContent !== 'string') continue;
          toPush.push({ path: f.path, content: f.newContent });
        }
        if (!toPush.length) {
          resolve({ ok: false, error: 'no valid changed files to deploy' });
          return;
        }
        toPush.push({ path: 'index.html', content: String(plan.indexHtml) });

        // githubPush pushes the whole workspace (App.Workspace.list()); to push an
        // ARBITRARY set of files we pass them explicitly if the signature supports
        // it, else fall back to a temporary workspace write + push of just these.
        pushFiles(toPush, { token: token, owner: owner, repo: repo, branch: branch }).then(function (r) {
          if (r && r.ok) resolve({ ok: true, results: r.results });
          else resolve({ ok: false, error: (r && r.error) ? r.error : 'push failed', results: r && r.results });
        }).catch(function (err) {
          resolve({ ok: false, error: (err && err.message) ? err.message : 'push failed' });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) ? e.message : 'deploy failed' });
      }
    });
  }

  // pushFiles(list, creds) -> Promise<{ok, results, error?}>. Uses the GitHub REST
  //   contents API directly (mirrors Workspace.githubPush) so we push EXACTLY the
  //   given {path,content} set (NOT the whole workspace). Sequential + bounded +
  //   never throws (rejects only on no-fetch). Each file: GET sha (if present) then
  //   PUT base64(utf8) content.
  function pushFiles(list, creds) {
    return new Promise(function (resolve) {
      try {
        if (typeof fetch !== 'function') { resolve({ ok: false, results: [], error: 'fetch unavailable' }); return; }
        var token = creds.token, owner = creds.owner, repo = creds.repo, branch = creds.branch || 'main';
        var apiBase = 'https://api.github.com/repos/' +
          encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/';

        function authHeaders(extra) {
          var h = {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          };
          if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
          return h;
        }
        function encPath(p) {
          return String(p).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
        }
        function getUrl(p) { return apiBase + encPath(p) + '?ref=' + encodeURIComponent(branch); }
        function putUrl(p) { return apiBase + encPath(p); }
        function b64(content) {
          try {
            if (App.Workspace && typeof App.Workspace.toBase64Utf8 === 'function') {
              return App.Workspace.toBase64Utf8(content);
            }
          } catch (e) {}
          // last-resort base64 (ASCII-safe; Workspace.toBase64Utf8 should exist).
          try { return (typeof btoa === 'function') ? btoa(unescape(encodeURIComponent(content))) : ''; }
          catch (e2) { return ''; }
        }

        var results = [];
        var anyOk = false;

        function next(idx) {
          if (idx >= list.length) { resolve({ ok: anyOk, results: results }); return; }
          var it = list[idx];
          var p = it.path;
          var sha = null;
          fetch(getUrl(p), { method: 'GET', headers: authHeaders() })
            .then(function (resp) {
              if (resp && resp.ok) {
                return resp.json().then(function (j) { if (j && j.sha) sha = j.sha; }).catch(function () {});
              }
              return null;
            })
            .catch(function () {})
            .then(function () {
              var body = {
                message: 'NEON//WORKS self-improve: update ' + p,
                content: b64(String(it.content == null ? '' : it.content)),
                branch: branch
              };
              if (sha) body.sha = sha;
              return fetch(putUrl(p), {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
              });
            })
            .then(function (resp) {
              var ok = !!(resp && resp.ok);
              if (ok) anyOk = true;
              results.push({ path: p, status: ok ? 'ok' : ('error ' + (resp ? resp.status : 0)) });
            })
            .catch(function (err) {
              results.push({ path: p, status: 'error ' + ((err && err.message) ? err.message : 'network') });
            })
            .then(function () { next(idx + 1); });
        }
        next(0);
      } catch (e) {
        resolve({ ok: false, results: [], error: (e && e.message) ? e.message : 'fatal' });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // ATTACH
  // ---------------------------------------------------------------------------
  App.SelfImprove = {
    fetchSource: fetchSource,
    propose: propose,
    rewrite: rewrite,
    applyEdits: applyEdits,
    validate: validate,
    rebuildIndex: rebuildIndex,
    diff: diff,
    run: run,
    deploy: deploy,
    // helpers exposed for reuse / testing (additive, non-spec)
    moduleList: moduleList,
    parseJsonObject: parseJsonObject
  };

})();
