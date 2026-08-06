import 'server-only';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES,
  hermesArchiveMaxUploadBytes,
  hermesArchiveMaxUnpackedBytes,
  normalizeHermesArchiveMaxUploadMiB,
} from './archive-limits';

// A normal long-lived Hermes home can include browser profiles, package
// managers, and caches. Keep a hard cap for central-directory / filesystem
// exhaustion, but make it large enough for a legitimate 10 GiB backup.
export const MAX_HERMES_ARCHIVE_FILES = 200_000;
export const MAX_HERMES_ARCHIVE_FILE_BYTES = HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES;
export const MAX_HERMES_ARCHIVE_UNPACKED_BYTES = HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES;
export const MAX_HERMES_ARCHIVE_RUNTIME_CONFIG_BYTES = 4 * 1024 * 1024;
// A highly-compressible small cache page is normal. Large entries still use
// the ratio check to stop a ZIP bomb before it can consume staging storage.
export const MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_HERMES_ARCHIVE_SYMLINK_TARGET_BYTES = 4 * 1024;
export const MAX_HERMES_ARCHIVE_SYMLINKS = 1_024;

const ARCHIVE_TIMEOUT_MS = 45 * 60_000;
const ARCHIVE_CPU_LIMIT_SECONDS = 30 * 60;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const MAX_ARCHIVE_PROCESS_OUTPUT = 8_000;
const STAGING_RETENTION_MS = 48 * 60 * 60_000;
const STAGING_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const STAGING_LOCK_HEARTBEAT_MS = 5 * 60_000;
// A live importer refreshes its lease every five minutes. This deliberately
// does not track the much longer end-to-end import duration: a crashed app
// should release a shared staging disk promptly, while an active copy keeps
// renewing the filesystem lease throughout its Docker phases.
const STAGING_LOCK_STALE_MS = 30 * 60_000;
const STAGING_LOCK_RECLAIM_STALE_MS = 5 * 60_000;
const STAGING_LOCK_NAME = '.toolplane-hermes-import.lock';
const STAGING_LOCK_LEASE_PREFIX = '.toolplane-hermes-import-lease-';
const STAGING_LOCK_RECLAIM_NAME = '.toolplane-hermes-import.lock-reclaim';
const STAGING_LOCK_RECLAIM_LEASE_PREFIX = '.toolplane-hermes-import-reclaim-lease-';
const STAGING_SPACE_OVERHEAD_BYTES = 64 * 1024 * 1024;

export class HermesArchiveError extends Error {
  readonly statusCode: number;

  constructor(
    message = 'The archive could not be imported. Upload a trusted ZIP containing a .hermes folder or its contents at the ZIP root.',
    statusCode = 400,
  ) {
    super(message);
    this.name = 'HermesArchiveError';
    this.statusCode = statusCode;
  }
}

export class HermesArchiveLimitError extends HermesArchiveError {
  constructor(message: string) {
    super(message, 413);
    this.name = 'HermesArchiveLimitError';
  }
}

export type HermesArchiveStreamUpload = {
  name: string;
  size?: number;
  body: ReadableStream<Uint8Array>;
};

// Retained for internal callers that used the former staging entry point. It
// is intentionally streaming-only now: accepting an arrayBuffer() here would
// reintroduce a 10 GiB Node heap allocation through a future caller.
export type HermesArchiveUpload = HermesArchiveStreamUpload;

export type StagedHermesArchive = {
  directory: string;
  fileCount: number;
  unpackedBytes: number;
  cleanup: () => Promise<void>;
};

export type HermesArchiveImportLock = {
  stagingToken: string;
  assertHeld: () => Promise<void>;
  release: () => Promise<void>;
};

export type HermesArchiveStageOptions = {
  maxUploadMiB?: number;
  // The cross-process import lock assigns this token. Naming its staging
  // directory after the lease lets crash recovery remove the exact abandoned
  // ZIP/tree as soon as the stale lease is reclaimed.
  stagingToken?: string;
};

export function isSupportedHermesArchiveName(name: string): boolean {
  return /\.zip$/i.test(name.trim());
}

