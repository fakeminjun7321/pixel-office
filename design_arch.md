# PIXEL AI COMPANY — design_arch.md (ARCHITECTURE / MODULE CONTRACT)

> SINGLE SOURCE OF TRUTH for the App.* namespace. Independent authors MUST conform
> to the signatures, shapes, IDs, and constants below. Where this file pins a value,
> it WINS over the brief's seed sketch. This file + design_visual + design_orch merge
> into SPEC.md. Anything ambiguous here is intentionally pinned — do not improvise.

---

## 0. GROUND RULES (non-negotiable)

- **One document, classic scripts.** Every module is a plain `<script>` block (NOT an ES module).
  NEVER use `import` / `export` / top-level `await`. No bundler, no CDN, no npm.
- **Namespace.** First line of EVERY module:
  ```js
  window.App = window.App || {};
  ```
  Each module assigns exactly one sub-object (its own name) plus may seed `App.state` / `App.config`
  (only Store seeds state/config). Cross-module calls ALWAYS go through `App.*`.
- **No load-order assumptions** except: `main.js` is LAST. A module MUST NOT call another module's
  function at load time (define only; invoke from inside functions that run after `App.main.init`).
  Reading `App.config` constants at load time is allowed ONLY if config.js is guaranteed first
  (it is — see §10 load order). To be safe, prefer reading config inside functions.
- **No uncaught throws in the loop.** `update(dt)` and `draw(ctx)` must wrap risky work in try/catch
  and never break the rAF loop. Log errors via `App.Store.pushLog` or `console.error`.
- **Pixels.** `ctx.imageSmoothingEnabled = false`. Draw sprites/tiles at integer device pixels.

---

## 1. CONFIG (App.config) — constants, frozen at load

`config.js` (loads first) defines:

```js
App.config = {
  // --- grid / world geometry ---
  TILE: 16,            // logical tile size in WORLD pixels (one grid cell = 16x16 world px)
  PIXEL: 3,            // base upscale: 1 world px -> 3 screen px at zoom 1.0  (so a tile = 48 screen px @ zoom 1)
  GRID_COLS: 30,       // default office width in cells
  GRID_ROWS: 20,       // default office height in cells

  // --- camera ---
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 3.0,
  ZOOM_STEP: 0.15,     // per wheel notch / button press (multiplicative-ish; UI multiplies)
  CAMERA_START: { x: 0, y: 0, zoom: 1.0 },

  // --- movement / animation ---
  WALK_SPEED: 48,      // world px per second along path
  ARRIVE_EPS: 1.0,     // world px distance to consider a waypoint reached
  ANIM_FPS: 6,         // sprite frame advance rate (frames/sec) for walk/type cycles
  BOB_PERIOD: 1.6,     // seconds for one idle bob cycle
  BUBBLE_MS: 4500,     // default speech-bubble lifetime (ms) if `until` not given

  // --- API ---
  API_URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  DEFAULT_MODEL: 'claude-sonnet-4-6',      // worker default
  BOSS_MODEL:    'claude-opus-4-8',        // boss default
  FAST_MODEL:    'claude-haiku-4-5-20251001',
  MODELS: [                                // picker order
    { id: 'claude-opus-4-8',            label: 'Opus 4.8 (most capable)' },
    { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6 (balanced)' },
    { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5 (fast/cheap)' },
  ],
  MAX_TOKENS: 4096,
  WEB_SEARCH_TOOL: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },

  // --- persistence ---
  STORAGE_KEY: 'pixel_ai_company_v1',      // localStorage key for the whole save blob
  SCHEMA_VERSION: 1,

  // --- roles: preset system prompts + default neon color ---
  ROLES: { /* see §6.3 for exact keys; authors read App.config.ROLES[role] */ },
};
```

