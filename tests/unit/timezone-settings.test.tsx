import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTO_TIME_ZONE_VALUE } from '@/lib/timezone';

const mocks = vi.hoisted(() => ({
  updateTimeZonePreference: vi.fn(),
  useUserTimeZone: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('@/lib/auth/timezone-actions', () => ({
  updateTimeZonePreference: mocks.updateTimeZonePreference,
}));

vi.mock('@/components/timezone/UserTimeZoneContext', () => ({
  useUserTimeZone: mocks.useUserTimeZone,
}));

vi.mock('@/components/dashboard/SubmitButton', () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import { TimeZoneSettings } from '@/components/timezone/TimeZoneSettings';

describe('TimeZoneSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useUserTimeZone.mockReturnValue({
      detectedTimeZone: 'Asia/Taipei',
      timeZone: 'Asia/Taipei',
    });
    mocks.updateTimeZonePreference.mockResolvedValue({ savedAt: 123 });
  });

  it('defaults to automatic and labels it with the detected timezone', () => {
    render(<TimeZoneSettings timeZoneOverride={null} />);

    const select = screen.getByRole('combobox', { name: 'Your timezone' });
    expect(select).toHaveValue(AUTO_TIME_ZONE_VALUE);
    expect(screen.getByRole('option', {
      name: 'Automatic (Asia/Taipei)',
    })).toHaveValue(AUTO_TIME_ZONE_VALUE);
    expect(document.querySelector('input[name="detectedTimeZone"]')).toHaveValue('Asia/Taipei');
  });

  it('shows a persisted manual timezone as the selected option', () => {
    render(<TimeZoneSettings timeZoneOverride="America/New_York" />);

    expect(screen.getByRole('combobox', { name: 'Your timezone' }))
      .toHaveValue('America/New_York');
  });

  it('submits automatic mode with the current browser detection', async () => {
    render(<TimeZoneSettings timeZoneOverride="America/New_York" />);

    const select = screen.getByRole('combobox', { name: 'Your timezone' });
    await userEvent.selectOptions(select, AUTO_TIME_ZONE_VALUE);
    fireEvent.submit(select.closest('form')!);

    await waitFor(() => expect(mocks.updateTimeZonePreference).toHaveBeenCalledTimes(1));
    const formData = mocks.updateTimeZonePreference.mock.calls[0][1] as FormData;
    expect(formData.get('timeZone')).toBe(AUTO_TIME_ZONE_VALUE);
    expect(formData.get('detectedTimeZone')).toBe('Asia/Taipei');
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('lets the user choose and submit a custom timezone', async () => {
    render(<TimeZoneSettings timeZoneOverride={null} />);

    const select = screen.getByRole('combobox', { name: 'Your timezone' });
    await userEvent.selectOptions(select, 'America/New_York');
    expect(select).toHaveValue('America/New_York');
    fireEvent.submit(select.closest('form')!);

    await waitFor(() => expect(mocks.updateTimeZonePreference).toHaveBeenCalledTimes(1));
    const formData = mocks.updateTimeZonePreference.mock.calls[0][1] as FormData;
    expect(formData.get('timeZone')).toBe('America/New_York');
  });
});