const STAGE_ZIP_SCRIPT = String.raw`
import json
import os
import stat
import sys
import unicodedata
import zipfile

try:
    import resource
except ImportError:
    resource = None

source, destination, max_files_raw, max_file_bytes_raw, max_total_bytes_raw, max_ratio_raw, max_high_compression_file_bytes_raw, max_symlink_target_bytes_raw, max_symlinks_raw, cpu_limit_raw, max_runtime_config_bytes_raw = sys.argv[1:]
MAX_FILES = int(max_files_raw)
MAX_FILE_BYTES = int(max_file_bytes_raw)
MAX_TOTAL_BYTES = int(max_total_bytes_raw)
MAX_RATIO = int(max_ratio_raw)
MAX_HIGH_COMPRESSION_FILE_BYTES = int(max_high_compression_file_bytes_raw)
MAX_SYMLINK_TARGET_BYTES = int(max_symlink_target_bytes_raw)
MAX_SYMLINKS = int(max_symlinks_raw)
CPU_LIMIT_SECONDS = int(cpu_limit_raw)
MAX_RUNTIME_CONFIG_BYTES = int(max_runtime_config_bytes_raw)
MANAGED_EXACT = {".toolplane-env-keys.json", "skill-bundles/toolplane-agent.yaml"}
DIRECT_HOME_MARKERS = {"config.yaml", "sessions", "memories", "workspace", "skills", "plugins", "skill-bundles"}

if resource is not None:
    try:
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS))
    except (OSError, ValueError):
        pass


class ArchiveError(Exception):
    pass


def fail(message):
    raise ArchiveError(message)


def normalized_parts(name):
    raw = name.replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    raw = raw.rstrip("/")
    if not raw or raw.startswith("/") or "\x00" in raw:
        fail("unsafe archive path")
    parts = raw.split("/")
    if any(not part or part in (".", "..") for part in parts):
        fail("unsafe archive path")
    if parts[0].endswith(":"):
        fail("unsafe archive path")
    if any(len(part) > 180 or any(ord(char) < 32 for char in part) for part in parts):
        fail("unsafe archive path")
    return tuple(parts)


def is_metadata(parts):
    return parts[0] == "__MACOSX" or parts[-1].startswith("._")


def safe_relative_symlink_target(link_parts, target):
    # Absolute targets refer to the source machine (for example a virtualenv
    # interpreter under /Users). They are not portable into the managed Linux
    # sandbox, so skip them rather than recreating an external host reference.
    normalized = target.replace("\\", "/")
    if not normalized or "\x00" in normalized:
        fail("unsafe archive symlink")
    if normalized.startswith("/"):
        return None
    target_parts = normalized.split("/")
    if target_parts[0].endswith(":"):
        return None
    resolved = list(link_parts[:-1])
    for part in target_parts:
        if not part or part == ".":
            continue
        if part == "..":
            if not resolved:
                fail("archive symlink escapes Hermes home")
            resolved.pop()
            continue
        if len(part) > 180 or any(ord(char) < 32 for char in part):
            fail("unsafe archive symlink")
        resolved.append(part)
    return normalized


def strip_managed(parts):
    folded = tuple(unicodedata.normalize("NFC", part).casefold() for part in parts)
    joined = "/".join(folded)
    return (
        joined in MANAGED_EXACT
        or (len(folded) >= 2 and folded[0] == "skills" and folded[1] == "toolplane-agent")
    )


def path_key(parts):
    return "/".join(unicodedata.normalize("NFC", part).casefold() for part in parts)


def assert_zip_entry_is_safe(info):
    if info.flag_bits & 0x1:
        fail("encrypted entries are unsupported")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        fail("unsupported compression")
    if info.file_size < 0 or info.compress_size < 0:
        fail("invalid archive size")
    if info.file_size > MAX_FILE_BYTES:
        fail("archive file exceeds limit")
    if info.file_size and not info.compress_size:
        fail("invalid compressed size")
    if (
        info.compress_size
        and info.file_size > info.compress_size * MAX_RATIO
        and info.file_size > MAX_HIGH_COMPRESSION_FILE_BYTES
    ):
        fail("archive compression ratio exceeds limit")
    mode = (info.external_attr >> 16) & 0xffff
    file_type = stat.S_IFMT(mode)
    if mode & (stat.S_ISUID | stat.S_ISGID):
        fail("unsafe archive permissions")
    if file_type and file_type not in (stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
        fail("archive links and special files are unsupported")
    if file_type == stat.S_IFLNK and info.file_size > MAX_SYMLINK_TARGET_BYTES:
        fail("archive symlink target is too large")
    return file_type == stat.S_IFLNK


def choose_root(entries):
    file_parts = [
        entry["parts"] for entry in entries
        if not entry["directory"] and not entry["symlink"]
    ]
    # A root config is an unambiguous direct Hermes home. This also prevents a
    # nested workspace/.hermes directory from hijacking a ZIP rooted at /opt/data.
    if any(len(parts) == 1 and parts[0] == "config.yaml" for parts in file_parts):
        return tuple()
    roots = set()
    for entry in entries:
        parts = entry["parts"]
        if ".hermes" in parts:
            roots.add(parts[:parts.index(".hermes") + 1])
    outer_roots = {
        root for root in roots
        if not any(other != root and len(other) < len(root) and root[:len(other)] == other for other in roots)
    }
    if outer_roots:
        if len(outer_roots) != 1:
            fail("archive contains multiple Hermes homes")
        return next(iter(outer_roots))

    # Config-less Hermes homes are supported only when no wrapper candidate
    # exists, so a nested project .hermes cannot be mistaken for the backup root.
    if any(parts and parts[0] in DIRECT_HOME_MARKERS for parts in file_parts):
        return tuple()
    fail(".hermes folder not found")


def is_root_ancestor(parts, root):
    return bool(parts) and len(parts) < len(root) and root[:len(parts)] == parts


def ensure_destination(parent, parts):
    target = os.path.join(parent, *parts)
    resolved_parent = os.path.realpath(parent)
    resolved_target_parent = os.path.realpath(os.path.dirname(target))
    if os.path.commonpath((resolved_parent, resolved_target_parent)) != resolved_parent:
        fail("unsafe output path")
    return target


def copy_entry(reader, target, expected_size, counters):
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    copied = 0
    with open(target, "xb") as output:
        while True:
            chunk = reader.read(65536)
            if not chunk:
                break
            copied += len(chunk)
            counters["bytes"] += len(chunk)
            if copied > MAX_FILE_BYTES or counters["bytes"] > MAX_TOTAL_BYTES:
                fail("archive exceeds unpacked size limit")
            output.write(chunk)
    if copied != expected_size:
        fail("archive entry size mismatch")
    os.chmod(target, 0o600)


def read_symlink_target(archive, entry):
    try:
        raw_target = archive.read(entry["info"])
        if len(raw_target) != entry["info"].file_size:
            fail("archive symlink target is invalid")
        target = raw_target.decode("utf-8")
    except UnicodeDecodeError:
        fail("archive symlink target is invalid")
    return safe_relative_symlink_target(entry["relative"], target)


def copy_symlink(target, link_target):
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    os.symlink(link_target, target)


try:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_FILES:
            fail("archive file count is invalid")
        raw_entries = []
        declared_total = 0
        declared_symlinks = 0
        for info in infos:
            symlink = assert_zip_entry_is_safe(info)
            parts = normalized_parts(info.filename)
            if is_metadata(parts):
                continue
            if symlink:
                declared_symlinks += 1
                if declared_symlinks > MAX_SYMLINKS:
                    fail("archive contains too many symbolic links")
            declared_total += info.file_size
            if declared_total > MAX_TOTAL_BYTES:
                fail("archive exceeds unpacked size limit")
            directory = not symlink and (info.is_dir() or info.filename.endswith(("/", "\\")))
            raw_entries.append({
                "info": info,
                "parts": parts,
                "directory": directory,
                "symlink": symlink,
            })
        if not raw_entries:
            fail("archive file count is invalid")

        # The compressed ZIP is already staged beside destination. Before
        # writing any extracted entry, make sure this filesystem has room for
        # the declared uncompressed payload as well.
        statvfs = os.statvfs(os.path.dirname(destination))
        if statvfs.f_bavail * statvfs.f_frsize < declared_total:
            fail("not enough staging space")

        root = choose_root(raw_entries)
        targets = []
        seen = set()
        file_paths = set()
        directory_paths = set()
        symlink_paths = set()
        discarded_symlink_paths = set()
        for entry in raw_entries:
            parts = entry["parts"]
            if root:
                if parts[:len(root)] != root:
                    if entry["directory"] and is_root_ancestor(parts, root):
                        continue
                    fail("archive contains files outside .hermes")
                relative = parts[len(root):]
            else:
                relative = parts
            if not relative:
                continue
            if strip_managed(relative):
                continue
            if (
                not entry["directory"]
                and not entry["symlink"]
                and len(relative) == 1
                and relative[0] in {"config.yaml", ".env"}
                and entry["info"].file_size > MAX_RUNTIME_CONFIG_BYTES
            ):
                fail("Hermes configuration file exceeds limit")
            if (
                entry["symlink"]
                and len(relative) == 1
                and relative[0] in {"config.yaml", ".env"}
            ):
                fail("Hermes configuration files cannot be symbolic links")
            key = path_key(relative)
            if key in seen:
                fail("archive contains duplicate paths")
            seen.add(key)
            parent_keys = [path_key(relative[:index]) for index in range(1, len(relative))]
            if entry["directory"]:
                if key in file_paths or key in symlink_paths:
                    fail("archive contains conflicting paths")
                if any(
                    parent in file_paths
                    or parent in symlink_paths
                    or parent in discarded_symlink_paths
                    for parent in parent_keys
                ):
                    fail("archive contains conflicting paths")
                directory_paths.add(key)
                targets.append({**entry, "relative": relative})
            elif entry["symlink"]:
                if key in file_paths or key in directory_paths:
                    fail("archive contains conflicting paths")
                if any(
                    parent in file_paths
                    or parent in symlink_paths
                    or parent in discarded_symlink_paths
                    for parent in parent_keys
                ):
                    fail("archive contains conflicting paths")
                link_target = read_symlink_target(archive, {**entry, "relative": relative})
                if link_target is None:
                    discarded_symlink_paths.add(key)
                    continue
                symlink_paths.add(key)
                targets.append({**entry, "relative": relative, "link_target": link_target})
            else:
                if (
                    key in directory_paths
                    or key in symlink_paths
                    or any(
                        parent in file_paths
                        or parent in symlink_paths
                        or parent in discarded_symlink_paths
                        for parent in parent_keys
                    )
                ):
                    fail("archive contains conflicting paths")
                file_paths.add(key)
                targets.append({**entry, "relative": relative})

        # ZIP entry count limits central-directory work, while inode preflight
        # prevents many otherwise-small entries from exhausting the staging
        # filesystem during extraction. Include implicit parent directories and
        # the extraction root itself because os.makedirs creates both.
        output_paths = set()
        for entry in targets:
            relative = entry["relative"]
            for index in range(1, len(relative) + 1):
                output_paths.add(relative[:index])
        required_inodes = len(output_paths) + 1
        if statvfs.f_favail < required_inodes:
            fail("not enough staging inodes")

        files = [entry for entry in targets if not entry["directory"]]
        if not files:
            fail("Hermes home is empty")
        counters = {"bytes": 0}
        for entry in targets:
            if entry["symlink"]:
                continue
            if entry["directory"]:
                target = ensure_destination(destination, entry["relative"])
                os.makedirs(target, mode=0o700, exist_ok=True)
                os.chmod(target, 0o700)
                continue
            target = ensure_destination(destination, entry["relative"])
            with archive.open(entry["info"], "r") as reader:
                copy_entry(reader, target, entry["info"].file_size, counters)
        for entry in targets:
            if not entry["symlink"]:
                continue
            target = ensure_destination(destination, entry["relative"])
            copy_symlink(target, entry["link_target"])
        print(json.dumps({"files": len(files), "bytes": counters["bytes"]}))
except ArchiveError as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(2)
except (zipfile.BadZipFile, OSError, RuntimeError, ValueError):
    sys.exit(2)
`;

