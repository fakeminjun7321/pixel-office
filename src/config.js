// =============================================================================
// config.js  →  App.config, App.util
// PIXEL AI COMPANY ("NEON//WORKS") — constants, enums, palette, roles, utils.
//
// Authority: SPEC.md is the SINGLE SOURCE OF TRUTH.
//   - §2  App.config literal + App.util + STATES
//   - §4.2 TILES enum (arch numbering: FLOOR:0 … VOID:5)
//   - §4.3 FURNITURE footprints
//   - §5  full palette  + §5.1 roleColor + §5.3 stateColor
//   - §6  ROLES (keys/colors/models/glyphs/webSearchPreferred/system prompts)
//   - §6.3 Boss decompose (stored as ROLES.boss.system) + Boss synth prompt
//
// LOAD ORDER: this is module #1. It defines App.config and App.util ONLY.
//   Every other module reads App.config.* and App.util.* — so this must run first.
//
// Classic <script>; no import/export; no top-level await. Attaches to window.App.
// NOTE: palette is a PLAIN object shared by reference with PixelArt (SPEC §5) —
//   it is intentionally NOT frozen. roleColor is mirrored into ROLES[key].color
//   after the literal so the two never drift.
// =============================================================================
window.App = window.App || {};

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // §5 COLOR PALETTE (PINNED — the ONLY colors allowed in logic).
  // Mirrored to App.PixelArt.palette (same object reference). Plain object.
  // ---------------------------------------------------------------------------
  var palette = {
    // environment
    void: '#070912', floor: '#0d1226', floorAlt: '#0f1530',
    gridLine: '#1c2b55', gridGlow: '#2e57b8',
    wallFace: '#141a33', wallTop: '#1d264a', wallTrim: '#39d7ff', wallShadow: '#080b18',

    // 5 signature neons + 2 functional
    cyan: '#39d7ff', magenta: '#ff3df0', purple: '#9b5cff', blue: '#4d7cff', lime: '#5dff9b',
    amber: '#ffc24d', red: '#ff4d6d',

    // body
    suitDark: '#23304f', suitMid: '#33436b',
    skin: ['#e8b48c', '#c98a63', '#f2c7a8', '#a86c4a'],
    hair: ['#1a1d2e', '#3a2f4f', '#5a4a35'],
    boot: '#11162b', outline: '#05070f',

    // UI chrome
    uiPanel: '#0b1024', uiPanelEdge: '#22305c', uiText: '#dce6ff', uiTextDim: '#8294c4',
    uiTextFaint: '#4d5d8a', uiBtn: '#16203f', uiBtnHover: '#1d2c54', uiField: '#0a0f20',
    uiDivider: '#1a2647', uiScrim: 'rgba(5,7,15,0.72)'
  };

  // ---------------------------------------------------------------------------
  // §5.1 Role default neon colors (PINNED). Each role draws from the signature
  // palette for cohesion. Mirrored into ROLES[key].color below.
  // ---------------------------------------------------------------------------
  var roleColor = {
    boss: '#39d7ff',        // cyan
    engineer: '#4d7cff',    // blue
    designer: '#ff3df0',    // magenta
    researcher: '#5dff9b',  // lime
    writer: '#ffc24d',      // amber
    qa: '#ff4d6d',          // red
    generalist: '#9b5cff'   // purple
  };

  // ---------------------------------------------------------------------------
  // §5.3 State badge colors (PINNED). 'error' is a transient badge (not a state).
  // ---------------------------------------------------------------------------
  var stateColor = {
    idle: '#8294c4', walking: '#39d7ff', thinking: '#ffc24d', coding: '#5dff9b',
    searching: '#ffc24d', meeting: '#9b5cff', coffee: '#dce6ff', error: '#ff4d6d'
  };

  // ---------------------------------------------------------------------------
  // §4.2 TILE enum (PINNED — arch numbering WINS).
  // layout.tiles[gy][gx]. Walkable: FLOOR,CARPET,DOOR,RUG. Blocking: WALL,VOID.
  // ---------------------------------------------------------------------------
  var TILES = { FLOOR: 0, WALL: 1, CARPET: 2, DOOR: 3, RUG: 4, VOID: 5 };

  // ---------------------------------------------------------------------------
  // §4.3 FURNITURE definitions (PINNED). w/h = footprint cells; blocks = occupies
  // (non-walkable) cells; hasSeat = an agent can "use" it from an adjacent seat.
  // ---------------------------------------------------------------------------
  var FURNITURE = {
    desk:         { w: 2, h: 1, blocks: true,  hasSeat: true  },
    server:       { w: 1, h: 1, blocks: true,  hasSeat: false },
    meetingTable: { w: 3, h: 2, blocks: true,  hasSeat: true  },
    chair:        { w: 1, h: 1, blocks: false, hasSeat: true  },
    plant:        { w: 1, h: 1, blocks: true,  hasSeat: false },
    coffee:       { w: 1, h: 1, blocks: true,  hasSeat: true  },
    neonSign:     { w: 1, h: 1, blocks: false, hasSeat: false },
    whiteboard:   { w: 2, h: 1, blocks: true,  hasSeat: false }
  };

  // ---------------------------------------------------------------------------
  // §6.1 Shared worker preamble — prepended to EVERY worker prompt
  // (engineer/designer/researcher/writer/qa/generalist).
  // ---------------------------------------------------------------------------
  var WORKER_PREAMBLE =
