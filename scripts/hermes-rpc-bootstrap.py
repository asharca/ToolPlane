"""Run the pinned native gateway inside one isolated ToolPlane Agent home.

The Node driver owns protocol/session handling. This process owns the flock for
its entire lifetime, config projection, and the native gateway. No legacy Hermes
home, dashboard, provider key, or database connection is used here.
"""
import fcntl
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".toolplane-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    home = Path(request["home"])
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A separate open file description holds this lock until process exit,
    # including SIGKILL. Never unlink it or guess whether a recorded PID is alive.
    lease = open(home / ".toolplane-rpc.lock", "a+")
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("This Hermes RPC Agent is busy; retry after its current operation finishes.") from None
    os.umask(0o077)
    atomic_json(home / "config.yaml", request["config"])
    # This mode owns its configuration; do not inherit manually planted provider
    # credentials or process hooks from a previous native .env.
    (home / ".env").write_text("# Managed by ToolPlane Hermes RPC.\n")
    os.chmod(home / ".env", 0o600)
    # Native providers may save resolved configuration in session metadata.
    # Only short-lived runtime grants enter this home; they are replaced each turn.
    os.environ.update({
        "HERMES_HOME": str(home), "HOME": str(home),
        "TERMINAL_CWD": request["cwd"],
        "HERMES_SESSION_SOURCE": "toolplane",
        "HERMES_TUI_TOOLSETS": ",".join(request["toolsets"]),
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "PYTHONUNBUFFERED": "1", "NO_COLOR": "1",
    })
    # The named provider's canonical fallback also resolves only to the scoped
    # ToolPlane proxy. This is needed by native resume after provider normalization.
    os.environ["OPENAI_API_KEY"] = request["token"]
    os.environ["OPENAI_BASE_URL"] = request["modelBase"]
    source = request["source"]
    sys.path.insert(0, source)
    os.chdir(request["cwd"])
    try:
        runpy.run_module("tui_gateway.entry", run_name="__main__")
    finally:
        # Keep native state, memories and learned skills, not an active grant.
        config = request["config"]
        for provider in config.get("providers", {}).values():
            provider["api_key"] = "expired-toolplane-runtime-grant"
        for server in config.get("mcp_servers", {}).values():
            server["headers"] = {}
        atomic_json(home / "config.yaml", config)
        lease.close()


if __name__ == "__main__":
    main()
