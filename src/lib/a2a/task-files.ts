import "server-only";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { permitsTransportProtocol } from "@/lib/transport-policy";
import { createHash, randomUUID } from "node:crypto";
import { Part, Task, TaskState } from "@a2a-js/sdk";
import type { A2ATask, Prisma } from "@prisma/client";
import {
  RequestMalformedError,
  UnsupportedOperationError,
  TaskNotFoundError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { assertLiveGrant, type TaskGrant } from "./principal";
import {
  lockTask,
  taskScope,
  persist,
  transition,
  recordTaskSettled,
} from "./store";
import { taskEvent, terminal, settled } from "./model";
import {
  assertTaskFileReadAuthority,
  copyTaskFile,
  storeTaskFile,
  copyAdmittedTaskFile,
  storeAdmittedTaskFile,
} from "./files";
import { taskFileLimit, taskFileLimitError } from "./file-limits";
import { fetchRemoteFile } from "./remote-network";
import { refreshRemoteTaskFileSources } from "./remote-executor";
import { wakeAgentWorker } from "@/lib/agents/execution/worker";

type Source =
  | { kind: "raw" | "url"; value: string }
  | { kind: "copy"; taskId: string; fileId: string };
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const transfers = new Map<string, Promise<boolean>>();

/** Admission/observation holds the task lock; no network or object-storage I/O occurs here. */
export async function prepareTaskFileParts(
  tx: Prisma.TransactionClient,
  taskId: string,
  workspaceId: string,
  parts: Part[],
  sourcePrefix: string,
  expiresAt: Date,
  sourceTaskId = taskId,
  deferredFiles?: Prisma.A2ATaskFileCreateManyInput[],
  refreshUrls = false,
): Promise<Part[]> {
  const policy = await getTransportSettings();
  const result: Part[] = [];
  let count = parts.some((part) => part.content?.$case !== "text")
    ? (await tx.a2ATaskFile.count({ where: { taskId } })) +
      (deferredFiles?.length ?? 0)
    : 0;
  for (const [index, part] of parts.entries()) {
    const content = part.content;
    if (content?.$case === "text") {
      result.push(
        Part.fromJSON({ text: content.value, mediaType: part.mediaType }),
      );
      continue;
    }
    let source: Source;
    if (content?.$case === "url") {
      const url = new URL(content.value);
      if (
        !permitsTransportProtocol(url.protocol, policy) ||
        url.username ||
        url.password ||
        url.hash ||
        content.value !== content.value.trim() ||
        content.value.includes("\\")
      )
        throw new RequestMalformedError(
          "File URLs require HTTPS without credentials or fragments.",
        );
      source = { kind: "url", value: content.value };
    } else if (content?.$case === "raw") {
      if (content.value.byteLength > policy.a2aInlineBytes)
        throw new RequestMalformedError(
          `Inline files exceed the ${policy.a2aInlineBytes / 1024} KiB limit; use a URL.`,
        );
      source = {
        kind: "raw",
        value: Buffer.from(content.value).toString("base64"),
      };
    } else {
      const id =
        content?.$case === "data" ? content.value.toolplaneFileId : undefined;
      if (typeof id !== "string")
        throw new RequestMalformedError(
          "A valid owned file handle is required.",
        );
      const owned = await tx.a2ATaskFile.findFirst({
        where: {
          id,
          taskId: sourceTaskId,
          workspaceId,
          status: "ready",
          expiresAt: { gt: new Date() },
        },
      });
      if (!owned)
        throw new RequestMalformedError(
          "File does not belong to the authorized source task.",
        );
      if (sourceTaskId === taskId) {
        result.push(
          Part.fromJSON({
            data: { toolplaneFileId: id },
            metadata: { toolplaneFileId: id },
            filename: owned.filename,
            mediaType: owned.mimeType,
          }),
        );
        continue;
      }
      source = { kind: "copy", taskId: sourceTaskId, fileId: id };
    }
    const sourceKey = `${sourcePrefix}:${index}`;
    const previous = await tx.a2ATaskFile.findUnique({
      where: { taskId_sourceKey: { taskId, sourceKey } },
    });
    if (refreshUrls && !previous) continue;
    const filename = part.filename || `file-${index + 1}`;
    const mimeType = part.mediaType || "application/octet-stream";
    if (
      previous &&
      (previous.filename !== filename || previous.mimeType !== mimeType)
    )
      throw new RequestMalformedError("File source identity changed.");
    if (previous?.status === "ready") {
      if (
        previous.expiresAt <= new Date() ||
        (content?.$case === "raw" &&
          createHash("sha256").update(content.value).digest("hex") !==
            previous.sha256)
      )
        throw new RequestMalformedError(
          "Ready file source identity changed or expired.",
        );
      result.push(
        Part.fromJSON({
          data: { toolplaneFileId: previous.id },
          metadata: { toolplaneFileId: previous.id },
          filename,
          mediaType: mimeType,
        }),
      );
      continue;
    }
    if (!previous && ++count > policy.a2aTaskFiles)
      throw taskFileLimitError("TASK_FILE_COUNT_EXCEEDED", policy.a2aTaskFiles);
    const sourceEnvelope = encryptSecretText(
      JSON.stringify({ taskId, sourceKey, source }),
    );
    const data = {
      id: randomUUID(),
      taskId,
      workspaceId,
      sourceKey,
      filename,
      mimeType,
      source: json(sourceEnvelope),
      status: "pending",
      expiresAt: new Date(
        Math.min(expiresAt.getTime(), Date.now() + 7 * 86_400_000),
      ),
    };
    const file =
      previous ??
      (deferredFiles ? data : await tx.a2ATaskFile.create({ data }));
    if (!previous && deferredFiles) deferredFiles.push(data);
    if (previous && previous.status !== "ready" && previous.source) {
      const old = JSON.parse(decryptSecretText(previous.source)) as {
        source: Source;
      };
      const same = JSON.stringify(old.source) === JSON.stringify(source);
      if (
        !same &&
        !(refreshUrls && old.source.kind === "url" && source.kind === "url")
      )
        throw new RequestMalformedError("File source identity changed.");
      if (!same)
        await tx.a2ATaskFile.update({
          where: { id: file.id },
          data: { source: json(sourceEnvelope) },
        });
    }
    result.push(
      Part.fromJSON({
        data: { toolplaneFileId: file.id },
        metadata: { toolplaneFileId: file.id },
        filename,
        mediaType: mimeType,
      }),
    );
  }
  return result;
}

async function receiveTransfers(
  taskId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  assertRuntimeOwner();
  const row = await db.a2ATask.findUniqueOrThrow({ where: { id: taskId } });
  if (
    !["file-receiving", "remote-file-receiving"].includes(row.phase) ||
    terminal(row.state)
  )
    return false;
  const grant = row.grant as unknown as TaskGrant;
  const output = row.remoteObservedState != null;
  const owner = runtimeAbortSignal();
  const abort = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(owner ? [owner] : []),
    ...(signal ? [signal] : []),
  ]);
  const files = await db.a2ATaskFile.findMany({
    where: { taskId, status: { not: "ready" } },
    orderBy: { createdAt: "asc" },
  });
  let limitFailure: { reason: string; message: string } | undefined;
  for (const file of files) {
    try {
      abort.throwIfAborted();
      if (output) await assertTaskFileReadAuthority(taskId);
      else await assertLiveGrant(grant, "send");
      const current = await db.a2ATask.findUniqueOrThrow({
        where: { id: taskId },
      });
      if (
        terminal(current.state) ||
        current.cancelRequestedAt ||
        current.phase !== row.phase ||
        file.expiresAt <= new Date()
      )
        throw new Error("File reception stopped.");
      const descriptor = JSON.parse(decryptSecretText(file.source)) as {
        taskId: string;
        sourceKey: string;
        source: Source;
      };
      if (
        descriptor.taskId !== taskId ||
        descriptor.sourceKey !== file.sourceKey
      )
        throw new Error("File binding mismatch.");
      const source = descriptor.source;
      if (source.kind === "copy") {
        if (output)
          await copyTaskFile(
            source.taskId,
            source.fileId,
            taskId,
            file.sourceKey,
          );
        else
          await copyAdmittedTaskFile(
            source.taskId,
            source.fileId,
            taskId,
            file.sourceKey,
          );
      } else {
        const stream =
          source.kind === "url"
            ? await fetchRemoteFile(source.value, abort)
            : (async function* () {
                yield Buffer.from(source.value, "base64");
              })();
        if (output)
          await storeTaskFile(
            taskId,
            file.sourceKey,
            file.filename,
            file.mimeType,
            stream,
            abort,
          );
        else
          await storeAdmittedTaskFile(
            taskId,
            file.sourceKey,
            file.filename,
            file.mimeType,
            stream,
            abort,
          );
      }
    } catch (error) {
      // Fixed diagnostics only: exception strings and URLs may contain signed capabilities.
      const reason = taskFileLimit(error);
      if (reason && !limitFailure)
        limitFailure = { reason, message: (error as Error).message };
      await db.a2ATaskFile.updateMany({
        where: { id: file.id, status: { in: ["pending", "failed"] } },
        data: { status: "failed", errorCode: reason ?? "FILE_DOWNLOAD_FAILED" },
      });
      if (reason && !output) break;
    }
  }
  let completed: A2ATask | undefined;
  const ready = await db.$transaction(async (tx) => {
    const current = await lockTask(tx, taskId);
    if (
      terminal(current.state) ||
      current.cancelRequestedAt ||
      current.phase !== row.phase
    )
      return false;
    const pending = await tx.a2ATaskFile.count({
      where: { taskId, status: { not: "ready" } },
    });
    const task = Task.fromJSON(current.snapshot);
    task.metadata = {
      ...task.metadata,
      toolplaneFileDelivery: {
        state: pending ? "failed" : "ready",
        ...(pending && limitFailure ? { reason: limitFailure.reason } : {}),
        ...(output ? { remoteState: current.remoteObservedState } : {}),
      },
    };
    if (pending && !output && limitFailure) {
      // Retrying cannot satisfy a size or count limit; end the input stage now.
      transition(task, TaskState.TASK_STATE_FAILED, limitFailure.message);
      completed = await persist(tx, current, task, taskEvent(task), {
        remoteFilesStatus: "failed",
        leaseToken: null,
      });
      return false;
    }
    if (pending) {
      await persist(tx, current, task, taskEvent(task), {
        remoteFilesStatus: "failed",
        phase: output ? "remote-file-failed" : "file-transfer-failed",
        leaseToken: null,
      });
      return false;
    }
    if (output) {
      const observed = current.remoteObservedState as TaskState;
      const message = task.status?.message;
      if (task.status?.state !== observed) transition(task, observed);
      if (task.status) task.status.message = message;
      const updated = await persist(tx, current, task, taskEvent(task), {
        remoteFilesStatus: "ready",
        phase: terminal(observed) ? "done" : "remote-waiting",
        leaseToken: null,
      });
      if (settled(observed)) completed = updated;
    } else
      await persist(tx, current, task, taskEvent(task), {
        remoteFilesStatus: "ready",
        phase: "queued",
        leaseToken: null,
      });
    return true;
  });
  if (completed) await recordTaskSettled(completed);
  return ready;
}