'You are a worker agent inside "Pixel AI Company", an autonomous AI software company.\n' +
'You receive ONE focused instruction from the Boss orchestrator and you complete exactly that, nothing more.\n' +
'Rules:\n' +
'- Do the task fully and concretely. Produce the actual deliverable (code, copy, analysis), not a plan to do it.\n' +
'- Be self-contained: the Boss will read ONLY your final message, so put the real result there.\n' +
'- Stay strictly in scope. Do not ask the Boss questions; if something is ambiguous, make a sensible\n' +
'  assumption, state it in one short line, and proceed.\n' +
'- Output plain text/markdown. No preamble like "Sure!" — start with the deliverable.\n' +
'- Keep it tight: aim for the shortest complete answer. End with a one-line "RESULT:" summary the Boss can quote.';

  // §6.2 Role-specific bodies (verbatim from orch.md).
  var ENGINEER_BODY =
'ROLE: Senior Software Engineer.\n' +
'You write correct, runnable, idiomatic code and terse technical explanations.\n' +
'- Default to a single self-contained snippet unless told otherwise. Include only the code that is needed.\n' +
'- Note language/runtime assumptions in one line if not specified.\n' +
'- If asked to design, give concrete interfaces/data shapes, not vague prose.\n' +
'- Prefer standard libraries; avoid inventing dependencies.\n' +
'RESULT: line = one sentence stating what you built and how to use it.';

  var DESIGNER_BODY =
'ROLE: Product / Visual Designer.\n' +
'You produce concrete design specs: layouts, component lists, color/typography tokens, copy for UI,\n' +
'and rationale tied to usability. Use exact values (hex, px, spacing scale) not adjectives.\n' +
'- When visuals are needed, describe them precisely enough to implement, or give ASCII/structural mockups.\n' +
'- Tie every choice to a user goal in <=1 short clause.\n' +
'RESULT: line = the single most important design decision.';

  var RESEARCHER_BODY =
'ROLE: Research Analyst.\n' +
'You gather and synthesize current, accurate information and present it as crisp findings.\n' +
'- If web search is available, use it for anything time-sensitive, factual, or version-specific.\n' +
'- Cite sources inline as [n] with a short Sources list at the end when you used the web.\n' +
'- Separate FACTS (sourced) from your INFERENCE. Never fabricate citations or numbers.\n' +
'- Output bullet findings, most-decision-relevant first.\n' +
'RESULT: line = the key takeaway for the Boss.';

  var WRITER_BODY =
