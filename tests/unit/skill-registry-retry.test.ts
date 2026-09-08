// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
const mocks = vi.hoisted(() => ({ bundle: vi.fn(), upsert: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/skills/bundle', () => ({ fetchGithubSkillBundle: mocks.bundle }));
import { syncGithubSkillRegistry } from '@/lib/skills/registry';

const source = { owner: 'acme', repo: 'skills', ref: 'main', rootPath: 'skills' };
const database = { skill: { findUnique: vi.fn().mockResolvedValue(null), upsert: mocks.upsert }, auditEvent: { create: mocks.audit },
  $transaction: (run: (tx: unknown) => unknown) => run(database) };

describe('registry retry selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/commits/') ? { sha: 'abc' } : { skills: [{ path: 'one' }, { path: 'two' }] })));
    mocks.upsert.mockResolvedValue({ id: 'skill-2' });
    mocks.bundle.mockResolvedValue({ name: 'Two', slugHint: 'two', files: [], source: { normalized: 'github:acme/skills/two' }, content: '# Two' });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('updates only failed paths, preserves registry ordering and records the actor', async () => {
    const result = await syncGithubSkillRegistry(database as unknown as PrismaClient, source, { paths: ['skills/two'], actorId: 'admin-1' });
    expect(mocks.bundle).toHaveBeenCalledOnce();
    expect(mocks.bundle).toHaveBeenCalledWith('https://github.com/acme/skills/tree/main/skills/two');
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ score: 6999 }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: 'admin-1', action: 'catalog.skill.synced' }) }));
    expect(result).toMatchObject({ found: 1, created: 1, failed: [] });
  });
  it('rejects retry paths absent from the registry before fetching bundles', async () => {
    await expect(syncGithubSkillRegistry(database as unknown as PrismaClient, source, { paths: ['../../private'] })).rejects.toThrow('Retry paths');
    expect(mocks.bundle).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it('returns per-file reasons with credentials removed', async () => {
    mocks.bundle.mockRejectedValue(new Error('Authorization: Bearer sensitive-value'));
    const result = await syncGithubSkillRegistry(database as unknown as PrismaClient, source, { paths: ['skills/two'] });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe('skills/two');
    expect(result.failed[0].error).not.toContain('sensitive-value');
  });
});
