"""Opt-in native protocol check with a local model stub; no paid model access.
Run with HERMES_RPC_SOURCE + HERMES_RPC_PYTHONPATH pointing at the pinned checkout
and frozen dependency environment. This exercises the real upstream agent loop.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[2]
REQUESTS = []
TOKEN = ["runtime-grant-one"]
MCP_CALLS = []


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/mcp":
            assert self.headers.get("Authorization") == "Bearer " + TOKEN[0], "stale MCP grant"
            rid, method = body.get("id"), body.get("method")
            if rid is None:
                self.send_response(202); self.end_headers(); return
            if method == "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "toolplane-fixture", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "echo", "description": "Echo a fixture message", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}}]}
            elif method == "tools/call":
                MCP_CALLS.append(body["params"])
                result = {"content": [{"type": "text", "text": "MCP_TOOL_RESULT_FROM_SELECTED_DEPLOYMENT"}]}
            else:
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "unknown method"}}).encode()); return
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}).encode()); return
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        assert self.headers.get("Authorization") == "Bearer " + TOKEN[0], "stale runtime grant"
        REQUESTS.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        reply = "native-turn-" + ("3" if "exercise-tools" in json.dumps(body.get("messages", [])) else "2" if "message-2" in json.dumps(body.get("messages", [])) else "1")
        call_tools = body.get("messages", [{}])[-1].get("role") == "user" and "exercise-tools" in json.dumps(body["messages"][-1])
        deltas = [({"role": "assistant"}, None), ({"content": reply}, None), ({}, "stop")]
        if call_tools:
            names = [tool["function"]["name"] for tool in body.get("tools", [])]
            mcp_name = "mcp__tp_fixture__echo"
            call_name = mcp_name if mcp_name in names else "tool_call"
            call_args = {"message": "fixture"} if mcp_name in names else {"name": mcp_name, "arguments": {"message": "fixture"}}
            deltas = [({"role": "assistant", "tool_calls": [
                {"index": 0, "id": "call-skill", "type": "function", "function": {"name": "skill_view", "arguments": json.dumps({"name": "fixture"})}},
                {"index": 1, "id": "call-echo", "type": "function", "function": {"name": call_name, "arguments": json.dumps(call_args)}},
            ]}, None), ({}, "tool_calls")]
        if body.get("stream"):
            for delta, finish in deltas:
                value = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1,
                         "model": "fixture-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if finish:
                    value["usage"] = {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.wfile.write(json.dumps({"id": "fixture", "object": "chat.completion", "created": 1,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}}).encode())


def main():
    source = os.environ["HERMES_RPC_SOURCE"]
    dependencies = os.environ["HERMES_RPC_PYTHONPATH"]
    server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="toolplane-hermes-native-") as temporary:
            home = Path(temporary) / "home"
            skill = Path(temporary) / "assigned-skills" / "fixture"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: fixture\ndescription: Native fixture skill\n---\nReturn the fixture answer.\n")
            model_base = f"http://127.0.0.1:{server.server_port}/v1"
            common = {"sessionId": "conversation-1", "home": str(home), "cwd": temporary,
                "python": sys.executable, "bootstrap": str(ROOT / "scripts/hermes-rpc-bootstrap.py"),
                "source": source, "testPythonPath": dependencies + os.pathsep + source,
                "binding": "binding-1", "provider": "custom:toolplane-rpc", "model": "fixture-model",
                "modelBase": model_base, "toolsets": ["memory", "skills", "tp_fixture"], "timeoutMs": 20_000,
                "config": {"model": {"provider": "custom:toolplane-rpc", "default": "fixture-model"},
                    "providers": {"toolplane-rpc": {"api": model_base, "api_key": TOKEN[0], "transport": "chat_completions",
                        "default_model": "fixture-model", "models": {"fixture-model": {}}, "discover_models": False}},
                    "agent": {"max_turns": 3, "system_prompt": "SYSTEM_PROMPT_FROM_TOOLPLANE"},
                    "plugins": {"enabled": []}, "skills": {"external_dirs": [str(skill.parent)]},
                    "mcp_servers": {"tp_fixture": {"url": f"http://127.0.0.1:{server.server_port}/mcp", "enabled": True,
                        "headers": {"Authorization": "Bearer " + TOKEN[0]}}}}}
            for number in (1, 2, 3):
                if number == 2:
                    TOKEN[0] = "runtime-grant-two"
                request = {**common, "token": TOKEN[0], "message": "exercise-tools" if number == 3 else "message-" + str(number),
                    "history": [] if number == 1 else [{"role": "user", "content": "DO_NOT_REPLAY_THIS"}]}
                request["config"]["providers"]["toolplane-rpc"]["api_key"] = TOKEN[0]
                request["config"]["mcp_servers"]["tp_fixture"]["headers"]["Authorization"] = "Bearer " + TOKEN[0]
                path = Path(temporary) / "request.json"
                path.write_text(json.dumps(request))
                proc = subprocess.run(["node", str(ROOT / "scripts/hermes-rpc-session.mjs"), str(path)],
                    env={**os.environ, "TOOLPLANE_HERMES_RPC_TEST": "1"}, capture_output=True, text=True, timeout=40)
                events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
                assert proc.returncode == 0, (number, proc.stdout, proc.stderr)
                assert events[-1]["type"] == "result", events
                assert events[-1]["text"].strip() == "native-turn-" + str(number), events
                assert TOKEN[0] not in proc.stdout, "grant exposed"
                print(json.dumps({"turn": number, "events": [event["type"] for event in events], "usage": events[-1].get("usage")}))
            assert len(REQUESTS) == 4, len(REQUESTS)
            assert len(MCP_CALLS) == 1 and MCP_CALLS[0]["name"] == "echo", MCP_CALLS
            assert "MCP_TOOL_RESULT_FROM_SELECTED_DEPLOYMENT" in json.dumps(REQUESTS[-1])
            assert "Return the fixture answer." in json.dumps(REQUESTS[-1])
            second = json.dumps(REQUESTS[-1]["messages"])
            assert "message-1" in second and "message-2" in second and "native-turn-1" in second
            assert "DO_NOT_REPLAY_THIS" not in second
            assert "SYSTEM_PROMPT_FROM_TOOLPLANE" in json.dumps(REQUESTS[0])
            tools = {tool["function"]["name"] for tool in REQUESTS[0].get("tools", [])}
            assert "memory" in tools and "skill_view" in tools, tools
            assert "terminal" not in tools and "cronjob" not in tools, tools
            assert "Native fixture skill" in json.dumps(REQUESTS[0])
            print("Native Hermes RPC: streaming, grant rotation, process restart/resume, no history replay, system prompt, selected Skill reading and real MCP round-trip passed.")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
