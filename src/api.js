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

    // OpenAI has no server-side web_search here: opts.tools is intentionally ignored.
    var messages = [{ role: 'system', content: opts.system || '' }]
      .concat(Array.isArray(opts.messages) ? opts.messages : []);

    var body = {
      model: opts.model,
      messages: messages,
      stream: true,
      max_completion_tokens: opts.maxTokens || MAX_TOKENS,
      stream_options: { include_usage: true },
    };

    var headers = {
      'Authorization': 'Bearer ' + opts.openaiKey,
      'content-type': 'application/json',
    };

    acc.onState('thinking');

    return fetch(OPENAI_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (resp) {
        if (!resp.ok) {
          var retryAfter = retryAfterMsFromResp(resp);
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
    var RETRY_MAX = (typeof cfg.RETRY_MAX === 'number') ? cfg.RETRY_MAX : 4;
    var RETRY_BASE_MS = (typeof cfg.RETRY_BASE_MS === 'number') ? cfg.RETRY_BASE_MS : 700;
    var RETRY_MAX_MS = (typeof cfg.RETRY_MAX_MS === 'number') ? cfg.RETRY_MAX_MS : 8000;

    // Cancellable retry-timer handle (cleared by abort()).
    var retryTimer = null;
    var cancelled = false;

    // Compute backoff delay for retry #attempt (0-based): base*2^attempt capped,
    // plus random jitter; honor an explicit retry-after when the server gave one.
    function backoffMs(attemptIdx, retryAfterMs) {
      if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
        // Clamp server hint to our ceiling, still add a little jitter.
        return Math.min(retryAfterMs, RETRY_MAX_MS) + Math.floor(Math.random() * 250);
      }
      var raw = RETRY_BASE_MS * Math.pow(2, attemptIdx);
      var capped = Math.min(raw, RETRY_MAX_MS);
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

        // --- Transient failure: exponential backoff + retry. -----------------
        if (e && e.__transient) {
          if (attemptIdx < RETRY_MAX) {
            var delay = backoffMs(attemptIdx, e.retryAfterMs);
            if (typeof console !== 'undefined' && console.info) {
              console.info('[App.API] transient failure — retry ' +
                (attemptIdx + 1) + '/' + RETRY_MAX + ' in ' + delay + 'ms');
            }
            // While waiting, do NOT call onError; nudge state back to thinking.
            onState('thinking');
            retryTimer = setTimeout(function () {
              retryTimer = null;
              runAttempt(useOpts, attemptIdx + 1);
            }, delay);
            return;
          }
          // Retries exhausted — report clearly.
          onError({
            type: 'http',
            status: e && e.status,
            message: 'rate limited / overloaded — retried ' + RETRY_MAX +
              '×; try again',
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
  };
})();
