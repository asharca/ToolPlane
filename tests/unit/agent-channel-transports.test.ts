// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeixinBot } from '@/lib/agents/channels/adapters/wechat/WeChatProtocol';
import { createChannelAdapter } from '@/lib/agents/channels/create-adapter';
import { channelFetch, sanitizeRemoteUrl } from '@/lib/agents/channels/http';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const credentials = { token: 'private-wechat-token', accountId: 'account', userId: '', baseUrl: 'https://ilinkai.weixin.qq.com' };
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

describe('Cherry native transports', () => {
  it('creates all six adapters without a Hermes checkout or subprocess', async () => {
    vi.stubEnv('TOOLPLANE_HERMES_ROOT', '');
    vi.stubEnv('HERMES_ROOT', '');
    for (const platform of ['telegram', 'weixin', 'feishu', 'discord', 'slack', 'qqbot']) {
      const instance = await createChannelAdapter({ id: platform, agentId: 'dsh-agent', platform, credentials: {} });
      expect(instance.channelId).toBe(platform);
      expect(instance.agentId).toBe('dsh-agent');
      expect(instance.connected).toBe(false);
    }
  });

  it('polls iLink with stored credentials and replies using the inbound context token', async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('/getupdates') ? {
      ret: 0, get_updates_buf: 'cursor', msgs: [{
        message_id: '9007199254740994', from_user_id: 'friend', to_user_id: 'account', client_id: '',
        create_time_ms: Date.now(), message_type: 1, message_state: 2, context_token: 'context-token',
        item_list: [{ type: 1, text_item: { text: 'Hello DSH' } }],
      }],
    } : { ret: 0 }));
    vi.stubGlobal('fetch', fetch);
    const connected = vi.fn();
    const bot = new WeixinBot({ credentials, onConnected: connected, log });
    const receive = vi.fn(async (message: { userId: string }) => {
      await bot.send(message.userId, 'DSH reply');
      await bot.stop();
    });
    bot.onMessage(receive);
    await bot.run();
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ userId: 'friend', messageId: '9007199254740994', text: 'Hello DSH' }));
    expect(connected).toHaveBeenCalledOnce();
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    const [, init] = calls.find(([url]) => url.endsWith('/sendmessage'))!;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-wechat-token');
    expect(JSON.parse(String(init.body)).msg).toMatchObject({ to_user_id: 'friend', context_token: 'context-token', item_list: [{ type: 1, text_item: { text: 'DSH reply' } }] });
  });

  it('reports expired WeChat credentials without opening a local login flow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/getupdates') ? { ret: -14, errmsg: 'expired' } : { ret: 0 })));
    const bot = new WeixinBot({ credentials, log });
    await expect(bot.run()).rejects.toThrow('Scan a new QR code in channel settings');
    await bot.stop();
  });

  it('blocks untrusted hosts, insecure sockets, oversized files, and credential-bearing redirects', async () => {
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://localhost', 'https://api.telegram.org.evil.test', 'https://user:secret@slack.com']) {
      expect(() => sanitizeRemoteUrl(url)).toThrow();
    }
    expect(() => sanitizeRemoteUrl('ws://gateway.discord.gg', true)).toThrow();
    expect(sanitizeRemoteUrl('wss://gateway.discord.gg', true)).toBe('wss://gateway.discord.gg/');
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://localhost/private' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(channelFetch('https://slack.com/test', { headers: { Authorization: 'Bearer secret' } })).rejects.toThrow('trusted platform');
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(new Response(null, { headers: { 'content-length': String(101 * 1024 * 1024) } }));
    await expect(channelFetch('https://slack.com/file')).rejects.toThrow('file size limit');
  });
});
