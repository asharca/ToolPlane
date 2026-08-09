import 'server-only';
import { unstable_cache } from 'next/cache';
import { db } from '@/lib/db';
import { getHomeSections } from '@/lib/queries/home';
import {
  getRelatedServers,
  getServer,
  listServers,
} from '@/lib/queries/servers';
import { getClient, listClients } from '@/lib/queries/clients';
import {
  getRelatedSkills,
  getSkill,
  listSkills,
  listTopSkills,
} from '@/lib/queries/skills';
import { getCategory, listCategories } from '@/lib/queries/categories';
import { listPublicAgentDirectory } from '@/lib/queries/public-agents';

const FIVE_MINUTES = 300;

// The page shell remains request-specific because locale is selected from a
// cookie/header. Only public catalog rows are shared across requests.

export const getPublicHomeSections = unstable_cache(
  getHomeSections,
  ['public-directory-home'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicServerCount = unstable_cache(
  () => db.server.count(),
  ['public-directory-server-count'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicServers = unstable_cache(
  (page: number, pageSize: number) => listServers({ page, pageSize }),
  ['public-directory-servers'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicServer = unstable_cache(
  (slug: string) => getServer(slug),
  ['public-directory-server'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicRelatedServers = unstable_cache(
  (excludeId: string, categoryIds: string[], take: number) =>
    getRelatedServers(excludeId, categoryIds, take),
  ['public-directory-related-servers'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicClients = unstable_cache(
  (page: number, pageSize: number) => listClients({ page, pageSize }),
  ['public-directory-clients'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicClientCount = unstable_cache(
  () => db.client.count(),
  ['public-directory-client-count'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicClient = unstable_cache(
  (slug: string) => getClient(slug),
  ['public-directory-client'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicSkills = unstable_cache(
  (page: number, pageSize: number) => listSkills({ page, pageSize }),
  ['public-directory-skills'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicTopSkills = unstable_cache(
  () => listTopSkills(100),
  ['public-directory-top-skills'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicSkillCount = unstable_cache(
  () => db.skill.count(),
  ['public-directory-skill-count'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicSkill = unstable_cache(
  (slug: string) => getSkill(slug),
  ['public-directory-skill'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicRelatedSkills = unstable_cache(
  (categoryIds: string[], take: number) =>
    getRelatedSkills(categoryIds, take),
  ['public-directory-related-skills'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicCategories = unstable_cache(
  listCategories,
  ['public-directory-categories'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicCategory = unstable_cache(
  (slug: string) => getCategory(slug),
  ['public-directory-category'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicAgentListing = unstable_cache(
  async (workspaceSlug: string, listingSlug: string) => {
    const result = await db.agentListing.findFirst({
      where: {
        slug: listingSlug,
        status: 'published',
        latestReleaseId: { not: null },
        publisherWorkspace: { is: { slug: workspaceSlug } },
        latestRelease: { is: { reviewStatus: 'approved' } },
      },
      select: {
        name: true,
        author: true,
        summary: true,
        iconUrl: true,
        installCount: true,
        publisherWorkspace: { select: { name: true } },
        latestRelease: {
          select: { version: true, releaseSummary: true },
        },
      },
    });
    if (!result?.publisherWorkspace || !result.latestRelease) return null;
    const raw = result.latestRelease.releaseSummary;
    const summary = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const count = (key: string) => {
      const value = summary[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
    };
    return {
      listing: {
        name: result.name,
        author: result.author,
        summary: result.summary,
        iconUrl: result.iconUrl,
        installCount: result.installCount,
      },
      workspace: result.publisherWorkspace,
      release: {
        version: result.latestRelease.version,
        summary: {
          resourceCount: count('resourceCount'),
          subAgentCount: count('subAgentCount'),
        },
      },
    };
  },
  ['public-directory-agent'],
  { revalidate: FIVE_MINUTES },
);

export const listPublicAgents = unstable_cache(
  () => listPublicAgentDirectory({ take: 24 }),
  ['public-directory-agents'],
  { revalidate: FIVE_MINUTES },
);

export const getPublicSitemapEntries = unstable_cache(
  async () => {
    const [servers, clients, skills, categories, agents] = await Promise.all([
      db.server.findMany({ select: { slug: true, updatedAt: true } }),
      db.client.findMany({ select: { slug: true, updatedAt: true } }),
      db.skill.findMany({ select: { slug: true, updatedAt: true } }),
      db.category.findMany({ select: { slug: true } }),
      db.agentListing.findMany({
        where: {
          status: 'published',
          latestReleaseId: { not: null },
          publisherWorkspace: { is: {} },
          latestRelease: { is: { reviewStatus: 'approved' } },
        },
        select: {
          slug: true,
          updatedAt: true,
          publisherWorkspace: { select: { slug: true } },
        },
      }),
    ]);
    return { servers, clients, skills, categories, agents };
  },
  ['public-directory-sitemap'],
  { revalidate: 3600 },
);
