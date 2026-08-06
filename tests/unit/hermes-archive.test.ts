import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  HermesArchiveError,
  MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES,
  MAX_HERMES_ARCHIVE_RUNTIME_CONFIG_BYTES,
  MAX_HERMES_ARCHIVE_SYMLINKS,
  MAX_HERMES_ARCHIVE_SYMLINK_TARGET_BYTES,
  acquireHermesArchiveImportLock,
  stageHermesArchive,
  stageHermesArchiveStream,
  type HermesArchiveUpload,
} from '@/lib/agents/hermes/archive';

type ZipEntry = {
  name: string;
  content?: string;
  mode?: number;
  compression?: 'deflate';
};

function crc32(content: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of content) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const compressed = entry.compression === 'deflate' ? deflateRawSync(content) : content;
    const compressionMethod = entry.compression === 'deflate' ? 8 : 0;
    const directory = entry.name.endsWith('/');
    const mode = entry.mode ?? (directory ? 0o40755 : 0o100600);
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(centralDirectory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, footer]);
}

function upload(name: string, content: Buffer): HermesArchiveUpload {
  return {
    name,
    size: content.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    }),
  };
}

function streamUpload(name: string, content: Buffer) {
  return {
    name,
    size: content.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const midpoint = Math.max(1, Math.floor(content.byteLength / 2));
        controller.enqueue(content.subarray(0, midpoint));
        controller.enqueue(content.subarray(midpoint));
        controller.close();
      },
    }),
  };
}

