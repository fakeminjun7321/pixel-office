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

  // ---------------------------------------------------------------------------
  // v3 §ARTIFACTS — appended to every worker instruction so concrete deliverables
  // are emitted as fenced ```artifact:<filename.ext>``` blocks the Orchestrator
  // can harvest. Also reinforces the trailing one-line RESULT: summary.
  // ---------------------------------------------------------------------------
  var WORKER_ARTIFACT_HINT =
'\n\nDELIVERABLE FORMAT:\n' +
'- If your task produces ANY concrete deliverable (code, a document, structured data, a config file),\n' +
'  emit it as a fenced block whose info-string is "artifact:" + a sensible filename WITH extension, e.g.:\n' +
'  ```artifact:login.js\n' +
'  // the actual code here\n' +
'  ```\n' +
'  or  ```artifact:spec.md\n' +
'  # the actual document here\n' +
'  ```\n' +
'  Put the FULL final content inside the block — not a snippet or a description of it.\n' +
'- Use one artifact block per distinct file. Plain prose/analysis can stay outside any block.\n' +
'- ALWAYS finish your message with a final line:  RESULT: <one-line summary of what you delivered>.';

  // ---------------------------------------------------------------------------
  // v3 §QA LOOP — system prompt for the QA reviewer pass. The reviewer reads a
  // worker's deliverable and MUST reply with EXACTLY one of the two forms below
  // so the Orchestrator can parse PASS/FAIL deterministically (reuse resultLine).
  // ---------------------------------------------------------------------------
  var QA_REVIEW_SYSTEM =
'You are a strict QA reviewer inside an autonomous AI company. You are given ONE worker deliverable.\n' +
'Judge it for correctness, completeness, and whether it actually satisfies the stated task — nothing else.\n' +
'Be pragmatic: a deliverable that is correct and complete PASSES even if it could be marginally nicer.\n' +
'Only FAIL for real, fixable defects (bugs, missing required pieces, factual/logical errors, broken format).\n' +
'\n' +
'You MUST reply with EXACTLY one line and NOTHING ELSE, in one of these two forms:\n' +
'RESULT: PASS\n' +
'RESULT: FAIL — <specific, actionable feedback the worker can act on in one revision>\n' +
'\n' +
'Do not add any other text, headings, markdown, or explanation. The feedback after "FAIL — " must be\n' +
'concrete (quote the offending part, name the missing piece, give the exact fix).';

  // worker system = preamble + "\n\n" + body  (artifact hint appended so EVERY worker emits artifacts)
  function worker(body) { return WORKER_PREAMBLE + '\n\n' + body + WORKER_ARTIFACT_HINT; }

  // ---------------------------------------------------------------------------
  // v3 §6 ROLES[*].persona — short identity / plan / relationships strings used
  // for agent flavor + memory-prompt prepends. Sensible defaults per role.
  // ---------------------------------------------------------------------------
  var PERSONAS = {
    boss: {
      identity: 'You are the Boss — the calm, decisive orchestrator who turns a fuzzy goal into a crisp plan.',
      plan: 'Decompose, delegate to the right specialists, then synthesize their work into one clean answer.',
      relationships: 'You trust your team; you push the engineer for rigor, the qa for honesty, and keep everyone unblocked.'
    },
    engineer: {
      identity: 'You are the Engineer — pragmatic, precise, and allergic to hand-waving. You ship working code.',
      plan: 'Read the spec, pick the simplest correct approach, write tight self-contained code, note assumptions.',
      relationships: 'You respect the designer\'s specs, lean on the researcher for facts, and brace for QA\'s nitpicks.'
    },
    designer: {
      identity: 'You are the Designer — visual, user-obsessed, exact with tokens (hex, px, spacing) not adjectives.',
      plan: 'Anchor every choice to a user goal, give concrete layouts/specs the engineer can implement directly.',
      relationships: 'You hand clean specs to the engineer and trade taste opinions with the writer.'
    },
    researcher: {
      identity: 'You are the Researcher — curious, skeptical, and careful to separate sourced fact from inference.',
      plan: 'Gather current, accurate info; cite sources; surface the most decision-relevant findings first.',
      relationships: 'You feed facts to the writer and engineer and flag anything time-sensitive to the Boss.'
    },
    writer: {
      identity: 'You are the Writer — clear, structured, and ruthless about cutting filler and clichés.',
      plan: 'Match audience and tone, build strong scannable structure, preserve every fact from your inputs.',
      relationships: 'You polish the researcher\'s findings and the engineer\'s notes into prose people actually read.'
    },
    qa: {
      identity: 'You are QA — the loyal skeptic. Your job is to catch what everyone else missed.',
      plan: 'Stress-test deliverables for correctness, completeness, and edge cases; give the minimal fix.',
      relationships: 'You hold the engineer and designer to a high bar; the Boss relies on your honest verdict.'
    },
    generalist: {
      identity: 'You are a Generalist Operator — versatile and reliable, you take any task end-to-end.',
      plan: 'Understand the ask, pick a sensible approach, and produce the real deliverable without fuss.',
      relationships: 'You fill gaps for the whole team and adapt to whatever the Boss needs next.'
    }
  };

  // §6.3 BOSS_DECOMPOSE_SYSTEM (Boss turn A — stored as ROLES.boss.system).
  // v3: EXTENDED so each subtask may declare optional "deps" (DAG) and "verify" (QA loop).
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
'      "needsWeb": <true|false>,\n' +
'      "deps": [<0-based indices of EARLIER plan items whose results this needs; [] if independent/parallel>],\n' +
'      "verify": <optional true|false: true to have QA review this deliverable before it is accepted>,\n' +
'      "requiresApproval": <optional true|false: true to pause for a human approval gate before this\n' +
'                           deliverable is accepted (only when the company has approval gating enabled)>\n' +
'    }\n' +
'  ],\n' +
'  "final": "<one sentence telling yourself how to combine the workers\' results into the user\'s answer>"\n' +
'}\n' +
'\n' +
'Rules:\n' +
'- 1 to 5 items in "plan". Each instruction must be complete on its own (the worker cannot see the user\'s\n' +
'  original goal — only your instruction).\n' +
'- Use only the role keys listed. If the goal is trivial/single-step, return a one-item plan.\n' +
'- ALWAYS include "deps" on every item: [] if it can start immediately (independent — these run in\n' +
'  PARALLEL), or the 0-based indices of the EARLIER items whose output it needs (e.g. item 2 needing\n' +
'  items 0 and 1 -> "deps":[0,1]). Never reference an index >= this item\'s own position; never create\n' +
'  cycles. Prefer [] so independent work runs concurrently; only list indices for genuine data needs.\n' +
'- "verify" is OPTIONAL (default false). Set it true for high-stakes deliverables (code, key analysis)\n' +
'  that should pass a QA review pass before being accepted.\n' +
'- Do NOT include comments or trailing commas. Output valid JSON parseable by JSON.parse.';

  // ---------------------------------------------------------------------------
  // Wave B/C §ADAPTIVE REPLAN — system prompt for the Boss's mid-run replan turn.
  // After workers report back (but BEFORE final synthesis) the Boss may decide the
  // plan needs adjusting. It is given the user goal + the workers' results and MUST
  // reply with strict JSON {action,newSubtasks,reason}. 'finish' => proceed to
  // synthesis as-is; 'replan' => spawn newSubtasks (same schema as decompose items)
  // under the root before synthesizing. Parsed by Orchestrator (reuse parsePlan).
  // ---------------------------------------------------------------------------
  var BOSS_REPLAN_SYSTEM =
