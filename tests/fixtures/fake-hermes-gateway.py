"""Deterministic JSON-RPC peer for adapter failure-path tests, not Hermes itself."""
import json
from pathlib import Path
import sys
import time

context = json.loads(Path(sys.argv[1]).read_text())
scenario = context.get("scenario", "success")
sid = "native-session"
stored = "stored-session"


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def event(kind, payload=None):
    send({"method": "event", "params": {"type": kind, "session_id": sid, "payload": payload or {}}})


if scenario == "malformed":
    print("not JSON", flush=True)
else:
    event("gateway.ready")
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    rid = request.get("id")
    if method in ("session.create", "session.resume"):
        if scenario == "missing-state" and method == "session.resume":
            send({"id": rid, "error": {"code": 4040, "message": "native session not found"}})
        else:
            send({"id": rid, "result": {"session_id": sid, "stored_session_id": stored, "session_key": stored}})
    elif method == "prompt.submit":
        send({"id": rid, "result": {"status": "streaming"}})
        if scenario == "interactive":
            send({"id": "approval-1", "method": "approval", "params": {"command": "unapproved-action"}})
        elif scenario == "hang":
            pass
        elif scenario == "oversized":
            sys.stdout.write("x" * (4 * 1024 * 1024 + 1))
            sys.stdout.flush()
        elif scenario == "exit-early":
            event("message.complete", {"status": "complete", "text": "not yet persisted"})
            sys.exit(0)
        else:
            send({"method": "event", "params": {"session_id": "another-session", "type": "message.delta", "payload": {"text": "wrong-session-data"}}})
            event("session.info", {"stored_session_id": stored, "running": True})
            text = "hello " + context["token"] + " world"
            for character in text:
                event("message.delta", {"text": character})
            event("tool.start", {"name": "mcp_tp_fake_echo", "tool_id": "tool-1"})
            event("tool.complete", {"name": "mcp_tp_fake_echo", "tool_id": "tool-1", "args": {}, "result": "echo", "duration_s": 0.1})
            event("message.complete", {"status": "error" if scenario == "error" else "complete", "text": text})
            event("session.info", {"stored_session_id": stored, "running": False})
    elif method == "session.compress":
        send({"id": rid, "result": {"lock_held": True} if scenario == "compact-busy" else {"status": "compressed", "info": {"stored_session_id": "stored-compacted"}}})
    elif method == "session.interrupt":
        send({"id": rid, "result": {"interrupted": True}})
    elif method == "session.close":
        send({"id": rid, "result": {"closed": True}})
        break
    elif method is None and rid == "approval-1":
        # The only permitted result is rejection, never an affirmative answer.
        assert request.get("error", {}).get("code") == -32601
