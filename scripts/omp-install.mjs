import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const installs = new Map();

// Linux abstract sockets are exclusive and disappear when their owner exits.
// Unlike a persisted lock directory they cannot strand installation after a crash.
async function installationLock(path) {
  const { dev, ino } = await stat(dirname(path));
  const address = `\0toolplane-omp-install-${createHash("sha256")
    .update(JSON.stringify([resolve(path), dev, ino]))
    .digest("hex")}`;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      server.once("error", (error) =>
        error.code === "EADDRINUSE" ? resolve(false) : reject(error),
      );
      server.listen(address, () => resolve(true));
    });
    if (acquired)
      return () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    if (Date.now() >= deadline) throw new Error("OMP_INSTALL_TIMEOUT");
    await delay(100);
  }
}

// Release metadata: https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.14.0
export const OMP_VERSION = "18.14.0";
export const OMP_ARTIFACTS = Object.freeze({
  x64: {
    asset: "omp-linux-x64",
    sha256: "e7dd2b606c4ebe9d1a7bcfad1b8820db968cd6b05409fed1c6bc8db0b6a95a8f",
  },
  arm64: {
    asset: "omp-linux-arm64",
    sha256: "dba8d170499709bc87359e02e677821aa76a6ef998ca0254578fe4ea07aff5bc",
  },
});
async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
export function ensureOmpInstalled(path, options = {}) {
  const key = resolve(path);
  const existing = installs.get(key);
  if (existing) return existing;
  const install = installOmp(key, options.workspaceRoot);
  installs.set(key, install);
  const cleanup = () => {
    if (installs.get(key) === install) installs.delete(key);
  };
  void install.then(cleanup, cleanup);
  return install;
}

async function installOmp(path, workspaceRoot) {
  const artifact = OMP_ARTIFACTS[process.arch];
  if (
    process.platform !== "linux" ||
    !artifact ||
    !process.report.getReport().header.glibcVersionRuntime
  )
    throw new Error("OMP_PLATFORM_UNSUPPORTED");
  if (
    await digest(path).then(
      (value) => value === artifact.sha256,
      () => false,
    )
  ) {
    await chmod(path, 0o700);
    return path;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await installationLock(path);
  let temporary;
  try {
    // Another process may have completed the download while this one waited.
    if (
      await digest(path).then(
        (value) => value === artifact.sha256,
        () => false,
      )
    ) {
      await chmod(path, 0o700);
      return path;
    }
    temporary = `${path}.${randomUUID()}.download`;
    if (
      typeof workspaceRoot === "string" &&
      /^\/workspace\/conversations\/(?:conversation|context)-[a-f0-9]{64}$/.test(
        workspaceRoot,
      )
    ) {
      let migration;
      try {
        const marker = `${workspaceRoot}/.toolplane-shared-migration.json`;
        if (
          (await lstat(marker)).isFile() &&
          (await realpath(marker)) === marker
        )
          migration = JSON.parse(await readFile(marker, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        migration?.legacyWorkspaceRoot === "/workspace" &&
        typeof migration.sourceSandboxId === "string"
      ) {
        const source = `${workspaceRoot}/.toolplane/runtime-packages/omp-${OMP_VERSION}/omp`;
        const trusted = await lstat(source).then(
          async (stat) =>
            stat.isFile() &&
            (await realpath(source)) === source &&
            (await digest(source)) === artifact.sha256,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (trusted) {
          await copyFile(source, temporary, constants.COPYFILE_EXCL);
          if ((await digest(temporary)) !== artifact.sha256)
            throw new Error("OMP_ARTIFACT_DIGEST_MISMATCH");
          await chmod(temporary, 0o700);
          await rename(temporary, path);
          return path;
        }
      }
    }
    const response = await fetch(
      `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${artifact.asset}`,
      {
        signal: AbortSignal.timeout(14 * 60_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error("OMP_ARTIFACT_DOWNLOAD_FAILED");
    const file = await open(temporary, "wx", 0o600);
    try {
      let size = 0;
      const bounded = async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > 512 * 1024 * 1024)
            throw new Error("OMP_ARTIFACT_TOO_LARGE");
          yield chunk;
        }
      };
      await pipeline(
        Readable.fromWeb(response.body),
        bounded,
        file.createWriteStream(),
      );
    } finally {
      await file.close();
    }
    if ((await digest(temporary)) !== artifact.sha256)
      throw new Error("OMP_ARTIFACT_DIGEST_MISMATCH");
    await chmod(temporary, 0o700);
    await rename(temporary, path);
    return path;
  } finally {
    try {
      if (temporary) await rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  await ensureOmpInstalled(process.argv[2]);
