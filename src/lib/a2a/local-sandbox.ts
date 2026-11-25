import "server-only";
import type { A2ATask } from "@prisma/client";
import { Task, Role, TaskState } from "@a2a-js/sdk";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { sandboxContainerName } from "@/lib/sandboxes/runtime";
import { agentSessionWorkingDirectory } from "@/lib/agents/session-paths";
import { resolveAgentEnvironmentCredentials } from "@/lib/agents/environment-credentials";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import {
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import {
  copyTaskFile,
  listTaskFiles,
  openTaskFile,
  storeTaskFile,
} from "./files";
import { taskFileLimitError } from "./file-limits";
import { db } from "@/lib/db";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import {
  type AgentConversationSandbox,
  ensureAgentConversationSandbox,
  findAgentConversationSandbox,
} from "@/lib/agents/conversation-sandbox";
import { assertLiveGrant, isLocalGrant, type TaskGrant } from "./principal";
import { settled } from "./model";
import { attachmentHardLimit } from "@/lib/agents/attachment-limits";
export class SandboxFileStagingError extends Error {
  readonly code = "A2A_SANDBOX_FILE_STAGING_FAILED";
  constructor(cause: unknown) {
    super(
      "Task files could not be delivered to the authorized sandbox; retry file delivery explicitly before execution.",
      { cause },
    );
  }
}

type LocalTaskSandboxMapping = AgentConversationSandbox & {
  a2aContextId: string;
};

/** Entry IDs come from the signed, revalidated ingress grant, never runtime input. */
export async function localTaskSandbox(
  row: A2ATask,
  mode: "admit" | "cleanup" | "access",
  signal?: AbortSignal,
): Promise<LocalTaskSandboxMapping> {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant)) throw new Error("PI_TARGET_UNAVAILABLE");
  if (mode === "cleanup") {
    assertRuntimeOwner();
    if (row.executionBackend !== "pi-harness" || !row.nativeOperationId)
      throw new Error("Native cleanup requires a bound operation.");
  } else await assertLiveGrant(grant, "send");
  if (mode === "admit" && row.executionBackend === "pi-sdk") {
    const { config } = await requireAgentRevision(
      db,
      grant.agentId,
      grant.agentRevisionId,
    );
    if (config.packages.length) {
      const releases = await db.marketRelease.findMany({
        where: {
          reviewStatus: "approved",
          OR: config.packages.map((pin) => ({
            id: pin.releaseId,
            checksum: pin.integrity,
            listing: {
              kind: "pi-package",
              status: { in: ["published", "removed"] },
              installs: {
                some: {
                  id: pin.marketInstallId,
                  targetWorkspaceId: grant.workspaceId,
                  status: { in: ["ready", "uninstalled"] },
                },
              },
            },
          })),
        },
        select: { manifest: true, checksum: true },
      });
      if (releases.length !== config.packages.length)
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      for (const release of releases) {
        try {
          parsePiPackageReleaseManifest(release.manifest, release.checksum);
        } catch {
          throw new Error("PI_PACKAGE_UNAVAILABLE");
        }
      }
    }
  }
  let conversationId: string | undefined;
  if (!grant.ancestorTaskIds.length && grant.entryPolicy) {
    if (grant.entryPolicy.kind === "work") {
      const work = await db.workSession.findFirst({
        where: {
          id: grant.entryPolicy.sourceId,
          workspaceId: grant.workspaceId,
          agentId: grant.agentId,
        },
        select: { conversationId: true },
      });
      if (!work) throw new Error("PI_TARGET_UNAVAILABLE");
      conversationId = work.conversationId;
    } else
      conversationId =
        grant.entryPolicy.conversationId ?? grant.entryPolicy.sourceId;
  }
  const identity = {
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    conversationId,
    contextId: row.contextId,
  };
  const mapping =
    mode === "cleanup"
      ? await findAgentConversationSandbox({ ...identity, cleanup: true })
      : await ensureAgentConversationSandbox({ ...identity, signal });
  if (!mapping) throw new Error("PI_TARGET_UNAVAILABLE");
  if (conversationId && grant.entryPolicy?.kind === "work")
    await db.workSession.updateMany({
      where: {
        id: grant.entryPolicy.sourceId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        conversationId,
      },
      data: { sandboxId: mapping.sandboxId },
    });
  return {
    ...mapping,
    conversationId: mapping.conversationId ?? conversationId,
    a2aContextId: row.contextId,
  };
}

