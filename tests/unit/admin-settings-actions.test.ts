// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  updateHermesArchiveSettings: vi.fn(),
  updateMcpStartupTimeoutSettings: vi.fn(),
  resetMcpStartupTimeoutSettings: vi.fn(),
  isValidMcpStartupTimeouts: vi.fn((idleTimeoutMs: unknown, maxTimeoutMs: unknown) => (
    Number.isSafeInteger(idleTimeoutMs)
    && Number.isSafeInteger(maxTimeoutMs)
    && Number(idleTimeoutMs) >= 1_000
    && Number(maxTimeoutMs) <= 1_800_000
    && Number(maxTimeoutMs) >= Number(idleTimeoutMs)
  )),
  revalidatePath: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({ getTranslations: mocks.getTranslations }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/admin/settings', () => ({
  updateHermesArchiveSettings: mocks.updateHermesArchiveSettings,
  updateMcpStartupTimeoutSettings: mocks.updateMcpStartupTimeoutSettings,
  resetMcpStartupTimeoutSettings: mocks.resetMcpStartupTimeoutSettings,
  isValidMcpStartupTimeouts: mocks.isValidMcpStartupTimeouts,
  MIN_MCP_STARTUP_TIMEOUT_MS: 1_000,
  MAX_MCP_STARTUP_TIMEOUT_MS: 1_800_000,
}));
vi.mock('@/lib/agents/attachment-limits', () => ({
  MAX_ADMIN_ATTACHMENT_MEGABYTES: 10_000,
  MIN_ADMIN_ATTACHMENT_MEGABYTES: 1,
  resetAgentAttachmentLimit: vi.fn(),
  setAgentAttachmentLimitBytes: vi.fn(),
}));

import {
  updateHermesArchiveUploadLimitAction,
  updateMcpStartupTimeoutSettingsAction,
} from '@/lib/admin/settings-actions';

function settingsForm(value: string): FormData {
  const formData = new FormData();
  formData.set('hermesArchiveMaxUploadMiB', value);
  return formData;
}

function mcpTimeoutsForm(idleSeconds: string, maxSeconds: string, intent?: string): FormData {
  const formData = new FormData();
  formData.set('mcpStartupIdleTimeoutSeconds', idleSeconds);
  formData.set('mcpStartupMaxTimeoutSeconds', maxSeconds);
  if (intent) formData.set('intent', intent);
  return formData;
}

describe('updateHermesArchiveUploadLimitAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.getTranslations.mockResolvedValue((key: string) => key);
    mocks.updateHermesArchiveSettings.mockResolvedValue({ hermesArchiveMaxUploadMiB: 24 });
  });

  it('requires an admin and persists a valid whole-MiB limit', async () => {
    await expect(updateHermesArchiveUploadLimitAction({}, settingsForm('24'))).resolves.toEqual({ ok: true });

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.updateHermesArchiveSettings).toHaveBeenCalledWith(24);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/settings');
  });

  it.each(['', '12.5', '0', '10241', '999999999999999999999'])('rejects invalid setting %j without writing', async (value) => {
    await expect(updateHermesArchiveUploadLimitAction({}, settingsForm(value))).resolves.toEqual({
      error: 'errorHermesArchiveMaxUploadMiB',
    });

    expect(mocks.updateHermesArchiveSettings).not.toHaveBeenCalled();
  });
});

describe('updateMcpStartupTimeoutSettingsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.getTranslations.mockResolvedValue((key: string) => key);
    mocks.updateMcpStartupTimeoutSettings.mockResolvedValue({
      idleTimeoutMs: 300_000,
      maxTimeoutMs: 900_000,
      source: 'database',
    });
    mocks.resetMcpStartupTimeoutSettings.mockResolvedValue(undefined);
  });

  it('persists valid whole-second MCP timeout settings', async () => {
    await expect(updateMcpStartupTimeoutSettingsAction({}, mcpTimeoutsForm('300', '900'))).resolves.toEqual({ ok: true });

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.updateMcpStartupTimeoutSettings).toHaveBeenCalledWith(300_000, 900_000);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/settings');
  });

  it.each([
    ['', '900'],
    ['300.5', '900'],
    ['0', '900'],
    ['900', '300'],
    ['1801', '1801'],
  ])('rejects invalid MCP timeouts %j / %j', async (idleSeconds, maxSeconds) => {
    await expect(updateMcpStartupTimeoutSettingsAction({}, mcpTimeoutsForm(idleSeconds, maxSeconds))).resolves.toEqual({
      error: 'errorMcpStartupTimeouts',
    });

    expect(mocks.updateMcpStartupTimeoutSettings).not.toHaveBeenCalled();
  });

  it('restores the service environment default without validating form fields', async () => {
    await expect(updateMcpStartupTimeoutSettingsAction({}, mcpTimeoutsForm('', '', 'reset'))).resolves.toEqual({ ok: true });

    expect(mocks.resetMcpStartupTimeoutSettings).toHaveBeenCalledOnce();
    expect(mocks.updateMcpStartupTimeoutSettings).not.toHaveBeenCalled();
  });
});
