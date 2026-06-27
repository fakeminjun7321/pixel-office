# design_orch.md — Agent & Orchestration Design (PIXEL AI COMPANY)

> Single source of truth for **live agent behavior + Boss orchestration**.
> Owns the runtime contract of `App.Agents` and `App.Orchestrator`.
> **If `SPEC.md` exists and gives concrete signatures, SPEC.md wins** for exact function names/args.
> Everything here is written to the namespace contract in the project brief: classic `<script>` blocks,
> no import/export, all state on `window.App` and `App.state`.

---

## 0. Module surface (what these two modules expose)

```js
window.App = window.App || {};

// ---- App.Agents : per-agent direct chat + agent factory + state-machine helpers ----
App.Agents = {
  ROLES,                       // preset role table (below)
  systemPromptFor(role, agent),// returns the system prompt string for a role
  create({name, role, model, color, gx, gy}), // -> Agent (pushes into App.state.agents)
  remove(agentId),
  byId(id),
  byRole(role),                // -> Agent[] matching role
  idleByRole(role),            // -> first idle, non-busy agent of role (or null)
  directChat(agentId, userText, {onText, onDone, onError}), // 1:1 streaming chat, NO orchestration
  setState(agent, visualState),// 'idle'|'walking'|'thinking'|'coding'|'searching'|'meeting'|'coffee'
  say(agent, text, ms),        // speech bubble for ms (default 4000)
  goTo(agent, gx, gy, thenState), // path the agent to a cell, set state on arrival
};

// ---- App.Orchestrator : Boss decomposition + delegation + synthesis + task queue ----
App.Orchestrator = {
  runBossTask(text),           // top-level: decompose -> delegate -> synthesize. Returns Promise<rootTask>
  enqueue(taskPartial),        // push a Task into the queue (status 'queued')
  tick(),                      // called each frame by main loop: idle agents pull queued tasks
  runSubtask(task, agent),     // execute one Task via App.API.stream on `agent`
  synthesize(rootTask),        // Boss final call combining child results
  cancelTask(taskId),          // abort in-flight stream + mark error/queued
  PLAN_SCHEMA_VERSION: 1,
};
```

`App.Orchestrator.tick()` is invoked once per frame from `main.js` (cheap; it just scans for `queued` tasks
and free agents). All actual work runs in async stream callbacks — the render loop never blocks.

---

## 1. Preset roles & default system prompts

`App.Agents.ROLES` is the canonical table. `key` is stored on `agent.role` and on `task.role` for matching.
Each role has: `label`, `color` (default neon accent), `model` (default model id), `glyph` (sprite hint for
PixelArt — e.g. headset/wrench/palette), and `system` (the prompt text).

> Models: boss defaults to `claude-opus-4-8`; workers default to `claude-sonnet-4-6`; fast roles may use
> `claude-haiku-4-5-20251001`. Never hardcode a key.

### 1.1 Shared preamble (prepended to EVERY worker prompt)

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

### 1.2 Boss / Orchestrator

`key: "boss"`, color `#23f0ff` (cyan), model `claude-opus-4-8`.

The Boss has **two prompts** because it plays two turns:
(A) **decompose** (returns strict JSON plan) and (B) **synthesize** (returns the final human answer).
Both are given in §2 and §5; the role's stored `system` field holds the decompose prompt by default.

### 1.3 Engineer

`key: "engineer"`, color `#39ff14` (neon green), glyph `wrench`, model `claude-sonnet-4-6`.

```text
[shared preamble]
ROLE: Senior Software Engineer.
You write correct, runnable, idiomatic code and terse technical explanations.
- Default to a single self-contained snippet unless told otherwise. Include only the code that is needed.
- Note language/runtime assumptions in one line if not specified.
- If asked to design, give concrete interfaces/data shapes, not vague prose.
- Prefer standard libraries; avoid inventing dependencies.
RESULT: line = one sentence stating what you built and how to use it.
```

### 1.4 Designer

`key: "designer"`, color `#ff2bd6` (magenta), glyph `palette`, model `claude-sonnet-4-6`.