### 1.1 Role presets (App.config.ROLES) — canonical keys
Every role key below MUST exist. `Agents.create` and the Add-Agent modal read these.
```js
ROLES = {
  boss:       { label:'Boss',       color:'#ff3df0', system:'<orchestrator prompt>' },
  engineer:   { label:'Engineer',   color:'#36f1cd', system:'<coding worker prompt>' },
  designer:   { label:'Designer',   color:'#c084fc', system:'<design worker prompt>' },
  researcher: { label:'Researcher', color:'#5bc0ff', system:'<research+web prompt>' },
  writer:     { label:'Writer',     color:'#ffd166', system:'<writing worker prompt>' },
  analyst:    { label:'Analyst',    color:'#7CFF6B', system:'<analysis worker prompt>' },
  generalist: { label:'Generalist', color:'#9aa7ff', system:'<fallback worker prompt>' },
}
```
- Orchestrator plan `role` values MUST map onto these keys (fallback to `generalist`).
- `design_orch` owns the EXACT prompt text; `design_arch` owns the KEY SET and color slots.

---

## 2. App.state — definitive shape (seeded by Store)

```js
App.state = {
  agents: [],   // Agent[]   (§3)
  tasks: [],    // Task[]    (§4)
  log: [],      // LogEntry[]: { t:Number(ms), from:String, to:String, kind:'system'|'msg'|'result'|'error', text:String }

  camera: { x:0, y:0, zoom:1.0 },   // x,y = WORLD-px offset of camera top-left; zoom in [ZOOM_MIN,ZOOM_MAX]

  layout: {                          // §5
    cols: 30, rows: 20,
    tiles: [],                       // Int grid[rows][cols] of TILE enum values (§5.1)
    furniture: [],                   // Furniture[] (§5.2)
  },

  settings: {
    apiKey: '',
    defaultModel: 'claude-sonnet-4-6',
    bossModel: 'claude-opus-4-8',
    webSearch: true,
    theme: 'neon',
  },

  selectedAgentId: null,   // String | null
  layoutEdit: false,       // Boolean — layout edit mode on/off
  paused: false,           // Boolean — pause simulation (loop still runs, update() early-returns sim)

  // --- runtime-only (NOT persisted; Store strips these on save) ---
  _time: 0,                // seconds since loop start (advanced by main loop)
  _meetingActive: false,   // collaboration/synthesis visualization flag
  _activeStreams: {},      // agentId -> AbortController (so we can cancel)
};
```

### 2.1 Persistence boundary
`Store.save` persists ONLY: `agents` (without transient fields), `tasks`, `log` (capped), `layout`,
`settings`, `selectedAgentId`. It MUST strip: `camera` is persisted (nice-to-have) but clamp on load;
strip per-agent transient fields `x,y,path,anim,bubble,busy,_*` and `App.state._*` runtime fields and
`_activeStreams`. On load, re-derive transient fields from `gx,gy` (place agent at desk center, empty path).

---

## 3. Agent shape (definitive)

```js
Agent = {
  id:           String,     // unique, e.g. 'a_'+rand
  name:         String,
  role:         String,     // a key of App.config.ROLES
  model:        String,     // a valid model id
  systemPrompt: String,     // resolved prompt (role preset or custom)
  color:        String,     // neon accent hex (e.g. '#36f1cd')

  gx: Number, gy: Number,   // home/desk grid cell (integers)
  x:  Number, y:  Number,   // current WORLD-px position (center of the cell when sitting)
  path: [],                 // Array<{gx,gy}> remaining waypoints (grid cells), excluding current cell
  facing: 'down',           // 'up'|'down'|'left'|'right'

  state: 'idle',            // 'idle'|'walking'|'thinking'|'coding'|'searching'|'meeting'|'coffee'
  anim: { frame:0, t:0 },   // frame=int sprite frame; t=seconds accumulator

  bubble: null,             // null | { text:String, until:Number(ms epoch) }
  conversation: [],         // Claude messages: [{ role:'user'|'assistant', content:String }]
  currentTaskId: null,      // String | null
  stats: { tasksDone:0, tokensIn:0, tokensOut:0 },
  busy: false,              // true while an API stream is in flight for this agent
}
```
- `state` is the SINGLE source of animation/behavior selection. `busy` is independent (network in flight).
- Sitting convention: an agent "at desk" has empty `path`, `x,y` == world-center of `(gx,gy)`, and
  `state` in {idle, thinking, coding, searching, meeting (if at table)}.

---

## 4. Task shape (definitive)

