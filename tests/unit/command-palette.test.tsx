import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pushMock, setThemeMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  setThemeMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/app/acme/mcp',
  useSearchParams: () => new URLSearchParams('__dashboardTab=tab-1'),
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: setThemeMock }),
}));
vi.mock('@/components/layout/LocaleSwitcher', () => ({
  LocaleSwitcher: () => <button type="button">Language</button>,
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

    const dialog = await screen.findByRole('dialog', { name: /quick navigation/i });
    expect(dialog).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(pushMock).toHaveBeenCalledWith('/app/acme/skills');
  });

  it('filters commands by query', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /quick navigation/i }));
    const input = screen.getByPlaceholderText(/search navigation items/i);
    await userEvent.type(input, 'logs');
    expect(screen.getByRole('button', { name: /Logs/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Members/ })).toBeNull();
  });

  it('closes with Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<DashboardHeaderControls />);

    const trigger = screen.getByRole('button', { name: /quick navigation/i });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opens workspace market routes instead of legacy create pages', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /quick navigation/i }));
    const input = screen.getByPlaceholderText(/search navigation items/i);
    await userEvent.type(input, 'Browse MCP');
    await userEvent.click(screen.getByRole('button', { name: /^Browse MCP/ }));

    expect(pushMock).toHaveBeenCalledWith('/app/acme/market/mcp');
  });

  it('includes the toolkit market in quick navigation', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /quick navigation/i }));
    await userEvent.type(screen.getByPlaceholderText(/search navigation items/i), 'Browse toolkits');
    await userEvent.click(screen.getByRole('button', { name: /^Browse toolkits/ }));

    expect(pushMock).toHaveBeenCalledWith('/app/acme/market/toolkits');
  });

  it('keeps settings in quick navigation without a duplicate header button', async () => {
    render(<DashboardHeaderControls />);
    expect(screen.queryByRole('button', { name: /^Settings$/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /quick navigation/i }));
    await userEvent.type(screen.getByPlaceholderText(/search navigation items/i), 'Settings');
    await userEvent.click(screen.getByRole('button', { name: /^Settings/i }));

    expect(pushMock).toHaveBeenCalledWith('/app/acme/settings?returnTo=%2Fapp%2Facme%2Fmcp%3F__dashboardTab%3Dtab-1');
  });

  it('toggles the theme from quick navigation', async () => {
    render(<DashboardHeaderControls />);
    await userEvent.click(screen.getByRole('button', { name: /quick navigation/i }));
    await userEvent.type(screen.getByPlaceholderText(/search navigation items/i), 'Toggle dark mode');
    await userEvent.click(screen.getByRole('button', { name: /^Toggle dark mode/i }));
    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });
});
