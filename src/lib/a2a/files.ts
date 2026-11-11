import "server-only";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import {
  DEFAULT_A2A_FILE_BYTES,
  permitsTransportProtocol,
} from "@/lib/transport-policy";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Readable } from "node:stream";
import { Part } from "@a2a-js/sdk";
import {
  Prisma,
  type A2ATaskFile,
  type A2ATask,
  type A2AContext,
} from "@prisma/client";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { runtimeEnv } from "@/lib/runtime-env";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import {
  AttachmentTooLargeError,
  deleteWorkspaceAttachmentFile,
  readWorkspaceAttachment,
  safeAttachmentFilename,
  writeWorkspaceAttachment,
} from "@/lib/attachments/storage";
import {
  TASK_FILE_LIMITS,
  TASK_INPUT_SOURCE_PREFIX,
  taskFileLimit,
  taskFileLimitError,
  type TaskFileLimit,
} from "./file-limits";
import {
  assertLiveGrant,
  isLocalGrant,
  isRemoteGrant,
  permits,
  type LocalA2AGrant,
  type TaskGrant,
} from "./principal";
import { assertLocalActor, localTarget, LOCAL_LIMITS } from "./local-policy";
import { remoteTarget } from "./remote-policy";
import { assertEntryPolicy } from "@/lib/agents/execution/entry-policy";

export type TaskFile = A2ATaskFile & {
  taskId: string;
  storagePath: string;
  size: number;
  sha256: string;
  status: "ready";
};
type AuthorizedFileTask = A2ATask & { context: A2AContext };
const missing = () => new TaskNotFoundError();
function ready(row: A2ATaskFile): TaskFile {
  if (
    row.status !== "ready" ||
    !row.taskId ||
    !row.storagePath ||
    row.size === null ||
    !row.sha256 ||
    row.expiresAt <= new Date()
  )
    throw missing();
  return row as TaskFile;
}

/** Read authority survives execution deadlines/leases, but not membership, policy or target revocation. */
async function assertLocalFileReader(
  grant: LocalA2AGrant,
  seen = new Set<string>(),
) {
  if (
    !permits(grant, "read") ||
    grant.ancestorTaskIds.length !== grant.ancestorAgentIds.length ||
    grant.ancestorTaskIds.length > LOCAL_LIMITS.depth
  )
    throw missing();
  await assertLocalActor(db, grant.workspaceId, grant.actorId);
  if (grant.entryPolicy) await assertEntryPolicy(db, grant);
  const target = await localTarget(
    db,
    grant.workspaceId,
    grant.agentId,
    grant.ancestorTaskIds.length ? "delegation" : grant.entryPolicy,
    grant.agentRevisionId,
  );
  if (target.binding !== grant.targetBinding) throw missing();
  for (let i = 0; i < grant.ancestorTaskIds.length; i++) {
    const id = grant.ancestorTaskIds[i];
    if (seen.has(id)) throw missing();
    seen.add(id);
    const row = await db.a2ATask.findUnique({ where: { id } });
    const ancestor = row?.grant as unknown as TaskGrant | undefined;
    if (
      !ancestor ||
      !isLocalGrant(ancestor) ||
      ancestor.workspaceId !== grant.workspaceId ||
      ancestor.actorId !== grant.actorId ||
      ancestor.agentId !== grant.ancestorAgentIds[i]
    )
      throw missing();
    await assertLocalActor(db, ancestor.workspaceId, ancestor.actorId);
    if (ancestor.entryPolicy) await assertEntryPolicy(db, ancestor);
    const current = await localTarget(
      db,
      ancestor.workspaceId,
      ancestor.agentId,
      ancestor.ancestorTaskIds.length ? "delegation" : ancestor.entryPolicy,
      ancestor.agentRevisionId,
    );
    if (
      current.binding !== ancestor.targetBinding ||
      !current.targets.includes(grant.ancestorAgentIds[i + 1] ?? grant.agentId)
    )
      throw missing();
  }
}
export async function assertTaskFileReadAuthority(taskId: string) {
  const task = await db.a2ATask.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (!task || task.context.expiresAt <= new Date()) throw missing();
  const grant = task.grant as unknown as TaskGrant;
  if (
    !grant ||
    grant.workspaceId !== task.context.workspaceId ||
    grant.ownerKey !== task.context.ownerKey ||
    !permits(grant, "read")
  )
    throw missing();
  if (isLocalGrant(grant)) {
    if (task.context.agentId !== grant.agentId) throw missing();
    await assertLocalFileReader(grant);
  } else if (isRemoteGrant(grant)) {
    if (task.context.remoteAgentId !== grant.remoteAgentId) throw missing();
    await assertLocalActor(db, grant.workspaceId, grant.actorId);
    if (
      (
        await remoteTarget(
          db,
          grant.workspaceId,
          grant.sourceAgentId,
          grant.remoteAgentId,
        )
      ).binding !== grant.targetBinding
    )
      throw missing();
    const parent = await db.a2ATask.findUnique({
      where: { id: grant.parentTaskId },
    });
    const authority = parent?.grant as unknown as TaskGrant | undefined;
    if (
      !parent ||
      !authority ||
      !isLocalGrant(authority) ||
      authority.workspaceId !== grant.workspaceId ||
      authority.actorId !== grant.actorId ||
      authority.agentId !== grant.sourceAgentId ||
      JSON.stringify(grant.ancestorTaskIds) !==
        JSON.stringify([...authority.ancestorTaskIds, parent.id]) ||
      JSON.stringify(grant.ancestorAgentIds) !==
        JSON.stringify([...authority.ancestorAgentIds, authority.agentId])
    )
      throw missing();
    await assertLocalFileReader(authority);
  } else {
    if (
      task.context.endpointId !== grant.endpointId ||
      task.context.clientId !== grant.clientId
    )
      throw missing();
    await assertLiveGrant(grant, "read");
  }
  return task;
}