```js
Task = {
  id:        String,
  title:     String,
  desc:      String,        // the instruction/body given to the worker
  assignee:  String|null,   // agentId
  status:    'queued'|'running'|'blocked'|'done'|'error',
  parentId:  String|null,   // boss task id for subtasks; null for top-level
  subtaskIds: [],           // String[] child task ids
  result:    String|null,   // worker/boss output text
  error:     String|null,
  createdAt: Number,        // ms epoch
  role:      String,        // desired worker role key (maps to ROLES; fallback 'generalist')
}
```
- Kanban columns derive from `status`: queued | (running|blocked) | (done|error). UI groups them.

---

## 5. LAYOUT — tiles & furniture (definitive)

### 5.1 Tile enum (App.config exposes; authors use the NUMBERS via these names)
```js
App.config.TILES = {
  FLOOR:   0,   // walkable neon-grid floor
  WALL:    1,   // solid, blocks movement + camera-visible wall
  CARPET:  2,   // walkable accent zone (e.g. meeting room rug)
  DOOR:    3,   // walkable, visual doorway
  RUG:     4,   // walkable accent under meeting table
  VOID:    5,   // out-of-bounds (non-walkable, drawn as deep background)
};
```
- `layout.tiles` is `tiles[row][col]` (row-major; row = gy, col = gx). Walkability table (§7.isWalkable):
  FLOOR✔ CARPET✔ DOOR✔ RUG✔ ; WALL�’✘ VOID✘. Furniture cells are ALSO blocked unless flagged `walkable`.

### 5.2 Furniture shape & types
```js
Furniture = {
  id:    String,
  type:  String,            // one of App.config.FURNITURE keys (below)
  gx:    Number, gy: Number,// anchor (top-left cell)
  dir:   'up'|'down'|'left'|'right',  // facing/orientation
  w:     Number, h: Number, // footprint in cells (default 1x1; from FURNITURE def)
  walkable: Boolean,        // if true, does NOT block pathfinding (e.g. rug, plant-on-shelf)
  seatGx: Number|null, seatGy: Number|null, // where an agent sits to "use" it (a walkable cell)
}

App.config.FURNITURE = {
  desk:        { w:2, h:1, blocks:true,  hasSeat:true  },  // workstation w/ monitor; seat is the cell below/dir-relative
  server:      { w:1, h:1, blocks:true,  hasSeat:false },  // glowing server rack
  meetingTable:{ w:3, h:2, blocks:true,  hasSeat:true  },  // central collab table (multiple seats around it)
  chair:       { w:1, h:1, blocks:false, hasSeat:true  },
  plant:       { w:1, h:1, blocks:true,  hasSeat:false },
  coffee:      { w:1, h:1, blocks:true,  hasSeat:true  },  // coffee machine; agents go here for 'coffee' state
  neonSign:    { w:1, h:1, blocks:false, hasSeat:false }, // wall decoration
  whiteboard:  { w:2, h:1, blocks:true,  hasSeat:false },
}
```
- A `desk`'s seat cell is computed from `dir` (the walkable cell the chair occupies, adjacent to monitor).
- `World.defaultLayout()` MUST give every seeded agent a `desk` whose seat == agent's `(gx,gy)`.

---

## 6. MODULE INTERFACES

> Every function listed is REQUIRED. Signatures are binding. "→" denotes return type.
> All grid coords are integers; all world/screen coords are floats unless noted.

### 6.1 App.PixelArt — procedural pixel rendering (stateless drawing helpers)
Draws into a provided `ctx`. Coordinates passed are SCREEN pixels (caller already applied camera).
Each draw routine assumes `imageSmoothingEnabled=false`.

