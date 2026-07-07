import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_IMPORT_SKILLS,
  TEXT_SKILL_EXTENSION_SET,
} from './limits';
export {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_IMPORT_FILES,
  MAX_SKILL_IMPORT_SKILLS,
} from './limits';

export type SkillBundleFile = { path: string; content: string; encoding?: 'base64' };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const GITHUB_SHORT =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/;
const GITHUB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:(tree|blob)\/([^/]+)\/?)?(.*))?$/;

export type ParsedGithubSkillSource = {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  normalized: string;
};

export type SkillBundle = {
  slugHint: string;
  name: string;
  description: string | null;
  author: string | null;
  source: ParsedGithubSkillSource;
  content: string;
  files: SkillBundleFile[];
};

export type UploadedSkillBundle = Omit<SkillBundle, 'source'> & {
  rootPath: string | null;
};

function stripSlash(raw: string): string {
  return raw.replace(/^\/+|\/+$/g, '');
}

export function parseGithubSkillSource(raw: string): ParsedGithubSkillSource {
  const input = raw.trim().replace(/\/$/, '');
  const url = GITHUB_URL.exec(input);
  if (url) {
    const [, owner, repo, mode, refFromUrl, rest = ''] = url;
    const ref = mode ? refFromUrl || 'HEAD' : 'HEAD';
    const path = stripSlash(mode ? rest : [refFromUrl, rest].filter(Boolean).join('/'));
    return {
      owner,
      repo,
      ref,
      path,
      normalized: path
        ? `https://github.com/${owner}/${repo}/tree/${ref}/${path}`
        : `https://github.com/${owner}/${repo}`,
    };
  }

  const short = GITHUB_SHORT.exec(input);
  if (!short) throw new Error('Format must be owner/repo, owner/repo/path, or a GitHub tree URL.');
  const [, owner, repo, rest = ''] = short;
  const path = stripSlash(rest);
  return {
    owner,
    repo,
    ref: 'HEAD',
    path,
    normalized: path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`,
  };
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

export function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER.exec(content);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = yamlValue(line.slice(idx + 1));
    if (key) result[key] = val;
  }
  return result;
}

export function safeSkillFilePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (!path || path.startsWith('/') || path.includes('\0')) return null;
  const parts = path.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (parts.some((p) => p.startsWith('._') || p === '__MACOSX')) return null;
  if (parts.includes('.git') || parts.includes('node_modules')) return null;
  if (path.length > 240) return null;
  return path;
}

export function normalizeSkillFiles(files: SkillBundleFile[]): SkillBundleFile[] {
  const out: SkillBundleFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    const path = safeSkillFilePath(file.path);
    if (!path || /^SKILL\.md$/i.test(path) || seen.has(path)) continue;

    const encoding = file.encoding === 'base64' ? 'base64' : undefined;
    const bytes = encoding === 'base64'
      ? Buffer.byteLength(file.content, 'base64')
      : Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_SKILL_FILE_BYTES) {
      throw new Error(`File too large: ${path}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error('Skill bundle is too large.');
    }

    seen.add(path);
    out.push({ path, content: file.content, ...(encoding ? { encoding } : {}) });
    if (out.length > MAX_SKILL_FILES - 1) {
      throw new Error(`Skill bundle has too many files; max ${MAX_SKILL_FILES}.`);
    }
  }

  return out;
}

export function isTextSkillFile(filePath: string, contentType = ''): boolean {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
  const normalizedType = contentType.toLowerCase();
  return (
    /^SKILL\.md$/i.test(filePath.split('/').pop() ?? filePath) ||
    normalizedType.startsWith('text/') ||
    normalizedType.includes('json') ||
    normalizedType.includes('xml') ||
    normalizedType.includes('yaml') ||
    TEXT_SKILL_EXTENSION_SET.has(ext)
  );
}

function directoryName(filePath: string): string | null {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? null : filePath.slice(0, idx);
}

function rootDepth(root: string | null): number {
  return root ? root.split('/').length : 0;
}

function rootContains(root: string | null, filePath: string): boolean {
  if (!root) return true;
  return filePath.startsWith(`${root}/`);
}

function nearestSkillRoot(filePath: string, roots: (string | null)[]): string | null | undefined {
  return roots
    .filter((root) => rootContains(root, filePath))
    .sort((a, b) => rootDepth(b) - rootDepth(a))[0];
}

function stripRoot(path: string, root: string | null): string | null {
  if (!root) return path;
  if (path === root) return null;
  if (!path.startsWith(`${root}/`)) return null;
  return path.slice(root.length + 1);
}

function safeUploadedSkillFiles(rawFiles: SkillBundleFile[]): SkillBundleFile[] {
  return rawFiles
    .map((file) => {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') return null;
      const path = safeSkillFilePath(file.path);
      if (!path) return null;
      const encoding = file.encoding === 'base64' ? 'base64' : undefined;
      return { path, content: file.content, ...(encoding ? { encoding } : {}) };
    })
    .filter((file): file is SkillBundleFile => Boolean(file));
}

