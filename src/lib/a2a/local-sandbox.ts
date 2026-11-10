import "server-only";
import type { A2ATask } from "@prisma/client";
import { Task, Role } from "@a2a-js/sdk";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { sandboxContainerName } from "@/lib/sandboxes/runtime";
import { agentSessionWorkingDirectory } from "@/lib/agents/session-paths";
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
  ensureAgentConversationSandbox,
  findAgentConversationSandbox,
} from "@/lib/agents/conversation-sandbox";
import { assertLiveGrant, isLocalGrant, type TaskGrant } from "./principal";
import { settled } from "./model";
import { getTransportSettings } from "@/lib/admin/transport-settings";
export class SandboxFileStagingError extends Error {
  readonly code = "A2A_SANDBOX_FILE_STAGING_FAILED";
  constructor(cause: unknown) {
    super(
      "Task files could not be delivered to the authorized sandbox; retry file delivery explicitly before execution.",
      { cause },
    );
  }
}

/** Entry IDs come from the signed, revalidated ingress grant, never runtime input. */
export async function localTaskSandbox(
  row: A2ATask,
  cleanup = false,
  signal?: AbortSignal,
) {
  const grant = row.grant as unknown as TaskGrant;
  if (!isLocalGrant(grant)) throw new Error("Local target unavailable.");
  if (cleanup) {
    assertRuntimeOwner();
    if (row.executionBackend !== "pi-harness" || !row.nativeOperationId)
      throw new Error("Native cleanup requires a bound operation.");
  } else await assertLiveGrant(grant, "send");
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
      if (!work) throw new Error("Local Work session unavailable.");
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
  const mapping = cleanup
    ? await findAgentConversationSandbox({ ...identity, cleanup: true })
    : await ensureAgentConversationSandbox({ ...identity, signal });
  if (!mapping) throw new Error("Bound native sandbox unavailable.");
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

async function fileProcess(
  row: A2ATask,
  action: "read" | "write",
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
  hash?: string,
) {
  const mapping = await localTaskSandbox(row, false, signal);
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
  const command =
    action === "read"
      ? `\nawait readWorkspaceFile(${root}, process.argv[1], process.stdout, { maxBytes: ${maxBytes} }).catch(reportFailure);`
      : `\nawait writeWorkspaceFile(${root}, process.argv[1], process.stdin, { maxBytes: ${maxBytes}, expectedHash: process.argv[2] }).catch(reportFailure);`;
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
      ...(hash ? [hash] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"], signal: combined },
  );
  let detail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (detail.length < 2048) detail += chunk.toString();
  });
  const { promise: done, resolve, reject } = Promise.withResolvers<void>();
  child.once("error", reject);
  child.once("close", (code) =>
    code === 0
      ? resolve()
      : reject(
          code === 27 && action === "read"
            ? taskFileLimitError("FILE_TOO_LARGE", maxBytes)
            : new Error(detail.trim() || "Sandbox file transfer failed."),
        ),
  );
  // A producer can fail before a consumer attaches; retain the original rejection.
  void done.catch(() => undefined);
  return { child, done };
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
    // Sandbox output becomes new task storage: the current administrator limit applies.
    const { a2aFileBytes } = await getTransportSettings();
    const transfer = await fileProcess(row, "read", path, a2aFileBytes, signal);
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
  const mapping = await localTaskSandbox(row, false, signal);
  for (const file of files) {
    const path = `${mapping.workspaceRoot}/.a2a-files/${row.id}/${file.id}-${file.filename}`;
    await trackRuntimeOperation(async () => {
      const { body } = await openTaskFile(row.id, file.id);
      // Already-stored files are bound by their verified size and hash, so a
      // later lower administrator limit never strands an accepted file.
      const transfer = await fileProcess(
        row,
        "write",
        path,
        file.size,
        signal,
        file.sha256,
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
