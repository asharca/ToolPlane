import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SITE_ROOT = path.join(process.cwd(), 'src', 'app', '(site)');
const SRC_ROOT = path.join(process.cwd(), 'src');
const BLOCKED_IMPORTS = [
  '@/lib/auth/current-user',
  '@/lib/workspace/actions',
  '@/lib/workspace/queries',
  '@/lib/skills/public-install',
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

function resolveLocalImport(specifier: string): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = path.join(SRC_ROOT, specifier.slice(2));
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function publicDependencyGraph(): string[] {
  const queue = sourceFiles(SITE_ROOT);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/["'](@\/[^"']+)["']/g)) {
      const dependency = resolveLocalImport(match[1]);
      if (dependency && !visited.has(dependency)) queue.push(dependency);
    }
  }
  return [...visited];
}

describe('public site architecture boundary', () => {
  it('reads only public catalog data and never imports authenticated mutations', () => {
    const graph = publicDependencyGraph();
    expect(graph.some((file) => file.endsWith('components/home/HomeView.tsx'))).toBe(true);
    expect(graph.some((file) => file.endsWith('lib/queries/public-search.ts'))).toBe(true);

    const violations = graph.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return BLOCKED_IMPORTS.filter((blockedImport) =>
        source.includes(blockedImport),
      ).map((blockedImport) => ({
        file: path.relative(process.cwd(), file),
        blockedImport,
      }));
    });

    expect(violations).toEqual([]);
  });

  it('keeps directory searches and legacy detail slugs usable', () => {
    const expectations = {
      'page.tsx': 'HomeView',
      'search/page.tsx': 'searchPublicDirectory',
      'server/[slug]/page.tsx': 'getPublicServer',
      'client/[slug]/page.tsx': 'getPublicClient',
      'tools/skills/[slug]/page.tsx': 'getPublicSkill',
      'agents/[...segments]/page.tsx': 'getPublicAgentListing',
    } as const;

    for (const [relativePath, marker] of Object.entries(expectations)) {
      const source = readFileSync(path.join(SITE_ROOT, relativePath), 'utf8');
      expect(source).toContain(marker);
      expect(source).not.toContain('permanentRedirect(');
    }

    const search = readFileSync(path.join(SITE_ROOT, 'search/page.tsx'), 'utf8');
    expect(search).toContain('searchParams');
    expect(search).toContain('defaultValue={query}');
    expect(search).toContain('AgentListingCard');

    const agents = readFileSync(path.join(SITE_ROOT, 'agents/page.tsx'), 'utf8');
    expect(agents).toContain('listPublicAgents');
    expect(agents).toContain('AgentListingCard');

    const category = readFileSync(path.join(SITE_ROOT, 'categories/[slug]/page.tsx'), 'utf8');
    expect(category).toContain('category.agentListings');
    expect(category).toContain('AgentListingCard');
  });

  it('defines canonical social metadata for the four public capability pages', () => {
    const pages = {
      'server/page.tsx': ["capabilityMetadata('mcp', '/server')"],
      'client/page.tsx': ['siteMetadata({', "'/client'"],
      'tools/skills/page.tsx': ['siteMetadata({', "'/tools/skills'"],
      'agents/page.tsx': ["capabilityMetadata('agents', '/agents')"],
    } as const;

    for (const [relativePath, metadataMarkers] of Object.entries(pages)) {
      const source = readFileSync(path.join(SITE_ROOT, relativePath), 'utf8');
      expect(source).toContain('generateMetadata');
      for (const marker of metadataMarkers) expect(source).toContain(marker);
    }

    const helper = readFileSync(path.join(SITE_ROOT, '_lib/metadata.ts'), 'utf8');
    expect(helper).toContain('alternates: { canonical }');
    expect(helper).toContain('openGraph:');
    expect(helper).toContain('twitter:');
  });
});
