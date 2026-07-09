import { Prisma, type PrismaClient } from '@prisma/client';
import { fetchGithubSkillBundle } from './bundle';
import { slugify } from './custom-skill';

export type GithubSkillRegistrySource = {
  owner: string;
  repo: string;
  ref?: string;
  rootPath?: string;
  slugPrefix?: string;
};

export type RegistrySkillEntry = {
  slug?: string;
  path: string;
  categories?: string[];
  curated?: boolean;
  score?: number;
};

export type SkillRegistrySyncResult = {
  registry: string;
  ref: string;
  rootPath: string;
  commitSha: string | null;
  found: number;
  created: number;
  updated: number;
  failed: { path: string; error: string }[];
};

type GithubEntry = {
  type: 'file' | 'dir' | string;
  name: string;
  path: string;
  download_url?: string | null;
};

type RegistryJson = {
  root?: string;
  skills?: {
    slug?: unknown;
    path?: unknown;
    categories?: unknown;
    curated?: unknown;
    score?: unknown;
  }[];
};

const DEFAULT_OWNER = 'asharca';
const DEFAULT_REPO = 'tp-skills';
const DEFAULT_REF = 'main';
const DEFAULT_ROOT = 'skills';

function cleanPart(raw: string, fallback: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, '') || fallback;
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN || process.env.TOOLPLANE_GITHUB_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'toolplane-skill-registry-sync',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function contentsUrl(source: Required<Pick<GithubSkillRegistrySource, 'owner' | 'repo' | 'ref'>>, path: string): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${encoded}?ref=${encodeURIComponent(source.ref)}`;
}

async function fetchJson<T>(url: string, optional = false): Promise<T | null> {
  const res = await fetch(url, { headers: githubHeaders(), cache: 'no-store' });
  if (optional && res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub request failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return (await res.json()) as T;
}

async function fetchRawJson<T>(url: string, optional = false): Promise<T | null> {
  const res = await fetch(url, { headers: githubHeaders(), cache: 'no-store' });
  if (optional && res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub raw request failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return (await res.json()) as T;
}

async function fetchCommitSha(source: Required<Pick<GithubSkillRegistrySource, 'owner' | 'repo' | 'ref'>>): Promise<string | null> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
  const data = await fetchJson<{ sha?: string }>(url, true);
  return data?.sha || null;
}

function normalizeSource(source: GithubSkillRegistrySource) {
  return {
    owner: cleanPart(source.owner, DEFAULT_OWNER),
    repo: cleanPart(source.repo, DEFAULT_REPO),
    ref: cleanPart(source.ref ?? DEFAULT_REF, DEFAULT_REF),
    rootPath: cleanPart(source.rootPath ?? DEFAULT_ROOT, DEFAULT_ROOT),
    slugPrefix: source.slugPrefix ?? '',
  };
}

export function defaultTpSkillsSource(): Required<GithubSkillRegistrySource> {
  return {
    owner: process.env.TP_SKILLS_OWNER || DEFAULT_OWNER,
    repo: process.env.TP_SKILLS_REPO || DEFAULT_REPO,
    ref: process.env.TP_SKILLS_REF || DEFAULT_REF,
    rootPath: process.env.TP_SKILLS_ROOT || DEFAULT_ROOT,
    slugPrefix: process.env.TP_SKILLS_SLUG_PREFIX || '',
  };
}

export function registryKey(source: Pick<GithubSkillRegistrySource, 'owner' | 'repo'>): string {
  return `github:${source.owner}/${source.repo}`;
}

function rawGithubTreeUrl(source: Required<Pick<GithubSkillRegistrySource, 'owner' | 'repo' | 'ref'>>, path: string): string {
  return `https://github.com/${source.owner}/${source.repo}/tree/${source.ref}/${path}`;
}

