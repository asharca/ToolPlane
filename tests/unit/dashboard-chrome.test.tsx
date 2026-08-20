import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/smoke/agents',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/workspace/actions', () => ({
  createWorkspaceAction: vi.fn(),
}));

vi.mock('@/lib/auth/actions', () => ({
  logoutAction: vi.fn(),
}));

const workspaces = [
  { id: 'workspace-1', slug: 'smoke', name: 'Smoke Workspace' },
  { id: 'workspace-2', slug: 'staging', name: 'Staging' },
];

function renderChrome() {
  return render(
    <DashboardChrome
      slug="smoke"
      workspaceName="Smoke Workspace"
      userLabel="smoke@example.com"
      supportEmail="support@example.com"
      workspaces={workspaces}
    >
      <main>Workspace content</main>
    </DashboardChrome>,
  );
}

describe('DashboardChrome tabs', () => {
  it('uses a route-driven top tab rail for workspace navigation', () => {
    renderChrome();

    const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' });
    expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/app/smoke/overview',
    );
    expect(within(navigation).getByRole('link', { name: 'Model Providers' })).toHaveAttribute(
      'href',
      '/app/smoke/providers',
    );
    expect(within(navigation).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/app/smoke/agents',
    );
    expect(within(navigation).getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