'You are the BOSS / orchestrator of an autonomous AI company. Your workers have finished their subtasks\n' +
'and you are about to synthesize the final answer. FIRST decide whether the current results are enough to\n' +
'fully satisfy the user\'s original goal, or whether one short round of EXTRA subtasks would materially\n' +
'improve the outcome (e.g. a gap surfaced, a result needs verification, a missing piece is now obvious).\n' +
'\n' +
'Be conservative: prefer to FINISH. Only ask for more work when there is a concrete, important gap that a\n' +
'small number of focused subtasks would close. Do NOT replan for cosmetic or marginal improvements.\n' +
'\n' +
'You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.\n' +
'Schema:\n' +
'{\n' +
'  "action": "finish" | "replan",\n' +
'  "newSubtasks": [\n' +
'    { "role": "<one of: engineer|designer|researcher|writer|qa>",\n' +
'      "title": "<=6 word label",\n' +
'      "instruction": "<full self-contained instruction; the worker cannot see anything but this>",\n' +
'      "needsWeb": <true|false>,\n' +
'      "deps": [<0-based indices among THESE newSubtasks only; [] if independent>],\n' +
'      "verify": <optional true|false>\n' +
'    }\n' +
'  ],\n' +
'  "reason": "<one short sentence explaining the decision>"\n' +
'}\n' +
'\n' +
'Rules:\n' +
'- If action is "finish", "newSubtasks" MUST be an empty array [].\n' +
'- If action is "replan", include 1-3 newSubtasks, each complete on its own. "deps" indices refer ONLY to\n' +
'  other items in this newSubtasks array (0-based), never to the earlier plan; never create cycles.\n' +
'- Use only the listed role keys. No comments, no trailing commas. Output valid JSON for JSON.parse.';

  // ---------------------------------------------------------------------------
  // Wave B/C §GROUP DEBATE — critique prompt. One bounded round: an agent reviews
  // the COMBINED peer results and returns concise, actionable improvement notes
  // that the Boss folds into the synthesis content. Not a rewrite, not a verdict —
  // just the few highest-leverage notes. Kept short so it stays cheap + bounded.
  // ---------------------------------------------------------------------------
  var DEBATE_SYSTEM =
'You are a sharp peer reviewer inside an autonomous AI company. You are shown the COMBINED results your\n' +
'colleagues produced for the user\'s goal. Critique them as a group: find gaps, contradictions, weak spots,\n' +
'and missed opportunities that would make the final synthesized answer stronger.\n' +
'\n' +
'Output ONLY a short list of concrete, actionable improvement notes (no preamble, no praise, no rewrite of\n' +
'the work). Each note: one line, specific, and phrased so the Boss can act on it during synthesis. If the\n' +
'results are already solid, say so in one line and list at most the single most useful refinement.\n' +
'Keep it to at most 5 notes. Do not add headings or markdown beyond simple "- " bullets.';

  // ---------------------------------------------------------------------------
  // v5 §PROJECT BUILD MODE — three prompts for the file-oriented pipeline that
  // turns a goal into a coherent, runnable MULTI-FILE project living in the
  // shared workspace (App.Workspace / App.state.files). These are consumed by
  // App.Orchestrator.runBuild. The DECOMPOSE prompt asks the Boss for a strict
  // JSON file MANIFEST; the WORKER preamble forces each worker to emit complete
  // files as fenced ```file:<path>``` blocks; the INTEGRATOR prompt does one
  // coherence pass over the whole tree, emitting only the files that changed.
  // ---------------------------------------------------------------------------

  // v5 §BUILD_DECOMPOSE_SYSTEM — Boss turn A (project-build mode). Reply STRICT
  // JSON { "files":[ {path,purpose,role,deps[]} ], "summary" }. No prose, no fences.
  var BUILD_DECOMPOSE_SYSTEM =
