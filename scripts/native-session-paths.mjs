import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";

const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
const fail = () => {
  throw new Error("NATIVE_SESSION_MIGRATION_SCOPE");
};

/** Rebase routing metadata only. The native transcript body remains byte-for-byte intact. */
export async function migrateNativeSessionPaths({
  workspaceRoot,
  sessionsDir,
  statePath,
}) {
  if (!workspaceRoot || workspaceRoot === "/workspace") return;
  let migration;
  try {
    migration = JSON.parse(
      await readFile(
        join(workspaceRoot, ".toolplane-shared-migration.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  // Fresh/pinned-snapshot workspaces have this marker but no legacy session.
  if (migration.legacyWorkspaceRoot == null) return;
  if (
    migration.legacyWorkspaceRoot !== "/workspace" ||
    !within(workspaceRoot, sessionsDir) ||
    !within(workspaceRoot, statePath)
  )
    fail();
  const marker = join(sessionsDir, ".toolplane-paths-v1.json");
  try {
    if (
      JSON.parse(await readFile(marker, "utf8")).workspaceRoot !== workspaceRoot
    )
      fail();
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rebase = (path) => {
    if (typeof path !== "string") fail();
    if (path === workspaceRoot || path.startsWith(`${workspaceRoot}/`))
      return path;
    if (path === "/workspace") return workspaceRoot;
    if (
      !path.startsWith("/workspace/") ||
      path.startsWith("/workspace/conversations/")
    )
      fail();
    const result = join(workspaceRoot, path.slice("/workspace/".length));
    if (!within(workspaceRoot, result)) fail();
    return result;
  };
  const atomicJson = async (path, value) => {
    const temporary = `${path}.${randomUUID()}.rebase`;
    try {
      await writeFile(temporary, JSON.stringify(value), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const handle = await open(path, "r");
      const buffer = Buffer.alloc(64 * 1024);
      let header,
        end,
        start = 0;
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const prefix = buffer.subarray(0, bytesRead);
        end = prefix.indexOf(10);
        if (end < 0) fail();
        header = JSON.parse(prefix.subarray(0, end).toString("utf8"));
        // OMP places its fixed-width title record before the native session header.
        if (header.type === "title") {
          start = end + 1;
          end = prefix.indexOf(10, start);
          if (end < 0) fail();
          header = JSON.parse(prefix.subarray(start, end).toString("utf8"));
        }
      } finally {
        await handle.close();
      }
      if (header.type !== "session") fail();
      const cwd = rebase(header.cwd);
      const parentSession = header.parentSession
        ? rebase(header.parentSession)
        : undefined;
      if (cwd === header.cwd && parentSession === header.parentSession)
        continue;
      const temporary = `${path}.${randomUUID()}.rebase`;
      try {
        const routing = Buffer.from(
          `${JSON.stringify({ ...header, cwd, ...(parentSession ? { parentSession } : {}) })}\n`,
        );
        await writeFile(
          temporary,
          Buffer.concat([buffer.subarray(0, start), routing]),
          { flag: "wx", mode: 0o600 },
        );
        await pipeline(
          createReadStream(path, { start: end + 1 }),
          createWriteStream(temporary, { flags: "a" }),
        );
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  if ((await lstat(sessionsDir)).isSymbolicLink()) fail();
  await visit(sessionsDir);
  try {
    if ((await lstat(statePath)).isSymbolicLink()) fail();
    const state = JSON.parse(await readFile(statePath, "utf8"));
    let changed = false;
    if (typeof state.sessionFile === "string") {
      const path = rebase(state.sessionFile);
      if (!within(sessionsDir, path)) fail();
      changed ||= state.sessionFile !== path;
      state.sessionFile = path;
    }
    if (typeof state.cwd === "string") {
      const cwd = rebase(state.cwd);
      changed ||= state.cwd !== cwd;
      state.cwd = cwd;
    }
    if (changed) await atomicJson(statePath, state);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicJson(marker, { workspaceRoot });
}
