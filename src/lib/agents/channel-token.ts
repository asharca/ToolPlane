import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

export const AGENT_CHANNEL_TOKEN_PREFIX = 'tpchan_';

export function createAgentChannelToken(): string {
  return `${AGENT_CHANNEL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashAgentChannelToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return `${token.slice(0, 11)}...`;
}
