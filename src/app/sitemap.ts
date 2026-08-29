import type { MetadataRoute } from 'next';
import { getPublicSitemapEntries } from './(site)/_lib/catalog';
import { siteOrigin } from './(site)/_lib/metadata';

export const dynamic = 'force-dynamic';

const STATIC_ROUTES = [
  '/',
  '/server',
  '/client',
  '/tools/skills',
  '/agents',
  '/categories',
  '/leaderboards',
  '/daily',
  '/daily/skills',
  '/tools/skills/leaderboard',
  '/what-is-an-mcp-server',
  '/privacy',
  '/terms',
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const entries = await getPublicSitemapEntries();
  const url = (path: string) => new URL(path, origin).toString();

  return [
    ...STATIC_ROUTES.map((path) => ({
      url: url(path),
      changeFrequency: path === '/' ? ('daily' as const) : ('weekly' as const),
      priority: path === '/' ? 1 : 0.7,
    })),
    ...entries.servers.map((server) => ({
      url: url(`/server/${encodeURIComponent(server.slug)}`),
      lastModified: server.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...entries.clients.map((client) => ({
      url: url(`/client/${encodeURIComponent(client.slug)}`),
      lastModified: client.updatedAt,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    ...entries.skills.map((skill) => ({
      url: url(`/tools/skills/${encodeURIComponent(skill.slug)}`),
      lastModified: skill.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...entries.categories.map((category) => ({
      url: url(`/categories/${encodeURIComponent(category.slug)}`),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...entries.agents.map((agent) => ({
      url: url(agent.publisherWorkspace
        ? `/agents/${encodeURIComponent(agent.publisherWorkspace.slug)}/${encodeURIComponent(agent.slug)}`
        : `/agents/${encodeURIComponent(agent.directorySlug)}`),
      lastModified: agent.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
