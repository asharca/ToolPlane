import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SITE_ROOT = path.join(process.cwd(), 'src', 'app', '(site)');
const SRC_ROOT = path.join(process.cwd(), 'src');
const BLOCKED_IMPORTS = [
  '@/lib/db',
  '@/lib/queries',
  '@/lib/agents/market',
  '@/lib/workspace',
  '@/lib/auth/current-user',
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
  it('does not import authenticated workspace or live directory data', () => {
    const graph = publicDependencyGraph();
    expect(graph.some((file) => file.endsWith('components/marketing/MarketingHome.tsx'))).toBe(true);

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

  it('keeps legacy public directory routes as fixed marketing redirects', () => {
    const redirects = {
      'server/[slug]/page.tsx': '/server',
      'server/page/[page]/page.tsx': '/server',
      'tools/skills/[slug]/page.tsx': '/tools/skills',
      'tools/skills/leaderboard/page.tsx': '/tools/skills',
      'agents/[...segments]/page.tsx': '/agents',
      'client/[slug]/page.tsx': '/client',
      'categories/page.tsx': '/server',
      'categories/[slug]/page.tsx': '/server',
      'search/page.tsx': '/',
      'daily/page.tsx': '/server',
      'daily/skills/page.tsx': '/tools/skills',
      'leaderboards/page.tsx': '/server',
    } as const;

    for (const [relativePath, target] of Object.entries(redirects)) {
      const source = readFileSync(path.join(SITE_ROOT, relativePath), 'utf8');
      expect(source).toContain("from 'next/navigation'");
      expect(source).toContain(`permanentRedirect('${target}')`);
    }
  });
});