'You are the BOSS / architect of an autonomous AI software company in PROJECT BUILD mode.\n' +
'The user gives you ONE goal (e.g. "build a todo web app"). Plan a COMPLETE, COHERENT, RUNNABLE\n' +
'multi-file project that your worker agents will write into a shared file workspace.\n' +
'\n' +
'Available worker roles (use the exact key string) — pick the best fit per file:\n' +
'- "engineer"  : code/logic files (.js, .py, .json, build/config).\n' +
'- "designer"  : markup/style files (.html, .css) and visual structure.\n' +
'- "researcher": files that need gathered/synthesized external facts.\n' +
'- "writer"    : prose files (README.md, docs, copy).\n' +
'- "generalist": anything that does not clearly fit the above.\n' +
'\n' +
'Plan rules:\n' +
'- For a WEB project: include an "index.html" ENTRY point plus the css/js it needs, and a "README.md".\n' +
'- Keep the file count SENSIBLE: 3 to 8 files. Do not over-split.\n' +
'- Use real relative paths with "/" for folders (e.g. "index.html", "css/style.css", "js/app.js",\n' +
'  "README.md"). No leading "/" or "./"; no "..".\n' +
'- Set "deps" so each file lists the OTHER files it relies on by path (e.g. js/app.js depends on\n' +
'  index.html if it targets specific DOM ids; index.html depends on the css/js it references). Files\n' +
'  with no deps are written FIRST and in PARALLEL; dependent files are written AFTER their deps so the\n' +
'  worker can read them and stay consistent. Never create cycles.\n' +
'\n' +
'You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.\n' +
'Schema:\n' +
'{\n' +
'  "files": [\n' +
'    { "path": "index.html",\n' +
'      "purpose": "<one short sentence: what this file is and what it must contain>",\n' +
'      "role": "<one of the role keys above>",\n' +
'      "deps": [<paths of OTHER files in this manifest this file relies on; [] if none>] }\n' +
'  ],\n' +
'  "summary": "<2-3 sentences describing the overall project so each worker shares the same mental model>"\n' +
'}\n' +
'\n' +
'- "deps" entries MUST be exact paths that also appear as some other item\'s "path". Drop bad refs.\n' +
'- Do NOT include comments or trailing commas. Output valid JSON parseable by JSON.parse.';

  // v5 §BUILD_WORKER_PREAMBLE — prepended to a build worker's instruction. Forces
  // file-block output. The role BODY (expertise) is still used as the system prompt;
  // this preamble REPLACES the chat/RESULT framing for build tasks.
  var BUILD_WORKER_PREAMBLE =
'You are a worker agent on a software team, building ONE coherent multi-file project in a shared workspace.\n' +
'You are assigned one or more files to WRITE. You are given: the project summary, the manifest entry for\n' +
'each of your files (path + purpose), and the FULL CURRENT CONTENT of the files yours depend on.\n' +
'\n' +
'Rules:\n' +
'- Write EACH assigned file FULLY and runnably — the complete file contents, not a snippet or outline.\n' +
'- Be CONSISTENT with the provided dependency files: match exact element ids/classes, file names,\n' +
'  function/variable names, data shapes and relative paths so the project actually works together.\n' +
'- Use real relative paths exactly as assigned. For web, reference sibling files by their given paths.\n' +
'- Do not invent extra files you were not assigned. Do not add external dependencies unless unavoidable.\n' +
'\n' +
'OUTPUT FORMAT (STRICT): output ONLY fenced blocks, one per file, whose info-string is "file:" + the\n' +
'exact path, with the COMPLETE file content inside. NO prose, explanation, or text outside the blocks:\n' +
'```file:index.html\n' +
'<!doctype html>\n' +
'... the entire file ...\n' +
'```\n' +
'```file:css/style.css\n' +
'... the entire file ...\n' +
'```\n' +
'Emit one block per assigned file and nothing else.';

  // v5 §BUILD_INTEGRATOR_SYSTEM — one coherence pass over the whole tree. Output
  // ONLY the files that need changes as ```file:<path>``` blocks, or the literal
  // token OK if nothing needs changing.
  var BUILD_INTEGRATOR_SYSTEM =
'You are the integration reviewer for an autonomous AI software company. You are given the ENTIRE current\n' +
'project file tree (each file: its path then its full content). Your job is a single COHERENCE pass:\n' +
'find and fix cross-file mismatches that would break the project, such as:\n' +
'- references to files/paths that do not exist or are misspelled,\n' +
'- DOM ids/classes used in JS that the HTML does not define (or vice versa),\n' +
'- undefined symbols, mismatched function/variable names across files,\n' +
'- stylesheet/script tags pointing at the wrong path.\n' +
'\n' +
'Make the MINIMAL changes needed for the project to be coherent and runnable. Do NOT redesign, rename for\n' +
'taste, or add features. Preserve each file\'s intent.\n' +
'\n' +
'OUTPUT FORMAT (STRICT): If NO changes are needed, reply with EXACTLY the single token:\n' +
'OK\n' +
'Otherwise output ONLY the files you changed, each as a fenced block whose info-string is "file:" + the\n' +
'exact path, containing the COMPLETE updated file content. NO prose outside the blocks. Do not emit files\n' +
'you did not change.';

  // ---------------------------------------------------------------------------
  // WAVE 1 §RUBRIC QA — LLM-judge system prompt. The judge scores ONE deliverable
  // against a concrete analytic rubric and returns STRICT JSON so the Orchestrator
  // can parse pass/fail + a focused fix hint. Reference-anchored, concrete criteria
  // keep judge bias low; it falls back to the legacy PASS/FAIL path on parse error.
  // ---------------------------------------------------------------------------
  var QA_RUBRIC_SYSTEM =
