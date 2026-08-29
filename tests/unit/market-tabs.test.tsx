import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketTabs } from '@/components/dashboard/MarketTabs';

const mocks = vi.hoisted(() => ({ pathname: '/app/acme/market/installed' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
}));

describe('MarketTabs', () => {
  beforeEach(() => {
    mocks.pathname = '/app/acme/market/installed';
  });

  it('uses resource types as primary tabs and keeps management separate', () => {
    render(<MarketTabs slug="acme" />);

    const tabs = within(screen.getByRole('navigation', { name: 'Market sections' }));
    expect(tabs.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'MCP',
      'Skills',
      'Agents',
      'Assistants',
      'Toolkits',
    ]);
    expect(tabs.getByRole('link', { name: 'MCP' })).toHaveAttribute('href', '/app/acme/market/mcp');
    expect(tabs.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/app/acme/market/skills');
    expect(tabs.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/app/acme/market/agents');
    expect(tabs.getByRole('link', { name: 'Assistants' })).toHaveAttribute('href', '/app/acme/market/assistants');
    expect(tabs.getByRole('link', { name: 'Toolkits' })).toHaveAttribute('href', '/app/acme/market/toolkits');
    expect(screen.getByRole('link', { name: 'Installed' })).toHaveAttribute(
      'href',
      '/app/acme/market/installed',
    );
    expect(screen.getByRole('link', { name: 'Installed' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps resource detail routes inside their resource tab', () => {
    mocks.pathname = '/app/acme/market/assistants/acme/research';
    render(<MarketTabs slug="acme" />);

    expect(screen.getByRole('link', { name: 'Assistants' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'MCP' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Installed' })).not.toHaveAttribute('aria-current');
  });

  it('shows pending updates on the installed tab', () => {
    render(<MarketTabs slug="acme" updateCount={2} />);

    expect(screen.getByLabelText('2 update(s) available')).toHaveTextContent('2');
  });
});
