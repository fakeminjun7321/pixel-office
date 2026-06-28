// =============================================================================
// workspace.js -> App.Workspace
// PIXEL AI COMPANY ("NEON//WORKS") -- v5 SHARED PROJECT WORKSPACE (virtual FS).
//
// The PROJECT BUILDER backbone. Workers WRITE files into a shared virtual
// filesystem and READ files other workers already wrote, so a multi-file
// project stays COHERENT. This is the deliverable workspace, SEPARATE from
// App.state.artifacts.
//
// LOAD ORDER: after tools.js, before pixelart.js. Depends ONLY on App.state /
// App.config. No DOM, no other modules. Pure-ish + DEFENSIVE: every public
// method is wrapped so it NEVER throws into the rAF loop.
//
// CONTRACT (v5 SHARED):
//   DATA MODEL -- App.state.files = { path -> {content,lang,updatedBy,t} }
//   App.Workspace.write(path, content, by)   -> normalize+store, returns path|null
//   App.Workspace.read(path)                 -> content String | null
//   App.Workspace.remove(path)               -> bool
//   App.Workspace.list()                     -> [{path,content,lang,updatedBy,t}] sorted
//   App.Workspace.clear()                    -> void
//   App.Workspace.tree()                     -> nested {name,path,dir,children|file}
//   App.Workspace.detectLang(path)           -> 'html'|'css'|'js'|...|'txt'
//   App.Workspace.parseFileBlocks(text)      -> [{path,content,lang}] from ```file:<p>```
//   App.Workspace.buildZip()                 -> Blob (valid store-only zip, folders)
//   App.Workspace.assembleRunnable()         -> single inlined HTML String | null
//   App.Workspace.githubPush(opts)           -> Promise<{ok,results,error?}>
//   App.Workspace.normalizePath(path)        -> normalized path String (helper)
//   App.Workspace.toBase64Utf8(str)          -> base64 of UTF-8 (helper)
//
// LIMITS: MAX_FILES total (default 200, from config.MAX_PROJECT_FILES), per-file
//   size cap (~200k chars). Over-cap writes are rejected (return null), never throw.
// =============================================================================

window.App = window.App || {};

