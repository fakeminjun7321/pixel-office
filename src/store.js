// =============================================================================
// store.js — App.Store
// PIXEL AI COMPANY ("NEON//WORKS") — persistence + seeding (per SPEC.md §3.3, §7.4, §9)
//
// 책임 / Responsibilities:
//   - App.state 생성/시드 (the shared mutable singleton; ONLY Store seeds it)
//   - localStorage 저장/로드 (the ONLY writer of localStorage)
//   - export/import JSON, clear(re-seed), pushLog, migrate
//
// 규칙 / Rules followed:
//   - Classic <script> only. NO import/export. Attach to window.App.
//   - Persistence boundary (§3.3): strip transient agent/task/state fields,
//     drop temp agents, reset running->queued tasks, cap log at 500, clamp
//     camera on load. Never persist `_*` fields.
//   - Versioned storage key (config.STORAGE_KEY) + SCHEMA_VERSION; migrate or
//     safely ignore corrupt/old data (-> fresh seed).
//   - Defensive: every public method wrapped in try/catch; never throws into
//     the caller (the rAF loop must stay alive).
//   - Cross-module calls go through App.* and are guarded (UI may be absent
//     when running headless; World may not yet exist at very-early init).
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  // -- local shortcuts (resolved lazily inside functions; App.* may load in any
  //    order except main.js last, and config.js first). config is guaranteed. --
  var C = App.config || {};

  // ---------------------------------------------------------------------------
  // INTERNAL HELPERS
  // ---------------------------------------------------------------------------

  // config 접근(로드 순서상 config.js가 먼저지만 방어적으로 재확인).
  function cfg() {
    return App.config || C || {};
  }

  function storageKey() {
    return cfg().STORAGE_KEY || 'pixel_ai_company_v1';
  }

  function schemaVersion() {
    var v = cfg().SCHEMA_VERSION;
    return (typeof v === 'number') ? v : 1;
  }

  function pal() {
    var c = cfg();
    return (c.palette) || (App.PixelArt && App.PixelArt.palette) || {};
  }

  function rolesTable() {
    return (cfg().ROLES) || {};
  }

  // localStorage 접근이 막혀있는(시크릿 모드/파일 권한) 환경 대비.
  function safeGetItem(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }
  function safeSetItem(key, val) {
    try {
      if (window.localStorage) { window.localStorage.setItem(key, val); return true; }
    } catch (e) { /* quota/secure-context -> ignore */ }
    return false;
  }
  function safeRemoveItem(key) {
    try {
      if (window.localStorage) { window.localStorage.removeItem(key); }
    } catch (e) { /* ignore */ }
  }

  function nowMs() { return Date.now(); }

  function uid(prefix) {
    if (App.util && App.util.uid) return App.util.uid(prefix);
    return (prefix || 'id') + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }

  function clamp(v, lo, hi) {
    if (App.util && App.util.clamp) return App.util.clamp(v, lo, hi);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // 깊은 복제(구조적). JSON 직렬화 가능한 데이터만 다루므로 충분하고 안전하다.
  function deepClone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); }
    catch (e) { return null; }
  }

  // 객체에서 `_`로 시작하는 모든 키 제거(런타임 전용 필드).
  function stripUnderscored(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && k.charAt(0) === '_') {
        delete obj[k];
      }
    }
    return obj;
  }

  // ---------------------------------------------------------------------------
  // DEFAULTS (fallbacks if config not fully present — should not normally hit)
  // ---------------------------------------------------------------------------

  function defaultCamera() {
    var start = cfg().CAMERA_START || { x: 0, y: 0, zoom: 1.0 };
    return { x: start.x || 0, y: start.y || 0, zoom: start.zoom || 1.0 };
  }

  function defaultSettings() {
    var c = cfg();
    return {
      apiKey: '',
      openaiKey: '',                                   // v2: OpenAI key (for gpt-* models)
      useCompanion: false,                             // v2: route Claude models through local subscription proxy
      companionUrl: c.COMPANION_URL || 'http://localhost:8787/v1/messages',
      defaultModel: c.DEFAULT_MODEL || 'claude-sonnet-4-6',
      bossModel: c.BOSS_MODEL || 'claude-opus-4-8',
      webSearch: true,
      theme: 'neon',
    };
  }

  // 빈/안전한 기본 레이아웃(World가 아직 없을 때의 최후 폴백).
  function emptyLayout() {
    var c = cfg();
    var cols = c.GRID_COLS || 30;
    var rows = c.GRID_ROWS || 20;
    var tiles = [];
    var FLOOR = (c.TILES && typeof c.TILES.FLOOR === 'number') ? c.TILES.FLOOR : 0;
    for (var gy = 0; gy < rows; gy++) {
      var row = [];
      for (var gx = 0; gx < cols; gx++) row.push(FLOOR);
      tiles.push(row);
    }
    return { cols: cols, rows: rows, tiles: tiles, furniture: [] };
  }

  function makeLayout() {
    try {
      if (App.World && typeof App.World.defaultLayout === 'function') {
        var L = App.World.defaultLayout();
        if (L && L.tiles && L.tiles.length) return L;
      }
    } catch (e) { /* fall through to empty */ }
    return emptyLayout();
  }

  // ---------------------------------------------------------------------------
  // STATE FACTORY — build the canonical empty App.state shape (§3)
  // ---------------------------------------------------------------------------

  function freshState() {
    return {
      agents: [],
      tasks: [],
      log: [],
      camera: defaultCamera(),
      layout: emptyLayout(),
      settings: defaultSettings(),
      selectedAgentId: null,
      layoutEdit: false,
      paused: false,

      // runtime-only (NOT persisted)
      _time: 0,
      _meetingActive: false,
      _activeStreams: {},
    };
  }

  // App.state가 없으면 생성. 있으면 누락 필드만 보강(병합) — 다른 모듈이 참조하는
  // 동일 객체 레퍼런스를 보존해야 하므로 절대 새 객체로 교체하지 않는다.
  function ensureState() {
    if (!App.state || typeof App.state !== 'object') {
      App.state = freshState();
      return App.state;
    }
    var s = App.state;
    var def = freshState();
    if (!Array.isArray(s.agents)) s.agents = [];
    if (!Array.isArray(s.tasks)) s.tasks = [];
    if (!Array.isArray(s.log)) s.log = [];
    if (!s.camera || typeof s.camera !== 'object') s.camera = def.camera;
    if (!s.layout || typeof s.layout !== 'object') s.layout = def.layout;
    if (!s.settings || typeof s.settings !== 'object') s.settings = def.settings;
    if (typeof s.selectedAgentId === 'undefined') s.selectedAgentId = null;
    if (typeof s.layoutEdit === 'undefined') s.layoutEdit = false;
    if (typeof s.paused === 'undefined') s.paused = false;
    if (typeof s._time !== 'number') s._time = 0;
    if (typeof s._meetingActive === 'undefined') s._meetingActive = false;
    if (!s._activeStreams || typeof s._activeStreams !== 'object') s._activeStreams = {};
    return s;
  }

  // ---------------------------------------------------------------------------
  // AGENT REBUILD — restore transient fields from gx,gy on load/import (§3.3)
  // ---------------------------------------------------------------------------

  // 좌표 -> 월드 픽셀(셀 중심). World가 있으면 사용, 없으면 직접 계산.
  function cellCenterWorld(gx, gy) {
    try {
      if (App.World && typeof App.World.cellToWorld === 'function') {
        var w = App.World.cellToWorld(gx, gy);
        if (w && typeof w.x === 'number') return w;
      }
    } catch (e) { /* fall through */ }
    var TILE = cfg().TILE || 16;
    return { x: (gx + 0.5) * TILE, y: (gy + 0.5) * TILE };
  }

  // 저장본의 stripped agent를 런타임 Agent로 복원(좌표/포즈/버블 등 재생성).
  function rebuildAgent(a) {
    if (!a || typeof a !== 'object') return null;
    var roles = rolesTable();
    var role = (a.role && roles[a.role]) ? a.role : (a.role || 'generalist');
    var gx = (typeof a.gx === 'number') ? a.gx : 0;
    var gy = (typeof a.gy === 'number') ? a.gy : 0;
    var center = cellCenterWorld(gx, gy);

    var agent = {
      id: a.id || uid('a'),
      name: a.name || (role.charAt(0).toUpperCase() + role.slice(1)),
      role: role,
      model: a.model || (roles[role] && roles[role].model) || (cfg().DEFAULT_MODEL || 'claude-sonnet-4-6'),
      systemPrompt: a.systemPrompt || (roles[role] && roles[role].system) || '',
      color: a.color || (roles[role] && roles[role].color) || pal().purple || '#9b5cff',
      gx: gx, gy: gy,
      homeGx: (typeof a.homeGx === 'number') ? a.homeGx : gx,
      homeGy: (typeof a.homeGy === 'number') ? a.homeGy : gy,
      // transient — rebuilt fresh
      x: center.x, y: center.y,
      path: [],
      facing: a.facing || 'down',
      state: 'idle',
      anim: { frame: 0, t: 0 },
      bubble: null,
      conversation: Array.isArray(a.conversation) ? a.conversation : [],
      currentTaskId: null,
      stats: (a.stats && typeof a.stats === 'object')
        ? {
            tasksDone: a.stats.tasksDone || 0,
            tokensIn: a.stats.tokensIn || 0,
            tokensOut: a.stats.tokensOut || 0,
          }
        : { tasksDone: 0, tokensIn: 0, tokensOut: 0 },
      busy: false,
      temp: false,            // temp agents are never persisted; loaded ones are permanent
      _idleSince: 0,
      _onArrive: null,
    };
    return agent;
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION — build the persistable blob (§3.3 persistence boundary)
  // ---------------------------------------------------------------------------

  // 저장용 agent 한 개를 만든다: temp는 호출 측에서 제외, transient 필드 제거.
  function serializeAgent(a) {
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      model: a.model,
      systemPrompt: a.systemPrompt,
      color: a.color,
      gx: (typeof a.homeGx === 'number') ? a.homeGx : a.gx,   // reload at the permanent desk, not a mid-task cell
      gy: (typeof a.homeGy === 'number') ? a.homeGy : a.gy,
      homeGx: (typeof a.homeGx === 'number') ? a.homeGx : a.gx,
      homeGy: (typeof a.homeGy === 'number') ? a.homeGy : a.gy,
      facing: a.facing || 'down',
      conversation: Array.isArray(a.conversation) ? a.conversation : [],
      currentTaskId: null,    // never persist a live task binding
      stats: (a.stats && typeof a.stats === 'object')
        ? {
            tasksDone: a.stats.tasksDone || 0,
            tokensIn: a.stats.tokensIn || 0,
            tokensOut: a.stats.tokensOut || 0,
          }
        : { tasksDone: 0, tokensIn: 0, tokensOut: 0 },
      // STRIPPED: x,y,path,anim,bubble,busy,temp,_idleSince,_onArrive
    };
  }

  // 저장용 task: _ctrl/_* 제거, running -> queued (재실행 가능하도록).
  function serializeTask(t) {
    var status = t.status;
    if (status === 'running') status = 'queued';
    return {
      id: t.id,
      title: t.title,
      desc: t.desc,
      assignee: (status === 'queued') ? null : (t.assignee || null), // clear stale binding on reset
      status: status,
      parentId: t.parentId || null,
      subtaskIds: Array.isArray(t.subtaskIds) ? t.subtaskIds.slice() : [],
      result: (typeof t.result === 'undefined') ? null : t.result,
      error: (typeof t.error === 'undefined') ? null : t.error,
      createdAt: t.createdAt || nowMs(),
      role: t.role || 'generalist',
      needsWeb: !!t.needsWeb,
      // STRIPPED: _ctrl and any _*
    };
  }

  // 카메라를 config 줌 한계로 클램프(World 없이도 안전).
  function clampCameraValue(cam) {
    var c = cfg();
    var zmin = c.ZOOM_MIN || 0.5;
    var zmax = c.ZOOM_MAX || 3.0;
    var out = {
      x: (cam && typeof cam.x === 'number') ? cam.x : 0,
      y: (cam && typeof cam.y === 'number') ? cam.y : 0,
      zoom: clamp((cam && typeof cam.zoom === 'number') ? cam.zoom : 1.0, zmin, zmax),
    };
    return out;
  }

  // 전체 저장 blob 생성(버전 포함). 직렬화 불가 데이터는 안전하게 폴백.
  function buildSaveBlob() {
    var s = ensureState();

    // agents: drop temp, strip transient
    var agents = [];
    for (var i = 0; i < s.agents.length; i++) {
      var a = s.agents[i];
      if (!a || a.temp === true) continue;   // §3.3: drop temp:true agents entirely
      agents.push(serializeAgent(a));
    }

    // tasks: strip _*, reset running->queued
    var tasks = [];
    for (var j = 0; j < s.tasks.length; j++) {
      var t = s.tasks[j];
      if (!t) continue;
      tasks.push(serializeTask(t));
    }

    // log: cap last 500
    var log = Array.isArray(s.log) ? s.log.slice(-500) : [];

    // layout: deep clone so we never persist live references
    var layout = deepClone(s.layout) || emptyLayout();

    // settings: deep clone with defaults merged
    var settings = Object.assign(defaultSettings(), deepClone(s.settings) || {});

    var blob = {
      v: schemaVersion(),
      savedAt: nowMs(),
      agents: agents,
      tasks: tasks,
      log: log,
      layout: layout,
      settings: settings,
      selectedAgentId: s.selectedAgentId || null,
      camera: clampCameraValue(s.camera),
      // NOT persisted: _time,_meetingActive,_activeStreams, layoutEdit, paused
    };
    return blob;
  }

  // ---------------------------------------------------------------------------
  // DESERIALIZATION — apply a (migrated) blob into the live App.state (§3.3)
  // ---------------------------------------------------------------------------

  // blob의 형태가 최소한으로 유효한지 검사(완전 신뢰 X, 부분 손상은 폴백).
  function looksLikeBlob(blob) {
    return blob && typeof blob === 'object' &&
      (Array.isArray(blob.agents) || Array.isArray(blob.tasks) || blob.layout);
  }

  // blob을 App.state에 반영. 동일 객체 레퍼런스 보존을 위해 in-place로 채운다.
  function applyBlob(blob) {
    var s = ensureState();

    // --- layout ---
    if (blob.layout && blob.layout.tiles && blob.layout.tiles.length) {
      s.layout = deepClone(blob.layout) || makeLayout();
    } else {
      s.layout = makeLayout();
    }

    // --- agents (rebuild transients) ---
    var newAgents = [];
    var rawAgents = Array.isArray(blob.agents) ? blob.agents : [];
    for (var i = 0; i < rawAgents.length; i++) {
      var ag = rebuildAgent(rawAgents[i]);
      if (ag) newAgents.push(ag);
    }
    s.agents.length = 0;
    for (var ai = 0; ai < newAgents.length; ai++) s.agents.push(newAgents[ai]);

    // --- tasks (strip transient, reset running->queued already done on save;
    //     also enforce here for imported blobs that bypassed our save) ---
    var newTasks = [];
    var rawTasks = Array.isArray(blob.tasks) ? blob.tasks : [];
    var validStatus = { queued: 1, blocked: 1, running: 1, done: 1, error: 1 };
    for (var j = 0; j < rawTasks.length; j++) {
      var rt = rawTasks[j];
      if (!rt || typeof rt !== 'object') continue;
      var st = validStatus[rt.status] ? rt.status : 'queued';
      if (st === 'running') st = 'queued';
      newTasks.push({
        id: rt.id || uid('t'),
        title: rt.title || '',
        desc: rt.desc || '',
        assignee: (st === 'queued') ? null : (rt.assignee || null),
        status: st,
        parentId: rt.parentId || null,
        subtaskIds: Array.isArray(rt.subtaskIds) ? rt.subtaskIds.slice() : [],
        result: (typeof rt.result === 'undefined') ? null : rt.result,
        error: (typeof rt.error === 'undefined') ? null : rt.error,
        createdAt: rt.createdAt || nowMs(),
        role: rt.role || 'generalist',
        needsWeb: !!rt.needsWeb,
        _ctrl: null,
      });
    }
    s.tasks.length = 0;
    for (var ti = 0; ti < newTasks.length; ti++) s.tasks.push(newTasks[ti]);

    // --- log (cap 500) ---
    var rawLog = Array.isArray(blob.log) ? blob.log : [];
    s.log.length = 0;
    var capped = rawLog.slice(-500);
    for (var li = 0; li < capped.length; li++) {
      var e = capped[li];
      if (e && typeof e === 'object') s.log.push(e);
    }

    // --- settings (merge over defaults) ---
    s.settings = Object.assign(defaultSettings(), (blob.settings && typeof blob.settings === 'object') ? blob.settings : {});

    // --- selection ---
    s.selectedAgentId = blob.selectedAgentId || null;
    // 유효하지 않은 선택이면 해제
    if (s.selectedAgentId && !findAgentById(s, s.selectedAgentId)) {
      s.selectedAgentId = null;
    }

    // --- camera (clamp; prefer World.clampCamera if present) ---
    s.camera = clampCameraValue(blob.camera || defaultCamera());
    try {
      if (App.World && typeof App.World.clampCamera === 'function') {
        App.World.clampCamera();   // operates on App.state.camera in place
      }
    } catch (e) { /* keep value-clamped camera */ }

    // runtime-only resets (never loaded from disk)
    s.layoutEdit = false;
    s.paused = false;
    s._time = 0;
    s._meetingActive = false;
    s._activeStreams = {};

    return s;
  }

  function findAgentById(s, id) {
    for (var i = 0; i < s.agents.length; i++) {
      if (s.agents[i] && s.agents[i].id === id) return s.agents[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // MIGRATION (§7.4) — upgrade older SCHEMA_VERSION; no-op if current
  // ---------------------------------------------------------------------------

  function migrate(blob) {
    try {
      if (!blob || typeof blob !== 'object') return blob;
      var target = schemaVersion();
      var v = (typeof blob.v === 'number') ? blob.v : 0;
      if (v === target) return blob;

      // v0 (unversioned legacy) -> v1: nothing structural to change yet; stamp it.
      // Future versions: add stepwise upgrades here (v1->v2, etc.).
      if (v < 1) {
        blob.v = 1;
        v = 1;
      }
      // Always stamp to current after running known steps.
      blob.v = target;
      return blob;
    } catch (e) {
      // 마이그레이션 실패시 그대로 반환(applyBlob의 방어로직이 최종 안전망).
      return blob;
    }
  }

  // ---------------------------------------------------------------------------
  // SEED (§7.4, §9) — default company
  // ---------------------------------------------------------------------------

  // Agents.create가 있으면 그것을 쓰고, 없으면 인라인 생성(스토어 단독 시드 가능).
  function makeAgent(spec) {
    if (App.Agents && typeof App.Agents.create === 'function') {
      try {
        var made = App.Agents.create(spec);
        // Agents.create는 state.agents에 push까지 한다(SPEC §7.5). 만든 객체 반환.
        if (made) return made;
      } catch (e) { /* fall back to inline */ }
    }
    // -- inline fallback (mirrors Agents.create resolution rules, §7.5) --
    var s = ensureState();
    var roles = rolesTable();
    var role = (spec.role && roles[spec.role]) ? spec.role : (spec.role || 'generalist');
    var rdef = roles[role] || {};
    var model = spec.model ||
      (role === 'boss' ? (s.settings.bossModel) : (s.settings.defaultModel)) ||
      rdef.model || (cfg().DEFAULT_MODEL || 'claude-sonnet-4-6');
    var color = spec.color || rdef.color || pal().purple || '#9b5cff';
    var systemPrompt = spec.systemPrompt || rdef.system || '';

    var gx = (typeof spec.gx === 'number') ? spec.gx : null;
    var gy = (typeof spec.gy === 'number') ? spec.gy : null;
    if (gx === null || gy === null) {
      var free = null;
      try {
        if (App.World && typeof App.World.freeDeskCell === 'function') free = App.World.freeDeskCell();
      } catch (e) { /* ignore */ }
      if (free) { gx = free.gx; gy = free.gy; }
      else { gx = (gx === null ? 1 : gx); gy = (gy === null ? 1 : gy); }
    }
    var center = cellCenterWorld(gx, gy);

    var agent = {
      id: uid('a'),
      name: spec.name || (role.charAt(0).toUpperCase() + role.slice(1)),
      role: role,
      model: model,
      systemPrompt: systemPrompt,
      color: color,
      gx: gx, gy: gy,
      homeGx: gx, homeGy: gy,
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
      _idleSince: 0,
      _onArrive: null,
    };
    s.agents.push(agent);
    return agent;
  }

  // defaultLayout의 desk seat들을 순서대로 모아 시드 에이전트 배치에 사용.
  // boss desk(보통 CARPET zone, dir 'down')를 우선 식별한다.
  function collectDeskSeats(layout) {
    var seats = [];
    var bossSeat = null;
    var furn = (layout && Array.isArray(layout.furniture)) ? layout.furniture : [];
    for (var i = 0; i < furn.length; i++) {
      var f = furn[i];
      if (!f || f.type !== 'desk') continue;
      if (typeof f.seatGx === 'number' && typeof f.seatGy === 'number') {
        var seat = { gx: f.seatGx, gy: f.seatGy, _y: f.gy };
        seats.push(seat);
      }
    }
    // boss desk = 가장 위쪽(작은 gy)에 있는 desk를 보스 자리로 추정(§9: top-center).
    seats.sort(function (a, b) { return a._y - b._y; });
    if (seats.length) bossSeat = seats[0];
    return { seats: seats, bossSeat: bossSeat };
  }

  function seed() {
    try {
      var s = ensureState();

      // 1) layout from World (or empty fallback)
      s.layout = makeLayout();

      // 2) reset collections / runtime
      s.agents.length = 0;
      s.tasks.length = 0;
      s.log.length = 0;
      s.settings = defaultSettings();
      s.camera = defaultCamera();
      s.selectedAgentId = null;
      s.layoutEdit = false;
      s.paused = false;
      s._time = 0;
      s._meetingActive = false;
      s._activeStreams = {};

      // 3) place the 4 default agents at desks (§9: boss, engineer, designer, researcher)
      var collected = collectDeskSeats(s.layout);
      var seats = collected.seats;
      var roles = rolesTable();

      // 시드 정의 — 색/모델은 ROLES에서 해석(§5.1, §6 defaults).
      var defs = [
        { name: 'Boss',       role: 'boss' },
        { name: 'Engineer',   role: 'engineer' },
        { name: 'Designer',   role: 'designer' },
        { name: 'Researcher', role: 'researcher' },
      ];

      // 좌석 할당: boss는 bossSeat 우선, 나머지는 남은 좌석을 순서대로.
      // bossSeat을 워커 풀에서 제외하기 위해 인덱스를 추적.
      var bossSeat = collected.bossSeat;
      var workerSeats = [];
      for (var si = 0; si < seats.length; si++) {
        var seat = seats[si];
        if (bossSeat && seat.gx === bossSeat.gx && seat.gy === bossSeat.gy && workerSeats.length === seats.length - 1) {
          // safety; not normally reached
        }
        workerSeats.push(seat);
      }
      // boss 좌석을 워커 풀에서 한 번 제거
      if (bossSeat) {
        for (var wi = 0; wi < workerSeats.length; wi++) {
          if (workerSeats[wi].gx === bossSeat.gx && workerSeats[wi].gy === bossSeat.gy) {
            workerSeats.splice(wi, 1);
            break;
          }
        }
      }

      var workerIdx = 0;
      for (var di = 0; di < defs.length; di++) {
        var d = defs[di];
        var spec = {
          name: d.name,
          role: d.role,
          color: (roles[d.role] && roles[d.role].color) || undefined,
          model: (roles[d.role] && roles[d.role].model) || undefined,
          systemPrompt: (roles[d.role] && roles[d.role].system) || undefined,
        };

        // 좌석 좌표 결정
        var cell = null;
        if (d.role === 'boss' && bossSeat) {
          cell = bossSeat;
        } else if (workerSeats.length) {
          cell = workerSeats[workerIdx % workerSeats.length];
          workerIdx++;
        }
        if (cell && typeof cell.gx === 'number') {
          spec.gx = cell.gx;
          spec.gy = cell.gy;
        }
        // 좌석이 전혀 없으면 makeAgent가 freeDeskCell/폴백으로 처리.
        makeAgent(spec);
      }

      // 4) seed log entry
      pushLog({ from: 'system', to: 'all', kind: 'system', text: 'NEON//WORKS online — default company seeded.' });

      // 5) persist the fresh company
      save();
      return s;
    } catch (e) {
      // 시드 실패시에도 최소한의 상태는 보장
      try {
        var fs = ensureState();
        if (!fs.layout || !fs.layout.tiles) fs.layout = emptyLayout();
        logErr('seed', e);
        return fs;
      } catch (e2) { return App.state; }
    }
  }

  // ---------------------------------------------------------------------------
  // SAVE / LOAD (§7.4)
  // ---------------------------------------------------------------------------

  // 디바운스 핸들 (Debounce-safe per SPEC). save()는 즉시 저장하지만, 빈번한
  // 호출에 대비해 saveDebounced를 추가로 제공(내부/외부 모두 안전).
  var _saveTimer = null;

  function save() {
    try {
      var blob = buildSaveBlob();
      var json;
      try { json = JSON.stringify(blob); }
      catch (e) {
        // 순환 참조 등으로 직렬화 실패 — 가능한 부분만 안전 저장 시도
        logErr('save:stringify', e);
        return false;
      }
      var ok = safeSetItem(storageKey(), json);
      return ok;
    } catch (e) {
      logErr('save', e);
      return false;
    }
  }

  // 외부에서 자주 호출해도 안전한 디바운스 저장(연속 호출을 합침).
  function saveDebounced(ms) {
    var delay = (typeof ms === 'number') ? ms : 400;
    if (_saveTimer) { clearTimeout(_saveTimer); }
    _saveTimer = setTimeout(function () {
      _saveTimer = null;
      save();
    }, delay);
  }

  function load() {
    try {
      var raw = safeGetItem(storageKey());
      if (!raw) return false;

      var blob;
      try { blob = JSON.parse(raw); }
      catch (e) {
        // 손상된 JSON — 무시(호출 측에서 seed로 폴백)
        logErr('load:parse', e);
        return false;
      }
      if (!looksLikeBlob(blob)) return false;

      blob = migrate(blob);
      applyBlob(blob);

      // UI 갱신(있으면)
      safeUIRefresh();
      return true;
    } catch (e) {
      logErr('load', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // INIT (§7.4) — main calls FIRST. Ensure state; load if present else seed.
  // ---------------------------------------------------------------------------

  function init() {
    try {
      ensureState();
      var loaded = load();
      if (!loaded) {
        seed();
      }
      return App.state;
    } catch (e) {
      // 무슨 일이 있어도 사용 가능한 state는 보장
      logErr('init', e);
      try {
        if (!App.state) App.state = freshState();
        if (!App.state.agents || !App.state.agents.length) {
          // 최후의 시도: 시드
          seed();
        }
      } catch (e2) { /* give up gracefully; state exists at minimum */ }
      return App.state;
    }
  }

  // ---------------------------------------------------------------------------
  // EXPORT / IMPORT (§7.4)
  // ---------------------------------------------------------------------------

  function exportJSON() {
    try {
      var blob = buildSaveBlob();
      return JSON.stringify(blob, null, 2);
    } catch (e) {
      logErr('exportJSON', e);
      // 빈 회사라도 유효한 JSON 반환
      return JSON.stringify({ v: schemaVersion(), agents: [], tasks: [], log: [], layout: emptyLayout(), settings: defaultSettings() }, null, 2);
    }
  }

  function importJSON(str) {
    try {
      if (typeof str !== 'string' || !str.trim()) return false;
      var blob;
      try { blob = JSON.parse(str); }
      catch (e) { logErr('importJSON:parse', e); return false; }
      if (!looksLikeBlob(blob)) return false;

      blob = migrate(blob);
      applyBlob(blob);     // replaces collections in-place (preserves App.state ref)
      save();              // persist the imported state
      safeUIRefresh();
      pushLog({ from: 'system', to: 'all', kind: 'system', text: 'State imported from JSON.' });
      return true;
    } catch (e) {
      logErr('importJSON', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // CLEAR (§7.4) — remove key; re-seed; UI.refresh()
  // ---------------------------------------------------------------------------

  function clear() {
    try {
      // 진행 중 스트림 중단(있으면) — 데이터 초기화 전에 정리
      abortAllStreams();
      safeRemoveItem(storageKey());
      seed();               // seed() already calls save()
      safeUIRefresh();
      return true;
    } catch (e) {
      logErr('clear', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // LOG (§7.4) — pushLog (PINNED name); App.Store.log compat alias (§7.10)
  // ---------------------------------------------------------------------------

  var VALID_LOG_KINDS = { system: 1, msg: 1, result: 1, error: 1 };

  function normalizeLogEntry(entry) {
    entry = (entry && typeof entry === 'object') ? entry : {};
    var kind = VALID_LOG_KINDS[entry.kind] ? entry.kind : 'system';
    return {
      t: (typeof entry.t === 'number') ? entry.t : nowMs(),  // fill t=Date.now()
      from: (entry.from == null) ? 'system' : String(entry.from),
      to: (entry.to == null) ? '' : String(entry.to),
      kind: kind,
      text: (entry.text == null) ? '' : String(entry.text),
    };
  }

  function pushLog(entry) {
    try {
      var s = ensureState();
      var e = normalizeLogEntry(entry);
      s.log.push(e);
      // cap last 500
      if (s.log.length > 500) {
        s.log.splice(0, s.log.length - 500);
      }
      // UI 갱신(있으면)
      if (App.UI && typeof App.UI.refreshLog === 'function') {
        try { App.UI.refreshLog(); } catch (e2) { /* ignore UI errors */ }
      }
      return e;
    } catch (e) {
      // 로그조차 실패하면 콘솔로만(루프 안전)
      try { console && console.warn && console.warn('[Store.pushLog] failed', e); } catch (e3) {}
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // MISC INTERNAL
  // ---------------------------------------------------------------------------

  // 활성 스트림 전부 중단(clear/reset 시). _activeStreams: agentId -> {abort()}
  function abortAllStreams() {
    try {
      var s = App.state;
      if (!s || !s._activeStreams) return;
      for (var id in s._activeStreams) {
        if (Object.prototype.hasOwnProperty.call(s._activeStreams, id)) {
          var h = s._activeStreams[id];
          try { if (h && typeof h.abort === 'function') h.abort(); } catch (e) {}
        }
      }
      s._activeStreams = {};
    } catch (e) { /* ignore */ }
  }

  function safeUIRefresh() {
    if (App.UI && typeof App.UI.refresh === 'function') {
      try { App.UI.refresh(); } catch (e) { /* ignore UI errors */ }
    }
  }

  // 내부 오류를 활동 로그+콘솔에 남기되, 절대 throw 하지 않는다.
  function logErr(where, err) {
    var msg = '[Store.' + where + '] ' + ((err && err.message) ? err.message : String(err));
    try { console && console.warn && console.warn(msg, err); } catch (e) {}
    // pushLog 안에서의 오류는 재귀를 피하기 위해 직접 로그에 넣지 않는다.
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API (§7.4 + compat alias §7.10)
  // ---------------------------------------------------------------------------

  App.Store = {
    init: init,
    seed: seed,
    save: save,
    saveDebounced: saveDebounced,   // bonus: debounce-safe convenience (non-spec, additive)
    load: load,
    exportJSON: exportJSON,
    importJSON: importJSON,
    clear: clear,
    pushLog: pushLog,
    migrate: migrate,
  };

  // §7.10 REQUIRED compat alias: orch.md used App.Store.log
  App.Store.log = App.Store.pushLog;

})();
