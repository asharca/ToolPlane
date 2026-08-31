export const HERMES_CHANNEL_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS',
  'DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_USERS',
  'MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_ALLOWED_USERS',
  'MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID',
  'MATRIX_ALLOWED_USERS', 'MATRIX_DEVICE_ID', 'MATRIX_PASSWORD', 'MATRIX_RECOVERY_KEY',
  'WHATSAPP_ENABLED', 'WHATSAPP_MODE', 'WHATSAPP_DM_POLICY', 'WHATSAPP_ALLOWED_USERS',
  'SIGNAL_HTTP_URL', 'SIGNAL_ACCOUNT', 'SIGNAL_ALLOWED_USERS',
  'BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD', 'BLUEBUBBLES_ALLOWED_USERS',
  'HASS_URL', 'HASS_TOKEN',
  'EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'EMAIL_IMAP_HOST', 'EMAIL_SMTP_HOST',
  'EMAIL_ALLOWED_USERS', 'EMAIL_SMTP_PORT',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_ALLOWED_USERS', 'DINGTALK_WEBHOOK_URL',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY',
  'FEISHU_VERIFICATION_TOKEN', 'FEISHU_ALLOWED_USERS', 'FEISHU_DOMAIN',
  'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON', 'GOOGLE_CHAT_ALLOWED_USERS',
  'GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE', 'GOOGLE_CHAT_HTTP_EVENTS_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_HTTP_EVENTS_URL', 'GOOGLE_CHAT_PROJECT_ID', 'GOOGLE_CHAT_SUBSCRIPTION_NAME',
  'WECOM_BOT_ID', 'WECOM_SECRET',
  'WECOM_CALLBACK_CORP_ID', 'WECOM_CALLBACK_CORP_SECRET', 'WECOM_CALLBACK_AGENT_ID',
  'WECOM_CALLBACK_TOKEN', 'WECOM_CALLBACK_ENCODING_AES_KEY',
  'WEIXIN_ACCOUNT_ID', 'WEIXIN_TOKEN', 'WEIXIN_BASE_URL',
  'QQ_APP_ID', 'QQ_CLIENT_SECRET', 'QQ_ALLOWED_USERS', 'QQ_GROUP_ALLOWED_USERS', 'QQ_SANDBOX',
  'BUZZ_RELAY_URL', 'BUZZ_PRIVATE_KEY', 'BUZZ_ALLOWED_USERS', 'BUZZ_AUTH_TAG', 'BUZZ_CHANNELS',
  'BUZZ_CLI_PATH', 'BUZZ_CREDENTIALS_FILE', 'BUZZ_POLL_INTERVAL', 'BUZZ_TRANSPORT',
  'PHOTON_PROJECT_ID', 'PHOTON_PROJECT_SECRET', 'PHOTON_ALLOWED_USERS', 'PHOTON_DASHBOARD_HOST',
  'PHOTON_MARKDOWN', 'PHOTON_MENTION_PATTERNS', 'PHOTON_NODE_BIN', 'PHOTON_REACTIONS',
  'PHOTON_SIDECAR_AUTOSTART', 'PHOTON_SIDECAR_PORT', 'PHOTON_SPECTRUM_HOST', 'PHOTON_TELEMETRY',
  'IRC_SERVER', 'IRC_CHANNEL', 'IRC_NICKNAME', 'IRC_ALLOWED_USERS', 'IRC_NICKSERV_PASSWORD',
  'IRC_PORT', 'IRC_SERVER_PASSWORD', 'IRC_USE_TLS',
  'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_ALLOWED_GROUPS', 'LINE_ALLOWED_ROOMS',
  'LINE_ALLOWED_USERS', 'LINE_HOST', 'LINE_PORT', 'LINE_PUBLIC_URL', 'LINE_SLOW_RESPONSE_THRESHOLD',
  'TEAMS_CLIENT_ID', 'TEAMS_CLIENT_SECRET', 'TEAMS_TENANT_ID', 'TEAMS_ALLOWED_USERS',
  'TEAMS_HOST', 'TEAMS_PORT',
  'NTFY_TOPIC', 'NTFY_ALLOWED_USERS', 'NTFY_MARKDOWN', 'NTFY_PUBLISH_TOPIC',
  'NTFY_SERVER_URL', 'NTFY_TOKEN', 'RAFT_PROFILE',
  'SIMPLEX_WS_URL', 'SIMPLEX_ALLOWED_USERS', 'SIMPLEX_AUTO_ACCEPT', 'SIMPLEX_GROUP_ALLOWED',
  'WEBHOOK_ENABLED', 'WEBHOOK_PORT', 'WEBHOOK_SECRET',
  'A2A_AGENT_NAME', 'A2A_BEARER_TOKEN', 'A2A_HOST', 'A2A_PEER_TOKENS', 'A2A_PORT',
] as const;

const HERMES_CHANNEL_ENV_KEY_SET = new Set<string>(HERMES_CHANNEL_ENV_KEYS);

export function withoutHermesChannelEnv(
  env: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !HERMES_CHANNEL_ENV_KEY_SET.has(key)),
  );
}

const HERMES_CHANNEL_ENV_KEYS_JSON = JSON.stringify(HERMES_CHANNEL_ENV_KEYS);

export const HERMES_ENV_MERGE_SCRIPT = String.raw`import json
import os
import pathlib
import re
import sys
import tempfile


# Hermes Channels owns these values in /opt/data/.env. Older ToolPlane
# versions allowed the same keys in Sandbox.config.env, so syncing could
# silently replace a newer Dashboard value with the stale database value.
# During the transition, preserve any value already on disk and only seed a
# legacy ToolPlane value when the channel has never written one.
CHANNEL_ENV_KEYS = set(${HERMES_CHANNEL_ENV_KEYS_JSON})


env_destination = pathlib.Path(sys.argv[1])
managed_env_path = pathlib.Path(sys.argv[2])
managed_keys_path = env_destination.parent / ".toolplane-env-keys.json"

try:
    managed_env = json.loads(
        sys.stdin.read() if str(managed_env_path) == "-"
        else managed_env_path.read_text(encoding="utf-8")
    )
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
assignment = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

try:
    existing_lines = env_destination.read_text(encoding="utf-8").splitlines()
except OSError:
    existing_lines = []
existing_keys = {
    match.group(1)
    for line in existing_lines
    if (match := assignment.match(line))
}
previous_key_set = {str(key) for key in previous_keys}
# Existing Dashboard channel values win. A legacy DB-only value is seeded once
# for compatibility, then released from ToolPlane ownership so future Dashboard
# edits and clears cannot be undone by a sync.
managed_env = {
    key: value for key, value in managed_env.items()
    if key not in CHANNEL_ENV_KEYS
    or (key not in existing_keys and key not in previous_key_set)
}
released_channel_keys = CHANNEL_ENV_KEYS & previous_key_set
owned_keys = (previous_key_set - released_channel_keys) | set(managed_env)
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
        json.dump(sorted(set(managed_env) - CHANNEL_ENV_KEYS), handle)
    os.chmod(keys_temporary, 0o600)
    os.replace(keys_temporary, managed_keys_path)
finally:
    if os.path.exists(keys_temporary):
        os.unlink(keys_temporary)
`;