export type LocalTaskSandboxLease = {
  taskId: string;
  leaseToken: string;
  mapping: LocalTaskSandboxMapping;
};

export async function claimedTaskSandbox(
  row: A2ATask,
  signal: AbortSignal,
  lease?: LocalTaskSandboxLease,
) {
  signal.throwIfAborted();
  if (!lease) return localTaskSandbox(row, "access", signal);
  assertRuntimeOwner();
  const grant = row.grant as unknown as TaskGrant;
  const { mapping } = lease;
  if (
    !isLocalGrant(grant) ||
    lease.taskId !== row.id ||
    lease.leaseToken !== row.leaseToken ||
    mapping.a2aContextId !== row.contextId
  )
    throw new Error("PI_TASK_AUTH_REVOKED");
  await assertLiveGrant(grant, "send");
  // Reuse allocation only while this claim owns the same live session binding.
  const bound = await db.a2ATask.findFirst({
    where: {
      id: row.id,
      leaseToken: lease.leaseToken,
      state: TaskState.TASK_STATE_WORKING,
      executionBackend: "pi-sdk",
      phase: "executing",
      cancelRequestedAt: null,
      deadlineAt: { gt: new Date() },
      context: {
        id: row.contextId,
        workspaceId: grant.workspaceId,
        agentId: grant.agentId,
        sandboxId: mapping.sandboxId,
        agentRevisionId: grant.agentRevisionId,
      },
    },
    select: { id: true },
  });
  if (!bound) throw new Error("PI_TASK_AUTH_REVOKED");
  await resolveAgentEnvironmentCredentials({
    workspaceId: grant.workspaceId,
    agentId: grant.agentId,
    agentRevisionId: grant.agentRevisionId,
    contextId: row.contextId,
    conversationId: mapping.conversationId,
  });
  signal.throwIfAborted();
  return mapping;
}

export function sandboxFilePath(path: string): string {
  if (!path || path.length > 1024 || /[\0\r\n]/.test(path))
    throw new Error("Invalid sandbox file path.");
  const absolute = posix.resolve("/workspace", path);
  if (
    !absolute.startsWith("/workspace/") ||
    absolute.split("/").includes(".toolplane")
  )
    throw new Error(
      "File must be inside the sandbox workspace, outside runtime state.",
    );
  return absolute;
}

type SandboxListOptions = { maxEntries: number; newerThanMs: number };
type SandboxFileList = {
  files: { path: string; size: number; mtimeMs: number }[];
  truncated: boolean;
};
type FileOperation =
  | { action: "read"; maxBytes: number }
  | { action: "write"; maxBytes: number; expectedHash?: string }
  | ({ action: "list" } & SandboxListOptions);