```text
[shared preamble]
ROLE: Product / Visual Designer.
You produce concrete design specs: layouts, component lists, color/typography tokens, copy for UI,
and rationale tied to usability. Use exact values (hex, px, spacing scale) not adjectives.
- When visuals are needed, describe them precisely enough to implement, or give ASCII/structural mockups.
- Tie every choice to a user goal in <=1 short clause.
RESULT: line = the single most important design decision.
```

### 1.5 Researcher

`key: "researcher"`, color `#b06bff` (purple), glyph `magnifier`, model `claude-sonnet-4-6`,
`webSearchPreferred: true`.

```text
[shared preamble]
ROLE: Research Analyst.
You gather and synthesize current, accurate information and present it as crisp findings.
- If web search is available, use it for anything time-sensitive, factual, or version-specific.
- Cite sources inline as [n] with a short Sources list at the end when you used the web.
- Separate FACTS (sourced) from your INFERENCE. Never fabricate citations or numbers.
- Output bullet findings, most-decision-relevant first.
RESULT: line = the key takeaway for the Boss.
```

### 1.6 Writer

`key: "writer"`, color `#ffd23f` (amber), glyph `pen`, model `claude-sonnet-4-6`.

```text
[shared preamble]
ROLE: Technical & Marketing Writer.
You turn raw material into clear, well-structured prose in the requested tone/format.
- Match the audience and length implied by the instruction; if unspecified, be concise and neutral.
- Strong structure: headline + scannable sections. No filler, no clichés.
- Preserve any facts/numbers from input exactly; do not invent specifics.
RESULT: line = the finished piece's one-sentence thesis.
```

### 1.7 QA

`key: "qa"`, color `#ff5e5e` (red), glyph `check`, model `claude-haiku-4-5-20251001` (fast).

```text
[shared preamble]
ROLE: Quality Assurance / Reviewer.
You critically review the provided artifact for correctness, completeness, and edge cases.
- Output: (1) a PASS/FAIL verdict, (2) a numbered list of concrete issues with severity [blocker|major|minor],
  (3) the minimal fix for each. Be specific (quote the offending part).
- If you cannot find issues, say PASS and list the top risks you checked.
RESULT: line = verdict + issue count, e.g. "FAIL — 2 blockers, 1 minor".
```

### 1.8 Generalist (fallback only — not shown in the picker by default)

`key: "generalist"`, color `#9fb4ff`, model `claude-sonnet-4-6`. Used when plan parsing fails (§2.4)
or when an unknown `role` is requested.

```text
[shared preamble]
ROLE: Generalist Operator.
Handle whatever the instruction asks as competently as possible, end-to-end. Produce the real deliverable.
RESULT: line = one-sentence summary of what you delivered.
```

**Role matching:** `App.Agents.idleByRole(role)` matches `agent.role === task.role`. If none idle, the
orchestrator either waits (queue) or **spawns a temporary worker** of that role (`temp:true`) seated at a
free desk; temp workers are auto-removed when idle for >60s if `App.config.cullTempAgents` (default true).

---

## 2. Boss decomposition: prompt, schema, parsing

### 2.1 Decompose system prompt (Boss turn A) — exact text

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
      "needsWeb": <true|false>          // true if this subtask requires current external info
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

### 2.2 Decompose user message

The user's raw goal is sent as the user turn, lightly framed so the model knows it's the goal to plan:

```text
GOAL:
<user text verbatim>

Return the JSON plan now.
```

### 2.3 Strict JSON plan schema (canonical, `PLAN_SCHEMA_VERSION = 1`)

```jsonc
{
  "plan": [
    { "role": "engineer", "title": "Build API client", "instruction": "Write a ...", "needsWeb": false }
  ],
  "final": "Combine the engineer's client code and the writer's README into one deliverable."
}
```

Normalized after parse into Task objects (see §3). `needsWeb` defaults to the role's `webSearchPreferred`
if missing. `title` defaults to first 6 words of `instruction` if missing.

### 2.4 Robust parsing strategy (`parsePlan(rawText)` — pseudo-code)

