// share.js — App.Share
// ---------------------------------------------------------------------------
// Contract (B): shareable links + state files + lightweight presets.
//
//   App.Share.exportLink()            -> string  (location + '#s=' + urlSafeB64(gzip(JSON)))
//   App.Share.importFromHash()        -> Promise<boolean>  (decode '#s=' and load on boot)
//   App.Share.downloadStateFile()     -> void     (download neonworks-state.json)
//   App.Share.loadStateFile(file)     -> Promise<boolean>  (load a .json state File)
//   App.Share.exportPreset()          -> void     (download lightweight OFFICE preset, no secrets)
//   App.Share.importPreset(file)      -> Promise<boolean>  (apply a preset .json)
//
// Design notes:
//   - Persistence is NOT reinvented. We reuse App.Store.exportJSON() (full
//     snapshot -> pretty JSON string) and App.Store.importJSON(str) (validate
//     + migrate + apply + save + refresh, returns bool). importJSON IS the same
//     load/replace path the DATA import uses, so links/files/presets all flow
//     through it.
//   - Compression: CompressionStream('gzip') / DecompressionStream('gzip') when
//     available, else a plain (uncompressed) base64 fallback. A 1-char marker is
//     prepended to the URL-safe base64 so import knows which path to take:
//       'G' + b64  -> gzipped payload
//       'R' + b64  -> raw (uncompressed) UTF-8 JSON
//   - URL-safe base64: standard base64 with  + / =  ->  - _  (padding stripped).
//   - Defensive: every public fn swallows errors. Malformed link/file resolves
//     false (or returns location for exportLink) and NEVER throws.
//   - Classic <script> module. NO import/export. Attaches to window.App.Share.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  var App = (window.App = window.App || {});

  // -- lazy resolvers (App.* may load in any order) ---------------------------
  function store() { return (App && App.Store) ? App.Store : null; }
  function ws() { return (App && App.Workspace) ? App.Workspace : null; }

  function logErr(where, e) {
    try { if (App.Store && App.Store.log) App.Store.log({ from: 'system', to: 'all', kind: 'error', text: 'share:' + where + ': ' + ((e && e.message) ? e.message : e) }); } catch (_) {}
    try { if (typeof console !== 'undefined' && console.warn) console.warn('share:' + where, e); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // UTF-8  <->  bytes
  // ---------------------------------------------------------------------------
  function strToBytes(str) {
    try {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    } catch (e) {}
    // manual UTF-8 encode fallback
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return new Uint8Array(out);
  }

  function bytesToStr(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {}
    // manual UTF-8 decode fallback
    var res = '';
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) { res += String.fromCharCode(b); }
      else if (b >= 0xc0 && b < 0xe0) { res += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f)); }
      else if (b >= 0xe0 && b < 0xf0) { res += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)); }
      else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        res += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // base64 (standard)  <->  bytes
  // ---------------------------------------------------------------------------
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
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
    // manual base64 encode
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
      var x = bytes[i], y = bytes[i + 1];
      res += B64[(x >> 2) & 63] + B64[((x << 4) | (y >> 4)) & 63] + B64[(y << 2) & 63] + '=';
    }
    return res;
  }

  function base64ToBytes(b64) {
    // strip whitespace; tolerate missing padding
    b64 = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      if (typeof atob === 'function') {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
        return out;
      }
    } catch (e) {}
    // manual base64 decode
    var lookup = {};
    for (var k = 0; k < B64.length; k++) lookup[B64[k]] = k;
    var clean = b64.replace(/=+$/, '');
    var bytes = [];
    var buf = 0, bits = 0;
    for (var j = 0; j < clean.length; j++) {
      var v = lookup[clean[j]];
      if (v === undefined) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
    }
    return new Uint8Array(bytes);
  }

  // url-safe base64: + / =  ->  - _  (padding stripped)  and back
  function toUrlSafe(b64) {
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromUrlSafe(s) {
    return String(s).replace(/-/g, '+').replace(/_/g, '/');
  }

  // ---------------------------------------------------------------------------
  // gzip via streams (async). Returns a Promise<Uint8Array> or rejects.
  // ---------------------------------------------------------------------------
  function gzipBytes(bytes) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') { reject(new Error('no-gzip')); return; }
        var cs = new CompressionStream('gzip');
        var writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        new Response(cs.readable).arrayBuffer().then(function (buf) {
          resolve(new Uint8Array(buf));
        }, reject);
      } catch (e) { reject(e); }
    });
  }

  function gunzipBytes(bytes) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') { reject(new Error('no-gunzip')); return; }
        var ds = new DecompressionStream('gzip');
        var writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        new Response(ds.readable).arrayBuffer().then(function (buf) {
          resolve(new Uint8Array(buf));
        }, reject);
      } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------------------
  // payload codec — string <-> marked url-safe base64
  //   encode: try gzip ('G'+b64); on any failure fall back to raw ('R'+b64).
  //   decode: read marker, gunzip or pass through. ALWAYS resolves a string or
  //           rejects (callers treat reject as "malformed").
  // ---------------------------------------------------------------------------
  function encodePayload(str) {
    return new Promise(function (resolve) {
      var bytes = strToBytes(str);
      gzipBytes(bytes).then(function (gz) {
        resolve('G' + toUrlSafe(bytesToBase64(gz)));
      }, function () {
        // gzip unavailable/failed -> plain base64
        resolve('R' + toUrlSafe(bytesToBase64(bytes)));
      });
    });
  }

  function decodePayload(marked) {
    return new Promise(function (resolve, reject) {
      try {
        marked = String(marked || '');
        if (!marked) { reject(new Error('empty')); return; }
        var marker = marked.charAt(0);
        var body = marked.slice(1);
        // Back-compat / lenient: if no recognized marker, treat the whole thing
        // as raw url-safe base64 of UTF-8 JSON.
        if (marker !== 'G' && marker !== 'R') { marker = 'R'; body = marked; }
        var bytes = base64ToBytes(fromUrlSafe(body));
        if (marker === 'G') {
          gunzipBytes(bytes).then(function (raw) {
            try { resolve(bytesToStr(raw)); } catch (e) { reject(e); }
          }, reject);
        } else {
          resolve(bytesToStr(bytes));
        }
      } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------
  function baseUrl() {
    try {
      if (typeof location !== 'undefined') return location.origin + location.pathname;
    } catch (e) {}
    return '';
  }

  function snapshotJSON() {
    // reuse Store's DATA-export serializer (pretty JSON string).
    var st = store();
    if (st && typeof st.exportJSON === 'function') return st.exportJSON();
    return '';
  }

  function loadSnapshotJSON(jsonStr) {
    // reuse Store's DATA-import path (validate + migrate + apply + save + refresh).
    var st = store();
    if (st && typeof st.importJSON === 'function') return !!st.importJSON(jsonStr);
    return false;
  }

  function triggerDownload(text, filename, mime) {
    // Prefer the Workspace helper (Blob-based) so behavior matches the rest of
    // the app; fall back to a local Blob+anchor if Workspace isn't present.
    try {
      var blob = (typeof Blob !== 'undefined')
        ? new Blob([text], { type: mime || 'application/json' })
        : null;
      var w = ws();
      if (blob && w && typeof w.triggerDownload === 'function') {
        return w.triggerDownload(blob, filename);
      }
      if (!blob || typeof document === 'undefined' || typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function') {
        return false;
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || 'neonworks-state.json';
      if (document.body && document.body.appendChild) document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      return true;
    } catch (e) { logErr('triggerDownload', e); return false; }
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      try {
        if (!file) { reject(new Error('no-file')); return; }
        // Modern path: File.text()
        if (typeof file.text === 'function') {
          file.text().then(resolve, reject);
          return;
        }
        if (typeof FileReader === 'undefined') { reject(new Error('no-FileReader')); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------------------
  // PUBLIC — exportLink / importFromHash  (the '#s=' share link)
  // ---------------------------------------------------------------------------

  // exportLink() -> full shareable URL. Synchronous return per contract: we
  // produce the base64 synchronously via a guaranteed-available codec. gzip is
  // async (streams), so for the SYNC return we use the raw('R') encoding; the
  // importer accepts both 'G' and 'R'. (exportLinkAsync below adds gzip when the
  // caller can await — used internally is optional.)
  function exportLink() {
    try {
      var json = snapshotJSON();
      if (!json) return baseUrl();
      var bytes = strToBytes(json);
      var payload = 'R' + toUrlSafe(bytesToBase64(bytes));
      return baseUrl() + '#s=' + payload;
    } catch (e) {
      logErr('exportLink', e);
      return baseUrl();
    }
  }

  // Async variant that uses gzip when available (smaller links for big states).
  // Returns Promise<string>. Falls back to the sync raw link on any failure.
  function exportLinkAsync() {
    return new Promise(function (resolve) {
      try {
        var json = snapshotJSON();
        if (!json) { resolve(baseUrl()); return; }
        encodePayload(json).then(function (payload) {
          resolve(baseUrl() + '#s=' + payload);
        }, function () {
          resolve(exportLink());
        });
      } catch (e) {
        logErr('exportLinkAsync', e);
        resolve(exportLink());
      }
    });
  }

  // importFromHash() -> Promise<boolean>. Decodes '#s=' and loads through Store.
  function importFromHash() {
    return new Promise(function (resolve) {
      try {
        if (typeof location === 'undefined' || !location.hash) { resolve(false); return; }
        var h = location.hash;
        // accept '#s=' (case-sensitive per contract) at the start
        if (h.indexOf('#s=') !== 0) { resolve(false); return; }
        var marked = h.slice(3);
        if (!marked) { resolve(false); return; }
        decodePayload(marked).then(function (json) {
          var ok = false;
          try { ok = loadSnapshotJSON(json); } catch (e) { logErr('importFromHash:load', e); ok = false; }
          // Clear the hash regardless (so a bad link doesn't re-trigger / linger)
          clearHash();
          resolve(!!ok);
        }, function (e) {
          logErr('importFromHash:decode', e);
          clearHash();
          resolve(false);
        });
      } catch (e) {
        logErr('importFromHash', e);
        resolve(false);
      }
    });
  }

  function clearHash() {
    try {
      if (typeof location === 'undefined') return;
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        location.hash = '';
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // PUBLIC — state file download / load
  // ---------------------------------------------------------------------------

  function downloadStateFile() {
    try {
      var json = snapshotJSON();
      if (!json) json = '{}';
      return triggerDownload(json, 'neonworks-state.json', 'application/json');
    } catch (e) { logErr('downloadStateFile', e); return false; }
  }

  function loadStateFile(file) {
    return new Promise(function (resolve) {
      try {
        readFileText(file).then(function (txt) {
          var ok = false;
          try { ok = loadSnapshotJSON(txt); } catch (e) { logErr('loadStateFile:load', e); ok = false; }
          resolve(!!ok);
        }, function (e) {
          logErr('loadStateFile:read', e);
          resolve(false);
        });
      } catch (e) {
        logErr('loadStateFile', e);
        resolve(false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // PRESET — lightweight OFFICE share (roster + layout/upgrades + settings,
  // EXCLUDING any apiKey/token). The marketplace-style share.
  // ---------------------------------------------------------------------------

  // strip secrets from a settings object (shallow clone; never mutate input).
  function sanitizeSettings(settings) {
    var s = (settings && typeof settings === 'object') ? settings : {};
    var out = {};
    for (var k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k]; }
    // drop credentials entirely
    delete out.apiKey;
    delete out.openaiKey;
    if (out.github && typeof out.github === 'object') {
      var g = {};
      for (var gk in out.github) { if (Object.prototype.hasOwnProperty.call(out.github, gk)) g[gk] = out.github[gk]; }
      g.token = '';   // never share the GitHub token
      out.github = g;
    }
    return out;
  }

  // Build a preset object from the current full snapshot. We parse Store's own
  // exportJSON so the agent/layout shapes are exactly what importJSON expects.
  function buildPresetObject() {
    var json = snapshotJSON();
    var blob = JSON.parse(json);   // may throw -> caller catches
    return {
      _preset: true,
      v: blob.v,
      savedAt: (typeof Date !== 'undefined') ? Date.now() : 0,
      agents: Array.isArray(blob.agents) ? blob.agents : [],
      layout: blob.layout || null,
      upgrades: Array.isArray(blob.upgrades) ? blob.upgrades : [],
      settings: sanitizeSettings(blob.settings),
    };
  }

  function exportPreset() {
    try {
      var preset = buildPresetObject();
      var txt = JSON.stringify(preset, null, 2);
      return triggerDownload(txt, 'neonworks-preset.json', 'application/json');
    } catch (e) { logErr('exportPreset', e); return false; }
  }

  // Apply a preset: overlay its roster/layout/upgrades/settings onto the CURRENT
  // full snapshot (preserving tasks/log/artifacts/files/credits), then run it
  // through the standard importJSON load path. Sensitive settings already in the
  // live state (apiKey/token) are RETAINED — the preset never carries them.
  function applyPresetObject(preset) {
    if (!preset || typeof preset !== 'object') return false;
    // current full snapshot to overlay onto
    var current;
    try { current = JSON.parse(snapshotJSON()); }
    catch (e) { current = {}; }
    if (!current || typeof current !== 'object') current = {};

    // roster + office
    if (Array.isArray(preset.agents)) current.agents = preset.agents;
    if (preset.layout) current.layout = preset.layout;
    if (Array.isArray(preset.upgrades)) current.upgrades = preset.upgrades;

    // settings: merge preset settings (secret-stripped) over current, but keep
    // the user's live credentials.
    var curSettings = (current.settings && typeof current.settings === 'object') ? current.settings : {};
    var liveApiKey = curSettings.apiKey;
    var liveOpenai = curSettings.openaiKey;
    var liveToken = (curSettings.github && typeof curSettings.github === 'object') ? curSettings.github.token : undefined;

    var presetSettings = sanitizeSettings(preset.settings);   // already has no secrets, but be safe
    var merged = {};
    var kk;
    for (kk in curSettings) { if (Object.prototype.hasOwnProperty.call(curSettings, kk)) merged[kk] = curSettings[kk]; }
    for (kk in presetSettings) { if (Object.prototype.hasOwnProperty.call(presetSettings, kk)) merged[kk] = presetSettings[kk]; }
    // restore live credentials (preset must never overwrite them)
    if (liveApiKey !== undefined) merged.apiKey = liveApiKey;
    if (liveOpenai !== undefined) merged.openaiKey = liveOpenai;
    if (merged.github && typeof merged.github === 'object' && liveToken !== undefined) {
      merged.github.token = liveToken;
    }
    current.settings = merged;

    // applying a preset starts a fresh office: drop in-flight tasks so we don't
    // resurrect work that referenced the old roster. Keep history/files/credits.
    current.tasks = [];

    return loadSnapshotJSON(JSON.stringify(current));
  }

  function importPreset(file) {
    return new Promise(function (resolve) {
      try {
        readFileText(file).then(function (txt) {
          var ok = false;
          try {
            var obj = JSON.parse(txt);
            ok = applyPresetObject(obj);
          } catch (e) { logErr('importPreset:parse', e); ok = false; }
          resolve(!!ok);
        }, function (e) {
          logErr('importPreset:read', e);
          resolve(false);
        });
      } catch (e) {
        logErr('importPreset', e);
        resolve(false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------
  App.Share = {
    exportLink: exportLink,
    exportLinkAsync: exportLinkAsync,   // bonus: gzip-when-available async link
    importFromHash: importFromHash,
    downloadStateFile: downloadStateFile,
    loadStateFile: loadStateFile,
    exportPreset: exportPreset,
    importPreset: importPreset,
  };

})();
