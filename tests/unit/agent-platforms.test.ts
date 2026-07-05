import { describe, expect, it } from 'vitest';
import {
  MESSAGING_PLATFORMS,
  getMessagingPlatform,
  hasBuiltInPairingProvider,
  missingCreateCredentialNames,
  missingStartCredentialNames,
  normalizePlatformMessageBody,
} from '@/lib/agents/platforms';

describe('messaging platform catalog', () => {
  it('covers the Hermes messaging platform surface', () => {
    const slugs = MESSAGING_PLATFORMS.map((p) => p.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      'telegram',
      'discord',
      'slack',
      'whatsapp',
      'whatsapp_cloud',
      'signal',
      'sms',
      'email',
      'homeassistant',
      'mattermost',
      'matrix',
      'dingtalk',
      'feishu',
      'wecom',
      'wecom_callback',
      'weixin',
      'bluebubbles',
      'qqbot',
      'yuanbao',
      'teams',
      'teams_meetings',
      'msgraph_webhook',
      'google_chat',
      'line',
      'ntfy',
      'raft',
      'irc',
      'simplex',
      'photon',
      'open_webui',
      'webhooks',
      'api',
    ]));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('finds known platforms and rejects unknown ones', () => {
    expect(getMessagingPlatform('slack')?.label).toBe('Slack');
    expect(getMessagingPlatform('whatsapp-cloud')?.slug).toBe('whatsapp_cloud');
    expect(getMessagingPlatform('msgraph-webhook')?.slug).toBe('msgraph_webhook');
    expect(getMessagingPlatform('not-real')).toBeNull();
  });

  it('models native setup flows instead of treating every platform as a URL', () => {
    const telegramPlatform = getMessagingPlatform('telegram');
    const wecom = getMessagingPlatform('wecom');
    const slack = getMessagingPlatform('slack');
    const whatsappCloud = getMessagingPlatform('whatsapp-cloud');

    expect(telegramPlatform?.setupFlow).toBe('bot_token');
    expect(telegramPlatform?.publicEndpointRequired).toBe(false);
    expect(telegramPlatform?.credentials.map((field) => field.name)).toContain('TELEGRAM_BOT_TOKEN');

    expect(wecom?.setupFlow).toBe('qr_scan');
    expect(wecom?.connectionMode).toContain('WebSocket');
    expect(wecom?.publicEndpointRequired).toBe(false);
    expect(wecom?.credentials.map((field) => field.name)).toEqual(expect.arrayContaining([
      'WECOM_BOT_ID',
      'WECOM_SECRET',
    ]));
    expect(wecom?.pairing?.provider).toBe('wecom_admin_qr');
    expect(wecom?.credentials.find((field) => field.name === 'WECOM_BOT_ID')?.requiredAt).toBe('start');
    expect(wecom ? missingCreateCredentialNames(wecom, {}) : []).toEqual([]);
    expect(wecom ? missingStartCredentialNames(wecom, {}) : []).toEqual(expect.arrayContaining([
      'WECOM_BOT_ID',
      'WECOM_SECRET',
    ]));

    const weixin = getMessagingPlatform('weixin');
    expect(weixin?.requiredEnv).toEqual(['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID']);
    expect(weixin ? missingCreateCredentialNames(weixin, {}) : []).toEqual([]);
    expect(weixin ? missingStartCredentialNames(weixin, {}) : []).toEqual(expect.arrayContaining([
      'WEIXIN_TOKEN',
      'WEIXIN_ACCOUNT_ID',
    ]));

    expect(slack?.setupFlow).toBe('socket_mode');
    expect(slack?.publicEndpointRequired).toBe(false);
    expect(slack?.credentials.map((field) => field.name)).toEqual(expect.arrayContaining([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
    ]));

    expect(whatsappCloud?.setupFlow).toBe('cloud_webhook');
    expect(whatsappCloud?.publicEndpointRequired).toBe(true);
    expect(whatsappCloud?.credentials.map((field) => field.name)).toContain('WHATSAPP_CLOUD_VERIFY_TOKEN');

    const discord = getMessagingPlatform('discord');
    expect(discord?.requiredEnv).toEqual(['DISCORD_BOT_TOKEN']);
    expect(discord?.credentials.find((field) => field.name === 'DISCORD_ALLOWED_USERS')?.required).toBeUndefined();

    const telegram = getMessagingPlatform('telegram');
    expect(telegram?.requiredEnv).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(telegram?.credentials.find((field) => field.name === 'TELEGRAM_ALLOWED_USERS')?.required).toBeUndefined();

    const dingtalk = getMessagingPlatform('dingtalk');
    expect(dingtalk?.setupFlow).toBe('qr_scan');
    expect(dingtalk?.publicEndpointRequired).toBe(false);
    expect(dingtalk?.requiredEnv).toEqual(['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET']);
    expect(dingtalk?.pairing?.provider).toBe('dingtalk_device_qr');
  });

  it('models active QR pairing providers for scan-first platforms', () => {
    const qrPlatforms = ['telegram', 'wecom', 'weixin', 'dingtalk', 'whatsapp', 'signal', 'yuanbao'];
    for (const slug of qrPlatforms) {
      const platform = getMessagingPlatform(slug);
      expect(platform?.pairing?.type).toBe('qr');
      expect(platform?.pairing?.provider).toBeTruthy();
    }
    const telegram = getMessagingPlatform('telegram')!;
    expect(telegram.pairing?.provider).toBe('telegram_managed_bot');
    expect(missingCreateCredentialNames(telegram, {})).toEqual([]);
    expect(missingStartCredentialNames(telegram, {})).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(hasBuiltInPairingProvider(telegram)).toBe(true);
    expect(hasBuiltInPairingProvider(getMessagingPlatform('wecom')!)).toBe(true);
    expect(hasBuiltInPairingProvider(getMessagingPlatform('weixin')!)).toBe(true);
    expect(hasBuiltInPairingProvider(getMessagingPlatform('dingtalk')!)).toBe(true);
    expect(hasBuiltInPairingProvider(getMessagingPlatform('whatsapp')!)).toBe(false);
  });

  it('keeps setup metadata complete for every platform', () => {
    for (const platform of MESSAGING_PLATFORMS) {
      expect(platform.primaryAction.length).toBeGreaterThan(0);
      expect(platform.connectionMode.length).toBeGreaterThan(0);
      expect(platform.credentials.length).toBeGreaterThan(0);
      expect(platform.setupSteps.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizePlatformMessageBody', () => {
  it('normalizes Slack Events API payloads', () => {
    const body = normalizePlatformMessageBody('slack', {
      team_id: 'T1',
      event: {
        type: 'message',
        text: 'hello slack',
        user: 'U1',
        channel: 'C1',
        thread_ts: '100.1',
        ts: '100.2',
      },
    });

    expect(body.message).toBe('hello slack');
    expect(body.source).toMatchObject({
      platform: 'slack',
      chatType: 'channel',
      chatId: 'C1',
      userId: 'U1',
      threadId: '100.1',
      messageId: '100.2',
      scopeId: 'T1',
    });
  });

  it('normalizes Discord message payloads', () => {
    const body = normalizePlatformMessageBody('discord', {
      id: 'm1',
      content: 'hello discord',
      channel_id: 'C1',
      guild_id: 'G1',
      thread_id: 'T1',
      author: { id: 'U1' },
    });

    expect(body.message).toBe('hello discord');
    expect(body.source).toMatchObject({
      platform: 'discord',
      chatType: 'thread',
      chatId: 'C1',
      userId: 'U1',
      threadId: 'T1',
      scopeId: 'G1',
    });
  });

  it('normalizes Telegram update payloads', () => {
    const body = normalizePlatformMessageBody('telegram', {
      message: {
        message_id: 42,
        message_thread_id: 7,
        text: 'hello telegram',
        chat: { id: 123, type: 'group' },
        from: { id: 456 },
      },
    });

    expect(body.message).toBe('hello telegram');
    expect(body.source).toMatchObject({
      platform: 'telegram',
      chatType: 'group',
      chatId: '123',
      userId: '456',
      threadId: '7',
      messageId: '42',
    });
  });

  it('normalizes WhatsApp Cloud payloads', () => {
    const body = normalizePlatformMessageBody('whatsapp_cloud', {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'phone1' },
            contacts: [{ wa_id: '15551234567' }],
            messages: [{ id: 'wamid.1', from: '15551234567', text: { body: 'hello whatsapp' } }],
          },
        }],
      }],
    });

    expect(body.message).toBe('hello whatsapp');
    expect(body.source).toMatchObject({
      platform: 'whatsapp_cloud',
      chatType: 'dm',
      chatId: 'phone1',
      userId: '15551234567',
      messageId: 'wamid.1',
    });
  });
});
