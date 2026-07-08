import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pushMock, setThemeMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  setThemeMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/app/acme/mcp',
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: setThemeMock }),
}));

import { DashboardHeaderControls } from '@/components/dashboard/DashboardHeaderControls';

describe('DashboardHeaderControls (command palette)', () => {
  beforeEach(() => {
    pushMock.mockClear();
    setThemeMock.mockClear();
  });

  it('opens the palette with Cmd+K and navigates a command to the active workspace', async () => {
    render(<DashboardHeaderControls />);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    const dialog = await screen.findByRole('dialog', { name: /command palette/i });
    expect(dialog).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(pushMock).toHaveBeenCalledWith('/app/acme/skills');
  });

  it('filters commands by query', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, 'logs');
    expect(screen.getByRole('button', { name: /Logs/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Members/ })).toBeNull();
  });

  it('toggles the theme from the header button', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /toggle theme/i }));
    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });
});
