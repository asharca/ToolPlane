// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  findInstall: vi.fn(),
  buildMarkdown: vi.fn(),
  skillLabel: vi.fn(),
  logRequest: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({
  resolveRequestUser: mocks.resolveRequestUser,
}));
vi.mock('@/lib/db', () => ({
  db: { installedSkill: { findFirst: mocks.findInstall } },
}));
vi.mock('@/lib/skills/artifact', () => ({
  buildInstalledSkillMarkdown: mocks.buildMarkdown,
}));
vi.mock('@/lib/workspace/skill-label', () => ({
  skillLabel: mocks.skillLabel,
}));
vi.mock('@/lib/observability/log', () => ({
  logRequest: mocks.logRequest,
}));

import { GET } from '@/app/api/v1/skills/[installId]/skill.md/route';

const context = { params: Promise.resolve({ installId: 'install-1' }) };

describe('installed skill.md download boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.findInstall.mockResolvedValue({
      id: 'install-1',
      skillId: 'skill-1',
      skill: { slug: 'reviewed-skill', name: 'Reviewed skill' },
      workspace: { id: 'workspace-1' },
    });
    mocks.buildMarkdown.mockReturnValue('# Reviewed skill\n');
    mocks.skillLabel.mockReturnValue({ slug: 'reviewed-skill', name: 'Reviewed skill' });
    mocks.logRequest.mockResolvedValue(undefined);
  });

  it('requires a session or Bearer-authenticated user before reading an install', async () => {
    mocks.resolveRequestUser.mockResolvedValue(null);

    const response = await GET(new Request('http://toolplane.test/api/v1/skills/install-1/skill.md'), context);

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.findInstall).not.toHaveBeenCalled();
  });

  it('scopes the requested install to workspaces available to the caller', async () => {
    const response = await GET(new Request('http://toolplane.test/api/v1/skills/install-1/skill.md', {
      headers: { authorization: 'Bearer api-token' },
    }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('# Reviewed skill\n');
    expect(mocks.resolveRequestUser).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.findInstall).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'install-1',
        workspace: {
          OR: [
            { ownerId: 'user-1' },
            { members: { some: { userId: 'user-1' } } },
          ],
        },
      },
    }));
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      path: '/skills/reviewed-skill/skill.md',
      statusCode: 200,
    }));
  });

  it('does not reveal whether an install exists outside the caller workspaces', async () => {
    mocks.findInstall.mockResolvedValue(null);

    const response = await GET(new Request('http://toolplane.test/api/v1/skills/install-1/skill.md'), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(mocks.buildMarkdown).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });
});
