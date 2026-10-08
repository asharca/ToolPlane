import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readSync, opendirSync, readlinkSync, realpathSync, writeFileSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_JSON = 96 * 1024 * 1024;
const fail = () => { throw Object.assign(new Error('PI_PACKAGE_CHECKSUM_MISMATCH'), { code: 'PI_PACKAGE_CHECKSUM_MISMATCH' }); }
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}
function safeAncestors(path) {
  let current = resolve(path);
  for (;;) {
    try { if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function readBounded(path, limit) {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > limit) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail();
    // File size is rechecked after reading; no unbounded read on a growing file.
    const bytes = Buffer.alloc(stat.size + 1);
    return { fd, bytes, size: stat.size };
  } catch (error) { closeSync(fd); throw error; }
}
function bytesAt(path, limit) {
  const { fd, bytes, size } = readBounded(path, limit);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== size) fail();
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
function load(item) {
  if (!/^[a-f0-9]{64}$/.test(item.checksum) || !isAbsolute(item.root) || !isAbsolute(item.manifestPath) || inside(item.root, item.manifestPath)) fail();
  safeAncestors(dirname(item.manifestPath));
  if ((lstatSync(item.manifestPath).mode & 0o7777) !== 0o444) fail();
  const manifest = JSON.parse(bytesAt(item.manifestPath, MAX_JSON).toString('utf8'));
  if (digest(canonicalJson(manifest)) !== item.checksum || manifest.schemaVersion !== 1 || manifest.kind !== 'pi-package') fail();
  const pkg = manifest.package;
  const runtime = pkg?.runtime;
  const portable = pkg.source?.kind === 'toolplane' && runtime?.platform === 'any' && runtime?.arch === 'any';
  if (runtime?.kind !== 'pi-sdk' || runtime.piVersion !== '0.87.1' || runtime.nodeMajor !== 24 || (!portable && (runtime.platform !== process.platform || runtime.arch !== process.arch)) || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('package_platform_mismatch');
  if (pkg.root !== 'package' || !Array.isArray(pkg.entries) || pkg.entries.length > 20000) fail();
  const inventory = new Map([['package', { type: 'directory', path: 'package' }]]);
  const seen = new Set();
  let total = 0;
  for (const entry of pkg.entries) {
    if (typeof entry.path !== 'string' || !/^package(?:\/[^/]+)*$/.test(entry.path) || /[\\\x00-\x1f\x7f]/.test(entry.path) || entry.path.split('/').some((part) => part === '.' || part === '..') || seen.has(entry.path)) fail();
    seen.add(entry.path);
    if (!['file', 'directory', 'symlink'].includes(entry.type)) fail();
    const previous = inventory.get(entry.path);
    if (previous && previous.type !== entry.type) fail();
    inventory.set(entry.path, entry);
    let parent = dirname(entry.path);
    while (parent !== '.') {
      if (inventory.has(parent) && inventory.get(parent).type !== 'directory') fail();
      if (!inventory.has(parent)) inventory.set(parent, { type: 'directory', path: parent });
      parent = dirname(parent);
    }
    if (entry.type === 'file') {
      if (entry.contentEncoding !== 'base64' || typeof entry.content !== 'string' || entry.content.length > Math.ceil(16 * 1024 * 1024 / 3) * 4 || typeof entry.executable !== 'boolean') fail();
      const bytes = Buffer.from(entry.content, 'base64');
      total += bytes.length;
      if (bytes.length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 || bytes.toString('base64') !== entry.content || digest(bytes) !== entry.sha256) fail();
    }
    if (entry.type === 'symlink' && (typeof entry.target !== 'string' || !entry.target || isAbsolute(entry.target) || /[\\\x00-\x1f\x7f]/.test(entry.target) || !inside(join(item.root, 'package'), resolve(item.root, dirname(entry.path), entry.target)))) fail();
  }
  for (const paths of Object.values(pkg.resources ?? {})) {
    if (!Array.isArray(paths)) fail();
    for (const path of paths) if (!inventory.has(path)) fail();
  }
  return { manifest, inventory };
}
export function verifyPiPackageSnapshots(packages) {
  try {
    if (!Array.isArray(packages) || packages.length > 16) fail();
    for (const item of packages) {
      const { inventory } = load(item);
      safeAncestors(item.root);
      const actual = new Set();
      function visit(directory, prefix = '') {
        const handle = opendirSync(directory);
        try {
          let next;
          while ((next = handle.readSync()) !== null) {
            const name = next.name;
            const path = prefix ? prefix + '/' + name : name;
            const entry = inventory.get(path);
            if (!entry) fail();
            actual.add(path);
            const absolute = join(item.root, path);
            const stat = lstatSync(absolute);
            if (entry.type === 'directory') {
              if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o555) fail();
              visit(absolute, path);
            } else if (entry.type === 'file') {
              if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== (entry.executable ? 0o555 : 0o444) || digest(bytesAt(absolute, 16 * 1024 * 1024)) !== entry.sha256) fail();
            } else {
              if (!stat.isSymbolicLink() || readlinkSync(absolute) !== entry.target || !inside(join(item.root, 'package'), realpathSync(absolute))) fail();
            }
          }
        } finally { handle.closeSync(); }
      }
      if ((lstatSync(item.root).mode & 0o7777) !== 0o555) fail();
      visit(item.root);
      if (actual.size !== inventory.size) fail();
    }
  } catch (error) {
    if (error.message === 'package_platform_mismatch') throw error;
    fail();
  }
}
export function materializePiPackageSnapshots(packages) {
  if (!Array.isArray(packages) || packages.length > 16) fail();
  for (const item of packages) {
    safeAncestors(dirname(item.root));
    safeAncestors(dirname(item.manifestPath));
    let exists = false;
    try { lstatSync(item.root); exists = true; } catch (error) { if (error.code !== 'ENOENT') fail(); }
    if (exists) { verifyPiPackageSnapshots([item]); continue; }
    // A surviving metadata file with missing snapshot is tampering, not an install retry.
    try { lstatSync(item.manifestPath); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(dirname(item.manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(item.manifestPath, JSON.stringify(item.manifest), { flag: 'wx', mode: 0o444 });
    chmodSync(item.manifestPath, 0o444);
    const { inventory } = load(item);
    const temp = item.root + '.tmp-' + randomUUID();
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    const entries = [...inventory.values()];
    for (const entry of entries.filter((entry) => entry.type === 'directory').sort((a, b) => a.path.length - b.path.length)) mkdirSync(join(temp, entry.path), { mode: 0o700 });
    for (const entry of entries) {
      const path = join(temp, entry.path);
      if (entry.type === 'file') {
        writeFileSync(path, Buffer.from(entry.content, 'base64'), { flag: 'wx', mode: entry.executable ? 0o555 : 0o444 });
        chmodSync(path, entry.executable ? 0o555 : 0o444);
      } else if (entry.type === 'symlink') symlinkSync(entry.target, path);
    }
    for (const entry of entries.filter((entry) => entry.type === 'directory')) chmodSync(join(temp, entry.path), 0o555);
    chmodSync(temp, 0o555);
    renameSync(temp, item.root);
    verifyPiPackageSnapshots([item]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const chunks = [];
    let received = 0;
    for await (const chunk of process.stdin) {
      received += chunk.length;
      if (received > MAX_JSON * 16) fail();
      chunks.push(chunk);
    }
    const packages = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(packages) || packages.length > 16) fail();
    if (process.argv[2] === 'materialize') materializePiPackageSnapshots(packages);
    else verifyPiPackageSnapshots(packages);
  } catch (error) {
    process.stderr.write(error.message === 'package_platform_mismatch' ? 'package_platform_mismatch\n' : 'PI_PACKAGE_CHECKSUM_MISMATCH\n');
    process.exitCode = 1;
  }
}
