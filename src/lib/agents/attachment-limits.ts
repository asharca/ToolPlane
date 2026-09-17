import 'server-only';
import { saveAuditedSetting } from '@/lib/admin/audited-setting';
import { db } from '@/lib/db';

export const DEFAULT_MAX_AGENT_ATTACHMENT_BYTES = 1_000_000_000;
export const MIN_ADMIN_ATTACHMENT_MEGABYTES = 1;
// AgentAttachment.size is a Prisma Int. Never admit a value it cannot store.
export const ABSOLUTE_MAX_AGENT_ATTACHMENT_BYTES = 2_000_000_000;
export const MAX_ADMIN_ATTACHMENT_MEGABYTES = ABSOLUTE_MAX_AGENT_ATTACHMENT_BYTES / 1_000_000;
export const AGENT_ATTACHMENT_LIMIT_SETTING_KEY = 'agent.maxAttachmentBytes';

export type AgentAttachmentLimit = {
  bytes: number;
  source: 'database' | 'environment' | 'default';
  cached?: boolean;
};

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function attachmentHardLimit(): number {
  const raw = process.env.TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES;
  const configured = positiveSafeInteger(raw);
  if (raw && !configured) throw new Error('Invalid TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES.');
  return Math.min(ABSOLUTE_MAX_AGENT_ATTACHMENT_BYTES, configured ?? ABSOLUTE_MAX_AGENT_ATTACHMENT_BYTES);
}
function bounded(bytes: number): number { return Math.min(bytes, attachmentHardLimit()); }
let lastKnownGood: AgentAttachmentLimit | null = null;

export function environmentAgentAttachmentLimit(): AgentAttachmentLimit {
  const raw = process.env.TOOLPLANE_MAX_ATTACHMENT_BYTES;
  const configured = positiveSafeInteger(raw);
  if (raw && !configured) throw new Error('Invalid TOOLPLANE_MAX_ATTACHMENT_BYTES.');
  return configured
    ? { bytes: bounded(configured), source: 'environment' }
    : { bytes: bounded(DEFAULT_MAX_AGENT_ATTACHMENT_BYTES), source: 'default' };
}

export async function resolveAgentAttachmentLimit(): Promise<AgentAttachmentLimit> {
  let setting;
  try {
    setting = await db.systemSetting.findUnique({ where: { key: AGENT_ATTACHMENT_LIMIT_SETTING_KEY }, select: { value: true } });
  } catch {
    // Fail closed on a cold cache rather than silently widening a DB limit.
    if (!lastKnownGood) throw new Error('Attachment limits are temporarily unavailable.');
    return { ...lastKnownGood, bytes: bounded(lastKnownGood.bytes), cached: true };
  }
  const configured = positiveSafeInteger(setting?.value);
  if (setting && !configured) throw new Error('Invalid persisted attachment limit.');
  const result: AgentAttachmentLimit = configured ? { bytes: bounded(configured), source: 'database' } : environmentAgentAttachmentLimit();
  lastKnownGood = result;
  return result;
}

export async function maxAgentAttachmentBytes(): Promise<number> {
  return (await resolveAgentAttachmentLimit()).bytes;
}

export async function setAgentAttachmentLimitBytes(bytes: number, actorId = 'system'): Promise<void> {
  if (!positiveSafeInteger(bytes) || bytes > attachmentHardLimit()) throw new Error('Invalid attachment limit.');
  await saveAuditedSetting(AGENT_ATTACHMENT_LIMIT_SETTING_KEY, String(bytes), actorId);
}

export async function resetAgentAttachmentLimit(actorId = 'system'): Promise<void> {
  await saveAuditedSetting(AGENT_ATTACHMENT_LIMIT_SETTING_KEY, null, actorId);
}

export function formatAttachmentByteLimit(bytes: number): string {
  if (bytes >= 1_000_000_000 && bytes % 1_000_000_000 === 0) {
    return `${bytes / 1_000_000_000} GB`;
  }
  if (bytes >= 1_000_000 && bytes % 1_000_000 === 0) {
    return `${bytes / 1_000_000} MB`;
  }
  return `${bytes} bytes`;
}