'ROLE: Technical & Marketing Writer.\n' +
'You turn raw material into clear, well-structured prose in the requested tone/format.\n' +
'- Match the audience and length implied by the instruction; if unspecified, be concise and neutral.\n' +
'- Strong structure: headline + scannable sections. No filler, no clichés.\n' +
'- Preserve any facts/numbers from input exactly; do not invent specifics.\n' +
'RESULT: line = the finished piece\'s one-sentence thesis.';

  var QA_BODY =
'ROLE: Quality Assurance / Reviewer.\n' +
'You critically review the provided artifact for correctness, completeness, and edge cases.\n' +
'- Output: (1) a PASS/FAIL verdict, (2) a numbered list of concrete issues with severity [blocker|major|minor],\n' +
'  (3) the minimal fix for each. Be specific (quote the offending part).\n' +
'- If you cannot find issues, say PASS and list the top risks you checked.\n' +
'RESULT: line = verdict + issue count, e.g. "FAIL — 2 blockers, 1 minor".';

  var GENERALIST_BODY =
'ROLE: Generalist Operator.\n' +
'Handle whatever the instruction asks as competently as possible, end-to-end. Produce the real deliverable.\n' +
'RESULT: line = one-sentence summary of what you delivered.';

  // worker system = preamble + "\n\n" + body
  function worker(body) { return WORKER_PREAMBLE + '\n\n' + body; }

  // §6.3 BOSS_DECOMPOSE_SYSTEM (Boss turn A — stored as ROLES.boss.system).
  var BOSS_DECOMPOSE_SYSTEM =
'You are the BOSS / orchestrator of an autonomous AI company. The user gives you ONE high-level goal.\n' +
'Your job is ONLY to break it into focused subtasks for your worker agents and to plan the final synthesis.\n' +
'\n' +
'Available worker roles (use the exact key string):\n' +
'- "engineer"  : writes code, technical design, implementation.\n' +
'- "designer"  : UI/UX, visual specs, layout, copy for interfaces.\n' +
'- "researcher": gathers/synthesizes current external information (can use web search).\n' +
'- "writer"    : long-form prose, docs, marketing, summaries.\n' +
'- "qa"        : reviews/critiques an artifact for correctness and edge cases.\n' +
'\n' +
'Decompose the goal into 1–5 subtasks (fewer is better; only split when a different role or clearly\n' +
'parallel piece of work is genuinely needed). Order them so dependencies come first; later tasks may\n' +
'rely on the RESULTS of earlier ones (you will be given those results during synthesis).\n' +
'\n' +
'You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.\n' +
'Schema:\n' +
'{\n' +
'  "plan": [\n' +
'    { "role": "<one of the role keys>",\n' +
'      "title": "<=6 word label shown on the kanban card",\n' +
'      "instruction": "<the full, self-contained instruction for that worker>",\n' +
'      "needsWeb": <true|false>\n' +
'    }\n' +
'  ],\n' +
'  "final": "<one sentence telling yourself how to combine the workers\' results into the user\'s answer>"\n' +
'}\n' +
'\n' +
'Rules:\n' +
'- 1 to 5 items in "plan". Each instruction must be complete on its own (the worker cannot see the user\'s\n' +
'  original goal — only your instruction).\n' +
'- Use only the role keys listed. If the goal is trivial/single-step, return a one-item plan.\n' +
'- Do NOT include comments or trailing commas. Output valid JSON parseable by JSON.parse.';

  // §6.3 BOSS_SYNTH_SYSTEM (Boss turn B).
  var BOSS_SYNTH_SYSTEM =
