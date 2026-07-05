#!/usr/bin/env python3
import asyncio
import importlib
import json
import os
import signal
import sys
import urllib.error
import urllib.request


PLATFORM = os.environ["TOOLPLANE_MESSAGING_PLATFORM"]
SERVER_URL = os.environ["TOOLPLANE_SERVER_URL"].rstrip("/")
CONNECTION_ID = os.environ["TOOLPLANE_CHANNEL_CONNECTION_ID"]
CHANNEL_TOKEN = os.environ["TOOLPLANE_CHANNEL_TOKEN"]
HERMES_ROOT = os.environ["HERMES_ROOT"]

ADAPTERS = {
    "telegram": ("plugins.platforms.telegram.adapter", "TelegramAdapter", "TELEGRAM_BOT_TOKEN"),
    "slack": ("plugins.platforms.slack.adapter", "SlackAdapter", "SLACK_BOT_TOKEN"),
    "discord": ("plugins.platforms.discord.adapter", "DiscordAdapter", "DISCORD_BOT_TOKEN"),
    "wecom": ("plugins.platforms.wecom.adapter", "WeComAdapter", None),
    "weixin": ("gateway.platforms.weixin", "WeixinAdapter", "WEIXIN_TOKEN"),
    "dingtalk": ("plugins.platforms.dingtalk.adapter", "DingTalkAdapter", None),
}


def die(message, code=1):
    print(f"[agent-channel-runner] {message}", file=sys.stderr)
    raise SystemExit(code)


def env(name, required=False):
    value = os.environ.get(name, "").strip()
    if required and not value:
        die(f"missing required environment variable: {name}")
    return value


def platform_extra(platform):
    if platform == "telegram":
        if not env("TELEGRAM_ALLOWED_USERS"):
            os.environ["TELEGRAM_ALLOWED_USERS"] = "*"
            os.environ["TELEGRAM_ALLOW_ALL_USERS"] = "true"
        extra = {}
        optional_map = {
            "allow_from": "TELEGRAM_ALLOWED_USERS",
            "allowed_chats": "TELEGRAM_ALLOWED_CHATS",
            "allowed_topics": "TELEGRAM_ALLOWED_TOPICS",
        }
        for key, env_name in optional_map.items():
            value = env(env_name)
            if value:
                extra[key] = [item.strip() for item in value.split(",") if item.strip()]
        return extra
    if platform == "wecom":
        extra = {
            "bot_id": env("WECOM_BOT_ID", True),
            "secret": env("WECOM_SECRET", True),
        }
        ws_url = env("WECOM_WEBSOCKET_URL")
        if ws_url:
            extra["websocket_url"] = ws_url
        return extra
    if platform == "weixin":
        extra = {
            "token": env("WEIXIN_TOKEN", True),
            "account_id": env("WEIXIN_ACCOUNT_ID", True),
        }
        optional_map = {
            "base_url": "WEIXIN_BASE_URL",
            "cdn_base_url": "WEIXIN_CDN_BASE_URL",
            "allow_from": "WEIXIN_ALLOWED_USERS",
            "dm_policy": "WEIXIN_DM_POLICY",
            "group_policy": "WEIXIN_GROUP_POLICY",
            "group_allow_from": "WEIXIN_GROUP_ALLOWED_USERS",
            "split_multiline_messages": "WEIXIN_SPLIT_MULTILINE_MESSAGES",
        }
        for key, env_name in optional_map.items():
            value = env(env_name)
            if value:
                extra[key] = value
        return extra
    if platform == "dingtalk":
        extra = {
            "client_id": env("DINGTALK_CLIENT_ID", True),
            "client_secret": env("DINGTALK_CLIENT_SECRET", True),
        }
        optional_map = {
            "allowed_users": "DINGTALK_ALLOWED_USERS",
            "require_mention": "DINGTALK_REQUIRE_MENTION",
            "free_response_chats": "DINGTALK_FREE_RESPONSE_CHATS",
            "allowed_chats": "DINGTALK_ALLOWED_CHATS",
            "webhook_url": "DINGTALK_WEBHOOK_URL",
        }
        for key, env_name in optional_map.items():
            value = env(env_name)
            if value:
                extra[key] = value
        return extra
    return {}


