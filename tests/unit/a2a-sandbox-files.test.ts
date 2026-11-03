// @vitest-environment node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  MAX_FILE_BYTES,
} from "../../scripts/a2a-sandbox-files.mjs";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "a2a-file-safety-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { root, workspace, outside };
}
function sink() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    output: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}
async function runCli(
  script: string,
  action: string,
  path: string,
  input = Buffer.alloc(0),
  sha256 = "",
) {
  const child = spawn(process.execPath, [script, action, path, sha256], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const {
    promise,
    resolve: complete,
    reject,
  } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("error", reject);
  child.once("close", (code, signal) => complete({ code, signal }));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") reject(error);
  });
  child.stdin.end(input);
  return {
    ...(await promise),
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sandbox file descriptor traversal and bounded atomic writes", () => {
  it("settles real CLI stdin writes and stdout reads with descriptor cleanup", async () => {
    const { root, workspace } = await setup();
    const helper = await readFile(
      resolve("scripts/a2a-sandbox-files.mjs"),
      "utf8",
    );
    const script = join(root, "a2a-sandbox-files.mjs");
    // Exercise the unchanged CLI dispatch in a subprocess without requiring a
    // privileged host /workspace directory; only its fixed sandbox root moves.
    await writeFile(
      script,
      helper.replaceAll('"/workspace"', JSON.stringify(workspace)),
    );
    const bytes = Buffer.alloc(5536);
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = index % 256;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const written = await runCli(
      script,
      "write",
      "received/records.json",
      bytes,
      sha256,
    );
    expect(written).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(written.stdout).toHaveLength(0);
    expect(await readFile(join(workspace, "received", "records.json"))).toEqual(
      bytes,
    );
    const read = await runCli(script, "read", "received/records.json");
    expect(read).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(read.stdout).toEqual(bytes);
    const mismatched = await runCli(
      script,
      "write",
      "received/records.json",
      Buffer.from("wrong"),
      sha256,
    );
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain("checksum");
    expect(await readFile(join(workspace, "received", "records.json"))).toEqual(
      bytes,
    );
    expect(await readdir(join(workspace, "received"))).toEqual([
      "records.json",
    ]);
  }, 20_000);

  it("round-trips full binary bytes and verifies the persisted hash", async () => {
    const { workspace } = await setup();
    const bytes = Buffer.from([0, 255, 127, 1, 2]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(workspace, "received", "file.bin");
    const stored = await writeWorkspaceFile(
      workspace,
      path,
      Readable.from([bytes]),
      sha256,
    );
    expect(stored).toMatchObject({ path, size: bytes.length, sha256 });
    const { chunks, output } = sink();
    await readWorkspaceFile(workspace, path, output);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it.each([
    "../outside/secret",
    "/etc/passwd",
    ".toolplane/token",
    "bad\0name",
  ])("rejects unauthorized path %j", async (path) => {
    const { workspace } = await setup();
    await expect(
      writeWorkspaceFile(workspace, path, Readable.from(["no"])),
    ).rejects.toThrow();
    await expect(
      readWorkspaceFile(workspace, path, sink().output),
    ).rejects.toThrow();
  });

  it("rejects directory/file symlinks and hardlinked publication files", async () => {
    const { workspace, outside } = await setup();
    const secret = join(outside, "secret");
    await writeFile(secret, "private");
    await symlink(outside, join(workspace, "escape"));
    await symlink(secret, join(workspace, "secret-link"));
    await link(secret, join(workspace, "secret-hardlink"));
    for (const path of ["escape/secret", "secret-link", "secret-hardlink"])
      await expect(
        readWorkspaceFile(workspace, path, sink().output),
      ).rejects.toThrow();
    await expect(
      writeWorkspaceFile(workspace, "escape/overwrite", Readable.from(["no"])),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual(["secret"]);
    expect(await readFile(secret, "utf8")).toBe("private");
  });

  it("atomically replaces a final symlink without following it", async () => {
    const { workspace, outside } = await setup();
    const secret = join(outside, "secret");
    await writeFile(secret, "private");
    const path = join(workspace, "destination");
    await symlink(secret, path);
    await writeWorkspaceFile(workspace, path, Readable.from(["public"]));
    expect(await readFile(path, "utf8")).toBe("public");
    expect(await readFile(secret, "utf8")).toBe("private");
  });

  it("does not publish partial, oversized or checksum-mismatched files", async () => {
    const { workspace } = await setup();
    const path = join(workspace, "result");
    await writeFile(path, "previous");
    await expect(
      writeWorkspaceFile(
        workspace,
        path,
        Readable.from(["changed"]),
        "0".repeat(64),
      ),
    ).rejects.toThrow("checksum");
    await expect(
      writeWorkspaceFile(
        workspace,
        path,
        Readable.from([Buffer.alloc(MAX_FILE_BYTES + 1)]),
      ),
    ).rejects.toThrow("10 MiB");
    async function* broken() {
      yield Buffer.from("partial");
      throw new Error("source interrupted");
    }
    await expect(
      writeWorkspaceFile(workspace, path, Readable.from(broken())),
    ).rejects.toThrow("source interrupted");
    expect(await readFile(path, "utf8")).toBe("previous");
    expect(await readdir(workspace)).toEqual(["result"]);
  });
});