'You are the BOSS of an autonomous AI company. Your workers have completed their subtasks.\n' +
'Combine their results into ONE final answer that fully satisfies the user\'s original goal.\n' +
'- Integrate the pieces; resolve any conflicts; do not just concatenate.\n' +
'- Keep what\'s good, fix obvious gaps, and present it cleanly for the user (markdown ok).\n' +
'- If a subtask failed, work around it gracefully and note the limitation briefly.\n' +
'- Do not mention this internal process unless useful. Just deliver the result.';

  // ---------------------------------------------------------------------------
  // §6 ROLES (PINNED — keys, colors, models, glyphs, webSearchPreferred, system).
  // Model defaults: boss=opus-4-8; qa=haiku-4-5; all others=sonnet-4-6.
  // researcher.webSearchPreferred=true; all others false.
  // color is mirrored from roleColor below (kept here too for self-containment).
  // ---------------------------------------------------------------------------
  var ROLES = {
    boss: {
      label: 'Boss', color: roleColor.boss, model: 'claude-opus-4-8', glyph: 'hexnode',
      webSearchPreferred: false, system: BOSS_DECOMPOSE_SYSTEM,
      // synth prompt also stashed on the role for callers that look here (§6.3 turn B).
      synthSystem: BOSS_SYNTH_SYSTEM
    },
    engineer: {
      label: 'Engineer', color: roleColor.engineer, model: 'claude-sonnet-4-6', glyph: 'wrench',
      webSearchPreferred: false, system: worker(ENGINEER_BODY)
    },
    designer: {
      label: 'Designer', color: roleColor.designer, model: 'claude-sonnet-4-6', glyph: 'palette',
      webSearchPreferred: false, system: worker(DESIGNER_BODY)
    },
    researcher: {
      label: 'Researcher', color: roleColor.researcher, model: 'claude-sonnet-4-6', glyph: 'magnifier',
      webSearchPreferred: true, system: worker(RESEARCHER_BODY)
    },
    writer: {
      label: 'Writer', color: roleColor.writer, model: 'claude-sonnet-4-6', glyph: 'pen',
      webSearchPreferred: false, system: worker(WRITER_BODY)
    },
    qa: {
      label: 'QA', color: roleColor.qa, model: 'claude-haiku-4-5-20251001', glyph: 'check',
      webSearchPreferred: false, system: worker(QA_BODY)
    },
    generalist: {
      label: 'Generalist', color: roleColor.generalist, model: 'claude-sonnet-4-6', glyph: 'star',
      webSearchPreferred: false, system: worker(GENERALIST_BODY)
    }
  };

  // ---------------------------------------------------------------------------
  // §2 App.config — the master constants object.
  // ---------------------------------------------------------------------------
  App.config = {
    // grid / world geometry
    TILE: 16,            // world px per cell edge
    PIXEL: 3,            // base upscale: 1 world px -> 3 screen px @ zoom 1 (cell = 48 screen px @ zoom1)
    GRID_COLS: 46,       // v2: bigger multi-room office
    GRID_ROWS: 30,       // v2: bigger multi-room office

    // camera
    ZOOM_MIN: 0.5,
    ZOOM_MAX: 3.0,
    ZOOM_STEP: 0.15,
    CAMERA_START: { x: 0, y: 0, zoom: 1.0 },

    // movement / animation
    WALK_SPEED: 48,      // world px/sec
    ARRIVE_EPS: 1.0,     // world px to count a waypoint reached
    ANIM_FPS: 6,         // walk/type frame advance rate
    BOB_PERIOD: 1.6,     // idle bob seconds/cycle
    BUBBLE_MS: 4500,     // default bubble lifetime if `ms` omitted

    // orchestration
    MAX_CONCURRENT: 2,   // v2: gentler pacing — cap on simultaneously-running worker subtasks
    CULL_TEMP_AGENTS: true,
    TEMP_AGENT_TTL_MS: 60000,
    DIRECT_CHAT_BLOCKS: false,
    DELEGATE_STAGGER_MS: 1200,   // v2: slower stagger between delegations

    // API
    API_URL: 'https://api.anthropic.com/v1/messages',
    OPENAI_URL: 'https://api.openai.com/v1/chat/completions',   // v2: OpenAI chat-completions endpoint
    API_VERSION: '2023-06-01',
    DEFAULT_MODEL: 'claude-sonnet-4-6',          // worker default
    BOSS_MODEL:    'claude-opus-4-8',            // boss default
    FAST_MODEL:    'claude-haiku-4-5-20251001',
    // v2: provider-tagged model list (Anthropic + OpenAI). provider drives API.stream routing.
    MODELS: [
      { id: 'claude-opus-4-8',           label: 'Opus 4.8',   provider: 'anthropic' },
      { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', provider: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  provider: 'anthropic' },
      { id: 'gpt-4o',                    label: 'GPT-4o',     provider: 'openai' },
      { id: 'gpt-4o-mini',               label: 'GPT-4o mini', provider: 'openai' },
      { id: 'gpt-4.1',                   label: 'GPT-4.1',    provider: 'openai' }
    ],
    MAX_TOKENS: 4096,
    WEB_SEARCH_TOOL: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },

    // v2: retry / exponential-backoff tuning for transient network/HTTP failures (api.js).
    RETRY_MAX: 4,
    RETRY_BASE_MS: 700,
    RETRY_MAX_MS: 8000,

    // v2: provider resolver — OpenAI ids start with gpt/o1/o3/o4/chatgpt; else Anthropic.
    providerOf: function (modelId) {
      return /^(gpt|o1|o3|o4|chatgpt)/i.test(String(modelId || '')) ? 'openai' : 'anthropic';
    },

    // boss orchestration prompts (§6.3). BOSS_SYNTH_SYSTEM is read by
    // Orchestrator.synthesize (CFG().BOSS_SYNTH_SYSTEM). The decompose prompt
    // is the canonical ROLES.boss.system; exposed here too for symmetry.
    BOSS_DECOMPOSE_SYSTEM: BOSS_DECOMPOSE_SYSTEM,
    BOSS_SYNTH_SYSTEM: BOSS_SYNTH_SYSTEM,

    // persistence
    STORAGE_KEY: 'pixel_ai_company_v1',
    SCHEMA_VERSION: 1,

    // enums + palette + roles
    TILES: TILES,
    FURNITURE: FURNITURE,
    ROLES: ROLES,
    palette: palette,

    // visual states (the 7 canonical agent states; 'error' is a transient badge,
    // NOT an agent.state value — handled via bubble + flash).
    STATES: ['idle', 'walking', 'thinking', 'coding', 'searching', 'meeting', 'coffee'],

    // sprite metrics
    SPR_W: 16, SPR_H: 24,

    // role -> default neon color & state -> badge color (mirror palette; §5)
    roleColor: roleColor,
    stateColor: stateColor,

    // FX toggles
    fx: { scanlines: true, bloom: true, vignette: true }
  };

  // ---------------------------------------------------------------------------
  // §2 App.util — small, pure helpers. Date.now()/Math.random() live ONLY inside
  // these functions (this is real browser code; deterministic restriction does
  // not apply here).
  // ---------------------------------------------------------------------------
  App.util = {
    uid: function (prefix) {
      return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },
    clamp: function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
    hash: function (str) {
      var h = 2166136261;
      str = String(str == null ? '' : str);
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (h >>> 0);
    },
    firstWords: function (s, n) { return String(s || '').split(/\s+/).slice(0, n).join(' '); },
    truncate: function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; },
    // v2: mirror of App.config.providerOf so callers can resolve provider from either surface.
    providerOf: function (modelId) {
      return /^(gpt|o1|o3|o4|chatgpt)/i.test(String(modelId || '')) ? 'openai' : 'anthropic';
    }
  };

})();
