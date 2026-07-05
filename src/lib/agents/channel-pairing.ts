import 'server-only';
import { db } from '@/lib/db';
import { updateAgentChannelConnectionCredentials } from '@/lib/agents/channel-connections';
import { configWithPairing, pairingFromConfig, type AgentChannelPairingState } from '@/lib/agents/channel-pairing-state';
import { getMessagingPlatform } from '@/lib/agents/platforms';
import { decryptSecretRecord, encryptSecretRecord } from '@/lib/security/secrets';

const TELEGRAM_ONBOARDING_DEFAULT_URL = 'https://setup.hermes-agent.nousresearch.com';
const WECOM_QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate';
const WECOM_QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result';
const WECOM_QR_CODE_PAGE = 'https://work.weixin.qq.com/ai/qc/gen?source=toolplane&scode=';
const WEIXIN_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const WEIXIN_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';
const WEIXIN_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const DINGTALK_REGISTRATION_DEFAULT_BASE_URL = 'https://oapi.dingtalk.com';
const DINGTALK_REGISTRATION_DEFAULT_SOURCE = 'openClaw';

type ChannelRow = NonNullable<Awaited<ReturnType<typeof db.agentChannelConnection.findFirst>>>;

function expiresIn(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON response.');
  return parsed as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function telegramOnboardingBaseUrl() {
  return (process.env.TELEGRAM_ONBOARDING_URL || TELEGRAM_ONBOARDING_DEFAULT_URL).trim().replace(/\/$/, '');
}

function dingtalkRegistrationBaseUrl() {
  return (process.env.DINGTALK_REGISTRATION_BASE_URL || DINGTALK_REGISTRATION_DEFAULT_BASE_URL).trim().replace(/\/$/, '');
}

function dingtalkRegistrationSource() {
  return (process.env.DINGTALK_REGISTRATION_SOURCE || DINGTALK_REGISTRATION_DEFAULT_SOURCE).trim() || DINGTALK_REGISTRATION_DEFAULT_SOURCE;
}

function pairingSecrets(row: ChannelRow) {
  try {
    const config = record(row.config);
    return decryptSecretRecord(record(config.pairingSecrets));
  } catch {
    return {};
  }
}

async function updatePairing(row: ChannelRow, pairing: AgentChannelPairingState, secrets?: Record<string, string>) {
  const updated = await db.agentChannelConnection.update({
    where: { id: row.id },
    data: {
      config: configWithPairing(
        row.config,
        pairing,
        secrets === undefined ? undefined : encryptSecretRecord(secrets),
      ),
      lastError: pairing.error ?? null,
    },
  });
  return updated;
}

async function requestTelegramPairing(): Promise<{ pairing: AgentChannelPairingState; secrets: Record<string, string> }> {
  const raw = await jsonFetch(`${telegramOnboardingBaseUrl()}/v1/telegram/pairings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ToolPlane/1.0',
    },
    body: JSON.stringify({ bot_name: 'ToolPlane Agent' }),
  });
  const pairingId = text(raw.pairing_id);
  const pollToken = text(raw.poll_token);
  const expiresAt = text(raw.expires_at);
  const deepLink = text(raw.deep_link);
  const qrPayload = text(raw.qr_payload) || deepLink;
  const suggestedUsername = text(raw.suggested_username);
  if (!pairingId || !pollToken || !expiresAt || !deepLink || !qrPayload) {
    throw new Error('Telegram setup service returned an incomplete response.');
  }
  return {
    pairing: {
      provider: 'telegram_managed_bot',
      status: 'waiting',
      qrPayload,
      scanUrl: deepLink,
      providerSessionId: pairingId,
      requestedAt: new Date().toISOString(),
      expiresAt,
      message: 'Scan this QR in Telegram to create the managed bot, then check setup status.',
      extra: {
        deepLink,
        suggestedUsername,
      },
    },
    secrets: { pollToken },
  };
}

async function checkTelegramPairing(row: ChannelRow, pairing: AgentChannelPairingState) {
  const pairingId = pairing.providerSessionId;
  if (!pairingId) throw new Error('Telegram pairing session is missing pairing id.');
  const secrets = pairingSecrets(row);
  const pollToken = secrets.pollToken;
  if (!pollToken) throw new Error('Telegram pairing session is missing poll token.');

  const raw = await jsonFetch(`${telegramOnboardingBaseUrl()}/v1/telegram/pairings/${encodeURIComponent(pairingId)}`, {
    headers: {
      Authorization: `Bearer ${pollToken}`,
      'User-Agent': 'ToolPlane/1.0',
    },
  });
  const status = text(raw.status);
  if (status === 'ready') {
    const botToken = text(raw.token);
    const botUsername = text(raw.bot_username);
    const ownerUserId = text(raw.owner_user_id);
    if (!botToken) throw new Error('Telegram setup service did not return a bot token.');
    await updatePairing(row, {
      ...pairing,
      status: 'ready',
      lastCheckedAt: new Date().toISOString(),
      message: ownerUserId
        ? 'Telegram bot is ready. Confirm the allowed user ID below before saving.'
        : 'Telegram bot is ready. Add at least one numeric Telegram user ID before saving.',
      error: undefined,
      extra: {
        ...pairing.extra,
        botUsername,
        ownerUserId,
      },
    }, { ...secrets, botToken });
    return;
  }
  await updatePairing(row, {
    ...pairing,
    status: Date.parse(pairing.expiresAt ?? '') < Date.now() ? 'expired' : 'waiting',
    lastCheckedAt: new Date().toISOString(),
    message: 'Waiting for Telegram managed bot confirmation.',
    error: undefined,
  }, secrets);
}

async function requestWeComPairing(): Promise<AgentChannelPairingState> {
  const raw = await jsonFetch(`${WECOM_QR_GENERATE_URL}?source=toolplane`, {
    headers: { 'User-Agent': 'ToolPlane/1.0' },
  });
  const data = record(raw.data);
  const scode = text(data.scode);
  const authUrl = text(data.auth_url);
  if (!scode || !authUrl) throw new Error('WeCom returned an incomplete QR response.');
  return {
    provider: 'wecom_admin_qr',
    status: 'waiting',
    qrPayload: authUrl,
    scanUrl: `${WECOM_QR_CODE_PAGE}${encodeURIComponent(scode)}`,
    providerSessionId: scode,
    requestedAt: new Date().toISOString(),
    expiresAt: expiresIn(300),
    message: 'Scan this QR in WeCom to create or authorize the AI Bot.',
  };
}

async function checkWeComPairing(row: ChannelRow, pairing: AgentChannelPairingState) {
  const scode = pairing.providerSessionId;
  if (!scode) throw new Error('WeCom pairing session is missing scode.');
  const raw = await jsonFetch(`${WECOM_QR_QUERY_URL}?scode=${encodeURIComponent(scode)}`, {
    headers: { 'User-Agent': 'ToolPlane/1.0' },
  });
  const data = record(raw.data);
  const status = text(data.status).toLowerCase();
  if (status === 'success') {
    const botInfo = record(data.bot_info);
    const botId = text(botInfo.botid) || text(botInfo.bot_id);
    const secret = text(botInfo.secret);
    if (!botId || !secret) throw new Error('WeCom scan succeeded, but Bot ID or Secret was missing.');
    await updateAgentChannelConnectionCredentials({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      credentials: {
        WECOM_BOT_ID: botId,
        WECOM_SECRET: secret,
      },
    });
    const latest = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: row.id } });
    await updatePairing(latest, {
      ...pairing,
      status: 'ready',
      qrPayload: undefined,
      lastCheckedAt: new Date().toISOString(),
      message: 'WeCom scan completed. Bot ID and Secret were saved.',
      error: undefined,
    });
    return;
  }
  await updatePairing(row, {
    ...pairing,
    status: Date.parse(pairing.expiresAt ?? '') < Date.now() ? 'expired' : 'waiting',
    lastCheckedAt: new Date().toISOString(),
    message: status ? `WeCom status: ${status}` : 'Waiting for WeCom scan.',
    error: undefined,
  });
}

async function requestWeixinPairing(): Promise<AgentChannelPairingState> {
  const url = `${WEIXIN_ILINK_BASE_URL}/${WEIXIN_GET_BOT_QR}?bot_type=3`;
  const raw = await jsonFetch(url, {
    headers: {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(WEIXIN_APP_CLIENT_VERSION),
    },
  });
  const qrcode = text(raw.qrcode);
  const qrcodeUrl = text(raw.qrcode_img_content);
  if (!qrcode) throw new Error('Weixin returned an incomplete QR response.');
  return {
    provider: 'weixin_ilink_qr',
    status: 'waiting',
    qrPayload: qrcodeUrl || qrcode,
    scanUrl: qrcodeUrl || undefined,
    providerSessionId: qrcode,
    requestedAt: new Date().toISOString(),
    expiresAt: expiresIn(480),
    message: 'Scan this QR in WeChat and confirm login.',
    extra: { baseUrl: WEIXIN_ILINK_BASE_URL },
  };
}

async function checkWeixinPairing(row: ChannelRow, pairing: AgentChannelPairingState) {
  const qrcode = pairing.providerSessionId;
  if (!qrcode) throw new Error('Weixin pairing session is missing QR id.');
  const baseUrl = pairing.extra?.baseUrl || WEIXIN_ILINK_BASE_URL;
  const raw = await jsonFetch(`${baseUrl}/${WEIXIN_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`, {
    headers: {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(WEIXIN_APP_CLIENT_VERSION),
    },
  });
  const status = text(raw.status) || 'wait';
  if (status === 'confirmed') {
    const accountId = text(raw.ilink_bot_id);
    const token = text(raw.bot_token);
    const nextBaseUrl = text(raw.baseurl) || baseUrl;
    if (!accountId || !token) throw new Error('Weixin login confirmed, but account ID or token was missing.');
    await updateAgentChannelConnectionCredentials({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      credentials: {
        WEIXIN_ACCOUNT_ID: accountId,
        WEIXIN_TOKEN: token,
        WEIXIN_BASE_URL: nextBaseUrl,
      },
    });
    const latest = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: row.id } });
    await updatePairing(latest, {
      ...pairing,
      status: 'ready',
      qrPayload: undefined,
      lastCheckedAt: new Date().toISOString(),
      message: 'Weixin login completed. Account ID and token were saved.',
      error: undefined,
      extra: { baseUrl: nextBaseUrl },
    });
    return;
  }
  if (status === 'scaned_but_redirect') {
    const redirectHost = text(raw.redirect_host);
    await updatePairing(row, {
      ...pairing,
      status: 'scanned',
      lastCheckedAt: new Date().toISOString(),
      message: 'Scanned. Waiting for confirmation in WeChat.',
      extra: redirectHost ? { baseUrl: `https://${redirectHost}` } : pairing.extra,
    });
    return;
  }
  await updatePairing(row, {
    ...pairing,
    status: status === 'expired' ? 'expired' : status === 'scaned' ? 'scanned' : 'waiting',
    lastCheckedAt: new Date().toISOString(),
    message: status === 'scaned' ? 'Scanned. Confirm login in WeChat.' : `Weixin status: ${status}`,
    error: undefined,
  });
}