function preferredPython(): string {
  return process.env.TOOLPLANE_PYTHON?.trim() || 'python3';
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= MAX_ARCHIVE_PROCESS_OUTPUT) return current;
  return `${current}${chunk.toString('utf8')}`.slice(0, MAX_ARCHIVE_PROCESS_OUTPUT);
}

function archiveInspectionFailure(output: string): HermesArchiveError {
  try {
    const parsed = JSON.parse(output) as { error?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : '';
    const messages: Record<string, string> = {
      'archive file count is invalid': `The archive contains too many ZIP entries. It may contain at most ${MAX_HERMES_ARCHIVE_FILES.toLocaleString()}.`,
      'archive compression ratio exceeds limit': 'The archive contains a large file that expands too much when extracted.',
      'archive symlink target is too large': 'The archive contains a symbolic link with an invalid target.',
      'archive symlink target is invalid': 'The archive contains a symbolic link with an invalid target.',
      'archive symlink escapes Hermes home': 'The archive contains a symbolic link that escapes the Hermes home.',
      'unsafe archive symlink': 'The archive contains a symbolic link with an invalid target.',
      'archive contains too many symbolic links': `The archive contains too many symbolic links. It may contain at most ${MAX_HERMES_ARCHIVE_SYMLINKS.toLocaleString()}.`,
      'Hermes configuration files cannot be symbolic links': 'The archive configuration files must be regular files.',
      '.hermes folder not found': 'The archive must contain a .hermes folder or its contents at the ZIP root.',
      'archive contains files outside .hermes': 'The archive contains files outside the selected .hermes folder.',
      'archive contains multiple Hermes homes': 'The archive contains more than one .hermes folder.',
      'not enough staging inodes': 'The server does not have enough temporary filesystem entries for this archive.',
    };
    if (message in messages) return new HermesArchiveError(messages[message]);
  } catch {
    // An invalid or truncated child-process response intentionally falls back
    // to the generic safe error below.
  }
  return new HermesArchiveError();
}

async function extractZipArchive(
  archivePath: string,
  destination: string,
  limits: {
    maxFileBytes: number;
    maxUnpackedBytes: number;
    maxRuntimeConfigBytes: number;
  },
): Promise<{
  fileCount: number;
  unpackedBytes: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      preferredPython(),
      [
        '-c',
        STAGE_ZIP_SCRIPT,
        archivePath,
        destination,
        String(MAX_HERMES_ARCHIVE_FILES),
        String(limits.maxFileBytes),
        String(limits.maxUnpackedBytes),
        String(MAX_ARCHIVE_COMPRESSION_RATIO),
        String(MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES),
        String(MAX_HERMES_ARCHIVE_SYMLINK_TARGET_BYTES),
        String(MAX_HERMES_ARCHIVE_SYMLINKS),
        String(ARCHIVE_CPU_LIMIT_SECONDS),
        String(limits.maxRuntimeConfigBytes),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, result?: { fileCount: number; unpackedBytes: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new HermesArchiveError());
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new HermesArchiveError('The archive took too long to inspect.'));
    }, ARCHIVE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.resume();
    child.once('error', () => {
      finish(new HermesArchiveError('Could not inspect the archive on this server.'));
    });
    child.once('close', (code) => {
      if (code !== 0) {
        finish(archiveInspectionFailure(stdout));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { files?: unknown; bytes?: unknown };
        const fileCount = Number(parsed.files);
        const unpackedBytes = Number(parsed.bytes);
        if (
          !Number.isInteger(fileCount)
          || fileCount < 1
          || fileCount > MAX_HERMES_ARCHIVE_FILES
          || !Number.isFinite(unpackedBytes)
          || unpackedBytes < 0
          || unpackedBytes > limits.maxUnpackedBytes
        ) {
          throw new Error('Invalid archive result.');
        }
        finish(undefined, { fileCount, unpackedBytes });
      } catch {
        finish(new HermesArchiveError());
      }
    });
  });
}

