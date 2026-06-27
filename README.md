# NEON//WORKS — Pixel AI Company

A neon-cyberpunk **pixel-art office** where every character is a real AI agent. Give the **Boss** a goal and it decomposes the work, delegates to role workers (engineer, designer, researcher…), they each do real work via the Claude / OpenAI API, and the Boss synthesizes a final answer — all visualized in a top-down office you can watch.

**Single self-contained `index.html`** — no build, no dependencies. Double-click to run (`file://`) or host anywhere static.

## Use it

1. Open `index.html` (or the GitHub Pages URL).
2. **⚙ Settings** → paste your **Anthropic API key** and/or **OpenAI API key** (stored only in your browser's localStorage; sent only to the provider).
3. Type a goal in the top bar → **DISPATCH**. The Boss plans and delegates.

> Keys are pay-as-you-go API keys (from `console.anthropic.com` / `platform.openai.com`), **not** Claude.ai / ChatGPT subscriptions. A local companion server for subscription use is optional (see `companion/`).

## Features

- **Orchestrator + workers** — Boss decomposes a goal into role-tagged subtasks, delegates, then synthesizes.
- **Multi-provider** — mix Claude (Opus/Sonnet/Haiku) and OpenAI (GPT-4o / 4o-mini / 4.1) per agent.
- **Live office** — agents pathfind to desks, "code"/"search", gather to meet, take ☕ breaks; speech bubbles + activity log.
- **Controls** — + Agent (name/role/model/color), click an agent to chat or assign, task board (kanban), layout editor, ☕ break (per-agent / everyone), web search toggle, export/import, autosave.

## Build

The deliverable `index.html` is generated from `src/*.js` + `src/shell.html` + `src/styles.css`:

```bash
bash build.sh
```

Edit the modules in `src/`, then rebuild. Load order is fixed (`config → pixelart → world → api → store → agents → orchestrator → ui → main`). `SPEC.md` is the architecture contract.

## Resilience

Transient API failures ("Failed to fetch", rate limits, overload) auto-retry with exponential backoff; concurrency is capped and staggered to stay under rate limits.