```js
App.PixelArt.palette                          // object: named neon hex colors (see design_visual). READ-ONLY map.
App.PixelArt.getPalette() → {name:hex,...}     // returns the palette object (single source of colors)

App.PixelArt.drawTile(ctx, tileType, sx, sy, size)
  // tileType: number from config.TILES. (sx,sy)=screen top-left. size=screen px edge (=TILE*PIXEL*zoom).

App.PixelArt.drawFurniture(ctx, furniture, sx, sy, size)
  // furniture: Furniture obj. (sx,sy)=screen top-left of its anchor cell. size=one cell edge in screen px.
  // Must render across its w*h footprint and respect furniture.dir.

App.PixelArt.drawAgent(ctx, agent, sx, sy, size)
  // (sx,sy)=screen position of the agent's CENTER-BOTTOM (feet) anchor; size=one cell edge screen px.
  // Selects pose from agent.state + agent.facing + agent.anim.frame. Uses agent.color as accent.

App.PixelArt.drawBubble(ctx, text, sx, sy, size)
  // speech bubble anchored above (sx,sy); wraps text; pixel-styled. Caller passes agent head screen pos.

App.PixelArt.drawFX(ctx, w, h, time)
  // full-canvas overlay: scanlines + vignette + subtle glow. (w,h)=canvas CSS px. time=App.state._time.
  // Drawn LAST, over everything. Must be cheap.

App.PixelArt.glowText(ctx, text, sx, sy, opts?) // optional helper used by signs/labels
```
Contract: PixelArt NEVER reads App.state directly (pure given args) EXCEPT `getPalette` returning constants.

### 6.2 App.World — grid, camera math, pathfinding
```js
App.World.TILE                                  // = config.TILE (convenience mirror)
App.World.cellSizeScreen(zoom?) → Number        // screen px per cell = TILE*PIXEL*zoom (zoom defaults state.camera.zoom)

App.World.defaultLayout() → { cols, rows, tiles, furniture }
  // builds the seeded neon office: walls border, meeting room w/ table+rug, server wall,
  // coffee corner, and N desks. Returned object is assigned to state.layout by Store.seed.

App.World.tileAt(gx, gy) → Number               // TILES.VOID if out of bounds; else state.layout.tiles[gy][gx]
App.World.furnitureAt(gx, gy) → Furniture|null  // first furniture whose footprint covers (gx,gy)

App.World.isWalkable(gx, gy, opts?) → Boolean
  // false if out of bounds, WALL/VOID tile, or covered by blocking furniture.
  // opts.ignoreAgents (default true). Agents do NOT block pathfinding (they pass through each other).

App.World.neighbors(gx, gy) → Array<{gx,gy}>    // 4-neighbour walkable cells (no diagonals)

App.World.findPath(start, goal) → Array<{gx,gy}> | null
  // start/goal = {gx,gy}. BFS or A* on the grid. Returns waypoint list EXCLUDING start, INCLUDING goal.
  // Returns [] if start==goal; null if unreachable. Must be O(cells) safe and never infinite-loop.

// --- camera transforms (use state.camera) ---
App.World.worldToScreen(wx, wy) → {x, y}
  // screen = (world - camera.xy) * (PIXEL*zoom).  i.e. sx = (wx - cam.x)*PIXEL*zoom.
App.World.screenToWorld(sx, sy) → {x, y}
  // inverse of worldToScreen.
App.World.cellToWorld(gx, gy) → {x, y}          // world px of cell CENTER = (gx+0.5)*TILE, (gy+0.5)*TILE
App.World.worldToCell(wx, wy) → {gx, gy}        // floor(world / TILE)
App.World.screenToCell(sx, sy) → {gx, gy}       // convenience: screenToWorld then worldToCell

App.World.clampCamera()                          // keep camera within layout bounds (+margin); clamp zoom
```
**Coordinate system (PINNED):**
- WORLD units = pixels where 1 cell = `TILE` (16) world px.
- SCREEN px per world px = `PIXEL * camera.zoom` (so 1 cell = 16*3*zoom screen px = 48 @ zoom 1).
- `camera.x, camera.y` = world coords of the screen's top-left corner.
- Canvas is sized to its CSS box * devicePixelRatio in main; PixelArt/World work in CSS screen px
  (main applies the DPR transform once). **Authors: assume screen px == CSS px.**

### 6.3 App.API — Anthropic browser-direct streaming
```js
App.API.stream(opts) → { abort(): void }
opts = {
  apiKey:   String,        // REQUIRED; if falsy -> onError({type:'no_key', message:'...'}) and return no-op
  model:    String,        // REQUIRED
  system:   String,        // system prompt
  messages: Array,         // [{role:'user'|'assistant', content:String}]
  tools:    Array|undefined,// e.g. [config.WEB_SEARCH_TOOL] when web search on
  maxTokens:Number|undefined,// default config.MAX_TOKENS
  signal:   AbortSignal|undefined, // optional external signal (else stream creates its own controller)
  onText:   (deltaText:String) => void,        // each text_delta chunk
  onState:  (s:String) => void,                // 'thinking'|'searching'|'writing'|'done' lifecycle hints
  onDone:   ({ text, usage, raw }) => void,     // text=full assistant text; usage={input_tokens,output_tokens}; raw=last message_delta
  onError:  (err:{type,message,status?}) => void,
}
```
Contract:
- POST `config.API_URL` with headers `{ 'x-api-key', 'anthropic-version':API_VERSION,
  'anthropic-dangerous-direct-browser-access':'true', 'content-type':'application/json' }`.
