// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  updateHermesArchiveSettings: vi.fn(),
  revalidatePath: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({ getTranslations: mocks.getTranslations }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/admin/settings', () => ({ updateHermesArchiveSettings: mocks.updateHermesArchiveSettings }));
vi.mock('@/lib/agents/attachment-limits', () => ({
  MAX_ADMIN_ATTACHMENT_MEGABYTES: 10_000,
  MIN_ADMIN_ATTACHMENT_MEGABYTES: 1,
  resetAgentAttachmentLimit: vi.fn(),
  setAgentAttachmentLimitBytes: vi.fn(),
}));

import { updateHermesArchiveUploadLimitAction } from '@/lib/admin/settings-actions';

function settingsForm(value: string): FormData {
  const formData = new FormData();
  formData.set('hermesArchiveMaxUploadMiB', value);
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

  it.each(['', '12.5', '0', '61', '999999999999999999999'])('rejects invalid setting %j without writing', async (value) => {
    await expect(updateHermesArchiveUploadLimitAction({}, settingsForm(value))).resolves.toEqual({
      error: 'errorHermesArchiveMaxUploadMiB',
    });

    expect(mocks.updateHermesArchiveSettings).not.toHaveBeenCalled();
  });
});