type ArchiveLimits = {
  maxUploadMiB: number;
  maxUploadBytes: number;
  maxUnpackedBytes: number;
  maxRuntimeConfigBytes: number;
};

function resolveArchiveLimits(options: HermesArchiveStageOptions): ArchiveLimits {
  const maxUploadMiB = normalizeHermesArchiveMaxUploadMiB(options.maxUploadMiB);
  return {
    maxUploadMiB,
    maxUploadBytes: hermesArchiveMaxUploadBytes(maxUploadMiB),
    maxUnpackedBytes: hermesArchiveMaxUnpackedBytes(maxUploadMiB),
    maxRuntimeConfigBytes: MAX_HERMES_ARCHIVE_RUNTIME_CONFIG_BYTES,
  };
}

function archiveSizeError(maxUploadMiB: number): HermesArchiveLimitError {
  return new HermesArchiveLimitError(`The archive must be ${maxUploadMiB} MiB or smaller.`);
}

function assertArchiveMetadata(name: string, size: number | undefined, limits: ArchiveLimits) {
  if (!isSupportedHermesArchiveName(name)) {
    throw new HermesArchiveError('Upload a .zip archive containing a .hermes folder or its contents at the ZIP root.');
  }
  if (
    size !== undefined
    && (!Number.isSafeInteger(size) || size <= 0 || size > limits.maxUploadBytes)
  ) {
    throw archiveSizeError(limits.maxUploadMiB);
  }
}

