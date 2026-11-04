import "server-only";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";

const IMAGE = "toolplane-pi-package-capture:0.87.1";
const VERSION = "0.87.1";
const LIMIT = 1024 * 1024 * 1024 + 32 * 1024 * 1024;
type Artifact = { path: string; sha256: string };
type Identity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
let prepared: Promise<Artifact & { identity: Identity }> | undefined;

function guard() {
  assertRuntimeOwner(true);
  runtimeAbortSignal()?.throwIfAborted();
}
function signal() {
  const owner = runtimeAbortSignal();
  const timeout = AbortSignal.timeout(300_000);
  return owner ? AbortSignal.any([owner, timeout]) : timeout;
}
async function command(args: string[], cleanup = false): Promise<string> {
  if (!cleanup) guard();
  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    signal: cleanup ? AbortSignal.timeout(15_000) : signal(),
  });
  let output = "";
  let errorOutput = "";
  const {
    promise: exited,
    resolve: finished,
    reject: failed,
  } = Promise.withResolvers<void>();
  child.once("error", failed);
  child.once("close", (code) =>
    code === 0
      ? finished()
      : failed(
          new Error(
            `PI_SDK_IMAGE_COMMAND_FAILED: ${errorOutput.slice(0, 4096)}`,
          ),
        ),
  );
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString("utf8");
    if (output.length > 64 * 1024) child.kill("SIGKILL");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    if (errorOutput.length < 4096) errorOutput += bytes.toString("utf8");
  });
  await exited;
  if (!cleanup) guard();
  return output;
}
async function cacheLock(directory: string) {
  const info = await stat(/* turbopackIgnore: true */ dirname(directory));
  const address = `\0toolplane-pi-artifact-${createHash("sha256")
    .update(JSON.stringify([directory, info.dev, info.ino]))
    .digest("hex")}`;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    guard();
    const server = createServer((socket) => socket.destroy());
    const {
      promise,
      resolve: acquired,
      reject,
    } = Promise.withResolvers<boolean>();
    server.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" ? acquired(false) : reject(error),
    );
    server.listen(address, () => acquired(true));
    if (await promise)
      return () => {
        const {
          promise: closed,
          resolve,
          reject: failed,
        } = Promise.withResolvers<void>();
        server.close((error) => (error ? failed(error) : resolve()));
        return closed;
      };
    if (Date.now() >= deadline) throw new Error("PI_SDK_PREPARE_TIMEOUT");
    await delay(100, undefined, { signal: runtimeAbortSignal() });
  }
}
async function identity(path: string): Promise<Identity> {
  const info = await lstat(/* turbopackIgnore: true */ path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size > LIMIT ||
    (await realpath(/* turbopackIgnore: true */ path)) !== path
  )
    throw new Error("PI_SDK_CACHE_SCOPE");
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}
async function readCached(directory: string, imageId: string) {
  const info = await lstat(/* turbopackIgnore: true */ directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!info) return null;
  if (
    !info.isDirectory() ||
    (await realpath(/* turbopackIgnore: true */ directory)) !== directory
  )
    throw new Error("PI_SDK_CACHE_SCOPE");
  const path = join(directory, "sdk.archive");
  const metadataPath = join(directory, "artifact.json");
  const metadataInfo = await identity(metadataPath);
  if (metadataInfo.size > 4096) throw new Error("PI_SDK_CACHE_SCOPE");
  const metadata = JSON.parse(
    await readFile(/* turbopackIgnore: true */ metadataPath, "utf8"),
  );
  if (
    metadata.imageId !== imageId ||
    metadata.version !== VERSION ||
    metadata.node !== 26 ||
    metadata.arch !== process.arch ||
    metadata.platform !== "linux" ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error("PI_SDK_CACHE_METADATA_MISMATCH");
  const before = await identity(path);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(
    /* turbopackIgnore: true */ path,
  )) {
    guard();
    hash.update(bytes);
  }
  if (
    hash.digest("hex") !== metadata.sha256 ||
    JSON.stringify(before) !== JSON.stringify(await identity(path))
  )
    throw new Error("PI_SDK_CACHE_DIGEST_MISMATCH");
  return { path, sha256: metadata.sha256 as string, identity: before };
}
async function prepare() {
  guard();
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("PI_SDK_PLATFORM_MISMATCH");
  // The existing package-capture path also requires this credential-free image
  // to be provisioned. Inspect once, then run the immutable ID, never its tag.
  const image = JSON.parse(
    await command(["image", "inspect", IMAGE, "--format", "{{json .}}"]),
  );
  const arch = process.arch === "x64" ? "amd64" : "arm64";
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
    image.Os !== "linux" ||
    image.Architecture !== arch
  )
    throw new Error("PI_SDK_IMAGE_PLATFORM_MISMATCH");
  const home = await realpath(/* turbopackIgnore: true */ homedir());
  const parent = join(
    /* turbopackIgnore: true */ home,
    ".cache",
    "toolplane",
    "pi-sdk",
    VERSION,
    `linux-${process.arch}-node26`,
  );
  guard();
  await mkdir(/* turbopackIgnore: true */ parent, {
    recursive: true,
    mode: 0o700,
  });
  if ((await realpath(/* turbopackIgnore: true */ parent)) !== parent)
    throw new Error("PI_SDK_CACHE_SCOPE");
  const directory = join(parent, image.Id.slice(7));
  const release = await cacheLock(directory);
  const stage = `${directory}.prepare-${randomUUID()}`;
  const name = `toolplane-pi-sdk-${randomUUID()}`;
  let started = false;
  try {
    const cached = await readCached(directory, image.Id);
    if (cached) {
      guard();
      return cached;
    }
    guard();
    await mkdir(/* turbopackIgnore: true */ stage, { mode: 0o700 });
    // The app and Docker daemon may have different filesystems. Send only this
    // trusted module over stdin instead of asking the daemon to bind an app path.
    const installer = await readFile(
      /* turbopackIgnore: true */ join(
        process.cwd(),
        "scripts",
        "pi-sdk-install.mjs",
      ),
      "utf8",
    );
    const file = await open(
      /* turbopackIgnore: true */ join(stage, "sdk.archive"),
      "wx",
      0o600,
    );
    try {
      guard();
      const child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "--interactive",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--entrypoint",
          "node",
          image.Id,
          "--input-type=module",
          "-",
          image.Id,
        ],
        { stdio: ["pipe", "pipe", "pipe"], signal: signal() },
      );
      started = true;
      let stderr = "";
      child.stderr.on("data", (bytes: Buffer) => {
        if (stderr.length < 4096) stderr += bytes.toString("utf8");
      });
      const {
        promise: exited,
        resolve: finished,
        reject: failed,
      } = Promise.withResolvers<void>();
      child.once("error", failed);
      child.once("close", (code) =>
        code === 0
          ? finished()
          : failed(new Error(`PI_SDK_ARTIFACT_PREPARE_FAILED: ${stderr}`)),
      );
      const hash = createHash("sha256");
      let size = 0;
      async function* bounded(chunks: AsyncIterable<Buffer>) {
        for await (const bytes of chunks) {
          guard();
          size += bytes.length;
          if (size > LIMIT) throw new Error("PI_SDK_ARTIFACT_TOO_LARGE");
          hash.update(bytes);
          yield bytes;
        }
      }
      const transfers = [
        exited,
        // With stdin execution argv[1] is "-", so the module's CLI guard stays
        // inactive and argv[2] is exactly the inspected, immutable image ID.
        pipeline(
          [
            installer,
            '\nawait writePiSdkArchive("/opt/pi-sdk", process.argv[2]);\n',
          ],
          child.stdin,
        ),
        pipeline(
          child.stdout,
          bounded,
          createWriteStream(
            /* turbopackIgnore: true */ join(stage, "sdk.archive"),
            { fd: file.fd, autoClose: false },
          ),
        ),
      ];
      try {
        await Promise.all(transfers);
      } catch (error) {
        child.kill("SIGKILL");
        await Promise.allSettled(transfers);
        throw error;
      }
      guard();
      const sha256 = hash.digest("hex");
      await writeFile(
        /* turbopackIgnore: true */ join(stage, "artifact.json"),
        JSON.stringify({
          imageId: image.Id,
          version: VERSION,
          node: 26,
          platform: "linux",
          arch: process.arch,
          sha256,
        }),
        { flag: "wx", mode: 0o600 },
      );
      guard();
      await rename(
        /* turbopackIgnore: true */ stage,
        /* turbopackIgnore: true */ directory,
      );
      const path = join(directory, "sdk.archive");
      return { path, sha256, identity: await identity(path) };
    } finally {
      await file.close();
    }
  } finally {
    try {
      if (started)
        await command(["rm", "--force", name], true).catch(() => undefined);
      await rm(/* turbopackIgnore: true */ stage, {
        recursive: true,
        force: true,
      });
    } finally {
      await release();
    }
  }
}
/** Shared dependency-only artifact; Agent configuration and credentials never enter this cache. */
export function preparePiRuntime(): Promise<Artifact> {
  return trackRuntimeOperation(async () => {
    guard();
    if (!prepared) {
      const pending = prepare();
      prepared = pending;
      void pending.catch(() => {
        if (prepared === pending) prepared = undefined;
      });
    }
    const result = await prepared;
    guard();
    if (
      JSON.stringify(await identity(result.path)) !==
      JSON.stringify(result.identity)
    )
      throw new Error("PI_SDK_CACHE_DIGEST_MISMATCH");
    guard();
    return { path: result.path, sha256: result.sha256 };
  }, true);
}
