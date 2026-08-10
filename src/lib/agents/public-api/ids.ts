import { randomBytes } from 'node:crypto';

function publicId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

export const createAgentEndpointId = () => publicId('agep');
export const createAgentConversationId = () => publicId('cnv');
export const createAgentResponseId = () => publicId('resp');
export const createAgentRequestId = () => publicId('req');

export function normalizePublicId(value: string, prefix: string): string | null {
  const normalized = value.trim();
  return normalized.startsWith(`${prefix}_`) && /^[a-z]+_[A-Za-z0-9_-]{12,80}$/.test(normalized)
    ? normalized
    : null;
}
