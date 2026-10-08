import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { resourceListingSchema } from '@/lib/market/listing-schema';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import { scanMarketArtifact, type MarketSecretScan } from '@/lib/market/secret-scan';

// Source provenance: immutable capture result
const npmSourceSchema = z.object({
  kind: z.literal('npm'),
  requested: z.string().min(1).max(2_000),
  name: z.string().min(1).max(240),
  version: z.string().min(1).max(240),
  integrity: z.string().min(1).max(128),
  registry: z.string().max(2_000).optional(),
}).strict();

const gitSourceSchema = z.object({
  kind: z.literal('git'),
  requested: z.string().min(1).max(2_000),
  url: z.string().min(1).max(2_000),
  commit: z.string().max(64),
}).strict();

const toolplaneSourceSchema = z.object({
  kind: z.literal('toolplane'),
  requested: z.string().min(1).max(2_000),
  name: z.string().min(1).max(240),
  version: z.string().min(1).max(240),
}).strict();
const packageSourceSchema = z.discriminatedUnion('kind', [npmSourceSchema, gitSourceSchema, toolplaneSourceSchema]);

// Single entry in the snapshot
const fileEntrySchema = z.object({
  type: z.literal('file'),
  path: z.string(),
  contentEncoding: z.literal('base64'),
  content: z.string(),
  executable: z.boolean(),
  sha256: z.string(),
}).strict();

const directoryEntrySchema = z.object({
  type: z.literal('directory'),
  path: z.string(),
}).strict();

const symlinkEntrySchema = z.object({
  type: z.literal('symlink'),
  path: z.string(),
  target: z.string(),
}).strict();

const entrySchema = z.discriminatedUnion('type', [fileEntrySchema, directoryEntrySchema, symlinkEntrySchema]);

const piPackageRuntimeSchema = z.union([
  z.object({ kind: z.literal('pi-sdk'), piVersion: z.literal('0.87.1'), nodeMajor: z.literal(24), platform: z.literal('linux'), arch: z.enum(['x64', 'arm64']) }).strict(),
  z.object({ kind: z.literal('pi-sdk'), piVersion: z.literal('0.87.1'), nodeMajor: z.literal(24), platform: z.literal('any'), arch: z.literal('any') }).strict(),
]);

export const piPackageMcpRequirementsSchema = z.array(z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  name: z.string().min(1).max(240),
  tools: z.array(z.string().min(1).max(256)).min(1).max(256),
}).strict()).max(64);

const piPackageSnapshotSchema = z.object({
  source: packageSourceSchema,
  name: z.string(),
  version: z.string().nullable(),
  runtime: piPackageRuntimeSchema,
  root: z.literal('package'),
  resources: z.object({
    extensions: z.array(z.string()),
    skills: z.array(z.string()),
    prompts: z.array(z.string()),
    themes: z.array(z.string()),
  }).strict(),
  entries: z.array(entrySchema).max(20_000),
  toolplane: z.object({
    schemaVersion: z.literal(1),
    mcp: piPackageMcpRequirementsSchema,
  }).strict().optional(),
}).strict();

const piPackageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('pi-package'),
  listing: resourceListingSchema,
  package: piPackageSnapshotSchema,
}).strict();

export type PiPackageManifestV1 = z.infer<typeof piPackageManifestSchema>;
export type PiPackageSnapshotV1 = PiPackageManifestV1['package'];
export type PiPackageEntryV1 = PiPackageSnapshotV1['entries'][number];
export type PiPackageSummary = Pick<PiPackageSnapshotV1, 'source' | 'name' | 'version' | 'runtime' | 'resources'> & {
  fileCount: number;
  totalBytes: number;
};

export function projectPiPackageSummary(snapshot: PiPackageSnapshotV1): PiPackageSummary {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of snapshot.entries) {
    if (entry.type !== 'file') continue;
    fileCount += 1;
    totalBytes += Buffer.byteLength(entry.content, 'base64');
  }
  return {
    source: snapshot.source,
    name: snapshot.name,
    version: snapshot.version,
    runtime: snapshot.runtime,
    resources: snapshot.resources,
    fileCount,
    totalBytes,
  };
}

const MAX_JSON_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function invalid(code = 'invalid'): never {
  throw new Error(`pi_package_${code}`);
}

