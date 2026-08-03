import 'server-only';

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_HERMES_ARCHIVE_BYTES = 48 * 1024 * 1024;
export const MAX_HERMES_ARCHIVE_FILES = 2_000;
export const MAX_HERMES_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_HERMES_ARCHIVE_UNPACKED_BYTES = 256 * 1024 * 1024;

const ARCHIVE_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const MAX_ARCHIVE_PROCESS_OUTPUT = 8_000;

export class HermesArchiveError extends Error {
  constructor(message = 'The archive could not be imported. Upload a trusted ZIP containing a .hermes folder or its contents at the ZIP root.') {
    super(message);
    this.name = 'HermesArchiveError';
  }
}

export type HermesArchiveUpload = {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type StagedHermesArchive = {
  directory: string;
  fileCount: number;
  unpackedBytes: number;
  cleanup: () => Promise<void>;
};

export function isHermesArchiveUpload(value: FormDataEntryValue | null): value is File & HermesArchiveUpload {
  return Boolean(
    value
    && typeof value === 'object'
    && 'name' in value
    && 'size' in value
    && 'arrayBuffer' in value,
  );
}

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

source, destination, max_files_raw, max_file_bytes_raw, max_total_bytes_raw, max_ratio_raw = sys.argv[1:]
MAX_FILES = int(max_files_raw)
MAX_FILE_BYTES = int(max_file_bytes_raw)
MAX_TOTAL_BYTES = int(max_total_bytes_raw)
MAX_RATIO = int(max_ratio_raw)
MANAGED_EXACT = {".toolplane-env-keys.json", "skill-bundles/toolplane-agent.yaml"}
DIRECT_HOME_MARKERS = {"config.yaml", "sessions", "memories", "workspace", "skills", "plugins", "skill-bundles"}

if resource is not None:
    try:
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
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
    if info.compress_size and info.file_size > info.compress_size * MAX_RATIO:
        fail("archive compression ratio exceeds limit")
    mode = (info.external_attr >> 16) & 0xffff
    file_type = stat.S_IFMT(mode)
    if mode & (stat.S_ISUID | stat.S_ISGID):
        fail("unsafe archive permissions")
    if file_type and file_type not in (stat.S_IFREG, stat.S_IFDIR):
        fail("archive links and special files are unsupported")


def choose_root(entries):
    file_parts = [entry["parts"] for entry in entries if not entry["directory"]]
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


try:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_FILES:
            fail("archive file count is invalid")
        raw_entries = []
        declared_total = 0
        for info in infos:
            assert_zip_entry_is_safe(info)
            parts = normalized_parts(info.filename)
            if is_metadata(parts):
                continue
            declared_total += info.file_size
            if declared_total > MAX_TOTAL_BYTES:
                fail("archive exceeds unpacked size limit")
            directory = info.is_dir() or info.filename.endswith(("/", "\\"))
            raw_entries.append({"info": info, "parts": parts, "directory": directory})
        if not raw_entries:
            fail("archive file count is invalid")

        root = choose_root(raw_entries)
        targets = []
        seen = set()
        file_paths = set()
        directory_paths = set()
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
            key = path_key(relative)
            if key in seen:
                fail("archive contains duplicate paths")
            seen.add(key)
            parent_keys = [path_key(relative[:index]) for index in range(1, len(relative))]
            if entry["directory"]:
                if key in file_paths:
                    fail("archive contains conflicting paths")
                directory_paths.add(key)
            else:
                if key in directory_paths or any(parent in file_paths for parent in parent_keys):
                    fail("archive contains conflicting paths")
                file_paths.add(key)
            targets.append({**entry, "relative": relative})

        files = [entry for entry in targets if not entry["directory"]]
        if not files:
            fail("Hermes home is empty")
        counters = {"bytes": 0}
        for entry in targets:
            if entry["directory"]:
                target = ensure_destination(destination, entry["relative"])
                os.makedirs(target, mode=0o700, exist_ok=True)
                os.chmod(target, 0o700)
                continue
            target = ensure_destination(destination, entry["relative"])
            with archive.open(entry["info"], "r") as reader:
                copy_entry(reader, target, entry["info"].file_size, counters)
        print(json.dumps({"files": len(files), "bytes": counters["bytes"]}))
except (ArchiveError, zipfile.BadZipFile, OSError, RuntimeError, ValueError):
    sys.exit(2)
`;

function preferredPython(): string {
  return process.env.TOOLPLANE_PYTHON?.trim() || 'python3';
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.length >= MAX_ARCHIVE_PROCESS_OUTPUT) return current;
  return `${current}${chunk.toString('utf8')}`.slice(0, MAX_ARCHIVE_PROCESS_OUTPUT);
}

async function extractZipArchive(archivePath: string, destination: string): Promise<{
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
        String(MAX_HERMES_ARCHIVE_FILE_BYTES),
        String(MAX_HERMES_ARCHIVE_UNPACKED_BYTES),
        String(MAX_ARCHIVE_COMPRESSION_RATIO),
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
        finish(new HermesArchiveError());
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
          || unpackedBytes > MAX_HERMES_ARCHIVE_UNPACKED_BYTES
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

export async function stageHermesArchive(upload: HermesArchiveUpload): Promise<StagedHermesArchive> {
  if (!isSupportedHermesArchiveName(upload.name)) {
    throw new HermesArchiveError('Upload a .zip archive containing a .hermes folder or its contents at the ZIP root.');
  }
  if (!Number.isFinite(upload.size) || upload.size <= 0 || upload.size > MAX_HERMES_ARCHIVE_BYTES) {
    throw new HermesArchiveError(`The archive must be smaller than ${MAX_HERMES_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'toolplane-hermes-import-'));
  try {
    const archivePath = path.join(directory, 'upload.zip');
    const archive = await upload.arrayBuffer();
    if (archive.byteLength > MAX_HERMES_ARCHIVE_BYTES) {
      throw new HermesArchiveError(`The archive must be smaller than ${MAX_HERMES_ARCHIVE_BYTES / 1024 / 1024} MB.`);
    }
    await writeFile(archivePath, Buffer.from(archive), { mode: 0o600 });
    const extractionRoot = path.join(directory, 'home');
    const result = await extractZipArchive(archivePath, extractionRoot);
    return {
      directory: extractionRoot,
      fileCount: result.fileCount,
      unpackedBytes: result.unpackedBytes,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof HermesArchiveError) throw error;
    throw new HermesArchiveError();
  }
}
