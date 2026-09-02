import 'server-only';

import { db } from '@/lib/db';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  isValidHermesArchiveMaxUploadMiB,
  normalizeHermesArchiveMaxUploadMiB,
} from '@/lib/agents/hermes/archive-limits';
import {
  DEFAULT_SKILL_IMPORT_SKILLS,
  isValidSkillImportMaxSkills,
} from '@/lib/skills/limits';
import { parseRemoteMcpPrivateHosts } from '../../../scripts/remote-mcp-private-hosts.mjs';

export const HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY = 'hermes.maxArchiveUploadMiB';
export const MCP_STARTUP_TIMEOUTS_SETTING_KEY = 'mcp.startupTimeouts';
export const REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY = 'mcp.remotePrivateHosts';
export const SKILL_IMPORT_MAX_SKILLS_SETTING_KEY = 'skills.maxImportSkills';

export const DEFAULT_MCP_STARTUP_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_MCP_STARTUP_MAX_TIMEOUT_MS = 5 * 60_000;
export const MIN_MCP_STARTUP_TIMEOUT_MS = 1_000;
export const MAX_MCP_STARTUP_TIMEOUT_MS = 30 * 60_000;

export type SystemSettings = {
  hermesArchiveMaxUploadMiB: number;
};

export type McpStartupTimeoutSettings = {
  idleTimeoutMs: number;
  maxTimeoutMs: number;
  source: 'database' | 'environment' | 'default';
};

export type SkillImportSettings = {
  maxSkills: number;
};

export type RemoteMcpPrivateHostsSettings = {
  value: string;
  source: 'database' | 'environment' | 'default';
};

function toSystemSettings(value?: string | null): SystemSettings {
  const parsed = Number(value);
  return {
    hermesArchiveMaxUploadMiB: isValidHermesArchiveMaxUploadMiB(parsed)
      ? parsed
      : DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  };
}

function validMcpStartupTimeout(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < MIN_MCP_STARTUP_TIMEOUT_MS || parsed > MAX_MCP_STARTUP_TIMEOUT_MS) return null;
  return parsed;
}

export function isValidMcpStartupTimeouts(
  idleTimeoutMs: unknown,
  maxTimeoutMs: unknown,
): boolean {
  const idle = validMcpStartupTimeout(idleTimeoutMs);
  const max = validMcpStartupTimeout(maxTimeoutMs);
  return idle !== null && max !== null && max >= idle;
}

function environmentTimeout(
  primary: string | undefined,
  legacy: string | undefined,
  fallback: number,
): { value: number; configured: boolean } {
  const configured = validMcpStartupTimeout(primary) ?? validMcpStartupTimeout(legacy);
  return configured === null
    ? { value: fallback, configured: false }
    : { value: configured, configured: true };
}

export function environmentMcpStartupTimeoutSettings(): McpStartupTimeoutSettings {
  const idle = environmentTimeout(
    process.env.TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS,
    process.env.MCP_STARTUP_IDLE_TIMEOUT_MS,
    DEFAULT_MCP_STARTUP_IDLE_TIMEOUT_MS,
  );
  const max = environmentTimeout(
    process.env.TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS,
    process.env.MCP_STARTUP_MAX_TIMEOUT_MS,
    DEFAULT_MCP_STARTUP_MAX_TIMEOUT_MS,
  );

  if (!isValidMcpStartupTimeouts(idle.value, max.value)) {
    return {
      idleTimeoutMs: DEFAULT_MCP_STARTUP_IDLE_TIMEOUT_MS,
      maxTimeoutMs: DEFAULT_MCP_STARTUP_MAX_TIMEOUT_MS,
      source: 'default',
    };
  }

  return {
    idleTimeoutMs: idle.value,
    maxTimeoutMs: max.value,
    source: idle.configured || max.configured ? 'environment' : 'default',
  };
}

function parseMcpStartupTimeoutSettings(value?: string | null): Omit<McpStartupTimeoutSettings, 'source'> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { idleTimeoutMs?: unknown; maxTimeoutMs?: unknown };
    const idleTimeoutMs = validMcpStartupTimeout(parsed?.idleTimeoutMs);
    const maxTimeoutMs = validMcpStartupTimeout(parsed?.maxTimeoutMs);
    if (idleTimeoutMs === null || maxTimeoutMs === null || maxTimeoutMs < idleTimeoutMs) return null;
    return {
      idleTimeoutMs,
      maxTimeoutMs,
    };
  } catch {
    return null;
  }
}

// This deliberately reads through to Postgres: an administrator's changed
// limit must be enforced by the very next import, including on another app
// instance.
export async function getHermesArchiveSettings(): Promise<SystemSettings> {
  try {
    const settings = await db.systemSetting.findUnique({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      select: { value: true },
    });
    return toSystemSettings(settings?.value);
  } catch {
    // Keep archive imports available during a rolling deploy before the
    // generic SystemSetting migration has completed.
    return toSystemSettings();
  }
}

