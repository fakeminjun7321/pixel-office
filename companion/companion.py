#!/usr/bin/env python3
"""
NEON//WORKS — local companion server (use your Claude SUBSCRIPTION, no API key).

It exposes a tiny endpoint that speaks the Anthropic /v1/messages SSE format, but
internally answers each request by shelling out to the `claude` CLI — which runs
against your logged-in Claude Pro/Max subscription. So agents whose model is a
Claude model can run WITHOUT an Anthropic API key.

RUN:
    python3 companion.py            # listens on http://localhost:8787

THEN in the app:
    Settings → enable "Use local companion (subscription)"  (URL defaults to this)
    Pick Claude models for your agents and DISPATCH as usual.

REQUIREMENTS:
    - `claude` CLI installed and logged into a Pro/Max subscription
      (run `claude`, then `/login` once).

LIMITATIONS:
    - Browsers block https→http (mixed content). Use the companion with the
      file:// or http://localhost version of the app, NOT the https GitHub Pages
      site. (Open index.html directly, or `python3 -m http.server` in the folder.)
    - Claude models only. OpenAI (gpt-*) agents still use the OpenAI API key.
    - Streaming is simulated (the CLI returns the full reply, which is then
      chunked back), so text appears in a few bursts rather than token-by-token.
"""
import json
import os
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8787


def subscription_env():
    """A clean env that forces the `claude` CLI to use the logged-in SUBSCRIPTION.

    Strips any API-key / base-URL overrides that would otherwise hijack auth
    (e.g. a stray ANTHROPIC_API_KEY in your shell, or a proxy ANTHROPIC_BASE_URL),
    so the CLI falls back to its stored OAuth subscription credentials.
    """
    env = os.environ.copy()
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        env.pop(k, None)
    return env


def model_alias(model):
    """Map the app's full model ids to a CLI alias the subscription understands."""
    m = (model or "").lower()
    if "opus" in m:
        return "opus"
    if "haiku" in m:
        return "haiku"
    if "sonnet" in m:
        return "sonnet"
    return "sonnet"  # default for anything unexpected (gpt-* should not reach here)


def build_prompt(messages):
    """Flatten the message list into one prompt (supports multi-turn direct chat)."""
    parts = []
    for msg in messages or []:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):  # content blocks
            content = "".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
        prefix = "Assistant: " if role == "assistant" else ""
        parts.append(prefix + str(content))
    return "\n\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # simple health check
        if self.path.rstrip("/").endswith("/health") or self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true,"service":"neonworks-companion"}')
            return
        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/v1/messages"):
            self._error(404, "not found")
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._error(400, "bad request: %s" % e)
            return

        model = model_alias(body.get("model"))
        system = body.get("system") or ""
        prompt = build_prompt(body.get("messages"))
        if not prompt.strip():
            self._error(400, "empty prompt")
            return

        cmd = ["claude", "-p", prompt, "--model", model, "--output-format", "text"]
        if system:
            cmd += ["--append-system-prompt", system]

        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300,
                env=subscription_env(),
            )
        except Exception as e:  # noqa: BLE001
            self._error(502, "claude CLI failed to run: %s" % e)
            return
        if proc.returncode != 0:
            self._error(502, "claude CLI error: %s" % (proc.stderr or "")[:500])
            return
        text = (proc.stdout or "").rstrip("\n")

        # Stream back as Anthropic-format SSE so the app's existing parser works.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()

        def sse(evt, data):
            self.wfile.write(
                ("event: %s\ndata: %s\n\n" % (evt, json.dumps(data))).encode("utf-8")
            )
            self.wfile.flush()

        try:
            sse("message_start", {
                "type": "message_start",
                "message": {"usage": {"input_tokens": 0, "output_tokens": 0}},
            })
            sse("content_block_start", {
                "type": "content_block_start", "index": 0,
                "content_block": {"type": "text", "text": ""},
            })
            step = max(1, len(text) // 40)  # ~40 bursts to simulate streaming
            for i in range(0, len(text), step):
                sse("content_block_delta", {
                    "type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": text[i:i + step]},
                })
            sse("content_block_stop", {"type": "content_block_stop", "index": 0})
            sse("message_delta", {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": max(1, len(text) // 4)},
            })
            sse("message_stop", {"type": "message_stop"})
        except (BrokenPipeError, ConnectionResetError):
            pass  # client navigated away / aborted

    def _error(self, code, msg):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(json.dumps(
                {"type": "error", "error": {"type": "companion_error", "message": msg}}
            ).encode("utf-8"))
        except Exception:  # noqa: BLE001
            pass

    def log_message(self, *args):
        return  # keep the console quiet


if __name__ == "__main__":
    if not shutil.which("claude"):
        sys.stderr.write(
            "ERROR: `claude` CLI not found on PATH.\n"
            "Install Claude Code and run `claude` once to log in to your subscription.\n"
        )
        sys.exit(1)
    print("NEON//WORKS companion → http://localhost:%d   (Ctrl+C to stop)" % PORT)
    print("Answering via your Claude subscription (`claude` CLI).")
    print('In the app: Settings → enable "Use local companion (subscription)".')
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
