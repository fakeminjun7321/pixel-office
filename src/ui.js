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
      on($('btn-add-agent'), 'click', function () { UI.openAddAgent(); });
      on($('btn-settings'), 'click', function () { UI.openSettings(); });
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

      // Global "Coffee break" control (sends all idle non-boss agents on break).
      ensureCoffeeBreakButton();

      // Logo glyph in the HUD.
      drawLogo();

      // (m5) Sync the web-search neon switch with persisted settings on first load,
      // so its .on/aria-checked state matches App.state before Settings is opened.
      setWebSearchSwitch(!!(App.state && App.state.settings && App.state.settings.webSearch));

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
    if (ORCH() && ORCH().runBossTask) {
      ORCH().runBossTask(text);
      UI.openTaskBoard(); // surface the board so the user sees the decomposition
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
    var panel = $('panel-agent');
    show(panel);
    ensureBreakButton();
    refreshSelectedPanel();
    renderTranscript(agentId);
    startPanelPreview();
    UI.refreshAgentList(); // highlight selected row
  };

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
    if (s) s.selectedAgentId = null;
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
    var ctog = $('set-companion-toggle'); if (ctog) ctog.checked = !!settings.useCompanion;
    var curl = $('set-companion-url'); if (curl) curl.value = settings.companionUrl || (CFG().COMPANION_URL || 'http://localhost:8787/v1/messages');
    var dm = $('set-default-model'); if (dm) dm.value = settings.defaultModel || CFG().DEFAULT_MODEL;
    var bm = $('set-boss-model'); if (bm) bm.value = settings.bossModel || CFG().BOSS_MODEL;
    setWebSearchSwitch(!!settings.webSearch);
    show($('modal-settings'));
  };

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
    if (App.Store && App.Store.save) App.Store.save();
    hide($('modal-settings'));
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
  // PUBLISH + §7.10 compat alias
  // ===========================================================================
  App.UI = UI;

  // appendAgentStream(id, delta) → appendTranscript(id,'assistant',delta)
  UI.appendAgentStream = function (id, delta) { UI.appendTranscript(id, 'assistant', delta); };

})();