'You are a rigorous QA judge inside an autonomous AI company. You are given ONE worker deliverable and the\n' +
'task it was meant to satisfy. Score it against the analytic rubric below — judge ONLY what is in front of\n' +
'you, against the stated task, not against an imagined ideal.\n' +
'\n' +
'RUBRIC (score each criterion independently):\n' +
'1. requirement-coverage : Does the deliverable address every explicit requirement of the task? A criterion\n' +
'   FAILS only if a REQUIRED piece is missing or wrong — not for optional polish.\n' +
'2. correctness          : Is the content factually/logically correct and internally consistent? No bugs,\n' +
'   no contradictions, no fabricated specifics.\n' +
'3. runs-without-error   : If it is code or a runnable artifact, would it run/parse as given (no obvious\n' +
'   syntax errors, undefined refs, broken structure)? For non-code, treat as "is it well-formed and usable".\n' +
'4. completeness         : Is it a finished, self-contained deliverable (not an outline, stub, or promise)?\n' +
'\n' +
'Be pragmatic and reference-anchored: quote the offending part when you fail a criterion. A deliverable\n' +
'that is correct and complete PASSES even if it could be marginally nicer. Only fail for real, fixable defects.\n' +
'\n' +
'You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.\n' +
'Schema:\n' +
'{\n' +
'  "scores": [\n' +
'    { "criterion": "requirement-coverage", "pass": <true|false>, "note": "<one short, specific line>" },\n' +
'    { "criterion": "correctness",          "pass": <true|false>, "note": "<one short, specific line>" },\n' +
'    { "criterion": "runs-without-error",   "pass": <true|false>, "note": "<one short, specific line>" },\n' +
'    { "criterion": "completeness",         "pass": <true|false>, "note": "<one short, specific line>" }\n' +
'  ],\n' +
'  "pass": <true|false>,\n' +
'  "fixFocus": "<if pass=false: the single most important, actionable thing to fix in one revision; else \\"\\">"\n' +
'}\n' +
'\n' +
'Rules:\n' +
'- "pass" (top level) is true ONLY when every criterion passes; otherwise false.\n' +
'- When pass=false, "fixFocus" MUST be a concrete, actionable instruction the worker can act on in ONE\n' +
'  revision (quote the offending part, name the missing piece, give the exact fix). When pass=true it is "".\n' +
'- Do NOT include comments or trailing commas. Output valid JSON parseable by JSON.parse.';

  // ---------------------------------------------------------------------------
  // WAVE 1 §TASK LEDGER — reflection prompt. Given the goal + recent results, the
  // Boss updates a small task ledger (facts learned, current plan, progress flag)
  // so the run carries forward grounded state. Returns STRICT JSON. Parsed by the
  // Orchestrator (App.state._ledger); a stuck progress nudges a re-plan.
  // ---------------------------------------------------------------------------
  var LEDGER_REFLECT_SYSTEM =
