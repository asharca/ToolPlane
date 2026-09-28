import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTheme } from 'next-themes';

const { setThemeMock } = vi.hoisted(() => ({ setThemeMock: vi.fn() }));

vi.mock('next-themes', () => ({
  useTheme: vi.fn(() => ({ resolvedTheme: 'light', setTheme: setThemeMock })),
}));

import { ThemeToggle } from '@/components/theme/ThemeToggle';

describe('ThemeToggle', () => {
  it('renders a toggle button and switches theme on click', async () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: /switch to dark theme/i });
    expect(btn).toBeInTheDocument();

    await userEvent.click(btn);
    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });

  it('hides the toggle while a theme is forced and restores it when released', () => {
    vi.mocked(useTheme).mockReturnValueOnce({
      resolvedTheme: 'light',
      forcedTheme: 'dark',
      setTheme: setThemeMock,
      themes: ['light', 'dark'],
    });
    const { rerender } = render(<ThemeToggle />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to dark theme/i })).toBeInTheDocument();
  });
});
