import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HermesArchiveError,
  stageHermesArchive,
  type HermesArchiveUpload,
} from '@/lib/agents/hermes/archive';

type ZipEntry = {
  name: string;
  content?: string;
  mode?: number;
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
    const directory = entry.name.endsWith('/');
    const mode = entry.mode ?? (directory ? 0o40755 : 0o100600);
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
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
    arrayBuffer: async () => content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer,
  };
}

describe('Hermes archive staging', () => {
  it('enforces a configured upload limit before reading the file body', async () => {
    const arrayBuffer = vi.fn();
    await expect(stageHermesArchive({
      name: 'too-large.zip',
      size: 2 * 1024 * 1024,
      arrayBuffer,
    }, { maxUploadMiB: 1 })).rejects.toBeInstanceOf(HermesArchiveError);

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rechecks the actual file body against the configured upload limit', async () => {
    const body = new Uint8Array(1024 * 1024 + 1).buffer;
    await expect(stageHermesArchive({
      name: 'mismatched-size.zip',
      size: 1,
      arrayBuffer: async () => body,
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

  it('counts metadata entries toward the archive entry limit', async () => {
    const metadata = Array.from({ length: 2_000 }, (_value, index) => ({
      name: `__MACOSX/._${index}`,
    }));
    await expect(stageHermesArchive(upload('metadata-bomb.zip', zip([
      { name: '.hermes/config.yaml', content: 'model: imported' },
      ...metadata,
    ])))).rejects.toBeInstanceOf(HermesArchiveError);
  });

  it.each<[string, ZipEntry[]]>([
    ['path traversal', [{ name: '.hermes/config.yaml', content: 'ok' }, { name: '.hermes/../escape.txt', content: 'no' }]],
    ['Windows path traversal', [{ name: '.hermes\\config.yaml', content: 'ok' }, { name: '.hermes\\..\\escape.txt', content: 'no' }]],
    ['symbolic link', [{ name: '.hermes/config.yaml', content: 'ok' }, { name: '.hermes/link', content: 'target', mode: 0o120777 }]],
    ['multiple homes', [{ name: 'a/.hermes/config.yaml', content: 'one' }, { name: 'b/.hermes/config.yaml', content: 'two' }]],
  ])('rejects %s', async (_name, entries) => {
    await expect(stageHermesArchive(upload('unsafe.zip', zip(entries)))).rejects.toBeInstanceOf(HermesArchiveError);
  });
});
