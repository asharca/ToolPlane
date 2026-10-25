import { inflateRawSync } from "node:zlib";

export type ZipFile = { path: string; data: Buffer };
export type ZipLimits = {
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxArchiveBytes: number;
};
const invalid = () => new Error("Invalid or unsafe ZIP archive.");

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !path.includes("\\") &&
    !/[\p{Cc}<>:"|?*]/u.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[ .]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
      )
  );
}

export function readZip(archive: Buffer, limits: ZipLimits): ZipFile[] {
  if (archive.length > limits.maxArchiveBytes || archive.length < 22)
    throw invalid();
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65557); end--) {
    if (
      archive.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + archive.readUInt16LE(end + 20) === archive.length
    )
      break;
  }
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) throw invalid();
  const count = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  const start = archive.readUInt32LE(end + 16);
  if (
    archive.readUInt16LE(end + 4) ||
    archive.readUInt16LE(end + 6) ||
    count !== archive.readUInt16LE(end + 8) ||
    !count ||
    count > limits.maxFiles ||
    start + size !== end
  )
    throw invalid();
  const files: ZipFile[] = [];
  const paths = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw invalid();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20);
    const expanded = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const next =
      cursor +
      46 +
      nameLength +
      archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const local = archive.readUInt32LE(cursor + 42);
    if (
      next > end ||
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      archive.readUInt16LE(cursor + 34) ||
      ((mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000))
    )
      throw invalid();
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = name.toString("utf8");
    const directory = path.endsWith("/");
    if (
      ((mode & 0xf000) === 0x4000 && !directory) ||
      ((mode & 0xf000) === 0x8000 && directory)
    )
      throw invalid();
    const normalized = directory ? path.slice(0, -1) : path;
    const key = normalized.normalize("NFC").toLowerCase();
    if (
      !Buffer.from(path).equals(name) ||
      !safePath(normalized) ||
      paths.has(key) ||
      expanded > limits.maxFileBytes ||
      (expanded > 1024 * 1024 && expanded > compressed * 200) ||
      local + 30 > start ||
      archive.readUInt32LE(local) !== 0x04034b50 ||
      archive.readUInt16LE(local + 6) !== flags ||
      archive.readUInt16LE(local + 8) !== method
    )
      throw invalid();
    paths.add(key);
    const localNameLength = archive.readUInt16LE(local + 26);
    const dataStart =
      local + 30 + localNameLength + archive.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressed;
    if (
      dataEnd > start ||
      !archive
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(name) ||
      (!(flags & 8) &&
        (archive.readUInt32LE(local + 14) !== crc ||
          archive.readUInt32LE(local + 18) !== compressed ||
          archive.readUInt32LE(local + 22) !== expanded))
    )
      throw invalid();
    ranges.push([local, dataEnd]);
    total += expanded;
    if (total > limits.maxBytes || (directory && expanded)) throw invalid();
    const payload = archive.subarray(dataStart, dataEnd);
    const data =
      method === 0
        ? Buffer.from(payload)
        : inflateRawSync(payload, { maxOutputLength: Math.max(1, expanded) });
    if (data.length !== expanded || crc32(data) !== crc) throw invalid();
    if (!directory) files.push({ path, data });
    cursor = next;
  }
  if (cursor !== end) throw invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++)
    if (ranges[index][0] < ranges[index - 1][1]) throw invalid();
  const filePaths = new Set(
    files.map((file) => file.path.normalize("NFC").toLowerCase()),
  );
  for (const key of paths) {
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (filePaths.has(parent)) throw invalid();
    }
  }
  return files;
}

export function writeZip(files: ZipFile[]): Buffer {
  if (!files.length || files.length >= 65535) throw invalid();
  const paths = new Set<string>();
  for (const { path } of files) {
    const key = path.normalize("NFC").toLowerCase();
    if (!safePath(path) || paths.has(key)) throw invalid();
    paths.add(key);
  }
  for (const key of paths) {
    const parts = key.split("/");
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join("/"))) throw invalid();
  }
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { path, data } of files) {
    if (!safePath(path)) throw invalid();
    const name = Buffer.from(path);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x314, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(0x81a40000, 38);
    entry.writeUInt32LE(offset, 42);
    chunks.push(header, name, data);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