function rawGithubFileUrl(source: Required<Pick<GithubSkillRegistrySource, 'owner' | 'repo' | 'ref'>>, path: string): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${encoded}`;
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function categoryName(slug: string): string {
  return titleFromSlug(slug) || slug;
}

function normalizeRegistrySkill(raw: NonNullable<RegistryJson['skills']>[number], rootPath: string): RegistrySkillEntry | null {
  const path = typeof raw.path === 'string' ? cleanPart(raw.path, '') : '';
  if (!path) return null;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((value) => slugify(String(value))).filter(Boolean)
    : [];
  const score = Number(raw.score);
  return {
    slug: typeof raw.slug === 'string' && raw.slug.trim() ? slugify(raw.slug) : undefined,
    path: path.startsWith(`${rootPath}/`) || path === rootPath ? path : `${rootPath}/${path}`,
    categories,
    curated: raw.curated !== false,
    ...(Number.isFinite(score) ? { score: Math.trunc(score) } : {}),
  };
}

async function loadRegistryJson(source: ReturnType<typeof normalizeSource>): Promise<RegistrySkillEntry[] | null> {
  const registry = await fetchRawJson<RegistryJson>(rawGithubFileUrl(source, 'registry.json'), true);
  if (!registry) return null;
  const rootPath = typeof registry.root === 'string' && registry.root.trim()
    ? cleanPart(registry.root, source.rootPath)
    : source.rootPath;
  if (!Array.isArray(registry.skills)) return [];
  return registry.skills
    .map((entry) => normalizeRegistrySkill(entry, rootPath))
    .filter((entry): entry is RegistrySkillEntry => Boolean(entry));
}

async function listSkillDirectories(source: ReturnType<typeof normalizeSource>): Promise<RegistrySkillEntry[]> {
  const fromRegistry = await loadRegistryJson(source);
  if (fromRegistry) return fromRegistry;

  const entries = await fetchJson<GithubEntry[]>(contentsUrl(source, source.rootPath));
  if (!Array.isArray(entries)) throw new Error(`Registry root is not a directory: ${source.rootPath}`);
  return entries
    .filter((entry) => entry.type === 'dir')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry, index) => ({
      path: entry.path,
      curated: true,
      score: 7_000 - index,
    }));
}

async function connectCategories(db: PrismaClient, slugs: string[]) {
  const unique = [...new Set(slugs.map((slug) => slugify(slug)).filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await Promise.all(
    unique.map((slug) =>
      db.category.upsert({
        where: { slug },
        update: {},
        create: { slug, name: categoryName(slug) },
        select: { id: true },
      }),
    ),
  );
  return rows.map((row) => ({ id: row.id }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export async function syncGithubSkillRegistry(
  db: PrismaClient,
  rawSource: GithubSkillRegistrySource,
): Promise<SkillRegistrySyncResult> {
  const source = normalizeSource(rawSource);
  const registry = registryKey(source);
  const commitSha = await fetchCommitSha(source).catch(() => null);
  const entries = await listSkillDirectories(source);
  let created = 0;
  let updated = 0;
  const failed: SkillRegistrySyncResult['failed'] = [];

  for (const [index, entry] of entries.entries()) {
    try {
      const bundle = await fetchGithubSkillBundle(rawGithubTreeUrl(source, entry.path));
      const slug = slugify(`${source.slugPrefix}${entry.slug || bundle.slugHint}`);
      const existing = await db.skill.findUnique({ where: { slug }, select: { id: true } });
      const categories = await connectCategories(db, entry.categories ?? []);
      const files = bundle.files.length ? (bundle.files as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
      const score = entry.score ?? 7_000 - index;

      await db.skill.upsert({
        where: { slug },
        update: {
          name: bundle.name,
          author: bundle.author,
          description: bundle.description,
          githubSource: bundle.source.normalized,
          sourceRegistry: registry,
          sourcePath: entry.path,
          sourceSha: commitSha,
          content: bundle.content,
          files,
          score,
          curated: entry.curated !== false,
          categories: { set: categories },
        },
        create: {
          slug,
          name: bundle.name,
          author: bundle.author,
          description: bundle.description,
          githubSource: bundle.source.normalized,
          sourceRegistry: registry,
          sourcePath: entry.path,
          sourceSha: commitSha,
          content: bundle.content,
          files,
          score,
          curated: entry.curated !== false,
          categories: { connect: categories },
        },
      });

      if (existing) updated += 1;
      else created += 1;
    } catch (error) {
      failed.push({ path: entry.path, error: errorMessage(error) });
    }
  }

  await db.scrapeCheckpoint.upsert({
    where: { job: `skill-registry:${registry}:${source.rootPath}` },
    update: {
      lastSlug: commitSha,
      doneCount: created + updated,
    },
    create: {
      job: `skill-registry:${registry}:${source.rootPath}`,
      lastSlug: commitSha,
      doneCount: created + updated,
    },
  });

  return {
    registry,
    ref: source.ref,
    rootPath: source.rootPath,
    commitSha,
    found: entries.length,
    created,
    updated,
    failed,
  };
}