async function fileProcess(
  row: A2ATask,
  operation: FileOperation,
  path: string,
  signal?: AbortSignal,
) {
  const mapping = await localTaskSandbox(row, "access", signal);
  const owner = runtimeAbortSignal();
  const combined = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...[signal, owner].filter((value): value is AbortSignal => !!value),
  ]);
  combined.throwIfAborted();
  const source = await readFile(
    `${process.cwd()}/scripts/a2a-sandbox-files.mjs`,
    "utf8",
  );
  const root = JSON.stringify(mapping.workspaceRoot);
  const { action, ...options } = operation;
  const helper = {
    read: "readWorkspaceFile",
    write: "writeWorkspaceFile",
    list: "listWorkspaceFiles",
  }[action];
  const stream = action === "write" ? "stdin" : "stdout";
  const command = `\nawait ${helper}(${root}, process.argv[1], process.${stream}, ${JSON.stringify(options)}).catch(reportFailure);`;
  const child = spawn(
    "docker",
    [
      "exec",
      ...(action === "write" ? ["-i"] : []),
      sandboxContainerName(mapping.sandboxId),
      "node",
      "--input-type=module",
      "-e",
      source + command,
      sandboxFilePath(
        mapping.workspaceRoot === "/workspace"
          ? path
          : agentSessionWorkingDirectory(mapping, path),
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe"], signal: combined },
  );
  let detail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (detail.length < 2048)
      detail += chunk.toString("utf8", 0, 2048 - detail.length);
  });
  const { promise: done, resolve, reject } = Promise.withResolvers<void>();
  child.once("error", reject);
  child.once("close", (code) =>
    code === 0
      ? resolve()
      : reject(
          code === 27 && operation.action === "read"
            ? taskFileLimitError("FILE_TOO_LARGE", operation.maxBytes)
            : new Error(detail.trim() || "Sandbox file transfer failed."),
        ),
  );
  // A producer can fail before a consumer attaches; retain the original rejection.
  void done.catch(() => undefined);
  return { child, done };
}

function validListedPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    /[\\\p{Cc}\p{Cs}]/u.test(path) ||
    /^[a-z]:/i.test(path) ||
    path !== path.trimEnd()
  )
    return false;
  const parts = path.split("/");
  return (
    parts.length <= 4 &&
    parts.every(
      (part) =>
        !!part && !part.startsWith(".") && Buffer.byteLength(part) <= 255,
    )
  );
}

// Treat sandbox stdout as untrusted. Never normalize a reported path into a
// different lookup, or forward unchecked fields to artifact publication.
function parseSandboxFileList(
  text: string,
  { maxEntries, newerThanMs }: SandboxListOptions,
): SandboxFileList {
  const result = JSON.parse(text);
  if (
    !Array.isArray(result?.files) ||
    typeof result.truncated !== "boolean" ||
    result.files.length > maxEntries ||
    (result.truncated && result.files.length !== maxEntries)
  )
    throw new Error("Invalid sandbox file listing.");

  const files: SandboxFileList["files"] = [];
  const paths = new Set<string>();
  for (const entry of result.files) {
    const { path, size, mtimeMs } = entry ?? {};
    const previous = files.at(-1);
    if (
      !validListedPath(path) ||
      paths.has(path) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !Number.isFinite(mtimeMs) ||
      mtimeMs < newerThanMs ||
      (previous &&
        (previous.mtimeMs > mtimeMs ||
          (previous.mtimeMs === mtimeMs && previous.path >= path)))
    )
      throw new Error("Invalid sandbox file listing entry.");
    paths.add(path);
    files.push({ path, size, mtimeMs });
  }
  return { files, truncated: result.truncated };
}

export async function listSandboxFiles(
  row: A2ATask,
  path: string,
  { maxEntries, newerThanMs }: SandboxListOptions,
  signal?: AbortSignal,
): Promise<SandboxFileList> {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    !Number.isFinite(newerThanMs)
  )
    throw new Error("Invalid sandbox file listing limits.");
  return trackRuntimeOperation(async () => {
    const options = { maxEntries, newerThanMs };
    const transfer = await fileProcess(
      row,
      { action: "list", ...options },
      path,
      signal,
    );
    transfer.child.stdin.end();
    // Each path has at most four 255-byte names, doubled at worst by JSON
    // quote escaping. Allow the separators, numeric metadata and envelope.
    const maxBytes = 64 + maxEntries * (2 * 1024 + 128);
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of transfer.child.stdout) {
        bytes += chunk.length;
        if (bytes > maxBytes)
          throw new Error("Sandbox file listing exceeds its size limit.");
        chunks.push(chunk as Buffer);
      }
      await transfer.done;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      );
      return parseSandboxFileList(text, options);
    } finally {
      if (transfer.child.exitCode === null) transfer.child.kill("SIGKILL");
      await transfer.done.catch(() => undefined);
    }
  });
}