```js
function parsePlan(raw) {
  if (!raw || !raw.trim()) return null;
  let s = raw.trim();

  // 1) strip code fences ```json ... ``` or ``` ... ```
  s = s.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/i, '');

  // 2) brace slicing: take from first '{' to the LAST matching '}'
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let body = s.slice(start, end + 1);

  // 3) forgiving cleanups: remove trailing commas, smart quotes
  body = body
    .replace(/,(\s*[}\]])/g, '$1')         // trailing commas
    .replace(/[“”]/g, '"')       // “ ”
    .replace(/[‘’]/g, "'");      // ‘ ’

  let obj;
  try { obj = JSON.parse(body); }
  catch (e) {
    // 4) last-ditch: try to balance braces by trimming to the deepest valid prefix
    try { obj = JSON.parse(balanceBraces(body)); } catch (e2) { return null; }
  }

  // 5) validate shape
  if (!obj || !Array.isArray(obj.plan) || obj.plan.length === 0) return null;
  obj.plan = obj.plan
    .filter(it => it && it.instruction)
    .slice(0, 5)
    .map(it => ({
      role: KNOWN_ROLES.has(it.role) ? it.role : 'generalist',
      title: (it.title || firstWords(it.instruction, 6)).slice(0, 48),
      instruction: String(it.instruction),
      needsWeb: typeof it.needsWeb === 'boolean'
                ? it.needsWeb
                : !!ROLES[it.role]?.webSearchPreferred,
    }));
  if (obj.plan.length === 0) return null;
  obj.final = typeof obj.final === 'string' ? obj.final
            : 'Combine all worker results into a single coherent answer for the user.';
  return obj; // PLAN_SCHEMA_VERSION 1
}
```

### 2.5 Fallback when parsing fails

If `parsePlan` returns `null`:
1. Log a `system` line: `Boss plan unreadable — running as a single generalist task.`
2. Build a **one-item plan**: `{ role:'generalist', title:'Handle task', instruction:<user text>, needsWeb:settings.webSearch }`.
3. Proceed normally (decompose → run → synthesize). Synthesis with one child effectively just polishes
   the single result, so the user still gets a clean answer.

If the Boss call itself errors (network / no key), see §8.

---

## 3. Task lifecycle state machine ↔ agent visual states

### 3.1 Task statuses

`queued → running → (blocked) → done | error`

| Task.status | Meaning | Set when |
|---|---|---|
| `queued`    | created, not yet picked up | on plan normalize / `enqueue` |
| `running`   | an agent owns it & stream is live | `tick()` assigns it to an idle agent |
| `blocked`   | waiting on a dependency's result | dependency not yet `done` |
| `done`      | result populated | stream `onDone` with non-empty text |
| `error`     | failed (API/parse/abort) | stream `onError` / abort |

Root (Boss) task uses the same enum: it sits `running` while children run, flips to `done` after
synthesis succeeds.

### 3.2 Agent visual state ↔ task phase mapping

| Phase | Task.status | Agent.state | Trigger / choreography |
|---|---|---|---|
| Boss receives goal | root `running` | Boss → `thinking` | Boss bubble "🧠 Planning…", walks to its desk if away |
| Plan produced | children `queued` | Boss → `idle` (watches) | Boss bubble "Delegating N tasks" |
| Subtask assigned | `running` | worker → `walking` | `goTo(desk, thenState)`; bubble shows `title` |
| Worker at desk, no web | `running` | worker → `coding` | sit + type animation; tokens stream into bubble/panel |
| Worker at desk, web on | `running` | worker → `searching` | magnifier glyph + scan FX while `web_search` active, then back to `coding` |
| Subtask finished | `done` | worker → `idle` then `coffee` | bubble "✓ done"; optional walk to coffee tile for ~6s |
| Subtask failed | `error` | worker → `idle` | bubble "⚠ error"; red flash |
| All children done → synthesis | root `running` | all participants → `meeting` | each non-busy contributor walks to a meeting-table cell; Boss `thinking` |
| Final answer ready | root `done` | Boss → `idle`/`coffee`; others disperse | Boss bubble "Done ✓"; result posted to board + log |

`App.Agents.setState` is the only place that mutates `agent.state`; it also resets `agent.anim.frame=0`
and updates `agent.facing` toward the relevant furniture (desk monitor / meeting table center).

### 3.3 Speech-bubble & log messages (concrete strings)

Use `App.Agents.say(agent, text, ms)` for bubbles and `App.Store.log({from,to,kind,text})` for the feed.
(`App.Store.log` appends to `App.state.log`; if its real name differs, SPEC.md wins.)

