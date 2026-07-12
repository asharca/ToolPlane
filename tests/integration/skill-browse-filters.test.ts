// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getBrowseSkills, getSkillBrowseCategories } from '@/lib/workspace/queries';

const stamp = Date.now();
const query = `filter-${stamp}`;
const ownerEmail = `skill-filter-owner-${stamp}@test.dev`;
const foreignEmail = `skill-filter-foreign-${stamp}@test.dev`;
const ownerSlug = `skill-filter-owner-${stamp}`;
const foreignSlug = `skill-filter-foreign-${stamp}`;
const networkCategorySlug = `network-${stamp}`;
const docsCategorySlug = `docs-${stamp}`;
const skillSlugs = [`${query}-github`, `${query}-other`, `${query}-uncategorized`];

let ownerWorkspaceId = '';

describe('skill browse filters', () => {
  beforeAll(async () => {
    const [owner, foreign] = await Promise.all([
      db.user.create({ data: { email: ownerEmail, passwordHash: 'x' } }),
      db.user.create({ data: { email: foreignEmail, passwordHash: 'x' } }),
    ]);
    const [ownerWorkspace, foreignWorkspace, networkCategory, docsCategory] = await Promise.all([
      db.workspace.create({
        data: {
          slug: ownerSlug,
          name: 'Skill Filter Owner',
          ownerId: owner.id,
          members: { create: { userId: owner.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: foreignSlug,
          name: 'Skill Filter Foreign',
          ownerId: foreign.id,
          members: { create: { userId: foreign.id, role: 'owner' } },
        },
      }),
      db.category.create({ data: { slug: networkCategorySlug, name: `Network ${stamp}` } }),
      db.category.create({ data: { slug: docsCategorySlug, name: `Docs ${stamp}` } }),
    ]);
    ownerWorkspaceId = ownerWorkspace.id;

    const [githubSkill, otherSkill] = await Promise.all([
      db.skill.create({
        data: {
          slug: skillSlugs[0],
          name: `${query} GitHub`,
          description: 'Network automation',
          githubSource: 'https://github.com/example/network-skill',
          curated: true,
          score: 30,
          categories: { connect: { id: networkCategory.id } },
        },
      }),
      db.skill.create({
        data: {
          slug: skillSlugs[1],
          name: `${query} Other`,
          description: 'Document automation',
          curated: false,
          score: 20,
          categories: { connect: { id: docsCategory.id } },
        },
      }),
    ]);
    await db.skill.create({
      data: {
        slug: skillSlugs[2],
        name: `${query} Uncategorized`,
        description: 'No category',
        curated: false,
        score: 10,
      },
    });
    await Promise.all([
      db.installedSkill.create({ data: { workspaceId: ownerWorkspace.id, skillId: githubSkill.id } }),
      db.installedSkill.create({ data: { workspaceId: foreignWorkspace.id, skillId: otherSkill.id } }),
    ]);
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug: { in: [ownerSlug, foreignSlug] } } });
    await db.skill.deleteMany({ where: { slug: { in: skillSlugs } } });
    await db.category.deleteMany({ where: { slug: { in: [networkCategorySlug, docsCategorySlug] } } });
    await db.user.deleteMany({ where: { email: { in: [ownerEmail, foreignEmail] } } });
    await db.$disconnect();
  });

  function filters(overrides: Partial<Parameters<typeof getBrowseSkills>[2]> = {}) {
    return {
      workspaceId: ownerWorkspaceId,
      source: 'all' as const,
      installation: 'all' as const,
      category: 'all',
      sort: 'top' as const,
      ...overrides,
    };
  }

  it('filters installation status within the current workspace', async () => {
    const installed = await getBrowseSkills(1, query, filters({ installation: 'installed' }));
    expect(installed.all.map((skill) => skill.slug)).toEqual([skillSlugs[0]]);
    expect(installed.all[0].installed).toBe(true);

    const available = await getBrowseSkills(1, query, filters({ installation: 'available' }));
    expect(available.all.map((skill) => skill.slug).sort()).toEqual([skillSlugs[1], skillSlugs[2]].sort());
    expect(available.all.every((skill) => !skill.installed)).toBe(true);
  });

  it('combines source and category filters', async () => {
    const result = await getBrowseSkills(
      1,
      query,
      filters({ source: 'other', category: docsCategorySlug }),
    );
    expect(result.total).toBe(1);
    expect(result.all[0].slug).toBe(skillSlugs[1]);
    expect(result.all[0].categories.map((category) => category.slug)).toContain(docsCategorySlug);
  });

  it('supports uncategorized filtering and name sorting', async () => {
    const uncategorized = await getBrowseSkills(1, query, filters({ category: 'uncategorized' }));
    expect(uncategorized.all.map((skill) => skill.slug)).toEqual([skillSlugs[2]]);

    const sorted = await getBrowseSkills(1, query, filters({ sort: 'name' }));
    expect(sorted.all.map((skill) => skill.name)).toEqual(
      sorted.all.map((skill) => skill.name).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it('lists only categories that contain skills', async () => {
    const categories = await getSkillBrowseCategories();
    expect(categories.find((category) => category.slug === networkCategorySlug)?._count.skills).toBe(1);
    expect(categories.find((category) => category.slug === docsCategorySlug)?._count.skills).toBe(1);
  });
});