function stagingRoot(): string {
  const configuredRoot = process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR?.trim();
  return path.resolve(configuredRoot || os.tmpdir());
}

const stagingMaintenanceGlobal = globalThis as typeof globalThis & {
  __hermesArchiveStagingMaintenance?: NodeJS.Timeout;
};

const processIdentityGlobal = globalThis as typeof globalThis & {
  __hermesArchiveProcessIdentity?: string;
};

function stagingLockPath(root: string): string {
  return path.join(root, STAGING_LOCK_NAME);
}

function stagingLeasePath(root: string, token: string): string {
  return path.join(root, `${STAGING_LOCK_LEASE_PREFIX}${token}`);
}

function stagingLockReclaimPath(root: string): string {
  return path.join(root, STAGING_LOCK_RECLAIM_NAME);
}

function stagingLockReclaimLeasePath(root: string, token: string): string {
  return path.join(root, `${STAGING_LOCK_RECLAIM_LEASE_PREFIX}${token}`);
}

function stagingDirectoryPrefix(token?: string): string {
  return token ? `toolplane-hermes-import-${token}-` : 'toolplane-hermes-import-';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

async function sameStagingEntry(first: string, second: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(first), stat(second)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const [bootId, rawStat] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const closingName = rawStat.lastIndexOf(')');
      const fields = closingName >= 0 ? rawStat.slice(closingName + 2).trim().split(/\s+/) : [];
      // /proc/<pid>/stat field 22 is the process start tick; `fields` starts
      // at field 3 after the executable name and state.
      const startTick = fields[19];
      if (startTick) return `linux:${bootId.trim()}:${startTick}`;
    } catch {
      // Fall through to the current-process fallback below.
    }
  }
  if (pid === process.pid) {
    // The module can be re-evaluated during development HMR, so store the
    // non-Linux identity on globalThis. A moving Date/uplink-derived value
    // could otherwise make this process look stale to its own maintenance.
    processIdentityGlobal.__hermesArchiveProcessIdentity ??= `runtime:${randomUUID()}`;
    return processIdentityGlobal.__hermesArchiveProcessIdentity;
  }
  return null;
}

