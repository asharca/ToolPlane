import 'server-only';
import { db } from '@/lib/db';

export const DEFAULT_MAX_AGENT_ATTACHMENT_BYTES = 1_000_000_000;
export const MIN_ADMIN_ATTACHMENT_MEGABYTES = 1;
export const MAX_ADMIN_ATTACHMENT_MEGABYTES = 10_000;
export const AGENT_ATTACHMENT_LIMIT_SETTING_KEY = 'agent.maxAttachmentBytes';

export type AgentAttachmentLimit = {
  bytes: number;
  source: 'database' | 'environment' | 'default';
};

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function environmentAgentAttachmentLimit(): AgentAttachmentLimit {
  const configured = positiveSafeInteger(process.env.TOOLPLANE_MAX_ATTACHMENT_BYTES);
  return configured
    ? { bytes: configured, source: 'environment' }
    : { bytes: DEFAULT_MAX_AGENT_ATTACHMENT_BYTES, source: 'default' };
}

export async function resolveAgentAttachmentLimit(): Promise<AgentAttachmentLimit> {
  try {
    const setting = await db.systemSetting.findUnique({
      where: { key: AGENT_ATTACHMENT_LIMIT_SETTING_KEY },
      select: { value: true },
    });
    const configured = positiveSafeInteger(setting?.value);
    if (configured) return { bytes: configured, source: 'database' };
  } catch {
    // Keep uploads available during a rolling deploy before the migration has
    // completed. The admin form will still report persistence failures.
  }
  return environmentAgentAttachmentLimit();
}

export async function maxAgentAttachmentBytes(): Promise<number> {
  return (await resolveAgentAttachmentLimit()).bytes;
}

export async function setAgentAttachmentLimitBytes(bytes: number): Promise<void> {
  if (!positiveSafeInteger(bytes)) throw new Error('Invalid attachment limit.');
  await db.systemSetting.upsert({
    where: { key: AGENT_ATTACHMENT_LIMIT_SETTING_KEY },
    create: { key: AGENT_ATTACHMENT_LIMIT_SETTING_KEY, value: String(bytes) },
    update: { value: String(bytes) },
  });
}

export async function resetAgentAttachmentLimit(): Promise<void> {
  await db.systemSetting.deleteMany({ where: { key: AGENT_ATTACHMENT_LIMIT_SETTING_KEY } });
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
