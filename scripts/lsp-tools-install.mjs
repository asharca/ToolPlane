// Trusted independent LSP dependency artifact. No package manager runs in a sandbox.
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const PREFIX = "/workspace/.toolplane-tools/lsp";
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_HEADER = 8 * 1024 * 1024;
const fail = () => { throw new Error("LSP_ARTIFACT_INVALID"); };
const inside = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
async function safeDirectory(path) {
  if (path === "/") return;
  await safeDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) fail();
}
async function inventory(root) {
  const entries = [];
  let total = 0;
  async function visit(path) {
    if (entries.length >= 20000) fail();
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      entries.push({ path, type: "directory" });
      for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`);
    } else if (info.isSymbolicLink()) {
      const actual = await realpath(absolute);
      if (!inside(join(root, "node_modules"), actual)) fail();
      entries.push({ path, type: "symlink", target: relative(dirname(absolute), actual) });
    } else if (info.isFile()) {
      total += info.size;
      if (total > MAX_BYTES) fail();
      entries.push({ path, type: "file", size: info.size });
    } else fail();
  }
  await visit("node_modules");
  return entries;
}
function headerFor(entries) { return Buffer.from(`${JSON.stringify({ format: "toolplane-lsp-1", entries })}\n`); }
function validate(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 20000) fail();
  const seen = new Map();
  let size = 0;
  for (const entry of entries) {
    if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.includes("\0")
      || !entry.path.startsWith("node_modules") || entry.path.split("/").some((s) => !s || s === "." || s === "..")
      || seen.has(entry.path) || (entry.path !== "node_modules" && seen.get(dirname(entry.path)) !== "directory")) fail();
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail();
      size += entry.size;
    } else if (entry.type === "symlink") {
      if (typeof entry.target !== "string" || isAbsolute(entry.target) || entry.target.includes("\0")
        || !inside("/snapshot/node_modules", resolve("/snapshot", dirname(entry.path), entry.target))) fail();
    } else if (entry.type !== "directory") fail();
    seen.set(entry.path, entry.type);
  }
  if (entries[0].path !== "node_modules" || entries[0].type !== "directory" || size > MAX_BYTES) fail();
  return size;
}
export async function exportLspArtifact(destination = process.stdout) {
  const root = "/opt/toolplane-lsp";
  if (await realpath(root) !== root) fail();
  for (const [name, version] of Object.entries({ "typescript-language-server": "5.0.1", typescript: "5.9.3", pyright: "1.1.407" })) {
    if (JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version !== version) fail();
  }
  const entries = await inventory(root);
  validate(entries);
  const header = headerFor(entries);
  if (header.length > MAX_HEADER) fail();
  async function* bytes() {
    yield header;
    for (const entry of entries) if (entry.type === "file") yield* createReadStream(join(root, entry.path));
  }
  await pipeline(bytes(), destination);
}
async function verify(directory, sha256) {
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) fail();
  const metadata = join(directory, ".artifact.json");
  const info = await lstat(metadata);
  if (!info.isFile() || info.size > MAX_HEADER || info.nlink !== 1) fail();
  const header = await readFile(metadata);
  const manifest = JSON.parse(header);
  if (manifest.format !== "toolplane-lsp-1") fail();
  validate(manifest.entries);
  if (JSON.stringify(await inventory(directory)) !== JSON.stringify(manifest.entries)) fail();
  const hash = createHash("sha256").update(header);
  for (const entry of manifest.entries) if (entry.type === "file") {
    const path = join(directory, entry.path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size) fail();
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    } finally { await file.close(); }
  }
  if (hash.digest("hex") !== sha256) fail();
}
export async function verifyLspArtifact(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail();
  const directory = `${PREFIX}/${sha256}`;
  try { await lstat(directory); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  await verify(directory, sha256);
  return true;
}
export async function installLspArtifact(sha256, source = process.stdin) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail();
  await safeDirectory(PREFIX);
  const directory = `${PREFIX}/${sha256}`;
  const stage = `${PREFIX}/.install-${randomUUID()}`;
  const archive = `${stage}/archive`;
  await mkdir(stage, { mode: 0o700 });
  try {
    // Always drain and authenticate transport, even if another session installed it.
    let size = 0;
    const hash = createHash("sha256");
    async function* bounded() {
      for await (const bytes of source) {
        size += bytes.length;
        if (size > MAX_BYTES + MAX_HEADER) fail();
        hash.update(bytes); yield bytes;
      }
    }
    await pipeline(bounded(), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== sha256) fail();
    const file = await open(archive, "r");
    try {
      const headerBytes = Buffer.alloc(Math.min(size, MAX_HEADER));
      let readBytes = 0;
      let end = -1;
      while (readBytes < headerBytes.length && end < 0) {
        const { bytesRead } = await file.read(headerBytes, readBytes, Math.min(64 * 1024, headerBytes.length - readBytes), readBytes);
        if (!bytesRead) break;
        readBytes += bytesRead;
        end = headerBytes.subarray(0, readBytes).indexOf(10);
      }
      if (end < 0) fail();
      const header = headerBytes.subarray(0, end + 1);
      const manifest = JSON.parse(header);
      if (manifest.format !== "toolplane-lsp-1" || validate(manifest.entries) + header.length !== size) fail();
      const root = `${stage}/snapshot`;
      await mkdir(root);
      let position = header.length;
      for (const entry of manifest.entries) {
        const path = join(root, entry.path);
        if (entry.type === "directory") await mkdir(path);
        else if (entry.type === "symlink") await symlink(entry.target, path);
        else {
          if (entry.size) await pipeline(createReadStream(archive, { start: position, end: position + entry.size - 1 }), createWriteStream(path, { flags: "wx", mode: 0o600 }));
          else await writeFile(path, "", { flag: "wx", mode: 0o600 });
          position += entry.size;
        }
      }
      await writeFile(join(root, ".artifact.json"), header, { flag: "wx", mode: 0o600 });
      await verify(root, sha256);
      try { await rename(root, directory); } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        await verify(directory, sha256);
      }
      return directory;
    } finally { await file.close(); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}