describe('Hermes archive staging', () => {
  it('enforces a configured upload limit before reading the file body', async () => {
    const body = vi.fn(() => new ReadableStream<Uint8Array>());
    await expect(stageHermesArchive({
      name: 'too-large.zip',
      size: 2 * 1024 * 1024,
      get body() {
        return body();
      },
    }, { maxUploadMiB: 1 })).rejects.toBeInstanceOf(HermesArchiveError);

    expect(body).not.toHaveBeenCalled();
  });

  it('rechecks the actual file body against the configured upload limit', async () => {
    const body = new Uint8Array(1024 * 1024 + 1);
    await expect(stageHermesArchive({
      name: 'mismatched-size.zip',
      size: 1,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    }, { maxUploadMiB: 1 })).rejects.toBeInstanceOf(HermesArchiveError);
  });

  it('streams an archive to disk before ZIP inspection without materializing a File arrayBuffer', async () => {
    const staged = await stageHermesArchiveStream(streamUpload('streamed.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/workspace/notes.txt', content: 'hello' },
    ])));
    try {
      await expect(readFile(path.join(staged.directory, 'workspace/notes.txt'), 'utf8')).resolves.toBe('hello');
    } finally {
      await staged.cleanup();
    }
  });

  it('enforces the configured limit while consuming a stream with an untrusted content length', async () => {
    const body = new Uint8Array(1024 * 1024 + 1);
    await expect(stageHermesArchiveStream({
      name: 'too-large-stream.zip',
      size: 1,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    }, { maxUploadMiB: 1 })).rejects.toBeInstanceOf(HermesArchiveError);
  });

  it('normalizes a .hermes wrapper and strips ToolPlane-owned paths', async () => {
    const staged = await stageHermesArchive(upload('backup.zip', zip([
      { name: '.hermes/' },
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/sessions/session.json', content: '{"id":"one"}' },
      { name: '.hermes/workspace/project/.hermes/plugin.yaml', content: 'nested config' },
      { name: '.hermes/skills/toolplane-agent/unsafe/SKILL.md', content: 'ignored' },
      { name: '.hermes/skill-bundles/toolplane-agent.yaml', content: 'ignored' },
      { name: '.hermes/.toolplane-env-keys.json', content: '["TOKEN"]' },
    ])));

    try {
      await expect(readFile(path.join(staged.directory, 'config.yaml'), 'utf8')).resolves.toBe('model: imported');
      await expect(readFile(path.join(staged.directory, 'sessions/session.json'), 'utf8')).resolves.toBe('{"id":"one"}');
      await expect(readFile(path.join(staged.directory, 'workspace/project/.hermes/plugin.yaml'), 'utf8')).resolves.toBe('nested config');
      await expect(access(path.join(staged.directory, 'skills/toolplane-agent'))).rejects.toThrow();
      await expect(access(path.join(staged.directory, '.toolplane-env-keys.json'))).rejects.toThrow();
      expect(staged.fileCount).toBe(3);
    } finally {
      await staged.cleanup();
    }
  });

  it('accepts a ZIP whose root is already a Hermes home', async () => {
    const staged = await stageHermesArchive(upload('home.zip', zip([
      { name: 'config.yaml', content: 'model: imported' },
      { name: 'workspace/notes.txt', content: 'hello' },
    ])));
    try {
      await expect(readFile(path.join(staged.directory, 'workspace/notes.txt'), 'utf8')).resolves.toBe('hello');
    } finally {
      await staged.cleanup();
    }
  });

  it('preserves explicit empty directories', async () => {
    const staged = await stageHermesArchive(upload('empty-directory.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/workspace/empty/' },
    ])));
    try {
      const directory = await lstat(path.join(staged.directory, 'workspace/empty'));
      expect(directory.isDirectory()).toBe(true);
    } finally {
      await staged.cleanup();
    }
  });

  it('normalizes Windows separators and reserves managed path variants', async () => {
    const staged = await stageHermesArchive(upload('windows.zip', zip([
      { name: '.hermes\\' },
      { name: '.hermes\\config.yaml', content: 'model: imported' },
      { name: '.hermes\\workspace\\' },
      { name: '.hermes\\workspace\\notes.txt', content: 'hello' },
      { name: '.hermes\\skills\\ToolPlane-Agent\\unsafe\\SKILL.md', content: 'ignored' },
    ])));
    try {
      await expect(readFile(path.join(staged.directory, 'workspace/notes.txt'), 'utf8')).resolves.toBe('hello');
      await expect(access(path.join(staged.directory, 'skills/ToolPlane-Agent'))).rejects.toThrow();
    } finally {
      await staged.cleanup();
    }
  });

  it('keeps a direct Hermes home when its workspace has a nested .hermes directory', async () => {
    const staged = await stageHermesArchive(upload('direct-home.zip', zip([
      { name: 'config.yaml', content: 'model: imported' },
      { name: 'workspace/project/.hermes/plugin.yaml', content: 'nested config' },
    ])));
    try {
      await expect(readFile(path.join(staged.directory, 'config.yaml'), 'utf8')).resolves.toBe('model: imported');
      await expect(readFile(path.join(staged.directory, 'workspace/project/.hermes/plugin.yaml'), 'utf8')).resolves.toBe('nested config');
    } finally {
      await staged.cleanup();
    }
  });

  it('accepts macOS metadata and more than the legacy two-thousand entry limit', async () => {
    const metadata = Array.from({ length: 2_000 }, (_value, index) => ({
      name: `__MACOSX/._${index}`,
    }));
    const staged = await stageHermesArchive(upload('finder-backup.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      ...metadata,
    ])));
    try {
      expect(staged.fileCount).toBe(1);
    } finally {
      await staged.cleanup();
    }
  });

  it('preserves internal symlinks and skips host-specific absolute symlinks', async () => {
    const staged = await stageHermesArchive(upload('portable-links.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/target.txt', content: 'hello' },
      { name: '.hermes/links/internal', content: '../target.txt', mode: 0o120777 },
      { name: '.hermes/links/trailing-slash/', content: '../target.txt', mode: 0o120777 },
      { name: '.hermes/links/source-machine', content: '/Users/example/.venv/bin/python', mode: 0o120777 },
      { name: '.hermes/links/windows-machine', content: 'C:\\Users\\example\\python.exe', mode: 0o120777 },
      { name: '.hermes/links/network-machine', content: '\\\\server\\share\\python.exe', mode: 0o120777 },
    ])));
    try {
      const internal = path.join(staged.directory, 'links/internal');
      expect((await lstat(internal)).isSymbolicLink()).toBe(true);
      await expect(readlink(internal)).resolves.toBe('../target.txt');
      await expect(readFile(internal, 'utf8')).resolves.toBe('hello');
      const trailing = path.join(staged.directory, 'links/trailing-slash');
      expect((await lstat(trailing)).isSymbolicLink()).toBe(true);
      await expect(readlink(trailing)).resolves.toBe('../target.txt');
      await expect(access(path.join(staged.directory, 'links/source-machine'))).rejects.toThrow();
      await expect(access(path.join(staged.directory, 'links/windows-machine'))).rejects.toThrow();
      await expect(access(path.join(staged.directory, 'links/network-machine'))).rejects.toThrow();
    } finally {
      await staged.cleanup();
    }
  });

  it('rejects a symlink that escapes the Hermes home', async () => {
    await expect(stageHermesArchive(upload('escaping-link.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/escape', content: '../outside', mode: 0o120777 },
    ])))).rejects.toMatchObject({
      message: 'The archive contains a symbolic link that escapes the Hermes home.',
    });
  });

  it('rejects entries nested below a symbolic link', async () => {
    await expect(stageHermesArchive(upload('link-parent.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      { name: '.hermes/link', content: 'target', mode: 0o120777 },
      { name: '.hermes/link/child.txt', content: 'must not follow link' },
    ])))).rejects.toBeInstanceOf(HermesArchiveError);
  });

  it('requires regular configuration files and small symlink targets', async () => {
    await expect(stageHermesArchive(upload('linked-config.zip', zip([
      { name: '.hermes/config.yaml', content: 'other.yaml', mode: 0o120777 },
      { name: '.hermes/other.yaml', content: 'model: imported' },
    ])))).rejects.toMatchObject({
      message: 'The archive configuration files must be regular files.',
    });
    await expect(stageHermesArchive(upload('oversized-link-target.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      {
        name: '.hermes/link',
        content: 'x'.repeat(MAX_HERMES_ARCHIVE_SYMLINK_TARGET_BYTES + 1),
        mode: 0o120777,
      },
    ])))).rejects.toMatchObject({
      message: 'The archive contains a symbolic link with an invalid target.',
    });
  });

  it('caps symbolic links even when host-specific targets are discarded', async () => {
    const links = Array.from({ length: MAX_HERMES_ARCHIVE_SYMLINKS + 1 }, (_value, index) => ({
      name: `.hermes/links/source-${index}`,
      content: `/Users/source/.hermes/link-${index}`,
      mode: 0o120777,
    }));
    await expect(stageHermesArchive(upload('too-many-links.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      ...links,
    ])))).rejects.toMatchObject({
      message: `The archive contains too many symbolic links. It may contain at most ${MAX_HERMES_ARCHIVE_SYMLINKS.toLocaleString()}.`,
    });
  });

  it('allows highly-compressible cache files up to the small-file allowance', async () => {
    const staged = await stageHermesArchive(upload('compressed-cache.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      {
        name: '.hermes/cache/repetitive.bin',
        content: '0'.repeat(MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES),
        compression: 'deflate',
      },
    ])));
    try {
      await expect(readFile(path.join(staged.directory, 'cache/repetitive.bin'), 'utf8'))
        .resolves.toHaveLength(MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES);
    } finally {
      await staged.cleanup();
    }
  });

  it('continues to reject a large high-compression entry', async () => {
    await expect(stageHermesArchive(upload('compressed-bomb.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      {
        name: '.hermes/cache/repetitive.bin',
        content: '0'.repeat(MAX_HERMES_ARCHIVE_HIGH_COMPRESSION_FILE_BYTES + 1),
        compression: 'deflate',
      },
    ])))).rejects.toMatchObject({
      message: 'The archive contains a large file that expands too much when extracted.',
    });
  });

  it('keeps configuration files small even when the archive limit is raised', async () => {
    await expect(stageHermesArchive(upload('large-config.zip', zip([
      { name: '.hermes/config.yaml', content: 'a'.repeat(MAX_HERMES_ARCHIVE_RUNTIME_CONFIG_BYTES + 1) },
    ])), { maxUploadMiB: 10_240 })).rejects.toBeInstanceOf(HermesArchiveError);
  });

  it('serializes imports that share a staging volume', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-hermes-lock-'));
    const previousRoot = process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
    process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = root;
    try {
      const first = await acquireHermesArchiveImportLock();
      expect(first).not.toBeNull();
      await expect(acquireHermesArchiveImportLock()).resolves.toBeNull();
      await first?.assertHeld();
      await first?.release();

      const second = await acquireHermesArchiveImportLock();
      expect(second).not.toBeNull();
      await second?.release();
    } finally {
      if (previousRoot === undefined) delete process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
      else process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lease from a recreated container and its matching staging tree', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-hermes-stale-lock-'));
    const previousRoot = process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
    process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = root;
    const token = 'stale-import-token-0001';
    const staleLock = path.join(root, '.toolplane-hermes-import.lock');
    const staleDirectory = path.join(root, `toolplane-hermes-import-${token}-orphan`);
    try {
      await mkdir(staleDirectory);
      await writeFile(path.join(staleDirectory, 'upload.zip'), 'partial');
      await writeFile(staleLock, JSON.stringify({
        token,
        hostname: `recreated-${os.hostname()}`,
        pid: 1,
        processIdentity: 'previous-container',
      }));
      const expired = new Date(Date.now() - 31 * 60_000);
      await utimes(staleLock, expired, expired);

      const lock = await acquireHermesArchiveImportLock();

      expect(lock).not.toBeNull();
      await expect(access(staleDirectory)).rejects.toThrow();
      await lock?.release();
    } finally {
      if (previousRoot === undefined) delete process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
      else process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('immediately reclaims a fresh lock when stable host process identity proves its owner died', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-hermes-dead-lock-'));
    const previousRoot = process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
    process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = root;
    const token = 'dead-import-token-0001';
    const staleLock = path.join(root, '.toolplane-hermes-import.lock');
    const staleDirectory = path.join(root, `toolplane-hermes-import-${token}-orphan`);
    try {
      await mkdir(staleDirectory);
      await writeFile(staleLock, JSON.stringify({
        token,
        hostname: os.hostname(),
        pid: process.pid,
        processIdentity: 'previous-process-instance',
      }));

      const lock = await acquireHermesArchiveImportLock();

      expect(lock).not.toBeNull();
      await expect(access(staleDirectory)).rejects.toThrow();
      await lock?.release();
    } finally {
      if (previousRoot === undefined) delete process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR;
      else process.env.TOOLPLANE_HERMES_ARCHIVE_TMP_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<[string, ZipEntry[]]>([
    ['path traversal', [{ name: '.hermes/config.yaml', content: 'ok' }, { name: '.hermes/../escape.txt', content: 'no' }]],
    ['Windows path traversal', [{ name: '.hermes\\config.yaml', content: 'ok' }, { name: '.hermes\\..\\escape.txt', content: 'no' }]],
    ['special file', [{ name: '.hermes/config.yaml', content: 'ok' }, { name: '.hermes/fifo', content: 'target', mode: 0o010600 }]],
    ['multiple homes', [{ name: 'a/.hermes/config.yaml', content: 'one' }, { name: 'b/.hermes/config.yaml', content: 'two' }]],
  ])('rejects %s', async (_name, entries) => {
    await expect(stageHermesArchive(upload('unsafe.zip', zip(entries)))).rejects.toBeInstanceOf(HermesArchiveError);
  });
});
