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
      geminiKey: '',                                   // Gemini API key (for gemini-* models)
      safeMode: false,                                 // SAFE MODE: serialize requests + widen spacing to avoid rate-limit/overload (OFF by default; keeps Opus)
      defaultModel: c.DEFAULT_MODEL || 'claude-sonnet-4-6',
      bossModel: c.BOSS_MODEL || 'claude-opus-4-8',
      webSearch: true,
      theme: 'neon',
      sound: true,            // v3: completion chime on/off
      bgm: false,             // Wave 4a: ambient background music (procedural) on/off - default OFF
      liveChatter: false,     // v3: watercooler uses an LLM call when true; canned lines when false
      lang: (c.DEFAULT_LANG || 'ko'),  // Wave B: UI language (i18n) — 'en' | 'ko' (Korean is now the default)
      onboarded: false,       // Wave C: first-run guided tour completed flag
      // v5: GitHub push target for the project workspace. Token is stored LOCALLY
      // only (never transmitted except to api.github.com on an explicit push).
      github: { token: '', owner: '', repo: '', branch: 'main' },
    };
  }

  // v5: sanitize a persisted settings.github blob -> {token,owner,repo,branch}.
  // Coerces every field to a string; branch falls back to 'main'. Never throws.
  function normalizeGithub(g) {
    g = (g && typeof g === 'object') ? g : {};
    var branch = (g.branch == null) ? '' : String(g.branch);
    if (!branch) branch = 'main';
    return {
      token: (g.token == null) ? '' : String(g.token),
      owner: (g.owner == null) ? '' : String(g.owner),
      repo: (g.repo == null) ? '' : String(g.repo),
      branch: branch,
    };
  }

  // v3: cap helper for memory/artifact arrays.
  function artifactMax() {
    var n = cfg().ARTIFACT_MAX;
    return (typeof n === 'number' && n > 0) ? n : 200;
  }

  // v3: persona default from ROLES[role].persona (or a generic shape). Always
  // returns the {identity, plan, relationships} string-triple, never throws.
  function defaultPersona(role) {
    var roles = rolesTable();
    var p = (roles[role] && roles[role].persona) ||
            (roles.generalist && roles.generalist.persona) || null;
    if (p && typeof p === 'object') {
      return {
        identity: String(p.identity || ''),
        plan: String(p.plan || ''),
        relationships: String(p.relationships || ''),
      };
    }
    return { identity: '', plan: '', relationships: '' };
  }

  // v3: sanitize a persisted persona blob into the string-triple.
  function normalizePersona(p, role) {
    if (!p || typeof p !== 'object') return defaultPersona(role);
    return {
      identity: String(p.identity || ''),
      plan: String(p.plan || ''),
      relationships: String(p.relationships || ''),
    };
  }

  // v3: sanitize a persisted memories array into MemoryEntry[] (cap 50).
  function normalizeMemories(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || typeof m !== 'object') continue;
      var imp = (typeof m.importance === 'number') ? m.importance : 0;
      imp = clamp(imp, 0, 10);
      out.push({
        t: (typeof m.t === 'number') ? m.t : nowMs(),
        text: (m.text == null) ? '' : String(m.text),
        importance: imp,
      });
    }
    if (out.length > 50) out = out.slice(out.length - 50);
    return out;
  }

  // Wave B/C: sanitize a persisted mood value -> number in [0,1].
  // Falls back to CFG().MOOD_DEFAULT (or 0.7) when missing/invalid.
  function normalizeMood(m) {
    var def = cfg().MOOD_DEFAULT;
    if (typeof def !== 'number') def = 0.7;
    if (typeof m !== 'number' || !isFinite(m)) return def;
    return clamp(m, 0, 1);
  }

  // Wave B/C: sanitize a persisted relationships map -> { otherId: affinity }
  // where affinity is a finite number clamped to [-1,1]. Drops bad keys/values.
  function normalizeRelationships(r) {
    var out = {};
    if (!r || typeof r !== 'object') return out;
    for (var k in r) {
      if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
      if (!k || typeof k !== 'string') continue;
      var v = r[k];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      out[k] = clamp(v, -1, 1);
    }
    return out;
  }

  // Wave 4a: sanitize a persisted non-negative integer (xp/credits) -> finite
  // integer >= 0. Missing/invalid -> the given default (0). Never throws.
  function normalizeCount(n, def) {
    var d = (typeof def === 'number' && isFinite(def)) ? def : 0;
    if (typeof n !== 'number' || !isFinite(n)) return d;
    n = Math.floor(n);
    return n < 0 ? 0 : n;
  }

  // Wave 4a: recompute level from xp. Prefers a config formula/curve if present
  // (CFG().LEVEL_FOR_XP function, or CFG().LEVEL_THRESHOLDS ascending array of xp
  // cutoffs); otherwise the documented default: level = 1 + floor(sqrt(xp/100)).
  // Always returns an integer >= 1. Never throws.
  function levelForXp(xp) {
    try {
      var c = cfg();
      // Single source of truth: config.levelForXp (LEVEL_XP_BASE curve + LEVEL_MAX clamp).
      if (typeof c.levelForXp === 'function') {
        var clv = c.levelForXp(xp);
        if (typeof clv === 'number' && isFinite(clv) && clv >= 1) return Math.floor(clv);
      }
      if (typeof c.LEVEL_FOR_XP === 'function') {
        var lv = c.LEVEL_FOR_XP(xp);
        if (typeof lv === 'number' && isFinite(lv) && lv >= 1) return Math.floor(lv);
      }
      if (Array.isArray(c.LEVEL_THRESHOLDS)) {
        var level = 1;
        for (var i = 0; i < c.LEVEL_THRESHOLDS.length; i++) {
          var cut = c.LEVEL_THRESHOLDS[i];
          if (typeof cut === 'number' && isFinite(cut) && xp >= cut) level = i + 2;
        }
        return level;
      }
    } catch (e) { /* fall through to default curve */ }
    var v = 1 + Math.floor(Math.sqrt((xp > 0 ? xp : 0) / 100));
    return v < 1 ? 1 : v;
  }

  // Wave 4a: sanitize a persisted agent xp/level pair. xp -> integer >= 0; level
  // is trusted only if it is a sane integer >= 1 that is consistent with xp,
  // otherwise it is recomputed from xp so saves stay self-healing. Never throws.
  function normalizeXpLevel(rawXp, rawLevel) {
    var xp = normalizeCount(rawXp, 0);
    var lvl = (typeof rawLevel === 'number' && isFinite(rawLevel)) ? Math.floor(rawLevel) : 0;
    var derived = levelForXp(xp);
    if (lvl < 1) lvl = derived;
    // keep persisted level if it is at least the xp-derived level (allows manual
    // grants/bonuses to survive), but never below the curve.
    if (lvl < derived) lvl = derived;
    return { xp: xp, level: lvl };
  }

  // Wave 4a: sanitize a persisted upgrades id list -> unique non-empty strings.
  // Order preserved (first occurrence wins). Never throws.
  function normalizeUpgrades(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      var s = String(v).trim();
      if (!s) continue;
      if (Object.prototype.hasOwnProperty.call(seen, s)) continue;
      seen[s] = 1;
      out.push(s);
    }
    return out;
  }

  // Wave B/C: sanitize a persisted sprite/customization blob.
  // Returns a {hair, skin, accent} string-triple (empty strings -> renderer
  // uses its own defaults). Returns null when nothing customized, so we don't
  // bloat saves with empty objects for agents that were never customized.
  function normalizeSprite(sp) {
    if (!sp || typeof sp !== 'object') return null;
    var hair = (sp.hair == null) ? '' : String(sp.hair);
    var skin = (sp.skin == null) ? '' : String(sp.skin);
    var accent = (sp.accent == null) ? '' : String(sp.accent);
    if (!hair && !skin && !accent) return null;
    return { hair: hair, skin: skin, accent: accent };
  }

  // v3: sanitize one Artifact for persistence/load.
  function normalizeArtifact(a) {
    if (!a || typeof a !== 'object') return null;
    var type = a.type;
    if (type !== 'code' && type !== 'markdown' && type !== 'data' && type !== 'text') {
      type = 'text';
    }
    return {
      id: a.id || uid('art'),
      name: (a.name == null) ? 'artifact' : String(a.name),
      type: type,
      content: (a.content == null) ? '' : String(a.content),
      taskId: (a.taskId == null) ? null : String(a.taskId),
      agentId: (a.agentId == null) ? null : String(a.agentId),
      t: (typeof a.t === 'number') ? a.t : nowMs(),
    };
  }

  // v3: normalize + cap an artifacts array (keep most recent ARTIFACT_MAX).
  function normalizeArtifacts(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var na = normalizeArtifact(arr[i]);
      if (na) out.push(na);
    }
    var cap = artifactMax();
    if (out.length > cap) out = out.slice(out.length - cap);
    return out;
  }

  // v5: cap helper for the project workspace (state.files) file count.
  function maxProjectFiles() {
    var n = cfg().MAX_PROJECT_FILES;
    return (typeof n === 'number' && n > 0) ? n : 200;
  }

  // WAVE 1: cap helper for per-file version history (files[path].history).
  function fileHistoryCap() {
    var n = cfg().FILE_HISTORY_CAP;
    return (typeof n === 'number' && n > 0) ? n : 20;
  }

  // WAVE 1: sanitize a persisted file-history array -> [{content,t,by}] (oldest..
  // newest order preserved). Coerces content to String, caps per-entry size, and
  // keeps only the newest FILE_HISTORY_CAP entries. Never throws.
  function normalizeHistory(arr) {
    if (!Array.isArray(arr)) return [];
    var PER_ENTRY_MAX = 200 * 1024;   // 200k chars per historical version
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var h = arr[i];
      if (!h || typeof h !== 'object') continue;
      var content = (h.content == null) ? '' : String(h.content);
      if (content.length > PER_ENTRY_MAX) content = content.slice(0, PER_ENTRY_MAX);
      out.push({
        content: content,
        t: (typeof h.t === 'number') ? h.t : nowMs(),
        by: (h.by == null) ? 'agent' : String(h.by),
      });
    }
    var cap = fileHistoryCap();
    if (out.length > cap) out = out.slice(out.length - cap);   // keep newest
    return out;
  }

  // WAVE 1: sanitize the runtime task ledger -> {facts[],plan[],progress,updated}.
  // Caps the string arrays, constrains progress to the known enum, coerces every
  // entry to a string. Returns null when there is nothing meaningful to persist
  // (so empty saves are not bloated). Never throws.
  function normalizeLedger(l) {
    if (!l || typeof l !== 'object') return null;
    var LIST_CAP = 12;
    function strList(a) {
      if (!Array.isArray(a)) return [];
      var o = [];
      for (var i = 0; i < a.length && o.length < LIST_CAP; i++) {
        if (a[i] == null) continue;
        var s = String(a[i]);
        if (s) o.push(s);
      }
      return o;
    }
    var facts = strList(l.facts);
    var plan = strList(l.plan);
    var progress = l.progress;
    if (progress !== 'working' && progress !== 'stuck' && progress !== 'done') progress = 'working';
    var updated = (typeof l.updated === 'number') ? l.updated : nowMs();
    if (!facts.length && !plan.length && progress === 'working') return null;   // nothing meaningful
    return { facts: facts, plan: plan, progress: progress, updated: updated };
  }

  // KNOWLEDGE: cap helper for the company-wide cross-project knowledge base
  // (App.state.knowledge). Default 60 (config.KNOWLEDGE_CAP).
  function knowledgeCap() {
    var n = cfg().KNOWLEDGE_CAP;
    return (typeof n === 'number' && n > 0) ? n : 60;
  }

  // KNOWLEDGE: default number of entries getKnowledge() returns when k is omitted
  // (config.KNOWLEDGE_INJECT_K, default 4).
  function knowledgeInjectK() {
    var n = cfg().KNOWLEDGE_INJECT_K;
    return (typeof n === 'number' && n > 0) ? Math.floor(n) : 4;
  }

  // KNOWLEDGE: sanitize a persisted tags array -> unique non-empty lowercased
  // strings (cap 8 so a single entry cannot bloat the blob). Never throws.
  function normalizeTags(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    var seen = {};
    for (var i = 0; i < arr.length && out.length < 8; i++) {
      var v = arr[i];
      if (v == null) continue;
      var s = String(v).trim().toLowerCase();
      if (!s) continue;
      if (Object.prototype.hasOwnProperty.call(seen, s)) continue;
      seen[s] = 1;
      out.push(s);
    }
    return out;
  }

  // KNOWLEDGE: sanitize one knowledge entry -> {id, text, tags[], project, ts}.
  // Coerces every field, clamps text length, drops entries with empty text.
  // Returns null when there is nothing meaningful to keep. Never throws.
  function normalizeKnowledgeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    var TEXT_MAX = 600;   // a learning is a short reusable note, not a document
    var text = (e.text == null) ? '' : String(e.text).trim();
    if (!text) return null;
    if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX);
    return {
      id: e.id ? String(e.id) : uid('kn'),
      text: text,
      tags: normalizeTags(e.tags),
      project: (e.project == null) ? '' : String(e.project),
      ts: (typeof e.ts === 'number' && isFinite(e.ts)) ? e.ts : nowMs(),
    };
  }

  // KNOWLEDGE: normalize + cap a knowledge array (keep most recent KNOWLEDGE_CAP,
  // oldest dropped). Order preserved (assumed oldest..newest). Never throws.
  function normalizeKnowledge(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var ne = normalizeKnowledgeEntry(arr[i]);
      if (ne) out.push(ne);
    }
    var cap = knowledgeCap();
    if (out.length > cap) out = out.slice(out.length - cap);   // keep newest
    return out;
  }

  // KNOWLEDGE: lowercase token set for simple keyword-overlap ranking. Splits on
  // any non-alphanumeric run (handles unicode word chars loosely via the regex),
  // drops 1-char tokens. Returns a plain { token: 1 } map. Never throws.
  function knowledgeTokens(str) {
    var map = {};
    try {
      var s = String(str == null ? '' : str).toLowerCase();
      // Split on any run of NON-word chars. Keep ASCII alphanumerics AND any
      // codepoint >= U+00C0 (covers accented Latin, CJK, Hangul, etc.) so that
      // Korean/non-Latin learnings still tokenize. The class is built via
      // RegExp with \u-escapes so this source stays pure ASCII (build-safe).
      var parts = s.split(new RegExp('[^a-z0-9\\u00C0-\\uFFFF]+'));
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p && p.length > 1) map[p] = 1;
      }
    } catch (e) { /* return whatever we have */ }
    return map;
  }

  // WAVE 3: cap helper for the structured run-event trace (App.state.trace).
  function traceCap() {
    var n = cfg().TRACE_CAP;
    return (typeof n === 'number' && n > 0) ? n : 600;
  }

  // WAVE 3: sanitize the structured run-event trace -> small {t,type,...} rows.
  // Each event is coerced field-by-field: numeric fields pass through as numbers,
  // string fields are coerced + length-clamped (text especially), unknown fields
  // are dropped. Oversized/garbage rows are skipped. Keeps only the newest
  // TRACE_CAP events. Never throws. Migrate older saves (missing trace -> []).
  function normalizeTrace(arr) {
    if (!Array.isArray(arr)) return [];
    var TEXT_MAX = 240;     // short summary text only — drop anything huge
    var NAME_MAX = 80;
    function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : undefined; }
    function str(v, max) {
      if (v == null) return undefined;
      var s = String(v);
      if (s.length > max) s = s.slice(0, max);
      return s;
    }
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e !== 'object') continue;
      var row = {
        t: (typeof e.t === 'number' && isFinite(e.t)) ? e.t : nowMs(),
        type: str(e.type, NAME_MAX) || 'event',
      };
      // optional, coerced fields (only attached when present/valid)
      var taskId = str(e.taskId, NAME_MAX); if (taskId !== undefined) row.taskId = taskId;
      var role = str(e.role, NAME_MAX); if (role !== undefined) row.role = role;
      var agentId = str(e.agentId, NAME_MAX); if (agentId !== undefined) row.agentId = agentId;
      var name = str(e.name, NAME_MAX); if (name !== undefined) row.name = name;
      var ms = num(e.ms); if (ms !== undefined) row.ms = ms;
      var tIn = num(e.tokensIn); if (tIn !== undefined) row.tokensIn = tIn;
      var tOut = num(e.tokensOut); if (tOut !== undefined) row.tokensOut = tOut;
      var status = str(e.status, NAME_MAX); if (status !== undefined) row.status = status;
      var text = str(e.text, TEXT_MAX); if (text !== undefined) row.text = text;
      out.push(row);
    }
    var cap = traceCap();
    if (out.length > cap) out = out.slice(out.length - cap);   // keep newest
    return out;
  }

  // v5: detect a file's language from its extension (mirror of
  // Workspace.detectLang; kept here so the store can normalize standalone).
  function detectLangFor(path) {
    var p = String(path == null ? '' : path).toLowerCase();
    var dot = p.lastIndexOf('.');
    var ext = (dot >= 0) ? p.slice(dot + 1) : '';
    switch (ext) {
      case 'html': case 'htm': return 'html';
      case 'css': return 'css';
      case 'js': case 'mjs': case 'cjs': return 'js';
      case 'json': return 'json';
      case 'md': case 'markdown': return 'md';
      case 'py': return 'py';
      case 'ts': return 'ts';
      case 'txt': return 'txt';
      default: return 'txt';
    }
  }

  // v5: sanitize the persisted project workspace map (path -> file entry).
  //   - drop non-object entries / blank paths
  //   - coerce content to String, cap per-file size (200k chars)
  //   - cap total file count (drop oldest by t past MAX_PROJECT_FILES)
  //   - fill lang/updatedBy/t with safe defaults
  //   - WAVE 1: preserve files[path].history -> normalized [{content,t,by}] (capped)
  // Returns a fresh plain object. Never throws. Migrate older saves (missing
  // history -> []).
  function normalizeFiles(map) {
    var out = {};
    if (!map || typeof map !== 'object') return out;
    var PER_FILE_MAX = 200 * 1024;   // 200k chars per file
    var rows = [];
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var path = String(k == null ? '' : k).trim();
      if (!path) continue;
      var f = map[k];
      if (!f || typeof f !== 'object') continue;
      var content = (f.content == null) ? '' : String(f.content);
      if (content.length > PER_FILE_MAX) content = content.slice(0, PER_FILE_MAX);
      rows.push({
        path: path,
        content: content,
        lang: (f.lang == null || f.lang === '') ? detectLangFor(path) : String(f.lang),
        updatedBy: (f.updatedBy == null) ? 'agent' : String(f.updatedBy),
        t: (typeof f.t === 'number') ? f.t : nowMs(),
        history: normalizeHistory(f.history),   // WAVE 1: prior versions (migrate missing -> [])
      });
    }
    // cap total count: keep the most recently updated files.
    var cap = maxProjectFiles();
    if (rows.length > cap) {
      rows.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
      rows = rows.slice(0, cap);
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out[r.path] = { content: r.content, lang: r.lang, updatedBy: r.updatedBy, t: r.t, history: r.history };
    }
    return out;
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
      artifacts: [],          // v3: Artifact[] (persisted, capped at ARTIFACT_MAX)
      trace: [],              // WAVE 3: structured run-event trace (persisted, capped at TRACE_CAP)
      files: {},              // v5: project workspace (path -> {content,lang,updatedBy,t}); persisted, capped at MAX_PROJECT_FILES
      knowledge: [],          // KNOWLEDGE: cross-project company memory ({id,text,tags,project,ts}[]); persisted, capped at KNOWLEDGE_CAP
      credits: 0,             // Wave 4a: shared credit pool (earned per task; spent in the office shop)
      upgrades: [],           // Wave 4a: purchased OFFICE_UPGRADES ids (applied to layout on load)
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
      _followId: null,        // v3: agent id the camera follows (runtime-only)
      _buildActive: false,    // v5: true while a project BUILD pipeline is running (runtime-only, NOT persisted)
      // WAVE 1: task ledger (working memory; PERSISTED under blob.ledger when meaningful)
      _ledger: null,          // { facts:[], plan:[], progress:'working'|'stuck'|'done', updated }
      // WAVE 1: last run / self-repair capture — RUNTIME-ONLY, NEVER persisted.
      _lastRun: null,         // { errors:[], logs:[], t }
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
    if (!Array.isArray(s.artifacts)) s.artifacts = [];
    if (!Array.isArray(s.trace)) s.trace = [];                   // WAVE 3: run-event trace
    if (!s.files || typeof s.files !== 'object') s.files = {};   // v5: project workspace map
    if (!Array.isArray(s.knowledge)) s.knowledge = [];           // KNOWLEDGE: cross-project memory
    if (typeof s.credits !== 'number' || !isFinite(s.credits)) s.credits = 0;   // Wave 4a
    if (!Array.isArray(s.upgrades)) s.upgrades = [];                            // Wave 4a
    if (!s.camera || typeof s.camera !== 'object') s.camera = def.camera;
    if (!s.layout || typeof s.layout !== 'object') s.layout = def.layout;
    if (!s.settings || typeof s.settings !== 'object') s.settings = def.settings;
    if (typeof s.selectedAgentId === 'undefined') s.selectedAgentId = null;
    if (typeof s.layoutEdit === 'undefined') s.layoutEdit = false;
    if (typeof s.paused === 'undefined') s.paused = false;
    if (typeof s._time !== 'number') s._time = 0;
    if (typeof s._meetingActive === 'undefined') s._meetingActive = false;
    if (!s._activeStreams || typeof s._activeStreams !== 'object') s._activeStreams = {};
    if (typeof s._followId === 'undefined') s._followId = null;
    if (typeof s._buildActive === 'undefined') s._buildActive = false;   // v5
    if (typeof s._ledger === 'undefined') s._ledger = null;              // WAVE 1
    if (typeof s._lastRun === 'undefined') s._lastRun = null;            // WAVE 1 (runtime-only)
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
    var xl = normalizeXpLevel(a.xp, a.level);   // Wave 4a: xp/level (self-healing)

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
      // v3: persona + memories (default from ROLES if absent on disk)
      persona: normalizePersona(a.persona, role),
      memories: normalizeMemories(a.memories),
      // Wave B/C: social/affect + sprite customization (default-safe; migrate
      // older saves that lack these by supplying CFG defaults / empty maps).
      mood: normalizeMood(a.mood),
      // Wave 4a: gamification - xp/level (migrate older saves: missing -> 0/1;
      // level self-heals from xp via normalizeXpLevel above).
      xp: xl.xp,
      level: xl.level,
      relationships: normalizeRelationships(a.relationships),
      sprite: normalizeSprite(a.sprite),
      _idleSince: 0,
      _onArrive: null,
      _attention: false,      // v3: runtime-only attention marker
      _lastActivityTs: 0,     // Wave B/C: runtime-only activity-glow timestamp
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
      // v3: persist persona + memories (so accumulated context survives reload)
      persona: normalizePersona(a.persona, a.role),
      memories: normalizeMemories(a.memories),
      // Wave 4a: persist gamification xp/level (level kept consistent with xp).
      xp: normalizeCount(a.xp, 0),
      level: normalizeXpLevel(a.xp, a.level).level,
      // Wave B/C: persist mood, relationships, sprite customization.
      mood: normalizeMood(a.mood),
      relationships: normalizeRelationships(a.relationships),
      sprite: normalizeSprite(a.sprite),   // null when never customized (omitted-ish)
      // STRIPPED: x,y,path,anim,bubble,busy,temp,_idleSince,_onArrive,_attention,_lastActivityTs
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
      verify: !!t.verify,   // v3: keep the QA-gate flag so it survives reload (DAG dep order is lossy on mid-run reload — acceptable)
      // WAVE 3: per-task token accounting (Orchestrator accumulates _tokensIn/_tokensOut
      // as a worker streams). Persist as non-underscore numeric fields so per-task cost
      // survives reload; rebuildTask reads these back onto task._tokensIn/_tokensOut.
      tokensIn: (typeof t._tokensIn === 'number' && isFinite(t._tokensIn)) ? t._tokensIn
                : ((typeof t.tokensIn === 'number' && isFinite(t.tokensIn)) ? t.tokensIn : 0),
      tokensOut: (typeof t._tokensOut === 'number' && isFinite(t._tokensOut)) ? t._tokensOut
                : ((typeof t.tokensOut === 'number' && isFinite(t.tokensOut)) ? t.tokensOut : 0),
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

    // v3: artifacts — normalize + cap (deep cloned via normalize copy)
    var artifacts = normalizeArtifacts(s.artifacts);

    // WAVE 3: structured run-event trace — coerce/clamp + cap newest TRACE_CAP
    var trace = normalizeTrace(s.trace);

    // v5: project workspace — normalize + cap (fresh plain map, no live refs)
    var files = normalizeFiles(s.files);

    // KNOWLEDGE: cross-project company memory — normalize + cap newest KNOWLEDGE_CAP
    var knowledge = normalizeKnowledge(s.knowledge);

    // layout: deep clone so we never persist live references
    var layout = deepClone(s.layout) || emptyLayout();

    // settings: deep clone with defaults merged (then re-normalize github subobject).
    // deepClone is a JSON round-trip, so any non-serializable share/save artifact
    // (e.g. a File System Access directory handle parked on settings) is dropped
    // here automatically — directory handles live IN MEMORY on App.state._dirHandle
    // and are NEVER persisted. Strip any stray _*-prefixed runtime keys too.
    var settings = Object.assign(defaultSettings(), deepClone(s.settings) || {});
    settings = stripUnderscored(settings);
    settings.github = normalizeGithub(settings.github);   // v5

    // WAVE 1: task ledger — small runtime working-memory; persist when meaningful.
    var ledger = normalizeLedger(s._ledger);

    // Wave 4a: gamification economy - shared credits + purchased upgrade ids.
    var credits = normalizeCount(s.credits, 0);
    var upgrades = normalizeUpgrades(s.upgrades);

    var blob = {
      v: schemaVersion(),
      savedAt: nowMs(),
      agents: agents,
      tasks: tasks,
      log: log,
      artifacts: artifacts,
      trace: trace,           // WAVE 3: structured run-event trace
      files: files,           // v5: project workspace
      knowledge: knowledge,   // KNOWLEDGE: cross-project company memory
      credits: credits,       // Wave 4a: shared credit pool
      upgrades: upgrades,     // Wave 4a: purchased office-upgrade ids
      layout: layout,
      settings: settings,
      selectedAgentId: s.selectedAgentId || null,
      camera: clampCameraValue(s.camera),
      // NOT persisted: _time,_meetingActive,_activeStreams,_followId, layoutEdit, paused,
      //   _lastRun (WAVE 1: runtime-only self-repair capture — NEVER persisted).
    };
    if (ledger) blob.ledger = ledger;   // WAVE 1: persisted under a non-underscore key
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
      // WAVE 3: restore per-task token accounting onto the runtime task. Accept
      // both the persisted non-underscore fields and any legacy _-prefixed ones.
      var rtIn = (typeof rt.tokensIn === 'number' && isFinite(rt.tokensIn)) ? rt.tokensIn
                 : ((typeof rt._tokensIn === 'number' && isFinite(rt._tokensIn)) ? rt._tokensIn : 0);
      var rtOut = (typeof rt.tokensOut === 'number' && isFinite(rt.tokensOut)) ? rt.tokensOut
                 : ((typeof rt._tokensOut === 'number' && isFinite(rt._tokensOut)) ? rt._tokensOut : 0);
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
        verify: !!rt.verify,   // v3: restore QA-gate flag
        // WAVE 3: per-task tokens live on _-prefixed runtime fields (Orchestrator
        // accumulates them); seed from the persisted values so cost-per-task carries.
        _tokensIn: rtIn,
        _tokensOut: rtOut,
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

    // --- artifacts (normalize + cap) ---
    var rebuiltArtifacts = normalizeArtifacts(blob.artifacts);
    if (!Array.isArray(s.artifacts)) s.artifacts = [];
    s.artifacts.length = 0;
    for (var aj = 0; aj < rebuiltArtifacts.length; aj++) s.artifacts.push(rebuiltArtifacts[aj]);

    // --- WAVE 3: run-event trace (coerce/clamp + cap; migrate missing -> []) ---
    var rebuiltTrace = normalizeTrace(blob.trace);
    if (!Array.isArray(s.trace)) s.trace = [];
    s.trace.length = 0;
    for (var tj = 0; tj < rebuiltTrace.length; tj++) s.trace.push(rebuiltTrace[tj]);

    // --- files: project workspace (normalize + cap) ---
    var rebuiltFiles = normalizeFiles(blob.files);
    if (!s.files || typeof s.files !== 'object') s.files = {};
    // clear in place to preserve the object reference other modules may hold
    for (var fk in s.files) {
      if (Object.prototype.hasOwnProperty.call(s.files, fk)) delete s.files[fk];
    }
    for (var nfk in rebuiltFiles) {
      if (Object.prototype.hasOwnProperty.call(rebuiltFiles, nfk)) s.files[nfk] = rebuiltFiles[nfk];
    }

    // --- KNOWLEDGE: cross-project company memory (normalize + cap; migrate -> []) ---
    var rebuiltKnowledge = normalizeKnowledge(blob.knowledge);
    if (!Array.isArray(s.knowledge)) s.knowledge = [];
    s.knowledge.length = 0;   // clear in place to preserve the array reference
    for (var kj = 0; kj < rebuiltKnowledge.length; kj++) s.knowledge.push(rebuiltKnowledge[kj]);

    // --- Wave 4a: gamification economy (credits + purchased upgrade ids) ---
    s.credits = normalizeCount(blob.credits, 0);
    s.upgrades = normalizeUpgrades(blob.upgrades);

    // --- WAVE 1: task ledger (restore if present; else leave unset/runtime-init) ---
    var lg = normalizeLedger(blob.ledger);
    if (lg) { s._ledger = lg; }
    else if (typeof s._ledger === 'undefined') { s._ledger = null; }

    // --- settings (merge over defaults; re-normalize github subobject) ---
    // stripUnderscored drops any stray _*-prefixed runtime keys an imported/shared
    // blob might carry (directory handles are never serialized into a blob anyway).
    s.settings = Object.assign(defaultSettings(), (blob.settings && typeof blob.settings === 'object') ? blob.settings : {});
    s.settings = stripUnderscored(s.settings);
    s.settings.github = normalizeGithub(s.settings.github);   // v5

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
    s._followId = null;       // v3: never restore camera-follow from disk
    s._buildActive = false;   // v5: never restore a mid-build flag from disk
    s._lastRun = null;        // WAVE 1: self-repair capture is runtime-only; never restored
    // NOTE: s._ledger is set above from blob.ledger when present (it IS persisted).

    // --- Wave 4a: re-apply purchased office upgrades onto the (now-ready) layout.
    // World.reapplyUpgrades is idempotent + validates placement; guarded because
    // World may be absent very early or when running headless. Never throws here.
    try {
      if (App.World && typeof App.World.reapplyUpgrades === 'function') {
        App.World.reapplyUpgrades();
      }
    } catch (e) { logErr('applyBlob:reapplyUpgrades', e); }

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
      if (v < 1) {
        blob.v = 1;
        v = 1;
      }
      // v1 -> v2 (v3 feature set): artifacts/persona/memories + new settings.
      // All new fields are filled with safe defaults by applyBlob/rebuildAgent's
      // normalizers, so this step is a forward no-op beyond ensuring the shapes
      // exist on the blob (defensive; old saves simply gain defaults on load).
      if (v < 2) {
        if (!Array.isArray(blob.artifacts)) blob.artifacts = [];
        if (blob.settings && typeof blob.settings === 'object') {
          if (typeof blob.settings.sound === 'undefined') blob.settings.sound = true;
          if (typeof blob.settings.liveChatter === 'undefined') blob.settings.liveChatter = false;
        }
        // agent.persona/memories left absent here -> rebuildAgent supplies defaults.
        blob.v = 2;
        v = 2;
      }
      // v2 -> v3 (Wave B/C): settings.lang/onboarded + agent.mood/relationships/
      // sprite. All agent fields are filled with safe defaults by rebuildAgent's
      // normalizers on load, so this step only needs to ensure the settings keys
      // exist; everything else is a forward no-op. Run whenever v<3 regardless of
      // whether SCHEMA_VERSION was bumped to 3 (defensive).
      if (v < 3) {
        if (blob.settings && typeof blob.settings === 'object') {
          if (typeof blob.settings.lang === 'undefined') {
            blob.settings.lang = (cfg().DEFAULT_LANG || 'en');
          }
          if (typeof blob.settings.onboarded === 'undefined') {
            blob.settings.onboarded = false;
          }
        }
        // agent.mood/relationships/sprite left absent -> rebuildAgent defaults.
        v = 3;
      }
      // v3 -> v4 (v5 feature set): project workspace (blob.files) + settings.github.
      // Both are filled with safe defaults by applyBlob's normalizers (normalizeFiles
      // / normalizeGithub), so this step only ensures the shapes exist; everything
      // else is a forward no-op. Defensive: run whenever v<4 regardless of whether
      // SCHEMA_VERSION was bumped.
      if (v < 4) {
        if (!blob.files || typeof blob.files !== 'object') blob.files = {};
        if (blob.settings && typeof blob.settings === 'object') {
          if (typeof blob.settings.github === 'undefined') {
            blob.settings.github = { token: '', owner: '', repo: '', branch: 'main' };
          }
        }
        v = 4;
      }
      // v4 -> v5 (WAVE 1): per-file version history (files[path].history) + the
      // persisted task ledger (blob.ledger). Both are filled with safe defaults by
      // normalizeFiles (missing history -> []) / normalizeLedger on load, so this
      // step only ensures the shapes exist; everything else is a forward no-op.
      // Defensive: run whenever v<5 regardless of whether SCHEMA_VERSION was bumped.
      if (v < 5) {
        if (blob.files && typeof blob.files === 'object') {
          for (var fp in blob.files) {
            if (!Object.prototype.hasOwnProperty.call(blob.files, fp)) continue;
            var ff = blob.files[fp];
            if (ff && typeof ff === 'object' && !Array.isArray(ff.history)) ff.history = [];
          }
        }
        // blob.ledger absent -> normalizeLedger yields null (no ledger). Forward no-op.
        v = 5;
      }
      // v5 -> current (WAVE 3): structured run-event trace (blob.trace). Filled with
      // safe defaults by normalizeTrace on load (missing -> []), so this step only
      // ensures the shape exists; everything else is a forward no-op. Defensive: run
      // whenever v<6 regardless of whether SCHEMA_VERSION was bumped.
      if (v < 6) {
        if (!Array.isArray(blob.trace)) blob.trace = [];
        v = 6;
      }
      // v6 -> v7 (Wave 4a): gamification + economy. agent.xp/level, top-level
      // credits + upgrades, settings.bgm. All are filled with safe defaults by the
      // load-path normalizers (normalizeXpLevel / normalizeCount / normalizeUpgrades
      // and defaultSettings merge), so this step only ensures the shapes exist on
      // the blob; everything else is a forward no-op. Defensive: run whenever v<7
      // regardless of whether SCHEMA_VERSION was bumped.
      if (v < 7) {
        if (typeof blob.credits !== 'number' || !isFinite(blob.credits)) blob.credits = 0;
        if (!Array.isArray(blob.upgrades)) blob.upgrades = [];
        if (!Array.isArray(blob.knowledge)) blob.knowledge = [];   // KNOWLEDGE: cross-project memory (load normalizer fills defaults)
        if (blob.settings && typeof blob.settings === 'object') {
          if (typeof blob.settings.bgm === 'undefined') blob.settings.bgm = false;
        }
        if (Array.isArray(blob.agents)) {
          for (var gi = 0; gi < blob.agents.length; gi++) {
            var ga = blob.agents[gi];
            if (!ga || typeof ga !== 'object') continue;
            if (typeof ga.xp !== 'number' || !isFinite(ga.xp)) ga.xp = 0;
            // ga.level left absent -> rebuildAgent's normalizeXpLevel derives it.
          }
        }
        v = 7;
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
      // v3: persona + memories (Agents.create normally owns this; mirror here for
      // the inline fallback so store-only seeding still produces complete agents)
      persona: normalizePersona(spec.persona, role),
      memories: Array.isArray(spec.memories) ? normalizeMemories(spec.memories) : [],
      // Wave 4a: gamification - fresh agents start at xp 0 / level 1 (or a spec
      // override; level self-heals from xp). Agents.create normally owns this;
      // mirror here so store-only seeding still yields complete agents.
      xp: normalizeXpLevel(spec.xp, spec.level).xp,
      level: normalizeXpLevel(spec.xp, spec.level).level,
      // Wave B/C: mood / relationships / sprite (default-safe).
      mood: normalizeMood(spec.mood),
      relationships: normalizeRelationships(spec.relationships),
      sprite: normalizeSprite(spec.sprite),
      _idleSince: 0,
      _onArrive: null,
      _attention: false,
      _lastActivityTs: 0,
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
      if (!Array.isArray(s.artifacts)) s.artifacts = [];
      s.artifacts.length = 0;
      if (!s.files || typeof s.files !== 'object') s.files = {};   // v5: empty project workspace
      for (var fk in s.files) {
        if (Object.prototype.hasOwnProperty.call(s.files, fk)) delete s.files[fk];
      }
      if (!Array.isArray(s.knowledge)) s.knowledge = [];
      s.knowledge.length = 0;   // KNOWLEDGE: fresh company starts with no saved learnings (clear in place)
      s.credits = 0;            // Wave 4a: fresh company starts with no credits
      s.upgrades = [];          // Wave 4a: and no purchased upgrades
      s.settings = defaultSettings();
      s.camera = defaultCamera();
      s.selectedAgentId = null;
      s.layoutEdit = false;
      s.paused = false;
      s._time = 0;
      s._meetingActive = false;
      s._activeStreams = {};
      s._followId = null;
      s._buildActive = false;   // v5
      s._ledger = null;         // WAVE 1: fresh company starts with no ledger
      s._lastRun = null;        // WAVE 1: runtime-only

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
        { name: 'Writer',     role: 'writer' },
        { name: 'QA',         role: 'qa' },
        { name: 'Generalist', role: 'generalist' },
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
      return JSON.stringify({ v: schemaVersion(), agents: [], tasks: [], log: [], artifacts: [], files: {}, knowledge: [], credits: 0, upgrades: [], layout: emptyLayout(), settings: defaultSettings() }, null, 2);
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
  // WAVE A §SESSIONS — named project snapshots, stored under their OWN key
  // (STORAGE_KEY + '_sessions'). Completely separate from the active-state
  // autosave (save()/load() above are UNCHANGED). Shape on disk:
  //   { index: [{ id, name, savedAt, agentCount, taskCount, artifactCount }],
  //     blobs: { <id>: <saveBlob> } }
  // Every method is wrapped in try/catch and never throws into the caller.
  // ---------------------------------------------------------------------------

  function sessionsKey() {
    return storageKey() + '_sessions';
  }

  // Read the sessions container; tolerant of missing/corrupt data.
  function readSessions() {
    var empty = { index: [], blobs: {} };
    try {
      var raw = safeGetItem(sessionsKey());
      if (!raw) return empty;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return empty;
      if (!Array.isArray(obj.index)) obj.index = [];
      if (!obj.blobs || typeof obj.blobs !== 'object') obj.blobs = {};
      return obj;
    } catch (e) {
      logErr('readSessions', e);
      return empty;
    }
  }

  function writeSessions(store) {
    try {
      if (!store || typeof store !== 'object') return false;
      var json = JSON.stringify(store);
      return safeSetItem(sessionsKey(), json);
    } catch (e) {
      logErr('writeSessions', e);
      return false;
    }
  }

  // Build a lightweight index row from a save blob.
  function sessionMeta(id, name, blob) {
    return {
      id: id,
      name: name,
      savedAt: (blob && typeof blob.savedAt === 'number') ? blob.savedAt : nowMs(),
      agentCount: (blob && Array.isArray(blob.agents)) ? blob.agents.length : 0,
      taskCount: (blob && Array.isArray(blob.tasks)) ? blob.tasks.length : 0,
      artifactCount: (blob && Array.isArray(blob.artifacts)) ? blob.artifacts.length : 0,
    };
  }

  // listSessions() -> [{id,name,savedAt,agentCount,taskCount,artifactCount}], newest first.
  function listSessions() {
    try {
      var store = readSessions();
      var rows = [];
      for (var i = 0; i < store.index.length; i++) {
        var r = store.index[i];
        if (!r || typeof r !== 'object' || !r.id) continue;
        rows.push({
          id: String(r.id),
          name: (r.name == null) ? 'Session' : String(r.name),
          savedAt: (typeof r.savedAt === 'number') ? r.savedAt : 0,
          agentCount: (typeof r.agentCount === 'number') ? r.agentCount : 0,
          taskCount: (typeof r.taskCount === 'number') ? r.taskCount : 0,
          artifactCount: (typeof r.artifactCount === 'number') ? r.artifactCount : 0,
        });
      }
      rows.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
      return rows;
    } catch (e) {
      logErr('listSessions', e);
      return [];
    }
  }

  // saveSession(name) -> id. Snapshots the CURRENT App.state via buildSaveBlob
  // (the existing serialize path). Overwrites a session with the same name.
  function saveSession(name) {
    try {
      var nm = (name == null || String(name).trim() === '') ? ('Session ' + new Date().toLocaleString()) : String(name).trim();
      var blob = buildSaveBlob();   // reuse existing serialize path
      var store = readSessions();

      // Overwrite if a session with this name already exists.
      var id = null;
      for (var i = 0; i < store.index.length; i++) {
        if (store.index[i] && store.index[i].name === nm) { id = store.index[i].id; break; }
      }
      if (!id) id = uid('sess');

      store.blobs[id] = blob;
      var meta = sessionMeta(id, nm, blob);
      // replace existing index row or append
      var replaced = false;
      for (var j = 0; j < store.index.length; j++) {
        if (store.index[j] && store.index[j].id === id) { store.index[j] = meta; replaced = true; break; }
      }
      if (!replaced) store.index.push(meta);

      writeSessions(store);
      pushLog({ from: 'system', to: 'all', kind: 'system', text: 'Session saved: "' + nm + '".' });
      return id;
    } catch (e) {
      logErr('saveSession', e);
      return null;
    }
  }

  // loadSession(id) -> bool. Replaces App.state contents IN PLACE (preserves the
  // object reference) via the existing applyBlob path. Clamps camera; refreshes UI.
  function loadSession(id) {
    try {
      if (!id) return false;
      var store = readSessions();
      var blob = store.blobs && store.blobs[id];
      if (!blob || typeof blob !== 'object') return false;

      // abort any in-flight streams before swapping state
      abortAllStreams();

      blob = migrate(blob);     // forward-compat with older saved sessions
      applyBlob(blob);          // in-place; clamps camera (applyBlob does this)
      safeUIRefresh();

      var nm = '';
      for (var i = 0; i < store.index.length; i++) {
        if (store.index[i] && store.index[i].id === id) { nm = store.index[i].name || ''; break; }
      }
      pushLog({ from: 'system', to: 'all', kind: 'system', text: 'Session loaded' + (nm ? ': "' + nm + '"' : '') + '.' });
      return true;
    } catch (e) {
      logErr('loadSession', e);
      return false;
    }
  }

  // deleteSession(id) -> bool.
  function deleteSession(id) {
    try {
      if (!id) return false;
      var store = readSessions();
      var found = false;
      var newIndex = [];
      for (var i = 0; i < store.index.length; i++) {
        if (store.index[i] && store.index[i].id === id) { found = true; continue; }
        newIndex.push(store.index[i]);
      }
      store.index = newIndex;
      if (store.blobs && Object.prototype.hasOwnProperty.call(store.blobs, id)) {
        delete store.blobs[id];
        found = true;
      }
      if (found) writeSessions(store);
      return found;
    } catch (e) {
      logErr('deleteSession', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // WAVE A §applyPreset — swap the agent roster for a config PRESET's roster.
  // Removes ALL current agents (incl. boss), creates the preset's agents (each
  // given a desk/home via World.freeDeskCell or a fallback cell), ensures a boss
  // exists, clears tasks + _meetingActive. Keeps the office layout AND artifacts
  // (default). Logs a line. Defensive; never throws.
  // ---------------------------------------------------------------------------

  function findPreset(presetId) {
    var list = (cfg().PRESETS) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === presetId) return list[i];
    }
    return null;
  }

  function applyPreset(presetId) {
    try {
      var preset = findPreset(presetId);
      if (!preset || !Array.isArray(preset.agents)) return false;
      var s = ensureState();

      // 1) abort streams + remove ALL current agents (incl. boss).
      abortAllStreams();
      s.agents.length = 0;
      s.selectedAgentId = null;

      // 2) clear tasks + meeting flag (do NOT touch layout; keep artifacts).
      s.tasks.length = 0;
      s._meetingActive = false;

      // 3) create the preset agents. makeAgent() routes through Agents.create
      //    (which assigns a desk via freeDeskCell) and falls back inline.
      var sawBoss = false;
      for (var i = 0; i < preset.agents.length; i++) {
        var a = preset.agents[i];
        if (!a || typeof a !== 'object') continue;
        var role = a.role || 'generalist';
        if (role === 'boss') sawBoss = true;
        makeAgent({
          name: a.name,
          role: role,
          model: a.model,
          color: a.color,
          systemPrompt: a.systemPrompt,
          persona: a.persona,
          // Wave B/C: forward optional social/sprite fields if a preset defines them.
          mood: a.mood,
          relationships: a.relationships,
          sprite: a.sprite,
        });
      }

      // 4) ensure a boss exists (preset rosters should include one, but be safe).
      if (!sawBoss) {
        makeAgent({ name: 'Boss', role: 'boss' });
      }

      pushLog({ from: 'system', to: 'all', kind: 'system', text: 'Preset applied: ' + (preset.name || preset.id) + '.' });
      save();
      safeUIRefresh();
      return true;
    } catch (e) {
      logErr('applyPreset', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // KNOWLEDGE BASE (contract A) — cross-project company memory. Lives on
  // App.state.knowledge ({id,text,tags[],project,ts}[]), persisted + capped at
  // KNOWLEDGE_CAP. Orchestrator distills LEARNINGS here after a build finalizes;
  // workers read them back via the recall_knowledge tool / decompose injection.
  // Both methods are defensive and NEVER throw (the rAF loop must stay alive).
  // ---------------------------------------------------------------------------

  // addKnowledge(text, meta?) -> the stored entry (or null on empty/failure).
  // Assigns id/ts; meta may set tags/project. No-ops on blank text. Caps the
  // array (oldest dropped) and persists (debounced so rapid adds coalesce).
  function addKnowledge(text, meta) {
    try {
      var s = ensureState();
      if (!Array.isArray(s.knowledge)) s.knowledge = [];
      var m = (meta && typeof meta === 'object') ? meta : {};
      var entry = normalizeKnowledgeEntry({
        text: text,
        tags: m.tags,
        project: m.project,
        // id/ts intentionally derived by the normalizer (fresh entry)
      });
      if (!entry) return null;   // blank text -> no-op
      s.knowledge.push(entry);
      // cap newest KNOWLEDGE_CAP (oldest dropped)
      var cap = knowledgeCap();
      if (s.knowledge.length > cap) {
        s.knowledge.splice(0, s.knowledge.length - cap);
      }
      saveDebounced();
      return entry;
    } catch (e) {
      logErr('addKnowledge', e);
      return null;
    }
  }

  // getKnowledge(query?, k?) -> array of up to k entries (default
  // KNOWLEDGE_INJECT_K). With a query, rank by lowercased keyword overlap
  // (token intersection of query vs entry text+tags+project); ties + no-query
  // fall back to most-recent first. Returns shallow copies. Never throws.
  function getKnowledge(query, k) {
    try {
      var s = ensureState();
      var list = Array.isArray(s.knowledge) ? s.knowledge : [];
      var lim = (typeof k === 'number' && isFinite(k) && k > 0) ? Math.floor(k) : knowledgeInjectK();
      if (!list.length) return [];

      var q = (query == null) ? '' : String(query).trim();
      var rows = [];
      var i, e;

      if (!q) {
        // most-recent first
        for (i = list.length - 1; i >= 0 && rows.length < lim; i--) {
          e = list[i];
          if (e && typeof e === 'object') {
            rows.push({ id: e.id, text: e.text, tags: (e.tags || []).slice(), project: e.project, ts: e.ts });
          }
        }
        return rows;
      }

      // keyword-overlap ranking
      var qTokens = knowledgeTokens(q);
      var scored = [];
      for (i = 0; i < list.length; i++) {
        e = list[i];
        if (!e || typeof e !== 'object') continue;
        var hay = String(e.text || '') + ' ' + ((e.tags || []).join(' ')) + ' ' + String(e.project || '');
        var hTokens = knowledgeTokens(hay);
        var overlap = 0;
        for (var t in qTokens) {
          if (Object.prototype.hasOwnProperty.call(qTokens, t) &&
              Object.prototype.hasOwnProperty.call(hTokens, t)) overlap++;
        }
        scored.push({ e: e, score: overlap, idx: i });
      }
      // sort: higher overlap first, then most-recent (higher idx) as tie-break.
      scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return b.idx - a.idx;
      });
      for (i = 0; i < scored.length && rows.length < lim; i++) {
        e = scored[i].e;
        rows.push({ id: e.id, text: e.text, tags: (e.tags || []).slice(), project: e.project, ts: e.ts });
      }
      return rows;
    } catch (e2) {
      logErr('getKnowledge', e2);
      return [];
    }
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
    // WAVE A: named project sessions (separate from the autosave above).
    listSessions: listSessions,
    saveSession: saveSession,
    loadSession: loadSession,
    deleteSession: deleteSession,
    // WAVE A: swap the agent roster for a config preset.
    applyPreset: applyPreset,
    // KNOWLEDGE (contract A): cross-project company memory.
    addKnowledge: addKnowledge,
    getKnowledge: getKnowledge,
  };

  // §7.10 REQUIRED compat alias: orch.md used App.Store.log
  App.Store.log = App.Store.pushLog;

})();
