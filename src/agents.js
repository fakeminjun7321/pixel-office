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

  // Clamp a number into 0..1 (NaN-safe). Used for mood + affinity.
  function clamp01n(v) {
    v = Number(v);
    if (!isFinite(v)) return 0.7;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
  // Normalize a relationships map → { otherId: affinity(0..1) }. Drops junk.
  function normRelations(rel) {
    var out = {};
    if (!rel || typeof rel !== 'object') return out;
    for (var k in rel) {
      if (!rel.hasOwnProperty(k)) continue;
      var a = Number(rel[k]);
      if (!isFinite(a)) continue;
      out[k] = (a < 0) ? 0 : (a > 1 ? 1 : a);
    }
    return out;
  }
  // Normalize a sprite-customization object. All fields optional; unknown → defaults
  // resolved at draw time. We keep only string/number primitives we recognize.
  function normSprite(sp) {
    if (!sp || typeof sp !== 'object') return null;
    var out = {};
    if (typeof sp.hair === 'string') out.hair = sp.hair;
    else if (typeof sp.hair === 'number') out.hair = sp.hair | 0;
    if (typeof sp.skin === 'string') out.skin = sp.skin;
    else if (typeof sp.skin === 'number') out.skin = sp.skin | 0;
    if (typeof sp.accent === 'string') out.accent = sp.accent;
    return out;
  }

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
      // v3: persona (identity/plan/relationships) + episodic memory.
      persona: resolvePersona(rdef, spec),
      memories: Array.isArray(spec.memories) ? spec.memories.slice() : [],
      _attention: false,
      // Wave B/C: mood (0..1), relationships (otherId -> affinity 0..1),
      // sprite customization, and an activity timestamp that drives the glow.
      mood: (typeof spec.mood === 'number') ? clamp01n(spec.mood) : (CFG().MOOD_DEFAULT != null ? clamp01n(CFG().MOOD_DEFAULT) : 0.7),
      relationships: (spec.relationships && typeof spec.relationships === 'object') ? normRelations(spec.relationships) : {},
      sprite: normSprite(spec.sprite),
      _lastActivityTs: 0,
      // Wave 4a: gamification. XP accrues per completed task; level is derived
      // from xp via levelForXp(). Preserve any caller-supplied values (e.g. a
      // restored save rebuilding through create()).
      xp: (typeof spec.xp === 'number' && isFinite(spec.xp) && spec.xp >= 0) ? Math.floor(spec.xp) : 0,
      level: (typeof spec.level === 'number' && isFinite(spec.level) && spec.level >= 1) ? Math.floor(spec.level) : 1,
    };
    // Keep level coherent with xp when only xp was supplied.
    if (typeof spec.level !== 'number') agent.level = levelForXp(agent.xp);

    if (s && Array.isArray(s.agents)) s.agents.push(agent);
    return agent;
  };

  // resolvePersona(roleDef, spec) → {identity, plan, relationships} (all strings).
  // Prefer spec.persona, then ROLES[role].persona, then a generic default.
  function resolvePersona(rdef, spec) {
    var p = (spec && spec.persona) || (rdef && rdef.persona) || null;
    function str(v) { return (typeof v === 'string') ? v : (v == null ? '' : String(v)); }
    if (p && typeof p === 'object') {
      return {
        identity: str(p.identity),
        plan: str(p.plan),
        relationships: str(p.relationships),
      };
    }
    return { identity: '', plan: '', relationships: '' };
  }

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
  // v3: MEMORY + ATTENTION API (orchestrator calls these)
  // ===========================================================================

  // addMemory(agent, text, importance) — push {t, text, importance(0..10)}.
  // Clamps importance, ignores empty text, caps the array at MEMORY_CAP (50).
  Agents.addMemory = function (agent, text, importance) {
    if (!agent) return;
    text = String(text == null ? '' : text).trim();
    if (!text) return;
    if (!Array.isArray(agent.memories)) agent.memories = [];
    var imp = Number(importance);
    if (!isFinite(imp)) imp = 1;
    if (imp < 0) imp = 0; else if (imp > 10) imp = 10;
    agent.memories.push({ t: nowMs(), text: truncate(text, 240), importance: imp });
    var cap = CFG().MEMORY_CAP || 50;
    if (agent.memories.length > cap) {
      // drop the oldest entries (front of the array)
      agent.memories.splice(0, agent.memories.length - cap);
    }
  };

  // scoreMemories(query, memories) → top-K MemoryEntry[] (highest score first).
  // score = tokenOverlapRelevance(query,text) + recencyDecay(t) + importance/10.
  // Pure JS, no deps, empty-safe.
  Agents.scoreMemories = function (query, memories) {
    if (!Array.isArray(memories) || !memories.length) return [];
    var k = CFG().MEMORY_TOPK || 3;
    var halflifeH = CFG().MEMORY_HALFLIFE_H || 24;
    var halflifeMs = Math.max(1, halflifeH) * 3600 * 1000;
    var now = nowMs();

    var qTokens = tokenize(query);
    var qSet = {};
    for (var qi = 0; qi < qTokens.length; qi++) qSet[qTokens[qi]] = true;
    var qCount = qTokens.length;

    var scored = [];
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      if (!m || typeof m.text !== 'string') continue;

      // token-overlap relevance (Jaccard-ish: matched / query tokens, 0..1)
      var rel = 0;
      if (qCount > 0) {
        var mTokens = tokenize(m.text);
        var mSet = {}, matched = 0;
        for (var j = 0; j < mTokens.length; j++) mSet[mTokens[j]] = true;
        for (var t in qSet) { if (qSet.hasOwnProperty(t) && mSet[t]) matched++; }
        rel = matched / qCount;
      }

      // recency decay (0..1): 1 at t=now, halves every halflife.
      var age = now - (typeof m.t === 'number' ? m.t : now);
      if (age < 0) age = 0;
      var recency = Math.pow(0.5, age / halflifeMs);

      // importance contribution (0..1)
      var imp = Number(m.importance);
      if (!isFinite(imp)) imp = 0;
      if (imp < 0) imp = 0; else if (imp > 10) imp = 10;

      var score = rel + recency + (imp / 10);
      scored.push({ m: m, score: score, idx: i });
    }

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.idx - a.idx; // tie-break: newer (later in array) first
    });

    var out = [];
    for (var r = 0; r < scored.length && out.length < k; r++) out.push(scored[r].m);
    return out;
  };

  // tokenize(str) → lowercase word tokens (len ≥ 2). Pure, empty-safe.
  function tokenize(str) {
    str = String(str == null ? '' : str).toLowerCase();
    var raw = str.split(/[^a-z0-9가-힣]+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].length >= 2) out.push(raw[i]);
    }
    return out;
  }

  // setAttention(agent, on) — toggle the pulsing "!" marker (drawn in Agents.draw).
  Agents.setAttention = function (agent, on) {
    if (!agent) return;
    agent._attention = !!on;
  };

  // ===========================================================================
  // Wave B/C: ACTIVITY GLOW + MOOD + RELATIONSHIPS
  // ===========================================================================

  // markActivity(agent) — stamp the agent as "recently active" so PixelArt draws a
  // glow that decays over CFG().GLOW_DECAY_MS. Called on streamed text + by the
  // orchestrator on collaboration. Cheap; never throws.
  Agents.markActivity = function (agent) {
    if (!agent) return;
    agent._lastActivityTs = nowMs();
  };

  // activityGlow(agent) — 0..1 strength of the recent-activity glow (1 right after
  // markActivity, decaying linearly to 0 after GLOW_DECAY_MS). Pure read; safe.
  Agents.activityGlow = function (agent) {
    if (!agent || !agent._lastActivityTs) return 0;
    var decay = CFG().GLOW_DECAY_MS || 2500;
    if (decay <= 0) return 0;
    var age = nowMs() - agent._lastActivityTs;
    if (age < 0) age = 0;
    if (age >= decay) return 0;
    return 1 - (age / decay);
  };

  // setMood(agent, value) — set mood, clamped to 0..1. Returns the clamped value.
  Agents.setMood = function (agent, value) {
    if (!agent) return 0;
    agent.mood = clamp01n(value);
    return agent.mood;
  };

  // adjustMood(agent, delta) — nudge mood by delta (clamped). Returns new mood.
  Agents.adjustMood = function (agent, delta) {
    if (!agent) return 0;
    var base = (typeof agent.mood === 'number') ? agent.mood : (CFG().MOOD_DEFAULT != null ? CFG().MOOD_DEFAULT : 0.7);
    agent.mood = clamp01n(base + (Number(delta) || 0));
    return agent.mood;
  };

  // adjustAffinity(agent, otherId, delta) — nudge how much `agent` likes `otherId`
  // by delta (clamped 0..1). Starts from the configured default affinity. Returns
  // the new affinity, or 0 on bad input. Subtle by design (orchestrator passes
  // small deltas after collaboration).
  Agents.adjustAffinity = function (agent, otherId, delta) {
    if (!agent || !otherId || otherId === agent.id) return 0;
    if (!agent.relationships || typeof agent.relationships !== 'object') agent.relationships = {};
    var def = (CFG().AFFINITY_DEFAULT != null) ? CFG().AFFINITY_DEFAULT : 0.5;
    var cur = (typeof agent.relationships[otherId] === 'number') ? agent.relationships[otherId] : def;
    var next = clamp01n(cur + (Number(delta) || 0));
    agent.relationships[otherId] = next;
    return next;
  };

  // ===========================================================================
  // Wave 4a: XP + LEVELING
  // ===========================================================================

  // levelForXp(xp) — derive level from total XP. Prefers a config thresholds table
  // (CFG().LEVEL_THRESHOLDS = ascending cumulative-XP array; index+1 = level) or a
  // configured curve denominator; falls back to level = 1 + floor(sqrt(xp/100)).
  // Pure, NaN-safe, always returns an integer >= 1.
  function levelForXp(xp) {
    xp = Number(xp);
    if (!isFinite(xp) || xp < 0) xp = 0;
    var cfg = CFG();
    // Single source of truth: config.levelForXp mirrors the LEVEL_XP_BASE curve AND
    // applies the LEVEL_MAX clamp. Delegate so every module agrees (SPEC hygiene).
    if (typeof cfg.levelForXp === 'function') {
      var clv = cfg.levelForXp(xp);
      if (isFinite(clv) && clv >= 1) return Math.floor(clv);
    }
    var th = cfg.LEVEL_THRESHOLDS;
    if (Array.isArray(th) && th.length) {
      var lvl = 1;
      for (var i = 0; i < th.length; i++) {
        var need = Number(th[i]);
        if (isFinite(need) && xp >= need) lvl = i + 1; else break;
      }
      return lvl < 1 ? 1 : lvl;
    }
    var denom = Number(cfg.LEVEL_CURVE_DENOM);
    if (!isFinite(denom) || denom <= 0) denom = 100;
    return 1 + Math.floor(Math.sqrt(xp / denom));
  }
  // Expose for store/UI (XP-bar progress) without forcing a recompute path.
  Agents.levelForXp = levelForXp;

  // grantXp(agent, n) — add clamped XP, recompute level, return {leveledUp, level}.
  // n is clamped to a non-negative integer. Never throws; bad agent -> no-op result.
  Agents.grantXp = function (agent, n) {
    if (!agent) return { leveledUp: false, level: 1 };
    var add = Number(n);
    if (!isFinite(add) || add < 0) add = 0;
    add = Math.floor(add);
    var prevXp = (typeof agent.xp === 'number' && isFinite(agent.xp) && agent.xp >= 0) ? agent.xp : 0;
    var prevLevel = (typeof agent.level === 'number' && isFinite(agent.level) && agent.level >= 1)
      ? agent.level : levelForXp(prevXp);
    agent.xp = prevXp + add;
    var newLevel = levelForXp(agent.xp);
    if (newLevel < prevLevel) newLevel = prevLevel; // levels never regress
    agent.level = newLevel;
    return { leveledUp: newLevel > prevLevel, level: newLevel };
  };

  // affinity(agent, otherId) — current affinity (default if unset). Pure read.
  Agents.affinity = function (agent, otherId) {
    var def = (CFG().AFFINITY_DEFAULT != null) ? CFG().AFFINITY_DEFAULT : 0.5;
    if (!agent || !agent.relationships || !otherId) return def;
    var v = agent.relationships[otherId];
    return (typeof v === 'number') ? v : def;
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

        // Chrome (ring/glow/nameplate/bubble/marker) uses csize so the boss's bigger
        // body (drawAgent scales it ×1.12 internally) gets matching-size chrome.
        var csize = size * (art.roleScale ? art.roleScale(a.role) : 1);

        // Selection ring UNDER the agent.
        if (selected && art.drawSelection) art.drawSelection(ctx, a, scr.x, scr.y, csize);

        // Wave B/C: activity glow UNDER the agent (a soft pool that fades with
        // recent streaming activity). Drawn before the sprite so it reads as a halo.
        if (art.drawAgentGlow) {
          var glow = Agents.activityGlow(a);
          if (glow > 0.01) {
            try { art.drawAgentGlow(ctx, a, scr.x, scr.y, csize, glow); } catch (e) {}
          }
        }

        // The sprite (feet anchor). drawAgent applies the boss ×1.12 internally.
        if (art.drawAgent) {
          art.drawAgent(ctx, a, scr.x, scr.y, size, {
            seated: (a.state === 'coding' || a.state === 'searching'),
            selected: selected,
            glow: art.drawAgentGlow ? 0 : Agents.activityGlow(a),
          });
        }

        // Nameplate above head.
        if (art.drawNameplate) art.drawNameplate(ctx, a, scr.x, scr.y, csize);

        // Speech bubble above head (head screen pos ≈ feet - ~26 art-px).
        if (a.bubble && a.bubble.text && art.drawBubble) {
          var headY = scr.y - 26 * (csize / 16);
          art.drawBubble(ctx, a.bubble.text, scr.x, headY, csize, a.color);
        }

        // v3: pulsing yellow "!" attention marker above the head (drawn here, not
        // in pixelart.js). Sits a touch above the nameplate so it stays visible.
        if (a._attention) {
          drawAttentionMarker(ctx, scr.x, scr.y, csize);
        }
      } catch (e) { /* one bad sprite must not break the pass */ }
    }
  };

  // ===========================================================================
  // DIRECT CHAT — chat(agent, userText) → {abort()}
  // Single agent, NO orchestration. Streams into bubble + UI transcript.
  // ===========================================================================
  // Usable credentials for a model? gemini → geminiKey; openai → openaiKey;
  // anthropic → apiKey OR the local companion. Mirrors api.js + orchestrator so
  // gemini-only / companion-only / GPT-only direct chat works.
  function hasCredsFor(model) {
    var set = (STATE() && STATE().settings) || {};
    var prov = (CFG().providerOf ? CFG().providerOf(model)
      : (App.util && App.util.providerOf ? App.util.providerOf(model) : 'anthropic'));
    if (prov === 'gemini') return !!set.geminiKey;
    if (prov === 'openai') return !!set.openaiKey;
    return !!set.apiKey;
  }

  // find the boss agent (for "보스/boss" mentions).
  function findBossAgent() {
    var s = STATE(); if (!s || !Array.isArray(s.agents)) return null;
    for (var i = 0; i < s.agents.length; i++) if (s.agents[i] && s.agents[i].role === 'boss') return s.agents[i];
    return null;
  }
  // resolve who a casual message is about: the boss, or a teammate named in the text.
  function chatTargetFrom(self, text) {
    var s = STATE(); if (!s || !Array.isArray(s.agents)) return null;
    var t = String(text || '').toLowerCase();
    if (/보스|boss|사장|대표/.test(t)) return findBossAgent();
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (a && a.id !== self.id && a.name && t.indexOf(String(a.name).toLowerCase()) !== -1) return a;
    }
    return null;
  }
  // applyChatIntent — light keyword reaction so everyday/social directives in direct
  // chat actually move the sim (mood / relationships), e.g. "보스랑 친해져봐" raises this
  // agent's affinity toward the boss. Best-effort and defensive; never throws.
  function applyChatIntent(agent, text) {
    var s = STATE(); if (!s || !agent) return;
    var t = String(text || '').toLowerCase();
    function bumpMood(d) { agent.mood = clamp01n((typeof agent.mood === 'number' ? agent.mood : 0.7) + d); }
    if (/친해|사이\s*좋|친하게|친목|친구|가까워|get along|befriend/.test(t)) {
      var target = chatTargetFrom(agent, text) || findBossAgent();
      if (target && target.id !== agent.id) {
        agent.relationships = agent.relationships || {};
        agent.relationships[target.id] = clamp01n((agent.relationships[target.id] || 0.5) + 0.2);
        target.relationships = target.relationships || {};
        target.relationships[agent.id] = clamp01n((target.relationships[agent.id] || 0.5) + 0.1);
      }
      bumpMood(0.05);
    }
    if (/기운|힘내|즐겁|행복|신나|기분\s*좋|cheer|happy|웃/.test(t)) bumpMood(0.1);
    if (/쉬어|쉬자|휴식|break|티타임|커피|coffee/.test(t)) bumpMood(0.05);
    if (/싸우|화나|혼나|짜증|stress|angry/.test(t)) bumpMood(-0.05);
  }

  Agents.chat = function (agent, userText, opts) {
    var noop = { abort: function () {} };
    if (!agent) return noop;
    var s = STATE();
    var settings = (s && s.settings) || {};
    userText = String(userText == null ? '' : userText).trim();
    if (!userText) return noop;

    // Per-agent chat file attach: when opts.attachments = [{name, text}] is present,
    // build a "[첨부 파일]" block (per-file "--- <name> ---\n<text>") that gets
    // PREPENDED to the message the agent actually receives, so it sees the file
    // content inline. The transcript still shows the raw userText. Fully
    // backward-compatible: absent/empty attachments → messageText === userText.
    var messageText = userText;
    var atts = (opts && Array.isArray(opts.attachments)) ? opts.attachments : null;
    if (atts && atts.length) {
      var blocks = [];
      for (var ai = 0; ai < atts.length; ai++) {
        var att = atts[ai];
        if (!att) continue;
        var aname = String(att.name == null ? '' : att.name).trim() || 'file';
        var atext = String(att.text == null ? '' : att.text);
        blocks.push('--- ' + aname + ' ---\n' + atext);
      }
      if (blocks.length) {
        messageText = '[첨부 파일]\n' + blocks.join('\n\n') + '\n\n' + userText;
      }
    }

    // Busy guard (config.DIRECT_CHAT_BLOCKS). Default false = allow concurrent.
    if (CFG().DIRECT_CHAT_BLOCKS && agent.busy) {
      try { if (App.UI && App.UI.toast) App.UI.toast(agent.name + ' is busy…'); } catch (e) {}
      return noop;
    }

    // No credentials → friendly bubble, no network. Provider/companion-aware (§10).
    if (!hasCredsFor(agent.model || settings.defaultModel)) {
      Agents.say(agent, '🔑 add an API key in Settings', 4000);
      try { if (App.UI && App.UI.toast) App.UI.toast('Add an API key in Settings'); } catch (e) {}
      try {
        if (App.Store && App.Store.pushLog) App.Store.pushLog({
          from: agent.name, to: 'system', kind: 'error', text: 'NO_KEY (direct chat)',
        });
      } catch (e) {}
      return noop;
    }

    // Casual coworker chat: let everyday/social directives nudge the sim a little
    // (befriend -> affinity+mood, cheer -> mood) so they have a real effect.
    try { applyChatIntent(agent, userText); } catch (e) {}

    // Record the user turn. The API/agent sees messageText (attachments inline);
    // the visible transcript shows the raw userText the human typed.
    agent.conversation.push({ role: 'user', content: messageText });
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
      system: (agent.systemPrompt || '') +
        '\n\n[CHAT MODE] You are chatting 1:1 with a teammate. Reply IN CHARACTER, briefly, like a real ' +
        'coworker. Understand everyday/social messages too (relationships, mood, small talk, breaks, getting ' +
        "along with the boss) - not only work tasks. Reply in the user's language (Korean or English).",
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
        // Wave B/C: mark activity so the agent glows while it streams.
        agent._lastActivityTs = nowMs();
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
        // v5: let a caller (e.g. "revise file with agent") receive the final text.
        try { if (opts && typeof opts.onComplete === 'function') opts.onComplete(text); } catch (e) {}
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

  // drawAttentionMarker(ctx, feetX, feetY, size) — a pulsing yellow "!" above the
  // agent's head. Self-contained ctx drawing (does NOT touch pixelart.js). Guarded
  // by the caller's try/catch but kept defensive anyway.
  function drawAttentionMarker(ctx, feetX, feetY, size) {
    var sc = size / 16;
    // Pulse 0..1 from the clock so it animates without per-agent state.
    var pulse = 0.5 + 0.5 * Math.sin(nowMs() / 220);
    var headY = feetY - 40 * sc;          // above the nameplate
    var r = (5 + 1.5 * pulse) * sc;        // glowing disc radius
    var alpha = 0.55 + 0.45 * pulse;
    var yellow = (CFG().palette && CFG().palette.yellow) ||
      (PA() && PA().palette && PA().palette.yellow) || '#ffe14d';

    ctx.save();
    ctx.globalAlpha = alpha;
    // soft glow disc
    ctx.beginPath();
    ctx.fillStyle = yellow;
    ctx.shadowColor = yellow;
    ctx.shadowBlur = 8 * sc * pulse;
    ctx.arc(feetX, headY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // the "!" glyph in dark ink on the disc
    ctx.globalAlpha = Math.min(1, alpha + 0.2);
    ctx.fillStyle = '#1a1320';
    ctx.font = 'bold ' + Math.round(9 * sc) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', feetX, headY + 0.5 * sc);
    ctx.restore();
  }

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