export async function updateHermesArchiveSettings(
  hermesArchiveMaxUploadMiB: number,
): Promise<SystemSettings> {
  const value = normalizeHermesArchiveMaxUploadMiB(hermesArchiveMaxUploadMiB);
  await db.systemSetting.upsert({
    where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
    create: {
      key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
      value: String(value),
    },
    update: { value: String(value) },
  });
  return toSystemSettings(String(value));
}

// Read through to Postgres so a saved administrator override applies to the
// next import on every app instance.
export async function getSkillImportSettings(): Promise<SkillImportSettings> {
  try {
    const setting = await db.systemSetting.findUnique({
      where: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY },
      select: { value: true },
    });
    const maxSkills = Number(setting?.value);
    return {
      maxSkills: isValidSkillImportMaxSkills(maxSkills)
        ? maxSkills
        : DEFAULT_SKILL_IMPORT_SKILLS,
    };
  } catch {
    // A rolling deploy may briefly run before the shared settings table exists.
    return { maxSkills: DEFAULT_SKILL_IMPORT_SKILLS };
  }
}

export async function updateSkillImportSettings(maxSkills: number): Promise<SkillImportSettings> {
  if (!isValidSkillImportMaxSkills(maxSkills)) {
    throw new Error('Invalid skill import maximum.');
  }
  await db.systemSetting.upsert({
    where: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY },
    create: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY, value: String(maxSkills) },
    update: { value: String(maxSkills) },
  });
  return { maxSkills };
}

// Resolve this for every MCP bridge launch so a newly saved admin override
// applies to the next start, including on another app instance.
export async function resolveMcpStartupTimeoutSettings(): Promise<McpStartupTimeoutSettings> {
  try {
    const setting = await db.systemSetting.findUnique({
      where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
      select: { value: true },
    });
    const parsed = parseMcpStartupTimeoutSettings(setting?.value);
    if (parsed) return { ...parsed, source: 'database' };
  } catch {
    // A rolling deploy may briefly run before the shared settings table exists.
  }
  return environmentMcpStartupTimeoutSettings();
}

export async function updateMcpStartupTimeoutSettings(
  idleTimeoutMs: number,
  maxTimeoutMs: number,
): Promise<McpStartupTimeoutSettings> {
  if (!isValidMcpStartupTimeouts(idleTimeoutMs, maxTimeoutMs)) {
    throw new Error('Invalid MCP startup timeouts.');
  }
  const value = JSON.stringify({ idleTimeoutMs, maxTimeoutMs });
  await db.systemSetting.upsert({
    where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
    create: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY, value },
    update: { value },
  });
  return { idleTimeoutMs, maxTimeoutMs, source: 'database' };
}

export async function resetMcpStartupTimeoutSettings(): Promise<void> {
  await db.systemSetting.deleteMany({ where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY } });
}

function environmentRemoteMcpPrivateHostsSettings(): RemoteMcpPrivateHostsSettings {
  const parsed = parseRemoteMcpPrivateHosts(process.env.TOOLPLANE_REMOTE_MCP_PRIVATE_HOSTS ?? '');
  return parsed?.value
    ? { value: parsed.value, source: 'environment' }
    : { value: '', source: 'default' };
}

// Resolve this for every Remote MCP launch so an administrator's saved
// allowlist applies to the next start on every app instance.
export async function resolveRemoteMcpPrivateHostsSettings(): Promise<RemoteMcpPrivateHostsSettings> {
  try {
    const setting = await db.systemSetting.findUnique({
      where: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY },
      select: { value: true },
    });
    if (setting) {
      const parsed = parseRemoteMcpPrivateHosts(setting.value);
      // A malformed persisted override must not fall back to a permissive env.
      return { value: parsed?.value ?? '', source: 'database' };
    }
  } catch {
    // Do not widen a saved administrator policy when Postgres is unavailable.
    return { value: '', source: 'default' };
  }
  return environmentRemoteMcpPrivateHostsSettings();
}

export async function updateRemoteMcpPrivateHostsSettings(
  value: string,
): Promise<RemoteMcpPrivateHostsSettings> {
  const parsed = parseRemoteMcpPrivateHosts(value);
  if (!parsed) throw new Error('Invalid Remote MCP private host allowlist.');
  await db.systemSetting.upsert({
    where: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY },
    create: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY, value: parsed.value },
    update: { value: parsed.value },
  });
  return { value: parsed.value, source: 'database' };
}

export async function resetRemoteMcpPrivateHostsSettings(): Promise<void> {
  await db.systemSetting.deleteMany({ where: { key: REMOTE_MCP_PRIVATE_HOSTS_SETTING_KEY } });
}
