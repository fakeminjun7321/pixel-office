window.App = window.App || {};
/* ===========================================================================
   palette.js -> App.Palette  [Wave B/C: Command palette]
   Self-installing Ctrl/Cmd+K command palette. Lists actions wired to the
   existing App API; each action is guarded via typeof so only available
   commands appear. Esc closes. Injects its own DOM + styles, reusing the
   existing modal look where practical. Never throws; no-ops if deps missing.
   =========================================================================== */
(function () {
  'use strict';

  var Palette = {};
  var els = null;          // { wrap, scrim, card, input, list }
  var actions = [];        // current full action list
  var filtered = [];       // filtered subset
  var activeIdx = 0;
  var open = false;
  var installed = false;

  function CFG()   { return App.config || {}; }
  function UI()    { return App.UI || null; }
  function ORCH()  { return App.Orchestrator || null; }
  function STATE() { return App.state || null; }

  // ---- small helpers ------------------------------------------------------
  function isFn(o, k) { return o && typeof o[k] === 'function'; }

  function safe(fn) {
    return function () {
      try { fn(); } catch (e) { /* never throw into UI */ }
    };
  }

  // ---- build the action set (only what's available) -----------------------
  function buildActions() {
    var out = [];
    var ui = UI();
    var orch = ORCH();

    function add(label, hint, run) { out.push({ label: label, hint: hint || '', run: safe(run) }); }

    // Dispatch goal -> focus the boss input
    add('Dispatch goal', 'Boss task', function () {
      var inp = document.getElementById('hud-task-input');
      if (inp) { inp.focus(); try { inp.select(); } catch (e) {} }
    });

    if (isFn(ui, 'openAddAgent'))      add('New Agent', 'Hire', function () { ui.openAddAgent(); });
    if (isFn(ui, 'openSettings'))      add('Settings', 'API keys, prefs', function () { ui.openSettings(); });

    if (isFn(ui, 'openTaskBoard'))     add('Tasks', 'Task board', function () { ui.openTaskBoard(); });
    else if (isFn(ui, 'openBoard'))    add('Tasks', 'Task board', function () { ui.openBoard(); });

    if (isFn(ui, 'openArtifacts'))     add('Artifacts', 'Outputs', function () { ui.openArtifacts(); });
    if (isFn(ui, 'openSessions'))      add('Sessions', 'Save / load', function () { ui.openSessions(); });
    if (isFn(ui, 'openPresets'))       add('New Company', 'Presets', function () { ui.openPresets(); });
    if (isFn(ui, 'openCostBreakdown')) add('Cost breakdown', 'Spend', function () { ui.openCostBreakdown(); });

    if (isFn(App.Graph, 'open'))       add('Workflow Flow', 'Graph', function () { App.Graph.open(); });

    if (isFn(ui, 'toggleLayoutEdit'))  add('Layout toggle', 'Edit layout', function () { ui.toggleLayoutEdit(); });

    if (isFn(orch, 'breakEveryone'))   add('Coffee break', 'Send idle crew to lounge', function () { orch.breakEveryone(); });

    // Pause / Resume — no public method; drive the existing status toggle.
    var st = STATE();
    if (st && typeof st.paused === 'boolean') {
      add(st.paused ? 'Resume' : 'Pause', 'Simulation', function () {
        var btn = document.getElementById('status-paused');
        if (btn && isFn(btn, 'click')) btn.click();
      });
    }

    if (isFn(ui, 'zoomIn'))    add('Zoom in', 'View', function () { ui.zoomIn(); });
    if (isFn(ui, 'zoomOut'))   add('Zoom out', 'View', function () { ui.zoomOut(); });
    if (isFn(ui, 'resetView')) add('Reset view', 'View', function () { ui.resetView(); });

    if (isFn(App.Onboarding, 'start')) add('Help / Tour', 'Guided tour', function () { App.Onboarding.start(); });

    return out;
  }

  // ---- fuzzy filter (subsequence match + simple scoring) ------------------
  function fuzzy(query, text) {
    if (!query) return 1;
    var q = query.toLowerCase(), t = text.toLowerCase();
    var qi = 0, score = 0, run = 0;
    for (var ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t.charAt(ti) === q.charAt(qi)) {
        qi++; run++; score += run;
        if (ti === 0) score += 5;       // start bonus
      } else { run = 0; }
    }
    return qi === q.length ? score + 1 : 0;
  }

  function applyFilter(query) {
    var scored = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var s = fuzzy(query, a.label + ' ' + a.hint);
      if (s > 0) scored.push({ a: a, s: s });
    }
    scored.sort(function (x, y) { return y.s - x.s; });
    filtered = scored.map(function (o) { return o.a; });
    activeIdx = 0;
    renderList();
  }

  function renderList() {
    if (!els) return;
    els.list.innerHTML = '';
    if (!filtered.length) {
      var empty = document.createElement('div');
      empty.className = 'cmdp-empty';
      empty.textContent = 'No matching commands';
      els.list.appendChild(empty);
      return;
    }
    for (var i = 0; i < filtered.length; i++) {
      (function (idx) {
        var a = filtered[idx];
        var row = document.createElement('div');
        row.className = 'cmdp-item' + (idx === activeIdx ? ' cmdp-active' : '');
        row.setAttribute('role', 'option');
        var lbl = document.createElement('span');
        lbl.className = 'cmdp-lbl';
        lbl.textContent = a.label;
        row.appendChild(lbl);
        if (a.hint) {
          var h = document.createElement('span');
          h.className = 'cmdp-hint';
          h.textContent = a.hint;
          row.appendChild(h);
        }
        row.addEventListener('mousemove', function () {
          if (activeIdx !== idx) { activeIdx = idx; updateActive(); }
        });
        row.addEventListener('click', function () { choose(idx); });
        els.list.appendChild(row);
      })(i);
    }
  }

  function updateActive() {
    if (!els) return;
    var rows = els.list.querySelectorAll('.cmdp-item');
    for (var i = 0; i < rows.length; i++) {
      if (i === activeIdx) {
        rows[i].classList.add('cmdp-active');
        try { rows[i].scrollIntoView({ block: 'nearest' }); } catch (e) {}
      } else {
        rows[i].classList.remove('cmdp-active');
      }
    }
  }

  function choose(idx) {
    var a = filtered[idx];
    closePalette();
    if (a && typeof a.run === 'function') a.run();
  }

  // ---- DOM + styles -------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('cmdp-styles')) return;
    var css = '' +
      '.cmdp-wrap{position:absolute;inset:0;z-index:120;display:flex;align-items:flex-start;justify-content:center;padding:12vh 20px 20px;}' +
      '.cmdp-scrim{position:absolute;inset:0;background:var(--scrim,rgba(5,7,15,.72));backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}' +
      '.cmdp-card{position:relative;width:min(560px,94vw);max-height:64vh;display:flex;flex-direction:column;' +
        'background:var(--panel,#0b1024);border:1px solid var(--panel-edge,#22305c);border-radius:10px;' +
        'box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden;}' +
      '.cmdp-input{appearance:none;border:0;outline:0;width:100%;box-sizing:border-box;' +
        'padding:14px 16px;font-size:15px;font-family:inherit;letter-spacing:.5px;' +
        'background:var(--field,#0a0f20);color:var(--text,#dce6ff);border-bottom:1px solid var(--divider,#1a2647);}' +
      '.cmdp-input::placeholder{color:var(--text-faint,#4d5d8a);}' +
      '.cmdp-list{overflow-y:auto;padding:6px;flex:1 1 auto;}' +
      '.cmdp-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:6px;cursor:pointer;' +
        'color:var(--text,#dce6ff);}' +
      '.cmdp-item.cmdp-active{background:var(--btn-hover,#1d2c54);}' +
      '.cmdp-lbl{font-size:13px;font-weight:700;letter-spacing:.6px;}' +
      '.cmdp-hint{margin-left:auto;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--text-faint,#4d5d8a);}' +
      '.cmdp-empty{padding:18px;text-align:center;color:var(--text-faint,#4d5d8a);font-size:12px;letter-spacing:1px;}' +
      '.cmdp-foot{padding:7px 12px;border-top:1px solid var(--divider,#1a2647);font-size:10px;letter-spacing:1px;' +
        'color:var(--text-faint,#4d5d8a);display:flex;gap:14px;}';
    var style = document.createElement('style');
    style.id = 'cmdp-styles';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function mount() {
    if (els) return els;
    injectStyles();
    var root = document.getElementById('modal-root') || document.body;
    if (!root) return null;

    var wrap = document.createElement('div');
    wrap.className = 'cmdp-wrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Command palette');

    var scrim = document.createElement('div');
    scrim.className = 'cmdp-scrim';
    scrim.addEventListener('click', closePalette);

    var card = document.createElement('div');
    card.className = 'cmdp-card';

    var input = document.createElement('input');
    input.className = 'cmdp-input';
    input.type = 'text';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.placeholder = 'Type a command...';

    var list = document.createElement('div');
    list.className = 'cmdp-list';
    list.setAttribute('role', 'listbox');

    var foot = document.createElement('div');
    foot.className = 'cmdp-foot';
    var f1 = document.createElement('span'); f1.textContent = 'Enter run';
    var f2 = document.createElement('span'); f2.textContent = 'Esc close';
    foot.appendChild(f1); foot.appendChild(f2);

    card.appendChild(input);
    card.appendChild(list);
    card.appendChild(foot);
    wrap.appendChild(scrim);
    wrap.appendChild(card);
    root.appendChild(wrap);

    input.addEventListener('input', function () { applyFilter(input.value); });
    input.addEventListener('keydown', onInputKey);

    els = { wrap: wrap, scrim: scrim, card: card, input: input, list: list };
    return els;
  }

  function onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length) { activeIdx = (activeIdx + 1) % filtered.length; updateActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length) { activeIdx = (activeIdx - 1 + filtered.length) % filtered.length; updateActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length) choose(activeIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  }

  // ---- open / close -------------------------------------------------------
  Palette.open = function () {
    try {
      if (open) return;
      if (!mount()) return;
      actions = buildActions();
      els.wrap.style.display = 'flex';
      els.input.value = '';
      applyFilter('');
      open = true;
      // focus after paint so iOS/Safari accepts it
      setTimeout(function () { try { els.input.focus(); } catch (e) {} }, 0);
    } catch (e) { /* swallow */ }
  };

  function closePalette() {
    try {
      if (!open || !els) return;
      els.wrap.style.display = 'none';
      open = false;
    } catch (e) {}
  }
  Palette.close = closePalette;
  Palette.toggle = function () { if (open) closePalette(); else Palette.open(); };
  Palette.isOpen = function () { return open; };

  // ---- self-install global hotkey ----------------------------------------
  function onKeyDown(e) {
    try {
      var k = (e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && k === 'k') {
        e.preventDefault();
        Palette.toggle();
      }
    } catch (err) {}
  }

  function install() {
    if (installed) return;
    installed = true;
    try { document.addEventListener('keydown', onKeyDown, true); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  App.Palette = Palette;
})();
