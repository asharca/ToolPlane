import { describe, expect, it } from 'vitest';
import { createAgentChannelToken, hashAgentChannelToken, AGENT_CHANNEL_TOKEN_PREFIX } from '@/lib/agents/channel-token';
import { appendAgentChannelLog, getAgentChannelLogs } from '@/lib/agents/channel-runtime-logs';
import { channelSenderAllowed } from '@/lib/agents/channel-access';
import { hostedRunnerSpec } from '@/lib/agents/platform-runner';
import { decryptSecretRecord, encryptSecretRecord } from '@/lib/security/secrets';

describe('agent channel platform primitives', () => {
  it('creates hashable channel tokens with a stable prefix', () => {
    const token = createAgentChannelToken();
    expect(token.startsWith(AGENT_CHANNEL_TOKEN_PREFIX)).toBe(true);
    expect(hashAgentChannelToken(token)).toHaveLength(64);
    expect(hashAgentChannelToken(token)).toBe(hashAgentChannelToken(token));
  });

  it('encrypts channel credentials without storing plaintext values', () => {
    const encrypted = encryptSecretRecord({ TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(JSON.stringify(encrypted)).not.toContain('123:abc');
    expect(decryptSecretRecord(encrypted)).toEqual({ TELEGRAM_BOT_TOKEN: '123:abc' });
  });

  it('uses Cherry native Node adapters without Hermes imports or process configuration', () => {
    expect(hostedRunnerSpec('feishu')?.className).toBe('FeishuAdapter');
    expect(hostedRunnerSpec('qqbot')?.className).toBe('QqAdapter');
    expect(hostedRunnerSpec('telegram')).toMatchObject({
      className: 'TelegramAdapter',
      runtime: 'node',
      requiredEnv: ['TELEGRAM_BOT_TOKEN'],
    });
    expect(hostedRunnerSpec('slack')?.requiredEnv).toEqual(expect.arrayContaining([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
    ]));
    expect(hostedRunnerSpec('weixin')).toMatchObject({
      runtime: 'node',
      className: 'WeChatAdapter',
      requiredEnv: expect.arrayContaining(['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID']),
    });
    expect(hostedRunnerSpec('whatsapp_cloud')).toBeNull();
  });

  it('bounds logs and enforces user and chat allowlists independently', () => {
    for (let i = 0; i < 205; i += 1) appendAgentChannelLog('bounded', 'info', `log ${i}`);
    expect(getAgentChannelLogs('bounded')).toHaveLength(200);
    const credentials = { SLACK_ALLOWED_USERS: 'U1,U2', SLACK_ALLOWED_CHANNELS: 'C1' };
    expect(channelSenderAllowed('slack', credentials, { userId: 'U1', chatId: 'C1' })).toBe(true);
    expect(channelSenderAllowed('slack', credentials, { userId: 'U3', chatId: 'C1' })).toBe(false);
    expect(channelSenderAllowed('slack', credentials, { userId: 'U1', chatId: 'C2' })).toBe(false);
    expect(channelSenderAllowed('slack', credentials, {})).toBe(false);
    expect(channelSenderAllowed('telegram', { TELEGRAM_ALLOW_ALL_USERS: 'false' }, {})).toBe(false);
    expect(channelSenderAllowed('discord', { DISCORD_ALLOWED_CHANNELS: '123' }, { chatId: 'channel:123' })).toBe(true);
    expect(channelSenderAllowed('qqbot', { QQBOT_ALLOWED_CHATS: 'group:123' }, { chatId: 'group:123' })).toBe(true);
    expect(channelSenderAllowed('discord', { DISCORD_ALLOWED_CHANNELS: '123' }, { chatId: 'channel:456' })).toBe(false);
    expect(channelSenderAllowed('discord', { DISCORD_ALLOWED_ROLES: 'moderator' }, { userId: '123' })).toBe(false);
    expect(channelSenderAllowed('discord', { DISCORD_ALLOWED_ROLES: 'moderator' }, { userId: '123' }, ['moderator'])).toBe(true);
    expect(channelSenderAllowed('weixin', { WEIXIN_DM_POLICY: 'disabled' }, { userId: 'friend' })).toBe(false);
    expect(channelSenderAllowed('weixin', { WEIXIN_DM_POLICY: 'allowlist' }, { userId: 'friend' })).toBe(false);
  });

});