(function () {
  'use strict';

  var App = window.App;

  function CFG() { return App.config || {}; }

  // ---- limits ---------------------------------------------------------------
  function maxFiles() {
    try {
      var n = App.config && App.config.MAX_PROJECT_FILES;
      n = parseInt(n, 10);
      if (n > 0 && n < 100000) return n;
    } catch (e) {}
    return 200;
  }
  var MAX_FILE_BYTES = 200 * 1024; // ~200k per file (chars; conservative)

  // newest-history cap (config.FILE_HISTORY_CAP || 20), bounded defensively.
  function historyCap() {
    try {
      var n = parseInt(CFG().FILE_HISTORY_CAP, 10);
      if (n > 0 && n < 10000) return n;
    } catch (e) {}
    return 20;
  }

  // ---- state accessor (Store owns/seeds; we read defensively) ---------------
  function filesMap() {
    if (!App.state || typeof App.state !== 'object') return null;
    if (!App.state.files || typeof App.state.files !== 'object') {
      App.state.files = {};
    }
    return App.state.files;
  }

  // ===========================================================================
  // PATH NORMALIZATION
  //   trim, strip leading './' and '/', collapse '..' and '.' segments,
  //   collapse duplicate slashes, drop backslashes. Defensive; never throws.
  // ===========================================================================
  function normalizePath(path) {
    try {
      var p = String(path == null ? '' : path);
      p = p.replace(/\\/g, '/');            // backslashes -> slashes
      p = p.replace(/^\s+|\s+$/g, '');      // trim
      p = p.replace(/\/+/g, '/');           // collapse duplicate slashes
      p = p.replace(/^(\.\/)+/, '');        // strip leading ./
      p = p.replace(/^\/+/, '');            // strip leading /
      // collapse . and .. against a stack
      var raw = p.split('/');
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var seg = raw[i];
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (out.length) out.pop(); continue; }
        out.push(seg);
      }
      return out.join('/');
    } catch (e) {
      return '';
    }
  }

  // ===========================================================================
  // LANGUAGE DETECTION by extension
  // ===========================================================================
  var EXT_LANG = {
    html: 'html', htm: 'html',
    css: 'css',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts',
    json: 'json',
    md: 'md', markdown: 'md',
    py: 'py',
    txt: 'txt', text: 'txt',
    xml: 'xml', svg: 'xml',
    yml: 'yaml', yaml: 'yaml',
    sh: 'sh', bash: 'sh',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
    sql: 'sql', toml: 'toml', ini: 'ini', csv: 'csv'
  };
  function detectLang(path) {
    try {
      var p = String(path || '').toLowerCase();
      var base = p.split('/').pop() || '';
      var dot = base.lastIndexOf('.');
      if (dot < 0 || dot === base.length - 1) {
        // no extension: a couple well-known bare names
        if (base === 'readme') return 'md';
        if (base === 'dockerfile') return 'txt';
        if (base === 'makefile') return 'txt';
        return 'txt';
      }
      var ext = base.slice(dot + 1);
      return EXT_LANG[ext] || 'txt';
    } catch (e) {
      return 'txt';
    }
  }

  // ===========================================================================
  // VERSION HISTORY helpers
  //   Each file record carries .history = [{content,t,by}] (newest LAST), the
  //   prior versions recorded BEFORE each overwrite/edit, capped to newest N.
  // ===========================================================================
  function carryHistory(rec) {
    // Return a fresh array of the record's existing history (coerced + capped).
    var out = [];
    try {
      if (rec && typeof rec === 'object' && rec.history && rec.history.length) {
        for (var i = 0; i < rec.history.length; i++) {
          var h = rec.history[i];
          if (!h || typeof h !== 'object') continue;
          out.push({
            content: (typeof h.content === 'string') ? h.content : String(h.content == null ? '' : h.content),
            t: (typeof h.t === 'number') ? h.t : 0,
            by: h.by ? String(h.by) : 'agent'
          });
        }
      }
    } catch (e) {}
    capHistory(out);
    return out;
  }

  function priorContentOf(rec) {
    if (rec && typeof rec === 'object' && typeof rec.content === 'string') return rec.content;
    if (typeof rec === 'string') return rec; // tolerate legacy shape
    if (rec && typeof rec === 'object' && rec.content != null) return String(rec.content);
    return '';
  }

  function capHistory(arr) {
    try {
      var cap = historyCap();
      while (arr.length > cap) arr.shift(); // drop oldest (front)
    } catch (e) {}
    return arr;
  }

  // Public: snapshots for a file, newest last. Always an array.
  function history(path) {
    try {
      var map = filesMap();
      if (!map) return [];
      var p = normalizePath(path);
      var rec = map[p];
      if (!rec || typeof rec !== 'object' || !rec.history || !rec.history.length) return [];
      var out = [];
      for (var i = 0; i < rec.history.length; i++) {
        var h = rec.history[i];
        if (!h || typeof h !== 'object') continue;
        out.push({
          content: (typeof h.content === 'string') ? h.content : String(h.content == null ? '' : h.content),
          t: (typeof h.t === 'number') ? h.t : 0,
          by: h.by ? String(h.by) : 'agent'
        });
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  // Public: restore a historical version (by index into history(path)) as a
  // NEW write (by:'user'), which itself snapshots the current content. Returns
  // the path on success, null otherwise. Never throws.
  function restore(path, index) {
    try {
      var snaps = history(path);
      var i = parseInt(index, 10);
      if (!(i >= 0 && i < snaps.length)) return null;
      var content = snaps[i].content;
      return write(path, content, 'user');
    } catch (e) {
      return null;
    }
  }

  // Public: dependency-free LCS line diff.
  //   -> [{type:'ctx'|'add'|'del', text:String}]  (old=del, new=add)
  //   Bounded for large files: above a size threshold, fall back to a coarse
  //   block diff (all-del then all-add) to avoid an O(n*m) table blowup.
  function diffLines(oldStr, newStr) {
    try {
      var a = splitLines(oldStr);
      var b = splitLines(newStr);
      var out = [];
      // Bound the LCS table: cap on product of line counts.
      var MAX_CELLS = 1500 * 1500; // ~2.25M cells ceiling (avoid a giant DP table / UI jank)
      if (a.length * b.length > MAX_CELLS || a.length > 20000 || b.length > 20000) {
        for (var d = 0; d < a.length; d++) out.push({ type: 'del', text: a[d] });
        for (var ad = 0; ad < b.length; ad++) out.push({ type: 'add', text: b[ad] });
        return out;
      }
      var n = a.length, m = b.length;
      // LCS length table (rows 0..n, cols 0..m). Uint arrays where possible.
      var table = [];
      for (var r = 0; r <= n; r++) {
        table.push(new Array(m + 1));
        table[r][m] = 0;
      }
      for (var c = 0; c <= m; c++) table[n][c] = 0;
      for (var ii = n - 1; ii >= 0; ii--) {
        var rowI = table[ii], rowI1 = table[ii + 1];
        for (var jj = m - 1; jj >= 0; jj--) {
          if (a[ii] === b[jj]) rowI[jj] = rowI1[jj + 1] + 1;
          else rowI[jj] = (rowI1[jj] >= rowI[jj + 1]) ? rowI1[jj] : rowI[jj + 1];
        }
      }
      // Backtrack to build the edit script.
      var x = 0, y = 0;
      while (x < n && y < m) {
        if (a[x] === b[y]) {
          out.push({ type: 'ctx', text: a[x] });
          x++; y++;
        } else if (table[x + 1][y] >= table[x][y + 1]) {
          out.push({ type: 'del', text: a[x] });
          x++;
        } else {
          out.push({ type: 'add', text: b[y] });
          y++;
        }
      }
      while (x < n) { out.push({ type: 'del', text: a[x] }); x++; }
      while (y < m) { out.push({ type: 'add', text: b[y] }); y++; }
      return out;
    } catch (e) {
      return [];
    }
  }

  function splitLines(s) {
    var str = String(s == null ? '' : s);
    str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (str === '') return [];
    return str.split('\n');
  }

  // ===========================================================================
  // WRITE / READ / REMOVE / LIST / CLEAR
  // ===========================================================================
  function write(path, content, by) {
    try {
      var map = filesMap();
      if (!map) return null;
      var p = normalizePath(path);
      if (!p) return null;
      var str = (content == null) ? '' : String(content);
      // per-file size cap (defensive truncate rather than reject silently)
      if (str.length > MAX_FILE_BYTES) str = str.slice(0, MAX_FILE_BYTES);
      // total-file cap: allow overwrite of existing, reject NEW over cap
      var existing = Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null;
      if (!existing) {
        var count = 0;
        for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) count++; }
        if (count >= maxFiles()) return null;
      }
      // VERSION HISTORY: carry forward prior history, and record the PRIOR
      // content as a snapshot BEFORE overwriting (capped to newest entries).
      var hist = carryHistory(existing);
      if (existing) {
        var priorContent = priorContentOf(existing);
        var priorT = (existing && typeof existing.t === 'number') ? existing.t : 0;
        var priorBy = (existing && existing.updatedBy) ? String(existing.updatedBy) : 'agent';
        // skip a no-op snapshot when content is unchanged (avoid history spam)
        if (priorContent !== str) {
          hist.push({ content: priorContent, t: priorT, by: priorBy });
          capHistory(hist);
        }
      }
      map[p] = {
        content: str,
        lang: detectLang(p),
        updatedBy: by ? String(by) : 'agent',
        t: Date.now(),
        history: hist
      };
      return p;
    } catch (e) {
      return null;
    }
  }

  function read(path) {
    try {
      var map = filesMap();
      if (!map) return null;
      var p = normalizePath(path);
      var rec = map[p];
      if (rec && typeof rec === 'object' && typeof rec.content === 'string') return rec.content;
      if (typeof rec === 'string') return rec; // tolerate legacy shape
      return null;
    } catch (e) {
      return null;
    }
  }

  function remove(path) {
    try {
      var map = filesMap();
      if (!map) return false;
      var p = normalizePath(path);
      if (Object.prototype.hasOwnProperty.call(map, p)) {
        delete map[p];
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function list() {
    try {
      var map = filesMap();
      if (!map) return [];
      var out = [];
      for (var k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        var rec = map[k];
        if (!rec) continue;
        if (typeof rec === 'string') rec = { content: rec, lang: detectLang(k), updatedBy: 'user', t: 0 };
        if (typeof rec !== 'object') continue;
        out.push({
          path: k,
          content: typeof rec.content === 'string' ? rec.content : String(rec.content == null ? '' : rec.content),
          lang: rec.lang || detectLang(k),
          updatedBy: rec.updatedBy || 'agent',
          t: typeof rec.t === 'number' ? rec.t : 0,
          history: (rec.history && rec.history.length) ? rec.history.length : 0
        });
      }
      out.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
      return out;
    } catch (e) {
      return [];
    }
  }

  function clear() {
    try {
      if (App.state && typeof App.state === 'object') App.state.files = {};
    } catch (e) {}
  }

  // ===========================================================================
  // TREE -- nested folder structure for the explorer
  //   { name, path, dir:true, children:[...] }  for folders
  //   { name, path, file:true, lang, updatedBy, t } for files
  //   root is a dir node with path '' and name '' (caller renders children).
  // ===========================================================================
  function tree() {
    var root = { name: '', path: '', dir: true, children: [] };
    try {
      var items = list();
      // index of dir nodes by path for O(1) lookup
      var dirIndex = {};
      dirIndex[''] = root;

      function ensureDir(dirPath) {
        if (dirIndex[dirPath]) return dirIndex[dirPath];
        var parts = dirPath.split('/');
        var name = parts[parts.length - 1];
        var parentPath = parts.slice(0, -1).join('/');
        var parent = ensureDir(parentPath);
        var node = { name: name, path: dirPath, dir: true, children: [] };
        parent.children.push(node);
        dirIndex[dirPath] = node;
        return node;
      }

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var segs = it.path.split('/');
        var fileName = segs[segs.length - 1];
        var dirPath = segs.slice(0, -1).join('/');
        var parent = ensureDir(dirPath);
        parent.children.push({
          name: fileName,
          path: it.path,
          file: true,
          lang: it.lang,
          updatedBy: it.updatedBy,
          t: it.t
        });
      }

      // sort each dir: folders first, then files, both alpha
      sortTree(root);
    } catch (e) {}
    return root;
  }

  function sortTree(node) {
    if (!node || !node.children) return;
    node.children.sort(function (a, b) {
      var ad = a.dir ? 0 : 1, bd = b.dir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].dir) sortTree(node.children[i]);
    }
  }

  // ===========================================================================
  // parseFileBlocks(text) -> [{path, content, lang}]
  //   Parses fenced blocks whose info string is 'file:<path>'.
  //   Accepts ``` or ~~~ fences, an optional language token after the path
  //   (e.g. ```file:src/app.js js), and a leading '// path: <p>' fallback.
  //   Robust, never throws. Last-write-wins on duplicate paths.
  // ===========================================================================
  function parseFileBlocks(text) {
    var out = [];
    try {
      var src = String(text == null ? '' : text);
      // normalize CRLF to LF for line scanning
      src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var lines = src.split('\n');
      var seen = {}; // path -> index in out (for last-write-wins)
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        var open = matchFenceOpen(line);
        if (open && open.path) {
          // collect until matching closing fence of same char/length-ish
          var body = [];
          var j = i + 1;
          var closed = false;
          for (; j < lines.length; j++) {
            if (matchFenceClose(lines[j], open.fenceChar)) { closed = true; break; }
            body.push(lines[j]);
          }
          var p = normalizePath(open.path);
          if (p) {
            var content = body.join('\n');
            pushFile(out, seen, p, content);
          }
          i = closed ? j + 1 : j;
          continue;
        }
        i++;
      }

      // fallback: leading '// path: <p>' convention inside generic fenced
      // blocks (only when NO file: blocks were found, to avoid double-parsing).
      if (out.length === 0) {
        parsePathCommentBlocks(src, out, {});
      }
    } catch (e) {
      // swallow; return whatever we have
    }
    return out;
  }

  function pushFile(out, seen, path, content) {
    var rec = { path: path, content: content, lang: detectLang(path) };
    if (Object.prototype.hasOwnProperty.call(seen, path)) {
      out[seen[path]] = rec; // last-write-wins
    } else {
      seen[path] = out.length;
      out.push(rec);
    }
  }

  // Match an opening fence with a file: info string.
  // Examples that match:
  //   ```file:src/app.js
  //   ```file: src/app.js js
  //   ~~~file:index.html html
  //   ``` file:README.md
  function matchFenceOpen(line) {
    if (typeof line !== 'string') return null;
    // ^ optional ws, fence (3+ ` or ~), optional ws, 'file:' info, path...
    var m = line.match(/^\s*(`{3,}|~{3,})\s*file\s*:\s*([^\s`~]+)(?:\s+[^\s`~]+)?\s*$/i);
    if (!m) return null;
    return { fenceChar: m[1].charAt(0), path: m[2] };
  }

  function matchFenceClose(line, fenceChar) {
    if (typeof line !== 'string') return false;
    var re = fenceChar === '~' ? /^\s*~{3,}\s*$/ : /^\s*`{3,}\s*$/;
    return re.test(line);
  }

  // Fallback parser: generic fenced blocks whose FIRST content line is a
  // '// path: <p>' (or '# path: <p>') comment naming the file.
  function parsePathCommentBlocks(src, out, seen) {
    try {
      var lines = src.split('\n');
      var i = 0;
      while (i < lines.length) {
        var open = lines[i].match(/^\s*(`{3,}|~{3,})/);
        if (open) {
          var fenceChar = open[1].charAt(0);
          var body = [];
          var j = i + 1;
          var closed = false;
          for (; j < lines.length; j++) {
            if (matchFenceClose(lines[j], fenceChar)) { closed = true; break; }
            body.push(lines[j]);
          }
          if (body.length) {
            var first = body[0];
            var pm = first.match(/^\s*(?:\/\/|#|<!\-\-)\s*path\s*:\s*([^\s>]+)/i);
            if (pm) {
              var p = normalizePath(pm[1]);
              if (p) {
                pushFile(out, seen, p, body.slice(1).join('\n'));
              }
            }
          }
          i = closed ? j + 1 : j;
          continue;
        }
        i++;
      }
    } catch (e) {}
  }

  // ===========================================================================
  // UTF-8 + BASE64 HELPERS
  // ===========================================================================
  function utf8Bytes(str) {
    var s = String(str == null ? '' : str);
    if (typeof TextEncoder !== 'undefined') {
      try { return new TextEncoder().encode(s); } catch (e) {}
    }
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        // surrogate pair -> code point
        var hi = c, lo = s.charCodeAt(i + 1);
        var cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        i++;
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToBase64(bytes) {
    // Prefer btoa over a binary string when available (fast path).
    try {
      if (typeof btoa === 'function') {
        var bin = '';
        var CH = 0x8000;
        for (var off = 0; off < bytes.length; off += CH) {
          var slice = bytes.subarray ? bytes.subarray(off, off + CH) : bytes.slice(off, off + CH);
          bin += String.fromCharCode.apply(null, slice);
        }
        return btoa(bin);
      }
    } catch (e) {}
    // manual base64
    var res = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      res += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var a = bytes[i];
      res += B64[(a >> 2) & 63] + B64[(a << 4) & 63] + '==';
    } else if (rem === 2) {
      var b0 = bytes[i], b1 = bytes[i + 1];
      res += B64[(b0 >> 2) & 63] + B64[((b0 << 4) | (b1 >> 4)) & 63] + B64[(b1 << 2) & 63] + '=';
    }
    return res;
  }
  function toBase64Utf8(str) {
    try { return bytesToBase64(utf8Bytes(str)); } catch (e) { return ''; }
  }

  // ===========================================================================
  // ZIP (store-only, folders preserved) -- self-contained, do NOT call UI helper
  // ===========================================================================
  var _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) {
      _crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // DOS time/date for the zip header (best-effort; constant epoch is also valid).
  function dosDateTime(ms) {
    var d;
    try { d = new Date(typeof ms === 'number' && ms > 0 ? ms : Date.now()); }
    catch (e) { d = new Date(); }
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    var date = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  // Build a store-only zip from [{name, data:Uint8Array, t?}] -> Uint8Array
  function makeStoreZip(entries) {
    var chunks = [];
    var central = [];
    var offset = 0;
    function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
    for (var i = 0; i < entries.length; i++) {
      var nameBytes = utf8Bytes(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var dt = dosDateTime(entries[i].t);
      // flag bit 11 (0x0800) = filename is UTF-8
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0),
        u16(dt.time), u16(dt.date),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      );
      chunks.push(new Uint8Array(local));
      chunks.push(nameBytes);
      chunks.push(data);
      var cen = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
        u16(dt.time), u16(dt.date),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset)
      );
      central.push({ head: new Uint8Array(cen), name: nameBytes });
      offset += local.length + nameBytes.length + data.length;
    }
    var centralStart = offset;
    var centralSize = 0;
    for (var j = 0; j < central.length; j++) {
      chunks.push(central[j].head);
      chunks.push(central[j].name);
      centralSize += central[j].head.length + central[j].name.length;
    }
    var end = [].concat(
      u32(0x06054b50), u16(0), u16(0),
      u16(entries.length), u16(entries.length),
      u32(centralSize), u32(centralStart), u16(0)
    );
    chunks.push(new Uint8Array(end));
    var total = 0;
    for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var m = 0; m < chunks.length; m++) { out.set(chunks[m], pos); pos += chunks[m].length; }
    return out;
  }

  function buildZip() {
    try {
      var items = list();
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        // folder paths preserved exactly (forward slashes per zip spec)
        entries.push({ name: items[i].path, data: utf8Bytes(items[i].content), t: items[i].t });
      }
      var bytes = makeStoreZip(entries);
      if (typeof Blob !== 'undefined') {
        return new Blob([bytes], { type: 'application/zip' });
      }
      return bytes; // headless fallback
    } catch (e) {
      try { return new Blob([new Uint8Array(0)], { type: 'application/zip' }); }
      catch (e2) { return null; }
    }
  }

  // ===========================================================================
  // assembleRunnable() -> single self-contained HTML for sandboxed live preview.
  //   Inline a local stylesheet link tag as an inline style block.
  //   Inline a local external-src script tag as an inline script block.
  //   Resolve relative paths against the html file's folder.
  //   Leave http(s):// (and //, data:) refs alone. Returns null if no html.
  //   Never executes anything.
  // ===========================================================================
  function isExternalRef(url) {
    return /^(?:https?:)?\/\//i.test(url) || /^data:/i.test(url) ||
           /^blob:/i.test(url) || /^mailto:/i.test(url) || /^#/.test(url);
  }

  function resolveRelative(baseDir, ref) {
    var r = String(ref || '');
    // strip query/hash for lookup
    r = r.replace(/[?#].*$/, '');
    if (/^\//.test(r)) return normalizePath(r); // root-relative -> from project root
    var combined = baseDir ? (baseDir + '/' + r) : r;
    return normalizePath(combined);
  }

  function escScriptClose(content) {
    // Neutralize a closing script tag inside file content so it cannot terminate
    // the inlined script block (insert a backslash before the slash; JS-equivalent).
    return String(content == null ? '' : content).replace(/<\/(script)/gi, '<\\/$1');
  }

  // Self-repair capture prelude: override console.* and listen for runtime
  // errors, forwarding each to the parent via postMessage. Built by SPLITTING
  // script-tag literals so this source never contains a real closing tag.
  //   parent.postMessage({source:'neonworks-run', kind:'log'|'error', text}, '*')
  function capturePrelude() {
    var SO = '<scr' + 'ipt>';
    var SC = '</scr' + 'ipt>';
    var body = [
      '(function(){',
      '  try {',
      '    var send = function(kind, text){',
      "      try { parent.postMessage({ source:'neonworks-run', kind:kind, text:String(text) }, '*'); } catch(e){}",
      '    };',
      '    var fmt = function(args){',
      '      var parts = [];',
      '      for (var i=0;i<args.length;i++){',
      '        var a = args[i];',
      '        try {',
      "          if (a && typeof a === 'object') parts.push(JSON.stringify(a));",
      '          else parts.push(String(a));',
      '        } catch(e){ parts.push(String(a)); }',
      '      }',
      "      return parts.join(' ');",
      '    };',
      "    var c = window.console || (window.console = {});",
      "    ['log','warn','error','info','debug'].forEach(function(name){",
      '      var orig = c[name];',
      '      c[name] = function(){',
      "        send(name === 'error' ? 'error' : 'log', name.toUpperCase() + ': ' + fmt(arguments));",
      "        try { if (typeof orig === 'function') orig.apply(c, arguments); } catch(e){}",
      '      };',
      '    });',
      "    window.addEventListener('error', function(ev){",
      '      try {',
      '        var msg = ev && ev.message ? ev.message : (ev && ev.error ? String(ev.error) : "error");',
      '        var loc = (ev && ev.filename) ? (" (" + ev.filename + ":" + (ev.lineno||0) + ":" + (ev.colno||0) + ")") : "";',
      '        var stk = (ev && ev.error && ev.error.stack) ? ("\\n" + ev.error.stack) : "";',
      "        send('error', msg + loc + stk);",
      '      } catch(e){}',
      '    });',
      "    window.addEventListener('unhandledrejection', function(ev){",
      '      try {',
      '        var r = ev && ev.reason;',
      '        var msg = (r && r.stack) ? r.stack : (r && r.message) ? r.message : String(r);',
      "        send('error', 'UnhandledRejection: ' + msg);",
      '      } catch(e){}',
      '    });',
      '  } catch(e){}',
      '})();'
    ].join('\n');
    return SO + '\n' + body + '\n' + SC;
  }

  // Inject the prelude at the TOP of <head> (or <body>, or the document) so it
  // installs before any project script runs. Defensive; returns html unchanged
  // on any failure.
  function injectCapture(html) {
    try {
      var prelude = capturePrelude();
      var headRe = /<head\b[^>]*>/i;
      if (headRe.test(html)) {
        return html.replace(headRe, function (tag) { return tag + '\n' + prelude; });
      }
      var bodyRe = /<body\b[^>]*>/i;
      if (bodyRe.test(html)) {
        return html.replace(bodyRe, function (tag) { return tag + '\n' + prelude; });
      }
      var htmlRe = /<html\b[^>]*>/i;
      if (htmlRe.test(html)) {
        return html.replace(htmlRe, function (tag) { return tag + '\n' + prelude; });
      }
      return prelude + '\n' + html;
    } catch (e) {
      return html;
    }
  }

  function assembleRunnable(opts) {
    try {
      var map = filesMap();
      if (!map) return null;
      // pick index.html, else first *.html (sorted)
      var htmlPath = null;
      if (read('index.html') != null) htmlPath = 'index.html';
      if (!htmlPath) {
        var items = list();
        for (var i = 0; i < items.length; i++) {
          if (/\.html?$/i.test(items[i].path)) { htmlPath = items[i].path; break; }
        }
      }
      if (!htmlPath) return null;
      var html = read(htmlPath);
      if (html == null) return null;

      var baseDir = htmlPath.indexOf('/') >= 0 ? htmlPath.replace(/\/[^/]*$/, '') : '';

      // 1) inline <link rel="stylesheet" href="X.css"> -> <style>
      html = html.replace(/<link\b[^>]*>/gi, function (tag) {
        try {
          if (!/rel\s*=\s*["']?\s*stylesheet/i.test(tag)) return tag;
          var hrefM = tag.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
          if (!hrefM) return tag;
          var href = hrefM[2] || hrefM[3] || hrefM[4] || '';
          if (!href || isExternalRef(href)) return tag;
          var p = resolveRelative(baseDir, href);
          var css = read(p);
          if (css == null) return tag; // keep ref if not found
          return '<style>\n' + css + '\n</style>';
        } catch (e) { return tag; }
      });

      // 2) inline a local external-src script tag as an inline script block
      html = html.replace(new RegExp('<scr' + 'ipt\\b([^>]*)>\\s*<\\/script>', 'gi'), function (full, attrs) {
        try {
          var srcM = attrs.match(/src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
          if (!srcM) return full; // inline script with no src -> leave
          var src = srcM[2] || srcM[3] || srcM[4] || '';
          if (!src || isExternalRef(src)) return full;
          var p = resolveRelative(baseDir, src);
          var js = read(p);
          if (js == null) return full;
          // preserve type=module if present (sandbox supports it)
          var typeM = attrs.match(/type\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
          var typeAttr = (typeM && /module/i.test(typeM[0])) ? ' type="module"' : '';
          return '<scr' + 'ipt' + typeAttr + '>\n' + escScriptClose(js) + '\n</scr' + 'ipt>';
        } catch (e) { return full; }
      });

      // Self-repair console/error capture prelude (opt-in via opts.capture).
      if (opts && opts.capture) {
        html = injectCapture(html);
      }

      return html;
    } catch (e) {
      return null;
    }
  }

  // ===========================================================================
  // githubPush(opts) -> Promise<{ok, results:[{path,status}], error?}>
  //   GitHub REST contents API. For each file: GET to discover sha (if exists)
  //   then PUT with base64(utf8) content. Best-effort, bounded, never throws
  //   (rejects only on fatal/no-fetch). Requires token+owner+repo.
  // ===========================================================================
  function githubPush(opts) {
    return new Promise(function (resolve) {
      try {
        var o = opts || {};
        var token = String(o.token || '').trim();
        var owner = String(o.owner || '').trim();
        var repo = String(o.repo || '').trim();
        var branch = String(o.branch || '').trim() || 'main';
        if (!token || !owner || !repo) {
          return resolve({ ok: false, results: [], error: 'missing token/owner/repo' });
        }
        if (typeof fetch !== 'function') {
          return resolve({ ok: false, results: [], error: 'fetch unavailable' });
        }

        var items = list();
        if (!items.length) {
          return resolve({ ok: false, results: [], error: 'no files to push' });
        }

        var apiBase = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/';
        function authHeaders(extra) {
          var h = {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          };
          if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
          return h;
        }
        function pathUrl(p) {
          // encode each path segment but keep slashes
          var enc = String(p).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
          return apiBase + enc + '?ref=' + encodeURIComponent(branch);
        }
        function putUrl(p) {
          var enc = String(p).split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
          return apiBase + enc;
        }

        var results = [];
        var anyOk = false;

        // sequential to stay bounded and respect rate limits
        function next(idx) {
          if (idx >= items.length) {
            return resolve({ ok: anyOk, results: results });
          }
          var it = items[idx];
          var p = it.path;
          var sha = null;
          // 1) GET existing sha (ignore errors / 404)
          fetch(pathUrl(p), { method: 'GET', headers: authHeaders() })
            .then(function (resp) {
              if (resp && resp.ok) {
                return resp.json().then(function (j) {
                  if (j && j.sha) sha = j.sha;
                }).catch(function () {});
              }
              return null;
            })
            .catch(function () { /* offline/404 -> create new */ })
            .then(function () {
              // 2) PUT content
              var body = {
                message: 'NEON//WORKS: update ' + p,
                content: toBase64Utf8(it.content),
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
              var status = resp ? resp.status : 0;
              var ok = !!(resp && resp.ok);
              if (ok) anyOk = true;
              results.push({ path: p, status: ok ? 'ok' : ('error ' + status) });
            })
            .catch(function (err) {
              results.push({ path: p, status: 'error ' + (err && err.message ? err.message : 'network') });
            })
            .then(function () { next(idx + 1); });
        }
        next(0);
      } catch (e) {
        resolve({ ok: false, results: [], error: (e && e.message) ? e.message : 'fatal' });
      }
    });
  }

  // ===========================================================================
  // PROJECT IMPORT INGEST -- importFiles(entries[{path,content}])
  //   Normalize each path + write() each into the workspace. Respects caps (the
  //   write() helper enforces per-file size + total-file count). Skips binaries
  //   (NUL bytes) and oversized/invalid entries gracefully. Never throws.
  //   -> { ok:Bool, count:Number, skipped:Number }
  // ===========================================================================
  function looksBinary(str) {
    try {
      var s = String(str == null ? '' : str);
      // sample up to first ~64k chars; a NUL byte strongly implies binary
      var lim = s.length < 65536 ? s.length : 65536;
      for (var i = 0; i < lim; i++) {
        if (s.charCodeAt(i) === 0) return true;
      }
      return false;
    } catch (e) {
      return true; // be conservative on failure -> skip
    }
  }

  function importFiles(entries) {
    var count = 0, skipped = 0;
    try {
      if (!entries || typeof entries.length !== 'number') {
        return { ok: false, count: 0, skipped: 0 };
      }
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || typeof e !== 'object') { skipped++; continue; }
        var rawPath = e.path;
        var content = (e.content == null) ? '' : String(e.content);
        var p = normalizePath(rawPath);
        if (!p) { skipped++; continue; }              // empty/dir-like path
        if (/\/$/.test(String(rawPath))) { skipped++; continue; } // explicit dir
        if (looksBinary(content)) { skipped++; continue; }        // binary -> skip
        var wrote = write(p, content, 'import');
        if (wrote) count++; else skipped++;           // cap-rejected -> skipped
      }
      return { ok: count > 0, count: count, skipped: skipped };
    } catch (err) {
      return { ok: count > 0, count: count, skipped: skipped };
    }
  }

  // ===========================================================================
  // ZIP READ (best-effort) -- readZip(arrayBuffer) -> Promise<[{path,content}]>
  //   Parse a .zip via its central directory; for STORED (method 0) entries
  //   slice bytes; for DEFLATED (method 8) inflate via DecompressionStream
  //   ('deflate-raw') when available, else skip that entry. UTF-8 decode; skip
  //   directories + binary (NUL) entries. Resolve [] on failure; NEVER throws.
  //   Pairs with the makeStoreZip()/buildZip() writer above.
  // ===========================================================================
  function readU16(view, off) {
    try { return view[off] | (view[off + 1] << 8); } catch (e) { return 0; }
  }
  function readU32(view, off) {
    try {
      return (view[off] | (view[off + 1] << 8) | (view[off + 2] << 16) | (view[off + 3] << 24)) >>> 0;
    } catch (e) { return 0; }
  }

  function utf8Decode(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
    } catch (e) {}
    // manual UTF-8 decode fallback
    var out = '';
    try {
      var i = 0, len = bytes.length;
      while (i < len) {
        var c = bytes[i++];
        if (c < 0x80) { out += String.fromCharCode(c); }
        else if (c >= 0xC0 && c < 0xE0) {
          out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
        } else if (c >= 0xE0 && c < 0xF0) {
          out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
        } else if (c >= 0xF0) {
          var cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
          cp -= 0x10000;
          out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        }
      }
    } catch (e) {}
    return out;
  }

  // Inflate raw DEFLATE bytes via DecompressionStream('deflate-raw').
  // Returns Promise<Uint8Array|null> (null if unavailable / on failure).
  function inflateRaw(bytes) {
    return new Promise(function (resolve) {
      try {
        if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') {
          return resolve(null);
        }
        var ds = new DecompressionStream('deflate-raw');
        var blob;
        try { blob = new Blob([bytes]); } catch (e) { blob = null; }
        var stream = blob && blob.stream ? blob.stream() : null;
        if (!stream) {
          // fall back to constructing a ReadableStream manually
          if (typeof ReadableStream === 'undefined') return resolve(null);
          stream = new ReadableStream({
            start: function (controller) { controller.enqueue(bytes); controller.close(); }
          });
        }
        var out = stream.pipeThrough(ds);
        new Response(out).arrayBuffer().then(function (ab) {
          try { resolve(new Uint8Array(ab)); } catch (e) { resolve(null); }
        }).catch(function () { resolve(null); });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function readZip(arrayBuffer) {
    return new Promise(function (resolve) {
      try {
        if (!arrayBuffer) return resolve([]);
        var bytes;
        try {
          bytes = (arrayBuffer instanceof Uint8Array) ? arrayBuffer : new Uint8Array(arrayBuffer);
        } catch (e) { return resolve([]); }
        var len = bytes.length;
        if (len < 22) return resolve([]); // smaller than minimal EOCD record

        // 1) Locate End Of Central Directory (EOCD) signature 0x06054b50,
        //    scanning backwards from the end (comment may follow it).
        var eocd = -1;
        var scanFloor = len - 22 - 65535;
        if (scanFloor < 0) scanFloor = 0;
        for (var s = len - 22; s >= scanFloor; s--) {
          if (readU32(bytes, s) === 0x06054b50) { eocd = s; break; }
        }
        if (eocd < 0) return resolve([]);

        var total = readU16(bytes, eocd + 10);          // total central dir records
        var cdSize = readU32(bytes, eocd + 12);         // central dir size
        var cdOffset = readU32(bytes, eocd + 16);       // central dir offset
        if (cdOffset > len || cdOffset + cdSize > len) {
          // tolerate slightly off offsets by clamping
          if (cdOffset > len) return resolve([]);
        }

        // 2) Walk the central directory records.
        var jobs = [];      // { path, async:Bool, content?, bytes?, method }
        var ptr = cdOffset;
        var guard = 0;
        while (ptr + 46 <= len && guard < 100000) {
          guard++;
          if (readU32(bytes, ptr) !== 0x02014b50) break; // not a central header
          var method = readU16(bytes, ptr + 10);
          var compSize = readU32(bytes, ptr + 20);
          var nameLen = readU16(bytes, ptr + 28);
          var extraLen = readU16(bytes, ptr + 30);
          var commentLen = readU16(bytes, ptr + 32);
          var localOff = readU32(bytes, ptr + 42);
          var nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
          var name = utf8Decode(nameBytes);
          ptr = ptr + 46 + nameLen + extraLen + commentLen;

          if (!name) continue;
          if (/\/$/.test(name)) continue;               // directory entry -> skip

          // 3) Resolve the local header to find the data start (extra field
          //    length can differ from the central record).
          if (localOff + 30 > len) continue;
          if (readU32(bytes, localOff) !== 0x04034b50) continue; // not a local header
          var lNameLen = readU16(bytes, localOff + 26);
          var lExtraLen = readU16(bytes, localOff + 28);
          var dataStart = localOff + 30 + lNameLen + lExtraLen;
          if (dataStart > len) continue;
          var dataEnd = dataStart + compSize;
          if (dataEnd > len) dataEnd = len;
          var raw = bytes.subarray(dataStart, dataEnd);

          if (method === 0) {
            // STORED -> raw bytes are the content
            jobs.push({ path: name, async: false, bytes: raw });
          } else if (method === 8) {
            // DEFLATED -> needs inflate (may be unavailable)
            jobs.push({ path: name, async: true, bytes: raw });
          } else {
            // unsupported method -> skip
            continue;
          }
        }

        // 4) Materialize each job (inflate as needed), then build results.
        var results = [];
        function finalizeBytes(name, decompressed) {
          try {
            if (!decompressed) return; // skip on inflate failure
            var text = utf8Decode(decompressed);
            if (looksBinary(text)) return;      // binary -> skip
            var p = normalizePath(name);
            if (!p) return;
            results.push({ path: p, content: text });
          } catch (e) {}
        }

        function step(idx) {
          // Drain consecutive synchronous (STORED) jobs in a loop so a zip with
          // thousands of stored entries can't overflow the call stack; only async
          // (DEFLATED) jobs break out to a .then() continuation (stack = O(#deflated)).
          while (idx < jobs.length && !jobs[idx].async) {
            finalizeBytes(jobs[idx].path, jobs[idx].bytes);
            idx++;
          }
          if (idx >= jobs.length) { return resolve(results); }
          var job = jobs[idx];
          inflateRaw(job.bytes).then(function (out) {
            finalizeBytes(job.path, out);
            step(idx + 1);
          }).catch(function () {
            step(idx + 1);
          });
        }
        step(0);
      } catch (e) {
        resolve([]);
      }
    });
  }

  // ===========================================================================
  // ATTACH
  // ===========================================================================
  App.Workspace = {
    write: write,
    read: read,
    remove: remove,
    list: list,
    clear: clear,
    tree: tree,
    detectLang: detectLang,
    parseFileBlocks: parseFileBlocks,
    buildZip: buildZip,
    assembleRunnable: assembleRunnable,
    githubPush: githubPush,
    // PROJECT IMPORT (Wave 3 builder)
    importFiles: importFiles,
    readZip: readZip,
    // VERSION HISTORY (Wave 1 reliability core)
    history: history,
    restore: restore,
    diffLines: diffLines,
    // helpers exposed for reuse / testing (additive, non-spec)
    normalizePath: normalizePath,
    toBase64Utf8: toBase64Utf8
  };

})();
