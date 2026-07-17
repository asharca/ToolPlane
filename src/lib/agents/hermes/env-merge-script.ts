export const HERMES_ENV_MERGE_SCRIPT = String.raw`import json
import os
import pathlib
import re
import sys
import tempfile


env_destination = pathlib.Path(sys.argv[1])
managed_env_path = pathlib.Path(sys.argv[2])
managed_keys_path = env_destination.parent / ".toolplane-env-keys.json"

try:
    managed_env = json.loads(managed_env_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    managed_env = {}
if not isinstance(managed_env, dict):
    managed_env = {}
managed_env = {
    str(key): str(value)
    for key, value in managed_env.items()
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key))
}

try:
    previous_keys = json.loads(managed_keys_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    previous_keys = []
if not isinstance(previous_keys, list):
    previous_keys = []
owned_keys = {str(key) for key in previous_keys} | set(managed_env)
assignment = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

try:
    existing_lines = env_destination.read_text(encoding="utf-8").splitlines()
except OSError:
    existing_lines = []
preserved_lines = []
for line in existing_lines:
    match = assignment.match(line)
    if match and match.group(1) in owned_keys:
        continue
    preserved_lines.append(line)
while preserved_lines and not preserved_lines[-1].strip():
    preserved_lines.pop()
if preserved_lines and managed_env:
    preserved_lines.append("")
preserved_lines.extend(
    f"{key}={json.dumps(value, ensure_ascii=False)}"
    for key, value in sorted(managed_env.items())
)

env_destination.parent.mkdir(parents=True, exist_ok=True)
env_fd, env_temporary = tempfile.mkstemp(prefix=".env.", dir=env_destination.parent)
try:
    with os.fdopen(env_fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(preserved_lines))
        if preserved_lines:
            handle.write("\n")
    os.chmod(env_temporary, 0o600)
    os.replace(env_temporary, env_destination)
finally:
    if os.path.exists(env_temporary):
        os.unlink(env_temporary)

keys_fd, keys_temporary = tempfile.mkstemp(prefix=".toolplane-env-keys.", dir=env_destination.parent)
try:
    with os.fdopen(keys_fd, "w", encoding="utf-8") as handle:
        json.dump(sorted(managed_env), handle)
    os.chmod(keys_temporary, 0o600)
    os.replace(keys_temporary, managed_keys_path)
finally:
    if os.path.exists(keys_temporary):
        os.unlink(keys_temporary)
`;