def message_type(value):
    raw = getattr(value, "value", value)
    if raw in ("photo", "sticker"):
        return "image"
    if raw == "document":
        return "file"
    return raw if raw in ("text", "command", "image", "file", "audio", "voice", "video", "location") else "text"


def source_payload(source):
    platform_value = getattr(getattr(source, "platform", None), "value", None) or PLATFORM
    return {
        "platform": platform_value,
        "chatId": getattr(source, "chat_id", None),
        "chatName": getattr(source, "chat_name", None),
        "chatType": getattr(source, "chat_type", None) or "dm",
        "userId": getattr(source, "user_id", None),
        "userName": getattr(source, "user_name", None),
        "threadId": getattr(source, "thread_id", None),
        "parentChatId": getattr(source, "parent_chat_id", None),
        "scopeId": getattr(source, "scope_id", None) or getattr(source, "guild_id", None),
        "messageId": getattr(source, "message_id", None),
    }


def attachments(event):
    urls = list(getattr(event, "media_urls", None) or [])
    types = list(getattr(event, "media_types", None) or [])
    out = []
    for index, url in enumerate(urls):
        raw_type = types[index] if index < len(types) else "file"
        kind = message_type(raw_type)
        out.append({"type": kind, "url": str(url), "name": os.path.basename(str(url))})
    return out


def compact(value):
    if isinstance(value, dict):
        return {str(k): compact(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [compact(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def event_payload(event):
    raw_metadata = getattr(event, "metadata", None)
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    return {
        "message": getattr(event, "text", "") or "",
        "messageType": message_type(getattr(event, "message_type", "text")),
        "source": source_payload(getattr(event, "source", None)),
        "messageId": getattr(event, "message_id", None),
        "attachments": attachments(event),
        "metadata": {
            "hermes": {
                "platform": PLATFORM,
                "messageId": getattr(event, "message_id", None),
                "platformUpdateId": getattr(event, "platform_update_id", None),
                "replyToMessageId": getattr(event, "reply_to_message_id", None),
                "replyToText": getattr(event, "reply_to_text", None),
            },
            **compact(metadata),
        },
    }


async def call_toolplane(event):
    payload = event_payload(event)
    if not payload["message"].strip() and payload["attachments"]:
        payload["message"] = "Attachment event"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    url = f"{SERVER_URL}/api/v1/agent-channels/{CONNECTION_ID}/events"
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "authorization": f"Bearer {CHANNEL_TOKEN}",
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "toolplane-agent-channel-runner",
        },
        method="POST",
    )

    def request():
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                body = res.read().decode("utf-8")
                return json.loads(body or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ToolPlane returned HTTP {exc.code}: {detail}") from exc

    body = await asyncio.to_thread(request)
    if body.get("delivery") == "silent":
        return None
    message = body.get("message")
    return message if isinstance(message, str) and message.strip() else None


async def main():
    if PLATFORM not in ADAPTERS:
        die(f"unsupported platform runner: {PLATFORM}")
    if not os.path.isdir(HERMES_ROOT):
        die(f"Hermes root does not exist: {HERMES_ROOT}")
    if HERMES_ROOT not in sys.path:
        sys.path.insert(0, HERMES_ROOT)

    try:
        from gateway.config import PlatformConfig
    except Exception as exc:
        die(f"could not import Hermes from {HERMES_ROOT}: {exc}")

    import_path, class_name, token_env = ADAPTERS[PLATFORM]
    token = env(token_env, True) if token_env else None
    try:
        module = importlib.import_module(import_path)
        adapter_cls = getattr(module, class_name)
    except Exception as exc:
        die(f"could not load Hermes adapter {import_path}.{class_name}: {exc}")

    config = PlatformConfig(
        enabled=True,
        token=token,
        extra=platform_extra(PLATFORM),
        gateway_restart_notification=False,
    )
    adapter = adapter_cls(config)
    adapter.set_message_handler(call_toolplane)

    print(f"[agent-channel-runner] starting {class_name} for {PLATFORM}", flush=True)
    connected = await adapter.connect()
    if not connected:
        die(f"Hermes adapter did not connect for {PLATFORM}", 2)
    print(f"[agent-channel-runner] connected {PLATFORM} channel {CONNECTION_ID}", flush=True)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    await stop.wait()
    try:
        await adapter.disconnect()
    except Exception as exc:
        print(f"[agent-channel-runner] disconnect failed: {exc}", file=sys.stderr)


asyncio.run(main())
