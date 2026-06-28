// =============================================================================
// main.js  →  App.main   (BOOTSTRAP + rAF LOOP) — RUNS LAST; only auto-running file.
// PIXEL AI COMPANY ("NEON//WORKS")
//
// Authority: SPEC.md §7.8 (init/loop/resize/draw), §4.1 (DPR transform applied
//            ONCE here so every other module works in CSS screen px), §7.8 draw
//            order (tiles → furniture → agents → FX), §10 (loop never throws).
//
//   App.main.init()  — Store.init(); grab canvas+ctx; imageSmoothingEnabled=false;
//                      resize(); UI.init(); start rAF loop.
//   App.main.loop(ts)— dt=clamp((ts-last)/1000,0,0.05); _time+=dt; sim+tick; draw.
//   App.main.resize()— canvas.width=clientW*dpr; setTransform(dpr,...) ONCE.
//   App.main.draw()  — clear(void) → tiles(visible) → furniture → Agents.draw → FX.
//
// Classic <script>; no import/export. Attaches to window.App.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  function CFG()   { return App.config || {}; }
  function STATE() { return App.state; }
  function WORLD() { return App.World; }
  function PA()    { return App.PixelArt; }

  var Main = {};

  var _canvas = null;
  var _ctx = null;
  var _dpr = 1;
  var _last = 0;
  var _running = false;
  var _saveAccum = 0;          // periodic autosave timer
  var _lastSignature = '';     // change detection for "meaningful changes" autosave

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  Main.init = function () {
    try {
      // 0) environment flags (defensive; never fatal).
      detectReduceMotion();
      injectManifest();

      // 1) state: load or seed.
      if (App.Store && App.Store.init) App.Store.init();

      // 2) canvas + ctx.
      _canvas = document.getElementById('world-canvas');
      if (!_canvas || !_canvas.getContext) {
        toast('Canvas not found — cannot render the office.');
        return;
      }
      _ctx = _canvas.getContext('2d');
      _ctx.imageSmoothingEnabled = false;

      Main.resize();
      window.addEventListener('resize', Main.resize);

      // 3) UI wiring.
      if (App.UI && App.UI.init) App.UI.init();

      // 3b) shared-link import (async, fire-and-forget). If a state arrives via
      //     #s=..., Share loads it through Store; refresh the UI when it lands.
      maybeImportFromHash();

      // 4) loop.
      _running = true;
      _last = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      requestAnimationFrame(Main.loop);
    } catch (e) {
      toast('Startup error: ' + ((e && e.message) || e));
      try { console && console.error && console.error('[App.main.init]', e); } catch (e2) {}
    }
  };

  // ---------------------------------------------------------------------------
  // prefers-reduced-motion — set a pure flag on App.state. We do NOT rewrite the
  // draw loop here; modules/CSS consult the flag. Re-read on changes.
  // ---------------------------------------------------------------------------
  function detectReduceMotion() {
    try {
      var s = STATE();
      var mq = (typeof window !== 'undefined' && window.matchMedia)
        ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      var on = !!(mq && mq.matches);
      if (s) s.reduceMotion = on;
      if (mq) {
        var onChange = function (e) {
          try { var st = STATE(); if (st) st.reduceMotion = !!(e && e.matches); } catch (e2) {}
        };
        // addEventListener is the modern API; addListener is the legacy fallback.
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) {
      try { var st2 = STATE(); if (st2) st2.reduceMotion = false; } catch (e2) {}
    }
  }

  // ---------------------------------------------------------------------------
  // installable Web App Manifest — generated at runtime and attached via a blob
  // URL <link rel="manifest">, with a procedurally generated neon SVG icon so the
  // app is installable with zero external assets. Defensive + non-fatal.
  // ---------------------------------------------------------------------------
  function injectManifest() {
    try {
      if (typeof document === 'undefined') return;
      if (document.querySelector('link[rel="manifest"]')) return; // don't double-inject

      var pal = (CFG() && CFG().palette) || {};
      var bg = pal.void || '#070912';
      var theme = pal.cyan || '#39d7ff';
      var iconUrl = neonIconDataUri(theme, pal.magenta || '#ff3df0', bg);

      var manifest = {
        name: 'NEON//WORKS',
        short_name: 'NEONWORKS',
        description: 'A living pixel-art AI agent collective you direct like a company.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'any',
        background_color: bg,
        theme_color: theme,
        icons: [
          { src: iconUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      };

      var json = JSON.stringify(manifest);
      var href;
      try {
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
          href = URL.createObjectURL(new Blob([json], { type: 'application/manifest+json' }));
        }
      } catch (eBlob) { href = null; }
      if (!href) {
        // data-URI fallback (some engines reject blob: manifests).
        href = 'data:application/manifest+json;charset=utf-8,' + encodeURIComponent(json);
      }

      var link = document.createElement('link');
      link.rel = 'manifest';
      link.href = href;
      var head = document.head || document.getElementsByTagName('head')[0];
      if (head) head.appendChild(link);
    } catch (e) {
      try { console && console.warn && console.warn('[App.main.injectManifest]', e); } catch (e2) {}
    }
  }

  // Build a small NEON//WORKS app icon as an SVG data-URI (no external assets).
  function neonIconDataUri(c1, c2, bg) {
    // 512x512 rounded-square tile with two hex nodes + a connecting bolt.
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
        '<rect width="512" height="512" rx="96" fill="' + bg + '"/>' +
        '<g fill="none" stroke="' + c1 + '" stroke-width="22" stroke-linejoin="round">' +
          '<path d="M150 150 L260 150 L300 215 L260 280 L150 280 L110 215 Z"/>' +
        '</g>' +
        '<g fill="none" stroke="' + c2 + '" stroke-width="22" stroke-linejoin="round">' +
          '<path d="M252 232 L362 232 L402 297 L362 362 L252 362 L212 297 Z"/>' +
        '</g>' +
        '<path d="M236 196 L300 196 L268 256 L320 256 L210 366 L246 286 L196 286 Z" fill="' + c1 + '" opacity="0.9"/>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // ---------------------------------------------------------------------------
  // shared-link import — defer to App.Share.importFromHash() if present. It is
  // async; on a successful load we re-render the full UI. Never throws.
  // ---------------------------------------------------------------------------
  function maybeImportFromHash() {
    try {
      if (!(App.Share && App.Share.importFromHash)) return;
      var p = App.Share.importFromHash();
      if (p && typeof p.then === 'function') {
        p.then(function (loaded) {
          if (loaded) refreshAfterLoad();
        }, function (err) {
          try { console && console.warn && console.warn('[App.main.importFromHash]', err); } catch (e2) {}
        });
      } else if (p) {
        refreshAfterLoad();
      }
    } catch (e) {
      try { console && console.warn && console.warn('[App.main.maybeImportFromHash]', e); } catch (e2) {}
    }
  }

  // Re-render every overlay after a fresh state lands (mirror UI.init's pass).
  function refreshAfterLoad() {
    try {
      var u = App.UI;
      if (!u) return;
      if (u.refreshArtifacts) u.refreshArtifacts();
      if (u.refreshFiles) u.refreshFiles();
      if (u.refreshLedger) u.refreshLedger();
      if (u.refresh) u.refresh();
    } catch (e) {
      try { console && console.warn && console.warn('[App.main.refreshAfterLoad]', e); } catch (e2) {}
    }
  }

  // ---------------------------------------------------------------------------
  // resize — size to CSS box × DPR; apply DPR transform ONCE (SPEC §4.1).
  // ---------------------------------------------------------------------------
  Main.resize = function () {
    try {
      if (!_canvas) return;
      _dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      if (!_dpr || _dpr < 1) _dpr = 1;
      var cw = _canvas.clientWidth || _canvas.width || 960;
      var ch = _canvas.clientHeight || _canvas.height || 600;
      _canvas.width = Math.max(1, Math.round(cw * _dpr));
      _canvas.height = Math.max(1, Math.round(ch * _dpr));
      if (_ctx) {
        // Single DPR transform — all modules thereafter work in CSS screen px.
        _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
        _ctx.imageSmoothingEnabled = false;
      }
      if (WORLD() && WORLD().clampCamera) WORLD().clampCamera();
    } catch (e) {
      try { console && console.warn && console.warn('[App.main.resize]', e); } catch (e2) {}
    }
  };

  // ---------------------------------------------------------------------------
  // loop
  // ---------------------------------------------------------------------------
  Main.loop = function (ts) {
    if (!_running) return;
    var now = (typeof ts === 'number') ? ts
      : ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    // ECO (heat): cap the loop to ~40fps. A skipped frame is just a cheap time-check
    // + reschedule, so we shed ~1/3 of the per-frame sim+canvas-render cost vs 60fps.
    if ((now - _last) < (CFG().ECO_FRAME_MS || 24)) { requestAnimationFrame(Main.loop); return; }
    var dt = (now - _last) / 1000;
    _last = now;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;     // clamp big gaps (tab switch) to keep sim stable

    var s = STATE();
    if (s) {
      if (typeof s._time !== 'number') s._time = 0;
      s._time += dt;
    }

    // --- simulation + orchestration (guarded) ---
    try {
      if (App.Agents && App.Agents.update) App.Agents.update(dt); // bubble expiry even if paused
    } catch (e) { warnOnce('agents.update', e); }

    try {
      if (s && !s.paused && App.Orchestrator && App.Orchestrator.tick) App.Orchestrator.tick();
    } catch (e) { warnOnce('orchestrator.tick', e); }

    // --- render: skip the heavy canvas draw when the tab is HIDDEN (ECO/heat).
    //     Sim + orchestration above keep running, so work continues in the bg. ---
    if (!(typeof document !== 'undefined' && document.hidden)) {
      // follow-camera: gently ease the camera toward the followed agent
      try { followCamera(s); } catch (e) { warnOnce('main.followCamera', e); }
      // draw (guarded)
      try { Main.draw(); } catch (e) { warnOnce('main.draw', e); }
      // minimap overlay (guarded; never throws into the loop)
      try { if (App.UI && App.UI.drawMinimap) App.UI.drawMinimap(); } catch (e) { warnOnce('ui.drawMinimap', e); }
    }

    // --- periodic autosave on meaningful change ---
    _saveAccum += dt;
    if (_saveAccum >= 2) {
      _saveAccum = 0;
      maybeAutosave();
    }

    requestAnimationFrame(Main.loop);
  };

  // ---------------------------------------------------------------------------
  // draw — tiles (visible range) → furniture → agents → FX overlay.
  // ---------------------------------------------------------------------------
  Main.draw = function () {
    var ctx = _ctx;
    if (!ctx || !_canvas) return;
    var s = STATE();
    var w = WORLD(), art = PA();
    var cfg = CFG();

    // CSS px viewport (DPR transform already applied).
    var cssW = _canvas.clientWidth || (_canvas.width / _dpr);
    var cssH = _canvas.clientHeight || (_canvas.height / _dpr);

    // 1) clear to void.
    var pal = (art && art.getPalette) ? art.getPalette() : (cfg.palette || {});
    ctx.fillStyle = pal.void || '#070912';
    ctx.fillRect(0, 0, cssW, cssH);

    if (!s || !s.layout || !w || !art) {
      // Still draw FX so the screen isn't dead, then bail.
      try { if (art && art.drawFX) art.drawFX(ctx, cssW, cssH, s ? s._time : 0); } catch (e) {}
      return;
    }

    var L = s.layout;
    var size = w.cellSizeScreen ? w.cellSizeScreen() : 48;

    // Visible cell range (cull off-screen tiles for perf).
    var tl = w.screenToCell ? w.screenToCell(0, 0) : { gx: 0, gy: 0 };
    var br = w.screenToCell ? w.screenToCell(cssW, cssH) : { gx: (L.cols || 30), gy: (L.rows || 20) };
    var gx0 = Math.max(0, tl.gx - 1);
    var gy0 = Math.max(0, tl.gy - 1);
    var gx1 = Math.min((L.cols || 30) - 1, br.gx + 1);
    var gy1 = Math.min((L.rows || 20) - 1, br.gy + 1);

    // 2) tiles.
    if (art.drawTile) {
      for (var gy = gy0; gy <= gy1; gy++) {
        for (var gx = gx0; gx <= gx1; gx++) {
          var t = w.tileAt ? w.tileAt(gx, gy) : 0;
          var scr = w.worldToScreen((gx) * (cfg.TILE || 16), (gy) * (cfg.TILE || 16));
          try { art.drawTile(ctx, t, scr.x, scr.y, size); } catch (e) {}
        }
      }
    }

    // 3) furniture (draw all; cheap for our counts). Pass seated agent if any.
    if (art.drawFurniture && L.furniture) {
      for (var fi = 0; fi < L.furniture.length; fi++) {
        var f = L.furniture[fi];
        if (!f) continue;
        // cull if entirely off-screen
        if (f.gx + (f.w || 1) < gx0 || f.gx > gx1 + 1 || f.gy + (f.h || 1) < gy0 || f.gy > gy1 + 1) continue;
        var fscr = w.worldToScreen(f.gx * (cfg.TILE || 16), f.gy * (cfg.TILE || 16));
        var seated = seatedAgentFor(f, s);
        try { art.drawFurniture(ctx, f, fscr.x, fscr.y, size, seated); } catch (e) {}
      }
    }

    // 4) agents (y-sorted; Agents.draw computes its own screen coords).
    try { if (App.Agents && App.Agents.draw) App.Agents.draw(ctx); } catch (e) {}

    // 5) FX overlay LAST (scanlines + bloom + vignette + day/night ambiance tint).
    //    drawFX reads the loop clock (s._time) for scanline drift and the real local
    //    hour for the ambiance tint — passing _time keeps the FX pass in lockstep.
    try { if (art.drawFX) art.drawFX(ctx, cssW, cssH, (typeof s._time === 'number') ? s._time : 0); } catch (e) {}
  };

  // ---------------------------------------------------------------------------
  // follow-camera — ease the camera so the followed agent stays centered.
  //   Gentle lerp; clamps after. No-op (and never throws) when nothing to follow.
  // ---------------------------------------------------------------------------
  function followCamera(s) {
    if (!s || !s._followId || !s.camera) return;
    var agents = s.agents;
    if (!Array.isArray(agents)) return;
    var a = null;
    for (var i = 0; i < agents.length; i++) {
      if (agents[i] && agents[i].id === s._followId) { a = agents[i]; break; }
    }
    if (!a) { s._followId = null; return; } // followed agent gone
    var ax = (typeof a.x === 'number') ? a.x : null;
    var ay = (typeof a.y === 'number') ? a.y : null;
    if (ax == null || ay == null) return;

    var cfg = CFG();
    var pps = (cfg.PIXEL || 3) * s.camera.zoom;
    if (!(pps > 0)) return;
    // desired camera top-left so the agent sits at viewport center.
    var vw = _canvas ? (_canvas.clientWidth || (_canvas.width / _dpr)) : 0;
    var vh = _canvas ? (_canvas.clientHeight || (_canvas.height / _dpr)) : 0;
    var targetX = ax - (vw / 2) / pps;
    var targetY = ay - (vh / 2) / pps;
    var lerp = 0.08; // small factor → gentle glide
    s.camera.x += (targetX - s.camera.x) * lerp;
    s.camera.y += (targetY - s.camera.y) * lerp;
    if (WORLD() && WORLD().clampCamera) WORLD().clampCamera();
  }

  // Find the agent currently seated at this furniture's seat (for monitor content).
  function seatedAgentFor(f, s) {
    if (!f || typeof f.seatGx !== 'number') return null;
    if (!s || !Array.isArray(s.agents)) return null;
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (!a) continue;
      if (a.gx === f.seatGx && a.gy === f.seatGy &&
          (a.state === 'coding' || a.state === 'searching' || a.state === 'idle' || a.state === 'thinking')) {
        return a;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // autosave — persist when a cheap signature of persistable state changes.
  // ---------------------------------------------------------------------------
  function maybeAutosave() {
    try {
      var s = STATE();
      if (!s) return;
      var sig = signature(s);
      if (sig !== _lastSignature) {
        _lastSignature = sig;
        if (App.Store && App.Store.save) App.Store.save();
      }
    } catch (e) { /* never throw from loop */ }
  }

  function signature(s) {
    // Cheap structural fingerprint: counts + statuses + selection + camera + settings hash.
    var parts = [];
    parts.push('a' + (s.agents ? s.agents.length : 0));
    if (s.tasks) {
      for (var i = 0; i < s.tasks.length; i++) {
        var t = s.tasks[i];
        if (t) parts.push(t.id + ':' + t.status);
      }
    }
    parts.push('sel' + (s.selectedAgentId || '-'));
    if (s.settings) parts.push('ws' + (s.settings.webSearch ? 1 : 0) + (s.settings.apiKey ? 'k' : '-'));
    if (s.layout && s.layout.furniture) parts.push('f' + s.layout.furniture.length);
    parts.push('log' + (s.log ? s.log.length : 0));
    return parts.join('|');
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  var _warned = {};
  function warnOnce(where, e) {
    if (_warned[where]) return;
    _warned[where] = true;
    try { console && console.warn && console.warn('[App.main:' + where + '] (suppressing repeats)', e); } catch (e2) {}
  }

  function toast(msg) {
    try { if (App.UI && App.UI.toast) { App.UI.toast(msg, 'error'); return; } } catch (e) {}
    try { console && console.warn && console.warn(msg); } catch (e2) {}
  }

  // ---------------------------------------------------------------------------
  // publish + autostart
  // ---------------------------------------------------------------------------
  App.main = Main;

  function boot() { Main.init(); }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      // DOM already parsed (script at end of body) — start now.
      boot();
    }
  }

})();