```
SYSTEM  log  "Boss received task: <title…>"
boss    say  "🧠 Planning…"
boss    log  kind:'msg'  to:'@all'   "Delegating 3 tasks"
boss    say  "@Engineer: build the API client"     // one per delegated child, staggered ~600ms
engineer say "On it ⌨️"        (state coding)
engineer log kind:'msg' to:'boss' "@Boss: starting <title>"
researcher say "🔎 searching…" (state searching)
engineer say "✓ done"          (state idle→coffee)
engineer log kind:'result' to:'boss' "@Boss: done ✓ — <RESULT line>"
boss    say  "Let's sync 🤝"    (everyone → meeting)
boss    say  "Synthesizing…"
boss    say  "Done ✓"
SYSTEM  log  "Task complete."
```

Bubble text is truncated to ~48 chars with `…`; the full text lives in the agent panel transcript and the log.

---

## 4. Worker execution — one subtask → one `App.API.stream` call

### 4.1 Building the call

```js
async function runSubtask(task, agent) {
  task.status = 'running';
  task.assignee = agent.id;
  agent.busy = true;
  agent.currentTaskId = task.id;

  const settings = App.state.settings;
  const apiKey = settings.apiKey;
  if (!apiKey) { failTask(task, agent, 'NO_KEY'); return; }   // see §8

  // 1) walk the agent to its desk, THEN start the stream
  await goToAsync(agent, agent.gx, agent.gy);  // resolves on arrival (or immediately if already there)

  // 2) decide web search
  const useWeb = !!settings.webSearch && (task.needsWeb || ROLES[task.role]?.webSearchPreferred);
  App.Agents.setState(agent, useWeb ? 'searching' : 'coding');

  // 3) assemble messages — workers are stateless per subtask (fresh context),
  //    but we keep agent.conversation for the side-panel transcript + direct chat continuity.
  const system = App.Agents.systemPromptFor(task.role, agent);
  const messages = [{
    role: 'user',
    content: buildWorkerUserContent(task)   // see §4.2
  }];
  const tools = useWeb
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    : undefined;

  let acc = '';
  const ctrl = App.API.stream({
    apiKey,
    model: agent.model || ROLES[task.role]?.model || settings.defaultModel,
    system, messages, tools,
    onState(s) {
      // API layer emits 'searching' when a web_search tool_use block starts, 'thinking' otherwise
      if (s === 'searching') App.Agents.setState(agent, 'searching');
      else if (s === 'text') App.Agents.setState(agent, 'coding');
    },
    onText(delta) {
      acc += delta;
      App.Agents.say(agent, acc.slice(-48), 3000);      // live bubble = tail of output
      App.UI.appendAgentStream?.(agent.id, delta);      // panel transcript live update
    },
    onDone({ text, usage }) {
      const out = (text || acc).trim();
      finishTask(task, agent, out, usage);              // see §4.3
    },
    onError(err) { failTask(task, agent, err); },        // §8 (with web-retry, §6 below)
  });
  task._ctrl = ctrl;   // keep AbortController for cancelTask
}
```

### 4.2 Worker user content (`buildWorkerUserContent`)

Inject dependency results so later subtasks can build on earlier ones:

```js
function buildWorkerUserContent(task) {
  let s = task.instruction;
  const deps = depResults(task);   // results of sibling tasks ordered before this one (if any)
  if (deps.length) {
    s += '\n\n--- CONTEXT FROM EARLIER STEPS (use as needed) ---\n';
    deps.forEach(d => { s += `\n[${d.role} — ${d.title}]\n${truncate(d.result, 4000)}\n`; });
  }
  return s;
}
```

Dependency policy (simple, deterministic): a subtask depends on **all earlier subtasks in the same plan**
that are already `done`. This makes "engineer then writer then qa" chains work without an explicit DAG.
A task whose required predecessors aren't all `done` is held `blocked` and re-checked each `tick()`.

### 4.3 Finishing