/** Input task has already passed grant/lease validation; paths never address the host. */
export async function storeSandboxTaskFile(
  row: A2ATask,
  sourceKey: string,
  path: string,
  filename?: string,
  mimeType = "application/octet-stream",
  signal?: AbortSignal,
) {
  return trackRuntimeOperation(async () => {
    const transfer = await fileProcess(
      row,
      { action: "read", maxBytes: attachmentHardLimit() },
      path,
      signal,
    );
    transfer.child.stdin.end();
    async function* bytes() {
      for await (const chunk of transfer.child.stdout) yield chunk as Buffer;
      await transfer.done;
    }
    try {
      return await storeTaskFile(
        row.id,
        sourceKey,
        filename ?? posix.basename(sandboxFilePath(path)),
        mimeType,
        bytes(),
        signal,
      );
    } finally {
      if (transfer.child.exitCode === null) transfer.child.kill("SIGKILL");
      await transfer.done.catch(() => undefined);
    }
  });
}
/** Legacy joined turns also receive parent-owned files, never child sandbox paths. */
export async function receiveSettledChildFiles(row: A2ATask) {
  const children = await db.a2ATask.findMany({
    where: { parentTaskId: row.id, rootTaskId: row.rootTaskId },
  });
  for (const child of children) {
    if (!settled(child.state)) continue;
    const task = Task.fromJSON(child.snapshot);
    const received = new Set<string>();
    const outputParts = [
      ...task.artifacts.map((artifact) => artifact.parts),
      ...task.history
        .filter((message) => message.role === Role.ROLE_AGENT)
        .map((message) => message.parts),
      ...(task.status?.message ? [task.status.message.parts] : []),
    ];
    for (const parts of outputParts) {
      for (const part of parts) {
        const fileId = part.metadata?.toolplaneFileId;
        if (typeof fileId === "string" && !received.has(fileId)) {
          await copyTaskFile(
            child.id,
            fileId,
            row.id,
            `child:${child.id}:${fileId}`,
          );
          received.add(fileId);
        }
      }
    }
  }
}

export type StagedTaskFile = {
  fileId: string;
  path: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
};

/** Stage only persisted, owned handles. No URL, signed ticket or file bytes enter model text. */
export async function stageLocalTaskFiles(
  row: A2ATask,
  signal?: AbortSignal,
): Promise<StagedTaskFile[]> {
  const files = await listTaskFiles(row.id);
  const staged: StagedTaskFile[] = [];
  if (!files.length) return staged;
  const mapping = await localTaskSandbox(row, "access", signal);
  for (const file of files) {
    const path = `${mapping.workspaceRoot}/.a2a-files/${row.id}/${file.id}-${file.filename}`;
    await trackRuntimeOperation(async () => {
      const { body } = await openTaskFile(row.id, file.id);
      // Already-stored files are bound by their verified size and hash, so a
      // later lower administrator limit never strands an accepted file.
      const transfer = await fileProcess(
        row,
        { action: "write", maxBytes: file.size, expectedHash: file.sha256 },
        path,
        signal,
      );
      transfer.child.stdout.resume();
      try {
        await Promise.all([
          pipeline(
            Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
            transfer.child.stdin,
            { signal },
          ),
          transfer.done,
        ]);
      } finally {
        if (transfer.child.exitCode === null) transfer.child.kill("SIGKILL");
        await transfer.done.catch(() => undefined);
      }
    });
    staged.push({
      fileId: file.id,
      path,
      filename: file.filename,
      mediaType: file.mimeType,
      size: file.size,
      sha256: file.sha256,
    });
  }
  return staged;
}