async function lockFileTask(tx: Prisma.TransactionClient, taskId: string) {
  const initial = await tx.a2ATask.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (!initial) throw missing();
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${initial.context.workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "A2ATask" WHERE id=${taskId} FOR UPDATE`;
  const row = await tx.a2ATask.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (!row || row.context.expiresAt <= new Date()) throw missing();
  return row;
}

/** Only already-admitted input descriptors may be written with send-only authority. */
async function assertAdmittedFileWriteAuthority(
  taskId: string,
  sourceKey: string,
  filename: string,
  mimeType: string,
) {
  assertRuntimeOwner();
  const task = await db.a2ATask.findUnique({
    where: { id: taskId },
    include: { context: true },
  });
  if (
    task?.phase !== "file-receiving" ||
    task.remoteObservedState !== null ||
    task.cancelRequestedAt ||
    task.deadlineAt <= new Date() ||
    task.context.expiresAt <= new Date()
  )
    throw missing();
  const grant = task.grant as unknown as TaskGrant;
  if (
    !grant ||
    grant.workspaceId !== task.context.workspaceId ||
    grant.ownerKey !== task.context.ownerKey
  )
    throw missing();
  if (
    isLocalGrant(grant)
      ? task.context.agentId !== grant.agentId
      : isRemoteGrant(grant)
        ? task.context.remoteAgentId !== grant.remoteAgentId
        : task.context.endpointId !== grant.endpointId ||
          task.context.clientId !== grant.clientId
  )
    throw missing();
  await assertLiveGrant(grant, "send");
  const file = await db.a2ATaskFile.findUnique({
    where: { taskId_sourceKey: { taskId, sourceKey } },
  });
  if (
    !file?.source ||
    file.workspaceId !== grant.workspaceId ||
    file.expiresAt <= new Date() ||
    file.filename !== filename ||
    file.mimeType !== mimeType
  )
    throw missing();
  return task;
}

export function storeAdmittedTaskFile(
  taskId: string,
  sourceKey: string,
  filename: string,
  mimeType: string,
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<TaskFile> {
  return storeAuthorizedTaskFile(
    taskId,
    sourceKey,
    filename,
    mimeType,
    stream,
    () =>
      assertAdmittedFileWriteAuthority(taskId, sourceKey, filename, mimeType),
    signal,
  );
}

/** Immutable source identity: retries return the same ready object, regardless of expiring source URLs. */
export function storeTaskFile(
  taskId: string,
  sourceKey: string,
  filename: string,
  mimeType: string,
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<TaskFile> {
  return storeAuthorizedTaskFile(
    taskId,
    sourceKey,
    filename,
    mimeType,
    stream,
    () => assertTaskFileReadAuthority(taskId),
    signal,
  );
}

async function storeAuthorizedTaskFile(
  taskId: string,
  sourceKey: string,
  filename: string,
  mimeType: string,
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  authorize: () => Promise<AuthorizedFileTask>,
  signal?: AbortSignal,
): Promise<TaskFile> {
  if (
    !sourceKey ||
    Buffer.byteLength(sourceKey) > 512 ||
    /\p{Cc}/u.test(sourceKey)
  )
    throw new UnsupportedOperationError("Invalid file source identity.");
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType) || mimeType.length > 160)
    throw new UnsupportedOperationError("Invalid file media type.");
  const authority = await authorize();
  const settings = await getTransportSettings();
  const fileBytes = settings.a2aFileBytes;
  const token = randomUUID();
  // Protocol metadata retains the caller's filename; only disk paths use ASCII.
  const safeName = safeAttachmentFilename(filename);
  const path = `objects/${token}-${safeName}`;
  const reservation = await db.$transaction(async (tx) => {
    const task = await lockFileTask(tx, taskId);
    const existing = await tx.a2ATaskFile.findUnique({
      where: { taskId_sourceKey: { taskId, sourceKey } },
    });
    if (existing?.status === "ready")
      return { file: ready(existing), upload: false as const };
    if (existing?.status === "uploading")
      throw new UnsupportedOperationError(
        "File transfer is already in progress.",
      );
    const [usage] = await tx.$queryRaw<
      { taskCount: bigint; taskInputBytes: bigint; workspaceBytes: bigint }[]
    >`
      SELECT COUNT(*) FILTER (WHERE "taskId"=${taskId}) AS "taskCount",
        COALESCE(SUM(CASE WHEN "taskId"=${taskId} AND starts_with("sourceKey", ${TASK_INPUT_SOURCE_PREFIX}) AND "storagePath" IS NOT NULL THEN COALESCE("size", ${DEFAULT_A2A_FILE_BYTES}) ELSE 0 END), 0) AS "taskInputBytes",
        COALESCE(SUM(CASE WHEN "storagePath" IS NOT NULL THEN COALESCE("size", ${DEFAULT_A2A_FILE_BYTES}) ELSE 0 END), 0) AS "workspaceBytes"
      FROM "A2ATaskFile" WHERE "workspaceId"=${task.context.workspaceId}`;
    if (!existing && Number(usage.taskCount) >= settings.a2aTaskFiles)
      throw taskFileLimitError(
        "TASK_FILE_COUNT_EXCEEDED",
        settings.a2aTaskFiles,
      );
    // [reason, configured limit, remaining bytes]: the smallest remainder is
    // both the reservation and the reported reason.
    const bounds: [TaskFileLimit, number, number][] = [
      ["FILE_TOO_LARGE", fileBytes, fileBytes],
      ...(sourceKey.startsWith(TASK_INPUT_SOURCE_PREFIX)
        ? [
            [
              "TASK_INPUT_BYTES_EXCEEDED",
              settings.a2aTaskInputBytes,
              settings.a2aTaskInputBytes - Number(usage.taskInputBytes),
            ] as [TaskFileLimit, number, number],
          ]
        : []),
      [
        "WORKSPACE_FILE_BYTES_EXCEEDED",
        settings.a2aWorkspaceFileBytes,
        settings.a2aWorkspaceFileBytes - Number(usage.workspaceBytes),
      ],
    ];
    const [limit, limitBytes, reservedBytes] = bounds.reduce((min, bound) =>
      bound[2] < min[2] ? bound : min,
    );
    if (reservedBytes <= 0) throw taskFileLimitError(limit, limitBytes);
    const expiresAt = new Date(
      Math.min(
        task.context.expiresAt.getTime(),
        Date.now() + TASK_FILE_LIMITS.retentionMs,
      ),
    );
    const data = {
      workspaceId: task.context.workspaceId,
      filename,
      mimeType,
      status: "uploading",
      uploadToken: token,
      uploadStartedAt: new Date(),
      storagePath: path,
      // Persist the reservation so later setting changes cannot undercount it.
      size: reservedBytes,
      sha256: null,
      errorCode: null,
      expiresAt,
    };
    const file = existing
      ? await tx.a2ATaskFile.update({ where: { id: existing.id }, data })
      : await tx.a2ATaskFile.create({ data: { ...data, taskId, sourceKey } });
    return {
      file,
      upload: true as const,
      maxBytes: reservedBytes,
      limit,
      limitBytes,
    };
  });
  if (!reservation.upload) {
    const file = ready(reservation.file);
    const body =
      stream instanceof ReadableStream
        ? Readable.fromWeb(stream as never)
        : stream;
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of body) {
      signal?.throwIfAborted();
      size += chunk.byteLength;
      if (size > fileBytes)
        throw taskFileLimitError("FILE_TOO_LARGE", fileBytes);
      hash.update(chunk);
    }
    if (
      size !== file.size ||
      hash.digest("hex") !== file.sha256 ||
      filename !== file.filename ||
      mimeType !== file.mimeType
    )
      throw new UnsupportedOperationError(
        "File source identity is already bound to different content.",
      );
    return file;
  }
  let written = false;
  let sourceError: unknown;
  // Storage rewraps body failures; keep the source's own limit reason.
  async function* watched() {
    try {
      for await (const chunk of stream instanceof ReadableStream
        ? Readable.fromWeb(stream as never)
        : stream)
        yield chunk as Uint8Array;
    } catch (error) {
      sourceError = error;
      throw error;
    }
  }
  try {
    const body = Readable.toWeb(
      Readable.from(watched()),
    ) as ReadableStream<Uint8Array>;
    const stored = await writeWorkspaceAttachment({
      workspaceId: authority.context.workspaceId,
      filename: safeName,
      body,
      objectId: token,
      allowEmpty: true,
      maxBytes: reservation.maxBytes,
      signal,
    });
    written = true;
    await authorize();
    return await db.$transaction(async (tx) => {
      await lockFileTask(tx, taskId);
      const row = await tx.a2ATaskFile.findUnique({
        where: { id: reservation.file.id },
      });
      if (
        !row ||
        row.uploadToken !== token ||
        row.status !== "uploading" ||
        row.expiresAt <= new Date()
      )
        throw missing();
      return ready(
        await tx.a2ATaskFile.update({
          where: { id: row.id },
          data: {
            status: "ready",
            size: stored.size,
            sha256: stored.sha256,
            storagePath: stored.storagePath,
            source: Prisma.DbNull,
            errorCode: null,
            uploadToken: null,
            uploadStartedAt: null,
          },
        }),
      );
    });
  } catch (error) {
    const limitError = taskFileLimit(error)
      ? error
      : taskFileLimit(sourceError)
        ? sourceError
        : error instanceof AttachmentTooLargeError
          ? taskFileLimitError(reservation.limit, reservation.limitBytes)
          : undefined;
    // Retain cleanup identity until physical removal has succeeded.
    try {
      await deleteWorkspaceAttachmentFile(authority.context.workspaceId, path);
      await db.a2ATaskFile.updateMany({
        where: { id: reservation.file.id, uploadToken: token },
        data: {
          status: "failed",
          errorCode: signal?.aborted
            ? "FILE_TRANSFER_ABORTED"
            : (taskFileLimit(limitError) ?? "FILE_TRANSFER_FAILED"),
          storagePath: null,
          size: null,
          sha256: null,
          uploadToken: null,
          uploadStartedAt: null,
        },
      });
    } catch {
      // A stale-upload sweep retries removal, including uploads whose process died.
      if (written)
        await db.a2ATaskFile.updateMany({
          where: { id: reservation.file.id, uploadToken: token },
          data: { errorCode: "FILE_CLEANUP_PENDING" },
        });
    }
    throw limitError ?? error;
  }
}

export async function listTaskFiles(taskId: string): Promise<TaskFile[]> {
  await assertTaskFileReadAuthority(taskId);
  return (
    await db.a2ATaskFile.findMany({
      where: { taskId, status: "ready", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
    })
  ).map(ready);
}
export async function openTaskFile(taskId: string, fileId: string) {
  const task = await assertTaskFileReadAuthority(taskId);
  const row = await db.a2ATaskFile.findFirst({
    where: { id: fileId, taskId, workspaceId: task.context.workspaceId },
  });
  if (!row) throw missing();
  const file = ready(row);
  const source = readWorkspaceAttachment(
    file.workspaceId,
    file.storagePath,
    Math.max(1, file.size),
  );
  const hash = createHash("sha256");
  let size = 0;
  const body = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (size !== file.size || hash.digest("hex") !== file.sha256)
          throw new Error("Task file integrity check failed.");
      },
    }),
  );
  return { file, body };
}
export async function copyTaskFile(
  sourceTaskId: string,
  fileId: string,
  targetTaskId: string,
  sourceKey: string,
) {
  const source = await assertTaskFileReadAuthority(sourceTaskId);
  const target = await assertTaskFileReadAuthority(targetTaskId);
  if (
    source.context.workspaceId !== target.context.workspaceId ||
    !(
      source.id === target.id ||
      source.parentTaskId === target.id ||
      target.parentTaskId === source.id
    )
  )
    throw missing();
  const { file, body } = await openTaskFile(sourceTaskId, fileId);
  const pending = await db.a2ATaskFile.findUnique({
    where: { taskId_sourceKey: { taskId: targetTaskId, sourceKey } },
  });
  return storeTaskFile(
    targetTaskId,
    sourceKey,
    pending?.filename ?? file.filename,
    pending?.mimeType ?? file.mimeType,
    body,
  );
}

export async function copyAdmittedTaskFile(
  sourceTaskId: string,
  fileId: string,
  targetTaskId: string,
  sourceKey: string,
) {
  const pending = await db.a2ATaskFile.findUnique({
    where: { taskId_sourceKey: { taskId: targetTaskId, sourceKey } },
  });
  if (!pending) throw missing();
  const target = await assertAdmittedFileWriteAuthority(
    targetTaskId,
    sourceKey,
    pending.filename,
    pending.mimeType,
  );
  const source = await assertTaskFileReadAuthority(sourceTaskId);
  if (
    source.context.workspaceId !== target.context.workspaceId ||
    !(
      source.id === target.id ||
      source.parentTaskId === target.id ||
      target.parentTaskId === source.id
    )
  )
    throw missing();
  const { body } = await openTaskFile(sourceTaskId, fileId);
  return storeAdmittedTaskFile(
    targetTaskId,
    sourceKey,
    pending.filename,
    pending.mimeType,
    body,
  );
}
export function makeTaskFilePart(file: TaskFile): Part {
  return Part.fromJSON({
    data: { toolplaneFileId: file.id },
    metadata: { toolplaneFileId: file.id },
    filename: file.filename,
    mediaType: file.mimeType,
  });
}
function ticketSignature(
  taskId: string,
  fileId: string,
  ownerKey: string,
  hash: string,
  expiry: string,
) {
  const secret = runtimeEnv("AUTH_SECRET");
  if (!secret) throw new Error("Missing task file signing key.");
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "toolplane:a2a:file:v1",
        taskId,
        fileId,
        ownerKey,
        hash,
        expiry,
      ]),
    )
    .digest("base64url");
}
export async function createTaskFileUrl(
  taskId: string,
  fileId: string,
  baseUrl: string,
) {
  const task = await assertTaskFileReadAuthority(taskId);
  const file = ready(
    (await db.a2ATaskFile.findFirst({ where: { id: fileId, taskId } })) ??
      (() => {
        throw missing();
      })(),
  );
  const origin = new URL(baseUrl);
  if (
    !permitsTransportProtocol(origin.protocol, await getTransportSettings()) ||
    origin.username ||
    origin.password
  )
    throw new Error("HTTPS file egress origin is required.");
  const expiry = String(
    Math.min(
      Date.now() + TASK_FILE_LIMITS.ticketMs,
      file.expiresAt.getTime(),
      task.context.expiresAt.getTime(),
    ),
  );
  const signature = ticketSignature(
    taskId,
    file.id,
    task.context.ownerKey,
    file.sha256,
    expiry,
  );
  const url = new URL(`/api/v1/a2a/files/${file.id}`, origin.origin);
  url.searchParams.set("task", taskId);
  url.searchParams.set("expires", expiry);
  url.searchParams.set("signature", signature);
  return url.toString();
}
export async function openTaskFileCapability(
  fileId: string,
  taskId: string,
  expiry: string,
  signature: string,
) {
  if (
    !/^\d{13}$/.test(expiry) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    Number(expiry) <= Date.now() ||
    Number(expiry) > Date.now() + TASK_FILE_LIMITS.ticketMs
  )
    throw missing();
  const task = await assertTaskFileReadAuthority(taskId);
  const row = await db.a2ATaskFile.findFirst({ where: { id: fileId, taskId } });
  if (!row) throw missing();
  const file = ready(row);
  const expected = ticketSignature(
    taskId,
    fileId,
    task.context.ownerKey,
    file.sha256,
    expiry,
  );
  if (
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) ||
    Number(expiry) > file.expiresAt.getTime()
  )
    throw missing();
  return openTaskFile(taskId, fileId);
}
export async function hydrateTaskParts(
  taskId: string,
  parts: Part[],
  baseUrl: string,
): Promise<Part[]> {
  return Promise.all(
    parts.map(async (part) => {
      const id = part.metadata?.toolplaneFileId;
      if (typeof id !== "string") return part;
      const file = await db.a2ATaskFile.findFirst({ where: { id, taskId } });
      if (!file) throw missing();
      if (file.status !== "ready") return part;
      const value = ready(file);
      return Part.fromJSON({
        url: await createTaskFileUrl(taskId, id, baseUrl),
        filename: value.filename,
        mediaType: value.mimeType,
      });
    }),
  );
}

/** Bounded maintenance; orphan records retain paths until physical deletion succeeds. */
export async function cleanupTaskFiles(now = new Date(), limit = 100) {
  const rows = await db.a2ATaskFile.findMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { taskId: null },
        {
          status: "uploading",
          uploadStartedAt: {
            lte: new Date(now.getTime() - TASK_FILE_LIMITS.uploadMs),
          },
        },
      ],
      AND: [
        {
          OR: [
            { storagePath: { not: null } },
            { source: { not: Prisma.DbNull } },
            { status: "uploading" },
          ],
        },
      ],
    },
    take: Math.max(1, Math.min(1000, limit)),
    orderBy: { expiresAt: "asc" },
  });
  let cleaned = 0;
  for (const candidate of rows) {
    const token = randomUUID();
    const reserved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${candidate.workspaceId} FOR UPDATE`;
      const row = await tx.a2ATaskFile.findUnique({
        where: { id: candidate.id },
      });
      if (
        !row ||
        (row.taskId &&
          row.expiresAt > now &&
          !(
            row.status === "uploading" &&
            row.uploadStartedAt &&
            row.uploadStartedAt.getTime() <=
              now.getTime() - TASK_FILE_LIMITS.uploadMs
          ))
      )
        return null;
      await tx.a2ATaskFile.update({
        where: { id: row.id },
        data: {
          status: "uploading",
          uploadToken: token,
          uploadStartedAt: new Date(now.getTime() - TASK_FILE_LIMITS.uploadMs),
          errorCode: "FILE_CLEANUP_PENDING",
          ...(!row.taskId || row.expiresAt <= now
            ? { source: Prisma.DbNull }
            : {}),
        },
      });
      return row;
    });
    if (!reserved) continue;
    // Docker I/O is outside the database transaction; the fence prevents resurrection.
    if (reserved.storagePath)
      await deleteWorkspaceAttachmentFile(
        reserved.workspaceId,
        reserved.storagePath,
      );
    await db.a2ATaskFile.updateMany({
      where: { id: reserved.id, uploadToken: token },
      data: {
        storagePath: null,
        uploadToken: null,
        uploadStartedAt: null,
        status: "failed",
        errorCode:
          reserved.expiresAt <= now
            ? "FILE_EXPIRED"
            : "FILE_TRANSFER_INTERRUPTED",
      },
    });
    cleaned++;
  }
  return cleaned;
}
