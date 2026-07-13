// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_TIME_ZONE_VALUE } from '@/lib/timezone';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  updateMany: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({
  getCurrentUser: mocks.getCurrentUser,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      updateMany: mocks.updateMany,
    },
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}));

import {
  syncDetectedTimeZone,
  updateTimeZonePreference,
} from '@/lib/auth/timezone-actions';

function preferenceForm(
  timeZone: string,
  detectedTimeZone = 'Asia/Taipei',
): FormData {
  const formData = new FormData();
  formData.set('timeZone', timeZone);
  formData.set('detectedTimeZone', detectedTimeZone);
  return formData;
}

describe('timezone preference actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'current-user',
      detectedTimeZone: 'Asia/Taipei',
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('does not sync when unauthenticated, invalid, or already current', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    await expect(syncDetectedTimeZone('America/New_York')).resolves.toBe(false);

    await expect(syncDetectedTimeZone('+08:00')).resolves.toBe(false);
    await expect(syncDetectedTimeZone('Asia/Taipei')).resolves.toBe(false);

    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('syncs a changed detected timezone only to the authenticated user', async () => {
    await expect(syncDetectedTimeZone('America/New_York')).resolves.toBe(true);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'current-user' },
      data: { detectedTimeZone: 'America/New_York' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('rejects invalid manual values without writing', async () => {
    const result = await updateTimeZonePreference(
      {},
      preferenceForm('Not/A-Time-Zone'),
    );

    expect(result).toEqual({ error: 'invalidTimeZone' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('writes a manual override only to the current user', async () => {
    const formData = preferenceForm('America/New_York');
    formData.set('userId', 'another-user');

    const result = await updateTimeZonePreference({}, formData);

    expect(result).toEqual({ savedAt: expect.any(Number) });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'current-user' },
      data: { timeZoneOverride: 'America/New_York' },
    });
  });

  it('clears the override and records the current detection in automatic mode', async () => {
    await updateTimeZonePreference(
      {},
      preferenceForm(AUTO_TIME_ZONE_VALUE, 'Europe/Paris'),
    );

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'current-user' },
      data: {
        timeZoneOverride: null,
        detectedTimeZone: 'Europe/Paris',
      },
    });
  });

  it('returns unauthorized when there is no current user or user row', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    await expect(updateTimeZonePreference(
      {},
      preferenceForm('Asia/Taipei'),
    )).resolves.toEqual({ error: 'unauthorized' });

    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(updateTimeZonePreference(
      {},
      preferenceForm('Asia/Taipei'),
    )).resolves.toEqual({ error: 'unauthorized' });
  });
});
