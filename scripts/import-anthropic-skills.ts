import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

type GithubEntry = {
  type: 'file' | 'dir' | string;
  name: string;
  path: string;
  size?: number;
  download_url?: string | null;
};

type SkillBundleFile = { path: string; content: string; encoding?: 'base64' };

const OWNER = 'anthropics';
const REPO = 'skills';
const REF = process.env.ANTHROPIC_SKILLS_REF || 'main';
const ROOT = process.env.ANTHROPIC_SKILLS_ROOT || 'skills';
const SLUG_PREFIX = process.env.ANTHROPIC_SKILL_SLUG_PREFIX ?? 'anthropic-';
const LOCAL_DIR = process.env.ANTHROPIC_SKILLS_LOCAL_DIR?.trim();
const MAX_SKILL_FILES = 160;
const MAX_FILE_BYTES = 2_000_000;
const MAX_BUNDLE_BYTES = 12_000_000;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const TEXT_EXTENSIONS = new Set([
  '.bash',
  '.cjs',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.xsd',
]);

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN || process.env.TOOLPLANE_GITHUB_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'toolplane-anthropic-skill-import',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders(), cache: 'no-store' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

async function fetchFile(url: string, filePath: string): Promise<Pick<SkillBundleFile, 'content' | 'encoding'>> {
  const response = await fetch(url, { headers: githubHeaders(), cache: 'no-store' });
  if (!response.ok) throw new Error(`GitHub file download failed: ${response.status} ${response.statusText}`);
  return fileFromBuffer(Buffer.from(await response.arrayBuffer()), filePath, response.headers.get('content-type') ?? '');
}

function fileFromBuffer(buffer: Buffer, filePath: string, contentType = ''): Pick<SkillBundleFile, 'content' | 'encoding'> {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
  const isText = contentType.startsWith('text/') || TEXT_EXTENSIONS.has(ext);
  if (isText) return { content: buffer.toString('utf8') };
  return { content: buffer.toString('base64'), encoding: 'base64' };
}

function localSkillsRoot(): string | null {
  if (!LOCAL_DIR) return null;
  const resolved = path.resolve(LOCAL_DIR);
  return path.basename(resolved) === ROOT ? resolved : path.join(resolved, ROOT);
}

function contentsUrl(path: string): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encoded}?ref=${encodeURIComponent(REF)}`;
}

function rawGithubTreeUrl(path: string): string {
  return `https://github.com/${OWNER}/${REPO}/tree/${REF}/${path}`;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function yamlValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (key) meta[key] = yamlValue(line.slice(sep + 1));
  }
  return meta;
}

function safeSkillFilePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (!path || path.startsWith('/') || path.includes('\0')) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.startsWith('._') || part === '__MACOSX')) return null;
  if (parts.includes('.git') || parts.includes('node_modules')) return null;
  if (path.length > 240) return null;
  return path;
}

function normalizeSkillFiles(files: SkillBundleFile[]): SkillBundleFile[] {
  const out: SkillBundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    const safePath = safeSkillFilePath(file.path);
    if (!safePath || /^SKILL\.md$/i.test(safePath) || seen.has(safePath)) continue;

    const encoding = file.encoding === 'base64' ? 'base64' : undefined;
    const bytes = encoding === 'base64'
      ? Buffer.byteLength(file.content, 'base64')
      : Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`File too large: ${safePath}`);
    totalBytes += bytes;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('Skill bundle is too large.');

    seen.add(safePath);
    out.push({ path: safePath, content: file.content, ...(encoding ? { encoding } : {}) });
    if (out.length > MAX_SKILL_FILES - 1) throw new Error(`Skill bundle has too many files; max ${MAX_SKILL_FILES}.`);
  }

  return out;
}

