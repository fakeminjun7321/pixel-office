window.App = window.App || {};
/* ===========================================================================
   onboarding.js -> App.Onboarding  [Wave B/C: First-run tour + empty states]
   Self-installing. If !settings.onboarded, after load shows a short spotlight
   tour over the HUD buttons (Next/Skip). On finish/skip sets onboarded=true and
   persists via App.Store.save. App.Onboarding.start() re-runs it on demand.
   Injects own DOM/styles. Guards everything; never blocks the app.
   =========================================================================== */
(function () {
  'use strict';

  var Onboarding = {};
  var els = null;          // { wrap, scrim, spot, pop, title, body, dots, next, skip }
  var steps = [];
  var idx = 0;
  var open = false;
  var installed = false;

  function STATE()  { return App.state || null; }
  function settings() {
    var s = STATE();
    if (!s) return null;
    if (!s.settings || typeof s.settings !== 'object') s.settings = {};
    return s.settings;
  }

  function persist() {
    try { if (App.Store && typeof App.Store.save === 'function') App.Store.save(); } catch (e) {}
  }

  function t(key, fallback) {
    try {
      if (App.I18n && typeof App.I18n.t === 'function') {
        var v = App.I18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (e) {}
    return fallback;
  }

  // ---- step definitions (resolved lazily so missing targets are skipped) --
  function buildSteps() {
    var defs = [
      { sel: '#btn-settings',     title: t('tour.settings.title', 'Set your API key'),
        body: t('tour.settings.body', 'Open Settings to add your Anthropic or OpenAI API key. Agents need it to think.') },
      { sel: '#hud-task-input',   title: t('tour.dispatch.title', 'Dispatch a goal'),
        body: t('tour.dispatch.body', 'Type a goal here and hit Dispatch. The Boss breaks it into subtasks for the crew.') },
      { sel: '#world-canvas',     title: t('tour.watch.title', 'Watch the agents'),
        body: t('tour.watch.body', 'Workers walk the office, collaborate, take breaks, and stream their results live.'),
        fallbackSel: '#stage' },
      { sel: '#btn-artifacts',    title: t('tour.artifacts.title', 'Collect artifacts'),
        body: t('tour.artifacts.body', 'Finished outputs land in Artifacts with a formatted preview.') },
      { sel: '#btn-sessions',     title: t('tour.sessions.title', 'Save sessions'),
        body: t('tour.sessions.body', 'Save and reload entire company states from Sessions whenever you like.') }
    ];
    var out = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var el = document.querySelector(d.sel) || (d.fallbackSel ? document.querySelector(d.fallbackSel) : null);
      if (el) out.push({ el: el, title: d.title, body: d.body });
    }
    return out;
  }

  // ---- DOM + styles -------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('onb-styles')) return;
    var css = '' +
      '.onb-wrap{position:absolute;inset:0;z-index:130;}' +
      '.onb-scrim{position:absolute;inset:0;background:rgba(5,7,15,.62);transition:clip-path .2s ease;}' +
      '.onb-spot{position:absolute;border:2px solid var(--accent,#5cf2ff);border-radius:8px;' +
        'box-shadow:0 0 0 9999px rgba(5,7,15,.62),0 0 18px var(--accent,#5cf2ff);' +
        'pointer-events:none;transition:all .2s ease;}' +
      '.onb-pop{position:absolute;width:min(300px,84vw);background:var(--panel,#0b1024);' +
        'border:1px solid var(--panel-edge,#22305c);border-radius:10px;padding:14px 15px;' +
        'box-shadow:0 16px 48px rgba(0,0,0,.55);transition:all .2s ease;}' +
      '.onb-title{margin:0 0 6px;font-size:13px;font-weight:800;letter-spacing:1px;color:var(--text,#dce6ff);}' +
      '.onb-body{margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--text-dim,#8294c4);}' +
      '.onb-row{display:flex;align-items:center;gap:8px;}' +
      '.onb-dots{display:flex;gap:5px;margin-right:auto;}' +
      '.onb-dot{width:6px;height:6px;border-radius:50%;background:var(--divider,#1a2647);}' +
      '.onb-dot.on{background:var(--accent,#5cf2ff);}' +
      '.onb-btn{appearance:none;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;' +
        'letter-spacing:.8px;padding:6px 12px;border-radius:5px;border:1px solid var(--panel-edge,#22305c);' +
        'background:var(--btn,#16203f);color:var(--text,#dce6ff);}' +
      '.onb-btn:hover{background:var(--btn-hover,#1d2c54);}' +
      '.onb-btn.primary{background:var(--accent,#5cf2ff);color:#04121a;border-color:transparent;}' +
      '.onb-skip{background:transparent;border-color:transparent;color:var(--text-faint,#4d5d8a);}';
    var style = document.createElement('style');
    style.id = 'onb-styles';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function mount() {
    if (els) return els;
    injectStyles();
    var root = document.getElementById('modal-root') || document.body;
    if (!root) return null;

    var wrap = document.createElement('div');
    wrap.className = 'onb-wrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Guided tour');

    var spot = document.createElement('div');
    spot.className = 'onb-spot';

    var pop = document.createElement('div');
    pop.className = 'onb-pop';

    var title = document.createElement('h3');
    title.className = 'onb-title';
    var body = document.createElement('p');
    body.className = 'onb-body';

    var rowEl = document.createElement('div');
    rowEl.className = 'onb-row';
    var dots = document.createElement('div');
    dots.className = 'onb-dots';
    var skip = document.createElement('button');
    skip.className = 'onb-btn onb-skip';
    skip.type = 'button';
    skip.textContent = t('tour.skip', 'Skip');
    var next = document.createElement('button');
    next.className = 'onb-btn primary';
    next.type = 'button';

    rowEl.appendChild(dots);
    rowEl.appendChild(skip);
    rowEl.appendChild(next);

    pop.appendChild(title);
    pop.appendChild(body);
    pop.appendChild(rowEl);

    wrap.appendChild(spot);
    wrap.appendChild(pop);
    root.appendChild(wrap);

    skip.addEventListener('click', function () { finish(); });
    next.addEventListener('click', function () { step(idx + 1); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
    });

    els = { wrap: wrap, spot: spot, pop: pop, title: title, body: body, dots: dots, next: next, skip: skip };
    return els;
  }

  function renderDots() {
    if (!els) return;
    els.dots.innerHTML = '';
    for (var i = 0; i < steps.length; i++) {
      var d = document.createElement('span');
      d.className = 'onb-dot' + (i === idx ? ' on' : '');
      els.dots.appendChild(d);
    }
  }

  function rect(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  function position(s) {
    if (!els || !s || !s.el) return;
    var r = rect(s.el);
    if (!r) return;
    var pad = 6;
    var x = Math.max(2, r.left - pad);
    var y = Math.max(2, r.top - pad);
    var w = r.width + pad * 2;
    var h = r.height + pad * 2;
    els.spot.style.left = x + 'px';
    els.spot.style.top = y + 'px';
    els.spot.style.width = w + 'px';
    els.spot.style.height = h + 'px';

    // place popover: below the target if room, else above; clamp horizontally.
    var vw = window.innerWidth || document.documentElement.clientWidth || 800;
    var vh = window.innerHeight || document.documentElement.clientHeight || 600;
    var popW = Math.min(300, vw * 0.84);
    var px = Math.min(Math.max(8, r.left), vw - popW - 8);
    var py;
    var below = r.bottom + 12;
    if (below + 150 < vh) py = below;
    else py = Math.max(8, r.top - 12 - 150);
    els.pop.style.left = px + 'px';
    els.pop.style.top = py + 'px';
  }

  function step(n) {
    if (!els) return;
    if (n >= steps.length) { finish(); return; }
    idx = Math.max(0, n);
    var s = steps[idx];
    els.title.textContent = s.title || '';
    els.body.textContent = s.body || '';
    els.next.textContent = (idx >= steps.length - 1)
      ? t('tour.done', 'Done')
      : t('tour.next', 'Next');
    renderDots();
    position(s);
  }

  function onResize() { if (open && steps[idx]) position(steps[idx]); }

  // ---- public start / finish ---------------------------------------------
  Onboarding.start = function () {
    try {
      if (open) return;
      if (!mount()) return;
      steps = buildSteps();
      if (!steps.length) { // nothing to point at — mark onboarded and bail.
        var st = settings(); if (st) { st.onboarded = true; persist(); }
        return;
      }
      els.wrap.style.display = 'block';
      open = true;
      window.addEventListener('resize', onResize);
      step(0);
      try { els.next.focus(); } catch (e) {}
    } catch (e) { /* never block */ }
  };

  function finish() {
    try {
      if (!open) return;
      open = false;
      if (els) els.wrap.style.display = 'none';
      window.removeEventListener('resize', onResize);
      var st = settings();
      if (st) { st.onboarded = true; persist(); }
    } catch (e) {}
  }
  Onboarding.finish = finish;
  Onboarding.isOpen = function () { return open; };

  // ---- self-install: first-run autostart ----------------------------------
  function maybeAutoStart() {
    try {
      var st = settings();
      if (st && !st.onboarded) {
        // small delay so the rest of the UI has laid out first. Re-check onboarded
        // at fire time — Store may hydrate the saved session after this scheduling
        // (main.js loads last), so a returning user must not get the tour again.
        setTimeout(function () { var s2 = settings(); if (s2 && s2.onboarded) return; Onboarding.start(); }, 900);
      }
    } catch (e) {}
  }

  function install() {
    if (installed) return;
    installed = true;
    maybeAutoStart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    // already loaded — but settings may not be hydrated yet; defer a tick.
    setTimeout(install, 0);
  }

  App.Onboarding = Onboarding;
})();
