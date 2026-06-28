// =============================================================================
// api.js  →  App.API
// Anthropic browser-direct SSE streaming for "Pixel AI Company" (NEON//WORKS).
//
// SPEC authority: SPEC.md §7.3 (App.API contract), ANTHROPIC API FACTS,
//                 §10 (error behaviors). This file is the SINGLE source of
//                 network access in the app.
//
// Contract (PINNED):
//   App.API.stream(opts) -> { abort(): void }
//   opts = {
//     apiKey, model, system, messages, tools?, maxTokens?, signal?,
//     onText(deltaText), onState(s), onDone({text,usage,raw}), onError(err)
//   }
//
// Rules followed:
//   - POST config.API_URL with the browser-direct header set.
//   - Real SSE parsing of /v1/messages (ReadableStream + TextDecoder, split '\n\n').
//   - web_search server tool support with graceful single-retry fallback when the
//     tool type is unsupported.
//   - Robust error handling: missing key, non-200 (parsed error JSON), network/abort.
//   - NEVER throws synchronously; all failures routed through onError.
//   - Does NOT read App.state; the caller passes apiKey/model. Reads App.config only.
// =============================================================================

window.App = window.App || {};

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small internal helpers (kept local; nothing leaks except App.API surface).
  // ---------------------------------------------------------------------------

  // Safe no-op so callbacks are always callable even if the caller omits some.
  function noop() {}

  // Wrap a callback so a throwing consumer can never break the stream pump.
  function safe(fn) {
    if (typeof fn !== 'function') return noop;
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (e) {
        // Swallow consumer-side exceptions; the API layer must stay alive.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[App.API] callback threw:', e);
        }
        return undefined;
      }
    };
  }

  // A handle that satisfies the {abort()} contract but does nothing.
  // Used for the synchronous no-key path so callers always get a handle back.
  function noopHandle() {
    return { abort: noop };
  }

  // Detect "the web_search tool isn't supported on this account/model" so we can
  // gracefully retry once WITHOUT tools. Conservative: only matches obvious cases.
  // SPEC §7.3: message includes 'web_search', OR status 400 + mentions 'tool'.
  function isToolUnsupportedError(err) {
    if (!err) return false;
    var msg = String(err.message || '').toLowerCase();
    var status = err.status;
    if (msg.indexOf('web_search') !== -1) return true;
    if (msg.indexOf('web search') !== -1) return true;
    if (status === 400 && msg.indexOf('tool') !== -1) return true;
    // Some servers phrase it as "not supported"/"unsupported" + tool-ish words.
    if (
      (status === 400 || status === 404) &&
      (msg.indexOf('unsupported') !== -1 || msg.indexOf('not supported') !== -1) &&
      (msg.indexOf('tool') !== -1 || msg.indexOf('search') !== -1)
    ) {
      return true;
    }
    return false;
  }

  // Try to pull a human-readable message out of an Anthropic error JSON blob.
  // Anthropic shape: { type:'error', error:{ type, message } }
  function extractApiErrorMessage(json) {
    if (!json) return '';
    if (json.error && typeof json.error === 'object') {
      if (json.error.message) return String(json.error.message);
      if (json.error.type) return String(json.error.type);
    }
    if (json.message) return String(json.message);
    return '';
  }

  // ---------------------------------------------------------------------------
  // SSE event accumulator. One instance per streaming attempt. Encapsulates all
  // mutable parse state + the Anthropic event -> callback mapping so the fetch
  // chain stays free of scoping/hoisting hazards.
  // ---------------------------------------------------------------------------
  function SSEAccumulator(callbacks) {
    this.onText = callbacks.onText;
    this.onState = callbacks.onState;
    this.onDone = callbacks.onDone;
    this.onError = callbacks.onError;

    this.buffer = '';                 // partial SSE text not yet ending in '\n\n'
    this.fullText = '';               // accumulated assistant text
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.lastMessageDelta = null;     // raw message_delta event (usage + stop_reason)
    this.firstTextSeen = false;       // emit onState('text') exactly once
    this.searchingAnnounced = false;  // emit onState('searching') at most once
    this.doneEmitted = false;         // guard onDone()/error against double-fire

    // --- Tool-use round-trip state (v6) -------------------------------------
    this.toolUses = [];               // finalized client tool_use blocks
    this.toolBlocks = {};             // index -> { id, name, jsonParts:[] }
    this.stopReason = null;           // message_delta.stop_reason
    this.assistantContent = [];       // assistant tool_use blocks (for replay)
  }

  // Emit the terminal onDone exactly once (idempotent).
  SSEAccumulator.prototype.finish = function (announceState) {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    if (announceState) this.onState('done');
    this.onDone({
      text: this.fullText,
      usage: this.usage,
      raw: this.lastMessageDelta,
      toolUses: this.toolUses,
      stopReason: this.stopReason,
      assistantContent: this.assistantContent,
    });
  };

  // Feed a decoded text chunk; processes every COMPLETE '\n\n'-delimited event.
  // When `final` is true, also processes whatever remains in the buffer as a
  // trailing event (no delimiter required).
  SSEAccumulator.prototype.feed = function (chunk, final) {
    if (chunk) this.buffer += chunk;
    var parts = this.buffer.split('\n\n');
    // Keep the last fragment buffered unless finalizing.
    this.buffer = final ? '' : parts.pop();
    for (var i = 0; i < parts.length; i++) {
      this.handleEvent(parts[i]);
      if (this.doneEmitted) return; // ignore anything after message_stop
    }
    if (final && this.buffer) {
      this.handleEvent(this.buffer);
      this.buffer = '';
    }
  };

  // Process ONE raw SSE event block. We only care about its 'data:' line(s).
  SSEAccumulator.prototype.handleEvent = function (block) {
    if (!block) return;
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5);
      if (payload.charAt(0) === ' ') payload = payload.slice(1);
      payload = payload.trim();
      if (!payload || payload === '[DONE]') continue;

      var evt;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        continue; // ignore malformed data lines
      }
      this.dispatch(evt);
      if (this.doneEmitted) return;
    }
  };

  // Map an Anthropic streaming event to callbacks.
  SSEAccumulator.prototype.dispatch = function (evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case 'message_start':
        if (evt.message && evt.message.usage) {
          if (typeof evt.message.usage.input_tokens === 'number') {
            this.usage.input_tokens = evt.message.usage.input_tokens;
          }
          if (typeof evt.message.usage.output_tokens === 'number') {
            this.usage.output_tokens = evt.message.usage.output_tokens;
          }
        }
        break;

      case 'content_block_start': {
        var cb = evt.content_block || {};
        // Server-side web_search tool activity => 'searching' state.
        if (
          cb.type === 'server_tool_use' ||
          cb.type === 'web_search_tool_result' ||
          cb.name === 'web_search'
        ) {
          if (!this.searchingAnnounced) {
            this.searchingAnnounced = true;
            this.onState('searching');
          }
        }
        // Client tool_use blocks (NOT server_tool_use — that mis-routes search).
        if (cb.type === 'tool_use') {
          this.toolBlocks[evt.index] = { id: cb.id, name: cb.name, jsonParts: [] };
        }
        break;
      }

      case 'content_block_delta': {
        var d = evt.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          if (!this.firstTextSeen) {
            this.firstTextSeen = true;
            this.onState('text'); // first visible text → flip from thinking/searching
          }
          this.fullText += d.text;
          this.onText(d.text);
        }
        // input_json_delta carries streamed tool_use input JSON fragments.
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          var tb = this.toolBlocks[evt.index];
          if (tb) tb.jsonParts.push(d.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        var fin = this.toolBlocks[evt.index];
        if (fin) {
          var input = {};
          try {
            input = JSON.parse(fin.jsonParts.join('')) || {};
          } catch (e) {
            input = { __parse_error: true, __raw: fin.jsonParts.join('') };
          }
          this.toolUses.push({ id: fin.id, name: fin.name, input: input });
          this.assistantContent.push({
            type: 'tool_use', id: fin.id, name: fin.name, input: input,
          });
          delete this.toolBlocks[evt.index];
        }
        break;
      }

      case 'message_delta':
        this.lastMessageDelta = evt;
        if (evt.delta && evt.delta.stop_reason) this.stopReason = evt.delta.stop_reason;
        if (evt.usage) {
          if (typeof evt.usage.output_tokens === 'number') {
            this.usage.output_tokens = evt.usage.output_tokens;
          }
          if (typeof evt.usage.input_tokens === 'number') {
            this.usage.input_tokens = evt.usage.input_tokens;
          }
        }
        break;

      case 'message_stop':
        this.finish(true);
        break;

      case 'error': {
        var em =
          (evt.error && (evt.error.message || evt.error.type)) || 'stream error';
        this.onError({ type: 'http', message: String(em) });
        this.doneEmitted = true; // stop processing further events
        break;
      }

      case 'ping':
      default:
        break; // ignore pings & unknown event types
    }
  };

  // ---------------------------------------------------------------------------
  // OpenAI SSE accumulator. Mirrors SSEAccumulator but parses the OpenAI
  // chat-completions stream: lines starting 'data: ', terminator 'data: [DONE]'.
  // Each chunk → choices[0].delta.content (may be null). Final usage object (when
  // stream_options.include_usage is set) → usage.{prompt_tokens,completion_tokens}.
  // ---------------------------------------------------------------------------
  function OpenAIAccumulator(callbacks) {
    this.onText = callbacks.onText;
    this.onState = callbacks.onState;
    this.onDone = callbacks.onDone;
    this.onError = callbacks.onError;

    this.buffer = '';
    this.fullText = '';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.lastChunk = null;            // raw last JSON chunk (for onDone.raw)
    this.firstTextSeen = false;       // emit onState('text') exactly once
    this.doneEmitted = false;

    // --- Tool-use round-trip state (v6; telemetry only for now) -------------
    this.toolCalls = {};              // index -> { id, name, args }
    this.toolUses = [];               // finalized { id, name, input }
    this.stopReason = null;           // mapped finish_reason
  }

  OpenAIAccumulator.prototype.finish = function (announceState) {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    // Finalize any accumulated tool_calls into {id,name,input}.
    for (var idx in this.toolCalls) {
      if (!Object.prototype.hasOwnProperty.call(this.toolCalls, idx)) continue;
      var slot = this.toolCalls[idx];
      var input = {};
      try {
        input = JSON.parse(slot.args || '{}') || {};
      } catch (e) {
        input = { __parse_error: true, __raw: slot.args || '' };
      }
      this.toolUses.push({ id: slot.id, name: slot.name, input: input });
    }
    if (announceState) this.onState('done');
    this.onDone({
      text: this.fullText,
      usage: this.usage,
      raw: this.lastChunk,
      toolUses: this.toolUses,
      stopReason: this.stopReason,
    });
  };

  OpenAIAccumulator.prototype.feed = function (chunk, final) {
    if (chunk) this.buffer += chunk;
    var parts = this.buffer.split('\n\n');
    this.buffer = final ? '' : parts.pop();
    for (var i = 0; i < parts.length; i++) {
      this.handleEvent(parts[i]);
      if (this.doneEmitted) return;
    }
    if (final && this.buffer) {
      this.handleEvent(this.buffer);
      this.buffer = '';
    }
  };

  OpenAIAccumulator.prototype.handleEvent = function (block) {
    if (!block) return;
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5);
      if (payload.charAt(0) === ' ') payload = payload.slice(1);
      payload = payload.trim();
      if (!payload) continue;
      if (payload === '[DONE]') { this.finish(true); return; }

      var evt;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        continue; // ignore malformed data lines
      }
      this.dispatch(evt);
      if (this.doneEmitted) return;
    }
  };

  OpenAIAccumulator.prototype.dispatch = function (evt) {
    if (!evt || typeof evt !== 'object') return;
    this.lastChunk = evt;

    // usage may arrive on a trailing chunk (include_usage) or alongside choices.
    if (evt.usage && typeof evt.usage === 'object') {
      if (typeof evt.usage.prompt_tokens === 'number') {
        this.usage.input_tokens = evt.usage.prompt_tokens;
      }
      if (typeof evt.usage.completion_tokens === 'number') {
        this.usage.output_tokens = evt.usage.completion_tokens;
      }
    }

    var choices = Array.isArray(evt.choices) ? evt.choices : null;
    if (choices && choices.length) {
      var delta = choices[0] && choices[0].delta;
      if (delta && typeof delta.content === 'string' && delta.content.length) {
        if (!this.firstTextSeen) {
          this.firstTextSeen = true;
          this.onState('text');
        }
        this.fullText += delta.content;
        this.onText(delta.content);
      }
      // tool_calls arrive as partials: id/name in the first delta per index,
      // argument fragments in later deltas. Accumulate per tc.index.
      if (delta && Array.isArray(delta.tool_calls)) {
        for (var j = 0; j < delta.tool_calls.length; j++) {
          var tc = delta.tool_calls[j];
          if (!tc) continue;
          var ix = tc.index || 0;
          var slot = this.toolCalls[ix] ||
            (this.toolCalls[ix] = { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function) {
            if (tc.function.name) slot.name = tc.function.name;
            if (tc.function.arguments) slot.args += tc.function.arguments;
          }
        }
      }
      var fr = choices[0] && choices[0].finish_reason;
      if (fr) this.stopReason = (fr === 'tool_calls') ? 'tool_use' : fr;
    }
  };

  // ---------------------------------------------------------------------------
  // OpenAI request shaping (v6 -> Wave 2): translate Anthropic-format tools and
  // Anthropic content-block messages into OpenAI chat-completions shapes.
  // Both helpers are DEFENSIVE -- they never throw; on any unexpected shape they
  // fall back to stringifying, so a malformed turn can't break the request.
  // ---------------------------------------------------------------------------

  // Stringify a value for OpenAI string-content slots (content / tool args /
  // tool_result content). Strings pass through; everything else is JSON.
  function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      try {
        return String(v);
      } catch (e2) {
        return '';
      }
    }
  }

  // Map Anthropic-format tools [{name,description,input_schema}] to OpenAI
  // function tools. Drops the server-side 'web_search' tool (OpenAI has no
  // equivalent in chat-completions). Returns null when nothing usable remains.
  function toOpenAiTools(tools) {
    if (!Array.isArray(tools) || !tools.length) return null;
    var out = [];
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      if (!t || typeof t !== 'object') continue;
      if (t.name === 'web_search') continue;            // no OpenAI equivalent
      if (t.type === 'web_search_20250305' || /web_search/.test(String(t.type || ''))) continue;
      if (!t.name) continue;
      var params = (t.input_schema && typeof t.input_schema === 'object')
        ? t.input_schema
        : { type: 'object', properties: {} };
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: params,
        },
      });
    }
    return out.length ? out : null;
  }

  // Translate the (possibly Anthropic-shaped) message list + system prompt into
  // an OpenAI messages array. Handles three message kinds:
  //   1) assistant whose .content is an ARRAY with {type:'text'} and/or
  //      {type:'tool_use',id,name,input}  -> { role:'assistant', content, tool_calls }
  //   2) user/any whose .content is an ARRAY of {type:'tool_result',...}
  //      -> EXPANDED into one { role:'tool', tool_call_id, content } per result
  //   3) plain string-content messages -> passed through unchanged.
  // The system prompt is prepended (matching the prior attemptOpenAI behavior).
  function toOpenAiMessages(messages, system) {
    var out = [{ role: 'system', content: system || '' }];
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== 'object') continue;
      var content = m.content;

      // (3) Plain string content -- pass through (preserve role).
      if (typeof content === 'string') {
        out.push({ role: m.role || 'user', content: content });
        continue;
      }

      // Array content: inspect block types.
      if (Array.isArray(content)) {
        // (2) tool_result array (typically role 'user') -> one tool msg each.
        var hasToolResult = false;
        for (var r = 0; r < content.length; r++) {
          if (content[r] && content[r].type === 'tool_result') { hasToolResult = true; break; }
        }
        if (hasToolResult) {
          for (var j = 0; j < content.length; j++) {
            var tr = content[j];
            if (!tr || typeof tr !== 'object') continue;
            if (tr.type === 'tool_result') {
              out.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id || tr.id || '',
                content: toStr(tr.content),
              });
            } else if (tr.type === 'text' && typeof tr.text === 'string') {
              // Stray text alongside tool_results: keep it as a user message.
              out.push({ role: m.role || 'user', content: tr.text });
            }
          }
          continue;
        }

        // (1) assistant content-array (text and/or tool_use).
        var textParts = [];
        var toolCalls = [];
        for (var k = 0; k < content.length; k++) {
          var blk = content[k];
          if (!blk || typeof blk !== 'object') {
            if (typeof blk === 'string') textParts.push(blk);
            continue;
          }
          if (blk.type === 'text' && typeof blk.text === 'string') {
            textParts.push(blk.text);
          } else if (blk.type === 'tool_use') {
            toolCalls.push({
              id: blk.id || '',
              type: 'function',
              function: {
                name: blk.name || '',
                arguments: toStr(blk.input || {}),
              },
            });
          }
        }
        var msg = {
          role: m.role || 'assistant',
          content: textParts.length ? textParts.join('') : null,
        };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        out.push(msg);
        continue;
      }

      // Unknown content shape -- never throw; stringify defensively.
      out.push({ role: m.role || 'user', content: toStr(content) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Transient-failure classification (the core of the "Failed to fetch" fix).
  // TRANSIENT = a fetch TypeError ('Failed to fetch'/network) that is NOT a user
  // abort, OR an HTTP status in the retryable set. NON-transient (4xx etc.) is
  // reported immediately and never retried.
  // ---------------------------------------------------------------------------
  var TRANSIENT_STATUS = { 408: 1, 409: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1, 529: 1 };

  function isTransientStatus(status) {
    return !!TRANSIENT_STATUS[status];
  }

  // Is a thrown fetch/stream error a transient NETWORK failure (not a user abort)?
  function isTransientNetworkError(e, controller) {
    if (!e) return false;
    // A user-initiated abort is NEVER transient.
    var aborted =
      (e.name === 'AbortError' || e.code === 20) ||
      (controller && controller.signal && controller.signal.aborted);
    if (aborted) return false;
    var msg = String(e.message || '').toLowerCase();
    if (e.name === 'TypeError') return true;            // classic "Failed to fetch"
    if (msg.indexOf('failed to fetch') !== -1) return true;
    if (msg.indexOf('network') !== -1) return true;
    if (msg.indexOf('load failed') !== -1) return true; // Safari's phrasing
    return false;
  }

  // Build the {abort()}-cancellable retry error carried up to the wrapper.
  function transientError(message, status, retryAfterMs) {
    var err = new Error(message || 'transient failure');
    err.__transient = true;
    if (typeof status === 'number') err.status = status;
    if (typeof retryAfterMs === 'number') err.retryAfterMs = retryAfterMs;
    return err;
  }

  // Parse a Retry-After header (seconds) into ms; null if absent/garbage.
  function retryAfterMsFromResp(resp) {
    try {
      var h = resp && resp.headers && resp.headers.get && resp.headers.get('retry-after');
      if (!h) return null;
      var secs = parseFloat(h);
      if (!isFinite(secs) || secs < 0) return null;
      return Math.round(secs * 1000);
    } catch (e) {
      return null;
    }
  }

  // A "rate-limit" status is one where the server is telling us to slow down for a
  // window (429 Too Many Requests, 529 Overloaded). These honor Retry-After up to
  // RATE_LIMIT_MAX_MS (NOT the generic RETRY_MAX_MS cap) and drive scheduler cooldown.
  var RATE_LIMIT_STATUS = { 429: 1, 529: 1 };
  function isRateLimitStatus(status) {
    return !!RATE_LIMIT_STATUS[status];
  }

  // ---------------------------------------------------------------------------
  // GLOBAL REQUEST SCHEDULER (v7 rate-limit hardening).
  //
  // Every stream attempt's fetch passes through here. It enforces two limits:
  //   (a) at most API_MAX_INFLIGHT requests in flight at once, and
  //   (b) at least `spacingMs` between request STARTS (adaptive: grows after a
  //       429/529, decays back toward API_MIN_SPACING_MS on a clean success).
  // After a rate-limit it also sets cooldownUntil so the UI/orchestrator can
  // throttle. Exposed read-only via App.API.rateState().
  //
  // DEADLOCK-FREE + ABORT-SAFE guarantees:
  //   * acquire() resolves with a `release` fn; the CALLER must call release()
  //     exactly once (we do it in a finally on the attempt path). release() is
  //     idempotent (a per-grant `released` flag) so a double-release can't drive
  //     inflight negative or double-pump the queue.
  //   * Each queued waiter carries an `aborted` flag. abort() on the waiter both
  //     rejects its promise (with a sentinel the caller treats as a normal abort)
  //     AND, if it was already granted a slot, releases that slot — so an aborted
  //     request NEVER strands a slot or its successors.
  //   * pump() always re-arms via setTimeout when blocked only by spacing, so a
  //     lone queued request can never wait forever for an event that won't come.
  //   * Every state transition (grant, release, abort) calls pump(), so the queue
  //     always drains as long as inflight < cap.
  // ---------------------------------------------------------------------------
  var Sched = {
    inflight: 0,
    queue: [],              // FIFO of waiter objects {resolve, aborted, granted, release}
    spacingMs: 0,           // current min spacing between starts (lazy-init from cfg)
    lastStartAt: 0,         // ms timestamp of the most recent granted start
    cooldownUntil: 0,       // ms timestamp; while in the future we're cooling down
    pumpTimer: null,        // pending setTimeout id for spacing-gated re-pump
    inited: false,
  };

  function schedCfg() {
    var cfg = App.config || {};
    return {
      maxInflight: (typeof cfg.API_MAX_INFLIGHT === 'number' && cfg.API_MAX_INFLIGHT > 0)
        ? cfg.API_MAX_INFLIGHT : 2,
      minSpacing: (typeof cfg.API_MIN_SPACING_MS === 'number' && cfg.API_MIN_SPACING_MS >= 0)
        ? cfg.API_MIN_SPACING_MS : 400,
      growth: (typeof cfg.API_COOLDOWN_GROWTH === 'number' && cfg.API_COOLDOWN_GROWTH > 1)
        ? cfg.API_COOLDOWN_GROWTH : 1.6,
    };
  }

  // Lazily initialize spacingMs from config (config.js may load after this file).
  function schedEnsureInit() {
    if (Sched.inited) return;
    Sched.spacingMs = schedCfg().minSpacing;
    Sched.inited = true;
  }

  function now() {
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : (+new Date());
  }

  // Hard ceiling on adaptive spacing so a long rate-limit streak can't wedge the
  // scheduler at multi-second spacing forever. (Spec: cap around 5000ms.)
  var SCHED_SPACING_CAP_MS = 5000;

  // Drain the queue: grant slots while under the inflight cap AND spacing allows.
  // When blocked purely by spacing, re-arm a one-shot timer so we self-resume.
  function pump() {
    schedEnsureInit();
    if (Sched.pumpTimer != null) {
      try { clearTimeout(Sched.pumpTimer); } catch (e) {}
      Sched.pumpTimer = null;
    }
    var cfg = schedCfg();
    while (Sched.queue.length && Sched.inflight < cfg.maxInflight) {
      // Drop any already-aborted waiters at the head without consuming a slot.
      var head = Sched.queue[0];
      if (head.aborted) { Sched.queue.shift(); continue; }

      var t = now();
      var wait = (Sched.lastStartAt + Sched.spacingMs) - t;
      if (wait > 0) {
        // Spacing-gated: arm a single timer to retry; do NOT busy-loop.
        Sched.pumpTimer = setTimeout(function () {
          Sched.pumpTimer = null;
          pump();
        }, wait);
        return;
      }

      // Grant the head.
      Sched.queue.shift();
      Sched.inflight += 1;
      Sched.lastStartAt = now();
      head.granted = true;
      var resolve = head.resolve;
      // Release closure: idempotent; frees the slot and pumps successors.
      head.release = makeRelease(head);
      // Resolve OUTSIDE the loop guard so the caller can start its fetch.
      resolve(head.release);
    }
  }

  // Build an idempotent release fn bound to one granted waiter.
  function makeRelease(waiter) {
    var released = false;
    return function () {
      if (released) return;
      released = true;
      if (Sched.inflight > 0) Sched.inflight -= 1;
      pump();
    };
  }

  // Acquire a scheduler slot. Returns { promise, abort }.
  //   promise resolves -> release fn (call once when the request settles)
  //   promise rejects  -> only via abort(), with a sentinel {__schedAbort:true}
  // abort() is safe to call at any phase (queued OR already granted).
  function schedAcquire() {
    schedEnsureInit();
    var waiter = { resolve: null, reject: null, aborted: false, granted: false, release: null };
    var promise = new Promise(function (resolve, reject) {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    Sched.queue.push(waiter);
    // Kick the queue (may grant immediately if under cap + spacing allows).
    pump();
    return {
      promise: promise,
      abort: function () {
        if (waiter.aborted) return;
        waiter.aborted = true;
        if (waiter.granted) {
          // Already holding a slot: release it so successors aren't stranded.
          if (waiter.release) {
            try { waiter.release(); } catch (e) {}
          } else if (Sched.inflight > 0) {
            Sched.inflight -= 1;
            pump();
          }
        } else {
          // Still queued: reject so the caller stops waiting; pump() will skip it.
          try { waiter.reject({ __schedAbort: true }); } catch (e) {}
          pump();
        }
      },
    };
  }

  // Feedback hook: the attempt layer calls this after each fetch settles with the
  // observed HTTP status (or 0 for a network error / no response).
  //   * On a rate-limit status (429/529): grow spacing (capped), arm cooldown.
  //   * On a clean success (2xx): decay spacing back toward the floor.
  // Other statuses leave spacing unchanged (a 500 isn't a "slow down" signal).
  function schedNotify(status, retryAfterMs) {
    schedEnsureInit();
    var cfg = schedCfg();
    if (isRateLimitStatus(status)) {
      var grown = Math.ceil(Math.max(Sched.spacingMs, cfg.minSpacing) * cfg.growth);
      Sched.spacingMs = Math.min(grown, SCHED_SPACING_CAP_MS);
      // Cooldown: at least one spacing window; honor Retry-After if larger.
      var cd = Sched.spacingMs;
      if (typeof retryAfterMs === 'number' && retryAfterMs > cd) cd = retryAfterMs;
      var cfgMax = App.config && typeof App.config.RATE_LIMIT_MAX_MS === 'number'
        ? App.config.RATE_LIMIT_MAX_MS : 90000;
      cd = Math.min(cd, cfgMax);
      Sched.cooldownUntil = now() + cd;
    } else if (status >= 200 && status < 300) {
      // Decay toward the floor (halfway each clean success, never below floor).
      var floor = cfg.minSpacing;
      if (Sched.spacingMs > floor) {
        Sched.spacingMs = Math.max(floor, Math.floor(Sched.spacingMs / 2));
      }
    }
    pump();
  }

  // Public read-only snapshot for the UI / orchestrator throttling.
  function rateState() {
    schedEnsureInit();
    var t = now();
    var cd = Sched.cooldownUntil > t ? Sched.cooldownUntil : 0;
    // Count only not-yet-aborted queued waiters.
    var q = 0;
    for (var i = 0; i < Sched.queue.length; i++) {
      if (!Sched.queue[i].aborted) q += 1;
    }
    return {
      inflight: Sched.inflight,
      queued: q,
      spacingMs: Sched.spacingMs,
      cooldownUntilMs: cd,
      recentlyRateLimited: Sched.cooldownUntil > t,
    };
  }

  // ---------------------------------------------------------------------------
  // Core: a single streaming attempt. Provider chosen by config.providerOf.
  // Drives the success path via an accumulator's callbacks; resolves normally on
  // success or NON-transient terminal error (reported via onError). REJECTS for:
  //   - the tool-unsupported sentinel (__toolUnsupported), and
  //   - TRANSIENT failures (__transient) — but only BEFORE any text streamed, so
  //     the wrapper can safely retry without duplicating output.
  // ---------------------------------------------------------------------------
  function attempt(opts, controller) {
    var cfg = App.config || {};
    var provider =
      (cfg.providerOf ? cfg.providerOf(opts.model)
        : (App.util && App.util.providerOf ? App.util.providerOf(opts.model) : 'anthropic'));
    return provider === 'openai'
      ? attemptOpenAI(opts, controller)
      : attemptAnthropic(opts, controller);
  }

  // Run a fetch-driven attempt body through the global scheduler. `body(status)`
  // is invoked once a slot is granted; it receives a `status` reporter object
  // ({ set(httpStatus, retryAfterMs) }) it should call once when the HTTP
  // response (or terminal network error) is known. Returns body()'s promise so
  // the existing __transient/__toolUnsupported rethrow semantics are preserved
  // BYTE-FOR-BYTE. The slot is released exactly once in finally (success, error,
  // or abort) and schedNotify() runs with the observed status.
  //
  // Abort-safety: we wire controller.signal's 'abort' to the scheduler waiter's
  // abort so a request still QUEUED (not yet started) is dropped and its slot/
  // successors are freed. If the slot is never granted (acquire rejected by an
  // abort), we resolve normally with no work — the underlying request never ran.
  function withSchedule(controller, body) {
    var gate = schedAcquire();

    // Bridge an external abort into the scheduler waiter so a queued request is
    // cancelled before it ever fetches.
    var onAbort = function () {
      try { gate.abort(); } catch (e) {}
    };
    var sig = controller && controller.signal;
    if (sig) {
      if (sig.aborted) {
        // Already aborted before we even queued: drop the slot immediately.
        try { gate.abort(); } catch (e) {}
      } else {
        try { sig.addEventListener('abort', onAbort); } catch (e) {}
      }
    }

    return gate.promise.then(
      function (release) {
        // Slot granted. Track release + status so finally is exactly-once.
        var done = false;
        var observed = { status: 0, retryAfterMs: undefined };
        var reporter = {
          set: function (httpStatus, retryAfterMs) {
            observed.status = (typeof httpStatus === 'number') ? httpStatus : 0;
            if (typeof retryAfterMs === 'number') observed.retryAfterMs = retryAfterMs;
          },
        };
        function settle() {
          if (done) return;
          done = true;
          try { if (sig) sig.removeEventListener('abort', onAbort); } catch (e) {}
          try { schedNotify(observed.status, observed.retryAfterMs); } catch (e) {}
          try { release(); } catch (e) {}
        }
        var p;
        try {
          p = body(reporter);
        } catch (e) {
          settle();
          throw e;
        }
        if (!p || typeof p.then !== 'function') {
          settle();
          return p;
        }
        return p.then(
          function (v) { settle(); return v; },
          function (err) { settle(); throw err; }
        );
      },
      function (reason) {
        // acquire() only rejects via abort. Detach listener; no slot was held.
        try { if (sig) sig.removeEventListener('abort', onAbort); } catch (e) {}
        if (reason && reason.__schedAbort) {
          // Queued request cancelled before start: nothing ran, nothing to report.
          // Resolve normally; the caller's abort path already handled UX.
          return undefined;
        }
        throw reason;
      }
    );
  }

  // ---- Anthropic streaming attempt (unchanged wire format) ------------------
  function attemptAnthropic(opts, controller) {
    var cfg = App.config || {};
    var st = (App.state && App.state.settings) || {};
    var useCompanion = !!(st.useCompanion && st.companionUrl);  // local subscription proxy
    var API_URL = useCompanion ? st.companionUrl
      : (cfg.API_URL || 'https://api.anthropic.com/v1/messages');
    var API_VERSION = cfg.API_VERSION || '2023-06-01';
    var MAX_TOKENS = cfg.MAX_TOKENS || 4096;

    var acc = new SSEAccumulator({
      onText: safe(opts.onText),
      onState: safe(opts.onState),
      onDone: safe(opts.onDone),
      onError: safe(opts.onError),
    });

    // Build the request body. Only include tools when provided & non-empty.
    var body = {
      model: opts.model,
      max_tokens: opts.maxTokens || MAX_TOKENS,
      system: opts.system || '',
      messages: Array.isArray(opts.messages) ? opts.messages : [],
      stream: true,
    };
    // Companion proxy ignores server tools (no web_search via the CLI path).
    var sentTools = !useCompanion && Array.isArray(opts.tools) && opts.tools.length > 0;
    if (sentTools) body.tools = opts.tools;

    var headers = useCompanion
      ? { 'content-type': 'application/json' }   // companion needs no key/version headers
      : {
          'x-api-key': opts.apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        };

    // Lifecycle hint: we're about to think.
    acc.onState('thinking');

    return withSchedule(controller, function (reporter) {
      return fetch(API_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      .then(function (resp) {
        // ---- Non-200: parse the error JSON and report ----------------------
        if (!resp.ok) {
          var retryAfter = retryAfterMsFromResp(resp);
          reporter.set(resp.status, retryAfter);  // feed scheduler (cooldown on 429/529)
          return resp.text().then(function (txt) {
            var parsed = null;
            try {
              parsed = txt ? JSON.parse(txt) : null;
            } catch (e) {
              parsed = null;
            }
            var msg =
              extractApiErrorMessage(parsed) ||
              (txt && txt.slice(0, 300)) ||
              ('HTTP ' + resp.status);
            var err = { type: 'http', status: resp.status, message: msg };

            // Tool-unsupported + we actually sent tools => reject so the
            // wrapper retries once without tools.
            if (sentTools && isToolUnsupportedError(err)) {
              var retryErr = new Error(msg);
              retryErr.__toolUnsupported = true;
              retryErr.status = resp.status;
              throw retryErr;
            }

            // Transient HTTP (429/5xx/etc.) => reject so the wrapper backs off.
            if (isTransientStatus(resp.status)) {
              throw transientError(msg, resp.status, retryAfter);
            }

            acc.onError(err);
          });
        }

        reporter.set(resp.status);  // 2xx success => scheduler decays spacing

        // ---- 200 OK but no readable stream: read full text, parse in bulk. --
        if (!resp.body || typeof resp.body.getReader !== 'function') {
          return resp.text().then(function (txt) {
            acc.feed(txt, true);
            acc.finish(false); // best-effort if no message_stop was present
          });
        }

        // ---- Stream the SSE body -------------------------------------------
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');

        function readChunk() {
          return reader.read().then(function (res) {
            if (res.done) {
              acc.feed('', true);  // flush trailing buffered event
              acc.finish(false);   // finish even without explicit message_stop
              return;
            }
            acc.feed(decoder.decode(res.value, { stream: true }), false);
            if (acc.doneEmitted) {
              // Saw message_stop; stop pulling and cancel the reader politely.
              try {
                reader.cancel();
              } catch (e) {}
              return;
            }
            return readChunk();
          });
        }

        return readChunk();
      })
      .catch(function (e) {
        // Rethrow sentinels so the wrapper can act on them.
        if (e && e.__toolUnsupported) throw e;
        if (e && e.__transient) throw e;

        // If we already delivered a terminal result, don't double-report.
        if (acc.doneEmitted) return;

        var aborted =
          (e && (e.name === 'AbortError' || e.code === 20)) ||
          (controller.signal && controller.signal.aborted);
        if (aborted) {
          acc.onError({ type: 'abort', message: 'request aborted' });
          return;
        }

        // Transient network failure BEFORE any text streamed => let the wrapper
        // retry. If text already streamed, don't retry (would duplicate output).
        if (isTransientNetworkError(e, controller) && !acc.firstTextSeen) {
          throw transientError((e && e.message) || 'Failed to fetch');
        }

        acc.onError({
          type: 'network',
          message: (e && e.message) || 'network error — check connection',
        });
      });
    });
  }

  // ---- OpenAI streaming attempt (chat-completions; no server web_search) ----
  function attemptOpenAI(opts, controller) {
    var cfg = App.config || {};
    var OPENAI_URL = cfg.OPENAI_URL || 'https://api.openai.com/v1/chat/completions';
    var MAX_TOKENS = cfg.MAX_TOKENS || 4096;

    var acc = new OpenAIAccumulator({
      onText: safe(opts.onText),
      onState: safe(opts.onState),
      onDone: safe(opts.onDone),
      onError: safe(opts.onError),
    });

    // Translate any Anthropic-shaped turns (assistant tool_use / user tool_result
    // content-block arrays) into OpenAI shapes; prepend the system prompt.
    var messages = toOpenAiMessages(opts.messages, opts.system);

    var body = {
      model: opts.model,
      messages: messages,
      stream: true,
      max_completion_tokens: opts.maxTokens || MAX_TOKENS,
      stream_options: { include_usage: true },
    };

    // Client tools: Anthropic-format opts.tools -> OpenAI function tools (drop
    // the server-side web_search tool, which has no chat-completions equivalent).
    var oaTools = toOpenAiTools(opts.tools);
    if (oaTools) {
      body.tools = oaTools;
      body.tool_choice = 'auto';
    }

    var headers = {
      'Authorization': 'Bearer ' + opts.openaiKey,
      'content-type': 'application/json',
    };

    acc.onState('thinking');

    return withSchedule(controller, function (reporter) {
      return fetch(OPENAI_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      .then(function (resp) {
        if (!resp.ok) {
          var retryAfter = retryAfterMsFromResp(resp);
          reporter.set(resp.status, retryAfter);  // feed scheduler (cooldown on 429/529)
          return resp.text().then(function (txt) {
            var parsed = null;
            try {
              parsed = txt ? JSON.parse(txt) : null;
            } catch (e) {
              parsed = null;
            }
            var msg =
              extractApiErrorMessage(parsed) ||
              (txt && txt.slice(0, 300)) ||
              ('HTTP ' + resp.status);

            if (isTransientStatus(resp.status)) {
              throw transientError(msg, resp.status, retryAfter);
            }
            acc.onError({ type: 'http', status: resp.status, message: msg });
          });
        }

        reporter.set(resp.status);  // 2xx success => scheduler decays spacing

        if (!resp.body || typeof resp.body.getReader !== 'function') {
          return resp.text().then(function (txt) {
            acc.feed(txt, true);
            acc.finish(false);
          });
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');

        function readChunk() {
          return reader.read().then(function (res) {
            if (res.done) {
              acc.feed('', true);
              acc.finish(false);
              return;
            }
            acc.feed(decoder.decode(res.value, { stream: true }), false);
            if (acc.doneEmitted) {
              try {
                reader.cancel();
              } catch (e) {}
              return;
            }
            return readChunk();
          });
        }

        return readChunk();
      })
      .catch(function (e) {
        if (e && e.__transient) throw e;
        if (acc.doneEmitted) return;

        var aborted =
          (e && (e.name === 'AbortError' || e.code === 20)) ||
          (controller.signal && controller.signal.aborted);
        if (aborted) {
          acc.onError({ type: 'abort', message: 'request aborted' });
          return;
        }

        if (isTransientNetworkError(e, controller) && !acc.firstTextSeen) {
          throw transientError((e && e.message) || 'Failed to fetch');
        }

        acc.onError({
          type: 'network',
          message: (e && e.message) || 'network error — check connection',
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Public: App.API.stream
  // Validates inputs synchronously, then runs attempt() with an exponential
  // backoff retry loop for TRANSIENT failures (the "Failed to fetch" fix); on
  // tool-unsupported failure (anthropic), retries ONCE without tools.
  // Always returns an {abort()} handle synchronously. Never throws.
  // ---------------------------------------------------------------------------
  function stream(opts) {
    opts = opts || {};
    var cfg = App.config || {};
    var onState = safe(opts.onState);
    var onError = safe(opts.onError);

    // --- Missing model: defend (caller should always pass one). --------------
    if (!opts.model) {
      onError({
        type: 'bad_request',
        message: 'No model specified for API request.',
      });
      return noopHandle();
    }

    // --- Provider-aware key check: openai models need openaiKey; else apiKey. -
    var provider =
      (cfg.providerOf ? cfg.providerOf(opts.model)
        : (App.util && App.util.providerOf ? App.util.providerOf(opts.model) : 'anthropic'));
    if (provider === 'openai') {
      if (!opts.openaiKey) {
        onError({ type: 'no_key', message: 'Set your OpenAI API key in Settings' });
        return noopHandle();
      }
    } else {
      // Companion mode (local subscription proxy) needs no Anthropic key.
      var _s = (App.state && App.state.settings) || {};
      var _companion = !!(_s.useCompanion && _s.companionUrl);
      if (!opts.apiKey && !_companion) {
        onError({ type: 'no_key', message: 'Set your API key in Settings (or enable the companion)' });
        return noopHandle();
      }
    }

    // AbortController bridges the caller's optional signal to our request.
    var controller;
    try {
      controller = new AbortController();
    } catch (e) {
      // Extremely old environment without AbortController — degrade to a stub.
      controller = { signal: undefined, abort: noop };
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        onError({ type: 'abort', message: 'request aborted' });
        return { abort: noop };
      }
      try {
        opts.signal.addEventListener('abort', function () {
          try {
            controller.abort();
          } catch (e) {}
        });
      } catch (e) {
        // ignore — non-fatal
      }
    }

    // Retry tuning (from config; sane fallbacks if config absent).
    var RETRY_MAX = (typeof cfg.RETRY_MAX === 'number') ? cfg.RETRY_MAX : 6;
    var RETRY_BASE_MS = (typeof cfg.RETRY_BASE_MS === 'number') ? cfg.RETRY_BASE_MS : 700;
    var RETRY_MAX_MS = (typeof cfg.RETRY_MAX_MS === 'number') ? cfg.RETRY_MAX_MS : 8000;
    // Rate-limit (429/529) ceiling: honor the server's window, NOT the 8s generic
    // cap. This is THE fix — a "Retry-After: 30" used to be clamped to 8s and burn
    // the whole budget before the per-minute window reset.
    var RATE_LIMIT_MAX_MS =
      (typeof cfg.RATE_LIMIT_MAX_MS === 'number') ? cfg.RATE_LIMIT_MAX_MS : 90000;

    // Cancellable retry-timer handle (cleared by abort()).
    var retryTimer = null;
    var cancelled = false;

    // Compute backoff delay for retry #attempt (0-based). Two regimes:
    //   * RATE-LIMIT (429/529): honor the server's Retry-After up to
    //     RATE_LIMIT_MAX_MS. With no header, use exponential but let the cap RISE
    //     toward RATE_LIMIT_MAX_MS on later attempts (so we wait out the window
    //     instead of giving up at 8s).
    //   * other transient (408/409/5xx): base*2^attempt capped at RETRY_MAX_MS.
    // Jitter is always added to de-correlate concurrent retriers.
    function backoffMs(attemptIdx, retryAfterMs, status) {
      var rateLimited = isRateLimitStatus(status);
      if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
        // Rate-limit hints honor the (large) RATE_LIMIT_MAX_MS ceiling; other
        // transient hints keep the generic 8s ceiling.
        var ceil = rateLimited ? RATE_LIMIT_MAX_MS : RETRY_MAX_MS;
        return Math.min(retryAfterMs, ceil) + Math.floor(Math.random() * 250);
      }
      var raw = RETRY_BASE_MS * Math.pow(2, attemptIdx);
      // For rate-limit with no header, let the exponential cap climb toward the
      // rate-limit ceiling on later attempts (RETRY_MAX_MS on early ones).
      var cap = rateLimited
        ? Math.min(RATE_LIMIT_MAX_MS, Math.max(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attemptIdx + 1)))
        : RETRY_MAX_MS;
      var capped = Math.min(raw, cap);
      return capped + Math.floor(Math.random() * (RETRY_BASE_MS));
    }

    // Run one attempt; on a TRANSIENT rejection, schedule a backed-off retry up
    // to RETRY_MAX times. `useOpts` lets the tool-unsupported path drop tools.
    function runAttempt(useOpts, attemptIdx) {
      if (cancelled) return;
      var p;
      try {
        p = attempt(useOpts, controller);
      } catch (e) {
        // attempt() should never throw synchronously, but be paranoid.
        onError({ type: 'network', message: (e && e.message) || 'unexpected error' });
        return;
      }
      if (!p || typeof p.then !== 'function') return;

      p.catch(function (e) {
        if (cancelled) return;

        // --- Tool-unsupported (anthropic): retry ONCE without tools. ----------
        if (
          e && e.__toolUnsupported &&
          Array.isArray(useOpts.tools) && useOpts.tools.length
        ) {
          if (typeof console !== 'undefined' && console.info) {
            console.info('[App.API] web_search tool unsupported — retrying without tools.');
          }
          var opts2 = {};
          for (var k in useOpts) {
            if (Object.prototype.hasOwnProperty.call(useOpts, k)) opts2[k] = useOpts[k];
          }
          opts2.tools = undefined;
          // Reset the transient-retry budget for the tools-free attempt.
          runAttempt(opts2, 0);
          return;
        }

        // --- Transient failure: backoff + retry. -----------------------------
        if (e && e.__transient) {
          if (attemptIdx < RETRY_MAX) {
            // Pass the status so 429/529 honor Retry-After up to RATE_LIMIT_MAX_MS
            // (the fix) instead of the generic 8s cap.
            var delay = backoffMs(attemptIdx, e.retryAfterMs, e && e.status);
            if (typeof console !== 'undefined' && console.info) {
              console.info('[App.API] transient failure (status ' + (e && e.status) +
                ') — retry ' + (attemptIdx + 1) + '/' + RETRY_MAX + ' in ' +
                Math.round(delay / 100) / 10 + 's');
            }
            // While waiting, do NOT call onError; nudge state back to thinking so
            // the orchestrator can surface a "retrying" bubble (it polls rateState).
            onState('thinking');
            retryTimer = setTimeout(function () {
              retryTimer = null;
              runAttempt(useOpts, attemptIdx + 1);
            }, delay);
            return;
          }
          // Retries exhausted — report clearly (attempts used + seconds-ish).
          onError({
            type: 'http',
            status: e && e.status,
            message: 'rate limited / overloaded — retried ' + RETRY_MAX +
              ' times over ~' + Math.round(RATE_LIMIT_MAX_MS / 1000) +
              's window; try again',
          });
          return;
        }

        // Any other rejection that bubbled here: classify generically.
        onError({
          type: 'http',
          status: e && e.status,
          message: (e && e.message) || 'request failed',
        });
      });
    }

    // Kick off (nothing async is allowed to escape).
    runAttempt(opts, 0);

    // Public abort handle — cancels both the in-flight request AND any pending
    // retry timer so the caller can fully stop a backing-off stream.
    return {
      abort: function () {
        cancelled = true;
        if (retryTimer) {
          try { clearTimeout(retryTimer); } catch (e) {}
          retryTimer = null;
        }
        try {
          controller.abort();
        } catch (e) {}
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Expose App.API.
  // ---------------------------------------------------------------------------
  App.API = {
    stream: stream,
    // Exposed for reuse; harmless to share. (SPEC §7.6 lists an equivalent
    // private helper in Orchestrator; this lets callers reuse one predicate.)
    isToolUnsupportedError: isToolUnsupportedError,
    // Read-only scheduler snapshot for the UI overload banner + orchestrator
    // throttling. { inflight, queued, spacingMs, cooldownUntilMs, recentlyRateLimited }
    rateState: rateState,
  };
})();
