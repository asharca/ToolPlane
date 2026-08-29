import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  revalidatePath: vi.fn(),
  setServerRecipe: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({ db: { server: { findUnique: vi.fn() } } }));
vi.mock('@/lib/admin/market', () => ({
  createDirectoryServer: vi.fn(),
  updateDirectoryServer: vi.fn(),
  deleteDirectoryServer: vi.fn(),
  createDirectorySkill: vi.fn(),
  updateDirectorySkill: vi.fn(),
  deleteDirectorySkill: vi.fn(),
  setServerRecipe: mocks.setServerRecipe,
  setServerVerified: vi.fn(),
}));
vi.mock('@/lib/admin/recipe-validate', () => ({ validateServerRecipe: vi.fn() }));
vi.mock('@/lib/admin/server-source', () => ({ fetchServerSourceMetadata: vi.fn() }));
vi.mock('@/lib/skills/bundle', () => ({ fetchGithubSkillBundle: vi.fn() }));
vi.mock('@/lib/skills/registry', () => ({ syncGithubSkillRegistry: vi.fn() }));

import { setServerRecipeAction } from '@/lib/admin/market-actions';

describe('admin connector recipe action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.setServerRecipe.mockResolvedValue({});
  });

  it('stores a remote connector with validated header-to-secret mappings', async () => {
    const form = new FormData();
    form.set('id', 'server-1');
    form.set('recipeSource', 'remote');
    form.set('recipeRef', 'https://mcp.example.com/mcp');
    form.set('recipeSourceUrl', 'https://github.com/acme/mcp');
    form.set('recipeTransport', 'sse');
    form.set('recipeAuthType', 'headers');
    form.set('recipeHeaderEnv', [
      'X-API-Key=MCP_API_KEY',
      'X-Tenant-ID=MCP_TENANT_ID',
      'Authorization=SHOULD_BE_REJECTED',
    ].join('\n'));

    await expect(setServerRecipeAction({}, form)).resolves.toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.setServerRecipe).toHaveBeenCalledWith('server-1', {
      source: 'remote',
      ref: 'https://mcp.example.com/mcp',
      sourceUrl: 'https://github.com/acme/mcp',
      env: ['MCP_API_KEY', 'MCP_TENANT_ID'],
      transport: 'sse',
      authType: 'headers',
      headerEnv: {
        'X-API-Key': 'MCP_API_KEY',
        'X-Tenant-ID': 'MCP_TENANT_ID',
      },
    });
  });
});