async function dingtalkRegistrationPost(path: string, payload: Record<string, unknown>) {
  const raw = await jsonFetch(`${dingtalkRegistrationBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ToolPlane/1.0',
    },
    body: JSON.stringify(payload),
  });
  if (raw.errcode !== undefined && Number(raw.errcode) !== 0) {
    throw new Error(`DingTalk ${path} failed: ${text(raw.errmsg) || `errcode ${text(raw.errcode)}`}`);
  }
  return raw;
}

async function requestDingTalkPairing(): Promise<AgentChannelPairingState> {
  const init = await dingtalkRegistrationPost('/app/registration/init', {
    source: dingtalkRegistrationSource(),
  });
  const nonce = text(init.nonce);
  if (!nonce) throw new Error('DingTalk registration init response missing nonce.');

  const begin = await dingtalkRegistrationPost('/app/registration/begin', { nonce });
  const deviceCode = text(begin.device_code);
  const verificationUrl = text(begin.verification_uri_complete);
  if (!deviceCode || !verificationUrl) {
    throw new Error('DingTalk registration begin response missing device code or verification URL.');
  }
  const expiresInSeconds = Math.max(numberValue(begin.expires_in, 7200), 60);
  const interval = Math.max(numberValue(begin.interval, 3), 2);

  return {
    provider: 'dingtalk_device_qr',
    status: 'waiting',
    qrPayload: verificationUrl,
    scanUrl: verificationUrl,
    providerSessionId: deviceCode,
    requestedAt: new Date().toISOString(),
    expiresAt: expiresIn(expiresInSeconds),
    message: 'Scan this QR in DingTalk to authorize Stream Mode credentials.',
    extra: {
      interval: String(interval),
      source: dingtalkRegistrationSource(),
    },
  };
}

async function checkDingTalkPairing(row: ChannelRow, pairing: AgentChannelPairingState) {
  const deviceCode = pairing.providerSessionId;
  if (!deviceCode) throw new Error('DingTalk pairing session is missing device code.');
  const raw = await dingtalkRegistrationPost('/app/registration/poll', { device_code: deviceCode });
  const status = text(raw.status).toUpperCase();

  if (status === 'SUCCESS') {
    const clientId = text(raw.client_id);
    const clientSecret = text(raw.client_secret);
    if (!clientId || !clientSecret) {
      throw new Error('DingTalk authorization succeeded, but Client ID or Client Secret was missing.');
    }
    await updateAgentChannelConnectionCredentials({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      credentials: {
        DINGTALK_CLIENT_ID: clientId,
        DINGTALK_CLIENT_SECRET: clientSecret,
      },
    });
    const latest = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: row.id } });
    await updatePairing(latest, {
      ...pairing,
      status: 'ready',
      qrPayload: undefined,
      lastCheckedAt: new Date().toISOString(),
      message: 'DingTalk authorization completed. Client ID and Client Secret were saved.',
      error: undefined,
    });
    return;
  }

  if (status === 'WAITING') {
    await updatePairing(row, {
      ...pairing,
      status: Date.parse(pairing.expiresAt ?? '') < Date.now() ? 'expired' : 'waiting',
      lastCheckedAt: new Date().toISOString(),
      message: 'Waiting for DingTalk QR authorization.',
      error: undefined,
    });
    return;
  }

  if (status === 'EXPIRED') {
    await updatePairing(row, {
      ...pairing,
      status: 'expired',
      lastCheckedAt: new Date().toISOString(),
      message: 'DingTalk authorization expired. Request a new QR code.',
      error: undefined,
    });
    return;
  }

  const reason = text(raw.fail_reason) || status || 'unknown status';
  await updatePairing(row, {
    ...pairing,
    status: 'error',
    lastCheckedAt: new Date().toISOString(),
    message: `DingTalk authorization failed: ${reason}`,
    error: reason,
  });
}

function unsupportedPairing(platform: string): AgentChannelPairingState {
  return {
    provider: 'external_setup_runner',
    status: 'error',
    requestedAt: new Date().toISOString(),
    message: 'No active setup runner is configured for this platform yet.',
    error: `Set up a ToolPlane pairing provider for ${platform}.`,
  };
}

export async function requestAgentChannelPairing(workspaceId: string, connectionId: string) {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  const platform = getMessagingPlatform(row.platform);
  if (!platform?.pairing) return { error: 'This platform does not use QR pairing.' };

  try {
    const requested =
      platform.pairing.provider === 'telegram_managed_bot'
        ? await requestTelegramPairing()
        : platform.pairing.provider === 'wecom_admin_qr'
          ? { pairing: await requestWeComPairing(), secrets: undefined }
          : platform.pairing.provider === 'weixin_ilink_qr'
            ? { pairing: await requestWeixinPairing(), secrets: undefined }
            : platform.pairing.provider === 'dingtalk_device_qr'
              ? { pairing: await requestDingTalkPairing(), secrets: undefined }
              : { pairing: unsupportedPairing(platform.slug), secrets: undefined };
    await updatePairing(row, requested.pairing, requested.secrets);
    const pairing = requested.pairing;
    return { pairing };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request QR.';
    const pairing: AgentChannelPairingState = {
      provider: platform.pairing.provider,
      status: 'error',
      requestedAt: new Date().toISOString(),
      message,
      error: message,
    };
    await updatePairing(row, pairing);
    return { error: message, pairing };
  }
}

export async function checkAgentChannelPairing(workspaceId: string, connectionId: string) {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  const platform = getMessagingPlatform(row.platform);
  if (!platform?.pairing) return { error: 'This platform does not use QR pairing.' };
  const pairing = pairingFromConfig(row.config);
  if (!pairing) return { error: 'Request a QR code first.' };

  try {
    if (pairing.provider === 'telegram_managed_bot') {
      await checkTelegramPairing(row, pairing);
    } else if (pairing.provider === 'wecom_admin_qr') {
      await checkWeComPairing(row, pairing);
    } else if (pairing.provider === 'weixin_ilink_qr') {
      await checkWeixinPairing(row, pairing);
    } else if (pairing.provider === 'dingtalk_device_qr') {
      await checkDingTalkPairing(row, pairing);
    } else {
      await updatePairing(row, unsupportedPairing(platform.slug));
      return { error: `No active setup runner is configured for ${platform.label}.` };
    }
    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to check QR scan.';
    await updatePairing(row, {
      ...pairing,
      status: 'error',
      lastCheckedAt: new Date().toISOString(),
      error: message,
      message,
    });
    return { error: message };
  }
}

export async function applyAgentChannelPairing(workspaceId: string, connectionId: string, allowedUserIdsText: string) {
  const row = await db.agentChannelConnection.findFirst({ where: { id: connectionId, workspaceId } });
  if (!row) return { error: 'Channel connection not found.' };
  const platform = getMessagingPlatform(row.platform);
  if (platform?.slug !== 'telegram') return { error: 'Only Telegram QR setup needs an apply step.' };
  const pairing = pairingFromConfig(row.config);
  if (pairing?.provider !== 'telegram_managed_bot') return { error: 'Request Telegram QR setup first.' };
  if (pairing.status !== 'ready') return { error: 'Telegram setup is not ready yet.' };
  const secrets = pairingSecrets(row);
  const botToken = secrets.botToken;
  if (!botToken) return { error: 'Telegram setup token is missing. Start a new QR setup.' };

  const allowedUserIds = Array.from(new Set(
    allowedUserIdsText
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  const invalid = allowedUserIds.find((value) => !/^\d+$/.test(value));
  if (invalid) return { error: `Allowed Telegram user IDs must be numeric: ${invalid}` };

  const updated = await updateAgentChannelConnectionCredentials({
    workspaceId: row.workspaceId,
    connectionId: row.id,
    credentials: {
      TELEGRAM_BOT_TOKEN: botToken,
      ...(allowedUserIds.length ? { TELEGRAM_ALLOWED_USERS: allowedUserIds.join(',') } : {}),
    },
  });
  if (updated.error) return updated;
  const latest = await db.agentChannelConnection.findUniqueOrThrow({ where: { id: row.id } });
  await updatePairing(latest, {
    ...pairing,
    status: 'ready',
    qrPayload: undefined,
    lastCheckedAt: new Date().toISOString(),
    message: 'Telegram setup saved. Start the hosted runner when ready.',
    error: undefined,
    extra: {
      ...pairing.extra,
      ...(allowedUserIds.length ? { allowedUserIds: allowedUserIds.join(',') } : { allowedUserIds: '*' }),
    },
  }, {});
  return {};
}
