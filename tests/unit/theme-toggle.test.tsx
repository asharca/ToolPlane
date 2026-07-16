import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { setThemeMock } = vi.hoisted(() => ({ setThemeMock: vi.fn() }));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: setThemeMock }),
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
});
