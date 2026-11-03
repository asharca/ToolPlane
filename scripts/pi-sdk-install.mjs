import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const version = "0.87.1";
const packages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
async function verify(root) {
  if (
    Number(process.versions.node.split(".")[0]) !== 26 ||
    process.platform !== "linux"
  )
    throw new Error("package_platform_mismatch");
  if ((await realpath(root)) !== root) throw new Error("PI_SDK_INSTALL_SCOPE");
  for (const name of packages) {
    const path = join(root, "node_modules", name, "package.json");
    if (!within(root, await realpath(path)))
      throw new Error("PI_SDK_INSTALL_SCOPE");
    if (JSON.parse(await readFile(path, "utf8")).version !== version)
      throw new Error("PI_SDK_VERSION_MISMATCH");
  }
  await access(join(root, "node_modules/.bin/pi"), constants.X_OK);
}
async function lock(directory) {
  const { dev, ino } = await stat(dirname(directory));
  const address = `\0toolplane-pi-install-${createHash("sha256")
    .update(JSON.stringify([directory, dev, ino]))
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
    if (Date.now() >= deadline) throw new Error("PI_SDK_INSTALL_TIMEOUT");
    await delay(100);
  }
}
async function links(directory, from, to) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await links(path, from, to);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (from === to) {
        if (!within(from, await realpath(path)))
          throw new Error("PI_SDK_INSTALL_SCOPE");
      } else if (isAbsolute(target)) {
        if (!within(from, target)) throw new Error("PI_SDK_INSTALL_SCOPE");
        await unlink(path);
        await symlink(join(to, relative(from, target)), path);
      }
    } else if (!entry.isFile()) throw new Error("PI_SDK_INSTALL_SCOPE");
  }
}
async function migratedSource(workspaceRoot) {
  if (
    typeof workspaceRoot !== "string" ||
    !/^\/workspace\/conversations\/(?:conversation|context)-[a-f0-9]{64}$/.test(
      workspaceRoot,
    )
  )
    return;
  const marker = join(workspaceRoot, ".toolplane-shared-migration.json");
  try {
    if (!(await lstat(marker)).isFile() || (await realpath(marker)) !== marker)
      return;
    const migration = JSON.parse(await readFile(marker, "utf8"));
    if (
      migration.legacyWorkspaceRoot !== "/workspace" ||
      typeof migration.sourceSandboxId !== "string"
    )
      return;
    const root = join(
      workspaceRoot,
      ".toolplane/runtime-packages",
      `pi-sdk-${version}`,
    );
    await verify(root);
    await links(join(root, "node_modules"), root, root);
    return root;
  } catch (error) {
    // A missing/invalid old installation is never copied; install the exact public packages instead.
    if (
      ["ENOENT", "PI_SDK_INSTALL_SCOPE", "PI_SDK_VERSION_MISMATCH"].includes(
        error.code ?? error.message,
      )
    )
      return;
    throw error;
  }
}
export async function ensurePiSdkInstalled({
  directory,
  workspaceRoot,
  storeDir,
}) {
  directory = resolve(directory);
  if (directory !== `/workspace/.toolplane/runtime-packages/pi-sdk-${version}`)
    throw new Error("PI_SDK_INSTALL_SCOPE");
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const release = await lock(directory);
  const stage = `${directory}.install-${randomUUID()}`;
  try {
    try {
      await verify(directory);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Do not overwrite or delete a partial/tampered installation that is already present.
    try {
      await lstat(directory);
      throw new Error("PI_SDK_INSTALL_INCOMPLETE");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(stage, { mode: 0o700 });
    const source = await migratedSource(workspaceRoot);
    if (source) {
      // Only installed dependencies move into the shared area, never session HOME/config/secrets.
      await cp(join(source, "node_modules"), join(stage, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      await links(join(stage, "node_modules"), source, stage);
    } else {
      const args = [
        "add",
        "--save-prod",
        "--ignore-workspace",
        "--save-exact",
        "--ignore-scripts",
        "--store-dir",
        storeDir,
        ...packages.map((name) => `${name}@${version}`),
      ];
      await new Promise((resolve, reject) => {
        const child = spawn("pnpm", args, {
          cwd: stage,
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            PATH: process.env.PATH,
            HOME: stage,
            LANG: "C.UTF-8",
            CI: "1",
          },
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("PI_SDK_INSTALL_FAILED")),
        );
      });
    }
    await verify(stage);
    await links(join(stage, "node_modules"), stage, stage);
    await links(join(stage, "node_modules"), stage, directory);
    await rename(stage, directory);
    await verify(directory);
  } finally {
    try {
      await rm(stage, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  await ensurePiSdkInstalled(JSON.parse(process.argv[2]));