- Body: `{ model, max_tokens, system, messages, stream:true, tools? }`.
- Parse SSE: read `response.body` reader + TextDecoder, split buffer on `'\n\n'`, handle `data: ` lines.
  Events: message_start, content_block_start (server_tool_use → onState('searching')),
  content_block_delta (text_delta→onText; input_json_delta ignored for display),
  message_delta (capture usage + stop_reason), message_stop → onDone.
- Non-200: read JSON body, call onError({type:'http', status, message}). Network/abort: onError({type:'network'|'abort'}).
- **Web search graceful degrade:** if a request WITH tools fails with an error implying the tool type is
  unsupported (400 mentioning tool/web_search), API retries ONCE without `tools` before reporting error.
- Returns a handle with `.abort()`. If `signal` not provided, internally creates an AbortController.
- NEVER throws synchronously; all failures go through onError.

### 6.4 App.Store — persistence + seeding
```js
App.Store.init()                 // ensure App.state exists; if no save -> seed(); else load(). Called by main first.
App.Store.seed()                 // create default company: state.layout=World.defaultLayout(); default agents
                                 //   (1 boss + engineer + designer + researcher), default settings/camera/tasks/log.
App.Store.save()                 // serialize persistable slice (§2.1) to localStorage[STORAGE_KEY]. Debounce-safe.
App.Store.load() → Boolean       // read+parse+migrate; rebuild transient fields; return true on success, false on miss/corrupt.
App.Store.exportJSON() → String  // pretty JSON of the full save blob (for download).
App.Store.importJSON(str) → Boolean // parse, validate shape, replace state (then save + UI.refresh). false on bad input.
App.Store.clear()                // remove storage key; re-seed; UI.refresh. (Settings "clear data".)
App.Store.pushLog(entry)         // append normalized LogEntry (fills t=Date.now() if missing); cap to last 500; UI may listen.
App.Store.migrate(blob) → blob   // upgrade older SCHEMA_VERSION blobs; safe no-op if current.
```
Contract: Store is the ONLY writer of localStorage. Agents/Orchestrator mutate `App.state` in place and
call `Store.save()` at meaningful checkpoints (task done, agent added, settings changed, layout edit commit).