async function listSkillDirectories(): Promise<GithubEntry[]> {
  const localRoot = localSkillsRoot();
  if (localRoot) {
    const entries = await readdir(localRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ type: 'dir', name: entry.name, path: `${ROOT}/${entry.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const entries = await fetchJson<GithubEntry[]>(contentsUrl(ROOT));
  return entries.filter((entry) => entry.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchSkillDirectory(rootPath: string): Promise<SkillBundleFile[]> {
  const localRoot = localSkillsRoot();
  if (localRoot) {
    const skillRoot = path.join(localRoot, rootPath.replace(new RegExp(`^${ROOT}/?`), ''));
    const files: SkillBundleFile[] = [];

    async function visit(absDir: string): Promise<void> {
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          await visit(absPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const relative = path.relative(skillRoot, absPath).replace(/\\/g, '/');
        const safePath = safeSkillFilePath(relative);
        if (!safePath) continue;

        const info = await stat(absPath);
        if (info.size > MAX_FILE_BYTES) throw new Error(`File too large: ${relative}`);
        files.push({ path: safePath, ...fileFromBuffer(await readFile(absPath), safePath) });
        if (files.length > MAX_SKILL_FILES) throw new Error(`Skill bundle has too many files; max ${MAX_SKILL_FILES}.`);
      }
    }

    await visit(skillRoot);
    return files;
  }

  const rootPrefix = `${rootPath}/`;
  const files: SkillBundleFile[] = [];

  async function visit(path: string): Promise<void> {
    const entries = await fetchJson<GithubEntry[] | GithubEntry>(contentsUrl(path));
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (entry.type === 'dir') {
        await visit(entry.path);
        continue;
      }
      if (entry.type !== 'file' || !entry.download_url) continue;
      if (entry.size != null && entry.size > MAX_FILE_BYTES) {
        throw new Error(`File too large: ${entry.path}`);
      }

      const relative = entry.path.startsWith(rootPrefix) ? entry.path.slice(rootPrefix.length) : entry.name;
      const safePath = safeSkillFilePath(relative);
      if (!safePath) continue;

      const file = await fetchFile(entry.download_url, safePath);
      files.push({ path: safePath, ...file });
      if (files.length > MAX_SKILL_FILES) throw new Error(`Skill bundle has too many files; max ${MAX_SKILL_FILES}.`);
    }
  }

  await visit(rootPath);
  return files;
}

async function loadSkill(directory: GithubEntry, index: number) {
  const rootPath = `${ROOT}/${directory.name}`;
  const files = await fetchSkillDirectory(rootPath);
  const skillMd = files.find((file) => /^SKILL\.md$/i.test(file.path));
  if (!skillMd) throw new Error(`SKILL.md not found: ${rootPath}`);

  const meta = parseSkillFrontmatter(skillMd.content);
  const slug = slugify(`${SLUG_PREFIX}${directory.name}`);
  if (!slug) throw new Error(`Invalid slug for ${directory.name}`);

  const name = meta.name || titleFromSlug(directory.name);
  const description = meta.description || `${titleFromSlug(directory.name)} skill from anthropics/skills.`;
  const bundleFiles = normalizeSkillFiles(files);
  const source = rawGithubTreeUrl(rootPath);

  return {
    slug,
    name,
    author: meta.author || 'Anthropic',
    description,
    source,
    content: skillMd.content,
    files: bundleFiles,
    score: 8_000 - index,
  };
}

async function upsertSkill(db: PrismaClient, directory: GithubEntry, index: number) {
  const skill = await loadSkill(directory, index);

  const row = await db.skill.upsert({
    where: { slug: skill.slug },
    update: {
      name: skill.name,
      author: skill.author,
      description: skill.description,
      githubSource: skill.source,
      content: skill.content,
      files: skill.files.length ? (skill.files as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      score: skill.score,
      curated: true,
    },
    create: {
      slug: skill.slug,
      name: skill.name,
      author: skill.author,
      description: skill.description,
      githubSource: skill.source,
      content: skill.content,
      files: skill.files.length ? (skill.files as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      score: skill.score,
      curated: true,
    },
    select: { id: true, slug: true },
  });

  return { slug: row.slug, name: skill.name, source: skill.source, files: skill.files.length };
}

async function main() {
  const db = DRY_RUN ? null : createClient();
  try {
    const directories = await listSkillDirectories();
    console.log(`Found ${directories.length} skill directories in ${OWNER}/${REPO}/${ROOT}.`);

    const imported = [];
    for (const [index, directory] of directories.entries()) {
      const result = db
        ? await upsertSkill(db, directory, index)
        : await loadSkill(directory, index).then((skill) => ({
            slug: skill.slug,
            name: skill.name,
            source: skill.source,
            files: skill.files.length,
          }));
      imported.push(result);
      console.log(`${DRY_RUN ? 'parsed' : 'upserted'} ${result.slug} (${result.files} extra file${result.files === 1 ? '' : 's'})`);
    }

    console.log(`${DRY_RUN ? 'Parsed' : 'Imported'} ${imported.length} Anthropic skills.`);
  } finally {
    await db?.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