type StagingLockOwnerLiveness = 'alive' | 'dead' | 'unknown';

async function stagingLockOwnerLiveness(lock: string): Promise<StagingLockOwnerLiveness> {
  try {
    const metadata = JSON.parse(await readFile(lock, 'utf8')) as {
      hostname?: unknown;
      pid?: unknown;
      processIdentity?: unknown;
    };
    // A custom container recreate can change the hostname, so a new single
    // app process cannot signal the former owner. Its lease mtime lets us
    // reclaim that *expired* record instead of permanently stranding a volume.
    // This is crash recovery, not a distributed-lock guarantee: one staging
    // path must not be mounted by concurrently running ToolPlane app instances.
    if (metadata.hostname !== os.hostname()) return 'unknown';
    const pid = metadata.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return 'dead';
    try {
      process.kill(pid, 0);
      const recordedIdentity = metadata.processIdentity;
      if (typeof recordedIdentity !== 'string' || !recordedIdentity) {
        // Old lock records cannot distinguish a reused PID. Be conservative
        // for another live local process, but reclaim a stale self-lock.
        return pid !== process.pid ? 'alive' : 'dead';
      }
      const currentIdentity = await processStartIdentity(pid);
      return currentIdentity === null || currentIdentity === recordedIdentity
        ? 'alive'
        : 'dead';
    } catch (error) {
      if (errorCode(error) === 'EPERM') return 'alive';
      return errorCode(error) === 'ESRCH' ? 'dead' : 'unknown';
    }
  } catch {
    return 'dead';
  }
}

async function stagingLockToken(lock: string): Promise<string | null> {
  try {
    const metadata = JSON.parse(await readFile(lock, 'utf8')) as { token?: unknown };
    return typeof metadata.token === 'string' && /^[a-z0-9-]{16,128}$/i.test(metadata.token)
      ? metadata.token
      : null;
  } catch {
    return null;
  }
}

async function stagingReclamationInProgress(root: string): Promise<boolean> {
  try {
    await stat(stagingLockReclaimPath(root));
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupStagingDirectoriesForToken(root: string, token: string): Promise<void> {
  try {
    const prefix = stagingDirectoryPrefix(token);
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
  } catch {
    // The next maintenance pass can retry a directory that was still busy.
  }
}

async function cleanupExpiredStagingDirectories(root: string): Promise<void> {
  const cutoff = Date.now() - STAGING_RETENTION_MS;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('toolplane-hermes-import-')) continue;
      const directory = path.join(root, entry.name);
      try {
        const upload = path.join(directory, 'upload.zip');
        const latest = await stat(upload).catch(() => stat(directory));
        if (latest.mtimeMs < cutoff) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch {
        // A concurrent cleanup or upload may have removed the entry already.
      }
    }
  } catch {
    return;
  }
}

type StagingLockReclamation = {
  release: () => Promise<void>;
};

async function acquireStagingLockReclamation(root: string): Promise<StagingLockReclamation | null> {
  const reclaim = stagingLockReclaimPath(root);
  const token = randomUUID();
  const lease = stagingLockReclaimLeasePath(root, token);
  try {
    await writeFile(lease, JSON.stringify({
      token,
      pid: process.pid,
      hostname: os.hostname(),
      processIdentity: await processStartIdentity(process.pid),
      startedAt: new Date().toISOString(),
    }), {
      flag: 'wx',
      mode: 0o600,
    });
    await link(lease, reclaim);
  } catch (error) {
    await rm(lease, { force: true }).catch(() => undefined);
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (await sameStagingEntry(reclaim, lease)) {
          await rm(reclaim, { force: true });
        }
      } finally {
        await rm(lease, { force: true });
      }
    },
  };
}

async function cleanupExpiredStagingLock(root: string): Promise<void> {
  try {
    const lock = stagingLockPath(root);
    const details = await stat(lock);
    const liveness = await stagingLockOwnerLiveness(lock);
    if (liveness === 'alive') return;
    // Same-host PID/start identity can prove a crashed process immediately.
    // An unknown hostname needs the renewed-mtime grace period instead.
    if (
      liveness === 'unknown'
      && details.mtimeMs >= Date.now() - STAGING_LOCK_STALE_MS
    ) return;

    // Serialize stale reclaimers before the second liveness check and unlink.
    // Acquirers observe this sentinel both before and after linking their own
    // lease, so two maintenance workers cannot remove a fresh replacement
    // lock between an inode check and unlink.
    const reclamation = await acquireStagingLockReclamation(root);
    if (!reclamation) return;
    try {
      const current = await stat(lock);
      const currentLiveness = await stagingLockOwnerLiveness(lock);
      if (currentLiveness === 'alive') return;
      if (
        currentLiveness === 'unknown'
        && current.mtimeMs >= Date.now() - STAGING_LOCK_STALE_MS
      ) return;
      const token = await stagingLockToken(lock);
      await rm(lock, { force: true });
      if (token) await cleanupStagingDirectoriesForToken(root, token);
    } finally {
      await reclamation.release();
    }
  } catch {
    // There is no lock, or another process released it while maintenance ran.
  }
}

