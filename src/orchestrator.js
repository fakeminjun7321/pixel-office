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

  // ===========================================================================
  // ATTENTION — flag agents needing the user (no-key / rate-limit / error) and
  //   keep the document-title badge in sync. Guarded everywhere.
  // ===========================================================================
  function attentionCount() {
    var s = STATE(), n = 0;
    if (!s || !Array.isArray(s.agents)) return 0;
    for (var i = 0; i < s.agents.length; i++) {
      if (s.agents[i] && s.agents[i]._attention) n++;
    }
    return n;
  }
  function syncAttentionBadge() {
    try { if (App.UI && App.UI.setAttentionBadge) App.UI.setAttentionBadge(attentionCount()); } catch (e) {}
  }
  function raiseAttention(agent) {
    try {
      var ag = AGENTS();
      if (ag && ag.setAttention && agent) ag.setAttention(agent, true);
      else if (agent) agent._attention = true;
    } catch (e) {}
    syncAttentionBadge();
  }
  function clearAttention(agent) {
    try {
      var ag = AGENTS();
      if (ag && ag.setAttention && agent) ag.setAttention(agent, false);
      else if (agent) agent._attention = false;
    } catch (e) {}
    syncAttentionBadge();
  }

  // ===========================================================================
  // MOOD / RELATIONSHIPS — subtle nudges after collaboration. All guarded; prefer
  //   Agents helpers (owned by agents.js) but fall back to direct writes so this
  //   never throws if a helper is missing during a partial load.
  // ===========================================================================
  function clamp01(n) { n = +n; if (!isFinite(n)) return 0; return n < 0 ? 0 : (n > 1 ? 1 : n); }

  function markActivity(agent) {
    if (!agent) return;
    try {
      var ag = AGENTS();
      if (ag && typeof ag.markActivity === 'function') { ag.markActivity(agent); return; }
    } catch (e) {}
    try { agent._lastActivityTs = nowMs(); } catch (e) {}
  }

  function setMood(agent, value) {
    if (!agent) return;
    try {
      var ag = AGENTS();
      if (ag && typeof ag.setMood === 'function') { ag.setMood(agent, value); return; }
    } catch (e) {}
    try { agent.mood = clamp01(value); } catch (e) {}
  }

  function nudgeMood(agent, delta) {
    if (!agent) return;
    var cur = (typeof agent.mood === 'number') ? agent.mood
      : (CFG().MOOD_DEFAULT != null ? CFG().MOOD_DEFAULT : 0.7);
    setMood(agent, clamp01(cur + delta));
  }

  function adjustAffinity(a, b, delta) {
    if (!a || !b || a === b || a.id === b.id) return;
    try {
      var ag = AGENTS();
      if (ag && typeof ag.adjustAffinity === 'function') { ag.adjustAffinity(a, b.id, delta); return; }
    } catch (e) {}
    try {
      if (!a.relationships || typeof a.relationships !== 'object') a.relationships = {};
      var cur = (typeof a.relationships[b.id] === 'number') ? a.relationships[b.id] : 0.5;
      a.relationships[b.id] = clamp01(cur + delta);
    } catch (e) {}
  }

  // affinity(a, b) → current affinity a feels toward b (default 0.5).
  function affinity(a, b) {
    try {
      if (a && b && a.relationships && typeof a.relationships[b.id] === 'number') return a.relationships[b.id];
    } catch (e) {}
    return 0.5;
  }

  // bondParticipants — after a collaboration, raise mutual affinity + lift mood for
  //   everyone who worked together. Subtle (small deltas), guarded, never throws.
  function bondParticipants(list, moodDelta, affDelta) {
    try {
      if (!Array.isArray(list)) return;
      moodDelta = (typeof moodDelta === 'number') ? moodDelta : 0.05;
      affDelta = (typeof affDelta === 'number') ? affDelta : 0.04;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a) continue;
        nudgeMood(a, moodDelta);
        for (var j = 0; j < list.length; j++) {
          if (i === j) continue;
          adjustAffinity(a, list[j], affDelta);
        }
      }
      saveSoon();
    } catch (e) {}
  }

  var Orchestrator = {};
  Orchestrator.PLAN_SCHEMA_VERSION = 1;
  Orchestrator.adjustAffinity = adjustAffinity;
  Orchestrator.bondParticipants = bondParticipants;

  // Usable credentials for a model? openai → openaiKey; anthropic → apiKey OR the
  // local companion (subscription proxy needs no key). Mirrors api.js's guard so
  // companion-only / GPT-only setups aren't blocked before the request is built.
  function hasCredsFor(model) {
    var set = (STATE() && STATE().settings) || {};
    var prov = (CFG().providerOf ? CFG().providerOf(model)
      : (App.util && App.util.providerOf ? App.util.providerOf(model) : 'anthropic'));
    if (prov === 'openai') return !!set.openaiKey;
    return !!set.apiKey || !!(set.useCompanion && set.companionUrl);
  }

  // providerOf — resolve a model's provider ('anthropic' | 'openai' | ...).
  function providerOf(model) {
    try {
      if (CFG().providerOf) return CFG().providerOf(model);
      if (App.util && App.util.providerOf) return App.util.providerOf(model);
    } catch (e) {}
    return 'anthropic';
  }

  // clientToolsApplicable — true when the Browser-tools integration should expose
  //   App.Tools specs to a worker: tools module present + enabled + an Anthropic
  //   model (the only provider whose tool schema we pass through here).
  function clientToolsApplicable(agent, settings) {
    try {
      if (!App.Tools || typeof App.Tools.specs !== 'function') return false;
      if (typeof App.Tools.enabled === 'function' && !App.Tools.enabled()) return false;
      var model = (agent && agent.model) || (settings && settings.defaultModel);
      return providerOf(model) === 'anthropic';
    } catch (e) { return false; }
  }

  // executeToolUses(blocks) → Promise<tool_result[]>. Runs App.Tools.run for each
  //   {id,name,input} block and logs the activity. Bounded by the caller. Robust:
  //   any failure yields an error tool_result rather than throwing.
  function executeToolUses(blocks, agent) {
    var jobs = [];
    for (var i = 0; i < blocks.length; i++) {
      (function (blk) {
        var p;
        try {
          if (App.Tools && typeof App.Tools.run === 'function') {
            p = App.Tools.run(blk.name, blk.input);
          } else {
            p = Promise.resolve({ ok: false, output: '', error: 'tools unavailable' });
          }
        } catch (e) {
          p = Promise.resolve({ ok: false, output: '', error: String((e && e.message) || e) });
        }
        jobs.push(Promise.resolve(p).then(function (r) {
          r = r || {};
          var label = (agent && agent.name) || (agent && agent.role) || 'agent';
          try { log(label, 'tool', 'tool', '🔧 ' + (blk.name || 'tool') + (r.ok ? ' ✓' : ' ✗')); } catch (e) {}
          // surface in the agent transcript if the UI supports it.
          try {
            if (App.UI && App.UI.appendTranscript && agent) {
              App.UI.appendTranscript(agent.id, 'tool', '[tool ' + (blk.name || '') + '] ' + truncate(r.ok ? r.output : (r.error || 'error'), 200));
            }
          } catch (e) {}
          return {
            type: 'tool_result',
            tool_use_id: blk.id,
            content: r.ok ? String(r.output == null ? '' : r.output)
                          : ('ERROR: ' + String(r.error || 'tool failed')),
            is_error: !r.ok,
          };
        }));
      })(blocks[i]);
    }
    return Promise.all(jobs);
  }

  // slugify a title for artifact filenames (lowercase, dashes, no exotic chars).
  function slug(s) {
    return String(s || 'artifact')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'artifact';
  }
  // map a code-fence language hint → file extension.
  function extForLang(lang) {
    var L = String(lang || '').toLowerCase().trim();
    var map = {
      js: '.js', javascript: '.js', jsx: '.jsx', ts: '.ts', typescript: '.ts', tsx: '.tsx',
      py: '.py', python: '.py', rb: '.rb', ruby: '.rb', go: '.go', rs: '.rs', rust: '.rs',
      java: '.java', c: '.c', cpp: '.cpp', 'c++': '.cpp', cs: '.cs', php: '.php', swift: '.swift',
      kt: '.kt', kotlin: '.kt', sh: '.sh', bash: '.sh', zsh: '.sh', sql: '.sql',
      html: '.html', css: '.css', scss: '.scss', json: '.json', yaml: '.yml', yml: '.yml',
      xml: '.xml', md: '.md', markdown: '.md', txt: '.txt', text: '.txt', toml: '.toml',
    };
    return map[L] || (L ? ('.' + L.replace(/[^a-z0-9]/g, '').slice(0, 6)) : '.txt');
  }
  // classify an artifact type from filename extension / fence lang.
  function artifactType(name, lang) {
    var n = String(name || '').toLowerCase();
    if (/\.(md|markdown)$/.test(n) || /^(md|markdown)$/.test(String(lang || '').toLowerCase())) return 'markdown';
    if (/\.(json|csv|tsv|ya?ml|xml|toml)$/.test(n)) return 'data';
    if (/\.(txt|text)$/.test(n)) return 'text';
    if (/\.[a-z0-9]+$/.test(n)) return 'code';
    return 'text';
  }

  // ===========================================================================
  // ARTIFACTS — parse fenced blocks out of worker output and store them.
  // ```artifact:<filename.ext>\n<content>\n```  → Artifact named by filename.
  // a plain ```lang code block → name = slug(task.title)+ext(lang).
  // ===========================================================================
  function parseArtifacts(text, task, agent) {
    var out = [];
    try {
      if (!text) return out;
      var src = String(text);
      // Match fenced blocks: capture info string + body. Tolerate ``` or ~~~.
      var re = /(^|\n)([`~]{3,})[ \t]*([^\n`~]*)\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
      var m, autoIdx = 0;
      while ((m = re.exec(src)) !== null) {
        var info = String(m[3] || '').trim();
        var body = m[4] != null ? m[4] : '';
        var am = info.match(/^artifact:(\S+)/i);
        var name, lang = '';
        if (am) {
          name = am[1];
          lang = name.indexOf('.') >= 0 ? name.split('.').pop() : '';
        } else {
          // plain code block: only capture ones with a language hint (skip prose fences)
          lang = info.split(/\s+/)[0] || '';
          if (!lang) continue;
          var suffix = autoIdx > 0 ? ('-' + (autoIdx + 1)) : '';
          name = slug(task && task.title) + suffix + extForLang(lang);
        }
        autoIdx++;
        out.push({
          name: name,
          type: artifactType(name, lang),
          content: body,
          taskId: task ? task.id : null,
          agentId: agent ? agent.id : null,
        });
      }
    } catch (e) {}
    return out;
  }

  // pushArtifacts — dedupe by name+taskId (overwrite on retry); cap ARTIFACT_MAX.
  function pushArtifacts(list) {
    try {
      var s = STATE();
      if (!s) return;
      if (!Array.isArray(s.artifacts)) s.artifacts = [];
      var cap = CFG().ARTIFACT_MAX || 200;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || !a.name) continue;
        var existing = null;
        for (var j = 0; j < s.artifacts.length; j++) {
          var e = s.artifacts[j];
          if (e && e.name === a.name && e.taskId === a.taskId) { existing = e; break; }
        }
        if (existing) {
          existing.type = a.type;
          existing.content = a.content;
          existing.agentId = a.agentId;
          existing.t = nowMs();
        } else {
          s.artifacts.push({
            id: uid('art'),
            name: a.name, type: a.type, content: a.content,
            taskId: a.taskId, agentId: a.agentId, t: nowMs(),
          });
        }
      }
      // cap (drop oldest)
      if (s.artifacts.length > cap) s.artifacts.splice(0, s.artifacts.length - cap);
      try { if (App.UI && App.UI.refreshArtifacts) App.UI.refreshArtifacts(); } catch (e) {}
    } catch (e) {}
  }

  // ===========================================================================
  // MEMORY helpers — persona + relevant memory block injection.
  // ===========================================================================
  function importanceHeuristic(task, text) {
    var imp = 5;
    try {
      if (task && task.verify) imp += 2;                 // verified work matters more
      if (task && task._retries) imp += 1;               // hard-won
      var t = String(text || '');
      if (/RESULT:\s*FAIL/i.test(t)) imp += 1;
      if (t.length > 1200) imp += 1;                      // substantial deliverable
    } catch (e) {}
    return Math.max(0, Math.min(10, imp));
  }

  // personaBlock(agent) — short identity/plan/relationships preamble for prompts.
  function personaBlock(agent) {
    try {
      var p = agent && agent.persona;
      if (!p) return '';
      var lines = [];
      if (p.identity) lines.push('Identity: ' + p.identity);
      if (p.plan) lines.push('Your approach: ' + p.plan);
      if (p.relationships) lines.push('Team: ' + p.relationships);
      if (!lines.length) return '';
      return 'WHO YOU ARE:\n' + lines.join('\n');
    } catch (e) { return ''; }
  }

  // memoryBlock(agent, query) — top-K relevant memories as a short note.
  function memoryBlock(agent, query) {
    try {
      var ag = AGENTS();
      if (!ag || !ag.scoreMemories || !agent || !Array.isArray(agent.memories) || !agent.memories.length) return '';
      var top = ag.scoreMemories(query || '', agent.memories) || [];
      if (!top.length) return '';
      var lines = [];
      for (var i = 0; i < top.length; i++) {
        if (top[i] && top[i].text) lines.push('- ' + truncate(top[i].text, 160));
      }
      if (!lines.length) return '';
      return 'YOUR RELEVANT MEMORY:\n' + lines.join('\n');
    } catch (e) { return ''; }
  }

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
    // Count only running WORKER subtasks; the root boss task stays 'running' for the
    // whole goal lifetime and must NOT consume a MAX_CONCURRENT slot (else only one
    // worker ever runs in parallel at MAX_CONCURRENT=2).
    var s = STATE(), n = 0;
    if (!s || !Array.isArray(s.tasks)) return 0;
    for (var i = 0; i < s.tasks.length; i++) {
      var t = s.tasks[i];
      if (t && t.status === 'running' && t.parentId) n++;
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
    if (!hasCredsFor((boss && boss.model) || settings.bossModel || CFG().BOSS_MODEL)) {
      root.status = 'error';
      root.error = 'NO_KEY';
      if (boss) ag.say(boss, '🔑 add an API key (or enable the companion) in Settings', 4000);
      try { if (App.UI && App.UI.toast) App.UI.toast('Add an API key (or enable the companion) in Settings'); } catch (e) {}
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
    var pre = [];
    var personaP = personaBlock(boss);
    if (personaP) { pre.push(personaP); pre.push(''); }
    var memP = memoryBlock(boss, userText);
    if (memP) { pre.push(memP); pre.push(''); }
    var userMsg = pre.join('\n') + 'GOAL:\n' + userText + '\n\nReturn the JSON plan now.';

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
    var idxToId = {};   // plan index → child task id (for DAG dep resolution)
    var created = [];
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
          _depPlanIdx: Array.isArray(it.deps) ? it.deps.slice() : null, // declared deps (plan indices)
          _depIds: null,  // resolved below (plan idx → child task id)
          verify: !!it.verify,
          _retries: 0,
          _qaDone: false,
          _feedback: null,
          _ctrl: null,
        };
        s.tasks.push(t);
        root.subtaskIds.push(t.id);
        idxToId[idx] = t.id;
        created.push(t);

        // staggered delegation bubble from the boss.
        setTimeout(function () {
          var roleLabel = (ROLES()[t.role] && ROLES()[t.role].label) || t.role;
          if (boss) ag.say(boss, '@' + roleLabel + ': ' + t.title, 3000);
          log('Boss', roleLabel, 'msg', '@' + roleLabel + ': ' + t.title);
          refreshBoard();
        }, stagger * idx);
      })(items[i], i);
    }

    // Resolve declared deps (plan indices) → child task ids. Self / out-of-range
    // / forward refs are dropped so we never deadlock.
    for (var c = 0; c < created.length; c++) {
      var ct = created[c];
      if (!ct._depPlanIdx) continue;
      var ids = [];
      for (var d = 0; d < ct._depPlanIdx.length; d++) {
        var pi = ct._depPlanIdx[d];
        if (typeof pi !== 'number') continue;
        if (pi === ct._depIndex) continue;             // no self-dep
        var depId = idxToId[pi];
        if (depId && depId !== ct.id) ids.push(depId);
      }
      // keep [] when deps were declared-but-empty (explicit parallel); _depPlanIdx
      // is null only when the plan omitted deps entirely (→ legacy fallback).
      ct._depIds = ids;
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
        // optional DAG deps: array of earlier-subtask indices this one needs.
        var deps = null;
        if (Array.isArray(it.deps)) {
          deps = [];
          for (var di = 0; di < it.deps.length; di++) {
            var dv = it.deps[di];
            if (typeof dv === 'number' && isFinite(dv)) deps.push(dv | 0);
          }
          // keep [] as an explicit "no deps" (→ runs in parallel); only an absent
          // it.deps stays null (→ legacy all-earlier-siblings serial fallback).
        }
        var verify = (typeof it.verify === 'boolean') ? it.verify : false;
        out.push({ role: role, title: title, instruction: instruction, needsWeb: needsWeb, deps: deps, verify: verify });
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
  function isTerminal(t) { return t && (t.status === 'done' || t.status === 'error'); }

  function depsSatisfied(task) {
    if (!task.parentId) return true;          // standalone tasks have no deps

    // DAG: if deps were DECLARED (array present, even empty), gate ONLY on those.
    // [] → no deps → runnable immediately (parallel wave). [i,..] → wait for them.
    if (Array.isArray(task._depIds)) {
      for (var d = 0; d < task._depIds.length; d++) {
        var dep = taskById(task._depIds[d]);
        if (dep && !isTerminal(dep)) return false;
      }
      return true;
    }

    // Back-compat: depend on ALL earlier siblings in the same plan.
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

    // (re)assignment clears any prior attention flag on this agent.
    clearAttention(agent);

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
    var toolList = [];
    if (wantWeb && CFG().WEB_SEARCH_TOOL) toolList.push(CFG().WEB_SEARCH_TOOL);

    // CLIENT TOOLS (Browser tools — calc/run_js/analyze_data). Anthropic-only; the
    //   server-side stream parser in api.js doesn't surface tool_use args, so we
    //   cannot run a true round-trip tool loop here. We EXPOSE the tools to the
    //   model (so models that can answer without calling a tool benefit from the
    //   schema/hint) and detect a tool_use stop gracefully (see startWorkerStream).
    //   This is the deliberate "minimal, robust" integration the contract allows.
    if (clientToolsApplicable(agent, settings)) {
      try {
        var specs = App.Tools.specs();
        if (Array.isArray(specs)) {
          for (var ti = 0; ti < specs.length; ti++) toolList.push(specs[ti]);
        }
      } catch (e) {}
    }
    var tools = toolList.length ? toolList : undefined;

    // No credentials path (defend; provider/companion-aware so GPT & companion work).
    if (!hasCredsFor(agent.model || settings.defaultModel)) {
      ag.say(agent, '🔑 add an API key (or enable the companion) in Settings', 4000);
      failTask(task, 'NO_KEY');
      return;
    }

    // Choreography: walk to desk, then set coding/searching and stream.
    ag.say(agent, truncate(task.title, 40), 3000);
    ag.goToFurniture(agent, 'desk', function () {
      ag.setState(agent, wantWeb ? 'searching' : 'coding');
      startWorkerStream(task, agent, [{ role: 'user', content: userContent }], tools, wantWeb, 0);
    });
  }

  // stopReasonOf(res) — pull stop_reason from the raw final stream event (Anthropic
  //   message_delta.delta.stop_reason). null for OpenAI / unknown.
  function stopReasonOf(res) {
    try {
      var raw = res && res.raw;
      if (raw && raw.delta && typeof raw.delta.stop_reason === 'string') return raw.delta.stop_reason;
    } catch (e) {}
    return null;
  }

  // startWorkerStream — one streamed turn for `task`. messages[] is the running
  //   conversation (mutated across the bounded tool loop). iter = tool-loop depth.
  function startWorkerStream(task, agent, messages, tools, wantWeb, iter) {
    var ag = AGENTS();
    var settings = STATE().settings || {};
    var roleDef = ROLES()[task.role] || {};
    var sys = agent.systemPrompt || roleDef.system || '';
    iter = iter || 0;
    var MAX_TOOL_ITERS = (CFG().MAX_TOOL_ITERS != null) ? CFG().MAX_TOOL_ITERS : 2;

    // accumulate text across loop iterations so partial answers aren't lost.
    if (typeof task._acc !== 'string') task._acc = '';
    var acc = '';
    var bubbleAccum = '';

    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,        // GPT-model worker support
      model: agent.model || settings.defaultModel,
      system: sys,
      messages: messages,
      tools: tools,
      onState: function (st) {
        if (st === 'searching') ag.setState(agent, 'searching');
        else if (st === 'text') ag.setState(agent, 'coding'); // first text → coding
      },
      onText: function (delta) {
        acc += delta;
        bubbleAccum += delta;
        ag.say(agent, bubbleAccum.slice(-60), 3000);
        markActivity(agent);   // recent-activity glow (drawn by pixelart.js)
        // Live transcript so clicking the worker shows progress.
        try { if (App.UI && App.UI.appendTranscript) App.UI.appendTranscript(agent.id, 'assistant', delta); } catch (e) {}
        // keep the board's running card text fresh occasionally
        task.result = task._acc + acc;
      },
      onDone: function (res) {
        if (res && res.usage) {
          agent.stats.tokensIn += (res.usage.input_tokens || 0);
          agent.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        task._acc += acc;

        // TOOL LOOP (real path) — only if a future api.js surfaces structured
        //   tool_use blocks on the result (res.toolUses [{id,name,input}]). Today's
        //   api.js does not, so this branch is normally skipped; it's forward-safe.
        var toolUses = res && Array.isArray(res.toolUses) ? res.toolUses : null;
        if (toolUses && toolUses.length && tools && tools.length && iter < MAX_TOOL_ITERS) {
          var s4 = STATE(); if (s4 && s4._activeStreams) delete s4._activeStreams[agent.id];
          var asstContent = [];
          if (acc && acc.trim()) asstContent.push({ type: 'text', text: acc });
          for (var tu = 0; tu < toolUses.length; tu++) {
            asstContent.push({ type: 'tool_use', id: toolUses[tu].id, name: toolUses[tu].name, input: toolUses[tu].input });
          }
          executeToolUses(toolUses, agent).then(function (results) {
            var next = messages.slice();
            next.push({ role: 'assistant', content: asstContent });
            next.push({ role: 'user', content: results });
            startWorkerStream(task, agent, next, tools, wantWeb, iter + 1);
          }, function () {
            // tool execution failed wholesale → finalize with what we have.
            var t0 = task._acc || acc || ''; task._acc = '';
            if (t0 && t0.trim()) onWorkerResult(task, t0); else failTask(task, '(tool loop failed)');
          });
          return;
        }

        // TOOL LOOP (fallback) — the model wanted to call a client tool but api.js
        //   does not surface tool_use arguments/ids through its stream, so we cannot
        //   execute a true tool_result round-trip. Robust fallback: nudge the model
        //   to inline-compute (it already has its reasoning) and re-run once. Bounded.
        if (stopReasonOf(res) === 'tool_use' && tools && tools.length && iter < MAX_TOOL_ITERS) {
          try { log(agent.name || agent.role, 'tool', 'tool', '🔧 wanted a tool — asking for an inline answer'); } catch (e) {}
          var follow = messages.slice();
          if (acc && acc.trim()) follow.push({ role: 'assistant', content: acc });
          follow.push({
            role: 'user',
            content: 'Tool execution is unavailable in this environment. Please complete the task by reasoning it out directly and provide the final answer inline (do not call any tools).',
          });
          var s3 = STATE(); if (s3 && s3._activeStreams) delete s3._activeStreams[agent.id];
          // re-stream WITHOUT tools so it answers directly.
          startWorkerStream(task, agent, follow, undefined, wantWeb, iter + 1);
          return;
        }

        var text = task._acc || (res && res.text) || '';
        task._acc = '';
        if (!text || !text.trim()) {
          failTask(task, '(empty result)');
          return;
        }
        onWorkerResult(task, text);
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

  // depResults(task) — the done results of this task's DECLARED deps, else (fallback)
  // earlier siblings. Returns Task[] in dependency/order.
  function depResults(task) {
    var out = [];
    if (!task || !task.parentId) return out;
    if (Array.isArray(task._depIds)) {   // declared deps (incl. [] → no upstream context)
      for (var d = 0; d < task._depIds.length; d++) {
        var dep = taskById(task._depIds[d]);
        if (dep && dep.status === 'done' && dep.result) out.push(dep);
      }
      return out;
    }
    if (typeof task._depIndex !== 'number') return out;
    var sibs = childrenOf(task.parentId).filter(function (s) {
      return typeof s._depIndex === 'number' && s._depIndex < task._depIndex && s.status === 'done' && s.result;
    });
    sibs.sort(function (a, b) { return a._depIndex - b._depIndex; });
    return sibs;
  }

  // buildWorkerUserContent — persona + relevant memory + dep results + instruction
  //   (+ QA feedback on retry) + the artifact-emission hint.
  function buildWorkerUserContent(task) {
    var parts = [];
    var agent = AGENTS() && AGENTS().byId ? AGENTS().byId(task.assignee) : null;

    var persona = personaBlock(agent);
    if (persona) { parts.push(persona); parts.push(''); }

    var mem = memoryBlock(agent, (task.desc || '') + ' ' + (task.title || ''));
    if (mem) { parts.push(mem); parts.push(''); }

    var deps = depResults(task);
    if (deps.length) {
      parts.push('CONTEXT — results from earlier subtasks you can build on:');
      for (var i = 0; i < deps.length; i++) {
        var roleLabel = (ROLES()[deps[i].role] && ROLES()[deps[i].role].label) || deps[i].role;
        parts.push('[' + roleLabel + ' — ' + deps[i].title + ']\n' + deps[i].result);
      }
      parts.push('');
    }

    parts.push('YOUR TASK:\n' + task.desc);

    // QA feedback from a previous failed review → tell the worker to fix it.
    if (task._feedback) {
      parts.push('');
      parts.push('REVISION REQUIRED — a reviewer rejected your previous attempt. Address this specific feedback and re-deliver the corrected result:\n' + task._feedback);
    }

    // Artifact-emission hint (config-owned; guarded fallback).
    var hint = CFG().WORKER_ARTIFACT_HINT;
    if (hint) { parts.push(''); parts.push(String(hint)); }

    return parts.join('\n');
  }

  // ===========================================================================
  // onWorkerResult — a worker stream produced `text`. Extract artifacts, write a
  //   memory, then either run a QA review (verify tasks) or finalize terminal.
  // ===========================================================================
  function onWorkerResult(task, text) {
    var ag = AGENTS();
    var agent = ag && ag.byId ? ag.byId(task.assignee) : null;

    // 1) Artifacts: parse fenced blocks (dedupe by name+taskId → overwrite on retry).
    try { pushArtifacts(parseArtifacts(text, task, agent)); } catch (e) {}

    // 2) Memory: remember what this agent just did.
    try {
      if (agent && ag && ag.addMemory) {
        var summ = resultLine(text) || task.title || 'completed a task';
        ag.addMemory(agent, summ, importanceHeuristic(task, text));
      }
    } catch (e) {}

    // Stash the produced text so QA / finalize can use it.
    task.result = text;

    // 3) QA loop: a verify task isn't terminal until it PASSes (or retries exhaust).
    if (task.verify && !task._qaDone && CFG().QA_REVIEW_SYSTEM) {
      runQAReview(task, text, agent);
      return;
    }

    finishTask(task, text);
  }

  // runQAReview — stream a QA verdict; PASS → finalize, FAIL → retry (bounded).
  function runQAReview(task, text, worker) {
    var ag = AGENTS();
    var settings = STATE().settings || {};

    // Pick the QA role/agent model (haiku by default). Reuse the same creds rules.
    var qaRole = ROLES().qa || {};
    var qaAgent = (ag && ag.byRole) ? (ag.byRole('qa') || [])[0] : null;
    var qaModel = (qaAgent && qaAgent.model) || qaRole.model || CFG().FAST_MODEL || settings.defaultModel;

    // No creds for QA → skip review gracefully (finalize as-is; never deadlock).
    if (!hasCredsFor(qaModel)) { finishTask(task, text); return; }

    var sys = CFG().QA_REVIEW_SYSTEM;
    var artifactText = qaReviewContent(task, text);
    log('QA', (worker ? worker.name : task.role), 'msg', '🔍 reviewing: ' + truncate(task.title, 40));
    if (qaAgent) { try { ag.say(qaAgent, '🔍 reviewing…', 3000); } catch (e) {} }

    var acc = '';
    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,
      model: qaModel,
      system: sys,
      messages: [{ role: 'user', content: artifactText }],
      onText: function (d) { acc += d; },
      onDone: function (res) {
        var verdict = (res && res.text) || acc || '';
        var line = resultLine(verdict) || verdict;
        var pass = /\bPASS\b/i.test(line) && !/\bFAIL\b/i.test(line);
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__qa_' + task.id];
        if (pass) {
          log('QA', 'Boss', 'result', '✓ PASS: ' + truncate(task.title, 40));
          task._qaDone = true;
          finishTask(task, text);
        } else {
          var feedback = extractFeedback(line) || extractFeedback(verdict) || 'address correctness/completeness issues';
          if ((task._retries || 0) < (CFG().QA_MAX_RETRIES || 2)) {
            task._retries = (task._retries || 0) + 1;
            task._feedback = feedback;
            log('QA', (worker ? worker.name : task.role), 'msg', '✗ FAIL → revise (' + task._retries + '): ' + truncate(feedback, 60));
            // release the worker and re-queue for another attempt.
            if (worker) {
              try {
                worker.busy = false; worker.currentTaskId = null;
                ag.setState(worker, 'idle');
                ag.say(worker, '✍ revising…', 3000);
                var s3 = STATE(); if (s3 && s3._activeStreams) delete s3._activeStreams[worker.id];
              } catch (e) {}
            }
            task.status = 'queued';
            task.assignee = null;
            refreshBoard();
            saveSoon();
          } else {
            // retries exhausted → accept the last result, note QA done.
            log('QA', 'Boss', 'result', '⚠ FAIL but retries exhausted — accepting: ' + truncate(task.title, 40));
            task._qaDone = true;
            finishTask(task, text);
          }
        }
      },
      onError: function (err) {
        // QA review itself failed → don't deadlock; accept the worker result.
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__qa_' + task.id];
        log('QA', 'Boss', 'system', 'QA review error — accepting result: ' + ((err && err.message) || 'error'));
        task._qaDone = true;
        finishTask(task, text);
      },
    });
    var s = STATE(); if (s && s._activeStreams) s._activeStreams['__qa_' + task.id] = handle;
  }

  // qaReviewContent — what the reviewer reads: the deliverable + its instruction.
  function qaReviewContent(task, text) {
    var parts = [];
    parts.push('TASK INSTRUCTION:\n' + (task.desc || task.title || ''));
    parts.push('');
    parts.push('WORKER DELIVERABLE TO REVIEW:\n' + String(text || ''));
    return parts.join('\n');
  }

  // extractFeedback — pull the actionable part after "FAIL —" / "FAIL:".
  function extractFeedback(s) {
    if (!s) return '';
    var m = String(s).match(/FAIL\s*[—\-:]\s*(.+)$/im);
    return m ? m[1].trim() : '';
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
      clearAttention(agent);
      nudgeMood(agent, 0.06);   // satisfaction from finishing work
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
      nudgeMood(agent, -0.07);   // frustration from a failed task
      // Flag for the user: no-key / rate-limit (429) / any API error.
      raiseAttention(agent);
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
  // WATERCOOLER — sparse idle banter between two non-boss agents.
  //   Cooldown-gated, non-blocking. Canned lines by default; ONE batched LLM call
  //   when settings.liveChatter && creds. Writes the topic to both memories.
  // ===========================================================================
  var _lastChatter = 0;       // in state._time seconds
  var _chatterActive = false;

  function idleNonBoss() {
    var s = STATE(), out = [];
    if (!s || !Array.isArray(s.agents)) return out;
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (!a || a.role === 'boss') continue;
      if (a.state !== 'idle') continue;
      if (agentBusy(a)) continue;
      if (a._attention) continue;
      out.push(a);
    }
    return out;
  }

  function chatterLineFor(role) {
    var C = CFG().CHATTER_LINES || {};
    var pool = [];
    try {
      if (C.byRole && C.byRole[role] && C.byRole[role].length) pool = pool.concat(C.byRole[role]);
      if (C.generic && C.generic.length) pool = pool.concat(C.generic);
    } catch (e) {}
    if (!pool.length) pool = ['nice work team', 'coffee time? ☕', 'how was your weekend?', 'good sync 🤝'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function maybeWatercooler() {
    try {
      var s = STATE();
      if (!s) return;
      if (_chatterActive) return;
      if (!queueIsEmpty()) return;
      if (s._meetingActive) return;
      var cd = (CFG().CHATTER_COOLDOWN_MS || 25000) / 1000;
      if ((s._time - _lastChatter) < cd) return;

      var pool = idleNonBoss();
      if (pool.length < 2) return;

      // pick 2 distinct — prefer a higher-affinity pairing (still some randomness).
      var a = pool[Math.floor(Math.random() * pool.length)];
      var b = null;
      var rest = [];
      for (var ri = 0; ri < pool.length; ri++) { if (pool[ri] !== a) rest.push(pool[ri]); }
      if (!rest.length) return;
      if (Math.random() < 0.6) {
        // affinity-weighted: pick the peer 'a' likes most (ties → random).
        var best = rest[0], bestAff = affinity(a, rest[0]);
        for (var rj = 1; rj < rest.length; rj++) {
          var af = affinity(a, rest[rj]);
          if (af > bestAff || (af === bestAff && Math.random() < 0.5)) { best = rest[rj]; bestAff = af; }
        }
        b = best;
      } else {
        b = rest[Math.floor(Math.random() * rest.length)];
      }
      if (!b || a === b) return;

      _lastChatter = s._time;
      _chatterActive = true;
      startWatercooler(a, b);
    } catch (e) { _chatterActive = false; }
  }

  function startWatercooler(a, b) {
    var ag = AGENTS();
    var settings = STATE().settings || {};

    // Walk both to adjacent break/meeting spots.
    var spots = (WORLD() && WORLD().breakSpots) ? WORLD().breakSpots() : [];
    if ((!spots || spots.length < 2) && WORLD() && WORLD().meetingSeats) spots = WORLD().meetingSeats();
    spots = spots || [];

    var arrived = 0;
    function onArrive() {
      arrived++;
      if (arrived < 2) return;
      // Both in place → run the exchange.
      if (settings.liveChatter && hasCredsFor((a.model || settings.defaultModel))) {
        liveChatter(a, b);
      } else {
        cannedChatter(a, b);
      }
    }

    try {
      if (spots[0]) ag.goToCell(a, spots[0].gx, spots[0].gy, onArrive); else onArrive();
      if (spots[1]) ag.goToCell(b, spots[1].gx, spots[1].gy, onArrive); else onArrive();
    } catch (e) { cannedChatter(a, b); }
  }

  function cannedChatter(a, b) {
    var ag = AGENTS();
    var pair = [a, b];
    var turns = 2 + Math.floor(Math.random() * 3); // 2-4 turns
    var i = 0;
    var topicLine = null;
    function step() {
      try {
        if (i >= turns) { endWatercooler(a, b, topicLine); return; }
        var sp = pair[i % 2];
        var line = chatterLineFor(sp.role);
        if (!topicLine) topicLine = line;
        ag.say(sp, line, 3200);
        log(sp.name || sp.role, 'all', 'msg', line);
        i++;
        setTimeout(step, 1600 + Math.floor(Math.random() * 900));
      } catch (e) { endWatercooler(a, b, topicLine); }
    }
    step();
  }

  function liveChatter(a, b) {
    var ag = AGENTS();
    var settings = STATE().settings || {};
    var aLabel = (ROLES()[a.role] && ROLES()[a.role].label) || a.role;
    var bLabel = (ROLES()[b.role] && ROLES()[b.role].label) || b.role;
    var sys = "You are scripting a SHORT, light office watercooler exchange between two coworkers at an AI software company. " +
      "Keep it casual and brief: 2-4 total lines, alternating speakers, <=12 words each. No work assignments. " +
      "Output ONLY lines in the form 'NAME: text', nothing else.";
    var content = "Speaker A is " + (a.name || aLabel) + " (" + aLabel + "). Speaker B is " + (b.name || bLabel) + " (" + bLabel + "). Write their quick break-room chat.";

    var acc = '';
    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,
      model: (a.model || settings.defaultModel || CFG().FAST_MODEL),
      system: sys,
      messages: [{ role: 'user', content: content }],
      onText: function (d) { acc += d; },
      onDone: function (res) {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__chatter'];
        var txt = (res && res.text) || acc || '';
        playScriptedChatter(a, b, txt);
      },
      onError: function () {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__chatter'];
        cannedChatter(a, b); // graceful fallback
      },
    });
    var s = STATE(); if (s && s._activeStreams) s._activeStreams['__chatter'] = handle;
  }

  function playScriptedChatter(a, b, txt) {
    var ag = AGENTS();
    var lines = String(txt || '').split(/\n+/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l; }).slice(0, 4);
    if (!lines.length) { cannedChatter(a, b); return; }
    var pair = [a, b];
    var i = 0, topicLine = null;
    function step() {
      try {
        if (i >= lines.length) { endWatercooler(a, b, topicLine); return; }
        var raw = lines[i];
        var sp = pair[i % 2];
        var line = raw.replace(/^[^:]{0,24}:\s*/, '');   // drop "Name:" prefix if present
        if (!topicLine) topicLine = line;
        ag.say(sp, truncate(line, 60), 3200);
        log(sp.name || sp.role, 'all', 'msg', truncate(line, 80));
        i++;
        setTimeout(step, 1700 + Math.floor(Math.random() * 900));
      } catch (e) { endWatercooler(a, b, topicLine); }
    }
    step();
  }

  function endWatercooler(a, b, topicLine) {
    try {
      var ag = AGENTS();
      // remember the chat (low importance).
      if (topicLine && ag && ag.addMemory) {
        try { ag.addMemory(a, 'watercooler: ' + truncate(topicLine, 80), 1); } catch (e) {}
        try { ag.addMemory(b, 'watercooler: ' + truncate(topicLine, 80), 1); } catch (e) {}
      }
      // subtle bonding from a friendly chat.
      try { bondParticipants([a, b], 0.03, 0.05); } catch (e) {}
      // return both to desks if still idle & free.
      [a, b].forEach(function (agt) {
        if (!agt) return;
        if (agentBusy(agt)) return;
        var hx = (typeof agt.homeGx === 'number') ? agt.homeGx : agt.gx;
        var hy = (typeof agt.homeGy === 'number') ? agt.homeGy : agt.gy;
        ag.goToCell(agt, hx, hy, (function (x) {
          return function () { if (!agentBusy(x)) ag.setState(x, 'idle'); };
        })(agt));
      });
    } catch (e) {}
    _chatterActive = false;
  }

  // ===========================================================================
  // PRE-SYNTHESIS PIPELINE — adaptive replan → group debate → approval gate →
  //   synthesize. Each phase is OPTIONAL (config-gated) and creds-guarded; if a
  //   phase is off/unavailable we fall straight through to the next. Re-entrancy
  //   is guarded by root._gating + per-phase done-flags so tick() can call this
  //   repeatedly without double-firing. Never throws.
  // ===========================================================================
  function gatherWorkerResults(root) {
    var kids = childrenOf(root.id);
    kids.sort(function (a, b) {
      var ai = (typeof a._depIndex === 'number') ? a._depIndex : 0;
      var bi = (typeof b._depIndex === 'number') ? b._depIndex : 0;
      return ai - bi;
    });
    var parts = [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var roleLabel = (ROLES()[k.role] && ROLES()[k.role].label) || k.role;
      var body = (k.status === 'done' && k.result) ? k.result
        : ('(this subtask did not complete: ' + (k.error || 'no result') + ')');
      parts.push('[' + roleLabel + ' — ' + k.title + ']\n' + body);
    }
    return parts.join('\n\n');
  }

  function bossModelFor() {
    var settings = (STATE() && STATE().settings) || {};
    var boss = ensureBoss();
    return (boss && boss.model) || settings.bossModel || CFG().BOSS_MODEL;
  }

  // prepareSynthesis(root) — orchestrate the optional pre-synth phases, then synth.
  function prepareSynthesis(root) {
    try {
      if (!root || root._synthStarted) return;
      if (root._gating) return;             // a phase async-call is in flight
      // PHASE 1 — adaptive replan (once).
      if (CFG().ENABLE_REPLAN && !root._replanned) {
        root._gating = true;
        runReplanPhase(root, function (added) {
          root._gating = false;
          root._replanned = true;
          // If new children were added, return; tick() will re-enter once they finish.
          if (!added) prepareSynthesis(root);
          // (if added>0, the new queued tasks are picked up next tick; when all
          //  terminal again, checkRootsForSynthesis → prepareSynthesis runs phase 2.)
        });
        return;
      }
      // PHASE 2 — group debate / critique (once).
      if (CFG().ENABLE_DEBATE && !root._debated) {
        root._gating = true;
        runDebatePhase(root, function () {
          root._gating = false;
          root._debated = true;
          prepareSynthesis(root);
        });
        return;
      }
      // PHASE 3 — human approval gate (optional, default off).
      if (CFG().ENABLE_APPROVAL && !root._approved && App.UI && typeof App.UI.openApproval === 'function') {
        root._gating = true;
        runApprovalPhase(root, function (proceed) {
          root._gating = false;
          if (proceed) { root._approved = true; prepareSynthesis(root); }
          // if !proceed: runApprovalPhase already handled revise(re-queue)/reject(error).
        });
        return;
      }
      // All gates passed → synthesize.
      Orchestrator.synthesize(root);
    } catch (e) {
      // Never block delivery on a gate failure.
      try { Orchestrator.synthesize(root); } catch (e2) {}
    }
  }

  // runReplanPhase — one Boss call: should we add more subtasks? cb(addedCount).
  function runReplanPhase(root, cb) {
    var settings = (STATE() && STATE().settings) || {};
    var model = bossModelFor();
    var sys = CFG().BOSS_REPLAN_SYSTEM;
    if (!sys || !hasCredsFor(model)) { cb(0); return; }

    var boss = ensureBoss();
    var content = "USER'S ORIGINAL GOAL:\n" + (root.desc || '') +
      "\n\nWORKER RESULTS SO FAR:\n" + gatherWorkerResults(root) +
      "\n\nDecide whether more subtasks are needed. Reply with the strict JSON described in your instructions.";
    var acc = '';
    var done = false;
    function finish(added) { if (done) return; done = true; cb(added || 0); }
    try { log('Boss', 'system', 'system', '🔄 reviewing results (replan)…'); } catch (e) {}

    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,
      model: model,
      system: sys,
      messages: [{ role: 'user', content: content }],
      onText: function (d) { acc += d; },
      onDone: function (res) {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__boss_replan'];
        if (boss && res && res.usage) {
          boss.stats.tokensIn += (res.usage.input_tokens || 0);
          boss.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        var decision = parseReplanDecision((res && res.text) || acc);
        if (decision && decision.action === 'replan' && decision.newSubtasks && decision.newSubtasks.length) {
          var n = addReplanSubtasks(root, decision.newSubtasks);
          if (n > 0) {
            try { log('Boss', 'all', 'system', '🔄 adding ' + n + ' follow-up task' + (n === 1 ? '' : 's') + (decision.reason ? ': ' + truncate(decision.reason, 60) : '')); } catch (e) {}
            if (boss) { try { AGENTS().say(boss, '🔄 a bit more work…', 3000); } catch (e) {} }
            refreshBoard(); saveSoon();
          }
          finish(n);
        } else {
          finish(0);
        }
      },
      onError: function () {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__boss_replan'];
        finish(0);
      },
    });
    var s = STATE(); if (s && s._activeStreams) s._activeStreams['__boss_replan'] = handle;
  }

  // parseReplanDecision — tolerant JSON parse → {action,newSubtasks,reason}|null.
  function parseReplanDecision(raw) {
    try {
      if (!raw) return null;
      var s = String(raw).replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/i, '');
      var first = s.indexOf('{'), last = s.lastIndexOf('}');
      if (first === -1 || last === -1 || last < first) return null;
      var body = s.slice(first, last + 1).replace(/,(\s*[}\]])/g, '$1')
        .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      var obj = null;
      try { obj = JSON.parse(body); }
      catch (e) { var bal = braceBalancedPrefix(body); if (bal) { try { obj = JSON.parse(bal); } catch (e2) {} } }
      if (!obj || typeof obj !== 'object') return null;
      var action = (obj.action === 'replan') ? 'replan' : 'finish';
      var list = [];
      if (Array.isArray(obj.newSubtasks)) {
        for (var i = 0; i < obj.newSubtasks.length; i++) {
          var it = obj.newSubtasks[i];
          if (!it || typeof it !== 'object') continue;
          if (it.instruction == null || String(it.instruction).trim() === '') continue;
          list.push(it);
          if (list.length >= 4) break;
        }
      }
      return { action: action, newSubtasks: list, reason: (typeof obj.reason === 'string' ? obj.reason : '') };
    } catch (e) { return null; }
  }

  // addReplanSubtasks — append new children to an existing root; deps reference
  //   ONLY pre-existing siblings by their order index in this round are ignored
  //   (kept simple: new tasks have no inter-deps → run as a parallel follow-up wave).
  function addReplanSubtasks(root, items) {
    var s = STATE();
    if (!s || !Array.isArray(s.tasks)) return 0;
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var role = (ROLES()[it.role]) ? it.role : 'generalist';
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
        createdAt: nowMs() + i,
        role: role,
        needsWeb: (typeof it.needsWeb === 'boolean') ? it.needsWeb
          : !!(ROLES()[role] && ROLES()[role].webSearchPreferred),
        _depIndex: 1000 + i,    // after the original wave
        _depPlanIdx: null,
        _depIds: [],            // explicit no-deps → parallel follow-up wave
        verify: !!it.verify,
        _retries: 0,
        _qaDone: false,
        _feedback: null,
        _ctrl: null,
      };
      s.tasks.push(t);
      root.subtaskIds.push(t.id);
      n++;
    }
    return n;
  }

  // runDebatePhase — one batched critique call; appends critique notes to the root
  //   for the synthesizer to consider. cb() always called (creds-guarded skip).
  function runDebatePhase(root, cb) {
    var settings = (STATE() && STATE().settings) || {};
    var model = bossModelFor();
    var sys = CFG().DEBATE_SYSTEM;
    if (!sys || !hasCredsFor(model)) { cb(); return; }

    var boss = ensureBoss();
    var content = "USER'S ORIGINAL GOAL:\n" + (root.desc || '') +
      "\n\nPEER RESULTS TO CRITIQUE:\n" + gatherWorkerResults(root) +
      "\n\nProvide concise, actionable improvement notes.";
    var acc = '';
    var done = false;
    function finish() { if (done) return; done = true; cb(); }
    try { log('Boss', 'all', 'system', '💬 team critique round…'); } catch (e) {}

    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,
      model: model,
      system: sys,
      messages: [{ role: 'user', content: content }],
      onText: function (d) { acc += d; },
      onDone: function (res) {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__boss_debate'];
        if (boss && res && res.usage) {
          boss.stats.tokensIn += (res.usage.input_tokens || 0);
          boss.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        var notes = ((res && res.text) || acc || '').trim();
        if (notes) {
          root._debateNotes = notes;
          try { log('QA', 'Boss', 'msg', '💬 critique: ' + truncate(notes, 80)); } catch (e) {}
        }
        finish();
      },
      onError: function () {
        var s2 = STATE(); if (s2 && s2._activeStreams) delete s2._activeStreams['__boss_debate'];
        finish();
      },
    });
    var s = STATE(); if (s && s._activeStreams) s._activeStreams['__boss_debate'] = handle;
  }

  // runApprovalPhase — ask the user to approve the about-to-be-delivered work.
  //   cb(proceed:boolean). On 'revise:<text>' we re-queue a follow-up task with the
  //   feedback and DON'T proceed (cb(false)); on 'reject' we mark the root error.
  function runApprovalPhase(root, cb) {
    var payload = {
      title: root.title,
      goal: root.desc,
      results: gatherWorkerResults(root),
    };
    var p;
    try { p = App.UI.openApproval(payload); } catch (e) { cb(true); return; }
    if (!p || typeof p.then !== 'function') { cb(true); return; }
    p.then(function (decision) {
      decision = String(decision || 'approve');
      if (decision === 'approve') { cb(true); return; }
      if (decision.indexOf('revise') === 0) {
        var fb = '';
        var ci = decision.indexOf(':');
        if (ci >= 0) fb = decision.slice(ci + 1).trim();
        var n = addReplanSubtasks(root, [{
          role: 'generalist',
          title: 'Revise per feedback',
          instruction: 'Revise the delivered work to address this user feedback:\n' + (fb || '(no specifics given — improve overall quality)') +
            '\n\nPrior combined results:\n' + gatherWorkerResults(root),
        }]);
        // allow another approval round after the revision lands.
        root._approved = false;
        if (n > 0) { try { log('user', 'Boss', 'msg', '✏ revise: ' + truncate(fb, 60)); } catch (e) {} refreshBoard(); saveSoon(); }
        cb(false);
        return;
      }
      // reject
      root.status = 'error';
      root.error = 'rejected by user';
      root._synthStarted = true;
      try { log('user', 'Boss', 'error', 'delivery rejected.'); } catch (e) {}
      refreshBoard();
      try { if (App.UI && App.UI.showFinalResult) App.UI.showFinalResult(root); } catch (e) {}
      cb(false);
    }, function () { cb(true); });
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
        // Push the final answer as an Artifact (overwrite per root on re-run).
        try {
          pushArtifacts([{
            name: 'final-answer.md', type: 'markdown',
            content: rootTask.result,
            taskId: rootTask.id, agentId: boss ? boss.id : null,
          }]);
        } catch (e) {}
        // Boss remembers the outcome.
        try {
          if (boss && ag.addMemory) ag.addMemory(boss, 'Delivered: ' + truncate(rootTask.title, 80), 6);
        } catch (e) {}
        // RELATIONSHIPS/MOOD: a successful sync bonds the team + lifts spirits.
        try { bondParticipants(participants, 0.06, 0.05); } catch (e) {}
        if (boss) {
          boss.busy = false;
          ag.setState(boss, 'idle');
          ag.say(boss, 'Done ✓', 4000);
          clearAttention(boss);
        }
        // disperse participants back to their desks; send the boss home too.
        disperse(participants, boss);
        if (boss) ag.returnHome(boss);
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
        try { if (App.UI && App.UI.notifyDone) App.UI.notifyDone(rootTask); } catch (e) {}
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
        if (boss) ag.returnHome(boss);
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
    var boss = (AGENTS() && AGENTS().byRole) ? (AGENTS().byRole('boss') || [])[0] : null;
    var persona = personaBlock(boss);
    if (persona) { parts.push(persona); parts.push(''); }
    var mem = memoryBlock(boss, rootTask.desc || rootTask.title || '');
    if (mem) { parts.push(mem); parts.push(''); }
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
    // GROUP DEBATE notes (if a critique round ran) — let synthesis act on them.
    if (rootTask._debateNotes) {
      parts.push('\nTEAM CRITIQUE NOTES (address these where valid):\n' + rootTask._debateNotes);
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

      var maxConc = CFG().MAX_CONCURRENT || 3;

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

      // 4) watercooler: sparse idle banter when nothing is queued/running.
      maybeWatercooler();
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
        prepareSynthesis(root);
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
