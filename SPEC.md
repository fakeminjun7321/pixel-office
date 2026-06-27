# SPEC.md — PIXEL AI COMPANY ("NEON//WORKS") — AUTHORITATIVE BUILD CONTRACT

> This file is the SINGLE SOURCE OF TRUTH. It reconciles `design_arch.md` (module/namespace
> authority), `design_orch.md` (agent/orchestration runtime authority), and `design_visual.md`
> (art authority). **Where any design doc disagrees with this file, THIS FILE WINS.**
> Implementers MUST follow the exact names, shapes, IDs, and constants below. It is a checklist.
>
> Reconciliation rulings made here (read once):
> - **Tile enum** = arch.md numbering (FLOOR:0 … VOID:5). visual.md's enum is overridden.
> - **ROLES key set** = orch.md set: boss, engineer, designer, researcher, writer, qa, generalist
>   (arch.md's `analyst` is dropped). **Prompt text** = orch.md. **Colors** are pinned in §5 below
>   (a single reconciled palette; both docs' color guesses are overridden by §5).
> - **Function names**: where arch.md and orch.md gave different names for the same capability,
>   the names pinned in §7 are FINAL (e.g. `World.findPath(start,goal)`, `Agents.goToCell`,
>   `Agents.chat`, `Store.pushLog`). The other names are NOT defined; do not create aliases unless
>   listed in §7.10 (compat aliases) which ARE required.
> - **DOM IDs** = arch.md §8 plus the additions in §8 below (modal preview canvases, segment groups).

---

## 1. NAMESPACE & LOAD ORDER

First line of EVERY module:
```js
window.App = window.App || {};
```
- Classic `<script>` blocks only. **NO** `import` / `export` / top-level `await`. No CDN/npm/build.
- Each module assigns exactly ONE sub-object of `App`. Only `Store` seeds `App.state`. `config.js`
  defines `App.config` and `App.util`.
- Modules may reference other `App.*` members ONLY inside function bodies (run after `main.init`),
  EXCEPT reading `App.config` constants (config.js is guaranteed first).
- **Load order (concatenation order; main.js LAST, the only auto-running file):**

```
1. config.js        → App.config, App.util               (constants, TILES, FURNITURE, ROLES, MODELS, palette, uid)
2. pixelart.js      → App.PixelArt                        (pure procedural drawing)
3. world.js         → App.World                           (grid, camera math, pathfinding, defaultLayout)
4. api.js           → App.API                             (Anthropic SSE streaming)
5. store.js         → App.Store                           (persistence + seeding; creates App.state)
6. agents.js        → App.Agents                          (factory, sim, direct chat, draw)
7. orchestrator.js  → App.Orchestrator                    (boss decompose/delegate/synthesize, queue)
8. ui.js            → App.UI                              (DOM panels/modals, input, camera controls)
9. main.js          → App.main; calls App.main.init()     (bootstrap + rAF loop) — LAST
```

### Call graph (no cycles; nobody calls `main`)
```
main         → Store, UI, Agents, Orchestrator, World, PixelArt
UI           → World, Agents, Orchestrator, Store, PixelArt, config, state
Orchestrator → Agents, API, Store, World, UI(.refresh*/.show*), config, state
Agents       → World, PixelArt, API (direct chat), Store, config, state
World        → config, state
PixelArt     → config (palette only); otherwise pure
API          → config (no state access; caller passes key/model)
Store        → World(defaultLayout), config, state
```

---

## 2. App.config (config.js — constants, frozen at load)

```js
App.config = {
  // grid / world geometry
  TILE: 16,            // world px per cell edge
  PIXEL: 3,            // base upscale: 1 world px -> 3 screen px @ zoom 1 (cell = 48 screen px @ zoom1)
  GRID_COLS: 30,
  GRID_ROWS: 20,

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
  MAX_CONCURRENT: 4,   // cap on simultaneously-running worker subtasks
  CULL_TEMP_AGENTS: true,
  TEMP_AGENT_TTL_MS: 60000,
  DIRECT_CHAT_BLOCKS: false,
  DELEGATE_STAGGER_MS: 600,

  // API
  API_URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  DEFAULT_MODEL: 'claude-sonnet-4-6',          // worker default
  BOSS_MODEL:    'claude-opus-4-8',            // boss default
  FAST_MODEL:    'claude-haiku-4-5-20251001',
  MODELS: [
    { id: 'claude-opus-4-8',           label: 'Opus 4.8 (most capable)' },
    { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6 (balanced)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast/cheap)' },
  ],
  MAX_TOKENS: 4096,
  WEB_SEARCH_TOOL: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },

  // persistence
  STORAGE_KEY: 'pixel_ai_company_v1',
  SCHEMA_VERSION: 1,

  // enums + palette + roles (filled below)
  TILES:    { /* §4.2 */ },
  FURNITURE:{ /* §4.3 */ },
  ROLES:    { /* §6   */ },
  palette:  { /* §5   */ },

  // sprite metrics
  SPR_W: 16, SPR_H: 24,

  // role -> default neon color & state -> badge color (mirror palette; §5)
  roleColor:  { /* §6 */ },
  stateColor: { /* §5.3 */ },

  // FX toggles
  fx: { scanlines: true, bloom: true, vignette: true },
};

App.util = {
  uid(prefix){ return (prefix||'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); },
  clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); },
  hash(str){ let h=2166136261; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return (h>>>0); },
  firstWords(s,n){ return String(s||'').split(/\s+/).slice(0,n).join(' '); },
  truncate(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n)+'…' : s; },
};
```
- `App.config.STATES` (the 7 visual states, canonical order):
  `['idle','walking','thinking','coding','searching','meeting','coffee']` plus `'error'` is a
  transient badge state (NOT an agent.state value; error is shown via bubble + flash, agent.state
  returns to `idle`).

---

## 3. App.state (created/seeded by Store; the shared mutable singleton)

```js
App.state = {
  agents: [],   // Agent[]   (§3.1)
  tasks:  [],   // Task[]    (§3.2)
  log:    [],   // LogEntry[]: { t:Number(ms), from:String, to:String,
                //              kind:'system'|'msg'|'result'|'error', text:String }

  camera: { x:0, y:0, zoom:1.0 },   // x,y = WORLD-px of screen top-left; zoom in [ZOOM_MIN,ZOOM_MAX]

  layout: { cols:30, rows:20, tiles:[/*[gy][gx]*/], furniture:[/*Furniture*/] },  // §4

  settings: {
    apiKey: '', defaultModel: 'claude-sonnet-4-6', bossModel: 'claude-opus-4-8',
    webSearch: true, theme: 'neon',
  },

  selectedAgentId: null,   // String|null
  layoutEdit: false,       // Boolean
  paused: false,           // Boolean (loop runs; sim update + tick early-return)

  // runtime-only — NOT persisted (Store strips on save)
  _time: 0,                // seconds since loop start
  _meetingActive: false,
  _activeStreams: {},      // agentId -> {abort()}  (so streams can be cancelled)
};
```

### 3.1 Agent shape (definitive)
```js
Agent = {
  id:String, name:String, role:String /*key of ROLES*/, model:String, systemPrompt:String,
  color:String /*neon hex*/,
  gx:Number, gy:Number,                 // home/desk grid cell (ints)
  x:Number,  y:Number,                  // current WORLD-px (cell center when seated)
  path:[],                              // Array<{gx,gy}> remaining waypoints (excl current, incl goal)
  facing:'down',                        // 'up'|'down'|'left'|'right'
  state:'idle',                         // one of the 7 states (§2 STATES)
  anim:{ frame:0, t:0 },
  bubble:null,                          // null | { text:String, until:Number(ms epoch) }
  conversation:[],                      // [{role:'user'|'assistant', content:String}]
  currentTaskId:null,
  stats:{ tasksDone:0, tokensIn:0, tokensOut:0 },
  busy:false,                           // true while a stream is in flight for this agent
  temp:false,                           // true for orchestrator-spawned temp workers
  _idleSince:0,                         // ms epoch when last went idle (temp culling)
  _onArrive:null,                       // internal: callback fired when path empties (do not persist)
}
```

### 3.2 Task shape (definitive)
```js
Task = {
  id:String, title:String, desc:String /*instruction body given to worker*/,
  assignee:String|null /*agentId*/,
  status:'queued'|'running'|'blocked'|'done'|'error',
  parentId:String|null, subtaskIds:[],
  result:String|null, error:String|null,
  createdAt:Number /*ms*/, role:String /*ROLES key; fallback 'generalist'*/,
  needsWeb:Boolean,                     // from plan; default role.webSearchPreferred
  _ctrl:null,                           // internal AbortController/handle (do not persist)
}
```
- Kanban grouping: **Queued** = `queued`+`blocked`; **Running** = `running`; **Done** = `done`+`error`.

### 3.3 Persistence boundary (Store.save / load)
- **Persist:** `agents` (stripped), `tasks` (stripped), `log` (cap 500), `layout`, `settings`,
  `selectedAgentId`, `camera` (clamped on load).
- **Strip from agents on save:** `x,y,path,anim,bubble,busy,_idleSince,_onArrive` and any `_*`.
  Drop `temp:true` agents entirely (do not persist temp workers).
- **Strip from tasks on save:** `_ctrl` and any `_*`. Drop tasks whose `status` is `running` →
  rewrite to `queued` on save (so a reload re-runs them) OR drop child tasks of an incomplete root
  (implementer choice; default: keep tasks, reset `running`→`queued`, clear `_ctrl`).
- **Strip from state:** `_time,_meetingActive,_activeStreams`.
- **On load:** rebuild each agent's transient fields from `gx,gy` (place at cell center, empty path,
  `state:'idle'`, `anim:{frame:0,t:0}`, `bubble:null`, `busy:false`). Clamp camera via `World.clampCamera`.

---

## 4. LAYOUT — coordinate system, tiles, furniture

### 4.1 Coordinate system (PINNED — worked example)
- WORLD px: 1 cell = `TILE` (16) world px. SCREEN px per world px = `PIXEL * camera.zoom`.
  → 1 cell = `16*3*zoom` screen px = 48 @ zoom 1.
- `camera.x, camera.y` = WORLD coords of the screen's top-left corner.
- Transforms (World owns them; all canvas math goes through these):
  - `worldToScreen(wx,wy) = { x:(wx-cam.x)*PIXEL*zoom, y:(wy-cam.y)*PIXEL*zoom }`
  - `screenToWorld(sx,sy) = { x: sx/(PIXEL*zoom)+cam.x, y: sy/(PIXEL*zoom)+cam.y }`
  - `cellToWorld(gx,gy) = { x:(gx+0.5)*TILE, y:(gy+0.5)*TILE }`   (cell CENTER)
  - `worldToCell(wx,wy) = { gx:floor(wx/TILE), gy:floor(wy/TILE) }`
- Worked: agent at cell (5,4), cam {0,0,1} → world center (88,72) → screen (264,216).
- Canvas is sized to CSS box × devicePixelRatio in `main.resize`; main applies the DPR transform ONCE
  (`ctx.setTransform(dpr,0,0,dpr,0,0)`), so PixelArt/World/UI all work in **CSS screen px** (treat
  screen px == CSS px). DPR is invisible to every module except main.
- Zoom-toward-cursor (UI.onWheel): keep world point under cursor fixed:
  `cam.x = worldUnderCursor.x - cursorScreenX/(PIXEL*newZoom)` (and y likewise), then `clampCamera()`.

### 4.2 Tile enum (PINNED — arch numbering wins)
```js
App.config.TILES = { FLOOR:0, WALL:1, CARPET:2, DOOR:3, RUG:4, VOID:5 };
```
- `layout.tiles[gy][gx]` (row-major; first index = gy/row, second = gx/col).
- **Walkable:** FLOOR, CARPET, DOOR, RUG. **Blocking:** WALL, VOID. Out-of-bounds = VOID.
- Visual mapping for the art (visual.md zones map onto these tiles):
  - `CARPET` (2) = generic accent zone → use for the **Boss zone** (cyan-bordered) per visual §2.4.
  - `RUG` (4) = meeting-room rug under the table (purple-bordered) per visual §2.4.
  - `DOOR` (3) = doorway with lime seam (visual §2.3). `WALL` (1) = neon-trim wall (visual §2.2).
  - `FLOOR` (0) = neon grid (visual §2.1). `VOID` (5) = deep `palette.void`, drawn flat (no grid).
  - PixelArt.drawTile picks Boss-cyan vs meeting-purple border for CARPET vs RUG respectively.

### 4.3 Furniture (PINNED)
```js
App.config.FURNITURE = {
  desk:        { w:2, h:1, blocks:true,  hasSeat:true  },
  server:      { w:1, h:1, blocks:true,  hasSeat:false },
  meetingTable:{ w:3, h:2, blocks:true,  hasSeat:true  },
  chair:       { w:1, h:1, blocks:false, hasSeat:true  },
  plant:       { w:1, h:1, blocks:true,  hasSeat:false },
  coffee:      { w:1, h:1, blocks:true,  hasSeat:true  },
  neonSign:    { w:1, h:1, blocks:false, hasSeat:false },
  whiteboard:  { w:2, h:1, blocks:true,  hasSeat:false },
};

Furniture = {
  id:String, type:String /*FURNITURE key*/, gx:Number, gy:Number, dir:'up'|'down'|'left'|'right',
  w:Number, h:Number,            // footprint cells (default from FURNITURE def)
  walkable:Boolean,              // if true, does NOT block pathfinding (e.g. chair, neonSign)
  seatGx:Number|null, seatGy:Number|null,  // walkable cell an agent stands on to "use" it
}
```
- A blocking furniture occupies all `w*h` cells (those cells are NOT walkable).
- `seatGx/seatGy` (for `hasSeat`) is a WALKABLE cell adjacent to the prop on the `dir` side.
- `World.defaultLayout()` MUST give every seeded agent a `desk` whose `seat == agent (gx,gy)`.
- Art: visual.md `sign` == `neonSign`, `table` == `meetingTable`. Map those names accordingly.

---

## 5. COLOR PALETTE (PINNED — the ONLY colors allowed in logic)

Exposed as `App.config.palette` AND mirrored to `App.PixelArt.palette` (same object reference).
No ad-hoc hex anywhere except this block. UI CSS uses the matching `--vars` in §8.4.

```js
App.config.palette = {
  // environment
  void:'#070912', floor:'#0d1226', floorAlt:'#0f1530',
  gridLine:'#1c2b55', gridGlow:'#2e57b8',
  wallFace:'#141a33', wallTop:'#1d264a', wallTrim:'#39d7ff', wallShadow:'#080b18',

  // 5 signature neons + 2 functional
  cyan:'#39d7ff', magenta:'#ff3df0', purple:'#9b5cff', blue:'#4d7cff', lime:'#5dff9b',
  amber:'#ffc24d', red:'#ff4d6d',

  // body
  suitDark:'#23304f', suitMid:'#33436b',
  skin:['#e8b48c','#c98a63','#f2c7a8','#a86c4a'],
  hair:['#1a1d2e','#3a2f4f','#5a4a35'],
  boot:'#11162b', outline:'#05070f',

  // UI chrome
  uiPanel:'#0b1024', uiPanelEdge:'#22305c', uiText:'#dce6ff', uiTextDim:'#8294c4',
  uiTextFaint:'#4d5d8a', uiBtn:'#16203f', uiBtnHover:'#1d2c54', uiField:'#0a0f20',
  uiDivider:'#1a2647', uiScrim:'rgba(5,7,15,0.72)',
};
```

### 5.1 Role default colors (PINNED — reconciled; overrides both docs' guesses)
Each role's neon accent is drawn from the signature palette for cohesion:
```js
App.config.roleColor = {
  boss:'#39d7ff',        // cyan
  engineer:'#4d7cff',    // blue
  designer:'#ff3df0',    // magenta
  researcher:'#5dff9b',  // lime
  writer:'#ffc24d',      // amber
  qa:'#ff4d6d',          // red
  generalist:'#9b5cff',  // purple
};
```
Mirrored into each `ROLES[key].color` (§6). `Agents.create` resolves color =
`spec.color || ROLES[role].color || palette.purple`.

### 5.2 Glow recipe
`ctx.shadowColor = neon; ctx.shadowBlur = 6..14; ctx.shadowOffsetX=ctx.shadowOffsetY=0;` then fill,
then RESET `shadowBlur=0`. Budget glow to: monitor screens, visors, wall trim, server LEDs, neon
signs, selection ring, speech-bubble border. Floor grid uses FLAT lines (no shadow). Optional richer
bloom via cached additive radial-gradient sprites drawn with `globalCompositeOperation='lighter'`.

### 5.3 State badge colors (PINNED)
```js
App.config.stateColor = {
  idle:'#8294c4', walking:'#39d7ff', thinking:'#ffc24d', coding:'#5dff9b',
  searching:'#ffc24d', meeting:'#9b5cff', coffee:'#dce6ff', error:'#ff4d6d',
};
```

### 5.4 Sprite / animation / tile / FX implementation guidance (authoritative pointers)
- **Sprite base:** 16 wide × 24 tall art-px (`SPR_W/SPR_H`). Anchor = bottom-center `(8,23)` (feet).
  Drawn so feet sit at cell lower-middle; head overhangs upward (taller than tile — intended).
- **One silhouette, many neons:** shared dark-techwear body; identity = neon visor band + chest
  emblem + ankle accent + chair stripe + selection ring + bubble border, all in `agent.color`.
- **Per-agent variety (deterministic from id):** `h=App.util.hash(id)`;
  `skin = palette.skin[h%4]`, `hair = palette.hair[(h>>3)%3]`, optional longer-hair bit `h&4`.
- **Pixel maps:** follow `design_visual.md` §3 (down/up/side poses), §2 (tiles & furniture rect
  tables) EXACTLY for rect coordinates — that doc is the art authority for coordinates.
- **Animation clips & durations:** idle-bob 2f (~0.45s/f via BOB_PERIOD), walk 4f×4dir (ANIM_FPS=6),
  sit-and-type 2f (~0.18s). `anim.t += dt`; advance frame when `t > 1/ANIM_FPS` (walk/type) or by
  `BOB_PERIOD` sine for bob. Wrap by clip length. See visual.md §3.5 for exact per-frame deltas.
- **Monitor screen content** is driven by the SEATED agent's `state` (coding/searching/thinking/idle),
  visual.md §2.5.1. Server LEDs blink on `(frame+slot*7)%N`. Plant sways on slow sine.
- **FX overlay (drawFX, drawn LAST in screen px):** scanlines (cached 2px pattern, optional drift),
  faint center bloom (`lighter`, alpha ≤0.04), vignette (radial → `palette.void` alpha ~0.45). All
  gated by `config.fx.{scanlines,bloom,vignette}`.
- **Selection ring:** animated double ring + corner ticks in `agent.color` at feet, shadowBlur 8.
- **Logo wordmark:** `NEON//WORKS`, `//` in magenta with flicker; tiny hex-node glyph (boss+2 satellites).

---

## 6. ROLES (PINNED — keys, colors, models, prompts)

`App.config.ROLES` is the canonical table. Keys: **boss, engineer, designer, researcher, writer,
qa, generalist**. (arch.md's `analyst` is dropped.) Each entry:
```js
ROLES[key] = {
  label:String, color:String /*=roleColor[key]*/, model:String, glyph:String,
  webSearchPreferred:Boolean /*default false*/, system:String /*prompt text*/,
}
```
Defaults: boss model = `claude-opus-4-8`; qa model = `claude-haiku-4-5-20251001`; all others =
`claude-sonnet-4-6`. `researcher.webSearchPreferred = true`; all others false.

### 6.1 Shared worker preamble (prepend to EVERY worker prompt: engineer/designer/researcher/writer/qa/generalist)
```text
You are a worker agent inside "Pixel AI Company", an autonomous AI software company.
You receive ONE focused instruction from the Boss orchestrator and you complete exactly that, nothing more.
Rules:
- Do the task fully and concretely. Produce the actual deliverable (code, copy, analysis), not a plan to do it.
- Be self-contained: the Boss will read ONLY your final message, so put the real result there.
- Stay strictly in scope. Do not ask the Boss questions; if something is ambiguous, make a sensible
  assumption, state it in one short line, and proceed.
- Output plain text/markdown. No preamble like "Sure!" — start with the deliverable.
- Keep it tight: aim for the shortest complete answer. End with a one-line "RESULT:" summary the Boss can quote.
```

### 6.2 Role-specific bodies (each = preamble + the body below). Verbatim from orch.md.
- **engineer** (glyph `wrench`):
```text
ROLE: Senior Software Engineer.
You write correct, runnable, idiomatic code and terse technical explanations.
- Default to a single self-contained snippet unless told otherwise. Include only the code that is needed.
- Note language/runtime assumptions in one line if not specified.
- If asked to design, give concrete interfaces/data shapes, not vague prose.
- Prefer standard libraries; avoid inventing dependencies.
RESULT: line = one sentence stating what you built and how to use it.
```
- **designer** (glyph `palette`):
```text
ROLE: Product / Visual Designer.
You produce concrete design specs: layouts, component lists, color/typography tokens, copy for UI,
and rationale tied to usability. Use exact values (hex, px, spacing scale) not adjectives.
- When visuals are needed, describe them precisely enough to implement, or give ASCII/structural mockups.
- Tie every choice to a user goal in <=1 short clause.
RESULT: line = the single most important design decision.
```
- **researcher** (glyph `magnifier`, webSearchPreferred:true):
```text
ROLE: Research Analyst.
You gather and synthesize current, accurate information and present it as crisp findings.
- If web search is available, use it for anything time-sensitive, factual, or version-specific.
- Cite sources inline as [n] with a short Sources list at the end when you used the web.
- Separate FACTS (sourced) from your INFERENCE. Never fabricate citations or numbers.
- Output bullet findings, most-decision-relevant first.
RESULT: line = the key takeaway for the Boss.
```
- **writer** (glyph `pen`):
```text
ROLE: Technical & Marketing Writer.
You turn raw material into clear, well-structured prose in the requested tone/format.
- Match the audience and length implied by the instruction; if unspecified, be concise and neutral.
- Strong structure: headline + scannable sections. No filler, no clichés.
- Preserve any facts/numbers from input exactly; do not invent specifics.
RESULT: line = the finished piece's one-sentence thesis.
```
- **qa** (glyph `check`, model haiku):
```text
ROLE: Quality Assurance / Reviewer.
You critically review the provided artifact for correctness, completeness, and edge cases.
- Output: (1) a PASS/FAIL verdict, (2) a numbered list of concrete issues with severity [blocker|major|minor],
  (3) the minimal fix for each. Be specific (quote the offending part).
- If you cannot find issues, say PASS and list the top risks you checked.
RESULT: line = verdict + issue count, e.g. "FAIL — 2 blockers, 1 minor".
```
- **generalist** (glyph `star`, fallback; not shown in picker by default):
```text
ROLE: Generalist Operator.
Handle whatever the instruction asks as competently as possible, end-to-end. Produce the real deliverable.
RESULT: line = one-sentence summary of what you delivered.
```

### 6.3 Boss prompts (boss has TWO; stored `ROLES.boss.system` = the DECOMPOSE prompt)
- **BOSS_DECOMPOSE_SYSTEM** (Boss turn A — stored as `ROLES.boss.system`):
```text
You are the BOSS / orchestrator of an autonomous AI company. The user gives you ONE high-level goal.
Your job is ONLY to break it into focused subtasks for your worker agents and to plan the final synthesis.

Available worker roles (use the exact key string):
- "engineer"  : writes code, technical design, implementation.
- "designer"  : UI/UX, visual specs, layout, copy for interfaces.
- "researcher": gathers/synthesizes current external information (can use web search).
- "writer"    : long-form prose, docs, marketing, summaries.
- "qa"        : reviews/critiques an artifact for correctness and edge cases.

Decompose the goal into 1–5 subtasks (fewer is better; only split when a different role or clearly
parallel piece of work is genuinely needed). Order them so dependencies come first; later tasks may
rely on the RESULTS of earlier ones (you will be given those results during synthesis).

You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.
Schema:
{
  "plan": [
    { "role": "<one of the role keys>",
      "title": "<=6 word label shown on the kanban card",
      "instruction": "<the full, self-contained instruction for that worker>",
      "needsWeb": <true|false>
    }
  ],
  "final": "<one sentence telling yourself how to combine the workers' results into the user's answer>"
}

Rules:
- 1 to 5 items in "plan". Each instruction must be complete on its own (the worker cannot see the user's
  original goal — only your instruction).
- Use only the role keys listed. If the goal is trivial/single-step, return a one-item plan.
- Do NOT include comments or trailing commas. Output valid JSON parseable by JSON.parse.
```
- **Boss decompose USER message** (frame the goal):
```text
GOAL:
<user text verbatim>

Return the JSON plan now.
```
- **BOSS_SYNTH_SYSTEM** (Boss turn B):
```text
You are the BOSS of an autonomous AI company. Your workers have completed their subtasks.
Combine their results into ONE final answer that fully satisfies the user's original goal.
- Integrate the pieces; resolve any conflicts; do not just concatenate.
- Keep what's good, fix obvious gaps, and present it cleanly for the user (markdown ok).
- If a subtask failed, work around it gracefully and note the limitation briefly.
- Do not mention this internal process unless useful. Just deliver the result.
```
- **Boss synth USER message** (built by `buildSynthUserContent(rootTask)`):
```text
USER'S ORIGINAL GOAL:
<root user text>

SYNTHESIS GUIDANCE (your own earlier note):
<plan.final>

WORKER RESULTS:
[<role> — <title>]
<result text>

[<role> — <title>]
<result text>
...

Produce the final answer for the user now.
```

### 6.4 Boss JSON-plan parsing rules (`Orchestrator.parsePlan(raw) → plan|null`)
Apply IN ORDER (defensive; never throw):
1. If `!raw.trim()` → `null`.
2. Strip code fences: `s.replace(/^```(?:json|jsonc)?\s*/i,'').replace(/```\s*$/i,'')`.
3. Brace-slice: `body = s.slice(s.indexOf('{'), s.lastIndexOf('}')+1)`; if no braces → `null`.
4. Forgiving cleanup: remove trailing commas `/,(\s*[}\]])/g→'$1'`; smart quotes `“”→"`, `‘’→'`.
5. `JSON.parse(body)`; on failure try a brace-balanced prefix; still failing → `null`.
6. Validate: require `Array.isArray(obj.plan) && obj.plan.length>0`; filter items lacking
   `instruction`; `slice(0,5)`; normalize each item:
   - `role`: keep iff it's a known ROLES key, else `'generalist'`.
   - `title`: `(it.title || firstWords(instruction,6)).slice(0,48)`.
   - `instruction`: `String(it.instruction)`.
   - `needsWeb`: boolean if given, else `!!ROLES[role]?.webSearchPreferred`.
   - If plan empties after filtering → `null`.
   - `obj.final`: string if given, else `'Combine all worker results into a single coherent answer for the user.'`
7. Return normalized `{plan, final}` (PLAN_SCHEMA_VERSION = 1).

**Fallback when `parsePlan===null`:** log `system` "Boss plan unreadable — running as a single
generalist task."; build one-item plan `{role:'generalist', title:'Handle task',
instruction:<user text>, needsWeb:settings.webSearch}`; proceed (decompose→run→synthesize).

---

## 6.5 TASK ↔ AGENT-STATE MAPPING (PINNED)

| Phase | Task.status | Agent.state | Choreography |
|---|---|---|---|
| Boss receives goal | root `running` | boss → `thinking` | walk boss to its desk if away; bubble "🧠 Planning…" |
| Plan produced | children `queued` | boss → `idle` | bubble "Delegating N tasks" |
| Subtask assigned | `running` | worker → `walking` | `goToCell`/`goToFurniture('desk')`; bubble = task.title |
| At desk, no web | `running` | worker → `coding` | sit+type anim; tokens stream to bubble/panel |
| At desk, web on | `running` | worker → `searching` | scan FX while web_search active; flip to `coding` on first text |
| Subtask done | `done` | worker → `idle` then maybe `coffee` | bubble "✓ done" |
| Subtask failed | `error`(task) | worker → `idle` | bubble "⚠ error"; red flash |
| All children terminal → synth | root `running` | participants → `meeting`; boss → `thinking` | walk to meeting-table ring; boss bubble "Let's sync 🤝" |
| Final ready | root `done` | boss → `idle`/`coffee`; others disperse | boss bubble "Done ✓"; result to board+log |

- `Agents.setState` is the ONLY mutator of `agent.state`; it resets `anim.frame=0` on pose-class
  change and updates `agent.facing` toward the relevant furniture (desk monitor / table center).
- Bubble text truncated to ~48 chars; full text in panel transcript + log.
- Bubble durations: planning 4000, per-delegation 3000, result 2500, "Done ✓" 4000. Stagger
  delegations by `config.DELEGATE_STAGGER_MS` (600).

---

## 7. MODULE FUNCTION SIGNATURES (PINNED — every function REQUIRED; "→" = return)

### 7.1 App.PixelArt (pure drawing; never reads App.state except palette mirror)
```js
App.PixelArt.palette                                   // === App.config.palette (same ref). READ-ONLY.
App.PixelArt.getPalette() → {name:hex,...}             // returns the palette object
App.PixelArt.drawTile(ctx, tileType, sx, sy, size)     // tileType from TILES; (sx,sy)=screen TL; size=cell edge screen px
App.PixelArt.drawFurniture(ctx, furniture, sx, sy, size [, seatedAgent])
                                                       // render across w*h footprint; respect furniture.dir; screen px
App.PixelArt.drawAgent(ctx, agent, sx, sy, size [, opts])
                                                       // (sx,sy)=screen pos of feet (center-bottom) anchor; size=cell edge.
                                                       // opts={seated:bool, selected:bool}. Pose from state/facing/anim.
                                                       // Exception-safe: unknown state -> idle-bob fallback.
App.PixelArt.drawBubble(ctx, text, sx, sy, size [, color])
                                                       // pixel speech bubble anchored above (sx,sy)=head screen pos; wraps.
App.PixelArt.drawNameplate(ctx, agent, sx, sy, size)   // name pill + state dot above head (world->screen done by caller)
App.PixelArt.drawSelection(ctx, agent, sx, sy, size)   // animated selection ring at feet
App.PixelArt.drawFX(ctx, w, h, time)                   // full-canvas scanlines+bloom+vignette; (w,h)=canvas CSS px; LAST
App.PixelArt.glowText(ctx, text, sx, sy [, opts])       // helper for signs/labels (optional styling)
App.PixelArt.drawLogoGlyph(ctx, sx, sy, size)          // the NEON//WORKS hex-node glyph (used by top bar / boot splash)
```

### 7.2 App.World (grid, camera, pathfinding)  — **findPath uses {start,goal} object form**
```js
App.World.TILE                                          // mirror of config.TILE
App.World.cellSizeScreen([zoom]) → Number               // TILE*PIXEL*(zoom||state.camera.zoom)
App.World.defaultLayout() → { cols, rows, tiles, furniture }   // seeded neon office (§9)
App.World.tileAt(gx, gy) → Number                       // TILES.VOID if OOB
App.World.furnitureAt(gx, gy) → Furniture|null          // first furniture covering the cell
App.World.isWalkable(gx, gy [, opts]) → Boolean         // OOB/WALL/VOID/blocking-furniture => false; opts.ignoreAgents default true
App.World.neighbors(gx, gy) → Array<{gx,gy}>            // 4-dir walkable cells
App.World.findPath(start, goal) → Array<{gx,gy}> | null
   // start/goal = {gx,gy}. BFS/A* (no diagonals). EXCLUDES start, INCLUDES goal.
   // [] when start==goal; null when unreachable. O(cells) bounded; never infinite-loop.
App.World.worldToScreen(wx, wy) → {x,y}
App.World.screenToWorld(sx, sy) → {x,y}
App.World.cellToWorld(gx, gy) → {x,y}                   // CELL CENTER
App.World.worldToCell(wx, wy) → {gx,gy}                 // floor(world/TILE)
App.World.screenToCell(sx, sy) → {gx,gy}
App.World.clampCamera()                                 // keep camera in bounds(+margin); clamp zoom
App.World.meetingSeats() → Array<{gx,gy}>               // walkable ring cells around the meeting table
App.World.coffeeTile() → {gx,gy} | null                // seat cell of a coffee machine (or null)
App.World.freeDeskCell() → {gx,gy} | null              // an unoccupied desk seat (for new/temp agents)
```
- **NOTE (compat):** orch.md called `findPath(gx0,gy0,gx1,gy1)`. The PINNED form is the object form
  `findPath({gx,gy},{gx,gy})`. Orchestrator/Agents MUST call the object form. (No 4-arg overload.)

### 7.3 App.API (Anthropic browser-direct SSE)
```js
App.API.stream(opts) → { abort(): void }
opts = {
  apiKey:String /*REQUIRED; falsy -> onError({type:'no_key',message}) + no-op handle*/,
  model:String /*REQUIRED*/, system:String, messages:Array /*[{role,content}]*/,
  tools:Array|undefined, maxTokens:Number|undefined /*default config.MAX_TOKENS*/,
  signal:AbortSignal|undefined,
  onText:(deltaText)=>void,            // each text_delta
  onState:(s)=>void,                   // 'thinking'|'searching'|'text'|'done' lifecycle hints
  onDone:({text,usage,raw})=>void,     // text=full assistant text; usage={input_tokens,output_tokens}
  onError:(err:{type,message,status?})=>void,
}
```
Contract:
- POST `config.API_URL`, headers: `{'x-api-key':apiKey, 'anthropic-version':config.API_VERSION,
  'anthropic-dangerous-direct-browser-access':'true', 'content-type':'application/json'}`.
- Body: `{ model, max_tokens, system, messages, stream:true, tools? }`.
- SSE parse: `response.body` reader + TextDecoder; buffer split on `'\n\n'`; handle `data: ` lines.
  Events → callbacks: `content_block_start` with `server_tool_use`/web_search → `onState('searching')`;
  `content_block_delta` `text_delta`→`onText` (also first text → `onState('text')`);
  `input_json_delta` ignored for display; `message_delta` → capture `usage`+`stop_reason`;
  `message_stop` → `onDone({text:accumulated, usage, raw:lastMessageDelta})`.
- Non-200: read JSON, `onError({type:'http', status, message})`. Network/abort:
  `onError({type:'network'|'abort', message})`.
- **Web-search graceful degrade:** if a request WITH `tools` fails 4xx implying tool unsupported
  (message mentions `web_search`/`tool`), retry ONCE WITHOUT `tools` before reporting. Helper:
  `isToolUnsupportedError(err)` (message includes `web_search`, or status 400 + `tool`).
- Returns `{abort()}`. Internally creates an AbortController if `signal` absent. **Never throws
  synchronously**; all failures via `onError`.
- API does NOT read App.state; the caller passes apiKey/model.

### 7.4 App.Store (persistence + seeding; ONLY writer of localStorage)
```js
App.Store.init()                  // ensure App.state exists; if save present -> load() else seed(). main calls first.
App.Store.seed()                  // build default company: layout=World.defaultLayout(); 4 default agents
                                  //   (boss, engineer, designer, researcher) at their desks; default settings/camera.
App.Store.save()                  // persist persistable slice (§3.3) to localStorage[STORAGE_KEY]. Debounce-safe.
App.Store.load() → Boolean        // parse+migrate+rebuild transients; true on success, false on miss/corrupt.
App.Store.exportJSON() → String   // pretty JSON of the full save blob
App.Store.importJSON(str) → Boolean // parse+validate+replace state; then save() + UI.refresh(); false on bad input
App.Store.clear()                 // remove key; re-seed; UI.refresh()
App.Store.pushLog(entry)          // append normalized LogEntry (fills t=Date.now()); cap last 500; UI.refreshLog()
App.Store.migrate(blob) → blob    // upgrade older SCHEMA_VERSION; no-op if current
```
- **PINNED log API name = `App.Store.pushLog`.** orch.md used `App.Store.log` — that is a REQUIRED
  compat alias (§7.10). Implementers route both to one impl.

### 7.5 App.Agents (factory, sim, draw, direct chat)
```js
App.Agents.create(spec) → Agent
   // spec={name, role, model?, color?, gx?, gy?, systemPrompt?, temp?}. Defaults from ROLES.
   // model = spec.model || (role==='boss'?settings.bossModel:settings.defaultModel) || ROLES[role].model
   // color = spec.color || ROLES[role].color; systemPrompt = spec.systemPrompt || ROLES[role].system
   // gx/gy = spec or World.freeDeskCell(). Pushes to state.agents. Does NOT save (caller saves).
App.Agents.remove(agentId)        // abort its stream, free desk, drop from agents, clear selection if selected
App.Agents.byId(agentId) → Agent|null
App.Agents.byRole(role) → Agent[]
App.Agents.findIdle(role) → Agent|null   // first agent with state==='idle' && !busy && role match; else null
App.Agents.update(dt)             // advance ALL agents (path-follow, facing, anim, bob, bubble expiry, temp cull).
                                  //   dt sec. Per-agent try/catch (one bad agent never freezes others).
                                  //   When paused: still expire bubbles, but no movement/state sim.
App.Agents.draw(ctx)             // y-sorted draw of every agent via PixelArt (sprite, nameplate, selection, bubble).
                                  //   Uses World.worldToScreen itself (main has NOT pre-applied camera).
App.Agents.setState(agent, s)     // set agent.state (one of 7); reset anim.frame on pose-class change; update facing.
App.Agents.say(agent, text [, ms])// agent.bubble={text, until:Date.now()+(ms||config.BUBBLE_MS)}
App.Agents.goToCell(agent, gx, gy [, onArrive])    // path via World.findPath; state 'walking'; fire onArrive on empty path
App.Agents.goToFurniture(agent, type [, onArrive]) // walk to nearest free seat of furniture type, then sit(), then onArrive
App.Agents.sit(agent)             // snap to cell center, clear path, face furniture, state→'idle' (caller may override)
App.Agents.chat(agent, userText) → {abort()}
   // DIRECT single-agent chat (NO orchestration). Append user msg to agent.conversation; API.stream with
   //   agent.systemPrompt + conversation; set 'coding'/'searching'; stream into bubble + UI.appendTranscript;
   //   on done append assistant msg, bump stats. Respects config.DIRECT_CHAT_BLOCKS for busy. Returns handle.
```
- **Movement:** move `x,y` toward next waypoint at `WALK_SPEED*dt`; pop waypoint within `ARRIVE_EPS`;
  when path empty → fire `_onArrive` once, default state `idle` unless caller set otherwise.
- **PINNED names:** `goToCell` (not `goTo`), `chat` (not `directChat`). Both old names are REQUIRED
  compat aliases (§7.10).

### 7.6 App.Orchestrator (boss flow + queue)
```js
App.Orchestrator.PLAN_SCHEMA_VERSION = 1
App.Orchestrator.runBossTask(text) → Promise|void
   // ensure boss agent; create root Task {role:'boss', status:'running'}; boss 'thinking' + "🧠 Planning…";
   // API.stream(decompose) -> parsePlan() || fallback; create child Tasks (queued, parentId=root, push subtaskIds);
   // boss "Delegating N tasks" + staggered per-child "@Role: <title>"; rely on tick() to run children.
App.Orchestrator.parsePlan(raw) → {plan,final}|null     // §6.4 rules
App.Orchestrator.enqueueTask(spec) → Task
   // spec={title, desc /*instruction*/, role, parentId?, assignee?, needsWeb?}. Create Task status 'queued'; push.
App.Orchestrator.assign(task [, agent])                  // bind assignee+currentTaskId; status 'running';
                                                        // if no agent -> findIdle(role) or spawn temp; drive to desk + runWorker
App.Orchestrator.runWorker(task)                         // §4 orch.md: walk-to-desk, set coding/searching, API.stream
                                                        // (tools iff settings.webSearch && (task.needsWeb||role.webSearchPreferred)),
                                                        // stream into bubble + UI.appendTranscript; on done finishTask; tick()
App.Orchestrator.synthesize(rootTask)                    // _meetingActive on; walk participants to meetingSeats;
                                                        // boss 'thinking'+"Synthesizing…"; API.stream(synth);
                                                        // on done root.result/status done, "Done ✓", UI.showFinalResult, disperse
App.Orchestrator.tick()                                  // each frame: assign queued tasks to idle agents (FIFO, dep-gated,
                                                        // MAX_CONCURRENT cap); flip blocked->queued when deps satisfied;
                                                        // detect all-children-terminal -> synthesize. Cheap, re-entrant-safe.
App.Orchestrator.cancelTask(taskId)                      // abort stream; agent idle; task->'queued' (re-runnable); log
```
- **Dependency policy:** a child depends on ALL earlier siblings in the same plan that are `done`;
  a child whose required predecessors aren't all done is held `blocked`, re-checked each tick.
  Dependency results are injected into the worker user content (orch.md §4.2).
- **Anti-double-assignment:** claim synchronously (`agent.busy=true; task.status='running'`) BEFORE
  any `await` in `runWorker`.
- **Synthesis trigger:** all children terminal (`done`/`error`) with ≥1 `done` → synthesize; if ALL
  `error` → root `error` (no synthesis), boss "⚠ couldn't complete".
- **PINNED names:** `enqueueTask`, `runWorker`. orch.md's `enqueue`/`runSubtask` are REQUIRED compat
  aliases (§7.10). Internal helpers (`_checkPlanComplete`, `beginSynthesis`, `finishTask`, `failTask`,
  `buildWorkerUserContent`, `buildSynthUserContent`, `depsSatisfied`, `spawnTempWorker`, `maybeCoffee`,
  `isToolUnsupportedError`, `resultLine`) are implementation-private (prefix `_` or local).

### 7.7 App.UI (DOM overlays, input, camera controls)
```js
App.UI.init()                     // query DOM by §8 IDs; populate model/role selects from config; attach listeners; refresh()
App.UI.refresh()                  // re-render everything state-driven (agent list, board, log, hud, selected panel)
App.UI.refreshBoard()             // kanban only
App.UI.refreshLog()               // activity log only
App.UI.refreshAgentList()         // left rail only
App.UI.openAddAgent()             // add-agent modal; submit -> Agents.create + Store.save + refresh + live preview
App.UI.openAgentPanel(agentId)    // set selectedAgentId; show side panel (name/role/state/model/stats, transcript, chat input)
App.UI.closeAgentPanel()          // hide panel; clear selectedAgentId
App.UI.openSettings()             // settings modal (apiKey, defaultModel, bossModel, webSearch, export/import/clear)
App.UI.openTaskBoard()            // show board + "give big task to Boss" input -> Orchestrator.runBossTask
App.UI.toggleLayoutEdit()         // flip state.layoutEdit; show/hide palette; Store.save on exit
App.UI.zoomIn()  App.UI.zoomOut()  App.UI.resetView()   // mutate camera; World.clampCamera()
App.UI.onCanvasPointerDown(e) / onCanvasPointerMove(e) / onCanvasPointerUp(e)
                                  // drag-to-pan; click-select agent (screenToCell -> hit test);
                                  // in layoutEdit: place/move/remove furniture (snap to cell)
App.UI.onWheel(e)                 // zoom toward cursor; clamp
App.UI.appendTranscript(agentId, role, text)            // live-append streamed tokens to open agent panel
App.UI.showFinalResult(task)      // surface a root task's final result (panel/modal)
App.UI.showError(msg)             // surface an error to the user
App.UI.toast(msg [, kind])        // transient notice (e.g. 'Set your API key in Settings')
```
- UI never does network or pathfinding; all canvas math via `App.World`. Guard every DOM node access.
- **Compat aliases (required, §7.10):** `App.UI.appendAgentStream(agentId, delta)` →
  `appendTranscript(agentId,'assistant',delta)`.

### 7.8 App.main (bootstrap + loop; runs LAST; only auto-running file)
```js
App.main.init()    // 1) Store.init() 2) grab #world-canvas + 2d ctx, imageSmoothingEnabled=false, main.resize()
                   // 3) UI.init() 4) requestAnimationFrame(loop). try/catch; fatal -> UI.toast.
App.main.loop(ts)  // dt = clamp((ts-last)/1000, 0, 0.05); state._time += dt;
                   //   if(!paused){ Agents.update(dt); Orchestrator.tick(); } else Agents.update(dt)/*bubble expiry only*/;
                   //   draw(); requestAnimationFrame(loop).
App.main.resize()  // canvas.width=clientW*dpr, height=clientH*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
                   //   imageSmoothingEnabled=false; World.clampCamera().
App.main.draw()    // clear(void) -> tiles (visible range) -> furniture -> Agents.draw(ctx) -> PixelArt.drawFX(ctx,cssW,cssH,_time)
```
- **Draw order (PINNED):** floor/tiles → furniture → agents (y-sorted) → bubbles (part of Agents.draw)
  → FX overlay. (Furniture+agents MAY be one y-sorted pass for correct overlap; drawing all furniture
  then all agents is acceptable.)
- `window.addEventListener('resize', App.main.resize)`; init on `DOMContentLoaded`.

### 7.9 Per-agent vs orchestrated paths
- **Direct chat:** `UI.panel send → App.Agents.chat(agent, text)` (single agent, no queue/synthesis).
- **Boss task:** `UI #board-send → App.Orchestrator.runBossTask(text)`.
- **Manual queue:** `App.Orchestrator.enqueueTask({title,desc,role})` (standalone, no parent, no synth).

### 7.10 REQUIRED compat aliases (define these so cross-doc call sites resolve)
```js
App.Store.log         = App.Store.pushLog;            // orch.md name
App.Agents.goTo       = App.Agents.goToCell;          // orch.md name (agent, gx, gy, thenState)
App.Agents.directChat = function(id,t,cbs){ ... };    // orch.md name -> wraps chat(byId(id), t)
App.Agents.idleByRole = App.Agents.findIdle;          // orch.md name
App.Orchestrator.enqueue    = App.Orchestrator.enqueueTask;  // orch.md name
App.Orchestrator.runSubtask = App.Orchestrator.runWorker;    // orch.md name
App.UI.appendAgentStream    = function(id,delta){ App.UI.appendTranscript(id,'assistant',delta); };
```
All `App.UI.*` calls from Orchestrator/Agents MUST be guarded (`App.UI.showFinalResult &&`/`?.`) so
orchestration works headless.

---

## 8. DOM CONTRACT (shell author + UI author MUST agree; UI binds by these exact IDs)

Visibility toggled ONLY by adding/removing class **`.hidden`** (`display:none`).
Model `<select>`s populated from `config.MODELS`; role `<select>` from `config.ROLES` (UI fills at init —
shell ships them empty). Buttons fire UI methods only; no inline JS in shell beyond ids/classes.

```
#app                       root flex container (canvas + overlays)
#world-canvas              the <canvas> the office renders on
#hud                       top bar container (logo + center input + right buttons)
  #hud-logo-canvas         small <canvas> for the procedural NEON//WORKS glyph (logo lockup)
  #btn-task                "New Task / Boss" button (opens/foregrounds task board)
  #btn-add-agent           "+ Agent" button
  #btn-settings            settings button
  #btn-layout              toggle layout-edit button (active state when on)
  #btn-zoom-in             zoom + button
  #btn-zoom-out            zoom - button
  #btn-reset-view          reset camera button
  #status-paused           pause/play toggle button + indicator

#agent-list                left rail listing agents (click row -> openAgentPanel)

#panel-agent               right side panel (agent detail)            [.hidden by default]
  #panel-agent-canvas      small <canvas> mini-sprite of the agent (idle-bob)
  #panel-agent-name        agent name node (colored by agent.color)
  #panel-agent-meta        role / state / model / stats node
  #panel-agent-transcript  scrollable transcript container
  #panel-agent-input       <textarea> for direct chat
  #panel-agent-send        send button
  #panel-agent-close       close button

#board                     task board / kanban container             [toggle .hidden]
  #board-input             <textarea> "give big task to Boss"
  #board-send              "DISPATCH" submit button
  #board-col-queued        Queued column body (queued + blocked)
  #board-col-running       Running column body
  #board-col-done          Done column body (done + error)

#log                       activity-log list container (auto-scroll)

#modal-root                container where modals mount

#modal-add-agent           add-agent modal root                      [.hidden]
  #aa-name                 name input
  #aa-role                 role <select> (populated from ROLES)
  #aa-model                model picker group (segmented; populated from MODELS)  [container]
  #aa-color                color swatch row + custom (container)
  #aa-system               custom system prompt <textarea> (optional override)
  #aa-preview-canvas       live agent sprite preview <canvas>
  #aa-submit               submit/create button
  #aa-cancel               cancel button

#modal-settings            settings modal root                       [.hidden]
  #set-apikey              API key input (password, show/hide)
  #set-default-model       worker default model <select>
  #set-boss-model          boss model <select>
  #set-websearch           web-search toggle (neon switch input/button)
  #set-export              export JSON button
  #set-import              import JSON button (triggers #set-import-file)
  #set-import-file         hidden <input type=file>
  #set-clear              clear-data (danger) button
  #set-save               save settings button
  #set-close              close button

#layout-palette            furniture palette for layout-edit         [.hidden unless layoutEdit]
                           (buttons/items carry data-furniture="<FURNITURE key>")

#toast                     toast container
```
Notes:
- `#aa-model` / `#aa-color` are CONTAINERS the UI fills (segmented neon tabs / swatch row), not native
  selects (per visual.md §7). `#set-default-model`/`#set-boss-model` ARE native `<select>`s.
- Every node access in UI must be guarded (defensive: missing node → no-op, no throw).

### 8.4 CSS variable seed (shell `<style>` / inline) — names match palette §5
```css
:root{
  --void:#070912; --floor:#0d1226; --floor-alt:#0f1530; --panel:#0b1024; --panel-edge:#22305c;
  --text:#dce6ff; --text-dim:#8294c4; --text-faint:#4d5d8a;
  --cyan:#39d7ff; --magenta:#ff3df0; --purple:#9b5cff; --blue:#4d7cff; --lime:#5dff9b;
  --amber:#ffc24d; --red:#ff4d6d;
  --btn:#16203f; --btn-hover:#1d2c54; --field:#0a0f20; --divider:#1a2647;
  --scrim:rgba(5,7,15,.72); --glow-cyan:0 0 12px rgba(57,215,255,.45);
}
body{ background:var(--void); color:var(--text);
      font-family:"DejaVu Sans Mono",ui-monospace,Menlo,Consolas,monospace; }
.hidden{ display:none !important; }
```

---

## 9. DEFAULT SEEDED COMPANY (World.defaultLayout + Store.seed)

Layout target (30×20 grid; visual.md §8): walled rectangular floor with one DOOR on the bottom edge.
- **Boss zone** top-center: a `CARPET` (cyan-bordered) patch; a `desk` facing `down` w/ monitor; a
  `server` rack beside it; a `neonSign` (logo) on the back wall behind the Boss.
- **Worker desks:** 4–6 `desk`s along left/right rows, each with `chair` at its seat, spaced ~2 cells,
  a `plant` between pairs.
- **Meeting area** center-bottom: `RUG` (purple-bordered) patch with a `meetingTable` (3×2); open seat
  cells around it returned by `World.meetingSeats()`.
- **Coffee corner:** a `coffee` machine near the door + 1 `plant`. `World.coffeeTile()` returns its seat.
- **Datacenter corner:** 2–3 `server` racks (blinking LEDs = focal glow).
- **Seeded agents (Store.seed):** Boss (cyan, opus), Engineer (blue, sonnet), Designer (magenta,
  sonnet), Researcher (lime, sonnet) — each at its own desk seat. Default settings (empty apiKey,
  webSearch true, theme 'neon'), camera = `config.CAMERA_START`, empty tasks/log.

---

## 10. ERROR / EMPTY-STATE BEHAVIORS (PINNED — loop never throws)
- **No API key** at send: `UI.toast('Set your API key in Settings')`, actor bubble "🔑 set your API
  key in Settings", task → `error` (`error:'NO_KEY'`); no network. Never crash.
- **API HTTP error:** agent bubble "⚠ error" + red flash; log `system` "API error (<status>): <msg>";
  task → `error`, `task.error=msg`; offer Retry on the card (re-enqueueTask same partial).
- **Network error:** same UX, message "network error — check connection"; Retry available.
- **Web tool unsupported:** auto-retry once without `tools` (§7.3); only if retry also fails → `error`.
- **Plan JSON unparseable:** fallback single generalist task (§6.4); log `system`
  "Boss plan unreadable — running as one task."
- **Empty result:** task → `error` ("(empty result)"); Boss synthesizes around the gap.
- **All children failed:** root → `error`; boss bubble "⚠ couldn't complete"; show collected child
  errors in the result modal for per-card retry.
- **Aborted (cancel/pause):** `task._ctrl.abort()`; task → `queued` (re-runnable); agent → idle,
  busy=false.
- **Unreachable desk:** agent stays idle at current cell; log a `system` entry; no infinite loop.
- **Corrupt/missing localStorage:** `Store.seed()` a fresh company.
- **Loop safety:** per-agent try/catch in `Agents.update`; per-draw try/catch; all async paths
  routed to `failTask`/`onError`, never bubbling to rAF.

---

## 11. NAMING / STYLE (PINNED)
- IDs via `App.util.uid(prefix)` with prefixes `a_` (agent), `t_` (task), `f_` (furniture).
- Colors ONLY from `App.PixelArt.getPalette()` / `ROLES[x].color` / `agent.color` / state/role color
  maps. No ad-hoc hex in logic (CSS may use the `--vars`).
- Comments Korean or English. Functions small & defensive. No uncaught throws in `update`/`draw`/tick.
- States: exactly the 7 in `config.STATES`; `error` is a transient badge/bubble, not an agent.state.
- Every `App.UI.*` invoked from Orchestrator/Agents is OPTIONAL — guard with `&&`/`?.`.

— END SPEC.md (authoritative) —
