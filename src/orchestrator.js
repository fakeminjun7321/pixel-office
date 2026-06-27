// =============================================================================
// orchestrator.js  →  App.Orchestrator
// PIXEL AI COMPANY ("NEON//WORKS") — Boss decompose / delegate / synthesize + queue.
//
// Authority: SPEC.md §6 (ROLES + boss prompts), §6.4 (parsePlan rules), §6.5
//            (task↔state map + choreography), §7.6 (signatures), §10 (errors),
//            §7.10 (compat aliases).
//
// Flow (PINNED):
//   runBossTask(text)
//     → ensure boss; create root Task {role:'boss', status:'running'};
//       boss 'thinking' + "🧠 Planning…"; API.stream(decompose) → parsePlan()||fallback;
//       create child Tasks (queued, parentId=root, push subtaskIds); boss "Delegating N";
//       staggered per-child "@Role: <title>"; tick() runs the children.
//   tick() (each frame)
//     → assign queued tasks to idle role-matching agents (FIFO, dep-gated,
//       MAX_CONCURRENT cap); flip blocked→queued when deps satisfied; when all
//       children terminal → synthesize. Cheap & re-entrant-safe.
//   runWorker(task) → walk-to-desk, coding/searching, API.stream (web tool when
//       enabled), stream to bubble + transcript; finishTask; tick().
//   synthesize(root) → meeting choreography; boss synth call; root done; final result.
//
// Defensive everywhere; no uncaught throws (loop calls tick()). Classic <script>.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  function CFG()    { return App.config || {}; }
  function STATE()  { return App.state; }
  function ROLES()  { return (App.config && App.config.ROLES) || {}; }
  function AGENTS() { return App.Agents; }
  function WORLD()  { return App.World; }

  function uid(p) {
    return (App.util && App.util.uid) ? App.util.uid(p)
      : (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function truncate(s, n) {
    if (App.util && App.util.truncate) return App.util.truncate(s, n);
    s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function firstWords(s, n) {
    if (App.util && App.util.firstWords) return App.util.firstWords(s, n);
    return String(s || '').split(/\s+/).slice(0, n).join(' ');
  }
  function nowMs() { return Date.now(); }

  function log(from, to, kind, text) {
    try {
      if (App.Store && App.Store.pushLog) {
        App.Store.pushLog({ from: from, to: to, kind: kind, text: text });
      }
    } catch (e) {}
  }
  function refreshBoard() {
    try { if (App.UI && App.UI.refreshBoard) App.UI.refreshBoard(); } catch (e) {}
  }
  function saveSoon() {
    try {
      if (App.Store && App.Store.saveDebounced) App.Store.saveDebounced();
      else if (App.Store && App.Store.save) App.Store.save();
    } catch (e) {}
  }

  var Orchestrator = {};
  Orchestrator.PLAN_SCHEMA_VERSION = 1;

  // ===========================================================================
  // TASK lookups
  // ===========================================================================
  function taskById(id) {
    var s = STATE();
    if (!s || !Array.isArray(s.tasks)) return null;
    for (var i = 0; i < s.tasks.length; i++) {
      if (s.tasks[i] && s.tasks[i].id === id) return s.tasks[i];
    }
    return null;
  }
  function childrenOf(rootId) {
    var s = STATE(), out = [];
    if (!s || !Array.isArray(s.tasks)) return out;
    for (var i = 0; i < s.tasks.length; i++) {
      if (s.tasks[i] && s.tasks[i].parentId === rootId) out.push(s.tasks[i]);
    }
    return out;
  }
  function runningCount() {
    var s = STATE(), n = 0;
    if (!s || !Array.isArray(s.tasks)) return 0;
    for (var i = 0; i < s.tasks.length; i++) {
      if (s.tasks[i] && s.tasks[i].status === 'running') n++;
    }
    return n;
  }
  // No work pending or in flight (used for light boss-initiated rest).
  function queueIsEmpty() {
    var s = STATE();
    if (!s || !Array.isArray(s.tasks)) return true;
    for (var i = 0; i < s.tasks.length; i++) {
      var st = s.tasks[i] && s.tasks[i].status;
      if (st === 'queued' || st === 'running' || st === 'blocked') return false;
    }
    return true;
  }

  // ===========================================================================
  // BOSS — ensure / runBossTask
  // ===========================================================================
  function ensureBoss() {
    var ag = AGENTS();
    var s = STATE();
    var existing = ag && ag.byRole ? ag.byRole('boss') : [];
    if (existing && existing.length) return existing[0];
    // Spawn a boss if somehow missing.
    var roleDef = ROLES().boss || {};
    var settings = (s && s.settings) || {};
    return ag.create({
      name: 'Boss', role: 'boss',
      model: settings.bossModel || roleDef.model,
      color: roleDef.color,
      systemPrompt: roleDef.system,
    });
  }

  // runBossTask(text) — decompose the user's high-level goal into child tasks.
  Orchestrator.runBossTask = function (text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return;

    var s = STATE();
    var settings = (s && s.settings) || {};
    var ag = AGENTS();
    var boss = ensureBoss();

    // root task
    var root = {
      id: uid('t'),
      title: truncate(text, 48),
      desc: text,
      assignee: boss ? boss.id : null,
      status: 'running',
      parentId: null,
      subtaskIds: [],
      result: null,
      error: null,
      createdAt: nowMs(),
      role: 'boss',
      needsWeb: false,
      _ctrl: null,
      _plan: null,           // captured plan {plan, final}
      _synthStarted: false,
    };
    s.tasks.push(root);
    log('user', 'Boss', 'msg', truncate(text, 120));
    refreshBoard();

    // No key → fail fast, friendly. (§10)
    if (!settings.apiKey) {
      root.status = 'error';
      root.error = 'NO_KEY';
      if (boss) ag.say(boss, '🔑 set your API key in Settings', 4000);
      try { if (App.UI && App.UI.toast) App.UI.toast('Set your API key in Settings'); } catch (e) {}
      log('Boss', 'system', 'error', 'NO_KEY — cannot plan.');
      refreshBoard();
      return;
    }

    // Boss → thinking; walk to its desk if away.
    if (boss) {
      var startPlanning = function () {
        ag.setState(boss, 'thinking');
        ag.say(boss, '🧠 Planning…', 4000);
        streamDecompose(root, boss, text);
      };
      // walk to desk seat first (best-effort)
      ag.goToFurniture(boss, 'desk', startPlanning);
    } else {
      streamDecompose(root, null, text);
    }
  };

  function streamDecompose(root, boss, userText) {
    var settings = STATE().settings || {};
    var roleDef = ROLES().boss || {};
    var sys = roleDef.system || '';
    var userMsg = 'GOAL:\n' + userText + '\n\nReturn the JSON plan now.';

    var raw = '';
    if (boss) boss.busy = true;   // claim BEFORE stream (onError can fire synchronously on no-key/no-model)
    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,        // GPT-model boss support
      model: (boss && boss.model) || settings.bossModel || CFG().BOSS_MODEL,
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
      // decomposition never needs web search
      onState: function (st) {
        if (boss && st === 'text') ag_set(boss, 'thinking'); // keep thinking pose during plan
      },
      onText: function (d) { raw += d; },
      onDone: function (res) {
        if (boss) { boss.busy = false; }
        var plan = Orchestrator.parsePlan((res && res.text) || raw);
        if (!plan) {
          log('Boss', 'system', 'system', 'Boss plan unreadable — running as a single generalist task.');
          plan = {
            plan: [{
              role: 'generalist', title: 'Handle task',
              instruction: userText, needsWeb: !!settings.webSearch,
            }],
            final: 'Combine all worker results into a single coherent answer for the user.',
          };
        }
        root._plan = plan;
        if (boss && res && res.usage) {
          boss.stats.tokensIn += (res.usage.input_tokens || 0);
          boss.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        createChildTasks(root, plan, boss);
      },
      onError: function (err) {
        if (boss) { boss.busy = false; ag_set(boss, 'idle'); }
        var msg = (err && err.message) || 'error';
        root.status = 'error';
        root.error = msg;
        if (boss) AGENTS().say(boss, '⚠ ' + truncate(msg, 36), 4000);
        log('Boss', 'system', 'error', 'plan error: ' + msg);
        refreshBoard();
        var s = STATE(); if (s && s._activeStreams) delete s._activeStreams['__boss_plan'];
      },
    });
    var s = STATE(); if (s && s._activeStreams) s._activeStreams['__boss_plan'] = handle;
    root._ctrl = handle;
  }

  // small guard wrapper for setState
  function ag_set(agent, st) { try { AGENTS().setState(agent, st); } catch (e) {} }

  function createChildTasks(root, plan, boss) {
    var s = STATE();
    var ag = AGENTS();
    var items = (plan && plan.plan) || [];

    if (boss) {
      ag.setState(boss, 'idle');
      ag.say(boss, 'Delegating ' + items.length + ' task' + (items.length === 1 ? '' : 's'), 3000);
    }

    var stagger = CFG().DELEGATE_STAGGER_MS || 600;
    for (var i = 0; i < items.length; i++) {
      (function (it, idx) {
        var t = {
          id: uid('t'),
          title: truncate(it.title || firstWords(it.instruction, 6), 48),
          desc: String(it.instruction || ''),
          assignee: null,
          status: 'queued',
          parentId: root.id,
          subtaskIds: [],
          result: null,
          error: null,
          createdAt: nowMs() + idx, // preserve order in FIFO sorts
          role: (ROLES()[it.role] ? it.role : 'generalist'),
          needsWeb: (typeof it.needsWeb === 'boolean')
            ? it.needsWeb
            : !!(ROLES()[it.role] && ROLES()[it.role].webSearchPreferred),
          _depIndex: idx, // position in plan (for dependency ordering)
          _ctrl: null,
        };
        s.tasks.push(t);
        root.subtaskIds.push(t.id);

        // staggered delegation bubble from the boss.
        setTimeout(function () {
          var roleLabel = (ROLES()[t.role] && ROLES()[t.role].label) || t.role;
          if (boss) ag.say(boss, '@' + roleLabel + ': ' + t.title, 3000);
          log('Boss', roleLabel, 'msg', '@' + roleLabel + ': ' + t.title);
          refreshBoard();
        }, stagger * idx);
      })(items[i], i);
    }

    refreshBoard();
    saveSoon();
    // tick() (driven by main loop) will assign & run children.
  }

  // ===========================================================================
  // parsePlan(raw) → {plan, final} | null   (SPEC §6.4)
  // ===========================================================================
  Orchestrator.parsePlan = function (raw) {
    try {
      if (!raw || !String(raw).trim()) return null;
      var s = String(raw);

      // 2) strip code fences
      s = s.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/i, '');

      // 3) brace-slice
      var first = s.indexOf('{');
      var last = s.lastIndexOf('}');
      if (first === -1 || last === -1 || last < first) return null;
      var body = s.slice(first, last + 1);

      // 4) forgiving cleanup
      body = body.replace(/,(\s*[}\]])/g, '$1');     // trailing commas
      body = body.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); // smart quotes

      // 5) parse; on failure try brace-balanced prefix
      var obj = null;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        var bal = braceBalancedPrefix(body);
        if (bal) { try { obj = JSON.parse(bal); } catch (e2) { obj = null; } }
      }
      if (!obj || typeof obj !== 'object') return null;

      // 6) validate
      if (!Array.isArray(obj.plan) || obj.plan.length === 0) return null;
      var roles = ROLES();
      var out = [];
      for (var i = 0; i < obj.plan.length; i++) {
        var it = obj.plan[i];
        if (!it || typeof it !== 'object') continue;
        if (it.instruction == null || String(it.instruction).trim() === '') continue;
        var role = (it.role && roles[it.role]) ? it.role : 'generalist';
        var instruction = String(it.instruction);
        var title = String(it.title || firstWords(instruction, 6)).slice(0, 48);
        var needsWeb = (typeof it.needsWeb === 'boolean')
          ? it.needsWeb
          : !!(roles[role] && roles[role].webSearchPreferred);
        out.push({ role: role, title: title, instruction: instruction, needsWeb: needsWeb });
        if (out.length >= 5) break;
      }
      if (out.length === 0) return null;

      var final = (typeof obj.final === 'string' && obj.final.trim())
        ? obj.final
        : 'Combine all worker results into a single coherent answer for the user.';

      return { plan: out, final: final };
    } catch (e) {
      return null;
    }
  };

  // Best-effort: return the largest balanced {...} prefix of a string.
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

  // ===========================================================================
  // enqueueTask(spec) → Task   (standalone manual queue or programmatic)
  // ===========================================================================
  Orchestrator.enqueueTask = function (spec) {
    spec = spec || {};
    var s = STATE();
    var role = (ROLES()[spec.role]) ? spec.role : 'generalist';
    var t = {
      id: uid('t'),
      title: truncate(spec.title || firstWords(spec.desc, 6) || 'Task', 48),
      desc: String(spec.desc || ''),
      assignee: spec.assignee || null,
      status: 'queued',
      parentId: spec.parentId || null,
      subtaskIds: [],
      result: null,
      error: null,
      createdAt: nowMs(),
      role: role,
      needsWeb: (typeof spec.needsWeb === 'boolean')
        ? spec.needsWeb
        : !!(ROLES()[role] && ROLES()[role].webSearchPreferred),
      _ctrl: null,
    };
    if (s && Array.isArray(s.tasks)) s.tasks.push(t);
    refreshBoard();
    saveSoon();
    return t;
  };

  // ===========================================================================
  // DEPENDENCY policy — a child depends on ALL earlier siblings in the same plan.
  // It is runnable iff every earlier sibling is `done` (error counts as resolved
  // so a failed predecessor doesn't deadlock; its result is simply absent).
  // ===========================================================================
  function depsSatisfied(task) {
    if (!task.parentId) return true;          // standalone tasks have no deps
    if (typeof task._depIndex !== 'number') return true;
    var sibs = childrenOf(task.parentId);
    for (var i = 0; i < sibs.length; i++) {
      var sib = sibs[i];
      if (sib === task || sib.id === task.id) continue;
      if (typeof sib._depIndex !== 'number') continue;
      if (sib._depIndex < task._depIndex) {
        // earlier sibling must be terminal (done/error) before this one runs.
        if (sib.status !== 'done' && sib.status !== 'error') return false;
      }
    }
    return true;
  }

  // ===========================================================================
  // assign(task [, agent]) — bind + drive to desk + runWorker.
  // ===========================================================================
  Orchestrator.assign = function (task, agent) {
    if (!task) return;
    var ag = AGENTS();
    if (!agent) {
      agent = ag.findIdle(task.role) || spawnTempWorker(task.role);
    }
    if (!agent) return; // couldn't get an agent; remain queued for a later tick

    // Anti-double-assignment: claim synchronously BEFORE any await.
    agent.busy = true;
    agent.currentTaskId = task.id;
    task.assignee = agent.id;
    task.status = 'running';

    var roleLabel = (ROLES()[task.role] && ROLES()[task.role].label) || task.role;
    log('Boss', agent.name || roleLabel, 'msg', '@' + (agent.name || roleLabel) + ': ' + task.title);
    refreshBoard();

    runWorker(task);
  };

  function spawnTempWorker(role) {
    var ag = AGENTS();
    var roleDef = ROLES()[role] || ROLES().generalist || {};
    var spec = {
      name: cap(role) + '·' + Math.floor(Math.random() * 90 + 10),
      role: (ROLES()[role] ? role : 'generalist'),
      temp: true,
      color: roleDef.color,
      systemPrompt: roleDef.system,
    };
    var a = ag.create(spec);
    if (a) {
      log('system', a.name, 'system', 'spawned temp ' + (spec.role) + ' worker');
      try { if (App.UI && App.UI.refreshAgentList) App.UI.refreshAgentList(); } catch (e) {}
    }
    return a;
  }
  function cap(s) { s = String(s || 'worker'); return s.charAt(0).toUpperCase() + s.slice(1); }

  // ===========================================================================
  // runWorker(task) — walk to desk, set coding/searching, stream the result.
  // ===========================================================================
  function runWorker(task) {
    var ag = AGENTS();
    var agent = ag.byId(task.assignee);
    if (!agent) { failTask(task, 'no agent'); return; }

    var settings = STATE().settings || {};
    var roleDef = ROLES()[task.role] || {};

    // Build the worker user content (with dependency results injected).
    var userContent = buildWorkerUserContent(task);

    // Web search decision.
    var wantWeb = !!(settings.webSearch && (task.needsWeb || roleDef.webSearchPreferred));
    var tools = (wantWeb && CFG().WEB_SEARCH_TOOL) ? [CFG().WEB_SEARCH_TOOL] : undefined;

    // No key path (should be caught earlier, but defend).
    if (!settings.apiKey) {
      ag.say(agent, '🔑 set your API key in Settings', 4000);
      failTask(task, 'NO_KEY');
      return;
    }

    // Choreography: walk to desk, then set coding/searching and stream.
    ag.say(agent, truncate(task.title, 40), 3000);
    ag.goToFurniture(agent, 'desk', function () {
      ag.setState(agent, wantWeb ? 'searching' : 'coding');
      startWorkerStream(task, agent, userContent, tools, wantWeb);
    });
  }

  function startWorkerStream(task, agent, userContent, tools, wantWeb) {
    var ag = AGENTS();
    var settings = STATE().settings || {};
    var roleDef = ROLES()[task.role] || {};
    var sys = agent.systemPrompt || roleDef.system || '';

    var acc = '';
    var bubbleAccum = '';

    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,        // GPT-model worker support
      model: agent.model || settings.defaultModel,
      system: sys,
      messages: [{ role: 'user', content: userContent }],
      tools: tools,
      onState: function (st) {
        if (st === 'searching') ag.setState(agent, 'searching');
        else if (st === 'text') ag.setState(agent, 'coding'); // first text → coding
      },
      onText: function (delta) {
        acc += delta;
        bubbleAccum += delta;
        ag.say(agent, bubbleAccum.slice(-60), 3000);
        // Live transcript so clicking the worker shows progress.
        try { if (App.UI && App.UI.appendTranscript) App.UI.appendTranscript(agent.id, 'assistant', delta); } catch (e) {}
        // keep the board's running card text fresh occasionally
        task.result = acc;
      },
      onDone: function (res) {
        var text = (res && res.text) || acc || '';
        if (res && res.usage) {
          agent.stats.tokensIn += (res.usage.input_tokens || 0);
          agent.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        if (!text || !text.trim()) {
          failTask(task, '(empty result)');
          return;
        }
        finishTask(task, text);
      },
      onError: function (err) {
        var msg = (err && err.message) || 'error';
        if (err && err.type === 'no_key') { failTask(task, 'NO_KEY'); return; }
        if (err && err.type === 'abort') {
          // aborted (cancel/pause) → re-runnable
          task.status = 'queued';
          task.assignee = null;
          agent.busy = false;
          agent.currentTaskId = null;
          ag.setState(agent, 'idle');
          var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams[agent.id];
          refreshBoard();
          return;
        }
        failTask(task, msg, (err && err.status));
      },
    });

    task._ctrl = handle;
    var s = STATE(); if (s && s._activeStreams) s._activeStreams[agent.id] = handle;
  }

  // buildWorkerUserContent — instruction + any done-predecessor results (orch.md §4.2).
  function buildWorkerUserContent(task) {
    var parts = [];
    if (task.parentId && typeof task._depIndex === 'number') {
      var sibs = childrenOf(task.parentId).filter(function (s) {
        return typeof s._depIndex === 'number' && s._depIndex < task._depIndex && s.status === 'done' && s.result;
      });
      sibs.sort(function (a, b) { return a._depIndex - b._depIndex; });
      if (sibs.length) {
        parts.push('CONTEXT — results from earlier subtasks you can build on:');
        for (var i = 0; i < sibs.length; i++) {
          var roleLabel = (ROLES()[sibs[i].role] && ROLES()[sibs[i].role].label) || sibs[i].role;
          parts.push('[' + roleLabel + ' — ' + sibs[i].title + ']\n' + sibs[i].result);
        }
        parts.push('');
      }
    }
    parts.push('YOUR TASK:\n' + task.desc);
    return parts.join('\n');
  }

  // ===========================================================================
  // finishTask / failTask
  // ===========================================================================
  function finishTask(task, text) {
    var ag = AGENTS();
    task.status = 'done';
    task.result = text;
    task.error = null;

    var agent = ag.byId(task.assignee);
    if (agent) {
      agent.busy = false;
      agent.currentTaskId = null;
      agent.stats.tasksDone += 1;
      ag.setState(agent, 'idle');
      ag.say(agent, '✓ done', 2500);
      // honor a deferred break request (set while the agent was busy), else maybe wander.
      if (agent._wantBreak) {
        agent._wantBreak = false;
        sendOnBreak(agent.id);
      } else {
        maybeCoffee(agent);
      }
      var s = STATE(); if (s && s._activeStreams) delete s._activeStreams[agent.id];
    }
    var roleLabel = agent ? agent.name : ((ROLES()[task.role] && ROLES()[task.role].label) || task.role);
    log(roleLabel, 'Boss', 'result', truncate(resultLine(text) || ('✓ ' + task.title), 120));
    refreshBoard();
    saveSoon();
    try { if (App.UI && App.UI.refreshAgentList) App.UI.refreshAgentList(); } catch (e) {}
  }

  function failTask(task, msg, status) {
    var ag = AGENTS();
    task.status = 'error';
    task.error = msg || 'error';

    var agent = ag.byId(task.assignee);
    if (agent) {
      agent.busy = false;
      agent.currentTaskId = null;
      ag.setState(agent, 'idle');
      if (msg === 'NO_KEY') ag.say(agent, '🔑 set your API key in Settings', 4000);
      else ag.say(agent, '⚠ error', 3500);
      var s = STATE(); if (s && s._activeStreams) delete s._activeStreams[agent.id];
    }
    var label = agent ? agent.name : task.role;
    log(label, 'Boss', 'error', 'API error' + (status ? ' (' + status + ')' : '') + ': ' + (msg || ''));
    refreshBoard();
    saveSoon();
  }

  // resultLine — pull the "RESULT:" summary line if present.
  function resultLine(text) {
    if (!text) return '';
    var m = String(text).match(/RESULT:\s*(.+)\s*$/im);
    return m ? m[1].trim() : '';
  }

  // maybeCoffee — sometimes a finished worker wanders to the lounge for a break.
  // Now routed through Agents.goToBreak (lounge spots) rather than a bare coffee tile.
  function maybeCoffee(agent) {
    try {
      if (!agent || agent.temp) return;
      if (STATE() && STATE()._meetingActive) return;   // don't wander off during a sync meeting
      if (Math.random() > 0.4) return;
      var ag = AGENTS();
      ag.goToBreak(agent, function () {
        // relax in the lounge, then head home after a beat
        setTimeout(function () {
          if (agent.state === 'coffee' && !agent.busy) ag.returnHome(agent);
        }, 3500);
      });
    } catch (e) {}
  }

  // ===========================================================================
  // TEA-BREAK policy (NEW) — sendOnBreak / breakEveryone + light banter.
  // ===========================================================================

  // True iff the agent currently has a stream in flight (must not interrupt it).
  function agentBusy(agent) {
    if (!agent) return true;
    if (agent.busy) return true;
    try {
      var s = STATE();
      if (s && s._activeStreams && s._activeStreams[agent.id]) return true;
    } catch (e) {}
    return false;
  }

  // sendOnBreak(agentId) — walk an idle agent to the lounge for a relaxed break,
  // then send it home. If the agent is busy, defer via _wantBreak (finishTask honors it).
  function sendOnBreak(agentId) {
    try {
      var ag = AGENTS();
      var agent = ag && ag.byId ? ag.byId(agentId) : null;
      if (!agent) return;

      // Busy → remember the request; finishTask will take the break afterwards.
      if (agentBusy(agent)) { agent._wantBreak = true; return; }
      // Already lounging → nothing to do.
      if (agent.state === 'coffee') return;

      log('user', agent.name || agent.role, 'msg', '☕ taking a break');
      ag.goToBreak(agent, function () {
        // sparse banter while relaxing
        maybeBanter(agent, 'break');
        // relaxed delay, then return home and idle.
        var delay = 6000 + Math.floor(Math.random() * 3000); // ~6-9s
        setTimeout(function () {
          if (agent.state === 'coffee' && !agentBusy(agent)) ag.returnHome(agent);
        }, delay);
      });
    } catch (e) {}
  }
  Orchestrator.sendOnBreak = sendOnBreak;

  // breakEveryone() — send all idle non-boss agents to the lounge, staggered.
  Orchestrator.breakEveryone = function () {
    try {
      var s = STATE();
      var ag = AGENTS();
      if (!s || !Array.isArray(s.agents) || !ag) return;
      log('user', 'all', 'msg', '☕ coffee break!');
      var sent = 0;
      for (var i = 0; i < s.agents.length; i++) {
        var a = s.agents[i];
        if (!a || a.role === 'boss') continue;
        if (a.state !== 'idle' || agentBusy(a)) continue;
        (function (agt, n) {
          setTimeout(function () { sendOnBreak(agt.id); }, 600 * n);
        })(a, sent);
        sent++;
      }
    } catch (e) {}
  };

  // Light, non-spammy inter-agent banter during meetings / breaks.
  var _banterLines = [
    'nice work team',
    'this one was fun',
    'coffee hits different ☕',
    'how was your weekend?',
    'ship it 🚀',
    'love the energy',
    'almost there!',
    'good sync 🤝',
  ];
  var _lastBanter = 0;
  function maybeBanter(agent, ctx) {
    try {
      if (!agent) return;
      if (Math.random() > 0.25) return;                 // sparse
      var now = nowMs();
      if (now - _lastBanter < 5000) return;             // rate-limit globally
      _lastBanter = now;
      var line = _banterLines[Math.floor(Math.random() * _banterLines.length)];
      AGENTS().say(agent, line, 3000);
      log(agent.name || agent.role, 'all', 'msg', line);
    } catch (e) {}
  }

  // ===========================================================================
  // synthesize(rootTask) — meeting choreography + final boss call.
  // ===========================================================================
  Orchestrator.synthesize = function (rootTask) {
    if (!rootTask || rootTask._synthStarted) return;
    rootTask._synthStarted = true;

    var s = STATE();
    var ag = AGENTS();
    var settings = s.settings || {};
    var boss = ensureBoss();

    s._meetingActive = true;

    // Gather participants = boss + agents that worked on children.
    var kids = childrenOf(rootTask.id);
    var participants = [];
    if (boss) participants.push(boss);
    for (var i = 0; i < kids.length; i++) {
      var a = ag.byId(kids[i].assignee);
      if (a && participants.indexOf(a) === -1) participants.push(a);
    }

    // Walk participants to meeting seats.
    var seats = (WORLD() && WORLD().meetingSeats) ? WORLD().meetingSeats() : [];
    for (var p = 0; p < participants.length; p++) {
      var pa = participants[p];
      var seat = seats[p];
      if (seat) {
        ag.goToCell(pa, seat.gx, seat.gy, (function (agt) {
          return function () { ag.setState(agt, 'meeting'); };
        })(pa));
      } else {
        ag.setState(pa, 'meeting');
      }
    }
    if (boss) {
      ag.setState(boss, 'thinking');
      ag.say(boss, "Let's sync 🤝", 3500);
    }
    // sparse friendly banter from one participant during the sync.
    if (participants.length > 1) maybeBanter(participants[1], 'meeting');
    log('Boss', 'all', 'system', 'Synthesizing ' + kids.length + ' results…');
    refreshBoard();

    // Build synth content and stream.
    var content = buildSynthUserContent(rootTask);
    var roleDef = ROLES().boss || {};
    var synthSys = (CFG().BOSS_SYNTH_SYSTEM) || roleDef.synthSystem || DEFAULT_SYNTH_SYSTEM;

    var acc = '';
    if (boss) boss.busy = true;   // claim BEFORE stream (onError can fire synchronously on no-key/no-model)
    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,        // GPT-model boss support
      model: (boss && boss.model) || settings.bossModel || CFG().BOSS_MODEL,
      system: synthSys,
      messages: [{ role: 'user', content: content }],
      onState: function (st) {
        if (boss && st === 'searching') ag.setState(boss, 'searching');
      },
      onText: function (delta) {
        acc += delta;
        if (boss) ag.say(boss, acc.slice(-60), 3000);
      },
      onDone: function (res) {
        var text = (res && res.text) || acc || '';
        if (boss && res && res.usage) {
          boss.stats.tokensIn += (res.usage.input_tokens || 0);
          boss.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        rootTask.status = 'done';
        rootTask.result = text || '(no synthesis produced)';
        s._meetingActive = false;
        if (boss) {
          boss.busy = false;
          ag.setState(boss, 'idle');
          ag.say(boss, 'Done ✓', 4000);
        }
        // disperse participants back to their desks.
        disperse(participants, boss);
        log('Boss', 'user', 'result', 'Final answer ready.');
        // Boss-initiated rest: queue empty + root done → occasionally a team break.
        // Light touch; breakEveryone() only moves idle, non-busy agents.
        if (queueIsEmpty() && Math.random() < 0.3) {
          setTimeout(function () {
            if (queueIsEmpty() && !(STATE() && STATE()._meetingActive)) {
              Orchestrator.breakEveryone();
            }
          }, 4000);
        }
        refreshBoard();
        try { if (App.UI && App.UI.showFinalResult) App.UI.showFinalResult(rootTask); } catch (e) {}
        saveSoon();
        if (s && s._activeStreams) delete s._activeStreams['__boss_synth'];
      },
      onError: function (err) {
        var msg = (err && err.message) || 'error';
        rootTask.status = 'error';
        rootTask.error = msg;
        s._meetingActive = false;
        if (boss) { boss.busy = false; ag.setState(boss, 'idle'); ag.say(boss, '⚠ ' + truncate(msg, 36), 4000); }
        disperse(participants, boss);
        log('Boss', 'system', 'error', 'synthesis error: ' + msg);
        refreshBoard();
        try { if (App.UI && App.UI.showFinalResult) App.UI.showFinalResult(rootTask); } catch (e) {}
        if (s && s._activeStreams) delete s._activeStreams['__boss_synth'];
      },
    });
    rootTask._ctrl = handle;
    if (s && s._activeStreams) s._activeStreams['__boss_synth'] = handle;
  };

  var DEFAULT_SYNTH_SYSTEM =
    "You are the BOSS of an autonomous AI company. Your workers have completed their subtasks.\n" +
    "Combine their results into ONE final answer that fully satisfies the user's original goal.\n" +
    "- Integrate the pieces; resolve any conflicts; do not just concatenate.\n" +
    "- Keep what's good, fix obvious gaps, and present it cleanly for the user (markdown ok).\n" +
    "- If a subtask failed, work around it gracefully and note the limitation briefly.\n" +
    "- Do not mention this internal process unless useful. Just deliver the result.";

  function buildSynthUserContent(rootTask) {
    var parts = [];
    parts.push("USER'S ORIGINAL GOAL:\n" + (rootTask.desc || ''));
    var guidance = (rootTask._plan && rootTask._plan.final) ||
      'Combine all worker results into a single coherent answer for the user.';
    parts.push('\nSYNTHESIS GUIDANCE (your own earlier note):\n' + guidance);
    parts.push('\nWORKER RESULTS:');
    var kids = childrenOf(rootTask.id);
    kids.sort(function (a, b) {
      var ai = (typeof a._depIndex === 'number') ? a._depIndex : 0;
      var bi = (typeof b._depIndex === 'number') ? b._depIndex : 0;
      return ai - bi;
    });
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var roleLabel = (ROLES()[k.role] && ROLES()[k.role].label) || k.role;
      var body = (k.status === 'done' && k.result) ? k.result
        : ('(this subtask did not complete: ' + (k.error || 'no result') + ')');
      parts.push('\n[' + roleLabel + ' — ' + k.title + ']\n' + body);
    }
    parts.push('\nProduce the final answer for the user now.');
    return parts.join('\n');
  }

  function disperse(participants, boss) {
    var ag = AGENTS();
    for (var i = 0; i < participants.length; i++) {
      var pa = participants[i];
      if (!pa || pa === boss) continue;
      if (pa.busy) continue;
      // Send back to the agent's PERMANENT desk. gx/gy were overwritten by the walk
      // to the meeting seat, so dispersing to pa.gx/pa.gy would be a no-op (stuck at table).
      var hx = (typeof pa.homeGx === 'number') ? pa.homeGx : pa.gx;
      var hy = (typeof pa.homeGy === 'number') ? pa.homeGy : pa.gy;
      ag.goToCell(pa, hx, hy, (function (agt) {
        return function () { if (!agt.busy) ag.setState(agt, 'idle'); };
      })(pa));
      // (no unconditional setState('idle') — goToCell sets 'walking'; the onArrive callback idles)
    }
  }

  // ===========================================================================
  // tick() — frame-driven queue pump. Cheap & re-entrant-safe.
  // ===========================================================================
  var _ticking = false;
  Orchestrator.tick = function () {
    if (_ticking) return;
    _ticking = true;
    try {
      var s = STATE();
      if (!s || !Array.isArray(s.tasks)) return;
      if (s.paused) return;

      var maxConc = CFG().MAX_CONCURRENT || 4;

      // 1) flip blocked → queued when deps satisfied.
      for (var b = 0; b < s.tasks.length; b++) {
        var bt = s.tasks[b];
        if (bt && bt.status === 'blocked' && depsSatisfied(bt)) bt.status = 'queued';
      }

      // 2) assign queued tasks (FIFO by createdAt), dep-gated, concurrency-capped.
      var queued = [];
      for (var i = 0; i < s.tasks.length; i++) {
        var t = s.tasks[i];
        if (t && t.status === 'queued' && t.role !== 'boss') queued.push(t);
      }
      queued.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

      for (var q = 0; q < queued.length; q++) {
        if (runningCount() >= maxConc) break;
        var task = queued[q];
        if (!depsSatisfied(task)) {
          task.status = 'blocked';   // will be revisited next tick
          continue;
        }
        var ag = AGENTS();
        var agent = ag.findIdle(task.role);
        if (!agent) {
          // no idle role-match agent free right now; spawn a temp (cap respected
          // by runningCount check above) and assign.
          Orchestrator.assign(task); // assign() spawns a temp if needed
        } else {
          Orchestrator.assign(task, agent);
        }
      }

      // 3) synthesis trigger: any root with all children terminal & not yet synthesized.
      checkRootsForSynthesis(s);
    } catch (e) {
      // tick must never throw into the loop.
      try { console && console.warn && console.warn('[Orchestrator.tick]', e); } catch (e2) {}
    } finally {
      _ticking = false;
    }
  };

  function checkRootsForSynthesis(s) {
    for (var i = 0; i < s.tasks.length; i++) {
      var root = s.tasks[i];
      if (!root || root.parentId) continue;          // roots only
      if (root.role !== 'boss') continue;            // boss roots only synthesize
      if (root.status !== 'running') continue;        // still planning or already done/error
      if (root._synthStarted) continue;
      if (!root.subtaskIds || !root.subtaskIds.length) continue; // children not created yet

      var kids = childrenOf(root.id);
      if (!kids.length) continue;
      var allTerminal = true, anyDone = false, allError = true;
      for (var k = 0; k < kids.length; k++) {
        var st = kids[k].status;
        if (st !== 'done' && st !== 'error') { allTerminal = false; break; }
        if (st === 'done') { anyDone = true; allError = false; }
      }
      if (!allTerminal) continue;

      if (anyDone) {
        Orchestrator.synthesize(root);
      } else if (allError) {
        // All children failed → root error, no synthesis. (§7.6)
        root.status = 'error';
        root.error = 'all subtasks failed';
        root._synthStarted = true;
        var boss = ensureBoss();
        if (boss) AGENTS().say(boss, '⚠ couldn’t complete', 4000);
        log('Boss', 'user', 'error', 'All subtasks failed.');
        refreshBoard();
        try { if (App.UI && App.UI.showFinalResult) App.UI.showFinalResult(root); } catch (e) {}
      }
    }
  }

  // ===========================================================================
  // cancelTask(taskId) — abort stream; agent idle; task → queued (re-runnable).
  // ===========================================================================
  Orchestrator.cancelTask = function (taskId) {
    var t = taskById(taskId);
    if (!t) return;
    var ag = AGENTS();
    try { if (t._ctrl && t._ctrl.abort) t._ctrl.abort(); } catch (e) {}
    t._ctrl = null;
    var agent = ag.byId(t.assignee);
    if (agent) {
      try { if (STATE()._activeStreams) delete STATE()._activeStreams[agent.id]; } catch (e) {}
      agent.busy = false;
      agent.currentTaskId = null;
      ag.setState(agent, 'idle');
    }
    if (t.status === 'running') {
      t.status = 'queued';
      t.assignee = null;
    }
    log('user', 'system', 'system', 'cancelled task: ' + t.title);
    refreshBoard();
  };

  // ===========================================================================
  // PUBLISH + §7.10 REQUIRED compat aliases
  // ===========================================================================
  App.Orchestrator = Orchestrator;

  Orchestrator.enqueue = Orchestrator.enqueueTask;     // orch.md name
  Orchestrator.runSubtask = function (task) { return runWorker(task); }; // orch.md name
  Orchestrator.runWorker = function (task) { return runWorker(task); };  // public per SPEC §7.6

})();