```js
function finishTask(task, agent, out, usage) {
  task.result = out || '(empty result)';
  task.status = out ? 'done' : 'error';
  agent.busy = false;
  agent.currentTaskId = null;
  agent.stats.tasksDone += out ? 1 : 0;
  if (usage) { agent.stats.tokensIn += usage.input_tokens||0; agent.stats.tokensOut += usage.output_tokens||0; }
  App.Agents.say(agent, out ? '✓ done' : '⚠ error', 2500);
  App.Store.log({ from: agent.id, to: 'boss', kind: 'result',
                  text: `@Boss: done ✓ — ${resultLine(out)}` });
  App.Agents.setState(agent, 'idle');
  maybeCoffee(agent);                 // small chance / always-after-task walk to coffee tile
  App.Store.save?.();                 // persist progress
  App.Orchestrator._checkPlanComplete(task.parentId);  // may trigger synthesis (§5)
}
```

`resultLine(out)` extracts the trailing `RESULT:` line if present, else the first ~60 chars.

---

## 5. Synthesis + meeting-table choreography

### 5.1 When

`_checkPlanComplete(parentId)` runs after every child finishes. When **all** children of the root are
`done` (or terminal: `done`/`error` with at least one `done`), the Boss synthesizes. If every child
`error`ed, the root goes `error` with a friendly message (no synthesis).

### 5.2 Meeting choreography

```js
function beginSynthesis(rootTask) {
  const contributors = childrenOf(rootTask).map(t => App.Agents.byId(t.assignee)).filter(Boolean);
  const boss = bossAgent();
  // walk Boss + each contributor to a ring of cells around the meeting table furniture
  const seats = App.World.meetingSeats?.() || ringCellsAround(meetingTable());
  [boss, ...contributors].forEach((ag, i) => {
    if (!ag) return;
    App.Agents.goTo(ag, seats[i].gx, seats[i].gy, 'meeting');
  });
  boss && App.Agents.say(boss, "Let's sync 🤝", 3000);
  App.Store.log({ from:'boss', to:'@all', kind:'msg', text:'Syncing results at the table' });
  // start the synthesis call (doesn't need to wait for arrival; arrival is cosmetic)
}
```

### 5.3 Boss synthesis call (Boss turn B) — exact prompt

System prompt:

```text
You are the BOSS of an autonomous AI company. Your workers have completed their subtasks.
Combine their results into ONE final answer that fully satisfies the user's original goal.
- Integrate the pieces; resolve any conflicts; do not just concatenate.
- Keep what's good, fix obvious gaps, and present it cleanly for the user (markdown ok).
- If a subtask failed, work around it gracefully and note the limitation briefly.
- Do not mention this internal process unless useful. Just deliver the result.
```

User message:

```text
USER'S ORIGINAL GOAL:
<root user text>

SYNTHESIS GUIDANCE (your own earlier note):
<plan.final>

WORKER RESULTS:
[engineer — Build API client]
<result text>

[writer — Write README]
<result text>
...

Produce the final answer for the user now.
```

```js
async function synthesize(rootTask) {
  const boss = bossAgent();
  App.Agents.setState(boss, 'thinking');
  App.Agents.say(boss, 'Synthesizing…', 4000);
  let acc = '';
  App.API.stream({
    apiKey: App.state.settings.apiKey,
    model: boss.model || App.state.settings.bossModel,   // opus
    system: BOSS_SYNTH_SYSTEM,
    messages: [{ role:'user', content: buildSynthUserContent(rootTask) }],
    // synthesis itself usually doesn't need web; enable only if any child needed web AND settings.webSearch
    tools: synthNeedsWeb(rootTask) ? [WEB_TOOL] : undefined,
    onText(d){ acc += d; App.Agents.say(boss, acc.slice(-48), 3000); App.UI.appendAgentStream?.(boss.id, d); },
    onDone({text, usage}) {
      rootTask.result = (text||acc).trim();
      rootTask.status = 'done';
      bumpTokens(boss, usage);
      App.Agents.say(boss, 'Done ✓', 4000);
      App.Store.log({ from:'boss', to:'user', kind:'result', text:'Final answer ready ✓' });
      App.UI.showFinalResult?.(rootTask);   // surface on board / modal
      disperseMeeting();                     // contributors → idle/coffee/desks
      App.Agents.setState(boss, 'idle'); maybeCoffee(boss);
      App.Store.save?.();
    },
    onError(err){ rootTask.status='error'; rootTask.error=errMsg(err);
                  App.Agents.say(boss,'⚠ synth failed',4000); App.UI.showError?.(errMsg(err)); }
  });
}
```

---

## 6. Web search specifics

