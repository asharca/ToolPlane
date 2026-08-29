// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  installMarketRelease: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/chat/service', () => ({ deleteChatAssistant: vi.fn() }));
vi.mock('@/lib/market/skills', () => ({
  ignoreMarketUpdate: vi.fn(),
  MarketError: class MarketError extends Error {},
  publishAssistantRelease: vi.fn(),
  publishSkillRelease: vi.fn(),
  removeMarketInstall: vi.fn(),
}));
vi.mock('@/lib/market/resources', () => ({
  installMarketRelease: mocks.installMarketRelease,
  publishMcpRelease: vi.fn(),
  publishToolkitRelease: vi.fn(),
  updateMarketInstall: vi.fn(),
}));
vi.mock('@/lib/market/publisher-management', () => ({
  unpublishMarketListing: vi.fn(),
  withdrawMarketRelease: vi.fn(),
}));

import { installMarketResourceAction } from '@/lib/market/actions';

describe('market install action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
  });

  it.each([
    ['setup_required', '/app/acme/mcp/deployment-1?tab=variables'],
    ['stopped', '/app/acme/mcp/deployment-1'],
  ])('redirects an MCP in %s state to its next required step', async (status, expected) => {
    mocks.installMarketRelease.mockResolvedValue({
      kind: 'mcp',
      resource: { id: 'deployment-1', status },
    });
    const form = new FormData();
    form.set('workspace', 'acme');
    form.set('releaseId', 'release-1');

    await installMarketResourceAction(form);

    expect(mocks.redirect).toHaveBeenCalledWith(expected);
  });
});