### 6.5 App.Agents — agent lifecycle, simulation, drawing
```js
App.Agents.create(spec) → Agent
  // spec = { name, role, model?, color?, gx?, gy?, systemPrompt? }. Fills defaults from config.ROLES.
  // Resolves model (spec.model||settings.defaultModel, boss→bossModel), color (spec.color||ROLES[role].color),
  // systemPrompt (spec.systemPrompt||ROLES[role].system). Picks a free desk cell if gx/gy omitted.
  // Pushes to state.agents, returns the agent. Does NOT save (caller decides) — but UI.openAddAgent saves.

App.Agents.remove(agentId)        // abort its stream, free its desk, drop from state.agents, clear selection if selected.
App.Agents.byId(agentId) → Agent|null
App.Agents.findIdle(role) → Agent|null  // idle (state==='idle' && !busy) agent matching role; null if none.

App.Agents.update(dt)             // advance ALL agents: path-follow movement, facing, anim frames, bob,
                                  //   bubble expiry, state upkeep. dt in seconds. Pure simulation (no network).
                                  //   No-op for sim when App.state.paused (still expire bubbles? -> yes, keep UI sane).
App.Agents.draw(ctx)             // draw every agent (sorted by y for depth) via PixelArt.drawAgent + bubbles.
                                  //   Caller (main) has NOT pre-applied camera; Agents.draw uses World.worldToScreen itself.

App.Agents.setState(agent, s)     // set agent.state to one of the 7 states; resets anim if pose-class changes.
App.Agents.goToCell(agent, gx, gy, onArrive?)  // compute path via World.findPath; set state 'walking';
                                  //   stores onArrive callback fired when path empties.
App.Agents.goToFurniture(agent, furnitureType, onArrive?) // find nearest furniture of type w/ free seat,
                                  //   walk to its seat cell, then sit() and fire onArrive.
App.Agents.sit(agent)             // snap to cell center, clear path, face the furniture, state→'idle' (or 'coding' set by caller).
App.Agents.say(agent, text, ms?)  // set agent.bubble={text, until:Date.now()+(ms||config.BUBBLE_MS)}; also Store.pushLog optional.
```
Contract: `Agents.update` MUST be exception-safe per agent (wrap each agent in try/catch; one bad agent
doesn't freeze the rest). Movement: move `x,y` toward next waypoint at WALK_SPEED*dt; pop waypoint within
ARRIVE_EPS; when path empty -> fire onArrive once, set state to 'idle' unless overridden.

### 6.6 App.Orchestrator — boss decomposition / delegation / synthesis
```js
App.Orchestrator.runBossTask(text) → Promise|void
  // 1. ensure a boss agent exists (Agents w/ role 'boss'); create a top-level Task (status 'running').
  // 2. boss does a PLAN call (API.stream, boss system + JSON-plan instruction). Parse defensively:
  //    strip ```fences```, slice first '{'..last '}', JSON.parse. On failure -> single generalist task.
  // 3. for each plan item -> enqueueTask({role,title,instruction,parentId}). assign() idle/temp workers.
  // 4. when all subtasks done -> synthesize(); post final to top-level task.result + boss bubble + log.

App.Orchestrator.enqueueTask(spec) → Task
  // spec = { title, desc/instruction, role, parentId?, assignee? }. Create Task status 'queued', push state.tasks.

App.Orchestrator.assign(task, agent?)  // bind task.assignee, agent.currentTaskId, task.status='running';
                                       // if no agent, pick findIdle(task.role) or spawn temp via Agents.create.
                                       // drive the agent: goToFurniture('desk') then runWorker.

App.Orchestrator.runWorker(task)       // for an assigned task: set agent state 'coding'/'searching',
                                       // API.stream(worker system + task.desc, tools if webSearch+research),
                                       // stream tokens into agent bubble; on done -> task.result, status 'done',
                                       // agent.stats++, agent state 'idle', Store.save, then tick().

App.Orchestrator.synthesize(parentTask) // boss combines child results into final answer (API.stream);
                                        // sets _meetingActive, walks agents to meetingTable, then final bubble.

App.Orchestrator.tick()                // scheduler: idle agents pick up next 'queued' task (FIFO);
                                       // detect all-children-done -> trigger synthesize. Safe to call often.
```
Contract: Orchestrator owns the multi-agent flow & visual choreography (walk-to-desk, meeting). It calls
`Agents.*` for movement/state, `API.stream` for work, `Store.pushLog/save` for logging/persistence, and
`UI.refresh*` to update panels/board. design_orch pins exact prompt text & JSON schema; this file pins the
function set, the parse-fallback rule, and the call graph.

### 6.7 App.UI — DOM overlays (panels/modals/buttons), input handlers
```js
App.UI.init()                    // query DOM by the IDs in §8, attach all event listeners, initial render.
App.UI.refresh()                 // re-render everything driven by state (agent list, board, log, hud).
App.UI.refreshBoard()            // re-render the kanban/task board only.
App.UI.refreshLog()              // re-render activity log only.

App.UI.openAddAgent()            // open Add-Agent modal (name/role/model/color); on submit -> Agents.create + Store.save + refresh.
App.UI.openAgentPanel(agentId)   // set state.selectedAgentId, show side panel: name/role/state/stats, transcript, chat input.
App.UI.closeAgentPanel()         // hide side panel, clear selectedAgentId.
App.UI.openSettings()            // settings modal: apiKey, defaultModel, bossModel, webSearch, export/import/clear.
App.UI.openTaskBoard()           // show task board + "give big task to Boss" input -> Orchestrator.runBossTask.
App.UI.toggleLayoutEdit()        // flip state.layoutEdit; toggle palette UI + canvas edit affordances; Store.save on exit.

// canvas viewport controls (UI owns the listeners; mutates state.camera; clamps via World.clampCamera)
App.UI.zoomIn()  App.UI.zoomOut()  App.UI.resetView()
App.UI.onCanvasPointerDown(e) / Move(e) / Up(e)   // drag-to-pan; click-select agent (screenToCell→hit test);
                                                  // in layoutEdit: place/move/remove furniture (snap to cell).
App.UI.onWheel(e)                // zoom toward cursor; clamp.

App.UI.appendTranscript(agentId, role, text)  // live-append streamed tokens to the open agent panel.
App.UI.toast(msg, kind?)         // small transient notice (e.g. 'set your API key in Settings').
```
Contract: UI READS state and CALLS other modules; it never does network or pathfinding itself. All canvas
math goes through `App.World`. UI must guard for missing DOM nodes (defensive).

### 6.8 main — bootstrap & loop (runs LAST)
```js
App.main.init()    // 1) Store.init() 2) get canvas+ctx, set imageSmoothingEnabled=false, size to DPR
                   // 3) UI.init() 4) start loop. Wrap in try/catch; surface fatal via UI.toast.
App.main.loop(ts)  // rAF callback: compute dt (clamp <=0.05s), state._time+=dt;
                   //   if(!paused) Agents.update(dt) + Orchestrator.tick();
                   //   draw(): clear → tiles → furniture → Agents.draw(ctx) → PixelArt.drawFX. requestAnimationFrame(loop).
App.main.resize()  // recompute canvas size to (clientW*DPR, clientH*DPR); set ctx transform to DPR; World.clampCamera.
```
**Draw order (pinned):** background/floor tiles → furniture (y-sorted with agents OR drawn before) → agents
(y-sorted) → speech bubbles → FX overlay. Recommended: draw furniture & agents in one y-sorted pass for
correct overlap; if simpler, draw all furniture then all agents (acceptable).

---

## 7. WALKABILITY & PATHFINDING (pinned rules)
- `isWalkable(gx,gy)`: in-bounds AND tile ∈ {FLOOR,CARPET,DOOR,RUG} AND no blocking furniture covering it.
- Agents are NON-blocking for pathfinding (they overlap/pass). Collision is only vs walls/void/furniture.
- `findPath` excludes start, includes goal, returns `[]` when start==goal, `null` when unreachable.
- Seats are walkable cells (so agents can stand on them); the furniture body is the blocking part.

---

## 8. DOM CONTRACT (shell.html IDs/classes — BINDING for shell author + UI author)

The shell MUST provide exactly these element IDs. UI queries them by ID.

```
#app                      root flex container (canvas + overlays)
#world-canvas             the <canvas> the office renders on            (UI/main use this id)
#hud                      top bar container
  #btn-task               "New Task / Boss" button (opens task board input)
  #btn-add-agent          "+ Agent" button
  #btn-settings           settings button
  #btn-layout             toggle layout edit button
  #btn-zoom-in            zoom + button
  #btn-zoom-out           zoom - button
  #btn-reset-view         reset camera button
  #status-paused          pause toggle / indicator
#agent-list               left rail listing agents (click -> openAgentPanel)
#panel-agent              right side panel (agent detail)  [hidden by default via .hidden]
  #panel-agent-name       agent name node
  #panel-agent-meta       role/state/model/stats node
  #panel-agent-transcript scrollable transcript container
  #panel-agent-input      <textarea> for direct chat
  #panel-agent-send       send button
  #panel-agent-close      close button
#board                    task board / kanban container   [toggle .hidden]
  #board-input            <textarea> "give big task to Boss"
  #board-send             submit big task button
  #board-col-queued / #board-col-running / #board-col-done   column bodies
#log                      activity log list container
#modal-root               container where modals (add-agent, settings) are mounted
#modal-add-agent          add-agent modal root            [.hidden]
  #aa-name #aa-role #aa-model #aa-color #aa-system #aa-submit #aa-cancel
#modal-settings           settings modal root             [.hidden]
  #set-apikey #set-default-model #set-boss-model #set-websearch
  #set-export #set-import #set-import-file #set-clear #set-save #set-close
#layout-palette           furniture palette (layout edit) [.hidden unless layoutEdit]
#toast                    toast container
```
Conventions:
- Visibility toggled by adding/removing class **`.hidden`** (`display:none`). Authors agree on this class.
- Model `<select>` elements are populated from `config.MODELS` by UI at init (don't hardcode options in shell).
- Role `<select>` (#aa-role) populated from `config.ROLES` keys/labels by UI.
- Buttons fire UI methods only; no inline JS in shell beyond ids/classes.

---

## 9. INTER-MODULE CALL GRAPH (who calls whom — to prevent cycles)
```
main      → Store, UI, Agents, Orchestrator, World, PixelArt
UI        → World, Agents, Orchestrator, Store, config, state   (NOT API directly except via Orchestrator/Agents chat)
Orchestrator → Agents, API, Store, World, UI(refresh*), config, state
Agents    → World, PixelArt, API (for direct chat), Store(say/log), config, state
World     → config, state
PixelArt  → config (palette only); pure functions otherwise
API       → config, state(settings for key/model defaults are READ by callers, not API itself)
Store     → World(defaultLayout), config, state
```
- Direct per-agent chat path: `UI.panel send → Agents`-level helper `Agents.chat(agent, text)` (single-agent,
  no orchestration) OR `Orchestrator`-free call. **PIN:** add `App.Agents.chat(agent, userText)` →
  streams a reply into agent.conversation + transcript + bubble; returns the stream handle. (single agent.)
- No module calls `main`. Only `main` starts the loop & wires top-level DOM/resize.

---

## 10. MODULE LOAD ORDER (scripts concatenated in THIS order; main.js LAST)
```
1. config.js        (App.config, TILES, FURNITURE, ROLES, MODELS)
2. pixelart.js      (App.PixelArt)
3. world.js         (App.World)
4. api.js           (App.API)
5. store.js         (App.Store)        // seeds App.state via World.defaultLayout
6. agents.js        (App.Agents)
7. orchestrator.js  (App.Orchestrator)
8. ui.js            (App.UI)
9. main.js          (App.main; calls main.init())   <-- LAST, only file that auto-runs
```
Rule: files 1–8 only DEFINE (assign to App.*). They may reference other App.* members only inside function
bodies (executed after main.init). config.js may run trivial constant setup at load. main.js is the sole
entry point that invokes `App.main.init()` (e.g. on DOMContentLoaded).

---

## 11. UNITS & CAMERA — worked example (so all authors agree numerically)
- TILE=16, PIXEL=3, zoom=1 → one cell = 48 screen px. GRID 30×20 → world 480×320 px → 1440×960 screen @ zoom1.
- Agent at cell (5,4): world center = ((5+0.5)*16, (4+0.5)*16) = (88, 72).
- camera={x:0,y:0,zoom:1}: worldToScreen(88,72) = ((88-0)*3, (72-0)*3) = (264, 216).
- Zoom toward cursor: keep the world point under the cursor fixed by adjusting camera.x/y after changing zoom:
  `cam.x = worldUnderCursor.x - cursorScreenX/(PIXEL*newZoom)` (UI.onWheel implements; World provides transforms).

---

## 12. ERROR / EMPTY STATES (pinned behaviors)
- Missing API key on any send → `UI.toast('Set your API key in Settings')`, no crash, no stream.
- Boss plan parse fail → fallback single generalist task (never throw).
- Unreachable desk → agent stays idle at current cell; log a 'system' entry; do not loop forever.
- Corrupt/missing localStorage → `Store.seed()` fresh company.
- Web search unsupported → silent retry without tools (§6.3); if still failing, normal onError.
- Loop never breaks: per-agent and per-draw try/catch.

---

## 13. NAMING/STYLE
- IDs: lowercase, `a_`/`t_`/`f_` prefixes for agent/task/furniture ids; helper `App.util?.uid(prefix)` allowed
  (if a tiny shared util is desired, put it on `App.util` defined in config.js).
- Comments: Korean or English fine. Keep functions small & defensive.
- Colors ONLY from `App.PixelArt.getPalette()` / `ROLES[x].color` / `agent.color`. No ad-hoc hex in logic.

— END design_arch.md —
