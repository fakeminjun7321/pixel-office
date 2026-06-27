// =============================================================================
// agents.js  →  App.Agents
// PIXEL AI COMPANY ("NEON//WORKS") — agent factory, simulation, draw, direct chat.
//
// Authority: SPEC.md §3.1 (Agent shape), §7.5 (signatures), §6.5 (task↔state map),
//            §5.4 (sprite anchors), §10 (error behaviors), §7.10 (compat aliases).
//
// Contract notes (PINNED):
//   - create(spec) resolves model/color/systemPrompt/gx,gy from ROLES + World;
//     pushes to state.agents; does NOT save (caller saves).
//   - update(dt) advances ALL agents (path-follow, facing, anim, bob, bubble
//     expiry, temp cull). Per-agent try/catch — one bad agent never freezes others.
//     When paused: only bubble expiry runs; no movement/state sim.
//   - draw(ctx) y-sorted; uses World.worldToScreen ITSELF (main has NOT pre-applied
//     a camera transform). Feet anchor = cell-center-bottom in screen px.
//   - setState is the ONLY mutator of agent.state; resets anim.frame on pose-class
//     change and updates facing toward the relevant furniture.
//   - goToCell / goToFurniture path via World.findPath (object form); fire onArrive
//     once when the path empties.
//   - chat(agent, text) = DIRECT single-agent chat (no orchestration).
//   - Classic <script>; no import/export. Attaches to window.App. Defensive.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  // Lazy resolvers (load order: config first, main last; everything else may vary).
  function CFG()   { return App.config || {}; }
  function STATE() { return App.state; }
  function WORLD() { return App.World; }
  function PA()    { return App.PixelArt; }
  function ROLES() { return (App.config && App.config.ROLES) || {}; }

  function pal() {
    var c = CFG();
    return (c.palette) || (App.PixelArt && App.PixelArt.palette) || {};
  }
  function uid(p) {
    return (App.util && App.util.uid) ? App.util.uid(p)
      : (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function truncate(s, n) {
    if (App.util && App.util.truncate) return App.util.truncate(s, n);
    s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function nowMs() { return Date.now(); }

  // Pose classes — anim.frame resets when an agent crosses between these.
  // SPEC §6.5: setState resets anim.frame on "pose-class change".
  function poseClass(state) {
    if (state === 'walking') return 'walk';
    if (state === 'coding' || state === 'searching') return 'sit';
    return 'stand'; // idle / thinking / meeting / coffee
  }

  var Agents = {};

  // ===========================================================================
  // FACTORY — create / remove / lookups
  // ===========================================================================

  // create(spec) → Agent. spec={name, role, model?, color?, gx?, gy?, systemPrompt?, temp?}
  Agents.create = function (spec) {
    spec = spec || {};
    var s = STATE();
    var roles = ROLES();
    var role = (spec.role && roles[spec.role]) ? spec.role : (spec.role || 'generalist');
    var rdef = roles[role] || {};
    var settings = (s && s.settings) || {};

    var model = spec.model ||
      (role === 'boss' ? settings.bossModel : settings.defaultModel) ||
      rdef.model || (CFG().DEFAULT_MODEL || 'claude-sonnet-4-6');

    var color = spec.color || rdef.color || pal().purple || '#9b5cff';
    var systemPrompt = spec.systemPrompt || rdef.system || '';

    // Resolve home cell.
    var gx = (typeof spec.gx === 'number') ? spec.gx : null;
    var gy = (typeof spec.gy === 'number') ? spec.gy : null;
    if (gx === null || gy === null) {
      var free = null;
      try { if (WORLD() && WORLD().freeDeskCell) free = WORLD().freeDeskCell(); } catch (e) {}
      if (free) { gx = free.gx; gy = free.gy; }
      else { gx = (gx === null ? 1 : gx); gy = (gy === null ? 1 : gy); }
    }
    var center = cellCenter(gx, gy);

    var agent = {
      id: uid('a'),
      name: spec.name || (role.charAt(0).toUpperCase() + role.slice(1)),
      role: role,
      model: model,
      systemPrompt: systemPrompt,
      color: color,
      gx: gx, gy: gy,
      homeGx: gx, homeGy: gy,   // permanent desk seat (gx/gy get mutated as the agent walks)
      x: center.x, y: center.y,
      path: [],
      facing: 'down',
      state: 'idle',
      anim: { frame: 0, t: 0 },
      bubble: null,
      conversation: [],
      currentTaskId: null,
      stats: { tasksDone: 0, tokensIn: 0, tokensOut: 0 },
      busy: false,
      temp: !!spec.temp,
      _idleSince: nowMs(),
      _onArrive: null,
    };

    if (s && Array.isArray(s.agents)) s.agents.push(agent);
    return agent;
  };

  // remove(agentId) — abort its stream, free desk implicitly, drop, clear selection.
  Agents.remove = function (agentId) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents)) return;
    // abort any in-flight stream for this agent
    try {
      if (s._activeStreams && s._activeStreams[agentId]) {
        var h = s._activeStreams[agentId];
        if (h && typeof h.abort === 'function') h.abort();
        delete s._activeStreams[agentId];
      }
    } catch (e) {}
    for (var i = 0; i < s.agents.length; i++) {
      if (s.agents[i] && s.agents[i].id === agentId) {
        s.agents.splice(i, 1);
        break;
      }
    }
    if (s.selectedAgentId === agentId) {
      s.selectedAgentId = null;
      try { if (App.UI && App.UI.closeAgentPanel) App.UI.closeAgentPanel(); } catch (e) {}
    }
  };

  Agents.byId = function (agentId) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents)) return null;
    for (var i = 0; i < s.agents.length; i++) {
      if (s.agents[i] && s.agents[i].id === agentId) return s.agents[i];
    }
    return null;
  };

  Agents.byRole = function (role) {
    var s = STATE(), out = [];
    if (!s || !Array.isArray(s.agents)) return out;
    for (var i = 0; i < s.agents.length; i++) {
      if (s.agents[i] && s.agents[i].role === role) out.push(s.agents[i]);
    }
    return out;
  };

  // findIdle(role) → first idle && !busy && role-match agent, else null.
  Agents.findIdle = function (role) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents)) return null;
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (a && a.role === role && a.state === 'idle' && !a.busy) return a;
    }
    return null;
  };

  // ===========================================================================
  // STATE MACHINE
  // ===========================================================================

  // setState(agent, s) — ONLY mutator of agent.state. Resets anim.frame on
  // pose-class change; updates facing toward the relevant furniture.
  Agents.setState = function (agent, st) {
    if (!agent) return;
    var STATES = (CFG().STATES) || ['idle', 'walking', 'thinking', 'coding', 'searching', 'meeting', 'coffee'];
    if (STATES.indexOf(st) === -1) st = 'idle'; // 'error' is NOT a state (badge only)

    var prevPose = poseClass(agent.state);
    var nextPose = poseClass(st);
    agent.state = st;
    if (prevPose !== nextPose) {
      if (!agent.anim) agent.anim = { frame: 0, t: 0 };
      agent.anim.frame = 0;
      agent.anim.t = 0;
    }
    if (st === 'idle') agent._idleSince = nowMs();

    // Face the relevant furniture for seated/meeting poses.
    try {
      if (st === 'coding' || st === 'searching') {
        faceFurnitureAtSeat(agent);            // face the desk monitor
      } else if (st === 'meeting') {
        faceMeetingCenter(agent);
      }
    } catch (e) {}
  };

  // say(agent, text [, ms]) — set a speech bubble.
  Agents.say = function (agent, text, ms) {
    if (!agent) return;
    var dur = (typeof ms === 'number') ? ms : (CFG().BUBBLE_MS || 4500);
    agent.bubble = { text: truncate(String(text == null ? '' : text), 64), until: nowMs() + dur };
  };

  // ===========================================================================
  // MOVEMENT
  // ===========================================================================

  // goToCell(agent, gx, gy [, onArrive]) — path & walk; fire onArrive on empty path.
  Agents.goToCell = function (agent, gx, gy, onArrive) {
    if (!agent) return;
    var w = WORLD();
    var start = { gx: agent.gx, gy: agent.gy };
    var goal = { gx: gx, gy: gy };

    // Already there?
    if (agent.gx === gx && agent.gy === gy) {
      agent.path = [];
      agent._onArrive = null;
      if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
      return;
    }

    var path = null;
    try { if (w && w.findPath) path = w.findPath(start, goal); } catch (e) { path = null; }

    if (!path) {
      // Unreachable desk — stay idle at current cell; log; no infinite loop. (§10)
      try {
        if (App.Store && App.Store.pushLog) {
          App.Store.pushLog({ from: agent.name || agent.id, to: 'system', kind: 'system',
            text: 'could not reach target cell (' + gx + ',' + gy + ')' });
        }
      } catch (e) {}
      agent.path = [];
      Agents.setState(agent, 'idle');
      // Still fire onArrive so orchestration doesn't deadlock — it works "in place".
      if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
      return;
    }

    agent.path = path;          // waypoints exclude start, include goal
    agent._onArrive = (typeof onArrive === 'function') ? onArrive : null;
    Agents.setState(agent, 'walking');
  };

  // goToFurniture(agent, type [, onArrive]) — walk to nearest free seat, sit, onArrive.
  Agents.goToFurniture = function (agent, type, onArrive) {
    if (!agent) return;
    var seat = nearestFreeSeat(agent, type);
    if (!seat) {
      // No seat — fall back to current cell; fire onArrive so flow proceeds.
      Agents.sit(agent);
      if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
      return;
    }
    Agents.goToCell(agent, seat.gx, seat.gy, function () {
      Agents.sit(agent);
      if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
    });
  };

  // sit(agent) — snap to cell center, clear path, face furniture, state → idle.
  Agents.sit = function (agent) {
    if (!agent) return;
    var c = cellCenter(agent.gx, agent.gy);
    agent.x = c.x; agent.y = c.y;
    agent.path = [];
    agent._onArrive = null;
    try { faceFurnitureAtSeat(agent); } catch (e) {}
    Agents.setState(agent, 'idle'); // caller may override immediately
  };

  // goToBreak(agent [, onArrive]) — walk the agent to the lounge for a tea break.
  // Target preference: a World.breakSpots() cell → World.coffeeTile() → nearest
  // 'coffee' furniture (via goToFurniture). On arrival: state 'coffee', say
  // '☕ break' (~3000ms), then fire onArrive. Does NOT touch homeGx/homeGy.
  Agents.goToBreak = function (agent, onArrive) {
    if (!agent) return;
    var w = WORLD();

    // On-arrival behavior shared by every target path.
    function arrived() {
      try { Agents.setState(agent, 'coffee'); } catch (e) {}
      Agents.say(agent, '☕ break', 3000);
      if (typeof onArrive === 'function') { try { onArrive(); } catch (e) {} }
    }

    // 1) Prefer a dedicated break spot in the lounge (near coffee/sofa).
    var spot = null;
    try {
      if (w && w.breakSpots) {
        var spots = w.breakSpots() || [];
        spot = pickNearestUnoccupied(agent, spots);
      }
    } catch (e) { spot = null; }
    if (spot) {
      Agents.goToCell(agent, spot.gx, spot.gy, arrived);
      return;
    }

    // 2) Fall back to the coffee machine's seat tile.
    var ct = null;
    try { if (w && w.coffeeTile) ct = w.coffeeTile(); } catch (e) { ct = null; }
    if (ct && typeof ct.gx === 'number' && !seatOccupiedByOther(agent, ct.gx, ct.gy)) {
      Agents.goToCell(agent, ct.gx, ct.gy, arrived);
      return;
    }

    // 3) Last resort: nearest free 'coffee' furniture seat.
    Agents.goToFurniture(agent, 'coffee', arrived);
  };

  // returnHome(agent) — walk back to the permanent desk seat (homeGx/homeGy)
  // and go idle on arrival. Never modifies homeGx/homeGy.
  Agents.returnHome = function (agent) {
    if (!agent) return;
    var hx = (typeof agent.homeGx === 'number') ? agent.homeGx : agent.gx;
    var hy = (typeof agent.homeGy === 'number') ? agent.homeGy : agent.gy;
    Agents.goToCell(agent, hx, hy, function () {
      Agents.setState(agent, 'idle');
    });
  };

  // ===========================================================================
  // SIMULATION — update(dt)
  // ===========================================================================
  Agents.update = function (dt) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents)) return;
    if (typeof dt !== 'number' || dt < 0) dt = 0;

    var paused = !!s.paused;
    var cfg = CFG();
    var cullTemp = (cfg.CULL_TEMP_AGENTS !== false);
    var ttl = cfg.TEMP_AGENT_TTL_MS || 60000;
    var now = nowMs();

    for (var i = s.agents.length - 1; i >= 0; i--) {
      var a = s.agents[i];
      if (!a) { s.agents.splice(i, 1); continue; }
      try {
        // Bubble expiry runs even when paused.
        if (a.bubble && a.bubble.until && now > a.bubble.until) a.bubble = null;

        if (paused) continue; // no movement / anim / state sim while paused

        // --- movement along path ---
        if (a.path && a.path.length) {
          stepAlongPath(a, dt);
        }

        // --- animation frame advance ---
        advanceAnim(a, dt);

        // --- temp agent cull: idle, not busy, no path, past TTL ---
        if (cullTemp && a.temp && !a.busy && a.state === 'idle' &&
            (!a.path || !a.path.length) && a._idleSince && (now - a._idleSince) > ttl) {
          // Don't cull while selected (avoid yanking an open panel).
          if (s.selectedAgentId !== a.id) {
            s.agents.splice(i, 1);
            continue;
          }
        }
      } catch (e) {
        // One bad agent must never freeze the loop. Reset to a safe idle.
        try { a.path = []; a.state = 'idle'; } catch (e2) {}
      }
    }
  };

  function stepAlongPath(a, dt) {
    var w = WORLD();
    var speed = CFG().WALK_SPEED || 48;        // world px/sec
    var eps = CFG().ARRIVE_EPS || 1.0;
    var remaining = speed * dt;

    // Ensure we are in 'walking' pose while moving.
    if (a.state !== 'walking') Agents.setState(a, 'walking');

    while (remaining > 0 && a.path.length) {
      var wp = a.path[0];
      var target = cellCenter(wp.gx, wp.gy);
      var dx = target.x - a.x, dy = target.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= eps || dist === 0) {
        // reached this waypoint
        a.x = target.x; a.y = target.y;
        a.gx = wp.gx; a.gy = wp.gy;
        a.path.shift();
        continue;
      }

      // facing from movement direction
      if (Math.abs(dx) > Math.abs(dy)) a.facing = dx < 0 ? 'left' : 'right';
      else a.facing = dy < 0 ? 'up' : 'down';

      if (remaining >= dist) {
        // snap onto the waypoint, subtract distance, continue to next
        a.x = target.x; a.y = target.y;
        a.gx = wp.gx; a.gy = wp.gy;
        a.path.shift();
        remaining -= dist;
      } else {
        var k = remaining / dist;
        a.x += dx * k;
        a.y += dy * k;
        remaining = 0;
      }
    }

    // Arrived?
    if (!a.path.length) {
      // snap exactly to cell center for clean seating
      var c = cellCenter(a.gx, a.gy);
      a.x = c.x; a.y = c.y;
      var cb = a._onArrive;
      a._onArrive = null;
      if (a.state === 'walking') Agents.setState(a, 'idle');
      if (typeof cb === 'function') { try { cb(); } catch (e) {} }
    }
  }

  function advanceAnim(a, dt) {
    if (!a.anim) a.anim = { frame: 0, t: 0 };
    var cfg = CFG();
    var fps = cfg.ANIM_FPS || 6;
    var pose = poseClass(a.state);

    if (pose === 'stand') {
      // idle-bob is sine-driven in PixelArt; advance a slow 2-frame counter so any
      // frame-based art still animates. Use BOB_PERIOD for cadence.
      var period = cfg.BOB_PERIOD || 1.6;
      a.anim.t += dt;
      if (a.anim.t >= period / 2) {
        a.anim.t -= period / 2;
        a.anim.frame = (a.anim.frame + 1) % 2;
      }
      return;
    }

    // walk (4 frames) & sit-type (2 frames) advance at ANIM_FPS.
    var len = (pose === 'walk') ? 4 : 2;
    var step = 1 / (pose === 'sit' ? Math.max(fps, 8) : fps); // typing a touch faster
    a.anim.t += dt;
    while (a.anim.t >= step) {
      a.anim.t -= step;
      a.anim.frame = (a.anim.frame + 1) % len;
    }
  }

  // ===========================================================================
  // DRAW — y-sorted, via PixelArt. Computes screen coords itself.
  // ===========================================================================
  Agents.draw = function (ctx) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents) || !ctx) return;
    var w = WORLD(), art = PA();
    if (!w || !art) return;

    var size = w.cellSizeScreen ? w.cellSizeScreen() : 48;

    // y-sort a shallow copy so further-back agents draw first (overlap correct).
    var list = s.agents.slice();
    list.sort(function (p, q) { return (p.y || 0) - (q.y || 0); });

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      try {
        // Feet anchor: cell-center-bottom. agent.x/.y track cell center (world px);
        // feet sit at the lower middle of the cell -> world (x, cellBottom).
        var feetWorldY = a.y + (CFG().TILE || 16) * 0.5; // bottom edge of the cell
        var scr = w.worldToScreen(a.x, feetWorldY);

        var selected = (s.selectedAgentId === a.id);

        // Selection ring UNDER the agent.
        if (selected && art.drawSelection) art.drawSelection(ctx, a, scr.x, scr.y, size);

        // The sprite (feet anchor).
        if (art.drawAgent) {
          art.drawAgent(ctx, a, scr.x, scr.y, size, {
            seated: (a.state === 'coding' || a.state === 'searching'),
            selected: selected,
          });
        }

        // Nameplate above head.
        if (art.drawNameplate) art.drawNameplate(ctx, a, scr.x, scr.y, size);

        // Speech bubble above head (head screen pos ≈ feet - ~26 art-px).
        if (a.bubble && a.bubble.text && art.drawBubble) {
          var headY = scr.y - 26 * (size / 16);
          art.drawBubble(ctx, a.bubble.text, scr.x, headY, size, a.color);
        }
      } catch (e) { /* one bad sprite must not break the pass */ }
    }
  };

  // ===========================================================================
  // DIRECT CHAT — chat(agent, userText) → {abort()}
  // Single agent, NO orchestration. Streams into bubble + UI transcript.
  // ===========================================================================
  // Usable credentials for a model? openai → openaiKey; anthropic → apiKey OR the
  // local companion. Mirrors api.js so companion-only / GPT-only direct chat works.
  function hasCredsFor(model) {
    var set = (STATE() && STATE().settings) || {};
    var prov = (CFG().providerOf ? CFG().providerOf(model)
      : (App.util && App.util.providerOf ? App.util.providerOf(model) : 'anthropic'));
    if (prov === 'openai') return !!set.openaiKey;
    return !!set.apiKey || !!(set.useCompanion && set.companionUrl);
  }

  Agents.chat = function (agent, userText) {
    var noop = { abort: function () {} };
    if (!agent) return noop;
    var s = STATE();
    var settings = (s && s.settings) || {};
    userText = String(userText == null ? '' : userText).trim();
    if (!userText) return noop;

    // Busy guard (config.DIRECT_CHAT_BLOCKS). Default false = allow concurrent.
    if (CFG().DIRECT_CHAT_BLOCKS && agent.busy) {
      try { if (App.UI && App.UI.toast) App.UI.toast(agent.name + ' is busy…'); } catch (e) {}
      return noop;
    }

    // No credentials → friendly bubble, no network. Provider/companion-aware (§10).
    if (!hasCredsFor(agent.model || settings.defaultModel)) {
      Agents.say(agent, '🔑 add an API key (or enable the companion) in Settings', 4000);
      try { if (App.UI && App.UI.toast) App.UI.toast('Add an API key (or enable the companion) in Settings'); } catch (e) {}
      try {
        if (App.Store && App.Store.pushLog) App.Store.pushLog({
          from: agent.name, to: 'system', kind: 'error', text: 'NO_KEY (direct chat)',
        });
      } catch (e) {}
      return noop;
    }

    // Record the user turn.
    agent.conversation.push({ role: 'user', content: userText });
    try { if (App.UI && App.UI.appendTranscript) App.UI.appendTranscript(agent.id, 'user', userText); } catch (e) {}

    // Decide if this agent should be allowed web search (researcher / global toggle).
    var roleDef = ROLES()[agent.role] || {};
    var wantWeb = !!(settings.webSearch && roleDef.webSearchPreferred);
    var tools = wantWeb && CFG().WEB_SEARCH_TOOL ? [CFG().WEB_SEARCH_TOOL] : undefined;

    agent.busy = true;
    Agents.setState(agent, wantWeb ? 'searching' : 'coding');
    Agents.say(agent, '…', 2000);

    var assistantText = '';
    var streamedToTranscript = false;
    var bubbleAccum = '';

    var handle = App.API.stream({
      apiKey: settings.apiKey,
      openaiKey: settings.openaiKey,
      model: agent.model || settings.defaultModel,
      system: agent.systemPrompt || '',
      messages: agent.conversation.slice(),
      tools: tools,
      onState: function (st) {
        if (st === 'searching') Agents.setState(agent, 'searching');
        else if (st === 'text' || st === 'thinking') {
          // flip to coding on first visible text
          if (st === 'text') Agents.setState(agent, 'coding');
        }
      },
      onText: function (delta) {
        assistantText += delta;
        bubbleAccum += delta;
        // bubble shows the tail of the stream (truncated by say()).
        Agents.say(agent, bubbleAccum.slice(-60), 3000);
        try {
          if (App.UI && App.UI.appendTranscript) {
            App.UI.appendTranscript(agent.id, 'assistant', delta);
            streamedToTranscript = true;
          }
        } catch (e) {}
      },
      onDone: function (res) {
        var text = (res && res.text) || assistantText || '';
        agent.conversation.push({ role: 'assistant', content: text });
        // stats
        if (res && res.usage) {
          agent.stats.tokensIn += (res.usage.input_tokens || 0);
          agent.stats.tokensOut += (res.usage.output_tokens || 0);
        }
        agent.busy = false;
        Agents.setState(agent, 'idle');
        Agents.say(agent, truncate(text || '(done)', 48), 3000);

        // If the transcript never received streamed deltas (e.g. panel closed then
        // reopened), the open panel re-renders on refresh; ensure final answer shown.
        if (!streamedToTranscript) {
          try { if (App.UI && App.UI.appendTranscript) App.UI.appendTranscript(agent.id, 'assistant', text); } catch (e) {}
        }
        try { if (App.UI && App.UI.refreshAgentList) App.UI.refreshAgentList(); } catch (e) {}
        try { if (App.Store && App.Store.save) App.Store.save(); } catch (e) {}
        if (s && s._activeStreams) delete s._activeStreams[agent.id];
      },
      onError: function (err) {
        agent.busy = false;
        Agents.setState(agent, 'idle');
        var msg = (err && err.message) || 'error';
        if (err && err.type === 'no_key') {
          Agents.say(agent, '🔑 set your API key in Settings', 4000);
        } else {
          Agents.say(agent, '⚠ ' + truncate(msg, 40), 4000);
        }
        try {
          if (App.Store && App.Store.pushLog) App.Store.pushLog({
            from: agent.name, to: 'system', kind: 'error',
            text: 'chat error: ' + msg,
          });
        } catch (e) {}
        try { if (App.UI && App.UI.appendTranscript) App.UI.appendTranscript(agent.id, 'assistant', '⚠ ' + msg); } catch (e) {}
        if (s && s._activeStreams) delete s._activeStreams[agent.id];
      },
    });

    if (s && s._activeStreams) s._activeStreams[agent.id] = handle;
    return handle || noop;
  };

  // ===========================================================================
  // INTERNAL HELPERS
  // ===========================================================================

  function cellCenter(gx, gy) {
    var w = WORLD();
    if (w && w.cellToWorld) {
      try { var c = w.cellToWorld(gx, gy); if (c && typeof c.x === 'number') return c; } catch (e) {}
    }
    var T = CFG().TILE || 16;
    return { x: (gx + 0.5) * T, y: (gy + 0.5) * T };
  }

  // Find the furniture this agent's seat belongs to and face its center.
  function faceFurnitureAtSeat(agent) {
    var w = WORLD();
    var s = STATE();
    var L = s && s.layout;
    if (!w || !L || !L.furniture) return;
    // Find a furniture whose seat == agent cell.
    for (var i = 0; i < L.furniture.length; i++) {
      var f = L.furniture[i];
      if (!f) continue;
      if (f.seatGx === agent.gx && f.seatGy === agent.gy) {
        faceTowardRect(agent, f.gx, f.gy, f.w || 1, f.h || 1);
        return;
      }
    }
  }

  function faceMeetingCenter(agent) {
    var w = WORLD(), s = STATE();
    var L = s && s.layout;
    if (!w || !L || !L.furniture) return;
    for (var i = 0; i < L.furniture.length; i++) {
      var f = L.furniture[i];
      if (f && f.type === 'meetingTable') {
        faceTowardRect(agent, f.gx, f.gy, f.w || 3, f.h || 2);
        return;
      }
    }
  }

  function faceTowardRect(agent, rx, ry, rw, rh) {
    var cx = rx + (rw - 1) / 2;
    var cy = ry + (rh - 1) / 2;
    var dx = cx - agent.gx, dy = cy - agent.gy;
    if (Math.abs(dx) > Math.abs(dy)) agent.facing = dx < 0 ? 'left' : 'right';
    else agent.facing = dy < 0 ? 'up' : 'down';
  }

  // Nearest free seat of a furniture type (Manhattan to the seat cell).
  function nearestFreeSeat(agent, type) {
    var s = STATE();
    var L = s && s.layout;
    var w = WORLD();
    if (!L || !L.furniture || !w) return null;

    // meetingTable: use World.meetingSeats() ring (multiple seats).
    if (type === 'meetingTable' && w.meetingSeats) {
      var seats = w.meetingSeats() || [];
      return pickNearestUnoccupied(agent, seats);
    }
    if (type === 'coffee' && w.coffeeTile) {
      var ct = w.coffeeTile();
      if (ct && !seatOccupiedByOther(agent, ct.gx, ct.gy)) return ct;
    }

    // generic: collect seat cells of all furniture of this type.
    var cands = [];
    for (var i = 0; i < L.furniture.length; i++) {
      var f = L.furniture[i];
      if (!f || f.type !== type) continue;
      if (typeof f.seatGx === 'number' && typeof f.seatGy === 'number') {
        cands.push({ gx: f.seatGx, gy: f.seatGy });
      }
    }
    return pickNearestUnoccupied(agent, cands);
  }

  function pickNearestUnoccupied(agent, cells) {
    var w = WORLD();
    var best = null, bestD = Infinity;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!c) continue;
      if (seatOccupiedByOther(agent, c.gx, c.gy)) continue;
      if (w && w.isWalkable && !w.isWalkable(c.gx, c.gy)) continue;
      var d = Math.abs(c.gx - agent.gx) + Math.abs(c.gy - agent.gy);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function seatOccupiedByOther(agent, gx, gy) {
    var s = STATE();
    if (!s || !Array.isArray(s.agents)) return false;
    for (var i = 0; i < s.agents.length; i++) {
      var o = s.agents[i];
      if (!o || o === agent || o.id === agent.id) continue;
      if (o.gx === gx && o.gy === gy) return true;
    }
    return false;
  }

  // ===========================================================================
  // PUBLISH + §7.10 REQUIRED compat aliases
  // ===========================================================================
  App.Agents = Agents;

  // goTo(agent, gx, gy, thenState) — orch.md name; wraps goToCell. If a `thenState`
  // string is given, set it on arrival (in addition to default idle handling).
  Agents.goTo = function (agent, gx, gy, thenState) {
    Agents.goToCell(agent, gx, gy, function () {
      if (typeof thenState === 'string') Agents.setState(agent, thenState);
    });
  };

  // directChat(id, t, cbs) — orch.md name; wraps chat(byId(id), t). cbs optional/ignored
  // (chat handles its own callbacks); returns the {abort()} handle.
  Agents.directChat = function (id, t /*, cbs */) {
    var a = Agents.byId(id);
    if (!a) return { abort: function () {} };
    return Agents.chat(a, t);
  };

  // idleByRole — orch.md name; alias of findIdle.
  Agents.idleByRole = Agents.findIdle;

})();
