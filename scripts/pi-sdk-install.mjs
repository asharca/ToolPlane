import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fchmodSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findPackageJSON } from "node:module";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const PI_SDK_VERSION = "1.5.2";
const DIRECTORY = `/workspace/.toolplane/runtime-packages/pi-sdk-${PI_SDK_VERSION}`;
const MARKER = ".toolplane-pi-sdk.json";
const MAGIC = "TOOLPLANE_PI_SDK_1\n";
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST = 32 * 1024 * 1024;
const packages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
const scope = () => new Error("PI_SDK_INSTALL_SCOPE");
function platform() {
  if (
    Number(process.versions.node.split(".")[0]) !== 26 ||
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("PI_SDK_PLATFORM_MISMATCH");
}
async function exists(path) {
  return lstat(/* turbopackIgnore: true */ path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function runtimeDirectory(directory, create = false) {
  if (directory !== DIRECTORY) throw scope();
  for (const path of [
    "/workspace",
    "/workspace/.toolplane",
    dirname(directory),
  ]) {
    if (create && path !== "/workspace")
      await mkdir(/* turbopackIgnore: true */ path, { mode: 0o700 }).catch(
        (error) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    const info = await exists(path);
    if (!info) return false;
    if (
      !info.isDirectory() ||
      (await realpath(/* turbopackIgnore: true */ path)) !== path
    )
      throw scope();
  }
  return true;
}
async function lock(directory, signal) {
  const { dev, ino } = await stat(
    /* turbopackIgnore: true */ dirname(directory),
  );
  const address = `\0toolplane-pi-install-${createHash("sha256")
    .update(JSON.stringify([directory, dev, ino]))
    .digest("hex")}`;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    signal?.throwIfAborted();
    const server = createServer((socket) => socket.destroy());
    const { promise, resolve: acquired, reject } = Promise.withResolvers();
    server.once("error", (error) =>
      error.code === "EADDRINUSE" ? acquired(false) : reject(error),
    );
    server.listen(address, () => acquired(true));
    if (await promise)
      return () => {
        const {
          promise: closed,
          resolve,
          reject: failed,
        } = Promise.withResolvers();
        server.close((error) => (error ? failed(error) : resolve()));
        return closed;
      };
    if (Date.now() >= deadline) throw new Error("PI_SDK_INSTALL_TIMEOUT");
    await delay(100, undefined, { signal });
  }
}
// This module runs in a dedicated installer/capture process. Reuse one bounded
// buffer instead of creating thousands of streams for the small SDK files.
const fileBuffer = Buffer.allocUnsafe(256 * 1024);
function digest(path, archiveHash) {
  const hash = createHash("sha256");
  const fd = openSync(/* turbopackIgnore: true */ path, "r");
  try {
    for (;;) {
      const size = readSync(fd, fileBuffer, 0, fileBuffer.length, null);
      if (!size) break;
      const bytes = fileBuffer.subarray(0, size);
      hash.update(bytes);
      archiveHash?.update(bytes);
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function validateManifest(manifest) {
  if (
    manifest.schema !== 1 ||
    manifest.version !== PI_SDK_VERSION ||
    manifest.node !== 26 ||
    manifest.platform !== "linux" ||
    manifest.arch !== process.arch ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)
  )
    throw new Error("PI_SDK_ARTIFACT_METADATA_MISMATCH");
  if (
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length ||
    manifest.entries.length > 100_000
  )
    throw scope();
  const types = new Map();
  let total = 0;
  for (const entry of manifest.entries) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length > 4096 ||
      /[\\\p{Cc}]/u.test(entry.path) ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      (entry.path !== "node_modules" &&
        !entry.path.startsWith("node_modules/")) ||
      types.has(entry.path)
    )
      throw scope();
    if (
      entry.path !== "node_modules" &&
      types.get(dirname(entry.path)) !== "directory"
    )
      throw scope();
    if (!["directory", "file", "symlink"].includes(entry.type)) throw scope();
    if (entry.type === "file") {
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        throw scope();
      total += entry.size;
      if (total > MAX_BYTES) throw new Error("PI_SDK_ARTIFACT_TOO_LARGE");
    }
    if (entry.type === "symlink") {
      if (
        typeof entry.target !== "string" ||
        !entry.target ||
        isAbsolute(entry.target) ||
        /[\\\p{Cc}]/u.test(entry.target) ||
        !within(
          "/sdk/node_modules",
          resolve("/sdk", dirname(entry.path), entry.target),
        )
      )
        throw scope();
    }
    types.set(entry.path, entry.type);
  }
  if (types.get("node_modules") !== "directory") throw scope();
}
async function packageVersions(root) {
  const sdkPackage = join(root, "node_modules", packages[0], "package.json");
  const sdkEntry = join(
    dirname(await realpath(/* turbopackIgnore: true */ sdkPackage)),
    "dist/index.js",
  );
  for (const name of packages) {
    const path =
      name === packages[0]
        ? sdkPackage
        : findPackageJSON(name, pathToFileURL(sdkEntry));
    if (
      !path ||
      !within(
        join(root, "node_modules"),
        await realpath(/* turbopackIgnore: true */ path),
      )
    )
      throw scope();
    if (
      JSON.parse(await readFile(/* turbopackIgnore: true */ path, "utf8"))
        .version !== PI_SDK_VERSION
    )
      throw new Error("PI_SDK_VERSION_MISMATCH");
  }
  if (
    !within(
      join(root, "node_modules"),
      await realpath(
        /* turbopackIgnore: true */ join(root, "node_modules/.bin/pi"),
      ),
    )
  )
    throw scope();
  await access(
    /* turbopackIgnore: true */ join(root, "node_modules/.bin/pi"),
    constants.X_OK,
  );
}
async function entriesFor(root, normalizeLinks = false, archiveHash) {
  const entries = [];
  async function visit(path) {
    if (entries.length >= 100_000) throw scope();
    const absolute = join(root, path);
    const info = await lstat(/* turbopackIgnore: true */ absolute);
    if (info.isDirectory()) {
      entries.push({ path, type: "directory" });
      for (const name of (
        await readdir(/* turbopackIgnore: true */ absolute)
      ).sort())
        await visit(`${path}/${name}`);
    } else if (info.isSymbolicLink()) {
      let target = await readlink(/* turbopackIgnore: true */ absolute);
      if (
        !within(
          join(root, "node_modules"),
          await realpath(/* turbopackIgnore: true */ absolute),
        )
      )
        throw scope();
      if (isAbsolute(target)) {
        if (!normalizeLinks || !within(join(root, "node_modules"), target))
          throw scope();
        target = relative(dirname(absolute), target);
      }
      entries.push({ path, type: "symlink", target });
    } else if (info.isFile() && (normalizeLinks || info.nlink === 1)) {
      entries.push({
        path,
        type: "file",
        mode: info.mode & 0o777,
        size: info.size,
        sha256: digest(absolute, archiveHash),
      });
    } else throw scope();
  }
  await visit("node_modules");
  return entries;
}
function archiveHeader(manifest) {
  const header = Buffer.from(`${MAGIC}${JSON.stringify(manifest)}\n`);
  if (header.length > MAX_MANIFEST) throw scope();
  return header;
}
/** Used only in the pinned, credential-free image; emits SDK dependencies and metadata. */
export async function writePiSdkArchive(
  root,
  imageId,
  destination = process.stdout,
) {
  platform();
  if (
    root !== "/opt/pi-sdk" ||
    (await realpath(/* turbopackIgnore: true */ root)) !== root
  )
    throw scope();
  await packageVersions(root);
  const manifest = {
    schema: 1,
    version: PI_SDK_VERSION,
    node: 26,
    platform: "linux",
    arch: process.arch,
    imageId,
    entries: await entriesFor(root, true),
  };
  validateManifest(manifest);
  async function* bytes() {
    yield archiveHeader(manifest);
    for (const entry of manifest.entries)
      if (entry.type === "file")
        yield* createReadStream(
          /* turbopackIgnore: true */ join(root, entry.path),
        );
  }
  await pipeline(bytes(), destination);
}
async function verifyRoot(directory, expectedSha256) {
  const info = await exists(directory);
  if (!info) return false;
  if (
    !info.isDirectory() ||
    (await realpath(/* turbopackIgnore: true */ directory)) !== directory
  )
    throw scope();
  const marker = join(directory, MARKER);
  const markerInfo = await exists(marker);
  if (!markerInfo) {
    // Old public-package installations remain read-only and usable. They have no
    // release manifest, so verify versions and the entire dependency tree scope.
    await packageVersions(directory);
    await entriesFor(directory, true);
    return true;
  }
  if (
    !markerInfo.isFile() ||
    markerInfo.nlink !== 1 ||
    markerInfo.size > MAX_MANIFEST ||
    (await realpath(/* turbopackIgnore: true */ marker)) !== marker
  )
    throw scope();
  const installed = JSON.parse(
    await readFile(/* turbopackIgnore: true */ marker, "utf8"),
  );
  validateManifest(installed.manifest);
  if (
    !/^[a-f0-9]{64}$/.test(installed.sha256) ||
    (expectedSha256 && installed.sha256 !== expectedSha256)
  )
    throw new Error("PI_SDK_ARTIFACT_DIGEST_MISMATCH");
  const hash = createHash("sha256").update(archiveHeader(installed.manifest));
  const actual = await entriesFor(directory, false, hash);
  if (JSON.stringify(actual) !== JSON.stringify(installed.manifest.entries))
    throw new Error("PI_SDK_INTEGRITY_MISMATCH");
  if (hash.digest("hex") !== installed.sha256)
    throw new Error("PI_SDK_ARTIFACT_DIGEST_MISMATCH");
  await packageVersions(directory);
  return true;
}
/** Constant-size turn check; full dependency integrity is checked during installation. */
export async function verifyPiSdkRuntime(directory) {
  platform();
  if (!(await runtimeDirectory(directory))) return false;
  const info = await exists(directory);
  if (!info) return false;
  if (
    !info.isDirectory() ||
    (await realpath(/* turbopackIgnore: true */ directory)) !== directory
  )
    throw scope();
  // A present but partial SDK must fail, not trigger silent replacement.
  await packageVersions(directory);
  return true;
}
async function readHeader(file) {
  const chunks = [];
  let length = 0;
  let lines = 0;
  let position = 0;
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error("PI_SDK_ARTIFACT_TRUNCATED");
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 10 && ++lines === 2) {
        if (length + i + 1 > MAX_MANIFEST) throw scope();
        chunks.push(buffer.subarray(0, i + 1));
        const header = Buffer.concat(chunks).toString("utf8");
        if (!header.startsWith(MAGIC)) throw scope();
        return {
          manifest: JSON.parse(header.slice(MAGIC.length)),
          position: position + i + 1,
        };
      }
    }
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    length += bytesRead;
    if (length > MAX_MANIFEST) throw scope();
  }
}
/** Receives only a local trusted archive; no package manager or network is used. */
export async function installPiSdkRuntime(
  { directory, sha256 },
  source = process.stdin,
) {
  platform();
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("PI_SDK_ARTIFACT_DIGEST_MISMATCH");
  await runtimeDirectory(directory, true);
  const release = await lock(directory);
  const stage = `${directory}.install-${randomUUID()}`;
  const archive = `${stage}.archive`;
  try {
    if (await verifyRoot(directory, sha256)) return directory;
    const hash = createHash("sha256");
    let size = 0;
    const file = await open(/* turbopackIgnore: true */ archive, "wx+", 0o600);
    try {
      async function* bounded(chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > MAX_BYTES + MAX_MANIFEST)
            throw new Error("PI_SDK_ARTIFACT_TOO_LARGE");
          hash.update(chunk);
          yield chunk;
        }
      }
      await pipeline(
        source,
        bounded,
        createWriteStream(/* turbopackIgnore: true */ archive, {
          fd: file.fd,
          autoClose: false,
        }),
      );
      if (hash.digest("hex") !== sha256)
        throw new Error("PI_SDK_ARTIFACT_DIGEST_MISMATCH");
      const header = await readHeader(file);
      validateManifest(header.manifest);
      let position = header.position;
      await mkdir(/* turbopackIgnore: true */ stage, { mode: 0o700 });
      for (const entry of header.manifest.entries) {
        const path = join(stage, entry.path);
        if (entry.type === "directory")
          await mkdir(/* turbopackIgnore: true */ path, { mode: 0o755 });
        else if (entry.type === "symlink")
          await symlink(entry.target, /* turbopackIgnore: true */ path);
        else {
          const output = openSync(
            /* turbopackIgnore: true */ path,
            "wx",
            0o600,
          );
          try {
            let remaining = entry.size;
            let offset = position;
            while (remaining) {
              const size = readSync(
                file.fd,
                fileBuffer,
                0,
                Math.min(remaining, fileBuffer.length),
                offset,
              );
              if (!size) throw new Error("PI_SDK_ARTIFACT_TRUNCATED");
              let written = 0;
              while (written < size) {
                const count = writeSync(
                  output,
                  fileBuffer,
                  written,
                  size - written,
                );
                if (!count) throw new Error("PI_SDK_INSTALL_INCOMPLETE");
                written += count;
              }
              remaining -= size;
              offset += size;
            }
            fchmodSync(output, entry.mode);
          } finally {
            closeSync(output);
          }
          position += entry.size;
        }
      }
      if (position !== size) throw new Error("PI_SDK_ARTIFACT_SIZE_MISMATCH");
      await writeFile(
        /* turbopackIgnore: true */ join(stage, MARKER),
        JSON.stringify({ sha256, manifest: header.manifest }),
        { flag: "wx", mode: 0o600 },
      );
      await verifyRoot(stage, sha256);
      await runtimeDirectory(directory);
      if (await exists(directory)) throw new Error("PI_SDK_INSTALL_INCOMPLETE");
      await rename(
        /* turbopackIgnore: true */ stage,
        /* turbopackIgnore: true */ directory,
      );
      return directory;
    } finally {
      await file.close();
    }
  } finally {
    try {
      await rm(/* turbopackIgnore: true */ stage, {
        recursive: true,
        force: true,
      });
      await rm(/* turbopackIgnore: true */ archive, { force: true });
    } finally {
      await release();
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "archive")
    await writePiSdkArchive("/opt/pi-sdk", process.argv[3]);
  else await installPiSdkRuntime(JSON.parse(process.argv[2]));
}
