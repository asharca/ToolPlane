// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';
import {
  DEFAULT_SKILL_IMPORT_SKILLS,
  MAX_SKILL_IMPORT_SKILLS,
} from '@/lib/skills/limits';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    systemSetting: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
    },
  },
}));

import {
  getHermesArchiveSettings,
  HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
  MCP_STARTUP_TIMEOUTS_SETTING_KEY,
  getSkillImportSettings,
  resolveMcpStartupTimeoutSettings,
  resetMcpStartupTimeoutSettings,
  SKILL_IMPORT_MAX_SKILLS_SETTING_KEY,
  updateHermesArchiveSettings,
  updateMcpStartupTimeoutSettings,
  updateSkillImportSettings,
} from '@/lib/admin/settings';

describe('system settings storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the safe archive default until the generic setting row exists', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(getHermesArchiveSettings()).resolves.toEqual({
      hermesArchiveMaxUploadMiB: DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      select: { value: true },
    });
  });

  it('writes a key/value setting and never expands a stale value past the hard cap', async () => {
    mocks.upsert.mockResolvedValue(undefined);

    await expect(updateHermesArchiveSettings(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB + 1)).resolves.toEqual({
      hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      create: {
        key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
        value: String(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB),
      },
      update: { value: String(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB) },
    });
  });

  it('falls back to the safe default while the shared settings table is unavailable', async () => {
    mocks.findUnique.mockRejectedValue(new Error('relation does not exist'));

    await expect(getHermesArchiveSettings()).resolves.toEqual({
      hermesArchiveMaxUploadMiB: DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
  });

  it('uses the default skill import limit until a valid administrator override exists', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(getSkillImportSettings()).resolves.toEqual({
      maxSkills: DEFAULT_SKILL_IMPORT_SKILLS,
    });

    mocks.findUnique.mockResolvedValue({ value: '80' });
    await expect(getSkillImportSettings()).resolves.toEqual({ maxSkills: 80 });

    mocks.findUnique.mockResolvedValue({ value: String(MAX_SKILL_IMPORT_SKILLS + 1) });
    await expect(getSkillImportSettings()).resolves.toEqual({
      maxSkills: DEFAULT_SKILL_IMPORT_SKILLS,
    });
  });

  it('writes a bounded skill import limit', async () => {
    mocks.upsert.mockResolvedValue(undefined);

    await expect(updateSkillImportSettings(80)).resolves.toEqual({ maxSkills: 80 });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY },
      create: { key: SKILL_IMPORT_MAX_SKILLS_SETTING_KEY, value: '80' },
      update: { value: '80' },
    });

    await expect(updateSkillImportSettings(MAX_SKILL_IMPORT_SKILLS + 1)).rejects.toThrow(
      'Invalid skill import maximum.',
    );
  });

  it('uses the Compose environment values until an administrator saves an MCP timeout override', async () => {
    vi.stubEnv('TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS', '300000');
    vi.stubEnv('TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS', '900000');
    mocks.findUnique.mockResolvedValue(null);

    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 300_000,
      maxTimeoutMs: 900_000,
      source: 'environment',
    });

    mocks.findUnique.mockResolvedValue({
      value: JSON.stringify({ idleTimeoutMs: 120_000, maxTimeoutMs: 600_000 }),
    });
    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      source: 'database',
    });
  });

  it('rejects malformed persisted MCP timeouts and falls back to the compatible environment alias', async () => {
    vi.stubEnv('MCP_STARTUP_IDLE_TIMEOUT_MS', '180000');
    vi.stubEnv('MCP_STARTUP_MAX_TIMEOUT_MS', '540000');
    mocks.findUnique.mockResolvedValue({ value: '{not-json' });

    await expect(resolveMcpStartupTimeoutSettings()).resolves.toEqual({
      idleTimeoutMs: 180_000,
      maxTimeoutMs: 540_000,
      source: 'environment',
    });
  });

  it('writes and resets the paired MCP timeout override atomically', async () => {
    mocks.upsert.mockResolvedValue(undefined);
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    await expect(updateMcpStartupTimeoutSettings(300_000, 900_000)).resolves.toEqual({
      idleTimeoutMs: 300_000,
      maxTimeoutMs: 900_000,
      source: 'database',
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
      create: {
        key: MCP_STARTUP_TIMEOUTS_SETTING_KEY,
        value: JSON.stringify({ idleTimeoutMs: 300_000, maxTimeoutMs: 900_000 }),
      },
      update: { value: JSON.stringify({ idleTimeoutMs: 300_000, maxTimeoutMs: 900_000 }) },
    });

    await resetMcpStartupTimeoutSettings();
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { key: MCP_STARTUP_TIMEOUTS_SETTING_KEY },
    });
  });

  it('refuses an unsafe MCP timeout pair before writing a setting row', async () => {
    await expect(updateMcpStartupTimeoutSettings(900_000, 300_000)).rejects.toThrow(
      'Invalid MCP startup timeouts.',
    );

    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
