// =============================================================================
// ui.js  →  App.UI
// PIXEL AI COMPANY ("NEON//WORKS") — DOM overlays, modals, input, camera controls.
//
// Authority: SPEC.md §8 (DOM contract / exact ids), §7.7 (signatures), §4.1
//            (zoom-toward-cursor math), §10 (errors), §7.10 (compat aliases).
//
// Rules: UI never does network or pathfinding; all canvas math via App.World.
//   Every DOM node access is guarded (missing node → no-op, never throw).
//   Visibility toggled ONLY by adding/removing `.hidden`.
//   Selects populated from config.MODELS; role select from config.ROLES.
// Classic <script>; no import/export. Attaches to window.App.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  function CFG()    { return App.config || {}; }
  function STATE()  { return App.state; }
  // i18n helper — returns translated string when App.I18n is present, else fallback.
  function T(key, fallback, vars) {
    try {
      if (App.I18n && typeof App.I18n.t === 'function') {
        var v = App.I18n.t(key, vars);
        // App.I18n.t falls back to the key itself when missing; prefer our literal then.
        if (v != null && v !== key) return v;
      }
    } catch (e) {}
    return (fallback != null) ? fallback : key;
  }
  // Re-apply i18n to a (sub)tree if the module is available. Safe no-op otherwise.
  function applyI18n(root) {
    try { if (App.I18n && typeof App.I18n.apply === 'function') App.I18n.apply(root || document); } catch (e) {}
  }
  function WORLD()  { return App.World; }
  function ROLES()  { return (App.config && App.config.ROLES) || {}; }
  function AGENTS() { return App.Agents; }
  function ORCH()   { return App.Orchestrator; }

  function truncate(s, n) {
    if (App.util && App.util.truncate) return App.util.truncate(s, n);
    s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function clamp(v, lo, hi) {
    if (App.util && App.util.clamp) return App.util.clamp(v, lo, hi);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // -- DOM helpers (defensive) --------------------------------------------------
  function $(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
  function on(node, ev, fn) { if (node && node.addEventListener) node.addEventListener(ev, fn); }
  function show(node) { if (node) node.classList.remove('hidden'); }
  function hide(node) { if (node) node.classList.add('hidden'); }
  function setText(node, t) { if (node) node.textContent = (t == null ? '' : String(t)); }
  function clear(node) { if (node) { while (node.firstChild) node.removeChild(node.firstChild); } }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = String(txt);
    return n;
  }

  var UI = {};

  // Add-agent modal working selection (model/color chosen via segmented controls).
  var _aaSel = { model: null, color: null };
  var _aaPreviewRAF = 0;
  var _panelPreviewRAF = 0;
  // Layout-edit working state.
  var _layoutTool = null;      // currently selected furniture key to place
  var _dragFurniture = null;   // furniture being moved
  // Pan state.
  var _pan = { active: false, lastX: 0, lastY: 0, movedEnough: false, downX: 0, downY: 0 };

  // ===========================================================================
  // init() — bind everything by SPEC §8 ids, populate selects, refresh.
  // ===========================================================================
  UI.init = function () {
    try {
      populateModelSelect($('set-default-model'));
      populateModelSelect($('set-boss-model'));

      // HUD buttons
      on($('btn-task'), 'click', function () { UI.openTaskBoard(); });
      on($('btn-build'), 'click', function () { dispatchBuild(); });
      on($('btn-files'), 'click', function () { UI.openFiles(); });
      on($('btn-run'), 'click', function () { UI.runPreview(); });
      on($('btn-add-agent'), 'click', function () { UI.openAddAgent(); });
      on($('btn-settings'), 'click', function () { UI.openSettings(); });
      on($('btn-artifacts'), 'click', function () { UI.openArtifacts(); });
      on($('btn-presets'), 'click', function () { UI.openPresets(); });
      on($('btn-sessions'), 'click', function () { UI.openSessions(); });
      on($('btn-cost-meter'), 'click', function () { UI.openCostBreakdown(); });
      on($('btn-layout'), 'click', function () { UI.toggleLayoutEdit(); });
      on($('btn-zoom-in'), 'click', function () { UI.zoomIn(); });
      on($('btn-zoom-out'), 'click', function () { UI.zoomOut(); });
      on($('btn-reset-view'), 'click', function () { UI.resetView(); });
      on($('status-paused'), 'click', function () { togglePause(); });

      // HUD center "give the Boss a goal"
      var hudInput = $('hud-task-input');
      on($('hud-task-dispatch'), 'click', function () { dispatchBoss(hudInput); });
      on(hudInput, 'keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatchBoss(hudInput); }
      });

      // Board
      on($('board-close'), 'click', function () { hide($('board')); });
      var boardInput = $('board-input');
      on($('board-send'), 'click', function () { dispatchBoss(boardInput); });
      on(boardInput, 'keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatchBoss(boardInput); }
      });

      // Agent panel
      on($('panel-agent-close'), 'click', function () { UI.closeAgentPanel(); });
      var panelInput = $('panel-agent-input');
      on($('panel-agent-send'), 'click', function () { sendDirectChat(panelInput); });
      on(panelInput, 'keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDirectChat(panelInput); }
      });

      // Add-agent modal
      on($('aa-cancel'), 'click', function () { hide($('modal-add-agent')); stopAAPreview(); });
      on($('aa-submit'), 'click', function () { submitAddAgent(); });
      on($('aa-role'), 'change', function () { onAARoleChange(); });
      bindScrimClose('modal-add-agent', function () { stopAAPreview(); });
      bindScrimClose('modal-settings');

      // Settings modal
      on($('set-close'), 'click', function () { hide($('modal-settings')); });
      on($('set-save'), 'click', function () { saveSettings(); });
      on($('set-apikey-toggle'), 'click', function () { toggleApiKeyVisible(); });
      on($('set-gh-token-toggle'), 'click', function () { toggleGhTokenVisible(); });
      on($('set-websearch'), 'click', function () { toggleWebSearchSwitch(); });
      on($('set-export'), 'click', function () { exportData(); });
      on($('set-import'), 'click', function () { var f = $('set-import-file'); if (f) f.click(); });
      on($('set-import-file'), 'change', function (e) { importData(e); });
      on($('set-clear'), 'click', function () { clearData(); });

      // Layout palette
      bindLayoutPalette();
      on($('layout-done'), 'click', function () { if (STATE() && STATE().layoutEdit) UI.toggleLayoutEdit(); });

      // Canvas pointer + wheel
      var canvas = $('world-canvas');
      on(canvas, 'pointerdown', UI.onCanvasPointerDown);
      on(canvas, 'pointermove', UI.onCanvasPointerMove);
      on(canvas, 'pointerup', UI.onCanvasPointerUp);
      on(canvas, 'pointercancel', UI.onCanvasPointerUp);
      on(canvas, 'wheel', UI.onWheel);

      // Minimap: pointerdown centers the camera on the clicked world point.
      var minimap = $('minimap');
      on(minimap, 'pointerdown', UI.onMinimapPointerDown);

      // Double-click empty floor clears follow-camera.
      var canvasDbl = $('world-canvas');
      on(canvasDbl, 'dblclick', function () { STATE() && (STATE()._followId = null); });

      // Global "Coffee break" control (sends all idle non-boss agents on break).
      ensureCoffeeBreakButton();

      // Mobile/responsive: wire the rail drawer toggles (shown <=820px via CSS).
      on($('btn-rail-crew'), 'click', function () { toggleRailDrawer('agent-list', 'btn-rail-crew'); });
      on($('btn-rail-log'),  'click', function () { toggleRailDrawer('log', 'btn-rail-log'); });

      // Logo glyph in the HUD.
      drawLogo();

      // i18n: translate the static shell now that DOM + config are ready.
      applyI18n(document);

      // (m5) Sync the web-search neon switch with persisted settings on first load,
      // so its .on/aria-checked state matches App.state before Settings is opened.
      setWebSearchSwitch(!!(App.state && App.state.settings && App.state.settings.webSearch));

      UI.refreshArtifacts();
      UI.refreshFiles();
      UI.refresh();
    } catch (e) {
      try { console && console.warn && console.warn('[UI.init]', e); } catch (e2) {}
    }
  };

  function bindScrimClose(modalId, after) {
    var modal = $(modalId);
    if (!modal) return;
    var scrim = modal.querySelector('.modal-scrim');
    on(scrim, 'click', function () { hide(modal); if (typeof after === 'function') after(); });
  }

  // ===========================================================================
  // MOBILE / RESPONSIVE — rail drawers
  // On narrow screens the CREW + ACTIVITY rails collapse off-canvas; the two
  // HUD toggle buttons slide them in as overlay drawers. The `.rail-open` class
  // (styled in styles.css) does the showing; here we just flip it + aria + the
  // shared scrim. Only one drawer is open at a time.
  // ===========================================================================
  function ensureRailScrim() {
    var sc = $('rail-scrim');
    if (sc) return sc;
    var app = $('app');
    if (!app) return null;
    sc = el('div', 'rail-scrim');
    sc.id = 'rail-scrim';
    on(sc, 'click', closeRailDrawers);
    app.appendChild(sc);
    return sc;
  }
  function closeRailDrawers() {
    ['agent-list', 'log'].forEach(function (id) { var n = $(id); if (n) n.classList.remove('rail-open'); });
    ['btn-rail-crew', 'btn-rail-log'].forEach(function (id) {
      var b = $(id); if (b) b.setAttribute('aria-pressed', 'false');
    });
    var sc = $('rail-scrim'); if (sc) sc.classList.remove('rail-scrim-on');
  }
  function toggleRailDrawer(railId, btnId) {
    var rail = $(railId);
    if (!rail) return;
    var isOpen = rail.classList.contains('rail-open');
    closeRailDrawers();
    if (!isOpen) {
      rail.classList.add('rail-open');
      var b = $(btnId); if (b) b.setAttribute('aria-pressed', 'true');
      var sc = ensureRailScrim(); if (sc) sc.classList.add('rail-scrim-on');
    }
  }
  // Expose so other flows (e.g. opening a panel on mobile) can dismiss drawers.
  UI.closeRailDrawers = closeRailDrawers;

  // ===========================================================================
  // SELECT / SEGMENTED POPULATION
  // ===========================================================================
  // Human-readable provider tag for a model (config.MODELS now carries .provider).
  // Falls back to util/config.providerOf when an entry lacks the field.
  function providerOf(model) {
    if (model && model.provider) return model.provider;
    var id = (model && model.id) || model;
    if (App.util && App.util.providerOf) return App.util.providerOf(id);
    if (CFG().providerOf) return CFG().providerOf(id);
    return /^(gpt|o1|o3|o4|chatgpt)/i.test(String(id || '')) ? 'openai' : 'anthropic';
  }
  function providerLabel(prov) {
    return prov === 'openai' ? 'OpenAI' : 'Claude';
  }

  function populateModelSelect(sel) {
    if (!sel) return;
    clear(sel);
    var models = CFG().MODELS || [];
    for (var i = 0; i < models.length; i++) {
      var o = document.createElement('option');
      o.value = models[i].id;
      // Prefix the option with its provider so Claude/OpenAI are distinguishable.
      o.textContent = '[' + providerLabel(providerOf(models[i])) + '] ' + (models[i].label || models[i].id);
      sel.appendChild(o);
    }
  }

  function populateRoleSelect(sel) {
    if (!sel) return;
    clear(sel);
    var roles = ROLES();
    // Show all roles except 'generalist' (fallback, not in picker by default §6.2) and 'boss'.
    var order = ['engineer', 'designer', 'researcher', 'writer', 'qa'];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      if (!roles[key]) continue;
      var o = document.createElement('option');
      o.value = key;
      o.textContent = roles[key].label || key;
      sel.appendChild(o);
    }
    // also allow boss & generalist as explicit options at the end
    ['boss', 'generalist'].forEach(function (key) {
      if (!roles[key]) return;
      var o = document.createElement('option');
      o.value = key;
      o.textContent = roles[key].label || key;
      sel.appendChild(o);
    });
  }

  // map a model id to the segmented picker's neon accent
  // (opus=cyan, sonnet=blue, haiku=lime; OpenAI models=magenta)
  function segAccent(modelId) {
    var m = String(modelId || '');
    if (providerOf(m) === 'openai') return 'magenta';
    if (m.indexOf('sonnet') !== -1) return 'blue';
    if (m.indexOf('haiku') !== -1) return 'lime';
    return 'cyan';
  }

  function buildSegmentedModels(container) {
    if (!container) return;
    clear(container);
    var models = CFG().MODELS || [];
    for (var i = 0; i < models.length; i++) {
      (function (m) {
        var b = el('button', 'seg');
        b.type = 'button';
        var prov = providerOf(m);
        var short = (m.label || m.id).replace(/\s*\(.*\)$/, ''); // short label
        b.textContent = short;
        // small provider tag (reuses styled .seg-sub) so Claude vs OpenAI read at a glance
        var tag = el('span', 'seg-sub', providerLabel(prov));
        b.appendChild(tag);
        b.title = providerLabel(prov) + ' · ' + (m.label || m.id);
        b.setAttribute('role', 'radio');
        b.setAttribute('data-model', m.id);
        b.setAttribute('data-provider', prov);
        b.setAttribute('data-accent', segAccent(m.id));
        on(b, 'click', function () {
          _aaSel.model = m.id;
          highlightSegmented(container, 'data-model', m.id);
        });
        container.appendChild(b);
      })(models[i]);
    }
  }

  function buildSwatchRow(container) {
    if (!container) return;
    clear(container);
    var rc = CFG().roleColor || {};
    var pal = (CFG().palette) || {};
    // signature neons
    var colors = [pal.cyan, pal.magenta, pal.purple, pal.blue, pal.lime, pal.amber, pal.red]
      .filter(function (c) { return !!c; });
    for (var i = 0; i < colors.length; i++) {
      (function (col) {
        var sw = el('button', 'swatch');
        sw.type = 'button';
        sw.style.background = col;
        sw.style.boxShadow = '0 0 8px ' + col;
        sw.setAttribute('data-color', col);
        on(sw, 'click', function () {
          _aaSel.color = col;
          highlightSegmented(container, 'data-color', col);
          schedAAPreview();
        });
        container.appendChild(sw);
      })(colors[i]);
    }
  }

  function highlightSegmented(container, attr, val) {
    if (!container) return;
    var items = container.children;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.getAttribute(attr) === val) it.classList.add('active');
      else it.classList.remove('active');
    }
  }

  // ===========================================================================
  // REFRESH helpers
  // ===========================================================================
  UI.refresh = function () {
    UI.refreshAgentList();
    UI.refreshBoard();
    UI.refreshLog();
    refreshSelectedPanel();
    refreshHud();
  };

  function refreshHud() {
    var s = STATE();
    var pauseBtn = $('status-paused');
    if (pauseBtn && s) {
      pauseBtn.setAttribute('aria-pressed', s.paused ? 'true' : 'false');
      pauseBtn.textContent = s.paused ? '▶' : '⏸';
    }
    var layoutBtn = $('btn-layout');
    if (layoutBtn && s) layoutBtn.setAttribute('aria-pressed', s.layoutEdit ? 'true' : 'false');
  }

  UI.refreshAgentList = function () {
    var s = STATE();
    var body = $('agent-list-body');
    if (!body || !s) return;
    clear(body);
    var agents = s.agents || [];
    setText($('agent-count'), agents.length);

    for (var i = 0; i < agents.length; i++) {
      (function (a) {
        var row = el('div', 'agent-row');
        if (s.selectedAgentId === a.id) row.classList.add('selected');
        row.style.setProperty('--accent', a.color || '#9b5cff');

        var dot = el('span', 'ar-dot');
        var sc = (CFG().stateColor) || {};
        dot.style.background = sc[a.state] || (CFG().palette ? CFG().palette.uiTextDim : '#8294c4');

        var nameWrap = el('div', 'ar-main');
        var nm = el('span', 'ar-name', a.name);
        nm.style.color = a.color || undefined;
        var role = el('span', 'ar-role',
          ((ROLES()[a.role] && ROLES()[a.role].label) || a.role) + (a.temp ? ' · temp' : ''));
        var stateLbl = el('span', 'ar-state st-' + (a.state || 'idle'), a.state);
        nameWrap.appendChild(nm);
        nameWrap.appendChild(role);
        nameWrap.appendChild(stateLbl);

        row.appendChild(dot);
        row.appendChild(nameWrap);
        on(row, 'click', function () { UI.openAgentPanel(a.id); });
        body.appendChild(row);
      })(agents[i]);
    }
    if (typeof refreshCostMeter === 'function') refreshCostMeter();
  };

  UI.refreshLog = function () {
    var s = STATE();
    var body = $('log-body');
    if (!body || !s) return;
    clear(body);
    var lines = s.log || [];
    var start = Math.max(0, lines.length - 120); // render the tail
    for (var i = start; i < lines.length; i++) {
      var e = lines[i];
      if (!e) continue;
      var line = el('div', 'log-line k-' + (e.kind || 'system'));
      var from = el('span', 'log-from', e.from || 'system');
      var arrow = el('span', 'log-arrow', '›');
      var txt = document.createTextNode(' ' + (e.text || ''));
      line.appendChild(from);
      line.appendChild(arrow);
      line.appendChild(txt);
      body.appendChild(line);
    }
    body.scrollTop = body.scrollHeight; // auto-scroll
  };

  UI.refreshBoard = function () {
    var s = STATE();
    if (!s) return;
    var colQ = $('board-col-queued');
    var colR = $('board-col-running');
    var colD = $('board-col-done');
    if (!colQ && !colR && !colD) return;
    clear(colQ); clear(colR); clear(colD);

    var counts = { queued: 0, running: 0, done: 0 };
    var tasks = s.tasks || [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t) continue;
      if (t.role === 'boss' && !t.parentId) {
        // root boss task: show in running until done/error, then in done col.
        if (t.status === 'running') { appendCard(colR, t, 'running'); counts.running++; }
        else if (t.status === 'done' || t.status === 'error') { appendCard(colD, t, 'done'); counts.done++; }
        else { appendCard(colQ, t, 'queued'); counts.queued++; }
        continue;
      }
      if (t.status === 'queued' || t.status === 'blocked') { appendCard(colQ, t, 'queued'); counts.queued++; }
      else if (t.status === 'running') { appendCard(colR, t, 'running'); counts.running++; }
      else { appendCard(colD, t, 'done'); counts.done++; } // done + error
    }
    setColCount('queued', counts.queued);
    setColCount('running', counts.running);
    setColCount('done', counts.done);
    if (typeof refreshCostMeter === 'function') refreshCostMeter();
  };

  function setColCount(col, n) {
    var nodes = document.querySelectorAll ? document.querySelectorAll('.col-count[data-col="' + col + '"]') : [];
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = n;
  }

  function appendCard(col, task, group) {
    if (!col) return;
    var card = el('div', 'task-card status-' + task.status);
    var roleColor = (ROLES()[task.role] && ROLES()[task.role].color) || '#9b5cff';
    card.style.setProperty('--accent', roleColor);
    card.style.borderLeftColor = roleColor;

    var title = el('div', 'tc-title', task.title || '(untitled)');
    card.appendChild(title);

    var head = el('div', 'tc-row');
    var roleTag = el('span', 'tc-role', (ROLES()[task.role] && ROLES()[task.role].label) || task.role);
    roleTag.style.color = roleColor;
    var statusTag = el('span', 'tc-assignee', task.status);
    head.appendChild(roleTag);
    head.appendChild(statusTag);
    card.appendChild(head);

    // assignee
    if (task.assignee) {
      var a = AGENTS() && AGENTS().byId ? AGENTS().byId(task.assignee) : null;
      if (a) {
        var who = el('div', 'tc-assignee', '▸ ' + a.name);
        who.style.color = a.color || undefined;
        card.appendChild(who);
      }
    }

    // result / error preview
    if (task.status === 'done' && task.result) {
      var rp = el('div', 'tc-assignee', truncate(stripMd(task.result), 140));
      card.appendChild(rp);
      if (!task.parentId) {
        var view = el('button', 'tc-retry', 'View result');
        view.type = 'button';
        on(view, 'click', function () { UI.showFinalResult(task); });
        card.appendChild(view);
      }
    } else if (task.status === 'error') {
      var ep = el('div', 'tc-assignee', '⚠ ' + truncate(task.error || 'error', 120));
      card.appendChild(ep);
      // Retry for parentless or any errored task.
      var retry = el('button', 'tc-retry', 'Retry');
      retry.type = 'button';
      on(retry, 'click', function () { retryTask(task); });
      card.appendChild(retry);
    }

    // cancel for running
    if (task.status === 'running' && task.parentId) {
      var cancel = el('button', 'tc-retry', 'Cancel');
      cancel.type = 'button';
      on(cancel, 'click', function () { if (ORCH() && ORCH().cancelTask) ORCH().cancelTask(task.id); });
      card.appendChild(cancel);
    }

    col.appendChild(card);
  }

  function stripMd(s) {
    return String(s || '').replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim();
  }

  function retryTask(task) {
    if (!task) return;
    if (!task.parentId) {
      // re-dispatch the root goal fresh
      if (ORCH() && ORCH().runBossTask) ORCH().runBossTask(task.desc || task.title);
      return;
    }
    task.status = 'queued';
    task.assignee = null;
    task.error = null;
    UI.refreshBoard();
    if (App.Store && App.Store.save) App.Store.save();
  }

  // ===========================================================================
  // DISPATCH / CHAT input handlers
  // ===========================================================================
  function dispatchBoss(input) {
    if (!input) return;
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    requestNotifyPermission(); // polite, one-time, on this user gesture
    if (ORCH() && ORCH().runBossTask) {
      ORCH().runBossTask(text);
      UI.openTaskBoard(); // surface the board so the user sees the decomposition
    }
  }

  // dispatchBuild() — kick off the PROJECT BUILDER pipeline (v5). Reads the same
  // goal text the user typed for DISPATCH (HUD center, then board input), runs
  // App.Orchestrator.runBuild, surfaces the board + files panel so the user
  // watches files appear. DISPATCH stays Q&A; this is the file-oriented mode.
  function dispatchBuild() {
    var hud = $('hud-task-input');
    var board = $('board-input');
    var text = '';
    if (hud && hud.value && hud.value.trim()) text = hud.value.trim();
    else if (board && board.value && board.value.trim()) text = board.value.trim();
    if (!text) {
      if (hud && hud.focus) { try { hud.focus(); } catch (e) {} }
      UI.toast(T('build.needGoal', 'Type a project goal first (e.g. "build a todo web app")'));
      return;
    }
    if (hud) hud.value = '';
    if (board) board.value = '';
    requestNotifyPermission();
    if (ORCH() && ORCH().runBuild) {
      try { ORCH().runBuild(text); } catch (e) { UI.showError('Build failed to start: ' + (e && e.message)); return; }
      UI.openTaskBoard();
    } else {
      UI.showError(T('build.unavailable', 'Build mode is unavailable.'));
    }
  }

  function sendDirectChat(input) {
    if (!input) return;
    var s = STATE();
    if (!s || !s.selectedAgentId) return;
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(s.selectedAgentId) : null;
    if (a && AGENTS().chat) AGENTS().chat(a, text);
  }

  // ===========================================================================
  // AGENT PANEL
  // ===========================================================================
  UI.openAgentPanel = function (agentId) {
    var s = STATE();
    if (!s) return;
    s.selectedAgentId = agentId;
    s._followId = agentId; // follow-camera tracks the selected agent
    var panel = $('panel-agent');
    show(panel);
    ensureBreakButton();
    ensurePanelExtras();          // mood + customize + terminal/log sections (once)
    refreshSelectedPanel();
    refreshPersonaPanel(agentId);
    renderTranscript(agentId);
    refreshPanelExtras(agentId);  // populate mood/customize/terminal for this agent
    startPanelPreview();
    UI.refreshAgentList();        // highlight selected row
    // On mobile, opening an agent panel should dismiss any open rail drawer.
    if (typeof closeRailDrawers === 'function') closeRailDrawers();
  };

  // -------------------------------------------------------------------------
  // AGENT PANEL EXTRAS (Wave B/C): MOOD readout, CUSTOMIZE editor, TERMINAL log.
  // Injected once into #panel-agent (after the persona box, before transcript).
  // Reuses .persona-box / .field / .swatch styling for visual consistency.
  // -------------------------------------------------------------------------
  function ensurePanelExtras() {
    if ($('panel-agent-extras')) return;
    var personaBox = $('panel-agent-persona');
    var transcript = $('panel-agent-transcript');
    var panel = $('panel-agent');
    if (!panel) return;

    var wrap = el('div', 'panel-extras');
    wrap.id = 'panel-agent-extras';

    // --- MOOD + RELATIONSHIPS (read-only) ---
    var moodBox = el('details', 'persona-box');
    moodBox.id = 'panel-agent-mood';
    var moodSum = el('summary', 'persona-summary');
    moodSum.setAttribute('data-i18n', 'agent.mood');
    moodSum.textContent = T('agent.mood', 'MOOD & RELATIONSHIPS');
    moodBox.appendChild(moodSum);
    var moodBody = el('div', 'persona-body');
    moodBody.id = 'panel-agent-mood-body';
    moodBox.appendChild(moodBody);
    wrap.appendChild(moodBox);

    // --- CUSTOMIZE (sprite hair/skin/accent) ---
    var custBox = el('details', 'persona-box');
    custBox.id = 'panel-agent-customize';
    var custSum = el('summary', 'persona-summary');
    custSum.setAttribute('data-i18n', 'agent.customize');
    custSum.textContent = T('agent.customize', 'CUSTOMIZE');
    custBox.appendChild(custSum);
    var custBody = el('div', 'persona-body');
    custBody.id = 'panel-agent-customize-body';
    custBox.appendChild(custBody);
    wrap.appendChild(custBox);

    // --- TERMINAL / LOG (recent activity transcript) ---
    var termBox = el('details', 'persona-box');
    termBox.id = 'panel-agent-terminal';
    var termSum = el('summary', 'persona-summary');
    termSum.setAttribute('data-i18n', 'agent.terminal');
    termSum.textContent = T('agent.terminal', 'TERMINAL / LOG');
    termBox.appendChild(termSum);
    var termBody = el('div', 'persona-body pe-terminal');
    termBody.id = 'panel-agent-terminal-body';
    termBox.appendChild(termBody);
    wrap.appendChild(termBox);

    // Insert after the persona box (or before transcript as a fallback).
    if (personaBox && personaBox.parentNode) {
      if (personaBox.nextSibling) personaBox.parentNode.insertBefore(wrap, personaBox.nextSibling);
      else personaBox.parentNode.appendChild(wrap);
    } else if (transcript && transcript.parentNode) {
      transcript.parentNode.insertBefore(wrap, transcript);
    } else {
      panel.appendChild(wrap);
    }
  }

  function refreshPanelExtras(agentId) {
    refreshMoodPanel(agentId);
    refreshCustomizePanel(agentId);
    refreshTerminalPanel(agentId);
  }

  // Map a 0..1 mood to a label + accent color.
  function moodLabel(m) {
    m = Number(m); if (isNaN(m)) m = 0.7;
    if (m >= 0.8) return { t: T('mood.great', 'Great'), c: 'var(--lime)' };
    if (m >= 0.6) return { t: T('mood.good', 'Good'), c: 'var(--cyan)' };
    if (m >= 0.4) return { t: T('mood.ok', 'OK'), c: 'var(--amber)' };
    if (m >= 0.2) return { t: T('mood.low', 'Low'), c: 'var(--amber)' };
    return { t: T('mood.down', 'Down'), c: 'var(--red)' };
  }

  function refreshMoodPanel(agentId) {
    var body = $('panel-agent-mood-body');
    if (!body) return;
    clear(body);
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(agentId) : null;
    if (!a) return;

    var mood = (typeof a.mood === 'number') ? a.mood : (CFG().MOOD_DEFAULT != null ? CFG().MOOD_DEFAULT : 0.7);
    var ml = moodLabel(mood);
    var moodField = el('div', 'pe-field');
    moodField.appendChild(el('div', 'pe-key', T('panel.mood', 'Mood')));
    var bar = el('div', 'mood-bar');
    var fill = el('div', 'mood-fill');
    fill.style.width = Math.round(clamp(mood, 0, 1) * 100) + '%';
    fill.style.background = ml.c;
    fill.style.boxShadow = '0 0 8px ' + ml.c;
    bar.appendChild(fill);
    moodField.appendChild(bar);
    var moodTxt = el('div', 'mood-label', ml.t + ' · ' + Math.round(mood * 100) + '%');
    moodTxt.style.color = ml.c;
    moodField.appendChild(moodTxt);
    body.appendChild(moodField);

    // Top relationships (highest affinity first).
    var relField = el('div', 'pe-field');
    relField.appendChild(el('div', 'pe-key', T('panel.topRelationships', 'Top relationships')));
    var rel = (a.relationships && typeof a.relationships === 'object') ? a.relationships : {};
    var rows = [];
    for (var oid in rel) {
      if (!Object.prototype.hasOwnProperty.call(rel, oid)) continue;
      var other = AGENTS() && AGENTS().byId ? AGENTS().byId(oid) : null;
      if (!other) continue;
      rows.push({ name: other.name, color: other.color, aff: Number(rel[oid]) || 0 });
    }
    rows.sort(function (x, y) { return y.aff - x.aff; });
    rows = rows.slice(0, 4);
    if (!rows.length) {
      relField.appendChild(el('div', 'pe-empty', T('panel.noRelationships', 'No relationships yet.')));
    } else {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var line = el('div', 'rel-line');
        var dot = el('span', 'rel-dot');
        dot.style.background = r.color || 'var(--purple)';
        dot.style.boxShadow = '0 0 6px ' + (r.color || 'var(--purple)');
        line.appendChild(dot);
        line.appendChild(el('span', 'rel-name', r.name));
        var pct = el('span', 'rel-aff', Math.round(clamp(r.aff, 0, 1) * 100) + '%');
        line.appendChild(pct);
        relField.appendChild(line);
      }
    }
    body.appendChild(relField);
  }

  // Sprite customization editor: hair / skin / accent swatches -> agent.sprite.
  // Reads palette options from App.PixelArt (if exposed) or sensible defaults.
  function spriteOptions() {
    var pal = (CFG().palette) || {};
    // Skin/hair palettes mirror pixelart.js defaults; accent reuses the neon swatch set.
    return {
      skin: ['#e8b48c', '#c98a63', '#f2c7a8', '#a86c4a'],
      hair: ['#1a1d2e', '#3a2f4f', '#5a4a35', '#7a3b2b', '#cdd3e6'],
      accent: [pal.cyan, pal.magenta, pal.purple, pal.blue, pal.lime, pal.amber, pal.red]
        .filter(function (c) { return !!c; })
    };
  }

  function refreshCustomizePanel(agentId) {
    var body = $('panel-agent-customize-body');
    if (!body) return;
    clear(body);
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(agentId) : null;
    if (!a) return;
    a.sprite = (a.sprite && typeof a.sprite === 'object') ? a.sprite : {};
    var opts = spriteOptions();

    var rowFor = function (label, key, colors, applyDefaultFrom) {
      var f = el('div', 'pe-field');
      f.appendChild(el('div', 'pe-key', label));
      var rowEl = el('div', 'swatch-row');
      var current = a.sprite[key];
      for (var i = 0; i < colors.length; i++) {
        (function (col) {
          var sw = el('button', 'swatch swatch-sm');
          sw.type = 'button';
          sw.style.background = col;
          sw.style.boxShadow = '0 0 6px ' + col;
          sw.setAttribute('data-color', col);
          if (current && String(current).toLowerCase() === String(col).toLowerCase()) sw.classList.add('active');
          on(sw, 'click', function () {
            a.sprite[key] = col;
            highlightSegmented(rowEl, 'data-color', col);
            persistCustomization();
          });
          rowEl.appendChild(sw);
        })(colors[i]);
      }
      f.appendChild(rowEl);
      return f;
    };

    body.appendChild(rowFor(T('customize.hair', 'Hair'), 'hair', opts.hair));
    body.appendChild(rowFor(T('customize.skin', 'Skin'), 'skin', opts.skin));
    body.appendChild(rowFor(T('customize.accent', 'Accent'), 'accent', opts.accent));

    // Reset row
    var resetField = el('div', 'pe-field');
    var resetBtn = el('button', 'btn btn-sq', '↺');
    resetBtn.type = 'button';
    resetBtn.style.width = 'auto';
    resetBtn.style.padding = '0 10px';
    resetBtn.appendChild(document.createTextNode(' ' + T('customize.reset', 'Reset')));
    on(resetBtn, 'click', function () {
      a.sprite = {};
      refreshCustomizePanel(agentId);
      persistCustomization();
    });
    resetField.appendChild(resetBtn);
    body.appendChild(resetField);
  }

  function persistCustomization() {
    try { if (App.Store && App.Store.save) App.Store.save(); } catch (e) {}
  }

  // Terminal/log view: the agent's recent activity (conversation tail + memories
  // + any logged tool calls), rendered monospace. Read-only, newest at bottom.
  function refreshTerminalPanel(agentId) {
    var body = $('panel-agent-terminal-body');
    if (!body) return;
    clear(body);
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(agentId) : null;
    if (!a) return;

    var lines = collectAgentActivity(a);
    if (!lines.length) {
      body.appendChild(el('div', 'pe-empty', T('panel.noActivity', 'No activity yet.')));
      return;
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var row = el('div', 'term-line term-' + (ln.kind || 'sys'));
      if (ln.tag) {
        var tag = el('span', 'term-tag', ln.tag);
        row.appendChild(tag);
      }
      row.appendChild(document.createTextNode(ln.text || ''));
      body.appendChild(row);
    }
    body.scrollTop = body.scrollHeight;
  }

  // Gather a flat, time-ordered activity list for one agent from available state.
  function collectAgentActivity(a) {
    var out = [];
    // Conversation turns (direct chat).
    var conv = Array.isArray(a.conversation) ? a.conversation : [];
    for (var i = Math.max(0, conv.length - 12); i < conv.length; i++) {
      var t = conv[i] || {};
      out.push({
        kind: t.role === 'user' ? 'in' : 'out',
        tag: t.role === 'user' ? '>' : a.name || 'agent',
        text: truncate(String(t.content || ''), 400)
      });
    }
    // Global log lines authored by this agent (tool calls / results live here).
    try {
      var glog = (STATE() && STATE().log) || [];
      var mine = [];
      for (var j = 0; j < glog.length; j++) {
        var e = glog[j];
        if (e && e.from === a.name) mine.push(e);
      }
      mine = mine.slice(-10);
      for (var k = 0; k < mine.length; k++) {
        var le = mine[k];
        out.push({
          kind: le.kind === 'error' ? 'err' : (le.kind === 'tool' ? 'tool' : 'sys'),
          tag: le.kind === 'tool' ? '⚙' : '·',
          text: truncate(String(le.text || ''), 400)
        });
      }
    } catch (e) {}
    return out;
  }

  // Inject (once) a '☕ Break' button into the agent panel compose row; it sends
  // the open agent on a tea break via Orchestrator.sendOnBreak. Reuses .btn.
  function ensureBreakButton() {
    if ($('panel-agent-break')) return;
    var sendBtn = $('panel-agent-send');
    if (!sendBtn || !sendBtn.parentNode) return;
    var b = el('button', 'btn', '☕ Break');
    b.id = 'panel-agent-break';
    b.type = 'button';
    b.title = 'Send this agent on a coffee break';
    on(b, 'click', function () {
      var s = STATE();
      if (!s || !s.selectedAgentId) return;
      if (ORCH() && ORCH().sendOnBreak) ORCH().sendOnBreak(s.selectedAgentId);
    });
    // place it just before the SEND button so it reads as a secondary action
    sendBtn.parentNode.insertBefore(b, sendBtn);
  }

  // Inject (once) a global "Coffee break" button into the HUD controls; it sends
  // every idle non-boss agent on a staggered break via breakEveryone. Reuses .btn.
  function ensureCoffeeBreakButton() {
    if ($('btn-coffee-break')) return;
    var controls = $('hud-controls');
    if (!controls) return;
    var b = el('button', 'btn');
    b.id = 'btn-coffee-break';
    b.type = 'button';
    b.title = 'Send everyone on a coffee break';
    var ico = el('span', 'btn-ico', '☕');
    var lbl = el('span', 'btn-lbl', 'Coffee break');
    b.appendChild(ico);
    b.appendChild(lbl);
    on(b, 'click', function () {
      if (ORCH() && ORCH().breakEveryone) ORCH().breakEveryone();
    });
    // place it before the first separator (with the primary actions)
    var sep = controls.querySelector ? controls.querySelector('.hud-sep') : null;
    if (sep) controls.insertBefore(b, sep);
    else controls.appendChild(b);
  }

  UI.closeAgentPanel = function () {
    var s = STATE();
    if (s) { s.selectedAgentId = null; s._followId = null; }
    hide($('panel-agent'));
    stopPanelPreview();
    UI.refreshAgentList();
  };

  function refreshSelectedPanel() {
    var s = STATE();
    if (!s || !s.selectedAgentId) return;
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(s.selectedAgentId) : null;
    if (!a) { UI.closeAgentPanel(); return; }
    var nameNode = $('panel-agent-name');
    setText(nameNode, a.name);
    if (nameNode) nameNode.style.color = a.color || undefined;
    var roleLabel = (ROLES()[a.role] && ROLES()[a.role].label) || a.role;
    setText($('panel-agent-meta'),
      roleLabel + ' · ' + a.state + ' · ' + shortModel(a.model) +
      ' · ✓' + a.stats.tasksDone + ' · ↓' + a.stats.tokensIn + ' ↑' + a.stats.tokensOut);
    // accent
    var accent = $('panel-agent');
    if (accent) accent.style.setProperty('--accent', a.color || '#9b5cff');
    // keep persona/memory + mood/terminal in sync while the panel is open
    refreshPersonaPanel(a.id);
    if ($('panel-agent-mood-body')) refreshMoodPanel(a.id);
    if ($('panel-agent-terminal-body')) refreshTerminalPanel(a.id);
  }

  // Read-only persona + recent memories for the open agent panel.
  function refreshPersonaPanel(agentId) {
    var body = $('panel-agent-persona-body');
    if (!body) return;
    clear(body);
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(agentId) : null;
    if (!a) return;

    var p = a.persona || {};
    var addField = function (key, val) {
      val = (val == null ? '' : String(val)).trim();
      if (!val) return;
      var f = el('div', 'pe-field');
      f.appendChild(el('div', 'pe-key', key));
      f.appendChild(el('div', 'pe-val', val));
      body.appendChild(f);
    };
    addField('Identity', p.identity);
    addField('Plan', p.plan);
    addField('Relationships', p.relationships);
    if (!body.firstChild) body.appendChild(el('div', 'pe-empty', 'No persona defined.'));

    // recent memories (latest ~8, newest first)
    var memWrap = el('div', 'pe-field');
    memWrap.appendChild(el('div', 'pe-key', 'Recent memory'));
    var mems = Array.isArray(a.memories) ? a.memories : [];
    if (!mems.length) {
      memWrap.appendChild(el('div', 'pe-empty', 'No memories yet.'));
    } else {
      var recent = mems.slice(-8).reverse();
      for (var i = 0; i < recent.length; i++) {
        var m = recent[i] || {};
        var line = el('div', 'pe-mem');
        var imp = Math.round(Number(m.importance) || 0);
        line.appendChild(el('span', 'pe-imp', '◆' + imp));
        line.appendChild(document.createTextNode(String(m.text || '')));
        memWrap.appendChild(line);
      }
    }
    body.appendChild(memWrap);
  }

  function shortModel(m) {
    if (!m) return '?';
    if (m.indexOf('opus') !== -1) return 'opus';
    if (m.indexOf('sonnet') !== -1) return 'sonnet';
    if (m.indexOf('haiku') !== -1) return 'haiku';
    return m;
  }

  // Render the whole conversation into the transcript (used on open/refresh).
  function renderTranscript(agentId) {
    var box = $('panel-agent-transcript');
    if (!box) return;
    clear(box);
    var a = AGENTS() && AGENTS().byId ? AGENTS().byId(agentId) : null;
    if (!a) return;
    var conv = a.conversation || [];
    for (var i = 0; i < conv.length; i++) {
      appendTurnNode(box, conv[i].role, conv[i].content);
    }
    box.scrollTop = box.scrollHeight;
  }

  function appendTurnNode(box, role, text) {
    var turn = el('div', 'tx-turn tx-' + (role === 'user' ? 'user' : 'assistant'));
    var who = el('div', 'tx-role', role === 'user' ? 'YOU' : 'AGENT');
    var body = el('div', 'tx-body', text || '');
    turn.appendChild(who);
    turn.appendChild(body);
    box.appendChild(turn);
    return turn;
  }

  // appendTranscript(agentId, role, text) — live-append; for assistant streaming we
  // coalesce consecutive deltas into the last assistant bubble.
  UI.appendTranscript = function (agentId, role, text) {
    var s = STATE();
    if (!s || s.selectedAgentId !== agentId) return; // only the OPEN panel
    var box = $('panel-agent-transcript');
    if (!box) return;

    if (role === 'tool') {
      // tool result/notice — render as a distinct chip, not a chat bubble.
      // a tool turn closes any open streaming assistant turn first.
      var prevT = box.lastChild;
      if (prevT && prevT.getAttribute) prevT.removeAttribute('data-streaming');
      var raw = String(text || '');
      // strip a leading "[tool NAME] " marker into a styled name chip
      var name = 'tool', rest = raw;
      var mm = /^\[tool\s*([^\]]*)\]\s*([\s\S]*)$/.exec(raw);
      if (mm) { name = (mm[1] || 'tool').trim() || 'tool'; rest = mm[2]; }
      var chip = el('div', 'tx-tool');
      chip.appendChild(el('span', 'tx-tool-ico', '🔧'));
      chip.appendChild(el('span', 'tx-tool-name', name));
      if (rest) chip.appendChild(el('span', 'tx-tool-brief', truncate(rest, 160)));
      box.appendChild(chip);
      box.scrollTop = box.scrollHeight;
      return;
    }
    if (role === 'assistant') {
      var last = box.lastChild;
      if (last && last.classList && last.classList.contains('tx-assistant') &&
          last.getAttribute('data-streaming') === '1') {
        var body = last.querySelector('.tx-body');
        if (body) body.textContent += String(text || '');
      } else {
        var turn = appendTurnNode(box, 'assistant', String(text || ''));
        turn.setAttribute('data-streaming', '1');
      }
    } else {
      // user turn closes any open streaming assistant turn first
      var prev = box.lastChild;
      if (prev && prev.getAttribute) prev.removeAttribute('data-streaming');
      appendTurnNode(box, 'user', String(text || ''));
    }
    box.scrollTop = box.scrollHeight;
  };

  // ----- tool-call display (Wave B/C) ------------------------------------
  // Orchestrator calls this when a worker invokes a browser tool so the user
  // sees it inline. Renders a compact chip in the open transcript and refreshes
  // the agent's terminal/log section. Safe no-op if the panel isn't open.
  UI.logToolCall = function (agentId, name, brief) {
    try {
      var s = STATE();
      // Always refresh the terminal section if this agent's panel is open.
      if (s && s.selectedAgentId === agentId && $('panel-agent-terminal-body')) {
        refreshTerminalPanel(agentId);
      }
      if (!s || s.selectedAgentId !== agentId) return;
      var box = $('panel-agent-transcript');
      if (!box) return;
      var chip = el('div', 'tx-tool');
      var ico = el('span', 'tx-tool-ico', '⚙');
      var lbl = el('span', 'tx-tool-name', String(name || 'tool'));
      chip.appendChild(ico);
      chip.appendChild(lbl);
      if (brief) chip.appendChild(el('span', 'tx-tool-brief', truncate(String(brief), 120)));
      box.appendChild(chip);
      box.scrollTop = box.scrollHeight;
    } catch (e) {}
  };

  // onToolCall(info) — optional hook the orchestrator may call when a tool fires.
  // info: { agentId, agentName, name, input, ok, brief }. Pushes a styled 'tool'
  // log line (🔧 name ok/err) and mirrors it into the open transcript. Safe no-op
  // if Store/log is unavailable. The orchestrator already logs tool kind='tool'
  // directly; this is an additional entry point so other callers stay decoupled.
  UI.onToolCall = function (info) {
    try {
      info = info || {};
      var name = String(info.name || 'tool');
      var ok = (info.ok !== false);
      var brief = info.brief != null ? String(info.brief)
        : (info.input != null ? compactInput(info.input) : '');
      var from = info.agentName || 'agent';
      var txt = '🔧 ' + name + (ok ? ' ✓' : ' ✗') + (brief ? ' · ' + truncate(brief, 80) : '');
      if (App.Store && App.Store.pushLog) {
        App.Store.pushLog({ from: from, to: 'tool', kind: 'tool', text: txt });
      }
      if (info.agentId != null) UI.logToolCall(info.agentId, name, brief);
      UI.refreshLog();
    } catch (e) {}
  };

  // Compact a tool input object/string into a short single-line brief.
  function compactInput(input) {
    try {
      if (input == null) return '';
      if (typeof input === 'string') return input;
      // prefer the most descriptive scalar fields when present
      var keys = ['path', 'query', 'url', 'filename', 'title', 'type', 'expr'];
      for (var i = 0; i < keys.length; i++) {
        if (input[keys[i]] != null && typeof input[keys[i]] !== 'object') return keys[i] + '=' + input[keys[i]];
      }
      return truncate(JSON.stringify(input), 120);
    } catch (e) { return ''; }
  }

  // ----- panel mini-sprite preview (idle-bob) -----
  function startPanelPreview() {
    stopPanelPreview();
    var canvas = $('panel-agent-canvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var loop = function () {
      try {
        var s = STATE();
        var a = (s && s.selectedAgentId && AGENTS().byId) ? AGENTS().byId(s.selectedAgentId) : null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (a && App.PixelArt && App.PixelArt.drawAgent) {
          var size = 48;
          App.PixelArt.drawAgent(ctx, idleClone(a), canvas.width / 2, canvas.height - 6, size, {});
        }
      } catch (e) {}
      _panelPreviewRAF = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopPanelPreview() {
    if (_panelPreviewRAF) { cancelAnimationFrame(_panelPreviewRAF); _panelPreviewRAF = 0; }
  }
  // a shallow copy forced to idle so the preview always idle-bobs regardless of work state
  function idleClone(a) {
    return {
      id: a.id, name: a.name, role: a.role, color: a.color,
      state: 'idle', facing: 'down', anim: { frame: 0, t: 0 },
    };
  }

  // ===========================================================================
  // ADD-AGENT MODAL
  // ===========================================================================
  UI.openAddAgent = function () {
    var modal = $('modal-add-agent');
    populateRoleSelect($('aa-role'));
    buildSegmentedModels($('aa-model'));
    buildSwatchRow($('aa-color'));
    // defaults
    var nameI = $('aa-name'); if (nameI) nameI.value = '';
    var sysI = $('aa-system'); if (sysI) sysI.value = '';
    onAARoleChange(); // sets default model+color from role
    show(modal);
    startAAPreview();
  };

  function onAARoleChange() {
    var roleSel = $('aa-role');
    if (!roleSel) return;
    var role = roleSel.value;
    var rdef = ROLES()[role] || {};
    var s = STATE();
    var settings = (s && s.settings) || {};
    // default model: boss->bossModel, else defaultModel, else role model
    var model = (role === 'boss' ? settings.bossModel : settings.defaultModel) || rdef.model || CFG().DEFAULT_MODEL;
    _aaSel.model = model;
    highlightSegmented($('aa-model'), 'data-model', model);
    _aaSel.color = rdef.color || (CFG().palette ? CFG().palette.purple : '#9b5cff');
    highlightSegmented($('aa-color'), 'data-color', _aaSel.color);
    schedAAPreview();
  }

  function submitAddAgent() {
    var roleSel = $('aa-role');
    var nameI = $('aa-name');
    var sysI = $('aa-system');
    var role = roleSel ? roleSel.value : 'generalist';
    var spec = {
      name: (nameI && nameI.value.trim()) || cap(role),
      role: role,
      model: _aaSel.model || undefined,
      color: _aaSel.color || undefined,
      systemPrompt: (sysI && sysI.value.trim()) || undefined,
    };
    if (AGENTS() && AGENTS().create) {
      var a = AGENTS().create(spec);
      if (a && App.Store && App.Store.save) App.Store.save();
      UI.toast('Agent "' + spec.name + '" joined the crew');
    }
    hide($('modal-add-agent'));
    stopAAPreview();
    UI.refresh();
  }
  function cap(s) { s = String(s || 'agent'); return s.charAt(0).toUpperCase() + s.slice(1); }

  function schedAAPreview() { /* preview loop reads _aaSel live; nothing to do */ }
  function startAAPreview() {
    stopAAPreview();
    var canvas = $('aa-preview-canvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var loop = function () {
      try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var roleSel = $('aa-role');
        var role = roleSel ? roleSel.value : 'generalist';
        var nameI = $('aa-name');
        var ghost = {
          id: 'preview_' + role,
          name: (nameI && nameI.value.trim()) || cap(role),
          role: role,
          color: _aaSel.color || ((CFG().palette) ? CFG().palette.purple : '#9b5cff'),
          state: 'idle', facing: 'down', anim: { frame: 0, t: 0 },
        };
        if (App.PixelArt && App.PixelArt.drawAgent) {
          App.PixelArt.drawAgent(ctx, ghost, canvas.width / 2, canvas.height - 10, 64, {});
        }
      } catch (e) {}
      _aaPreviewRAF = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopAAPreview() {
    if (_aaPreviewRAF) { cancelAnimationFrame(_aaPreviewRAF); _aaPreviewRAF = 0; }
  }

  // ===========================================================================
  // SETTINGS MODAL
  // ===========================================================================
  UI.openSettings = function () {
    var s = STATE();
    var settings = (s && s.settings) || {};
    var keyI = $('set-apikey'); if (keyI) { keyI.value = settings.apiKey || ''; keyI.type = 'password'; }
    // Inject (once) + load the OpenAI key field next to the Anthropic key.
    ensureOpenAIKeyField();
    var oaiI = $('set-openai-key'); if (oaiI) { oaiI.value = settings.openaiKey || ''; oaiI.type = 'password'; }
    // Inject (once) + load the local-companion toggle + URL.
    ensureCompanionField();
    // Inject (once) the EN/KO language toggle.
    ensureLangField();
    highlightSegmented($('set-lang'), 'data-lang', currentLang());
    var ctog = $('set-companion-toggle'); if (ctog) ctog.checked = !!settings.useCompanion;
    var curl = $('set-companion-url'); if (curl) curl.value = settings.companionUrl || (CFG().COMPANION_URL || 'http://localhost:8787/v1/messages');
    var dm = $('set-default-model'); if (dm) dm.value = settings.defaultModel || CFG().DEFAULT_MODEL;
    var bm = $('set-boss-model'); if (bm) bm.value = settings.bossModel || CFG().BOSS_MODEL;
    setWebSearchSwitch(!!settings.webSearch);
    // GitHub push fields (v5).
    var gh = (settings.github && typeof settings.github === 'object') ? settings.github : {};
    var ght = $('set-gh-token'); if (ght) { ght.value = gh.token || ''; ght.type = 'password'; }
    var gho = $('set-gh-owner'); if (gho) gho.value = gh.owner || '';
    var ghr = $('set-gh-repo'); if (ghr) ghr.value = gh.repo || '';
    var ghb = $('set-gh-branch'); if (ghb) ghb.value = gh.branch || 'main';
    // (v6) Inject + load the agent-tools controls (CORS proxy URL, allow tools,
    // allow tool GitHub push). Defaults: tools ON, push OFF, proxy empty.
    ensureToolsFields();
    var ten = $('set-tools-enabled'); if (ten) ten.checked = (settings.toolsEnabled !== false);
    var cpx = $('set-cors-proxy'); if (cpx) cpx.value = settings.corsProxy || '';
    var atg = $('set-tool-gh-push'); if (atg) atg.checked = (settings.allowToolGithubPush === true);
    show($('modal-settings'));
  };

  // Inject (once) the AGENT TOOLS settings group after the GitHub field, reusing
  // the existing .field / .field-row / .switch styling. Adds:
  //   - 'Allow agent tools' switch  -> settings.toolsEnabled (default ON)
  //   - 'CORS proxy URL' input      -> settings.corsProxy   (default '')
  //   - 'Allow tool GitHub push'    -> settings.allowToolGithubPush (default OFF)
  // Idempotent; degrades gracefully if the anchor is missing.
  function ensureToolsFields() {
    if ($('set-tools-enabled')) return; // already injected
    var anchor = $('set-gh-token');
    if (!anchor || typeof document === 'undefined') return;
    var anchorField = anchor;
    while (anchorField && anchorField.classList && !anchorField.classList.contains('field')) {
      anchorField = anchorField.parentNode;
    }
    if (!anchorField || !anchorField.parentNode) return;

    var group = el('div', 'field');
    var groupLabel = el('span', 'field-label');
    groupLabel.setAttribute('data-i18n', 'set.tools');
    groupLabel.textContent = T('set.tools', 'AGENT TOOLS');
    group.appendChild(groupLabel);

    // --- Allow agent tools switch (default ON) ---
    var toolRow = el('div', 'field field-inline');
    var toolLbl = el('span', 'field-label');
    toolLbl.setAttribute('data-i18n', 'set.toolsEnabled');
    toolLbl.textContent = T('set.toolsEnabled', 'ALLOW AGENT TOOLS');
    var toolSw = el('button', 'switch on');
    toolSw.id = 'set-tools-enabled';
    toolSw.type = 'button';
    toolSw.setAttribute('role', 'switch');
    toolSw.setAttribute('aria-checked', 'true');
    toolSw.title = 'Let agents call browser tools (files, search, run, charts)';
    toolSw.appendChild(el('span', 'switch-knob'));
    // expose .checked-like access via a getter mapped to aria-checked
    Object.defineProperty(toolSw, 'checked', {
      configurable: true,
      get: function () { return this.getAttribute('aria-checked') === 'true'; },
      set: function (v) { setSwitch(this, !!v); }
    });
    on(toolSw, 'click', function () { setSwitch(toolSw, toolSw.getAttribute('aria-checked') !== 'true'); });
    var toolHint = el('span', 'field-hint inline-hint',
      T('set.toolsEnabled.hint', 'Let agents read/write files, search, run HTML, and make charts.'));
    toolRow.appendChild(toolLbl);
    toolRow.appendChild(toolSw);
    toolRow.appendChild(toolHint);
    group.appendChild(toolRow);

    // --- CORS proxy URL ---
    var proxyRow = el('div', 'field');
    var proxyLbl = el('span', 'field-label');
    proxyLbl.setAttribute('data-i18n', 'set.corsProxy');
    proxyLbl.textContent = T('set.corsProxy', 'CORS PROXY URL');
    var proxyInput = document.createElement('input');
    proxyInput.id = 'set-cors-proxy';
    proxyInput.type = 'text';
    proxyInput.autocomplete = 'off';
    proxyInput.spellcheck = false;
    proxyInput.placeholder = 'https://your-proxy/?url=  (enables web_fetch)';
    var proxyHint = el('span', 'field-hint',
      T('set.corsProxy.hint', 'Optional. The web_fetch tool prepends this and appends the encoded URL. Leave blank to disable web fetching.'));
    proxyRow.appendChild(proxyLbl);
    proxyRow.appendChild(proxyInput);
    proxyRow.appendChild(proxyHint);
    group.appendChild(proxyRow);

    // --- Allow tool GitHub push switch (default OFF) ---
    var pushRow = el('div', 'field field-inline');
    var pushLbl = el('span', 'field-label');
    pushLbl.setAttribute('data-i18n', 'set.toolGhPush');
    pushLbl.textContent = T('set.toolGhPush', 'ALLOW TOOL GITHUB PUSH');
    var pushSw = el('button', 'switch');
    pushSw.id = 'set-tool-gh-push';
    pushSw.type = 'button';
    pushSw.setAttribute('role', 'switch');
    pushSw.setAttribute('aria-checked', 'false');
    pushSw.title = 'Let the github_push tool push without confirmation (off by default)';
    pushSw.appendChild(el('span', 'switch-knob'));
    Object.defineProperty(pushSw, 'checked', {
      configurable: true,
      get: function () { return this.getAttribute('aria-checked') === 'true'; },
      set: function (v) { setSwitch(this, !!v); }
    });
    on(pushSw, 'click', function () { setSwitch(pushSw, pushSw.getAttribute('aria-checked') !== 'true'); });
    var pushHint = el('span', 'field-hint inline-hint',
      T('set.toolGhPush.hint', 'Off by default — agents cannot push to GitHub via tools unless enabled.'));
    pushRow.appendChild(pushLbl);
    pushRow.appendChild(pushSw);
    pushRow.appendChild(pushHint);
    group.appendChild(pushRow);

    if (anchorField.nextSibling) anchorField.parentNode.insertBefore(group, anchorField.nextSibling);
    else anchorField.parentNode.appendChild(group);
  }

  // Generic neon-switch state setter (mirrors setWebSearchSwitch for any switch).
  function setSwitch(sw, on_) {
    if (!sw) return;
    sw.setAttribute('aria-checked', on_ ? 'true' : 'false');
    if (on_) sw.classList.add('on'); else sw.classList.remove('on');
  }

  function toggleGhTokenVisible() {
    var t = $('set-gh-token');
    if (!t) return;
    t.type = (t.type === 'password') ? 'text' : 'password';
  }

  // shell.html ships only the Anthropic-key field; inject an OpenAI-key field
  // dynamically (id 'set-openai-key' + show/hide toggle) right after it, reusing
  // the existing .field / .field-row / .btn styling. Idempotent.
  function ensureOpenAIKeyField() {
    if ($('set-openai-key')) return; // already injected
    var anchorInput = $('set-apikey');
    if (!anchorInput || typeof document === 'undefined') return;
    // climb to the enclosing .field label of the Anthropic key
    var anchorField = anchorInput;
    while (anchorField && anchorField.classList && !anchorField.classList.contains('field')) {
      anchorField = anchorField.parentNode;
    }
    if (!anchorField || !anchorField.parentNode) return;

    var field = el('label', 'field');
    var lbl = el('span', 'field-label', 'OPENAI API KEY');
    var row = el('span', 'field-row');
    var input = document.createElement('input');
    input.id = 'set-openai-key';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'sk-…  (for GPT-model agents)';
    var toggle = el('button', 'btn btn-sq', '👁');
    toggle.type = 'button';
    toggle.title = 'Show / hide key';
    toggle.setAttribute('aria-label', 'Toggle visibility');
    on(toggle, 'click', function () { toggleOpenAIKeyVisible(); });
    row.appendChild(input);
    row.appendChild(toggle);
    var hint = el('span', 'field-hint',
      'Stored only in your browser (localStorage). Used for GPT-model agents.');
    field.appendChild(lbl);
    field.appendChild(row);
    field.appendChild(hint);

    // insert directly after the Anthropic-key field
    if (anchorField.nextSibling) anchorField.parentNode.insertBefore(field, anchorField.nextSibling);
    else anchorField.parentNode.appendChild(field);
  }

  function toggleOpenAIKeyVisible() {
    var oaiI = $('set-openai-key');
    if (!oaiI) return;
    oaiI.type = (oaiI.type === 'password') ? 'text' : 'password';
  }

  // Inject (once) the local-companion controls (checkbox + URL) after the OpenAI
  // key field, reusing the existing .field styling. Lets Claude-model agents run
  // through the local subscription proxy (companion.py) with NO Anthropic key.
  function ensureCompanionField() {
    if ($('set-companion-toggle')) return; // already injected
    var anchor = $('set-openai-key');
    if (!anchor || typeof document === 'undefined') return;
    var anchorField = anchor;
    while (anchorField && anchorField.classList && !anchorField.classList.contains('field')) {
      anchorField = anchorField.parentNode;
    }
    if (!anchorField || !anchorField.parentNode) return;

    var field = el('label', 'field');
    field.appendChild(el('span', 'field-label', 'LOCAL COMPANION (SUBSCRIPTION)'));

    var row = el('span', 'field-row');
    var cb = document.createElement('input');
    cb.id = 'set-companion-toggle';
    cb.type = 'checkbox';
    cb.style.flex = '0 0 auto';
    var cbHint = el('span', 'field-hint', 'Use your Claude subscription via companion.py (no API key needed)');
    cbHint.style.flex = '1';
    row.appendChild(cb);
    row.appendChild(cbHint);

    var urlRow = el('span', 'field-row');
    var url = document.createElement('input');
    url.id = 'set-companion-url';
    url.type = 'text';
    url.autocomplete = 'off';
    url.spellcheck = false;
    url.placeholder = 'http://localhost:8787/v1/messages';
    urlRow.appendChild(url);

    var hint = el('span', 'field-hint',
      'Run companion/companion.py, then enable. Works with the file:// or localhost app (not the https Pages site).');

    field.appendChild(row);
    field.appendChild(urlRow);
    field.appendChild(hint);

    if (anchorField.nextSibling) anchorField.parentNode.insertBefore(field, anchorField.nextSibling);
    else anchorField.parentNode.appendChild(field);
  }

  // Inject (once) a LANGUAGE segmented EN/KO toggle into Settings. Switching it
  // calls App.I18n.setLang + re-applies translations live (and persists via Store
  // through I18n.setLang). Idempotent; no-ops gracefully if I18n is absent.
  function ensureLangField() {
    if ($('set-lang')) return;
    var anchor = $('set-default-model');
    if (!anchor || typeof document === 'undefined') return;
    var anchorField = anchor;
    while (anchorField && anchorField.classList && !anchorField.classList.contains('field')) {
      anchorField = anchorField.parentNode;
    }
    // climb once more past the .field-2col wrapper if present
    var insertAfter = anchorField;
    if (anchorField && anchorField.parentNode && anchorField.parentNode.classList &&
        anchorField.parentNode.classList.contains('field-2col')) {
      insertAfter = anchorField.parentNode;
    }
    if (!insertAfter || !insertAfter.parentNode) return;

    var field = el('div', 'field field-inline');
    var lbl = el('span', 'field-label');
    lbl.setAttribute('data-i18n', 'set.language');
    lbl.textContent = T('set.language', 'LANGUAGE');
    field.appendChild(lbl);

    var seg = el('div', 'segmented');
    seg.id = 'set-lang';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Language');
    var langs = [{ id: 'en', label: 'EN' }, { id: 'ko', label: '한' }];
    var cur = currentLang();
    langs.forEach(function (L) {
      var b = el('button', 'seg' + (L.id === cur ? ' active' : ''), L.label);
      b.type = 'button';
      b.setAttribute('data-lang', L.id);
      on(b, 'click', function () { setLanguage(L.id); });
      seg.appendChild(b);
    });
    field.appendChild(seg);

    if (insertAfter.nextSibling) insertAfter.parentNode.insertBefore(field, insertAfter.nextSibling);
    else insertAfter.parentNode.appendChild(field);
  }

  function currentLang() {
    try {
      if (App.I18n && App.I18n.getLang) return App.I18n.getLang();
    } catch (e) {}
    var s = STATE();
    return (s && s.settings && s.settings.lang) || 'en';
  }

  function setLanguage(lang) {
    try {
      if (App.I18n && App.I18n.setLang) App.I18n.setLang(lang);
      else {
        var s = STATE();
        if (s) { s.settings = s.settings || {}; s.settings.lang = lang; }
        if (App.Store && App.Store.save) App.Store.save();
      }
    } catch (e) {}
    // reflect selection in the segmented control
    highlightSegmented($('set-lang'), 'data-lang', lang);
    // re-apply translations across the whole document + any open modals
    applyI18n(document);
  }

  function saveSettings() {
    var s = STATE();
    if (!s) return;
    var settings = s.settings || (s.settings = {});
    var keyI = $('set-apikey'); if (keyI) settings.apiKey = keyI.value.trim();
    var oaiI = $('set-openai-key'); if (oaiI) settings.openaiKey = oaiI.value.trim();
    var ctog = $('set-companion-toggle'); if (ctog) settings.useCompanion = !!ctog.checked;
    var curl = $('set-companion-url'); if (curl) settings.companionUrl = curl.value.trim() || (CFG().COMPANION_URL || 'http://localhost:8787/v1/messages');
    var dm = $('set-default-model'); if (dm) settings.defaultModel = dm.value;
    var bm = $('set-boss-model'); if (bm) settings.bossModel = bm.value;
    var sw = $('set-websearch');
    if (sw) settings.webSearch = (sw.getAttribute('aria-checked') === 'true');
    // GitHub push config (token stays local).
    var gh = (settings.github && typeof settings.github === 'object') ? settings.github : (settings.github = { token: '', owner: '', repo: '', branch: 'main' });
    var ght = $('set-gh-token'); if (ght) gh.token = ght.value.trim();
    var gho = $('set-gh-owner'); if (gho) gh.owner = gho.value.trim();
    var ghr = $('set-gh-repo'); if (ghr) gh.repo = ghr.value.trim();
    var ghb = $('set-gh-branch'); if (ghb) gh.branch = ghb.value.trim() || 'main';
    // (v6) Agent-tools settings. tools default ON, push default OFF.
    var ten = $('set-tools-enabled'); if (ten) settings.toolsEnabled = (ten.getAttribute('aria-checked') === 'true');
    var cpx = $('set-cors-proxy'); if (cpx) settings.corsProxy = cpx.value.trim();
    var atg = $('set-tool-gh-push'); if (atg) settings.allowToolGithubPush = (atg.getAttribute('aria-checked') === 'true');
    if (App.Store && App.Store.save) App.Store.save();
    hide($('modal-settings'));
    requestNotifyPermission(); // polite, one-time, on this user gesture
    UI.toast('Settings saved');
  }

  function toggleApiKeyVisible() {
    var keyI = $('set-apikey');
    if (!keyI) return;
    keyI.type = (keyI.type === 'password') ? 'text' : 'password';
  }

  function setWebSearchSwitch(on_) {
    var sw = $('set-websearch');
    if (!sw) return;
    sw.setAttribute('aria-checked', on_ ? 'true' : 'false');
    if (on_) sw.classList.add('on'); else sw.classList.remove('on');
  }
  function toggleWebSearchSwitch() {
    var sw = $('set-websearch');
    if (!sw) return;
    setWebSearchSwitch(sw.getAttribute('aria-checked') !== 'true');
  }

  function exportData() {
    if (!(App.Store && App.Store.exportJSON)) return;
    var json = App.Store.exportJSON();
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'neon-works-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      UI.toast('Exported company JSON');
    } catch (e) {
      UI.showError('Export failed: ' + (e && e.message));
    }
  }

  function importData(ev) {
    var file = ev && ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var ok = App.Store && App.Store.importJSON ? App.Store.importJSON(String(reader.result || '')) : false;
      if (ok) { UI.toast('Imported company'); UI.refresh(); hide($('modal-settings')); }
      else UI.showError('Import failed: invalid JSON');
      var f = $('set-import-file'); if (f) f.value = '';
    };
    reader.onerror = function () { UI.showError('Could not read file'); };
    reader.readAsText(file);
  }

  function clearData() {
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Clear ALL data and re-seed the default company? This cannot be undone.')) return;
    if (App.Store && App.Store.clear) App.Store.clear();
    hide($('modal-settings'));
    UI.closeAgentPanel();
    UI.refresh();
    UI.toast('Data cleared — fresh company seeded');
  }

  // ===========================================================================
  // TASK BOARD
  // ===========================================================================
  UI.openTaskBoard = function () {
    show($('board'));
    UI.refreshBoard();
    var input = $('board-input');
    if (input && input.focus) { try { input.focus(); } catch (e) {} }
  };

  // ===========================================================================
  // LAYOUT EDIT
  // ===========================================================================
  UI.toggleLayoutEdit = function () {
    var s = STATE();
    if (!s) return;
    s.layoutEdit = !s.layoutEdit;
    var palette = $('layout-palette');
    if (s.layoutEdit) { show(palette); }
    else {
      hide(palette);
      _layoutTool = null;
      if (App.Store && App.Store.save) App.Store.save(); // save on exit (§7.7)
    }
    refreshHud();
  };

  function bindLayoutPalette() {
    var palette = $('layout-palette');
    if (!palette) return;
    var items = palette.querySelectorAll ? palette.querySelectorAll('.palette-item') : [];
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        on(item, 'click', function () {
          var key = item.getAttribute('data-furniture');
          _layoutTool = (_layoutTool === key) ? null : key;
          for (var j = 0; j < items.length; j++) items[j].classList.remove('active');
          if (_layoutTool) item.classList.add('active');
        });
      })(items[i]);
    }
  }

  // place/move/remove furniture at a clicked cell (layout edit mode).
  function layoutEditAt(gx, gy) {
    var s = STATE();
    var w = WORLD();
    if (!s || !s.layout) return;
    var L = s.layout;
    var FURN = (CFG().FURNITURE) || {};

    var existing = w && w.furnitureAt ? w.furnitureAt(gx, gy) : null;

    if (_layoutTool) {
      // placing: don't stack on existing blocking furniture
      if (existing) { UI.toast('cell occupied — pick an empty floor cell'); return; }
      var def = FURN[_layoutTool] || { w: 1, h: 1, blocks: true, hasSeat: false };
      var f = {
        id: (App.util && App.util.uid) ? App.util.uid('f') : ('f_' + Date.now()),
        type: _layoutTool,
        gx: gx, gy: gy,
        dir: 'down',
        w: def.w || 1, h: def.h || 1,
        walkable: (def.blocks === false),
        seatGx: null, seatGy: null,
      };
      // compute a seat if it has one (cell below the footprint)
      if (def.hasSeat) {
        var seatGx = gx + (((def.w || 1) - 1) >> 1);
        var seatGy = gy + (def.h || 1);
        // (m6) Only accept a seat the agent can actually stand on. If the computed
        // cell is a wall/void/out-of-bounds, try the adjacent cells; if none are
        // walkable, leave the seat null rather than placing an unusable one.
        var walkable = function (cx, cy) {
          return !!(w && w.isWalkable ? w.isWalkable(cx, cy) : false);
        };
        if (walkable(seatGx, seatGy)) {
          f.seatGx = seatGx; f.seatGy = seatGy;
        } else {
          var cand = [
            [seatGx - 1, seatGy], [seatGx + 1, seatGy],
            [seatGx, seatGy - 1], [seatGx, seatGy + 1],
          ];
          f.seatGx = null; f.seatGy = null;
          for (var si = 0; si < cand.length; si++) {
            if (walkable(cand[si][0], cand[si][1])) {
              f.seatGx = cand[si][0]; f.seatGy = cand[si][1];
              break;
            }
          }
        }
      }
      L.furniture.push(f);
      UI.toast('placed ' + _layoutTool);
    } else if (existing) {
      // removing: clicking a prop with no tool selected removes it
      for (var i = 0; i < L.furniture.length; i++) {
        if (L.furniture[i] && L.furniture[i].id === existing.id) {
          L.furniture.splice(i, 1);
          UI.toast('removed ' + existing.type);
          break;
        }
      }
    }
    if (App.Store && App.Store.save) App.Store.save();
  }

  // ===========================================================================
  // CAMERA controls
  // ===========================================================================
  UI.zoomIn = function () { adjustZoom(+(CFG().ZOOM_STEP || 0.15)); };
  UI.zoomOut = function () { adjustZoom(-(CFG().ZOOM_STEP || 0.15)); };

  function adjustZoom(delta) {
    var s = STATE();
    if (!s || !s.camera) return;
    // zoom toward viewport center
    var canvas = $('world-canvas');
    var cx = canvas ? canvas.clientWidth / 2 : 480;
    var cy = canvas ? canvas.clientHeight / 2 : 300;
    zoomAt(cx, cy, s.camera.zoom + delta);
  }

  function zoomAt(screenX, screenY, newZoom) {
    var s = STATE();
    var w = WORLD();
    if (!s || !s.camera) return;
    var cfg = CFG();
    newZoom = clamp(newZoom, cfg.ZOOM_MIN || 0.5, cfg.ZOOM_MAX || 3.0);
    var pps = (cfg.PIXEL || 3); // per-world-px before zoom
    // world point under cursor BEFORE zoom
    var before = w && w.screenToWorld ? w.screenToWorld(screenX, screenY) : null;
    s.camera.zoom = newZoom;
    if (before) {
      // keep that world point under the cursor: cam = world - cursorScreen/(PIXEL*zoom)
      s.camera.x = before.x - screenX / (pps * newZoom);
      s.camera.y = before.y - screenY / (pps * newZoom);
    }
    if (w && w.clampCamera) w.clampCamera();
  }

  UI.resetView = function () {
    var s = STATE();
    if (!s || !s.camera) return;
    var start = CFG().CAMERA_START || { x: 0, y: 0, zoom: 1.0 };
    s.camera.x = start.x; s.camera.y = start.y; s.camera.zoom = start.zoom;
    if (WORLD() && WORLD().clampCamera) WORLD().clampCamera();
  };

  // ===========================================================================
  // CANVAS POINTER — pan / select / layout edit
  // ===========================================================================
  UI.onCanvasPointerDown = function (e) {
    var canvas = $('world-canvas');
    if (!canvas) return;
    try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch (err) {}
    _pan.active = true;
    _pan.movedEnough = false;
    _pan.lastX = e.clientX; _pan.lastY = e.clientY;
    _pan.downX = e.clientX; _pan.downY = e.clientY;
  };

  UI.onCanvasPointerMove = function (e) {
    if (!_pan.active) return;
    var s = STATE();
    if (!s || !s.camera) return;
    var dx = e.clientX - _pan.lastX;
    var dy = e.clientY - _pan.lastY;
    _pan.lastX = e.clientX; _pan.lastY = e.clientY;
    if (Math.abs(e.clientX - _pan.downX) + Math.abs(e.clientY - _pan.downY) > 4) _pan.movedEnough = true;

    // pan: moving the pointer right should move the world right => camera left.
    var cfg = CFG();
    var pps = (cfg.PIXEL || 3) * s.camera.zoom;
    s.camera.x -= dx / pps;
    s.camera.y -= dy / pps;
    if (WORLD() && WORLD().clampCamera) WORLD().clampCamera();
  };

  UI.onCanvasPointerUp = function (e) {
    var canvas = $('world-canvas');
    if (canvas) { try { canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
    var wasPan = _pan.movedEnough;
    _pan.active = false;
    if (wasPan) return; // a drag, not a click

    // It's a click — convert to cell.
    var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var s = STATE();
    var w = WORLD();
    var cell = (w && w.screenToCell) ? w.screenToCell(sx, sy) : null;
    if (!cell) return;

    if (s && s.layoutEdit) {
      layoutEditAt(cell.gx, cell.gy);
      return;
    }

    // select agent: hit-test by nearest agent within the clicked cell (or close).
    var a = agentAtCell(cell.gx, cell.gy, sx, sy);
    if (a) UI.openAgentPanel(a.id);
  };

  // Find an agent under the click: same cell, or whose sprite (taller than a cell)
  // covers the click point.
  function agentAtCell(gx, gy, sx, sy) {
    var s = STATE();
    var w = WORLD();
    if (!s || !Array.isArray(s.agents) || !w) return null;
    var size = w.cellSizeScreen ? w.cellSizeScreen() : 48;
    var best = null, bestD = Infinity;
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (!a) continue;
      // feet screen pos
      var feetWorldY = a.y + (CFG().TILE || 16) * 0.5;
      var scr = w.worldToScreen(a.x, feetWorldY);
      // sprite bbox: width ~ size, height ~ size*1.6 (24 art-px tall vs 16 cell)
      var halfW = size * 0.5;
      var top = scr.y - size * 1.6;
      if (sx >= scr.x - halfW && sx <= scr.x + halfW && sy >= top && sy <= scr.y + 2) {
        var d = Math.abs(sx - scr.x) + Math.abs(sy - (scr.y - size * 0.6));
        if (d < bestD) { bestD = d; best = a; }
      } else if (a.gx === gx && a.gy === gy) {
        if (!best) best = a;
      }
    }
    return best;
  }

  UI.onWheel = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    var s = STATE();
    if (!s || !s.camera) return;
    var canvas = $('world-canvas');
    var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var step = (CFG().ZOOM_STEP || 0.15);
    var dir = (e.deltaY < 0) ? 1 : -1;
    zoomAt(sx, sy, s.camera.zoom + dir * step);
  };

  // ===========================================================================
  // RESULT / ERROR / TOAST
  // ===========================================================================
  UI.showFinalResult = function (task) {
    if (!task) return;
    // Lightweight modal mounted into #modal-root.
    var root = $('modal-root');
    if (!root) { UI.toast('Result ready'); return; }
    // remove any prior result modal
    var prev = $('modal-result');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var modal = el('div', 'modal');
    modal.id = 'modal-result';
    var scrim = el('div', 'modal-scrim');
    on(scrim, 'click', function () { modal.parentNode && modal.parentNode.removeChild(modal); });
    var card = el('div', 'modal-card modal-result-card');
    var accent = el('div', 'panel-accent'); card.appendChild(accent);

    var head = el('header', 'modal-head');
    var title = el('h2', 'modal-title', task.status === 'error' ? '⚠ TASK FAILED' : '✓ FINAL RESULT');
    var x = el('button', 'panel-x', '✕');
    x.type = 'button';
    on(x, 'click', function () { modal.parentNode && modal.parentNode.removeChild(modal); });
    head.appendChild(title); head.appendChild(x);

    var body = el('div', 'modal-body');
    var goal = el('div', 'result-goal', 'GOAL: ' + truncate(task.desc || task.title, 200));
    body.appendChild(goal);

    var content = el('pre', 'result-content');
    if (task.status === 'error') {
      content.textContent = '⚠ ' + (task.error || 'failed') + '\n\n' + collectChildErrors(task);
    } else {
      content.textContent = task.result || '(no result)';
    }
    body.appendChild(content);

    var foot = el('footer', 'modal-foot');
    var copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    on(copy, 'click', function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(task.result || task.error || '');
        UI.toast('Copied to clipboard');
      } catch (e) {}
    });
    var close = el('button', 'btn btn-primary', 'Close');
    close.type = 'button';
    on(close, 'click', function () { modal.parentNode && modal.parentNode.removeChild(modal); });
    foot.appendChild(copy); foot.appendChild(close);

    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    modal.appendChild(scrim); modal.appendChild(card);
    root.appendChild(modal);
  };

  function collectChildErrors(root) {
    var s = STATE();
    if (!s || !Array.isArray(s.tasks)) return '';
    var out = [];
    for (var i = 0; i < s.tasks.length; i++) {
      var t = s.tasks[i];
      if (t && t.parentId === root.id && t.status === 'error') {
        out.push('• ' + t.title + ': ' + (t.error || 'error'));
      }
    }
    return out.join('\n');
  }

  UI.showError = function (msg) { UI.toast(msg, 'error'); };

  var _toastTimer = 0;
  UI.toast = function (msg, kind) {
    var box = $('toast');
    if (!box) { try { console && console.log && console.log('[toast]', msg); } catch (e) {} return; }
    var t = el('div', 'toast-item' + (kind === 'error' ? ' kind-error' : ''), msg);
    box.appendChild(t);
    // entrance animation is CSS (toast-in) on mount; play exit via .leaving then remove
    setTimeout(function () {
      t.classList.add('leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 3200);
  };

  // ===========================================================================
  // MISC
  // ===========================================================================
  function togglePause() {
    var s = STATE();
    if (!s) return;
    s.paused = !s.paused;
    refreshHud();
  }

  function drawLogo() {
    var canvas = $('hud-logo-canvas');
    if (!canvas || !canvas.getContext || !App.PixelArt || !App.PixelArt.drawLogoGlyph) return;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var loop = function () {
      try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        App.PixelArt.drawLogoGlyph(ctx, canvas.width / 2, canvas.height / 2, canvas.width);
      } catch (e) {}
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ===========================================================================
  // ARTIFACTS  (badge + modal + per-item copy/download + store-only ZIP)
  // ===========================================================================
  var _arSel = null; // currently-viewed artifact id

  UI.refreshArtifacts = function () {
    var s = STATE();
    var arts = (s && Array.isArray(s.artifacts)) ? s.artifacts : [];
    var badge = $('artifacts-badge');
    if (badge) {
      badge.textContent = String(arts.length);
      if (arts.length > 0) show(badge); else hide(badge);
    }
    // if the modal is open, re-render its list
    if ($('modal-artifacts')) renderArtifactList();
  };

  UI.openArtifacts = function () {
    var root = $('modal-root');
    if (!root) { UI.toast('Artifacts unavailable'); return; }
    var prev = $('modal-artifacts');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var modal = el('div', 'modal');
    modal.id = 'modal-artifacts';
    var scrim = el('div', 'modal-scrim');
    on(scrim, 'click', function () { closeArtifacts(); });

    var card = el('div', 'modal-card');
    card.appendChild(el('div', 'panel-accent'));

    var head = el('header', 'modal-head');
    head.appendChild(el('h2', 'modal-title', '📦 ARTIFACTS'));
    var x = el('button', 'panel-x', '✕'); x.type = 'button';
    on(x, 'click', function () { closeArtifacts(); });
    head.appendChild(x);

    var bodyEl = el('div', 'modal-body');
    var list = el('div', 'ar-list'); list.id = 'ar-list';
    bodyEl.appendChild(list);
    var viewerHead = el('div', 'ar-viewer-head hidden'); viewerHead.id = 'ar-viewer-head';
    bodyEl.appendChild(viewerHead);
    var viewer = el('pre', 'ar-viewer hidden'); viewer.id = 'ar-viewer';
    bodyEl.appendChild(viewer);

    var foot = el('footer', 'modal-foot');
    var zipBtn = el('button', 'btn', '⤓ Download all (.zip)');
    zipBtn.type = 'button';
    on(zipBtn, 'click', function () { downloadAllZip(); });
    var close = el('button', 'btn btn-primary', 'Close');
    close.type = 'button';
    on(close, 'click', function () { closeArtifacts(); });
    foot.appendChild(zipBtn); foot.appendChild(close);

    card.appendChild(head); card.appendChild(bodyEl); card.appendChild(foot);
    modal.appendChild(scrim); modal.appendChild(card);
    root.appendChild(modal);

    _arSel = null;
    renderArtifactList();
  };

  function closeArtifacts() {
    var m = $('modal-artifacts');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    _arSel = null;
    _arHtmlSource = false;
  }

  function renderArtifactList() {
    var list = $('ar-list');
    if (!list) return;
    clear(list);
    var s = STATE();
    var arts = (s && Array.isArray(s.artifacts)) ? s.artifacts : [];
    if (!arts.length) {
      list.appendChild(el('div', 'ar-empty', 'No artifacts yet. Dispatch a goal — workers emit code/docs/data here.'));
      hideArtifactViewer();
      return;
    }
    for (var i = arts.length - 1; i >= 0; i--) { // newest first
      (function (art) {
        var item = el('div', 'ar-item');
        if (_arSel === art.id) item.classList.add('active');
        item.appendChild(el('span', 'ar-type', art.type || 'text'));
        item.appendChild(el('span', 'ar-name', art.name || '(unnamed)'));
        var a = AGENTS() && AGENTS().byId ? AGENTS().byId(art.agentId) : null;
        var sz = byteLen(art.content || '');
        item.appendChild(el('span', 'ar-meta', (a ? a.name + ' · ' : '') + humanSize(sz)));
        on(item, 'click', function () { viewArtifact(art.id); });
        list.appendChild(item);
      })(arts[i]);
    }
  }

  function findArtifact(id) {
    var s = STATE();
    var arts = (s && Array.isArray(s.artifacts)) ? s.artifacts : [];
    for (var i = 0; i < arts.length; i++) if (arts[i] && arts[i].id === id) return arts[i];
    return null;
  }

  function hideArtifactViewer() {
    hide($('ar-viewer')); hide($('ar-viewer-head'));
    clearArtifactPreview();
  }

  // viewArtifact — preview an artifact via App.MD (markdown render, code highlight,
  // sandboxed html iframe with a 'view source' toggle, or plain text). Falls back
  // to the legacy <pre> viewer if App.MD is unavailable. Never throws.
  var _arHtmlSource = false; // per-open toggle: html artifact -> show source vs render
  function viewArtifact(id) {
    _arSel = id;
    _arHtmlSource = false;
    var art = findArtifact(id);
    var viewer = $('ar-viewer');
    var vhead = $('ar-viewer-head');
    if (!art || !vhead) return;
    if (viewer) hide(viewer); // legacy <pre> slot stays hidden when we render rich preview

    // header: name + Copy + Download (kept from the prior viewer)
    show(vhead);
    clear(vhead);
    vhead.appendChild(el('span', 'ar-viewer-name', art.name || '(unnamed)'));
    var copy = el('button', 'btn btn-sq', '⧉'); copy.type = 'button'; copy.title = 'Copy';
    on(copy, 'click', function () {
      try { if (navigator.clipboard) navigator.clipboard.writeText(art.content || ''); UI.toast('Copied ' + art.name); } catch (e) {}
    });
    var dl = el('button', 'btn btn-sq', '⤓'); dl.type = 'button'; dl.title = 'Download';
    on(dl, 'click', function () { downloadOne(art); });
    vhead.appendChild(copy); vhead.appendChild(dl);

    renderArtifactPreview(art);
    renderArtifactList(); // re-mark active
  }

  // Remove any rich-preview nodes we mounted previously (idempotent).
  function clearArtifactPreview() {
    ['ar-preview-modes', 'ar-preview-body'].forEach(function (pid) {
      var n = $(pid);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  }

  function previewMode(art) {
    var MD = App.MD;
    if (MD && MD.previewable) {
      try { return MD.previewable(art.type, art.name); } catch (e) {}
    }
    // crude fallback when App.MD is absent
    var name = String(art.name || '').toLowerCase();
    if (art.type === 'html' || /\.html?$/.test(name)) return 'html';
    if (art.type === 'markdown' || /\.md$/.test(name)) return 'markdown';
    if (art.type === 'code') return 'code';
    return 'text';
  }

  function langFromName(name) {
    var n = String(name || '').toLowerCase();
    var dot = n.lastIndexOf('.');
    return dot >= 0 ? n.slice(dot + 1) : '';
  }

  function renderArtifactPreview(art) {
    clearArtifactPreview();
    var anchor = $('ar-viewer-head');
    if (!anchor || !anchor.parentNode) return;
    var parent = anchor.parentNode;
    var content = String(art.content || '');
    var mode = previewMode(art);
    var MD = App.MD;

    var body = el('div', 'ar-preview-body'); body.id = 'ar-preview-body';

    if (mode === 'html') {
      // mode switcher: Preview (sandboxed iframe) vs Source (highlighted code)
      var modes = el('div', 'ar-preview-modes'); modes.id = 'ar-preview-modes';
      var bPrev = el('button', 'ar-mode-btn' + (_arHtmlSource ? '' : ' active'), 'Preview');
      bPrev.type = 'button';
      var bSrc = el('button', 'ar-mode-btn' + (_arHtmlSource ? ' active' : ''), 'View source');
      bSrc.type = 'button';
      on(bPrev, 'click', function () { if (_arHtmlSource) { _arHtmlSource = false; renderArtifactPreview(art); } });
      on(bSrc, 'click', function () { if (!_arHtmlSource) { _arHtmlSource = true; renderArtifactPreview(art); } });
      modes.appendChild(bPrev); modes.appendChild(bSrc);
      parent.appendChild(modes);

      if (_arHtmlSource) {
        body.appendChild(buildCodeBlock(content, 'html'));
      } else {
        var iframe = document.createElement('iframe');
        iframe.className = 'ar-iframe';
        iframe.setAttribute('sandbox', ''); // scripts disabled
        iframe.setAttribute('title', art.name || 'HTML preview');
        var srcdoc = (MD && MD.htmlPreviewSrcdoc) ? safeStr(MD.htmlPreviewSrcdoc(content)) : content;
        iframe.setAttribute('srcdoc', srcdoc);
        body.appendChild(iframe);
      }
    } else if (mode === 'markdown') {
      var md = el('div', 'ar-md md-body');
      if (MD && MD.render) { try { md.innerHTML = String(MD.render(content)); } catch (e) { md.textContent = content; } }
      else md.textContent = content;
      body.appendChild(md);
    } else if (mode === 'code') {
      body.appendChild(buildCodeBlock(content, langFromName(art.name)));
    } else {
      // plain text
      var pre = el('pre', 'ar-viewer');
      pre.style.display = 'block';
      pre.textContent = content;
      body.appendChild(pre);
    }

    parent.appendChild(body);
  }

  // Build a highlighted <pre><code> block (uses App.MD.highlight when present).
  function buildCodeBlock(code, lang) {
    var wrap = el('div', 'ar-md md-body');
    var pre = document.createElement('pre');
    var codeEl = document.createElement('code');
    codeEl.className = 'md-code lang-' + (lang || 'txt');
    var MD = App.MD;
    if (MD && MD.highlight) {
      try { codeEl.innerHTML = String(MD.highlight(code, lang)); }
      catch (e) { codeEl.textContent = String(code || ''); }
    } else {
      codeEl.textContent = String(code || '');
    }
    pre.appendChild(codeEl);
    wrap.appendChild(pre);
    return wrap;
  }

  function safeStr(v) { return (v == null) ? '' : String(v); }

  function downloadOne(art) {
    try {
      var blob = new Blob([String(art.content || '')], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = safeFilename(art.name || 'artifact.txt');
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { UI.showError('Download failed: ' + (e && e.message)); }
  }

  function downloadAllZip() {
    var s = STATE();
    var arts = (s && Array.isArray(s.artifacts)) ? s.artifacts : [];
    if (!arts.length) { UI.toast('No artifacts to download'); return; }
    try {
      // dedupe filenames so the zip is valid
      var used = {};
      var files = [];
      for (var i = 0; i < arts.length; i++) {
        var nm = safeFilename(arts[i].name || ('artifact-' + i + '.txt'));
        if (used[nm]) {
          var dot = nm.lastIndexOf('.');
          var base = dot > 0 ? nm.slice(0, dot) : nm;
          var ext = dot > 0 ? nm.slice(dot) : '';
          var k = used[nm];
          while (used[base + '-' + k + ext]) k++;
          used[nm] = k + 1;
          nm = base + '-' + k + ext;
        }
        used[nm] = (used[nm] || 0) + 1;
        files.push({ name: nm, data: utf8Bytes(String(arts[i].content || '')) });
      }
      var zip = makeStoreZip(files);
      var blob = new Blob([zip], { type: 'application/zip' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'neon-works-artifacts-' + Date.now() + '.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      UI.toast('Downloaded ' + files.length + ' artifact(s)');
    } catch (e) { UI.showError('ZIP failed: ' + (e && e.message)); }
  }

  // ---- inline store-only (no-compression) ZIP writer -----------------------
  // CRC32 table.
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
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // fallback manual UTF-8 encode
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return new Uint8Array(out);
  }
  // build a store-only zip from [{name, data:Uint8Array}]
  function makeStoreZip(files) {
    var chunks = [];     // local records
    var central = [];    // central dir records
    var offset = 0;
    function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
    for (var i = 0; i < files.length; i++) {
      var nameBytes = utf8Bytes(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      );
      chunks.push(new Uint8Array(local));
      chunks.push(nameBytes);
      chunks.push(data);
      var cen = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
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
      u16(files.length), u16(files.length),
      u32(centralSize), u32(centralStart), u16(0)
    );
    chunks.push(new Uint8Array(end));
    // concat all chunks
    var total = 0;
    for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var m = 0; m < chunks.length; m++) { out.set(chunks[m], pos); pos += chunks[m].length; }
    return out;
  }

  function safeFilename(name) {
    return String(name || 'file.txt').replace(/[\/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file.txt';
  }
  function byteLen(str) { return utf8Bytes(String(str || '')).length; }
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ===========================================================================
  // ATTENTION badge · COMPLETION chime · NOTIFICATION
  // ===========================================================================
  // setAttentionBadge(n) — reflect attention-needing agent count in the tab title.
  UI.setAttentionBadge = function (n) {
    if (typeof document === 'undefined') return;
    n = Math.max(0, Number(n) || 0);
    try { document.title = (n > 0 ? '(' + n + ') ' : '') + 'NEON//WORKS'; } catch (e) {}
  };

  var _audioCtx = null;
  function getAudioCtx() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!_audioCtx) _audioCtx = new AC();
      if (_audioCtx.state === 'suspended' && _audioCtx.resume) { try { _audioCtx.resume(); } catch (e) {} }
      return _audioCtx;
    } catch (e) { return null; }
  }
  function playChime() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    try {
      var now = ctx.currentTime;
      var tones = [880, 1320]; // two-tone
      for (var i = 0; i < tones.length; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = tones[i];
        var t0 = now + i * 0.12;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.24);
      }
    } catch (e) {}
  }

  function requestNotifyPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default' && Notification.requestPermission) {
        var r = Notification.requestPermission();
        if (r && r.catch) r.catch(function () {});
      }
    } catch (e) {}
  }

  // notifyDone(rootTask) — chime (if enabled), OS notification (if granted),
  // and clear the attention tab badge.
  UI.notifyDone = function (rootTask) {
    var s = STATE();
    var settings = (s && s.settings) || {};
    if (settings.sound !== false) playChime(); // default-on
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        var title = (rootTask && (rootTask.title || rootTask.desc)) ? truncate(rootTask.title || rootTask.desc, 60) : 'Goal complete';
        new Notification('NEON//WORKS — done', { body: title });
      }
    } catch (e) {}
    UI.setAttentionBadge(0);
  };

  // ===========================================================================
  // MINIMAP — overview render + click-to-center
  // ===========================================================================
  UI.drawMinimap = function () {
    var canvas = $('minimap');
    if (!canvas || !canvas.getContext) return;
    var s = STATE();
    var w = WORLD();
    var cfg = CFG();
    if (!s || !s.layout) return;
    var ctx = canvas.getContext('2d');
    var cw = canvas.width, ch = canvas.height;
    var L = s.layout;
    var cols = L.cols || cfg.GRID_COLS || 46;
    var rows = L.rows || cfg.GRID_ROWS || 30;
    var TILE = cfg.TILE || 16;
    var worldW = cols * TILE, worldH = rows * TILE;

    // fit world into canvas with letterboxing
    var pad = 4;
    var scale = Math.min((cw - pad * 2) / worldW, (ch - pad * 2) / worldH);
    if (!(scale > 0)) return;
    var offX = (cw - worldW * scale) / 2;
    var offY = (ch - worldH * scale) / 2;
    var wx = function (x) { return offX + x * scale; };
    var wy = function (y) { return offY + y * scale; };

    var pal = (cfg.palette) || {};
    try {
      ctx.clearRect(0, 0, cw, ch);
      // floor backdrop
      ctx.fillStyle = pal.floor || '#0d1226';
      ctx.fillRect(offX, offY, worldW * scale, worldH * scale);
      ctx.strokeStyle = pal.gridLine || '#1c2b55';
      ctx.lineWidth = 1;
      ctx.strokeRect(offX + 0.5, offY + 0.5, worldW * scale, worldH * scale);

      // furniture bounds
      var furn = L.furniture || [];
      ctx.fillStyle = 'rgba(46,87,184,.55)';
      for (var fi = 0; fi < furn.length; fi++) {
        var f = furn[fi]; if (!f) continue;
        var fx = (f.gx || 0) * TILE, fy = (f.gy || 0) * TILE;
        var fw = (f.w || 1) * TILE, fh = (f.h || 1) * TILE;
        ctx.fillRect(wx(fx), wy(fy), Math.max(1, fw * scale), Math.max(1, fh * scale));
      }

      // agent dots (role colors)
      var agents = s.agents || [];
      for (var ai = 0; ai < agents.length; ai++) {
        var a = agents[ai]; if (!a) continue;
        var ax = (typeof a.x === 'number') ? a.x : (a.gx || 0) * TILE;
        var ay = (typeof a.y === 'number') ? a.y : (a.gy || 0) * TILE;
        var col = a.color || ((ROLES()[a.role] && ROLES()[a.role].color)) || '#9b5cff';
        ctx.fillStyle = col;
        var px = wx(ax), py = wy(ay);
        ctx.beginPath();
        ctx.arc(px, py, (s._followId === a.id) ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
        if (s.selectedAgentId === a.id) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.stroke();
        }
      }

      // viewport rectangle (current camera view)
      if (w && w.screenToWorld) {
        var canvasEl = $('world-canvas');
        var vw = canvasEl ? (canvasEl.clientWidth || canvasEl.width) : 0;
        var vh = canvasEl ? (canvasEl.clientHeight || canvasEl.height) : 0;
        var tl = w.screenToWorld(0, 0);
        var br = w.screenToWorld(vw, vh);
        if (tl && br) {
          ctx.strokeStyle = pal.cyan || '#39d7ff';
          ctx.lineWidth = 1;
          ctx.strokeRect(wx(tl.x) + 0.5, wy(tl.y) + 0.5,
            Math.max(2, (br.x - tl.x) * scale), Math.max(2, (br.y - tl.y) * scale));
        }
      }
    } catch (e) {}
  };

  UI.onMinimapPointerDown = function (e) {
    var canvas = $('minimap');
    var s = STATE();
    var w = WORLD();
    var cfg = CFG();
    if (!canvas || !s || !s.layout) return;
    var L = s.layout;
    var cols = L.cols || cfg.GRID_COLS || 46;
    var rows = L.rows || cfg.GRID_ROWS || 30;
    var TILE = cfg.TILE || 16;
    var worldW = cols * TILE, worldH = rows * TILE;
    var cw = canvas.width, ch = canvas.height;
    var pad = 4;
    var scale = Math.min((cw - pad * 2) / worldW, (ch - pad * 2) / worldH);
    if (!(scale > 0)) return;
    var offX = (cw - worldW * scale) / 2;
    var offY = (ch - worldH * scale) / 2;

    var rect = canvas.getBoundingClientRect();
    // account for CSS-vs-buffer scaling
    var sx = (e.clientX - rect.left) * (cw / (rect.width || cw));
    var sy = (e.clientY - rect.top) * (ch / (rect.height || ch));
    var worldX = (sx - offX) / scale;
    var worldY = (sy - offY) / scale;

    // center camera on that world point
    if (s.camera) {
      s._followId = null; // a manual minimap jump cancels follow
      var canvasEl = $('world-canvas');
      var vw = canvasEl ? (canvasEl.clientWidth || canvasEl.width) : 0;
      var vh = canvasEl ? (canvasEl.clientHeight || canvasEl.height) : 0;
      var pps = (cfg.PIXEL || 3) * s.camera.zoom;
      s.camera.x = worldX - (vw / 2) / pps;
      s.camera.y = worldY - (vh / 2) / pps;
      if (w && w.clampCamera) w.clampCamera();
    }
  };

  // ===========================================================================
  // WAVE A — shared lightweight modal mounter
  // ===========================================================================
  // mountModal(id, title) -> { modal, body, foot, close } or null. Reuses the
  // existing .modal/.modal-card chrome and #modal-root mount used by results/
  // artifacts. Scrim + ✕ close the modal. Idempotent (removes a prior instance).
  function mountModal(id, title) {
    var root = $('modal-root');
    if (!root) return null;
    var prev = $(id);
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var modal = el('div', 'modal');
    modal.id = id;
    var scrim = el('div', 'modal-scrim');
    var close = function () { if (modal.parentNode) modal.parentNode.removeChild(modal); };
    on(scrim, 'click', close);

    var card = el('div', 'modal-card');
    card.appendChild(el('div', 'panel-accent'));
    var head = el('header', 'modal-head');
    head.appendChild(el('h2', 'modal-title', title || ''));
    var x = el('button', 'panel-x', '✕'); x.type = 'button';
    on(x, 'click', close);
    head.appendChild(x);

    var body = el('div', 'modal-body');
    var foot = el('footer', 'modal-foot');

    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    modal.appendChild(scrim); modal.appendChild(card);
    root.appendChild(modal);
    return { modal: modal, body: body, foot: foot, close: close };
  }

  // ===========================================================================
  // HUMAN APPROVAL GATE (Wave B/C)
  // openApproval(payload) -> Promise<'approve' | 'revise:<text>' | 'reject'>
  // payload: { title?, goal?, content?, agent? }. Reuses modal scaffolding.
  // Resolves exactly once; closing via scrim/✕ resolves to 'reject'.
  // ===========================================================================
  UI.openApproval = function (payload) {
    payload = payload || {};
    return new Promise(function (resolve) {
      var m = mountModal('modal-approval', T('approval.title', '✓ APPROVAL NEEDED'));
      if (!m) { resolve('approve'); return; } // fail-open: don't block the pipeline
      var settled = false;
      var done = function (val) {
        if (settled) return;
        settled = true;
        try { m.close(); } catch (e) {}
        resolve(val);
      };
      // ✕ / scrim close => reject (override mountModal's plain close)
      var scrim = m.modal.querySelector('.modal-scrim');
      if (scrim) { scrim.onclick = null; on(scrim, 'click', function () { done('reject'); }); }
      var xBtn = m.modal.querySelector('.panel-x');
      if (xBtn) { xBtn.onclick = null; on(xBtn, 'click', function () { done('reject'); }); }

      var body = m.body;
      if (payload.goal) {
        var gl = el('div', 'approval-goal');
        gl.appendChild(el('div', 'pe-key', T('approval.goal', 'Goal')));
        gl.appendChild(el('div', 'pe-val', String(payload.goal)));
        body.appendChild(gl);
      }
      if (payload.agent) {
        body.appendChild(el('div', 'approval-meta', T('approval.from', 'From') + ': ' + String(payload.agent)));
      }
      var contentWrap = el('div', 'approval-content');
      var content = String(payload.content || payload.results || '');
      try {
        if (App.MD && App.MD.render) { contentWrap.innerHTML = App.MD.render(content); contentWrap.classList.add('md-body'); }
        else contentWrap.textContent = content;
      } catch (e) { contentWrap.textContent = content; }
      body.appendChild(contentWrap);

      var revLabel = el('label', 'field');
      revLabel.appendChild(el('span', 'field-label', T('approval.reviseLabel', 'Revision notes (optional)')));
      var rev = document.createElement('textarea');
      rev.id = 'approval-revise';
      rev.rows = 2;
      rev.spellcheck = false;
      rev.placeholder = T('approval.revisePlaceholder', 'What should change? Leave blank to just approve…');
      revLabel.appendChild(rev);
      body.appendChild(revLabel);

      var rejectBtn = el('button', 'btn btn-danger', T('btn.reject', 'Reject'));
      rejectBtn.type = 'button';
      on(rejectBtn, 'click', function () { done('reject'); });
      var reviseBtn = el('button', 'btn', T('btn.revise', 'Request changes'));
      reviseBtn.type = 'button';
      on(reviseBtn, 'click', function () {
        var txt = (rev.value || '').trim();
        if (!txt) { rev.focus(); UI.toast(T('approval.needNotes', 'Add revision notes, or Approve / Reject')); return; }
        done('revise:' + txt);
      });
      var approveBtn = el('button', 'btn btn-primary', T('btn.approve', 'Approve'));
      approveBtn.type = 'button';
      on(approveBtn, 'click', function () { done('approve'); });
      m.foot.appendChild(rejectBtn);
      m.foot.appendChild(reviseBtn);
      m.foot.appendChild(approveBtn);

      applyI18n(m.modal);
      try { approveBtn.focus(); } catch (e) {}
    });
  };

  // ===========================================================================
  // WAVE A — PRESET PICKER ("New Company")
  // ===========================================================================
  UI.openPresets = function () {
    var m = mountModal('modal-presets', '🏢 START A COMPANY');
    if (!m) { UI.toast('Presets unavailable'); return; }

    var presets = (CFG().PRESETS) || [];
    var list = el('div', 'preset-list');
    if (!presets.length) {
      list.appendChild(el('div', 'cost-empty', 'No presets configured.'));
    }
    for (var i = 0; i < presets.length; i++) {
      (function (p) {
        var card = el('button', 'preset-card'); card.type = 'button';
        card.appendChild(el('span', 'preset-ico', p.icon || '🏢'));
        var text = el('div', 'preset-text');
        text.appendChild(el('div', 'preset-name', p.name || p.id || 'Preset'));
        if (p.desc) text.appendChild(el('div', 'preset-desc', p.desc));
        var roster = Array.isArray(p.agents)
          ? p.agents.map(function (a) { return a && a.name ? a.name : (a && a.role) || '?'; }).join(' · ')
          : '';
        if (roster) text.appendChild(el('div', 'preset-roster', '▸ ' + roster));
        card.appendChild(text);
        on(card, 'click', function () { applyPresetWithConfirm(p, m.close); });
        list.appendChild(card);
      })(presets[i]);
    }
    m.body.appendChild(list);

    var note = el('div', 'cost-note',
      'Replaces the current crew with this roster (your office layout & artifacts are kept).');
    m.body.appendChild(note);

    var close = el('button', 'btn btn-primary', 'Cancel');
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);
  };

  function applyPresetWithConfirm(preset, closeModal) {
    if (!preset) return;
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Replace the current crew with the "' + (preset.name || preset.id) +
          '" roster? Tasks will be cleared (office layout is kept).')) return;
    var ok = false;
    try {
      if (App.Store && App.Store.applyPreset) ok = App.Store.applyPreset(preset.id);
    } catch (e) { ok = false; }
    if (!ok) { UI.showError('Could not apply preset'); return; }

    if (typeof closeModal === 'function') closeModal();
    UI.closeAgentPanel();
    UI.refresh();
    UI.refreshArtifacts();
    UI.toast('Company set up: ' + (preset.name || preset.id), 'ok');

    // offer to drop a sample goal into the boss input
    var goals = Array.isArray(preset.sampleGoals) ? preset.sampleGoals : [];
    if (goals.length) {
      var goal = goals[0];
      var ins = (typeof window !== 'undefined' && window.confirm)
        ? window.confirm('Insert a sample goal into the Boss input?\n\n' + truncate(goal, 160))
        : false;
      if (ins) {
        var hud = $('hud-task-input');
        if (hud) { hud.value = goal; try { hud.focus(); } catch (e) {} }
        var board = $('board-input');
        if (board) board.value = goal;
        UI.toast('Sample goal ready — press DISPATCH');
      }
    }
  }

  // ===========================================================================
  // WAVE A — SESSIONS PANEL (named project snapshots)
  // ===========================================================================
  UI.openSessions = function () {
    var m = mountModal('modal-sessions', '🗂 SESSIONS');
    if (!m) { UI.toast('Sessions unavailable'); return; }

    // toolbar: Save current as… · New
    var toolbar = el('div', 'session-toolbar');
    var saveBtn = el('button', 'btn btn-primary', '⤓ Save current as…');
    saveBtn.type = 'button';
    on(saveBtn, 'click', function () { saveSessionAs(m); });
    var newBtn = el('button', 'btn', '✦ New / seed');
    newBtn.type = 'button';
    on(newBtn, 'click', function () { newSession(m.close); });
    toolbar.appendChild(saveBtn); toolbar.appendChild(newBtn);
    m.body.appendChild(toolbar);

    var listWrap = el('div', 'session-list'); listWrap.id = 'session-list';
    m.body.appendChild(listWrap);
    renderSessionList();

    var close = el('button', 'btn btn-primary', 'Close');
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);
  };

  function renderSessionList() {
    var wrap = $('session-list');
    if (!wrap) return;
    clear(wrap);
    var sessions = [];
    try { if (App.Store && App.Store.listSessions) sessions = App.Store.listSessions() || []; } catch (e) { sessions = []; }
    if (!sessions.length) {
      wrap.appendChild(el('div', 'cost-empty', 'No saved sessions yet. Save the current company above.'));
      return;
    }
    for (var i = 0; i < sessions.length; i++) {
      (function (sess) {
        var row = el('div', 'session-row');
        var main = el('div', 'session-main');
        main.appendChild(el('div', 'session-name', sess.name || '(unnamed)'));
        var bits = [];
        if (sess.savedAt) bits.push(formatWhen(sess.savedAt));
        bits.push((sess.agentCount || 0) + ' agents');
        bits.push((sess.taskCount || 0) + ' tasks');
        bits.push((sess.artifactCount || 0) + ' artifacts');
        main.appendChild(el('div', 'session-meta', bits.join(' · ')));
        row.appendChild(main);

        var actions = el('div', 'session-actions');
        var load = el('button', 'btn btn-primary', 'Load'); load.type = 'button';
        on(load, 'click', function () { loadSession(sess.id); });
        var del = el('button', 'btn btn-danger', 'Del'); del.type = 'button';
        on(del, 'click', function () { deleteSession(sess); });
        actions.appendChild(load); actions.appendChild(del);
        row.appendChild(actions);
        wrap.appendChild(row);
      })(sessions[i]);
    }
  }

  function saveSessionAs(m) {
    if (typeof window === 'undefined' || !window.prompt) { UI.showError('Cannot prompt for a name'); return; }
    var def = 'Company ' + new Date().toLocaleDateString();
    var name = window.prompt('Save current company as:', def);
    if (name == null) return;
    name = String(name).trim();
    if (!name) { UI.toast('Name required'); return; }
    var id = null;
    try { if (App.Store && App.Store.saveSession) id = App.Store.saveSession(name); } catch (e) { id = null; }
    if (id) { UI.toast('Saved session "' + name + '"', 'ok'); renderSessionList(); }
    else UI.showError('Save failed');
  }

  function loadSession(id) {
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Load this session? Unsaved changes to the current company will be lost.')) return;
    var ok = false;
    try { if (App.Store && App.Store.loadSession) ok = App.Store.loadSession(id); } catch (e) { ok = false; }
    if (ok) {
      var m = $('modal-sessions'); if (m && m.parentNode) m.parentNode.removeChild(m);
      UI.closeAgentPanel();
      UI.refresh();
      UI.refreshArtifacts();
      UI.toast('Session loaded', 'ok');
    } else UI.showError('Load failed');
  }

  function deleteSession(sess) {
    if (!sess) return;
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Delete session "' + (sess.name || sess.id) + '"? This cannot be undone.')) return;
    try { if (App.Store && App.Store.deleteSession) App.Store.deleteSession(sess.id); } catch (e) {}
    renderSessionList();
    UI.toast('Session deleted');
  }

  function newSession(closeModal) {
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm('Start a fresh company? The current one is cleared and re-seeded (save it first if you want to keep it).')) return;
    try { if (App.Store && App.Store.clear) App.Store.clear(); } catch (e) {}
    if (typeof closeModal === 'function') closeModal();
    UI.closeAgentPanel();
    UI.refresh();
    UI.refreshArtifacts();
    UI.toast('Fresh company seeded', 'ok');
  }

  function formatWhen(t) {
    try {
      var d = new Date(t);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // ===========================================================================
  // WAVE A — COST METER (running session spend)
  // ===========================================================================
  function priceFor(modelId) {
    var cfg = CFG();
    if (cfg.priceFor) {
      try { var p = cfg.priceFor(modelId); if (p) return { in: Number(p.in) || 0, out: Number(p.out) || 0 }; } catch (e) {}
    }
    var tbl = cfg.PRICES || {};
    var e2 = tbl[modelId];
    return e2 ? { in: Number(e2.in) || 0, out: Number(e2.out) || 0 } : { in: 0, out: 0 };
  }

  // computeCost() -> { total, byAgent:[{name,model,tokensIn,tokensOut,cost,color}], byModel:{} }
  function computeCost() {
    var s = STATE();
    var agents = (s && Array.isArray(s.agents)) ? s.agents : [];
    var total = 0;
    var byAgent = [];
    var byModel = {};
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a) continue;
      var stats = a.stats || {};
      var tin = Number(stats.tokensIn) || 0;
      var tout = Number(stats.tokensOut) || 0;
      var pr = priceFor(a.model);
      var cost = (tin / 1e6) * pr.in + (tout / 1e6) * pr.out;
      total += cost;
      byAgent.push({
        name: a.name || a.id, model: a.model || '?',
        tokensIn: tin, tokensOut: tout, cost: cost, color: a.color || null,
      });
      var mk = a.model || '?';
      var mm = byModel[mk] || (byModel[mk] = { model: mk, tokensIn: 0, tokensOut: 0, cost: 0 });
      mm.tokensIn += tin; mm.tokensOut += tout; mm.cost += cost;
    }
    return { total: total, byAgent: byAgent, byModel: byModel };
  }

  function fmtUSD(n) {
    n = Number(n) || 0;
    if (n > 0 && n < 0.0001) return '$<0.0001';
    return '$' + n.toFixed(4);
  }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function refreshCostMeter() {
    var amt = $('cost-meter-amount');
    if (!amt) return;
    try {
      var c = computeCost();
      amt.textContent = c.total.toFixed(4);
      var btn = $('btn-cost-meter');
      if (btn) btn.title = 'Running session cost: ' + fmtUSD(c.total) + ' — click for breakdown';
    } catch (e) {}
  }

  UI.openCostBreakdown = function () {
    var m = mountModal('modal-cost', '$ SESSION COST');
    if (!m) { UI.toast('Cost meter unavailable'); return; }
    var c = computeCost();

    // total banner
    var banner = el('div', 'result-goal',
      'Total this session: ' + fmtUSD(c.total) + '  (estimated from token usage × model price)');
    m.body.appendChild(banner);

    // per-agent table
    if (!c.byAgent.length) {
      m.body.appendChild(el('div', 'cost-empty', 'No agents yet — no spend to report.'));
    } else {
      m.body.appendChild(buildCostTable('PER AGENT', ['Agent', 'Model', 'In', 'Out', 'Cost'],
        c.byAgent.map(function (r) {
          return { cells: [r.name, shortModel(r.model), fmtTokens(r.tokensIn), fmtTokens(r.tokensOut), fmtUSD(r.cost)], color: r.color };
        }), c.total));

      // per-model rollup
      var modelRows = [];
      for (var k in c.byModel) {
        if (!Object.prototype.hasOwnProperty.call(c.byModel, k)) continue;
        var mm = c.byModel[k];
        modelRows.push({ cells: [shortModel(mm.model), '', fmtTokens(mm.tokensIn), fmtTokens(mm.tokensOut), fmtUSD(mm.cost)], color: null });
      }
      m.body.appendChild(buildCostTable('PER MODEL', ['Model', '', 'In', 'Out', 'Cost'], modelRows, c.total));
    }

    var note = el('div', 'cost-note',
      'Prices are approximate public list prices (config.PRICES) and editable. Token counts come from each agent’s stats.');
    m.body.appendChild(note);

    var close = el('button', 'btn btn-primary', 'Close');
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);
  };

  function buildCostTable(caption, headers, rows, total) {
    var wrap = el('div');
    wrap.style.marginTop = '14px';
    wrap.appendChild(el('div', 'field-label', caption));
    var table = el('table', 'cost-table');
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    for (var h = 0; h < headers.length; h++) {
      var th = document.createElement('th');
      th.textContent = headers[h];
      htr.appendChild(th);
    }
    thead.appendChild(htr); table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < rows.length; i++) {
      var tr = document.createElement('tr');
      var cells = rows[i].cells || [];
      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement('td');
        if (c === cells.length - 1) td.className = 'cost-val';
        td.textContent = String(cells[c]);
        if (c === 0 && rows[i].color) td.style.color = rows[i].color;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    var tfoot = document.createElement('tfoot');
    var ftr = document.createElement('tr');
    var fl = document.createElement('td');
    fl.setAttribute('colspan', String(Math.max(1, headers.length - 1)));
    fl.textContent = 'TOTAL';
    var fv = document.createElement('td');
    fv.textContent = fmtUSD(total);
    ftr.appendChild(fl); ftr.appendChild(fv);
    tfoot.appendChild(ftr); table.appendChild(tfoot);

    wrap.appendChild(table);
    return wrap;
  }

  // ===========================================================================
  // v5 — PROJECT FILE WORKSPACE  (explorer · view/edit · run · zip · github)
  // The deliverable lives in App.state.files via App.Workspace. This panel lets
  // the user browse the file tree, view a file (App.MD render), edit + save,
  // ask an agent to revise it, add/delete files, RUN the project in a sandboxed
  // iframe, download a .zip, and push to GitHub. All Workspace calls are guarded.
  // ===========================================================================
  function WS() { return App.Workspace; }

  function fileCount() {
    try {
      var ws = WS();
      if (ws && ws.list) return ws.list().length;
      var s = STATE();
      var f = s && s.files;
      return (f && typeof f === 'object') ? Object.keys(f).length : 0;
    } catch (e) { return 0; }
  }

  // refreshFiles() — keep the Files HUD badge current; if the Files panel is open,
  // re-render its tree + (if a file is selected) its viewer.
  var _fileSel = null;      // path of the currently-viewed file
  var _fileSource = false;  // html: show source vs live preview toggle
  var _fileCollapsed = {};  // folderPath -> true when collapsed
  UI.refreshFiles = function () {
    var n = fileCount();
    var badge = $('files-badge');
    if (badge) {
      badge.textContent = String(n);
      if (n > 0) show(badge); else hide(badge);
    }
    if ($('modal-files')) {
      renderFileTree();
      if (_fileSel) {
        // re-view only if the selected file still exists
        var c = (WS() && WS().read) ? WS().read(_fileSel) : null;
        if (c == null) { _fileSel = null; hideFileViewer(); }
        else viewFile(_fileSel, true);
      }
    }
  };

  UI.openFiles = function () {
    var m = mountModal('modal-files', '📁 ' + T('files.title', 'PROJECT FILES'));
    if (!m) { UI.toast('Files unavailable'); return; }
    m.modal.classList.add('modal-files-wide');

    var bar = el('div', 'files-toolbar');
    var addBtn = el('button', 'btn', '＋ ' + T('files.add', 'New file'));
    addBtn.type = 'button';
    on(addBtn, 'click', function () { addFilePrompt(); });
    var runBtn = el('button', 'btn', '▶ ' + T('files.run', 'Run'));
    runBtn.type = 'button';
    on(runBtn, 'click', function () { UI.runPreview(); });
    var zipBtn = el('button', 'btn', '⤓ ' + T('files.zip', 'Download .zip'));
    zipBtn.type = 'button';
    on(zipBtn, 'click', function () { downloadProjectZip(); });
    var ghBtn = el('button', 'btn', '⇪ ' + T('files.push', 'Push to GitHub'));
    ghBtn.type = 'button';
    on(ghBtn, 'click', function () { pushToGithub(); });
    bar.appendChild(addBtn); bar.appendChild(runBtn); bar.appendChild(zipBtn); bar.appendChild(ghBtn);
    m.body.appendChild(bar);

    var split = el('div', 'files-split');
    var treeWrap = el('div', 'files-tree'); treeWrap.id = 'files-tree';
    var viewWrap = el('div', 'files-view'); viewWrap.id = 'files-view';
    split.appendChild(treeWrap); split.appendChild(viewWrap);
    m.body.appendChild(split);

    var close = el('button', 'btn btn-primary', T('btn.close', 'Close'));
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);

    renderFileTree();
    if (_fileSel && WS() && WS().read && WS().read(_fileSel) != null) viewFile(_fileSel, true);
    else hideFileViewer();
    applyI18n(m.modal);
  };

  function renderFileTree() {
    var host = $('files-tree');
    if (!host) return;
    clear(host);
    var tree = null;
    try { if (WS() && WS().tree) tree = WS().tree(); } catch (e) { tree = null; }
    var hasFiles = fileCount() > 0;
    if (!hasFiles || !tree) {
      host.appendChild(el('div', 'files-empty',
        T('files.empty', 'No project files yet. Press 🔨 Build with a goal, or add a file.')));
      return;
    }
    var rootChildren = (tree && Array.isArray(tree.children)) ? tree.children : [];
    var ul = el('div', 'ft-root');
    for (var i = 0; i < rootChildren.length; i++) renderTreeNode(ul, rootChildren[i], 0);
    host.appendChild(ul);
  }

  function renderTreeNode(parent, node, depth) {
    if (!node) return;
    if (node.dir) {
      var folderRow = el('div', 'ft-row ft-dir');
      folderRow.style.paddingLeft = (8 + depth * 14) + 'px';
      var collapsed = !!_fileCollapsed[node.path];
      var caret = el('span', 'ft-caret', collapsed ? '▸' : '▾');
      folderRow.appendChild(caret);
      folderRow.appendChild(el('span', 'ft-ico', '📁'));
      folderRow.appendChild(el('span', 'ft-name', node.name || node.path));
      on(folderRow, 'click', function () {
        _fileCollapsed[node.path] = !_fileCollapsed[node.path];
        renderFileTree();
      });
      parent.appendChild(folderRow);
      if (!collapsed) {
        var kids = Array.isArray(node.children) ? node.children : [];
        for (var i = 0; i < kids.length; i++) renderTreeNode(parent, kids[i], depth + 1);
      }
    } else {
      var row = el('div', 'ft-row ft-file');
      if (_fileSel === node.path) row.classList.add('active');
      row.style.paddingLeft = (8 + depth * 14 + 14) + 'px';
      row.appendChild(el('span', 'ft-ico', fileGlyph(node.lang, node.name)));
      row.appendChild(el('span', 'ft-name', node.name || node.path));
      on(row, 'click', function () { viewFile(node.path); });
      parent.appendChild(row);
    }
  }

  function fileGlyph(lang, name) {
    var l = lang || langFromName(name);
    switch (l) {
      case 'html': return '🌐';
      case 'css': return '🎨';
      case 'js': return '⚡';
      case 'json': return '{}';
      case 'md': return '📄';
      case 'py': return '🐍';
      default: return '📃';
    }
  }

  function hideFileViewer() {
    var v = $('files-view');
    if (!v) return;
    clear(v);
    v.appendChild(el('div', 'files-empty', T('files.pick', 'Select a file to view or edit.')));
  }

  // viewFile(path, keepEdits) — render the file with App.MD (code highlight, md
  // render, html preview/source toggle) + an EDIT textarea with Save / Revise /
  // Delete. keepEdits=true is used on background refresh to avoid clobbering an
  // in-progress edit if the textarea is focused.
  function viewFile(path, fromRefresh) {
    var ws = WS();
    var content = (ws && ws.read) ? ws.read(path) : null;
    if (content == null) { _fileSel = null; hideFileViewer(); renderFileTree(); return; }
    // Don't clobber an active edit during a background refresh.
    if (fromRefresh) {
      var ta0 = $('file-edit-area');
      if (ta0 && document.activeElement === ta0) return;
    }
    _fileSel = path;
    var v = $('files-view');
    if (!v) return;
    clear(v);

    var meta = (ws && ws.list) ? findFileMeta(path) : null;
    var lang = (meta && meta.lang) || (ws && ws.detectLang ? ws.detectLang(path) : langFromName(path));

    // header
    var head = el('div', 'fv-head');
    head.appendChild(el('span', 'fv-path', path));
    if (meta && meta.updatedBy) head.appendChild(el('span', 'fv-by', '✎ ' + meta.updatedBy));
    v.appendChild(head);

    // preview body (rendered)
    var preview = el('div', 'fv-preview'); preview.id = 'file-preview';
    v.appendChild(preview);
    renderFilePreview(preview, path, content, lang);

    // edit row
    var editWrap = el('div', 'fv-edit');
    var ta = document.createElement('textarea');
    ta.id = 'file-edit-area';
    ta.className = 'fv-edit-area';
    ta.spellcheck = false;
    ta.value = content;
    editWrap.appendChild(ta);

    var actions = el('div', 'fv-actions');
    var saveBtn = el('button', 'btn btn-primary', T('files.save', 'Save'));
    saveBtn.type = 'button';
    on(saveBtn, 'click', function () { saveFileEdit(path); });
    var reviseBtn = el('button', 'btn', T('files.revise', 'Revise with agent'));
    reviseBtn.type = 'button';
    on(reviseBtn, 'click', function () { reviseFileWithAgent(path); });
    var copyBtn = el('button', 'btn btn-sq', '⧉'); copyBtn.type = 'button'; copyBtn.title = T('btn.copy', 'Copy');
    on(copyBtn, 'click', function () {
      try { if (navigator.clipboard) navigator.clipboard.writeText(ta.value || ''); UI.toast(T('files.copied', 'Copied')); } catch (e) {}
    });
    var delBtn = el('button', 'btn btn-danger', T('files.delete', 'Delete'));
    delBtn.type = 'button';
    on(delBtn, 'click', function () { deleteFile(path); });
    actions.appendChild(saveBtn); actions.appendChild(reviseBtn); actions.appendChild(copyBtn); actions.appendChild(delBtn);
    editWrap.appendChild(actions);
    v.appendChild(editWrap);

    renderFileTree(); // re-mark active row
    applyI18n(v);
  }

  function findFileMeta(path) {
    try {
      var list = (WS() && WS().list) ? WS().list() : [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].path === path) return list[i];
    } catch (e) {}
    return null;
  }

  function renderFilePreview(host, path, content, lang) {
    clear(host);
    var MD = App.MD;
    if (lang === 'html') {
      var modes = el('div', 'ar-preview-modes');
      var bPrev = el('button', 'ar-mode-btn' + (_fileSource ? '' : ' active'), T('files.preview', 'Preview'));
      bPrev.type = 'button';
      var bSrc = el('button', 'ar-mode-btn' + (_fileSource ? ' active' : ''), T('files.source', 'Source'));
      bSrc.type = 'button';
      on(bPrev, 'click', function () { if (_fileSource) { _fileSource = false; renderFilePreview(host, path, latest(path, content), lang); } });
      on(bSrc, 'click', function () { if (!_fileSource) { _fileSource = true; renderFilePreview(host, path, latest(path, content), lang); } });
      modes.appendChild(bPrev); modes.appendChild(bSrc);
      host.appendChild(modes);
      if (_fileSource) {
        host.appendChild(buildCodeBlock(content, 'html'));
      } else {
        // Live preview inlines local assets so the single file actually renders.
        var iframe = document.createElement('iframe');
        iframe.className = 'ar-iframe fv-iframe';
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('title', path);
        // The entry html (index.html) previews the WHOLE project (assets inlined);
        // any other html previews its own content so you see the file you clicked.
        var isEntry = /(^|\/)index\.html$/i.test(path);
        var assembled = null;
        if (isEntry) { try { if (WS() && WS().assembleRunnable) assembled = WS().assembleRunnable(); } catch (e) { assembled = null; } }
        var doc = assembled || content;
        iframe.setAttribute('srcdoc', safeStr(doc));
        host.appendChild(iframe);
      }
    } else if (lang === 'md') {
      var md = el('div', 'ar-md md-body');
      if (MD && MD.render) { try { md.innerHTML = String(MD.render(content)); } catch (e) { md.textContent = content; } }
      else md.textContent = content;
      host.appendChild(md);
    } else {
      host.appendChild(buildCodeBlock(content, lang || langFromName(path)));
    }
  }

  // read the freshest content for a path (used when toggling html preview/source).
  function latest(path, fallback) {
    try { var c = (WS() && WS().read) ? WS().read(path) : null; if (c != null) return c; } catch (e) {}
    return fallback;
  }

  function saveFileEdit(path) {
    var ta = $('file-edit-area');
    if (!ta) return;
    var content = ta.value;
    try {
      if (WS() && WS().write) WS().write(path, content, 'user');
      else { var s = STATE(); if (s) { s.files = s.files || {}; s.files[path] = { content: String(content), lang: langFromName(path), updatedBy: 'user', t: Date.now() }; } }
    } catch (e) { UI.showError('Save failed: ' + (e && e.message)); return; }
    if (App.Store && App.Store.save) App.Store.save();
    UI.toast(T('files.saved', 'Saved ') + path);
    // re-render the rendered preview from the saved content
    var preview = $('file-preview');
    if (preview) {
      var lang = (WS() && WS().detectLang) ? WS().detectLang(path) : langFromName(path);
      renderFilePreview(preview, path, content, lang);
    }
    UI.refreshFiles();
  }

  function reviseFileWithAgent(path) {
    var ta = $('file-edit-area');
    var current = ta ? ta.value : (latest(path, ''));
    if (typeof window === 'undefined' || !window.prompt) { UI.showError('Cannot prompt for instructions'); return; }
    var instr = window.prompt(T('files.reviseAsk', 'How should the agent revise ' + path + '?'), '');
    if (instr == null) return;
    instr = String(instr).trim();
    if (!instr) return;

    // Pick an agent: prefer an idle non-boss agent, else any non-boss, else first.
    var a = pickReviseAgent();
    if (!a || !(AGENTS() && AGENTS().chat)) { UI.showError(T('files.noAgent', 'No agent available to revise')); return; }

    var lang = (WS() && WS().detectLang) ? WS().detectLang(path) : langFromName(path);
    var msg =
      'Revise the project file "' + path + '". Apply this instruction: ' + instr + '\n\n' +
      'Current content of ' + path + ':\n' +
      '```' + (lang || '') + '\n' + current + '\n```\n\n' +
      'Output ONLY the complete updated file as a fenced block:\n' +
      '```file:' + path + '\n<the full revised file>\n```\n' +
      'No prose outside the block.';

    UI.toast(T('files.revising', 'Asking ') + a.name + '…');
    try {
      // Agents.chat returns a stream handle (not a Promise); the result only lands
      // in its onDone, so drive the write-back from the completion callback.
      AGENTS().chat(a, msg, { onComplete: function (reply) { applyReviseReply(path, reply, a); } });
    } catch (e) { UI.showError('Revise failed: ' + (e && e.message)); }
  }

  function pickReviseAgent() {
    var s = STATE();
    var agents = (s && Array.isArray(s.agents)) ? s.agents : [];
    var fallback = null;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a || a.role === 'boss') continue;
      if (!fallback) fallback = a;
      if (a.state === 'idle') return a;
    }
    if (fallback) return fallback;
    return agents[0] || null;
  }

  function lastAssistantText(a) {
    var conv = (a && Array.isArray(a.conversation)) ? a.conversation : [];
    for (var i = conv.length - 1; i >= 0; i--) {
      if (conv[i] && conv[i].role === 'assistant') return String(conv[i].content || '');
    }
    return '';
  }

  function applyReviseReply(path, reply, a) {
    reply = String(reply || '');
    var written = 0;
    try {
      if (WS() && WS().parseFileBlocks) {
        var blocks = WS().parseFileBlocks(reply) || [];
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (!b || !b.path) continue;
          if (WS().write) WS().write(b.path, b.content, (a && a.id) || 'agent');
          written++;
        }
      }
    } catch (e) {}
    if (!written) {
      // No fenced file block — treat the whole reply as the file body if non-empty.
      var body = reply.trim();
      if (body && WS() && WS().write) { WS().write(path, body, (a && a.id) || 'agent'); written = 1; }
    }
    if (written) {
      if (App.Store && App.Store.save) App.Store.save();
      UI.toast(T('files.revised', 'Revised ') + path);
      viewFile(path, false);
      UI.refreshFiles();
    } else {
      UI.toast(T('files.noChange', 'Agent returned no file change'));
    }
  }

  function addFilePrompt() {
    if (typeof window === 'undefined' || !window.prompt) { UI.showError('Cannot prompt for a path'); return; }
    var path = window.prompt(T('files.addAsk', 'New file path (e.g. src/app.js):'), '');
    if (path == null) return;
    path = String(path).trim();
    if (!path) return;
    try {
      if (WS() && WS().read && WS().read(path) != null) {
        if (window.confirm && !window.confirm(T('files.overwrite', 'A file at that path exists. Overwrite?'))) {
          viewFile(path); return;
        }
      }
      if (WS() && WS().write) WS().write(path, '', 'user');
    } catch (e) { UI.showError('Could not create file: ' + (e && e.message)); return; }
    if (App.Store && App.Store.save) App.Store.save();
    UI.toast(T('files.added', 'Created ') + path);
    UI.refreshFiles();
    viewFile(path);
  }

  function deleteFile(path) {
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm(T('files.deleteAsk', 'Delete ') + path + '?')) return;
    try {
      if (WS() && WS().remove) WS().remove(path);
      else { var s = STATE(); if (s && s.files) delete s.files[path]; }
    } catch (e) {}
    if (_fileSel === path) { _fileSel = null; hideFileViewer(); }
    if (App.Store && App.Store.save) App.Store.save();
    UI.toast(T('files.deleted', 'Deleted ') + path);
    UI.refreshFiles();
  }

  // ----- RUN PREVIEW -----------------------------------------------------------
  // runPreview() — assemble the project into one self-contained HTML doc and run
  // it in a sandboxed iframe (scripts allowed, no same-origin). Friendly message
  // if there's no html entry. Includes a Reload control.
  UI.runPreview = function () {
    var assembled = null;
    try { if (WS() && WS().assembleRunnable) assembled = WS().assembleRunnable(); } catch (e) { assembled = null; }
    var m = mountModal('modal-run', '▶ ' + T('run.title', 'RUN PREVIEW'));
    if (!m) { UI.toast('Run unavailable'); return; }
    m.modal.classList.add('modal-files-wide');

    if (!assembled) {
      m.body.appendChild(el('div', 'files-empty',
        T('run.noHtml', 'No HTML entry to run. Build a web project (it needs an index.html) or add one in Files.')));
    } else {
      var frame = document.createElement('iframe');
      frame.className = 'run-iframe';
      frame.id = 'run-iframe';
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
      frame.setAttribute('title', T('run.title', 'RUN PREVIEW'));
      frame.setAttribute('srcdoc', safeStr(assembled));
      m.body.appendChild(frame);
    }

    if (assembled) {
      var reload = el('button', 'btn', '⟳ ' + T('run.reload', 'Reload'));
      reload.type = 'button';
      on(reload, 'click', function () {
        var f = $('run-iframe');
        if (!f) return;
        var fresh = null;
        try { if (WS() && WS().assembleRunnable) fresh = WS().assembleRunnable(); } catch (e) {}
        f.setAttribute('srcdoc', safeStr(fresh || assembled));
      });
      m.foot.appendChild(reload);
    }
    var close = el('button', 'btn btn-primary', T('btn.close', 'Close'));
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);
    applyI18n(m.modal);
  };

  // ----- ZIP -------------------------------------------------------------------
  function downloadProjectZip() {
    var blob = null;
    try { if (WS() && WS().buildZip) blob = WS().buildZip(); } catch (e) { blob = null; }
    if (!blob) {
      // fallback: build from the artifacts-style writer over the files map
      try {
        var list = (WS() && WS().list) ? WS().list() : [];
        if (!list.length) { UI.toast(T('files.noneZip', 'No files to download')); return; }
        var files = [];
        for (var i = 0; i < list.length; i++) files.push({ name: safeZipPath(list[i].path), data: utf8Bytes(String(list[i].content || '')) });
        blob = new Blob([makeStoreZip(files)], { type: 'application/zip' });
      } catch (e2) { UI.showError('ZIP failed: ' + (e2 && e2.message)); return; }
    }
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'project.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      UI.toast(T('files.zipped', 'Downloaded project.zip'));
    } catch (e) { UI.showError('Download failed: ' + (e && e.message)); }
  }
  // keep folder separators for zip paths (don't collapse '/').
  function safeZipPath(p) {
    return String(p || 'file.txt').replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+/, '').slice(0, 240) || 'file.txt';
  }

  // ----- GITHUB PUSH -----------------------------------------------------------
  function pushToGithub() {
    var s = STATE();
    var gh = (s && s.settings && s.settings.github) || {};
    if (!gh.token || !gh.owner || !gh.repo) {
      UI.showError(T('gh.needConfig', 'Set GitHub token, owner and repo in Settings first.'));
      UI.openSettings();
      return;
    }
    if (fileCount() === 0) { UI.toast(T('files.nonePush', 'No files to push')); return; }
    if (!(WS() && WS().githubPush)) { UI.showError(T('gh.unavailable', 'GitHub push is unavailable.')); return; }
    if (typeof window !== 'undefined' && window.confirm &&
        !window.confirm(T('gh.confirm', 'Push ' + fileCount() + ' file(s) to ' + gh.owner + '/' + gh.repo + ' (' + (gh.branch || 'main') + ')?'))) return;

    UI.toast(T('gh.pushing', 'Pushing to GitHub…'));
    var p;
    try { p = WS().githubPush(gh); } catch (e) { UI.showError('Push failed: ' + (e && e.message)); return; }
    if (!p || !p.then) { UI.showError('Push failed to start'); return; }
    p.then(function (res) {
      res = res || {};
      if (res.ok === false && res.error) { UI.showError('Push failed: ' + res.error); return; }
      var results = Array.isArray(res.results) ? res.results : [];
      var okN = 0, failN = 0, fails = [];
      for (var i = 0; i < results.length; i++) {
        var st = String(results[i].status || '');
        if (/^(ok|created|updated|2\d\d)$/.test(st) || results[i].ok) okN++;
        else { failN++; fails.push(results[i].path + ': ' + st); }
      }
      if (failN === 0) UI.toast(T('gh.done', 'Pushed ') + okN + ' file(s) to GitHub', 'ok');
      else {
        UI.toast(okN + ' ok · ' + failN + ' failed', 'error');
        showGithubResults(results);
      }
    }).catch(function (e) {
      UI.showError('Push failed: ' + (e && e.message));
    });
  }

  function showGithubResults(results) {
    var m = mountModal('modal-gh-results', '⇪ ' + T('gh.results', 'GITHUB PUSH RESULTS'));
    if (!m) return;
    var list = el('div', 'session-list');
    for (var i = 0; i < results.length; i++) {
      var r = results[i] || {};
      var row = el('div', 'session-row');
      var main = el('div', 'session-main');
      main.appendChild(el('div', 'session-name', r.path || '(file)'));
      main.appendChild(el('div', 'session-meta', String(r.status || (r.ok ? 'ok' : 'error'))));
      row.appendChild(main);
      list.appendChild(row);
    }
    m.body.appendChild(list);
    var close = el('button', 'btn btn-primary', T('btn.close', 'Close'));
    close.type = 'button';
    on(close, 'click', m.close);
    m.foot.appendChild(close);
  }

  // ===========================================================================
  // PUBLISH + §7.10 compat alias
  // ===========================================================================
  App.UI = UI;

  // appendAgentStream(id, delta) → appendTranscript(id,'assistant',delta)
  UI.appendAgentStream = function (id, delta) { UI.appendTranscript(id, 'assistant', delta); };

})();
