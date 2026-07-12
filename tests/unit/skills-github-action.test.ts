import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fetchBundles: vi.fn(),
  findMany: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    installedSkill: { create: mocks.create, findMany: mocks.findMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/skills/bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skills/bundle')>()),
  fetchGithubSkillBundles: mocks.fetchBundles,
}));

import { importSkillFromGithubAction } from '@/lib/skills/actions';

function githubForm(): FormData {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('repo', 'https://github.com/tikoci/routeros-skills');
  return form;
}

describe('importSkillFromGithubAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.findMany.mockResolvedValue([{ slug: 'routeros-firewall', skill: null }]);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: `created-${data.name}`,
      ...data,
    }));
    mocks.transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
  });

  it('creates every GitHub bundle atomically with source paths and bundled files', async () => {
    mocks.fetchBundles.mockResolvedValue([
      {
        slugHint: 'routeros-firewall',
        name: 'routeros-firewall',
        description: 'Firewall rules',
        author: 'tikoci',
        source: {
          owner: 'tikoci',
          repo: 'routeros-skills',
          ref: 'HEAD',
          path: 'routeros-firewall',
          normalized: 'https://github.com/tikoci/routeros-skills/tree/HEAD/routeros-firewall',
        },
        content: '# Firewall',
        files: [{ path: 'references/dos.md', content: 'dos reference' }],
      },
      {
        slugHint: 'routeros-scripting',
        name: 'routeros-scripting',
        description: 'Router scripts',
        author: 'tikoci',
        source: {
          owner: 'tikoci',
          repo: 'routeros-skills',
          ref: 'HEAD',
          path: 'routeros-scripting',
          normalized: 'https://github.com/tikoci/routeros-skills/tree/HEAD/routeros-scripting',
        },
        content: '# Scripting',
        files: [],
      },
    ]);

    await expect(importSkillFromGithubAction({}, githubForm())).rejects.toThrow(
      'REDIRECT:/app/acme/skills?imported=created-routeros-firewall%2Ccreated-routeros-scripting',
    );

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        workspaceId: 'workspace-1',
        source: 'github',
        sourceRef: 'https://github.com/tikoci/routeros-skills/tree/HEAD/routeros-firewall',
        name: 'routeros-firewall',
        slug: 'routeros-firewall-2',
        description: 'Firewall rules',
        content: '# Firewall',
        files: [{ path: 'references/dos.md', content: 'dos reference' }],
      }),
    });
    expect(mocks.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        sourceRef: 'https://github.com/tikoci/routeros-skills/tree/HEAD/routeros-scripting',
        name: 'routeros-scripting',
        slug: 'routeros-scripting',
        files: undefined,
      }),
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/skills');
  });

  it('returns a useful GitHub error without creating partial records', async () => {
    mocks.fetchBundles.mockRejectedValue(new Error('GitHub request failed (403): API rate limit exceeded.'));

    await expect(importSkillFromGithubAction({}, githubForm())).resolves.toEqual({
      error: 'GitHub request failed (403): API rate limit exceeded.',
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