'You are the BOSS / orchestrator of an autonomous AI company, keeping a concise TASK LEDGER for the current\n' +
'run. You are given the user goal and the most recent worker results (and possibly the prior ledger). Reflect\n' +
'and update the ledger so the team shares grounded, current state. Be terse and concrete — this is working\n' +
'memory, not a report.\n' +
'\n' +
'You MUST reply with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown, no code fences.\n' +
'Schema:\n' +
'{\n' +
'  "facts": [<short concrete facts learned so far, most decision-relevant first; <= 6 items>],\n' +
'  "plan":  [<short next-step plan items toward the goal; <= 6 items>],\n' +
'  "progress": "working" | "stuck" | "done"\n' +
'}\n' +
'\n' +
'Rules:\n' +
'- "facts" capture what is now KNOWN (results, constraints, decisions) — not speculation. Keep each one line.\n' +
'- "plan" is the remaining path to satisfy the goal. If nothing remains, use [] and set progress "done".\n' +
'- "progress": "done" when the goal is fully met by the results so far; "stuck" when results reveal a blocker\n' +
'  or repeated failure that needs a different approach (this will trigger a re-plan); else "working".\n' +
'- Keep arrays small and high-signal. No comments, no trailing commas. Output valid JSON for JSON.parse.';

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
      synthSystem: BOSS_SYNTH_SYSTEM,
      persona: PERSONAS.boss
    },
    engineer: {
      label: 'Engineer', color: roleColor.engineer, model: 'claude-sonnet-4-6', glyph: 'wrench',
      webSearchPreferred: false, system: worker(ENGINEER_BODY), persona: PERSONAS.engineer
    },
    designer: {
      label: 'Designer', color: roleColor.designer, model: 'claude-sonnet-4-6', glyph: 'palette',
      webSearchPreferred: false, system: worker(DESIGNER_BODY), persona: PERSONAS.designer
    },
    researcher: {
      label: 'Researcher', color: roleColor.researcher, model: 'claude-sonnet-4-6', glyph: 'magnifier',
      webSearchPreferred: true, system: worker(RESEARCHER_BODY), persona: PERSONAS.researcher
    },
    writer: {
      label: 'Writer', color: roleColor.writer, model: 'claude-sonnet-4-6', glyph: 'pen',
      webSearchPreferred: false, system: worker(WRITER_BODY), persona: PERSONAS.writer
    },
    qa: {
      label: 'QA', color: roleColor.qa, model: 'claude-haiku-4-5-20251001', glyph: 'check',
      webSearchPreferred: false, system: worker(QA_BODY), persona: PERSONAS.qa
    },
    generalist: {
      label: 'Generalist', color: roleColor.generalist, model: 'claude-sonnet-4-6', glyph: 'star',
      webSearchPreferred: false, system: worker(GENERALIST_BODY), persona: PERSONAS.generalist
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
    MAX_CONCURRENT: 3,   // v3: raised from 2 to allow parallel waves of worker subtasks
    CULL_TEMP_AGENTS: true,
    TEMP_AGENT_TTL_MS: 60000,
    DIRECT_CHAT_BLOCKS: false,
    DELEGATE_STAGGER_MS: 1200,   // v2: slower stagger between delegations

    // v3: QA review loop — how many times a failing verify-task may be revised.
    QA_MAX_RETRIES: 2,

    // v3: agent memory scoring (Agents.scoreMemories).
    MEMORY_TOPK: 3,          // how many memories to surface per query
    MEMORY_HALFLIFE_H: 24,   // recency half-life in hours for the decay term
    MEMORY_CAP: 50,          // max memories retained per agent (single source of truth)

    // v3: artifact store cap (oldest dropped past this).
    ARTIFACT_MAX: 200,

    // WAVE 3: structured run-event trace cap (App.state.trace; newest kept).
    // Drives the metrics dashboard timeline + replay scrubber. Store persists
    // App.state.trace capped to this many newest events; oldest dropped past it.
    TRACE_CAP: 600,

    // v3: watercooler chatter cooldown (ms between idle banter events).
    CHATTER_COOLDOWN_MS: 25000,

    // ---------------------------------------------------------------------------
    // WAVE 4a section GAMIFICATION — XP / level / credits economy.
    //   XP_PER_TASK     : XP granted per successfully completed (esp. QA-passed)
    //                     task. Orchestrator.finishTask -> Agents.grantXp(agent, n).
    //   CREDITS_PER_TASK: credits added to the shared App.state.credits pool per
    //                     completed task (spendable in the Office shop).
    //   XP_MAX          : sane clamp on per-agent cumulative XP.
    //   LEVEL_CURVE     : level = 1 + floor(sqrt(xp / LEVEL_XP_BASE)) — gentle
    //                     square-root curve so early levels come quick and later
    //                     ones slow down. LEVEL_MAX clamps the displayed level.
    //   App.config.levelForXp(xp) mirrors the curve so every module agrees.
    // ---------------------------------------------------------------------------
    XP_PER_TASK: 25,
    CREDITS_PER_TASK: 10,
    XP_MAX: 1000000,
    LEVEL_XP_BASE: 100,   // XP needed (×n^2) to reach successive levels
    LEVEL_MAX: 99,
    // credits default 0 (the live value lives on App.state.credits; this is the
    // documented starting balance for fresh/migrated saves — Store seeds it).
    CREDITS_DEFAULT: 0,

    // API
    API_URL: 'https://api.anthropic.com/v1/messages',
    OPENAI_URL: 'https://api.openai.com/v1/chat/completions',   // v2: OpenAI chat-completions endpoint
    // v2: local subscription proxy (companion.py). The companion is OPT-IN and OFF
    // by default (store defaultSettings().useCompanion === false), so a fresh or
    // migrated company talks to the cloud API directly and never depends on a local
    // server. The user explicitly enables it via the Settings companion toggle.
    COMPANION_URL: 'http://localhost:8787/v1/messages',
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

    // boss orchestration prompts (section 6.3). BOSS_SYNTH_SYSTEM is read by
    // Orchestrator.synthesize (CFG().BOSS_SYNTH_SYSTEM). The decompose prompt
    // is the canonical ROLES.boss.system; exposed here too for symmetry.
    BOSS_DECOMPOSE_SYSTEM: BOSS_DECOMPOSE_SYSTEM,
    BOSS_SYNTH_SYSTEM: BOSS_SYNTH_SYSTEM,

    // ---------------------------------------------------------------------------
    // v5 section PROJECT BUILD MODE — file-oriented pipeline prompts + caps. Consumed by
    // App.Orchestrator.runBuild + App.Workspace. BUILD_DECOMPOSE_SYSTEM -> Boss
    // file manifest (strict JSON); BUILD_WORKER_PREAMBLE -> per-file worker output
    // as ```file:<path>``` blocks; BUILD_INTEGRATOR_SYSTEM -> one coherence pass.
    // MAX_PROJECT_FILES caps the shared workspace (Workspace.write enforces).
    // ---------------------------------------------------------------------------
    BUILD_DECOMPOSE_SYSTEM: BUILD_DECOMPOSE_SYSTEM,
    BUILD_WORKER_PREAMBLE: BUILD_WORKER_PREAMBLE,
    BUILD_INTEGRATOR_SYSTEM: BUILD_INTEGRATOR_SYSTEM,
    MAX_PROJECT_FILES: 200,

    // ---------------------------------------------------------------------------
    // Wave B/C orchestration toggles + prompts.
    //   ENABLE_REPLAN     : Boss may run ONE adaptive replan round before synthesis.
    //   MAX_REPLAN_ROUNDS : hard cap on replan rounds per root (root._replanned gate).
    //   ENABLE_DEBATE     : run ONE bounded peer-critique round before synthesis.
    //   ENABLE_APPROVAL   : human-approval gate (default OFF so normal runs are
    //                       unaffected; Orchestrator only gates when this is true).
    // All are creds-guarded + defensive in the Orchestrator; absent creds => skip.
    // ---------------------------------------------------------------------------
    ENABLE_REPLAN: true,
    MAX_REPLAN_ROUNDS: 1,
    BOSS_REPLAN_SYSTEM: BOSS_REPLAN_SYSTEM,
    ENABLE_DEBATE: true,
    DEBATE_SYSTEM: DEBATE_SYSTEM,
    ENABLE_APPROVAL: false,

    // ---------------------------------------------------------------------------
    // Wave B/C section BROWSER TOOLS — master toggle read by App.Tools.enabled(). When
    // true (and settings allow + provider supports it), the Orchestrator exposes
    // App.Tools.specs() to tool-capable workers. Tool implementations live in
    // tools.js; this is only the on/off switch.
    // ---------------------------------------------------------------------------
    TOOLS_ENABLED: true,    // v6: Anthropic tool_use round-trip is now fully wired in api.js
                            // (toolUses/stopReason surfaced through the SSE accumulator), so the
                            // browser tools (calc/run_js/analyze_data + workspace/file/web tools)
                            // are exposed to tool-capable workers by default.
    // v6: optional CORS proxy URL for web_fetch (empty default = disabled). NOTE: the UI binds the
    // user-facing value to settings.corsProxy (persisted); tools read settings.corsProxy first and
    // fall back to this config default. Keep '' so nothing fetches cross-origin unless configured.
    CORS_PROXY: '',
    // Default UI language. Korean is now the default (store defaults settings.lang
    // to this, and i18n.getLang() falls back to it when settings.lang is unset).
    DEFAULT_LANG: 'ko',

    // ---------------------------------------------------------------------------
    // SHARE — hash fragment key for shareable state links. App.Share.exportLink
    // builds location + '#' + SHARE_HASH_KEY + '=' + urlSafeBase64(gzip(state));
    // App.Share.importFromHash checks location.hash for this same '#<key>=' prefix.
    // Single source of truth so the two halves never drift. NOTE: directory handles
    // (App.state._dirHandle) are NOT serializable and are NEVER part of share/save.
    // ---------------------------------------------------------------------------
    SHARE_HASH_KEY: 's',

    // ---------------------------------------------------------------------------
    // WAVE 2 section IMAGE GEN + RECURSIVE SUBTASKS — keyless Pollinations image endpoint
    // (tools.generate_image prepends this and appends the encoded prompt) and the
    // recursion bounds for App.Orchestrator.spawnSubtask / tools.spawn_subtask.
    //   SUBTASK_MAX_DEPTH      : how deep recursive subtasks may nest (1 = a worker
    //                            may spawn sub-workers, but those sub-workers may NOT
    //                            spawn further). Hard cap against infinite recursion.
    //   SUBTASK_MAX_CONCURRENT : global cap on simultaneously-running subtasks; on
    //                            exhaustion spawnSubtask resolves with an error string.
    // ---------------------------------------------------------------------------
    POLLINATIONS_URL: 'https://image.pollinations.ai/prompt/',
    SUBTASK_MAX_DEPTH: 1,
    SUBTASK_MAX_CONCURRENT: 3,

    // ---------------------------------------------------------------------------
    // Wave B/C section MOOD & RELATIONSHIPS — defaults for agent.mood (0..1) and the
    // affinity model (agent.relationships[otherId] in roughly -1..1, 0 = neutral).
    //   MOOD_DEFAULT      : starting/neutral mood for a new agent.
    //   MOOD_MIN/MAX      : clamp range for mood.
    //   AFFINITY_DEFAULT  : starting affinity toward an unknown colleague.
    //   AFFINITY_MIN/MAX  : clamp range for affinity.
    //   AFFINITY_NUDGE    : per-collaboration affinity increment (kept subtle).
    //   MOOD_COLLAB_GAIN  : mood lift from a successful collaboration/synthesis.
    //   MOOD_FAIL_DROP    : mood dip on an error/failed verify (subtle).
    //   MOOD_DECAY        : per-? drift back toward MOOD_DEFAULT (callers apply).
    // ---------------------------------------------------------------------------
    MOOD_DEFAULT: 0.7,
    MOOD_MIN: 0.0,
    MOOD_MAX: 1.0,
    AFFINITY_DEFAULT: 0.0,
    AFFINITY_MIN: -1.0,
    AFFINITY_MAX: 1.0,
    AFFINITY_NUDGE: 0.08,
    MOOD_COLLAB_GAIN: 0.06,
    MOOD_FAIL_DROP: 0.10,
    MOOD_DECAY: 0.01,

    // ---------------------------------------------------------------------------
    // Wave B/C section AMBIANCE — day/night tint overlay drawn in PixelArt.drawFX, keyed
    // by the hour of day. AMBIANCE_ENABLED gates it. AMBIANCE_TINTS maps a coarse
    // phase -> {color, alpha} (alpha is the overlay opacity, kept low). Phase is
    // chosen from the hour: night/dawn/day/dusk. Pure rendering; no state writes.
    // ---------------------------------------------------------------------------
    AMBIANCE_ENABLED: true,
    AMBIANCE_TINTS: {
      night: { color: '#0a1440', alpha: 0.30 },   // 21:00–05:00 deep blue
      dawn:  { color: '#ff8a5c', alpha: 0.14 },   // 05:00–08:00 warm sunrise
      day:   { color: '#ffffff', alpha: 0.00 },   // 08:00–17:00 neutral (no tint)
      dusk:  { color: '#9b5cff', alpha: 0.16 }    // 17:00–21:00 violet sunset
    },
    // phaseForHour(h) -> ambiance phase key. Pure helper for renderers.
    phaseForHour: function (h) {
      h = ((Number(h) % 24) + 24) % 24;
      if (h >= 5 && h < 8) return 'dawn';
      if (h >= 8 && h < 17) return 'day';
      if (h >= 17 && h < 21) return 'dusk';
      return 'night';
    },

    // ---------------------------------------------------------------------------
    // Wave B/C section ACTIVITY GLOW — a soft halo PixelArt draws around an agent that
    // produced output recently (agent._lastActivityTs). GLOW_ACTIVE_MS: how long
    // after the last activity the glow stays at full strength before fading out
    // over GLOW_FADE_MS. GLOW_RADIUS: halo radius in world px; GLOW_MAX_ALPHA: peak
    // opacity. Color falls back to the agent's role color. Pure rendering.
    // ---------------------------------------------------------------------------
    GLOW_ACTIVE_MS: 2500,
    GLOW_FADE_MS: 2500,
    GLOW_RADIUS: 14,
    GLOW_MAX_ALPHA: 0.45,

    // v3: worker artifact-emission hint (Orchestrator appends to worker instructions)
    // and the QA reviewer system prompt (Orchestrator QA loop).
    WORKER_ARTIFACT_HINT: WORKER_ARTIFACT_HINT,
    QA_REVIEW_SYSTEM: QA_REVIEW_SYSTEM,

    // ---------------------------------------------------------------------------
    // WAVE 1 section RELIABILITY CORE — version history, self-repair, rubric QA, ledger.
    //   FILE_HISTORY_CAP   : max prior versions kept per file (Workspace.history).
    //   ENABLE_SELF_REPAIR : master toggle for Orchestrator.runAndFix loop.
    //   REPAIR_MAX_ROUNDS  : hard cap on self-repair rounds per run (terminal).
    //   QA_RUBRIC_SYSTEM   : LLM-judge prompt -> STRICT JSON {scores,pass,fixFocus}.
    //   LEDGER_REFLECT_SYSTEM : ledger-update prompt -> STRICT JSON {facts,plan,progress}.
    // All consumed by orchestrator.js / workspace.js; defensive everywhere.
    // ---------------------------------------------------------------------------
    FILE_HISTORY_CAP: 20,
    ENABLE_SELF_REPAIR: true,
    REPAIR_MAX_ROUNDS: 3,
    QA_RUBRIC_SYSTEM: QA_RUBRIC_SYSTEM,
    LEDGER_REFLECT_SYSTEM: LEDGER_REFLECT_SYSTEM,

    // v3: watercooler banter pools. Orchestrator picks role-flavored lines (falls
    // back to generic). Short, office-y, non-blocking; used when liveChatter=false.
    CHATTER_LINES: {
      generic: [
        'Anyone else running on pure coffee today?',
        'Did you see the new ticket queue? Wild.',
        'I swear the office plant is judging me.',
        'Two more tasks and I\'m taking a lap.',
        'The neon sign flickered again — spooky.',
        'How was your weekend? Mine was all side projects.',
        'Standup felt shorter today, right?',
        'Whoever fixed the printer: legend.'
      ],
      byRole: {
        engineer: [
          'Just refactored that mess — feels good.',
          'It compiles. I\'m not touching it again.',
          'Naming things is still the hardest problem.',
          'I added one more test. Future me says thanks.'
        ],
        designer: [
          'Bumped the spacing 4px and it finally breathes.',
          'That magenta is doing a lot of heavy lifting.',
          'Contrast ratio passes now — chef\'s kiss.',
          'Can we please retire that drop shadow?'
        ],
        researcher: [
          'Found three sources that actually agree. Rare.',
          'The data\'s noisier than the lounge at lunch.',
          'Citation hunting is my cardio.',
          'Turns out the obvious answer was wrong again.'
        ],
        writer: [
          'Cut 200 words and it reads twice as well.',
          'Killed another adverb. They had it coming.',
          'A good headline took me longer than the draft.',
          'Tone check: do we sound human enough?'
        ],
        qa: [
          'Found an edge case nobody asked about. You\'re welcome.',
          'It works on my machine is not a test plan.',
          'I love a clean PASS. So peaceful.',
          'Reproduced it in three steps. Buckle up.'
        ],
        boss: [
          'Great momentum today, team.',
          'Let\'s keep the scope tight on this one.',
          'Ship it once QA\'s happy.',
          'Who needs anything unblocked?'
        ]
      }
    },

    // persistence
    STORAGE_KEY: 'pixel_ai_company_v1',
    SCHEMA_VERSION: 5,   // v3: artifacts/persona/memories/settings; v5: +files workspace + settings.github; WAVE1: +files[].history + ledger

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

    // role -> default neon color & state -> badge color (mirror palette; section 5)
    roleColor: roleColor,
    stateColor: stateColor,

    // FX toggles
    fx: { scanlines: true, bloom: true, vignette: true }
  };

  // ---------------------------------------------------------------------------
  // WAVE A section PRESETS — starter company rosters (App.config.PRESETS).
  // Preset = { id, name, desc, icon(emoji), agents:[{name, role, model?, color?,
  //   systemPrompt?}], sampleGoals:[String] }. role must be an existing ROLES key.
  // Presets mainly define the roster + sample goals; Store.applyPreset consumes them.
  // ---------------------------------------------------------------------------
  App.config.PRESETS = [
    {
      id: 'opinion-warehouse',
      name: '의견 수립 창고',
      desc: '반 친구들의 의견을 수집·분류·요약해 리포트로 정리하는 팀.',
      icon: '🗳️',
      agents: [
        // facilitator — runs the discussion as the orchestrator (boss).
        { name: '진행자', role: 'boss' },
        // researcher — gathers context/background for the topic.
        { name: '조사원', role: 'researcher' },
        // analyst — classifies + structures the collected opinions (qa role = critical/structured).
        { name: '분석가', role: 'qa' },
        // writer — turns the analysis into a clean summary report.
        { name: '작성자', role: 'writer' }
      ],
      sampleGoals: [
        '반 친구들의 [수학여행 장소]에 대한 의견을 수집·분류해서 요약 리포트로 정리해줘',
        '학급 회의 안건 [체육대회 종목]에 대한 찬반 의견을 모아 입장별로 정리해줘',
        '[축제 부스 아이디어]에 대한 친구들의 제안을 주제별로 묶어 요약해줘'
      ]
    },
    {
      id: 'blog-team',
      name: 'Blog Team',
      desc: 'A writer, a researcher, and an editor that ship polished posts.',
      icon: '✍️',
      agents: [
        { name: 'Boss', role: 'boss' },
        { name: 'Scribe', role: 'writer' },
        { name: 'Scout', role: 'researcher' },
        { name: 'Editor', role: 'qa' }
      ],
      sampleGoals: [
        'Write a 600-word blog post explaining what vector databases are, for a general dev audience.',
        'Draft an SEO-friendly intro + outline for a post on "remote team rituals".',
        'Turn these bullet notes into a polished, scannable blog article.'
      ]
    },
    {
      id: 'research-team',
      name: 'Research Team',
      desc: 'Two researchers, an analyst, and a writer for deep dives.',
      icon: '🔬',
      agents: [
        { name: 'Boss', role: 'boss' },
        { name: 'Researcher A', role: 'researcher' },
        { name: 'Researcher B', role: 'researcher' },
        { name: 'Analyst', role: 'qa' },
        { name: 'Writer', role: 'writer' }
      ],
      sampleGoals: [
        'Research the current state of small open-weight LLMs and summarize the top 3 with tradeoffs.',
        'Compare three note-taking apps for students and recommend one with reasoning.',
        'Gather recent findings on sleep and academic performance, then write a brief.'
      ]
    }
  ];

  // ---------------------------------------------------------------------------
  // WAVE A section PRICES — approximate public USD prices per 1M tokens for the cost
  // meter. APPROXIMATE / EDITABLE — update as provider pricing changes. Every
  // model in MODELS has an entry. priceFor() falls back to {in:0,out:0}.
  // ---------------------------------------------------------------------------
  App.config.PRICES = {
    // Anthropic (approximate, USD / 1M tokens)
    'claude-opus-4-8':           { in: 5.00,  out: 25.00 },
    'claude-sonnet-4-6':         { in: 3.00,  out: 15.00 },
    'claude-haiku-4-5-20251001': { in: 1.00,  out: 5.00  },
    // OpenAI (approximate, USD / 1M tokens)
    'gpt-4o':                    { in: 2.50,  out: 10.00 },
    'gpt-4o-mini':               { in: 0.15,  out: 0.60  },
    'gpt-4.1':                   { in: 2.00,  out: 8.00  }
  };

  // ---------------------------------------------------------------------------
  // WAVE 4a section LEVEL CURVE — single source of truth for XP -> level. Mirrored by
  // Agents.grantXp + the UI badges + pixelart so the level shown everywhere
  // agrees. level = 1 + floor(sqrt(xp / LEVEL_XP_BASE)), clamped to [1, LEVEL_MAX].
  // ---------------------------------------------------------------------------
  App.config.levelForXp = function (xp) {
    var base = (typeof App.config.LEVEL_XP_BASE === 'number' && App.config.LEVEL_XP_BASE > 0)
      ? App.config.LEVEL_XP_BASE : 100;
    var max = (typeof App.config.LEVEL_MAX === 'number') ? App.config.LEVEL_MAX : 99;
    var n = Number(xp);
    if (!isFinite(n) || n < 0) n = 0;
    var lvl = 1 + Math.floor(Math.sqrt(n / base));
    if (lvl < 1) lvl = 1;
    if (lvl > max) lvl = max;
    return lvl;
  };

  // priceFor(modelId) -> {in, out} USD per 1M tokens (fallback {in:0,out:0}).
  App.config.priceFor = function (modelId) {
    var p = App.config.PRICES && App.config.PRICES[modelId];
    if (p && typeof p === 'object') {
      return { in: (typeof p.in === 'number') ? p.in : 0, out: (typeof p.out === 'number') ? p.out : 0 };
    }
    return { in: 0, out: 0 };
  };

  // ---------------------------------------------------------------------------
  // WAVE 4a section OFFICE_UPGRADES — catalog the Office shop (ui.js) lists and the
  // World.applyUpgrade installer consumes. Each entry:
  //   { id, name, cost, desc, kind:'furniture'|'flair', spec }
  // For kind:'furniture' the spec is { type, count?, lounge?, dir? } describing
  // decorative pieces to push onto layout.furniture (World places them on valid
  // walkable spots without breaking connectivity; placement is best-effort and
  // SKIPS if no room). For kind:'flair' the spec is { flag, value } — a boolean
  // (or value) set on App.state.layout.flair[flag] that renderers may read.
  // applyUpgrade is idempotent (guarded by App.state.upgrades), so each id
  // installs at most once. credits default 0 (CREDITS_DEFAULT).
  // ---------------------------------------------------------------------------
  App.config.OFFICE_UPGRADES = [
    {
      id: 'green_thumb',
      name: 'Green Thumb',
      cost: 40,
      desc: 'Scatter a few extra potted plants around the office for some life.',
      kind: 'furniture',
      spec: { type: 'plant', count: 4 }
    },
    {
      id: 'neon_district',
      name: 'Neon District',
      cost: 80,
      desc: 'Mount extra neon signs on the walls — pure cyberpunk ambiance.',
      kind: 'furniture',
      spec: { type: 'neonSign', count: 3 }
    },
    {
      id: 'server_wall',
      name: 'Bigger Server Wall',
      cost: 120,
      desc: 'Expand the datacenter with a wall of humming server racks.',
      kind: 'furniture',
      spec: { type: 'server', count: 5 }
    },
    {
      id: 'brainstorm_boards',
      name: 'Brainstorm Boards',
      cost: 100,
      desc: 'Add whiteboards so the team can sketch out ideas anywhere.',
      kind: 'furniture',
      spec: { type: 'whiteboard', count: 2 }
    },
    {
      id: 'lounge_upgrade',
      name: 'Cozy Lounge',
      cost: 90,
      desc: 'A second coffee machine and lounge chairs for the break room.',
      kind: 'furniture',
      spec: { type: 'coffee', count: 1, lounge: true, extras: [ { type: 'chair', count: 3, lounge: true } ] }
    },
    {
      id: 'gold_carpet',
      name: 'Executive Carpet',
      cost: 150,
      desc: 'Lay a premium glowing carpet — a subtle flex on visitors.',
      kind: 'flair',
      spec: { flag: 'goldCarpet', value: true }
    },
    {
      id: 'party_mode',
      name: 'Party Lights',
      cost: 200,
      desc: 'Disco-grade neon lighting flair for the whole floor.',
      kind: 'flair',
      spec: { flag: 'partyMode', value: true }
    }
  ];

  // upgradeById(id) -> the OFFICE_UPGRADES entry or null. Convenience for World/UI.
  App.config.upgradeById = function (id) {
    var arr = App.config.OFFICE_UPGRADES || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === id) return arr[i];
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // section 2 App.util — small, pure helpers. Date.now()/Math.random() live ONLY inside
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