- Tool block: `const WEB_TOOL = { type:'web_search_20250305', name:'web_search', max_uses:5 };`
- Enabled per-subtask iff `settings.webSearch && (task.needsWeb || role.webSearchPreferred)`.
- Visual: while a `server_tool_use`/`web_search_tool_result` block is active the API layer calls
  `onState('searching')` → agent shows `searching` state (magnifier glyph + scan FX). On the next
  `text_delta` it flips back to `coding`.
- **Graceful degradation:** if the API returns an error indicating the tool type is unsupported
  (e.g. 400 mentioning `web_search_20250305` / `tools`), `onError` triggers a **single automatic retry
  without `tools`** for the same subtask, logging `system: "Web search unavailable — retrying without it."`
  Implement in the orchestrator's `onError` (see §8) by checking `err.isToolUnsupported`.

```js
function isToolUnsupportedError(err){
  const m = (err && (err.message||err.text||'')+'' ).toLowerCase();
  return m.includes('web_search') || (err && err.status===400 && m.includes('tool'));
}
```

---

## 7. Task queue semantics (idle agents pull work)

State lives in `App.state.tasks`. The queue is just `tasks.filter(status==='queued')`.

### 7.1 `tick()` (called once/frame, must be cheap & re-entrant-safe)

```js
App.Orchestrator.tick = function () {
  if (App.state.paused) return;
  const queued = App.state.tasks.filter(t => t.status === 'queued');
  for (const task of queued) {
    // dependency gate
    if (!depsSatisfied(task)) { task.status = 'blocked'; continue; }
    // pick an idle, non-busy agent matching role
    let agent = App.Agents.idleByRole(task.role);
    if (!agent) {
      // optionally spawn a temp worker if under the concurrency cap
      if (activeWorkers() < App.config.maxConcurrent) agent = spawnTempWorker(task.role);
    }
    if (!agent) continue;          // none free right now; try next frame
    // CLAIM atomically before any await to avoid double-assignment
    agent.busy = true;
    task.status = 'running';
    App.Orchestrator.runSubtask(task, agent);  // async; agent.busy already set
  }
  // re-check blocked tasks: flip back to 'queued' once deps satisfied
  App.state.tasks.forEach(t => { if (t.status==='blocked' && depsSatisfied(t)) t.status='queued'; });
};
```

### 7.2 Anti-double-assignment

- The claim (`agent.busy = true; task.status='running'`) happens **synchronously before** `runSubtask`'s
  first `await`. Since `tick()` runs on the single JS thread and isn't re-entered mid-call, no two ticks
  can grab the same idle agent or the same `queued` task.
- `runSubtask` re-asserts `agent.busy`/`task.status` defensively but never relies on them being unset.

### 7.3 Concurrency

- `App.config.maxConcurrent` (default 4) caps simultaneously `running` worker subtasks.
- Within one Boss plan, independent subtasks run **in parallel** up to the cap; dependent ones wait via
  the `blocked` gate. Manually queued (non-Boss) tasks interleave with plan tasks using the same rules.

### 7.4 Manual enqueue & direct chat

- `App.Orchestrator.enqueue({title, instruction, role})` pushes a standalone `queued` task (no parent);
  it gets picked up by `tick()` and, on `done`, just posts its result (no synthesis).
- **Direct chat** (`App.Agents.directChat`) bypasses the queue entirely: it streams straight to that one
  agent using its role system prompt + `agent.conversation` history, setting `coding`/`searching` visual
  state but **not** touching `busy`/tasks unless you want it to block orchestration (default: it sets
  `busy=false` so the agent can still be pulled — configurable via `App.config.directChatBlocks`).

---

## 8. Error-handling UX

All failures degrade gracefully; the render loop never throws.