function buildUploadedSkillBundle(
  safeFiles: SkillBundleFile[],
  rootPath: string | null,
  roots: (string | null)[],
  fallbackName = '',
): UploadedSkillBundle {
  const rootFiles = safeFiles
    .filter((file) => nearestSkillRoot(file.path, roots) === rootPath)
    .map((file) => {
      const path = stripRoot(file.path, rootPath);
      if (!path) return null;
      return { ...file, path };
    })
    .filter((file): file is SkillBundleFile => Boolean(file));

  const skillMd = rootFiles.find((file) => /^SKILL\.md$/i.test(file.path));
  if (!skillMd) throw new Error('SKILL.md not found in the uploaded folder.');
  if (skillMd.encoding === 'base64') throw new Error('SKILL.md must be a text file.');
  if (Buffer.byteLength(skillMd.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error('SKILL.md is too large.');
  }

  const fm = parseSkillFrontmatter(skillMd.content);
  const rootName = rootPath?.split('/').pop();
  const inferredName = fallbackName.trim() || rootName || 'Uploaded skill';
  return {
    slugHint: fm.name || inferredName,
    name: fm.name || inferredName,
    description: fm.description || null,
    author: fm.author || null,
    rootPath,
    content: skillMd.content,
    files: normalizeSkillFiles(rootFiles),
  };
}

export function parseUploadedSkillBundles(
  rawFiles: SkillBundleFile[],
  fallbackName = '',
): UploadedSkillBundle[] {
  const safeFiles = safeUploadedSkillFiles(rawFiles);
  if (safeFiles.length === 0) throw new Error('Skill folder is empty.');
  const roots = Array.from(
    new Set(
      safeFiles
        .filter((file) => /(^|\/)SKILL\.md$/i.test(file.path))
        .map((file) => directoryName(file.path)),
    ),
  ).sort((a, b) => rootDepth(a) - rootDepth(b) || String(a ?? '').localeCompare(String(b ?? '')));

  if (roots.length === 0) throw new Error('SKILL.md not found in the uploaded folder.');
  if (roots.length > MAX_SKILL_IMPORT_SKILLS) {
    throw new Error(`Skill import has too many skills; max ${MAX_SKILL_IMPORT_SKILLS}.`);
  }

  return roots.map((rootPath) => buildUploadedSkillBundle(safeFiles, rootPath, roots, roots.length === 1 ? fallbackName : ''));
}

export function parseUploadedSkillBundle(
  rawFiles: SkillBundleFile[],
  fallbackName = '',
): UploadedSkillBundle {
  return parseUploadedSkillBundles(rawFiles, fallbackName)[0];
}

type GithubEntry = {
  type: 'file' | 'dir' | string;
  name: string;
  path: string;
  size?: number;
  download_url?: string | null;
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'toolplane-skill-import' } });
  if (!res.ok) throw new Error(`GitHub request failed (${res.status}).`);
  return res.json();
}

async function fetchFile(url: string, filePath: string): Promise<Pick<SkillBundleFile, 'content' | 'encoding'>> {
  const res = await fetch(url, { headers: { 'user-agent': 'toolplane-skill-import' } });
  if (!res.ok) throw new Error(`GitHub file download failed (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? '';
  const isText = isTextSkillFile(filePath, contentType);
  if (isText) return { content: buffer.toString('utf8') };
  return { content: buffer.toString('base64'), encoding: 'base64' };
}

function contentsUrl(source: ParsedGithubSkillSource, path: string): string {
  const encodedPath = path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
}

export async function fetchGithubSkillBundle(rawSource: string): Promise<SkillBundle> {
  const source = parseGithubSkillSource(rawSource);
  const rootPath = source.path;
  const rootPrefix = rootPath ? `${rootPath}/` : '';
  const files: SkillBundleFile[] = [];

  async function visit(path: string) {
    const data = await fetchJson(contentsUrl(source, path));
    const entries = Array.isArray(data) ? (data as GithubEntry[]) : [data as GithubEntry];
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await visit(entry.path);
        continue;
      }
      if (entry.type !== 'file' || !entry.download_url) continue;
      if (entry.size != null && entry.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`File too large: ${entry.path}`);
      }
      const relative = entry.path.startsWith(rootPrefix)
        ? entry.path.slice(rootPrefix.length)
        : entry.name;
      const safePath = safeSkillFilePath(relative);
      if (!safePath) continue;
      const file = await fetchFile(entry.download_url, safePath);
      files.push({ path: safePath, ...file });
      if (files.length > MAX_SKILL_FILES) {
        throw new Error(`Skill bundle has too many files; max ${MAX_SKILL_FILES}.`);
      }
    }
  }

  await visit(rootPath);

  const skillMd = files.find((file) => /^SKILL\.md$/i.test(file.path));
  if (!skillMd) throw new Error('SKILL.md not found in that GitHub folder.');
  if (Buffer.byteLength(skillMd.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error('SKILL.md is too large.');
  }

  const fm = parseSkillFrontmatter(skillMd.content);
  const fallbackName = rootPath ? rootPath.split('/').pop() || source.repo : source.repo;
  return {
    slugHint: fm.name || fallbackName,
    name: fm.name || fallbackName,
    description: fm.description || null,
    author: fm.author || source.owner,
    source,
    content: skillMd.content,
    files: normalizeSkillFiles(files),
  };
}
