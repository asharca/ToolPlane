import 'server-only';

import { isValidMcpRef } from '@/lib/workspace/custom-mcp';

export type ServerMetadataSource = 'github' | 'npm' | 'pypi';

export type ServerSourceMetadata = {
  source: ServerMetadataSource;
  ref: string;
  name: string;
  description: string | null;
  readme: string | null;
  author: string | null;
  canonicalSourceUrl: string;
  stars: number;
};

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_README_LENGTH = 500_000;
const REQUEST_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result ? result.slice(0, maxLength) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(2_147_483_647, Math.trunc(value)))
    : 0;
}

async function limitedText(response: Response): Promise<string> {
  const announced = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    throw new Error('Source metadata response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel('Source metadata response exceeded the byte limit').catch(() => undefined);
        throw new Error('Source metadata response is too large.');
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: HeadersInit = {},
  optional = false,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(url, {
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`Source metadata request failed (${response.status}).`);
  try {
    return record(JSON.parse(await limitedText(response)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Source metadata response is invalid.');
    throw error;
  }
}

function githubRepositoryUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:(?:git\+)?https?:\/\/github\.com\/|git:\/\/github\.com\/|git@github\.com:|github:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(value.trim());
  if (!match) return null;
  const repo = match[2].replace(/\.git$/i, '');
  return repo ? `https://github.com/${match[1]}/${repo}` : null;
}

function repositoryValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return text(record(value)?.url, 2_000);
}

async function githubMetadata(ref: string, fetchImpl: typeof fetch): Promise<ServerSourceMetadata> {
  const url = new URL(ref);
  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const token = process.env.GITHUB_TOKEN || process.env.TOOLPLANE_GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'toolplane-mcp-metadata',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const [metadata, readmeData] = await Promise.all([
    requestJson(fetchImpl, base, headers),
    requestJson(fetchImpl, `${base}/readme`, headers, true),
  ]);
  if (!metadata) throw new Error('GitHub repository metadata is missing.');
  const encodedReadme = text(readmeData?.content, Math.ceil(MAX_README_LENGTH * 1.5));
  const readme = readmeData?.encoding === 'base64' && encodedReadme
    ? Buffer.from(encodedReadme.replace(/\s/g, ''), 'base64').toString('utf8').slice(0, MAX_README_LENGTH)
    : null;
  return {
    source: 'github',
    ref,
    name: text(metadata.name, 240) ?? repo,
    description: text(metadata.description, 20_000),
    readme: text(readme, MAX_README_LENGTH),
    author: text(record(metadata.owner)?.login, 240),
    canonicalSourceUrl: `https://github.com/${owner}/${repo}`,
    stars: count(metadata.stargazers_count),
  };
}

async function npmMetadata(ref: string, fetchImpl: typeof fetch): Promise<ServerSourceMetadata> {
  const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(ref)}`;
  const headers = { accept: 'application/json', 'user-agent': 'toolplane-mcp-metadata' };
  const [metadata, packageDocument] = await Promise.all([
    requestJson(fetchImpl, `${packageUrl}/latest`, headers),
    requestJson(fetchImpl, packageUrl, headers, true).catch(() => null),
  ]);
  if (!metadata) throw new Error('npm package metadata is missing.');
  const author = metadata.author;
  return {
    source: 'npm',
    ref,
    name: text(metadata.name, 240) ?? ref,
    description: text(metadata.description, 20_000),
    readme: text(packageDocument?.readme, MAX_README_LENGTH)
      ?? text(metadata.readme, MAX_README_LENGTH),
    author: typeof author === 'string' ? text(author, 240) : text(record(author)?.name, 240),
    canonicalSourceUrl: githubRepositoryUrl(repositoryValue(metadata.repository))
      ?? `https://www.npmjs.com/package/${ref.split('/').map(encodeURIComponent).join('/')}`,
    stars: 0,
  };
}

async function pypiMetadata(ref: string, fetchImpl: typeof fetch): Promise<ServerSourceMetadata> {
  const metadata = await requestJson(
    fetchImpl,
    `https://pypi.org/pypi/${encodeURIComponent(ref)}/json`,
    { accept: 'application/json', 'user-agent': 'toolplane-mcp-metadata' },
  );
  const info = record(metadata?.info);
  if (!info) throw new Error('PyPI project metadata is missing.');
  const projectUrls = record(info.project_urls);
  const githubUrl = Object.values(projectUrls ?? {}).map(githubRepositoryUrl).find(Boolean)
    ?? githubRepositoryUrl(info.home_page);
  return {
    source: 'pypi',
    ref,
    name: text(info.name, 240) ?? ref,
    description: text(info.summary, 20_000),
    readme: text(info.description, MAX_README_LENGTH),
    author: text(info.author, 240) ?? text(info.maintainer, 240),
    canonicalSourceUrl: githubUrl ?? `https://pypi.org/project/${encodeURIComponent(ref)}/`,
    stars: 0,
  };
}

export async function fetchServerSourceMetadata(
  input: { source: ServerMetadataSource; ref: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ServerSourceMetadata> {
  const source = input.source;
  const ref = input.ref.trim();
  if (!['github', 'npm', 'pypi'].includes(source) || !isValidMcpRef(source, ref)) {
    throw new Error(`Invalid ${source} source reference.`);
  }
  if (source === 'github') return githubMetadata(ref, fetchImpl);
  if (source === 'npm') return npmMetadata(ref, fetchImpl);
  return pypiMetadata(ref, fetchImpl);
}