| Failure | Detection | UX |
|---|---|---|
| **No API key** | `!settings.apiKey` at call time | No network call. Bubble on the actor: "🔑 set your API key in Settings". Toast/log `system`: "API key missing — open Settings to add it." Task → `error` with `error:'NO_KEY'`. Boss task: surface the same toast; do not crash. |
| **API HTTP error** | `App.API.stream` `onError` with parsed `{status, type, message}` | Agent bubble "⚠ error"; red flash; log `system`: "API error (<status>): <message>". Task → `error`, `task.error=message`. Offer "Retry" on the kanban card (re-`enqueue` same partial). |
| **Network error** | `onError` (TypeError/fetch fail, no status) | Same as above with message "network error — check connection". Retry available. |
| **Web tool unsupported** | `isToolUnsupportedError(err)` in `onError` | Auto-retry once without `tools` (§6). Only if the retry also fails do we mark `error`. |
| **Plan JSON unparseable** | `parsePlan()===null` | Fallback to single generalist task (§2.5); log `system`: "Boss plan unreadable — running as one task." User still gets an answer. |
| **Empty result** | `onDone` text empty after trim | Task → `error` ("(empty result)"); Boss synthesizes around it noting the gap. |
| **All children failed** | every child `error` | Root → `error`; Boss bubble "⚠ couldn't complete"; show the collected child errors in the result modal so the user can retry individual cards. |
| **Aborted** | user `cancelTask`/pause | `task._ctrl.abort()`; task → `queued` (re-runnable) or `error` per context; agent → `idle`, `busy=false`. |

`cancelTask`:

```js
App.Orchestrator.cancelTask = function (taskId) {
  const t = App.state.tasks.find(x => x.id === taskId);
  if (!t) return;
  try { t._ctrl && t._ctrl.abort(); } catch (e) {}
  const ag = t.assignee && App.Agents.byId(t.assignee);
  if (ag) { ag.busy = false; ag.currentTaskId = null; App.Agents.setState(ag, 'idle'); }
  t.status = 'queued';                 // allow re-pickup; UI may also offer hard-cancel → 'error'
  App.Store.log({ from:'system', to:t.assignee||'@all', kind:'system', text:`Task aborted: ${t.title}` });
};
```

---

## 9. End-to-end flow (reference sequence)

```
user → board input "Build a landing page for X"
  App.Orchestrator.runBossTask(text):
    1. ensure boss agent; rootTask = createTask({title:'Boss: '+head(text), role:'boss', status:'running'})
    2. boss.state='thinking'; say "🧠 Planning…"
    3. App.API.stream(decompose prompt) → raw
    4. plan = parsePlan(raw)  || fallbackPlan(text)
    5. for each item: child = createTask({...item, parentId:rootTask.id, status:'queued'})
       rootTask.subtaskIds.push(child.id)
    6. boss say "Delegating N tasks"; per-child boss say "@Role: <title>" (staggered)
    7. (each frame) tick() pulls queued children → runSubtask → stream → finishTask
       - dependent children wait as 'blocked' until predecessors 'done'
    8. when all children terminal → beginSynthesis(rootTask) → synthesize(rootTask)
    9. rootTask.done; UI.showFinalResult; agents disperse; Store.save
```

---

## 10. Cross-module assumptions (so implementers wire correctly)

These are **calls this design makes into other modules**. If SPEC.md names them differently, follow SPEC.md
and update the call sites; the orchestrator only needs the capability, not the exact name.

- `App.World.findPath(gx0,gy0,gx1,gy1) -> [{gx,gy},...]` — used by `goTo`/`goToAsync`.
- `App.World.meetingSeats() -> [{gx,gy},...]` and `App.World.coffeeTile() -> {gx,gy}` (fallbacks provided).
- `App.Store.log(entry)` appends to `App.state.log`; `App.Store.save()` persists to localStorage.
- `App.UI.appendAgentStream(agentId, delta)`, `App.UI.showFinalResult(task)`, `App.UI.showError(msg)`,
  `App.UI.toast(msg)` — all optional (guarded with `?.`); orchestration works headless if absent.
- `App.config`: `{ maxConcurrent:4, cullTempAgents:true, directChatBlocks:false }` defaults; created by
  config module, but orchestrator must default-fill any missing keys.

## 11. IDs, timing, determinism

- IDs: `App.Store.uid('task')` / `uid('agent')` (fallback `Date.now()+rand` if Store absent).
- Bubble durations: planning 4s, per-delegation 3s, result 2.5s, "Done ✓" 4s. Stagger delegations ~600ms.
- `tick()` does no allocation-heavy work; filters are O(tasks) and tasks are few. Safe at 60fps.
- All async paths wrapped in try/catch; any thrown error is routed to `failTask`/`onError`, never bubbles
  to the animation loop.
