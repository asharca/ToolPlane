import { constants } from "node:fs";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

export async function readWorkspaceFile(root, path, destination, signal) {
  const parent = await parentDirectory(root, path);
  let file;
  try {
    file = await open(
      parent.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES)
      throw new Error(
        "Only regular, single-linked workspace files up to 10 MiB can be shared.",
      );
    let bytes = 0;
    await pipeline(
      file.createReadStream({ autoClose: true }),
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > MAX_FILE_BYTES ? new Error("File exceeds 10 MiB.") : null,
            chunk,
          );
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
  expectedHash,
  signal,
) {
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
          if (bytes > MAX_FILE_BYTES) {
            callback(new Error("File exceeds 10 MiB."));
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, path, hash] = process.argv.slice(2);
  try {
    if (action === "read")
      await readWorkspaceFile("/workspace", path, process.stdout);
    else if (action === "write")
      await writeWorkspaceFile("/workspace", path, process.stdin, hash);
    else throw new Error("Invalid file operation.");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
