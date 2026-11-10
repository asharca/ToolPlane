import { constants } from "node:fs";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

// Callers supply the per-file byte limit; the helper has no built-in default.
function fileLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid sandbox file size limit.");
  return maxBytes;
}

// EFBIG lets the host report the size limit without parsing stderr.
function exceeds(maxBytes) {
  return Object.assign(
    new Error(
      `File exceeds the ${Number((maxBytes / 1024 ** 2).toFixed(2))} MiB file limit.`,
    ),
    { code: "EFBIG" },
  );
}

// Pin each directory inode, never resolve a model-controlled symlink. Linux's
// /proc/self/fd permits openat-style traversal without a native addon.
async function parentDirectory(root, path, create = false) {
  const absolute = resolve(root, path);
  const parts = relative(resolve(root), absolute).split(sep);
  if (
    !parts.length ||
    parts.some(
      (part) =>
        !part ||
        part === ".." ||
        part === ".toolplane" ||
        /[\0\r\n]/.test(part),
    )
  )
    throw new Error(
      "File must be inside the sandbox workspace, outside runtime state.",
    );
  const handles = [];
  try {
    let directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(directory);
    for (const part of parts.slice(0, -1)) {
      const next = `/proc/self/fd/${directory.fd}/${part}`;
      if (create)
        await mkdir(next, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      directory = await open(
        next,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(directory);
    }
    return {
      path: `/proc/self/fd/${directory.fd}/${parts.at(-1)}`,
      absolute,
      close: () =>
        Promise.all(handles.reverse().map((handle) => handle.close())),
    };
  } catch (error) {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
    throw error;
  }
}

export async function readWorkspaceFile(
  root,
  path,
  destination,
  { maxBytes, signal } = {},
) {
  const limit = fileLimit(maxBytes);
  const parent = await parentDirectory(root, path);
  let file;
  try {
    file = await open(
      parent.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error(
        "Only regular, single-linked workspace files can be shared.",
      );
    if (info.size > limit) throw exceeds(limit);
    let bytes = 0;
    await pipeline(
      file.createReadStream({ autoClose: true }),
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > limit ? exceeds(limit) : null, chunk);
        },
      }),
      destination,
      { signal },
    );
  } finally {
    await file?.close();
    await parent.close();
  }
}

export async function writeWorkspaceFile(
  root,
  path,
  source,
  { maxBytes, expectedHash, signal } = {},
) {
  const limit = fileLimit(maxBytes);
  const parent = await parentDirectory(root, path, true);
  const temporary = `${parent.path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    // The FileHandle remains owned here for fsync/atomic rename. A FileHandle
    // write stream with autoClose:false retains its handle reference after
    // finish, so awaiting file.close() can otherwise stall with no active I/O.
    await pipeline(
      source,
      new Writable({
        write(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limit) {
            callback(exceeds(limit));
            return;
          }
          hash.update(chunk);
          file.writeFile(chunk).then(() => callback(), callback);
        },
      }),
      { signal },
    );
    const sha256 = hash.digest("hex");
    if (expectedHash && sha256 !== expectedHash)
      throw new Error("File checksum changed during transfer.");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, parent.path);
    return {
      path: parent.absolute,
      filename: basename(path),
      size: bytes,
      sha256,
    };
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => undefined);
    await parent.close();
  }
}

/** Exit status 27 (EFBIG) marks a size limit; other failures exit 1. */
export function reportFailure(error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = error?.code === "EFBIG" ? 27 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, path, maxBytes, hash] = process.argv.slice(2);
  try {
    const options = { maxBytes: Number(maxBytes) };
    if (action === "read")
      await readWorkspaceFile("/workspace", path, process.stdout, options);
    else if (action === "write")
      await writeWorkspaceFile("/workspace", path, process.stdin, {
        ...options,
        expectedHash: hash,
      });
    else throw new Error("Invalid file operation.");
  } catch (error) {
    reportFailure(error);
  }
}
