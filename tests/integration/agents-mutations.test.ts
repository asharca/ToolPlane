// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  createAgent,
  updateAgent,
  setAgentTools,
  setProviderModels,
  appendMessage,
  createConversation,
} from '@/lib/agents/mutations';
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  findAgentChannelByInboundToken,
  listAgentChannelConnections,
  updateAgentChannelConnectionCredentials,
} from '@/lib/agents/channel-connections';
import {
  applyAgentChannelPairing,
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from '@/lib/agents/channel-pairing';

let workspaceId = '';
let userId = '';
let deploymentId = '';
let providerId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `agents-m-${Date.now()}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: { slug: `agents-m-${Date.now()}`, name: 'M', ownerId: userId,
      members: { create: { userId, role: 'owner' } } },
  });
  workspaceId = ws.id;
  const server = await db.server.create({
    data: { slug: `srv-${Date.now()}`, name: 'Srv' },
  });
  const dep = await db.deployment.create({ data: { workspaceId, serverId: server.id } });
  deploymentId = dep.id;
  const provider = await db.modelProvider.create({
    data: { workspaceId, name: 'P', format: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' },
  });
  providerId = provider.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agents mutations', () => {
  it('creates an agent with a unique slug', async () => {
    const a = await createAgent(workspaceId, 'My Agent');
    expect(a.slug).toBe('my-agent');
    const b = await createAgent(workspaceId, 'My Agent');
    expect(b.slug).toBe('my-agent-1');
  });

  it('updates config and replaces the attached tools', async () => {
    const a = await createAgent(workspaceId, 'Cfg');
    await updateAgent(workspaceId, a.id, {
      name: 'Cfg2', systemPrompt: 'sp', providerId, model: 'gpt-x', maxSteps: 5,
    });
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId], installedSkillIds: [], toolkitIds: [],
    });
    const reread = await db.agent.findUnique({
      where: { id: a.id }, include: { servers: true },
    });
    expect(reread?.name).toBe('Cfg2');
    expect(reread?.model).toBe('gpt-x');
    expect(reread?.servers).toHaveLength(1);

    await setAgentTools(workspaceId, a.id, { deploymentIds: [], installedSkillIds: [], toolkitIds: [] });
    const after = await db.agent.findUnique({ where: { id: a.id }, include: { servers: true } });
    expect(after?.servers).toHaveLength(0);
  });

  it('caches provider models', async () => {
    await setProviderModels(workspaceId, providerId, ['gpt-x', 'gpt-y']);
    const p = await db.modelProvider.findUnique({ where: { id: providerId } });
    expect(p?.models).toEqual(['gpt-x', 'gpt-y']);
    expect(p?.modelsFetchedAt).toBeInstanceOf(Date);
  });

  it('creates a conversation and appends messages', async () => {
    const a = await createAgent(workspaceId, 'Chat');
    const conv = await createConversation(workspaceId, a.id);
    await appendMessage(conv!.id, 'user', [{ type: 'text', text: 'hi' }]);
    const msgs = await db.message.findMany({ where: { conversationId: conv!.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });

  it('drops cross-workspace tool ids in setAgentTools', async () => {
    const other = await db.workspace.create({
      data: { slug: `m-other-${Date.now()}`, name: 'O', ownerId: userId, members: { create: { userId, role: 'owner' } } },
    });
    const fserver = await db.server.create({ data: { slug: `fsrv-${Date.now()}`, name: 'F' } });
    const fdep = await db.deployment.create({ data: { workspaceId: other.id, serverId: fserver.id } });
    const a = await createAgent(workspaceId, 'Scope');
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId, fdep.id], installedSkillIds: [], toolkitIds: [],
    });
    const reread = await db.agent.findUnique({ where: { id: a.id }, include: { servers: true } });
    expect(reread?.servers.map((s) => s.deploymentId)).toEqual([deploymentId]);
    await db.workspace.delete({ where: { id: other.id } });
  });

  it('nulls a cross-workspace providerId in updateAgent', async () => {
    const other = await db.workspace.create({
      data: { slug: `m-o2-${Date.now()}`, name: 'O2', ownerId: userId, members: { create: { userId, role: 'owner' } } },
    });
    const fprov = await db.modelProvider.create({
      data: { workspaceId: other.id, name: 'FP', format: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' },
    });
    const a = await createAgent(workspaceId, 'ProvScope');
    await updateAgent(workspaceId, a.id, {
      name: 'ProvScope', systemPrompt: null, providerId: fprov.id, model: null, maxSteps: 8,
    });
    const reread = await db.agent.findUnique({ where: { id: a.id } });
    expect(reread?.providerId).toBeNull();
    await db.workspace.delete({ where: { id: other.id } });
  });

  it('refuses to create a conversation on an agent outside the workspace', async () => {
    const other = await db.workspace.create({
      data: { slug: `m-o3-${Date.now()}`, name: 'O3', ownerId: userId, members: { create: { userId, role: 'owner' } } },
    });
    const fagent = await db.agent.create({ data: { workspaceId: other.id, name: 'FA', slug: 'fa' } });
    const conv = await createConversation(workspaceId, fagent.id);
    expect(conv).toBeNull();
    await db.workspace.delete({ where: { id: other.id } });
  });

  it('creates encrypted platform-owned channel connections', async () => {
    const a = await createAgent(workspaceId, 'Channels');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'telegram',
      name: 'Telegram prod',
      credentials: {
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_ALLOWED_USERS: '42',
      },
    });
    expect(result.error).toBeUndefined();
    const connection = result.connection!;
    expect(connection.platform).toBe('telegram');
    expect(connection.inboundToken).toMatch(/^tpchan_/);
    expect(connection.credentialNames).toEqual(['TELEGRAM_ALLOWED_USERS', 'TELEGRAM_BOT_TOKEN']);

    const raw = await db.agentChannelConnection.findUnique({ where: { id: connection.id } });
    expect(JSON.stringify(raw?.credentials)).not.toContain('123:abc');

    const byToken = await findAgentChannelByInboundToken(connection.id, connection.inboundToken);
    expect(byToken?.id).toBe(connection.id);
    expect(await listAgentChannelConnections(workspaceId, a.id)).toHaveLength(1);

    await deleteAgentChannelConnection(workspaceId, connection.id);
    expect(await listAgentChannelConnections(workspaceId, a.id)).toHaveLength(0);
  });

  it('creates QR setup channels before scan-returned credentials exist', async () => {
    const a = await createAgent(workspaceId, 'WeCom QR');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'wecom',
      name: 'WeCom setup',
      credentials: {},
    });

    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe('setup_required');
    expect(result.connection?.missingStartCredentialNames).toEqual(expect.arrayContaining([
      'WECOM_BOT_ID',
      'WECOM_SECRET',
    ]));

    const updated = await updateAgentChannelConnectionCredentials({
      workspaceId,
      connectionId: result.connection!.id,
      credentials: {
        WECOM_BOT_ID: 'bot-id',
        WECOM_SECRET: 'secret',
      },
    });

    expect(updated.error).toBeUndefined();
    expect(updated.connection?.status).toBe('stopped');
    expect(updated.connection?.missingStartCredentialNames).toEqual([]);

    await deleteAgentChannelConnection(workspaceId, result.connection!.id);
  });

  it('requests WeCom QR and saves scan-returned credentials', async () => {
    const a = await createAgent(workspaceId, 'WeCom active QR');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'wecom',
      name: 'WeCom active setup',
      credentials: {},
    });
    const connectionId = result.connection!.id;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/generate')) {
        return new Response(JSON.stringify({
          data: { scode: 'scode-1', auth_url: 'https://work.weixin.qq.com/auth/qr' },
        }), { status: 200 });
      }
      if (url.includes('/query_result')) {
        return new Response(JSON.stringify({
          data: {
            status: 'success',
            bot_info: { botid: 'bot-id', secret: 'secret' },
          },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const requested = await requestAgentChannelPairing(workspaceId, connectionId);
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.qrPayload).toBe('https://work.weixin.qq.com/auth/qr');

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.status).toBe('waiting');
    expect(afterRequest[0].pairing?.providerSessionId).toBe('scode-1');

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe('stopped');
    expect(afterCheck[0].pairing?.status).toBe('ready');
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);

    const raw = await db.agentChannelConnection.findUnique({ where: { id: connectionId } });
    expect(JSON.stringify(raw?.credentials)).not.toContain('secret');

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });

  it('requests Telegram managed-bot QR, waits for ready, then applies allowed users', async () => {
    const a = await createAgent(workspaceId, 'Telegram active QR');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'telegram',
      name: 'Telegram active setup',
      credentials: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe('setup_required');
    const connectionId = result.connection!.id;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/telegram/pairings') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          pairing_id: 'tg-pair-1',
          poll_token: 'poll-secret',
          suggested_username: 'toolplane_pair_bot',
          deep_link: 'https://t.me/newbot/HermesSetupBot/toolplane_pair_bot',
          qr_payload: 'https://t.me/newbot/HermesSetupBot/toolplane_pair_bot',
          expires_at: '2027-05-18T00:00:00.000Z',
        }), { status: 200 });
      }
      if (url.endsWith('/v1/telegram/pairings/tg-pair-1')) {
        expect(init?.headers).toEqual(expect.objectContaining({
          Authorization: 'Bearer poll-secret',
        }));
        return new Response(JSON.stringify({
          status: 'ready',
          token: '123456:SECRETabcdefghijklmnopqrstuvwxyz1234',
          bot_username: 'toolplane_pair_bot',
          owner_user_id: 123456789,
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const requested = await requestAgentChannelPairing(workspaceId, connectionId);
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.provider).toBe('telegram_managed_bot');
    expect(requested.pairing?.qrPayload).toBe('https://t.me/newbot/HermesSetupBot/toolplane_pair_bot');

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterReady = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterReady[0].pairing?.status).toBe('ready');
    expect(afterReady[0].pairing?.extra?.botUsername).toBe('toolplane_pair_bot');
    expect(afterReady[0].pairing?.extra?.ownerUserId).toBe('123456789');
    expect(afterReady[0].missingStartCredentialNames).toEqual(['TELEGRAM_BOT_TOKEN']);

    const applied = await applyAgentChannelPairing(workspaceId, connectionId, '');
    expect(applied.error).toBeUndefined();

    const afterApply = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterApply[0].status).toBe('stopped');
    expect(afterApply[0].missingStartCredentialNames).toEqual([]);
    expect(afterApply[0].credentialNames).toEqual(['TELEGRAM_BOT_TOKEN']);

    const raw = await db.agentChannelConnection.findUnique({ where: { id: connectionId } });
    expect(JSON.stringify(raw?.credentials)).not.toContain('SECRET');
    expect(JSON.stringify(raw?.config)).not.toContain('poll-secret');

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });

  it('requests Weixin QR and saves confirmed login credentials', async () => {
    const a = await createAgent(workspaceId, 'Weixin active QR');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'weixin',
      name: 'Weixin active setup',
      credentials: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe('setup_required');
    expect(result.connection?.missingStartCredentialNames).toEqual(expect.arrayContaining([
      'WEIXIN_ACCOUNT_ID',
      'WEIXIN_TOKEN',
    ]));
    const connectionId = result.connection!.id;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/get_bot_qrcode')) {
        return new Response(JSON.stringify({
          qrcode: 'qr-token-1',
          qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/scan/1',
        }), { status: 200 });
      }
      if (url.includes('/get_qrcode_status')) {
        return new Response(JSON.stringify({
          status: 'confirmed',
          ilink_bot_id: 'wx-account-1',
          bot_token: 'wx-token-1',
          baseurl: 'https://weixin-next.example.com',
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const requested = await requestAgentChannelPairing(workspaceId, connectionId);
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.qrPayload).toBe('https://ilinkai.weixin.qq.com/qr/scan/1');

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.provider).toBe('weixin_ilink_qr');
    expect(afterRequest[0].pairing?.providerSessionId).toBe('qr-token-1');

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe('stopped');
    expect(afterCheck[0].pairing?.status).toBe('ready');
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);
    expect(afterCheck[0].runnerSupported).toBe(true);
    expect(afterCheck[0].credentialNames).toEqual(['WEIXIN_ACCOUNT_ID', 'WEIXIN_BASE_URL', 'WEIXIN_TOKEN']);

    const raw = await db.agentChannelConnection.findUnique({ where: { id: connectionId } });
    expect(JSON.stringify(raw?.credentials)).not.toContain('wx-token-1');

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });

  it('requests DingTalk device QR and saves registered credentials', async () => {
    const a = await createAgent(workspaceId, 'DingTalk active QR');
    const result = await createAgentChannelConnection({
      workspaceId,
      agentId: a.id,
      platform: 'dingtalk',
      name: 'DingTalk active setup',
      credentials: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.connection?.status).toBe('setup_required');
    const connectionId = result.connection!.id;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (url.endsWith('/app/registration/init')) {
        expect(body.source).toBe('openClaw');
        return new Response(JSON.stringify({
          errcode: 0,
          nonce: 'nonce-1',
        }), { status: 200 });
      }
      if (url.endsWith('/app/registration/begin')) {
        expect(body.nonce).toBe('nonce-1');
        return new Response(JSON.stringify({
          errcode: 0,
          device_code: 'device-1',
          verification_uri_complete: 'https://oapi.dingtalk.com/device/verify?code=1',
          expires_in: 7200,
          interval: 3,
        }), { status: 200 });
      }
      if (url.endsWith('/app/registration/poll')) {
        expect(body.device_code).toBe('device-1');
        return new Response(JSON.stringify({
          errcode: 0,
          status: 'SUCCESS',
          client_id: 'ding-client-id',
          client_secret: 'ding-client-secret',
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const requested = await requestAgentChannelPairing(workspaceId, connectionId);
    expect(requested.error).toBeUndefined();
    expect(requested.pairing?.provider).toBe('dingtalk_device_qr');
    expect(requested.pairing?.qrPayload).toBe('https://oapi.dingtalk.com/device/verify?code=1');

    const afterRequest = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterRequest[0].pairing?.status).toBe('waiting');
    expect(afterRequest[0].pairing?.providerSessionId).toBe('device-1');

    const checked = await checkAgentChannelPairing(workspaceId, connectionId);
    expect(checked.error).toBeUndefined();

    const afterCheck = await listAgentChannelConnections(workspaceId, a.id);
    expect(afterCheck[0].status).toBe('stopped');
    expect(afterCheck[0].pairing?.status).toBe('ready');
    expect(afterCheck[0].missingStartCredentialNames).toEqual([]);
    expect(afterCheck[0].credentialNames).toEqual(['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET']);

    const raw = await db.agentChannelConnection.findUnique({ where: { id: connectionId } });
    expect(JSON.stringify(raw?.credentials)).not.toContain('ding-client-secret');

    await deleteAgentChannelConnection(workspaceId, connectionId);
  });
});