/** Initial/crash-recovered staging only. Failed transfers require the explicit retry API. */
export function stageTaskFileTransfers(
  taskId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const existing = transfers.get(taskId);
  if (existing) return existing;
  const work = receiveTransfers(taskId, signal).finally(() =>
    transfers.delete(taskId),
  );
  transfers.set(taskId, work);
  return work;
}

/** Requeues reception only; it cannot send a business message or execute a model. */
export async function retryTaskFileTransfers(
  grant: TaskGrant,
  taskId: string,
  signal?: AbortSignal,
): Promise<A2ATask> {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner();
    const row = await db.a2ATask.findFirst({
      where: {
        id: taskId,
        context: { ...taskScope(grant), expiresAt: { gt: new Date() } },
      },
    });
    if (!row) throw new TaskNotFoundError();
    const release = beginWorkspaceOperation(grant.workspaceId);
    if (!release) throw new UnsupportedOperationError("Workspace is closing.");
    try {
      const output = row.remoteObservedState != null;
      if (output) await assertTaskFileReadAuthority(taskId);
      else await assertLiveGrant(grant, "send");
      if (
        ![
          "file-transfer-failed",
          "remote-file-failed",
          "file-staging-failed",
        ].includes(row.phase)
      )
        throw new UnsupportedOperationError(
          "This task has no failed file reception to retry.",
        );
      if (
        terminal(row.state) ||
        row.cancelRequestedAt ||
        (!output && row.deadlineAt <= new Date())
      )
        throw new UnsupportedOperationError(
          "File reception is no longer authorized.",
        );
      if (output && row.remoteTaskId)
        await refreshRemoteTaskFileSources(row, signal);
      await db.$transaction(async (tx) => {
        const current = await lockTask(tx, taskId);
        if (
          current.phase !== row.phase ||
          current.cancelRequestedAt ||
          terminal(current.state)
        )
          throw new UnsupportedOperationError("File reception state changed.");
        const task = Task.fromJSON(current.snapshot);
        const sandbox = row.phase === "file-staging-failed";
        task.metadata = {
          ...task.metadata,
          toolplaneFileDelivery: {
            state: "pending",
            ...(sandbox ? { stage: "sandbox" } : {}),
            ...(output ? { remoteState: row.remoteObservedState } : {}),
          },
        };
        await persist(tx, current, task, taskEvent(task), {
          remoteFilesStatus: "pending",
          phase: sandbox
            ? "file-stage-ready"
            : output
              ? "remote-file-receiving"
              : "file-receiving",
          leaseToken: null,
        });
      });
      if (row.phase !== "file-staging-failed")
        await stageTaskFileTransfers(taskId, signal);
      wakeAgentWorker();
      return db.a2ATask.findUniqueOrThrow({ where: { id: taskId } });
    } finally {
      release();
    }
  });
}
