import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  detectClientTimeZone: vi.fn(),
  syncDetectedTimeZone: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('@/lib/auth/timezone-actions', () => ({
  syncDetectedTimeZone: mocks.syncDetectedTimeZone,
}));

vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return {
    ...actual,
    detectClientTimeZone: mocks.detectClientTimeZone,
  };
});

import { UserTimeZoneProvider } from '@/components/timezone/UserTimeZoneProvider';
import { useUserTimeZone } from '@/components/timezone/UserTimeZoneContext';

function TimeZoneProbe() {
  const { detectedTimeZone, timeZone } = useUserTimeZone();
  return (
    <div>
      <output aria-label="Detected timezone">{detectedTimeZone ?? 'none'}</output>
      <output aria-label="Effective timezone">{timeZone}</output>
    </div>
  );
}

describe('UserTimeZoneProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncDetectedTimeZone.mockResolvedValue(false);
  });

  it('does not sync when browser detection matches the saved value', async () => {
    mocks.detectClientTimeZone.mockReturnValue('Asia/Taipei');

    render(
      <UserTimeZoneProvider
        detectedTimeZone="Asia/Taipei"
        timeZoneOverride={null}
      >
        <TimeZoneProbe />
      </UserTimeZoneProvider>,
    );

    expect(await screen.findByLabelText('Detected timezone')).toHaveTextContent('Asia/Taipei');
    expect(screen.getByLabelText('Effective timezone')).toHaveTextContent('Asia/Taipei');
    expect(mocks.syncDetectedTimeZone).not.toHaveBeenCalled();
  });

  it('syncs a changed detection while preserving a manual override', async () => {
    mocks.detectClientTimeZone.mockReturnValue('America/New_York');
    mocks.syncDetectedTimeZone.mockResolvedValue(true);

    render(
      <UserTimeZoneProvider
        detectedTimeZone="Asia/Taipei"
        timeZoneOverride="Europe/Paris"
      >
        <TimeZoneProbe />
      </UserTimeZoneProvider>,
    );

    await waitFor(() => {
      expect(mocks.syncDetectedTimeZone).toHaveBeenCalledTimes(1);
      expect(mocks.syncDetectedTimeZone).toHaveBeenCalledWith('America/New_York');
    });
    expect(screen.getByLabelText('Detected timezone')).toHaveTextContent('America/New_York');
    expect(screen.getByLabelText('Effective timezone')).toHaveTextContent('Europe/Paris');
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('falls back to UTC when neither the server nor browser has a timezone', async () => {
    mocks.detectClientTimeZone.mockReturnValue(null);

    render(
      <UserTimeZoneProvider detectedTimeZone={null} timeZoneOverride={null}>
        <TimeZoneProbe />
      </UserTimeZoneProvider>,
    );

    expect(await screen.findByLabelText('Detected timezone')).toHaveTextContent('none');
    expect(screen.getByLabelText('Effective timezone')).toHaveTextContent('UTC');
    expect(mocks.syncDetectedTimeZone).not.toHaveBeenCalled();
  });
});
