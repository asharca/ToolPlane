// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  setLimit: vi.fn(),
  resetLimit: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/agents/attachment-limits', () => ({
  MIN_ADMIN_ATTACHMENT_MEGABYTES: 1,
  MAX_ADMIN_ATTACHMENT_MEGABYTES: 10_000,
  setAgentAttachmentLimitBytes: mocks.setLimit,
  resetAgentAttachmentLimit: mocks.resetLimit,
}));
vi.mock('@/lib/admin/settings', () => ({
  updateHermesArchiveSettings: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (
    key: string,
    values?: Record<string, unknown>,
  ) => key === 'errorInvalidAttachmentLimit'
    ? `Enter ${values?.min}-${values?.max} MB.`
    : key),
}));

import { updateAgentAttachmentLimitAction } from '@/lib/admin/settings-actions';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe('admin runtime settings action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.setLimit.mockResolvedValue(undefined);
    mocks.resetLimit.mockResolvedValue(undefined);
  });

  it('persists whole megabytes as bytes after checking admin access', async () => {
    const result = await updateAgentAttachmentLimitAction({}, form({ maxAttachmentSizeMb: '250' }));

    expect(result).toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.setLimit).toHaveBeenCalledWith(250_000_000);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/settings');
  });

  it('rejects invalid or excessive values', async () => {
    const result = await updateAgentAttachmentLimitAction({}, form({ maxAttachmentSizeMb: '10001' }));

    expect(result).toEqual({ error: 'Enter 1-10000 MB.' });
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });

  it('removes the database override when reset is requested', async () => {
    const result = await updateAgentAttachmentLimitAction({}, form({ intent: 'reset' }));

    expect(result).toEqual({ ok: true });
    expect(mocks.resetLimit).toHaveBeenCalledOnce();
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });

  it('does not mutate settings when admin authorization fails', async () => {
    mocks.requireAdmin.mockRejectedValue(new Error('forbidden'));

    await expect(updateAgentAttachmentLimitAction({}, form({ maxAttachmentSizeMb: '250' })))
      .rejects.toThrow('forbidden');
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });
});
