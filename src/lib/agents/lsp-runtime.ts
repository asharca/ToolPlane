import "server-only";
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";

export const LSP_TOOLS_IMAGE =
  process.env.TOOLPLANE_LSP_TOOLS_IMAGE?.trim() ||
  "ghcr.io/asharca/toolplane-lsp-tools:1";
const MAX_BYTES = 264 * 1024 * 1024;
type Artifact = {
  path: string;
  sha256: string;
  directory: string;
  installer: string;
};
let prepared: Promise<Artifact> | undefined;
const execute = promisify(execFile);
const fail = () => new Error("PI_LSP_ARTIFACT_UNAVAILABLE");

async function prepare(): Promise<Artifact> {
  assertRuntimeOwner(true);
  const signal = runtimeAbortSignal();
  const image = JSON.parse(
    (
      await execute(
        "docker",
        ["image", "inspect", LSP_TOOLS_IMAGE, "--format", "{{json .}}"],
        { signal, timeout: 30_000 },
      )
    ).stdout,
  );
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
    image.Os !== "linux" ||
    image.Architecture !==
      (process.arch === "x64"
        ? "amd64"
        : process.arch === "arm64"
          ? "arm64"
          : "unsupported")
  )
    throw fail();
  const installer = await readFile(
    join(process.cwd(), "scripts/lsp-tools-install.mjs"),
    "utf8",
  );
  const parent = join(await realpath(homedir()), ".cache/toolplane/lsp-tools");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent) throw fail();
  const stage = await mkdtemp(join(parent, ".capture-"));
  const name = `toolplane-lsp-export-${randomUUID()}`;
  const path = join(stage, "artifact");
  let child: ChildProcess | undefined;
  try {
    assertRuntimeOwner(true);
    child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
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
      ],
      {
        signal,
        timeout: 180_000,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    if (!child.stdin || !child.stdout) throw fail();
    const {
      promise: exited,
      resolve: finished,
      reject: failed,
    } = Promise.withResolvers<void>();
    child.once("error", failed);
    child.once("close", (code) => (code === 0 ? finished() : failed(fail())));
    let size = 0;
    const hash = createHash("sha256");
    async function* bounded(chunks: AsyncIterable<Buffer>) {
      for await (const bytes of chunks) {
        assertRuntimeOwner(true);
        size += bytes.length;
        if (size > MAX_BYTES) throw fail();
        hash.update(bytes);
        yield bytes;
      }
    }
    const transfers = [
      exited,
      pipeline([installer, "\nawait exportLspArtifact();\n"], child.stdin),
      pipeline(
        child.stdout,
        bounded,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      ),
    ];
    try {
      await Promise.all(transfers);
    } catch (error) {
      child.kill("SIGKILL");
      await Promise.allSettled(transfers);
      throw error;
    }
    assertRuntimeOwner(true);
    const sha256 = hash.digest("hex");
    const destination = join(parent, `${sha256}.archive`);
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (existing) {
      if (
        !existing.isFile() ||
        existing.nlink !== 1 ||
        existing.size !== size ||
        (await realpath(destination)) !== destination
      )
        throw fail();
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(destination))
        digest.update(bytes);
      if (digest.digest("hex") !== sha256) throw fail();
    } else await rename(path, destination);
    return {
      path: destination,
      sha256,
      directory: `/workspace/.toolplane-tools/lsp/${sha256}`,
      installer,
    };
  } catch {
    throw fail();
  } finally {
    child?.kill("SIGKILL");
    await execute("docker", ["rm", "--force", name], { timeout: 30_000 }).catch(
      () => undefined,
    );
    await rm(stage, { recursive: true, force: true });
  }
}

/** Independent trusted image export, prepared only when the revision enables lsp. */
export function prepareLspRuntime(): Promise<Artifact> {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    if (!prepared) {
      const pending = prepare().catch(() => {
        throw fail();
      });
      prepared = pending;
      void pending.catch(() => {
        if (prepared === pending) prepared = undefined;
      });
    }
    const artifact = await prepared;
    assertRuntimeOwner(true);
    const info = await lstat(artifact.path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_BYTES ||
      (await realpath(artifact.path)) !== artifact.path
    )
      throw fail();
    return artifact;
  }, true);
}
