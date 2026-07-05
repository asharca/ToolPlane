import { describe, expect, it } from 'vitest';
import { createAgentChannelToken, hashAgentChannelToken, AGENT_CHANNEL_TOKEN_PREFIX } from '@/lib/agents/channel-token';
import { runnerStderrToLastError, runnerStdoutIndicatesConnected } from '@/lib/agents/channel-runtime-logs';
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

  it('marks long-lived platforms as hosted Hermes runners', () => {
    expect(hostedRunnerSpec('telegram')).toMatchObject({
      className: 'TelegramAdapter',
      tokenEnv: 'TELEGRAM_BOT_TOKEN',
      requiredEnv: ['TELEGRAM_BOT_TOKEN'],
    });
    expect(hostedRunnerSpec('slack')?.requiredEnv).toEqual(expect.arrayContaining([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
    ]));
    expect(hostedRunnerSpec('weixin')).toMatchObject({
      importPath: 'gateway.platforms.weixin',
      className: 'WeixinAdapter',
      tokenEnv: 'WEIXIN_TOKEN',
      requiredEnv: ['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID'],
    });
    expect(hostedRunnerSpec('whatsapp_cloud')).toBeNull();
  });

  it('does not treat runner progress logs as channel errors', () => {
    expect(runnerStderrToLastError('[Telegram] Connecting to Telegram (attempt 1/8)...')).toBeNull();
    expect(runnerStderrToLastError('[Telegram] Discovering Telegram API fallback IPs')).toBeNull();
    expect(runnerStderrToLastError("Failed to load plugin demo: No module named 'optional_dep'")).toBeNull();
    expect(runnerStderrToLastError('Traceback: bot token is invalid')).toBe('Traceback: bot token is invalid');
    expect(runnerStdoutIndicatesConnected('[agent-channel-runner] connected telegram channel abc')).toBe(true);
  });
});