// Count JSON bytes without first allocating an unbounded serialized manifest.
function validateJsonSize(value: unknown): void {
  let total = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 12) invalid();
    if (typeof item === 'string') {
      if (item.length > MAX_JSON_BYTES) invalid('manifest_too_large');
      total += 2 + Buffer.byteLength(item);
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        if (code === 34 || code === 92) total += 1;
        else if (code < 32) total += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) i++;
          else total += 3;
        } else if (code >= 0xdc00 && code <= 0xdfff) total += 3;
        if (total > MAX_JSON_BYTES) invalid('manifest_too_large');
      }
    } else if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      if (typeof item === 'number' && !Number.isFinite(item)) invalid();
      total += String(item).length;
    } else if (typeof item === 'object') {
      if (ancestors.has(item)) invalid();
      const record = item as Record<string, unknown>;
      if (record.type === 'file' && typeof record.content === 'string' && record.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) invalid('file_too_large');
      ancestors.add(item);
      total += 2;
      if (Array.isArray(item)) {
        if (item.length > 20_000) invalid('entries_limit');
        total += Math.max(0, item.length - 1);
        for (const child of item) visit(child, depth + 1);
      } else {
        const keys = Object.keys(item);
        if (keys.length > 20_000) invalid();
        total += Math.max(0, keys.length - 1) + keys.length;
        for (const key of keys) {
          visit(key, depth + 1);
          visit((item as Record<string, unknown>)[key], depth + 1);
        }
      }
      ancestors.delete(item);
    } else invalid();
    if (total > MAX_JSON_BYTES) invalid('manifest_too_large');
  }
  visit(value, 0);
}

function validPath(path: string): boolean {
  return path.length > 0 && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && (path === 'package' || path.startsWith('package/'));
}

function validateEntries(entries: PiPackageEntryV1[]): (path: string) => PiPackageEntryV1 | undefined {
  const byPath = new Map<string, PiPackageEntryV1>();
  const directories = new Set<string>(['package']);
  let total = 0;
  for (const entry of entries) {
    if (!validPath(entry.path) || byPath.has(entry.path)) invalid('invalid_path');
    byPath.set(entry.path, entry);
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    if (entry.type === 'directory') directories.add(entry.path);
    if (entry.type === 'file') {
      // Bound decoded length before Buffer.from: Node's decoder is otherwise permissive.
      if (entry.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) invalid('file_too_large');
      const padding = entry.content.endsWith('==') ? 2 : entry.content.endsWith('=') ? 1 : 0;
      if (entry.content.length % 4 || /[^A-Za-z0-9+/]/.test(entry.content.slice(0, entry.content.length - padding))) invalid('invalid_base64');
      const size = entry.content.length / 4 * 3 - (entry.content.endsWith('==') ? 2 : entry.content.endsWith('=') ? 1 : 0);
      if (size > MAX_FILE_BYTES) invalid('file_too_large');
      total += size;
      if (total > MAX_TOTAL_BYTES) invalid('snapshot_too_large');
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'directory' && directories.has(entry.path)) invalid('parent_conflict');
    if (entry.type === 'symlink' && (!entry.target || entry.target.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(entry.target))) invalid('invalid_symlink');
    if (entry.type === 'file') {
      const bytes = Buffer.from(entry.content, 'base64');
      if (bytes.toString('base64') !== entry.content) invalid('invalid_base64');
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) invalid('file_checksum_mismatch');
    }
  }
  const linkPaths = new Map<string, string[]>();
  function resolve(path: string): PiPackageEntryV1 | undefined {
    const pending: Array<string | { exit: string }> = path.split('/').reverse();
    let resolved: string[] = [];
    const active = new Set<string>();
    while (pending.length) {
      const part = pending.pop()!;
      if (typeof part !== 'string') {
        linkPaths.set(part.exit, resolved.slice());
        active.delete(part.exit);
        continue;
      }
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (resolved.length <= 1) invalid('symlink_escape');
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, part].join('/');
      const entry = byPath.get(candidate);
      if (entry?.type === 'symlink') {
        if (active.has(candidate)) invalid('symlink_cycle');
        const cached = linkPaths.get(candidate);
        if (cached) {
          resolved = cached.slice();
          if (byPath.get(resolved.join('/'))?.type === 'file' && pending.some((segment) => typeof segment === 'string')) invalid('parent_conflict');
          continue;
        }
        active.add(candidate);
        pending.push({ exit: candidate });
        const target = entry.target.split('/');
        for (let i = target.length - 1; i >= 0; i--) pending.push(target[i]);
      } else {
        if (!entry && !directories.has(candidate)) invalid('symlink_missing');
        if (entry?.type === 'file' && pending.some((segment) => typeof segment === 'string')) invalid('parent_conflict');
        resolved.push(part);
      }
    }
    return byPath.get(resolved.join('/')) ?? (directories.has(resolved.join('/')) ? { type: 'directory', path: resolved.join('/') } : undefined);
  }
  for (const entry of entries) if (entry.type === 'symlink') resolve(entry.path);
  return resolve;
}

function publicGitUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid('invalid_source'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !url.hostname || url.pathname === '/') invalid('invalid_source');
  return url.href;
}

function validateSource(snapshot: PiPackageSnapshotV1): void {
  const source = snapshot.source;
  if (!snapshot.name || snapshot.name.length > 240 || (snapshot.version !== null && (!snapshot.version || snapshot.version.length > 240)) || !source.requested || source.requested.length > 2_000 || /[\x00-\x1f\x7f]/.test(source.requested)) invalid('invalid_source');
  if (source.kind === 'npm') {
    if (source.registry) {
      let registry: URL;
      try { registry = new URL(source.registry); } catch { return invalid('invalid_source'); }
      if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash || (registry.port && registry.port !== '443')) invalid('invalid_source');
    }
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(source.name)
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.version)
      || snapshot.name !== source.name || snapshot.version !== source.version) invalid('invalid_source');
    const prerelease = source.version.split('+')[0].split('-').slice(1).join('-');
    if (prerelease && prerelease.split('.').some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) invalid('invalid_source');
    const build = source.version.split('+')[1];
    if (build && build.split('.').some((part) => !part)) invalid('invalid_source');
    const prefix = `npm:${source.name}`;
    if (source.requested !== prefix && (!source.requested.startsWith(`${prefix}@`) || !/^[0-9A-Za-z.*^~<>=|+ -]+$/.test(source.requested.slice(prefix.length + 1)))) invalid('invalid_source');
    const integrity = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(source.integrity);
    if (!integrity) invalid('invalid_source');
    const digest = Buffer.from(integrity[2], 'base64');
    const lengths: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
    if (digest.length !== lengths[integrity[1]] || digest.toString('base64') !== integrity[2]) invalid('invalid_source');
  } else if (source.kind === 'git') {
    if (/\s/.test(source.requested) || /[\x00-\x20\x7f]/.test(source.url)) invalid('invalid_source');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) invalid('invalid_source');
    const normalized = publicGitUrl(source.url);
    let requested = source.requested.replace(/^git:/, '');
    requested = requested.replace(/^git@([^:]+):/, 'https://$1/');
    if (!requested.includes('://') && source.requested.startsWith('git:')) requested = `https://${requested}`;
    requested = requested.split('#')[0];
    const ref = requested.lastIndexOf('@');
    if (ref > requested.indexOf('://') + 3 && ref > requested.indexOf('/', requested.indexOf('://') + 3)) requested = requested.slice(0, ref);
    if (publicGitUrl(requested) !== normalized) invalid('invalid_source');
  } else {
    if (snapshot.name !== source.name || snapshot.version !== source.version
      || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(source.name)
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.version)
      || source.requested !== `toolplane:${source.name}@${source.version}`) invalid('invalid_source');
  }
}

export function parsePiPackageReleaseManifest(value: unknown, expectedChecksum?: string): PiPackageManifestV1 {
  validateJsonSize(value);
  const parsed = piPackageManifestSchema.safeParse(value);
  if (!parsed.success) invalid();
  const manifest = parsed.data;
  validateSource(manifest.package);
  const resolve = validateEntries(manifest.package.entries);
  if (!Object.values(manifest.package.resources).some((paths) => paths.length)) invalid('resources_missing');
  const requirements = manifest.package.toolplane?.mcp ?? [];
  if (new Set(requirements.map((item) => item.key)).size !== requirements.length
    || requirements.some((item) => new Set(item.tools).size !== item.tools.length)) invalid('invalid_requirements');
  for (const [kind, paths] of Object.entries(manifest.package.resources)) {
    const seen = new Set<string>();
    for (const path of paths) {
      if (!validPath(path) || path === 'package' || seen.has(path)) invalid('invalid_resource');
      seen.add(path);
      const entry = resolve(path);
      if (!entry || (kind === 'extensions' && (entry.type !== 'file' || !/\.(?:[cm]?js|ts)$/.test(path)))) invalid('invalid_resource');
    }
  }
  if (expectedChecksum !== undefined && (!/^[a-f0-9]{64}$/.test(expectedChecksum) || marketReleaseChecksum(manifest) !== expectedChecksum)) invalid('checksum_mismatch');
  return manifest;
}

export function scanPiPackageReleaseManifest(manifest: PiPackageManifestV1, releaseNotes?: string | null): MarketSecretScan {
  const validated = parsePiPackageReleaseManifest(manifest);
  return scanMarketArtifact(validated, releaseNotes, validated.package.entries.flatMap((entry, index) => entry.type === 'file' ? [{
    path: `manifest.package.entries[${index}].content(decoded)`,
    content: Buffer.from(entry.content, 'base64').toString('utf8'),
  }] : []));
}