async function cleanupExpiredStagingLeases(root: string): Promise<void> {
  const cutoff = Date.now() - STAGING_LOCK_STALE_MS;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(STAGING_LOCK_LEASE_PREFIX)) continue;
      const lease = path.join(root, entry.name);
      try {
        if (
          (await stat(lease)).mtimeMs < cutoff
          && await stagingLockOwnerLiveness(lease) !== 'alive'
        ) {
          await rm(lease, { force: true });
        }
      } catch {
        // A concurrent release or cleanup may have removed the lease already.
      }
    }
  } catch {
    return;
  }
}

async function cleanupExpiredStagingLockReclamation(root: string): Promise<void> {
  try {
    const reclaim = stagingLockReclaimPath(root);
    const details = await stat(reclaim);
    const liveness = await stagingLockOwnerLiveness(reclaim);
    if (
      liveness === 'dead'
      || (liveness === 'unknown' && details.mtimeMs < Date.now() - STAGING_LOCK_RECLAIM_STALE_MS)
    ) {
      await rm(reclaim, { force: true });
    }
  } catch {
    // There is no concurrent stale-lock reclaimer to recover.
  }
}

async function cleanupExpiredStagingLockReclaimLeases(root: string): Promise<void> {
  const cutoff = Date.now() - STAGING_LOCK_RECLAIM_STALE_MS;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(STAGING_LOCK_RECLAIM_LEASE_PREFIX)) continue;
      const lease = path.join(root, entry.name);
      try {
        if (
          (await stat(lease)).mtimeMs < cutoff
          && await stagingLockOwnerLiveness(lease) !== 'alive'
        ) {
          await rm(lease, { force: true });
        }
      } catch {
        // A concurrent reclaimer may have released this private lease.
      }
    }
  } catch {
    return;
  }
}

async function runStagingMaintenance(root = stagingRoot()): Promise<void> {
  await Promise.all([
    cleanupExpiredStagingDirectories(root),
    cleanupExpiredStagingLock(root),
    cleanupExpiredStagingLeases(root),
    cleanupExpiredStagingLockReclamation(root),
    cleanupExpiredStagingLockReclaimLeases(root),
  ]);
}

export async function cleanupHermesArchiveStaging(): Promise<void> {
  await runStagingMaintenance();
}

function ensureStagingMaintenance(): void {
  if (stagingMaintenanceGlobal.__hermesArchiveStagingMaintenance) return;
  void runStagingMaintenance();
  const timer = setInterval(() => {
    void runStagingMaintenance();
  }, STAGING_MAINTENANCE_INTERVAL_MS);
  timer.unref();
  stagingMaintenanceGlobal.__hermesArchiveStagingMaintenance = timer;
}

function requiredStagingBytes(announcedBytes: number | undefined, limits: ArchiveLimits): number {
  // A request without Content-Length is still supported, but it must reserve
  // enough capacity for the largest allowed ZIP and extracted Hermes home.
  const archiveBytes = announcedBytes ?? limits.maxUploadBytes;
  return archiveBytes + limits.maxUnpackedBytes + STAGING_SPACE_OVERHEAD_BYTES;
}

async function assertStagingCapacity(root: string, requiredBytes: number): Promise<void> {
  try {
    const filesystem = await statfs(root);
    const availableBytes = filesystem.bavail * filesystem.bsize;
    if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
      throw new HermesArchiveError(
        'The server does not have enough temporary storage for this archive.',
        507,
      );
    }
  } catch (error) {
    if (error instanceof HermesArchiveError) throw error;
    // Some development filesystems do not expose statfs. The stream still
    // handles write failures and always removes its partial staging directory.
  }
}

async function createStagingDirectory(
  announcedBytes: number | undefined,
  limits: ArchiveLimits,
  stagingToken?: string,
): Promise<string> {
  const root = stagingRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await runStagingMaintenance(root);
  await assertStagingCapacity(root, requiredStagingBytes(announcedBytes, limits));
  const prefix = stagingToken && /^[a-z0-9-]{16,128}$/i.test(stagingToken)
    ? stagingDirectoryPrefix(stagingToken)
    : stagingDirectoryPrefix();
  return mkdtemp(path.join(root, prefix));
}

// The app runs a single large import per shared staging volume. The lock is a
// filesystem entry rather than an in-memory semaphore so it survives a
// restarted single ToolPlane app process. This is deliberately not a
// distributed lock service; one staging volume belongs to one active app.
export async function acquireHermesArchiveImportLock(): Promise<HermesArchiveImportLock | null> {
  const root = stagingRoot();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await runStagingMaintenance(root);
    if (await stagingReclamationInProgress(root)) return null;
    const lock = stagingLockPath(root);
    const token = randomUUID();
    const lease = stagingLeasePath(root, token);
    const identity = await processStartIdentity(process.pid);
    try {
      await writeFile(lease, JSON.stringify({
        token,
        pid: process.pid,
        hostname: os.hostname(),
        processIdentity: identity,
        startedAt: new Date().toISOString(),
      }), {
        flag: 'wx',
        mode: 0o600,
      });
      await link(lease, lock);
    } catch (error) {
      await rm(lease, { force: true }).catch(() => undefined);
      if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        return null;
      }
      throw error;
    }

    // A stale-lock reclaimer may have started after our first sentinel check.
    // Yield this new lease to it instead of letting the reclaimer accidentally
    // unlink a fresh canonical lock that it had not observed yet.
    if (await stagingReclamationInProgress(root)) {
      try {
        if (await sameStagingEntry(lock, lease)) {
          await rm(lock, { force: true });
        }
      } finally {
        await rm(lease, { force: true });
      }
      return null;
    }

    let released = false;
    let leaseLost = false;
    const assertHeld = async () => {
      if (leaseLost || !await sameStagingEntry(lock, lease)) {
        leaseLost = true;
        throw new HermesArchiveError(
          'The archive import lost its temporary-storage reservation. Retry the import.',
          409,
        );
      }
    };
    const heartbeat = setInterval(() => {
      void (async () => {
        await assertHeld();
        // The canonical lock and this owner-only lease are hard links to the
        // same inode. Updating the private lease refreshes the lock without
        // ever touching a replacement lock created after a stale reclaim.
        await utimes(lease, new Date(), new Date());
      })().catch(() => {
        // Never renew or remove a lock we no longer own. The route checks the
        // lease again before mutating a sandbox and will clean its staging
        // directory rather than competing with a newer importer.
        leaseLost = true;
      });
    }, STAGING_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    return {
      stagingToken: token,
      assertHeld,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          if (await sameStagingEntry(lock, lease)) {
            await rm(lock, { force: true });
          }
        } finally {
          await rm(lease, { force: true });
        }
      },
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null;
    }
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new HermesArchiveError('The server does not have enough temporary storage for this archive.', 507);
    }
    throw new HermesArchiveError('Could not prepare temporary storage for this archive.', 500);
  }
}

function stageFailure(error: unknown): HermesArchiveError {
  if (error instanceof HermesArchiveError) return error;
  if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOSPC') {
    return new HermesArchiveError('The server does not have enough temporary storage for this archive.', 507);
  }
  return new HermesArchiveError();
}

async function stageArchiveFile(
  directory: string,
  archivePath: string,
  limits: ArchiveLimits,
): Promise<StagedHermesArchive> {
  const extractionRoot = path.join(directory, 'home');
  const result = await extractZipArchive(archivePath, extractionRoot, {
    maxFileBytes: limits.maxUnpackedBytes,
    maxUnpackedBytes: limits.maxUnpackedBytes,
    maxRuntimeConfigBytes: limits.maxRuntimeConfigBytes,
  });
  return {
    directory: extractionRoot,
    fileCount: result.fileCount,
    unpackedBytes: result.unpackedBytes,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function writeArchiveStream(
  body: ReadableStream<Uint8Array>,
  archivePath: string,
  limits: ArchiveLimits,
): Promise<number> {
  let receivedBytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > limits.maxUploadBytes) {
        callback(archiveSizeError(limits.maxUploadMiB));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    limit,
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
  );
  if (receivedBytes <= 0) {
    throw new HermesArchiveError('Choose a non-empty .zip archive to import.');
  }
  return receivedBytes;
}

export async function stageHermesArchive(
  upload: HermesArchiveUpload,
  options: HermesArchiveStageOptions = {},
): Promise<StagedHermesArchive> {
  return stageHermesArchiveStream(upload, options);
}

// The streaming variant is used by the raw-body Route Handler. It deliberately
// never calls FormData or File.arrayBuffer(), so a 10 GiB archive remains on
// disk instead of being materialized in the Node.js heap.
export async function stageHermesArchiveStream(
  upload: HermesArchiveStreamUpload,
  options: HermesArchiveStageOptions = {},
): Promise<StagedHermesArchive> {
  const limits = resolveArchiveLimits(options);
  assertArchiveMetadata(upload.name, upload.size, limits);

  const directory = await createStagingDirectory(upload.size, limits, options.stagingToken);
  try {
    const archivePath = path.join(directory, 'upload.zip');
    await writeArchiveStream(upload.body, archivePath, limits);
    return await stageArchiveFile(directory, archivePath, limits);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw stageFailure(error);
  }
}

ensureStagingMaintenance();
