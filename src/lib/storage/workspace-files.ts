import "server-only";
import { Prisma } from "@prisma/client";
import { terminal } from "@/lib/a2a/model";
import {
  removeDeletedTaskFile,
  stageWorkspaceTaskFileDeletion,
} from "@/lib/a2a/files";
import {
  removeAttachmentPendingCleanup,
  stageAttachmentDeletion,
} from "@/lib/attachments/uploads";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/observability/audit";
import { logSystemEvent } from "@/lib/observability/system";
import {
  resolveWorkspaceScope,
  type WorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import {
  effectiveUserLimits,
  lockStorageWorkspace,
  lockUserLimits,
  ownedStorageBytes,
  workspaceStorageBytes,
} from "./user-quota";

export type FileKind = "attachment" | "a2a";
export type FileSort = "size" | "createdAt";
export type WorkspaceFileRef = { kind: FileKind; id: string };
export type WorkspaceFileDeletionFailure =
  | "not_found"
  | "forbidden"
  | "in_use"
  | "storage_error";

type Cursor = WorkspaceFileRef & { value: number };
export type FilePage = {
  kind: FileKind | "all";
  sort: FileSort;
  limit: number;
  cursor: Cursor | null;
};

export function parseFileCursor(value: string, page: Omit<FilePage, "cursor">) {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error("Invalid cursor");
  const cursor = JSON.parse(Buffer.from(value, "base64url").toString());
  if (
    !cursor ||
    cursor.sort !== page.sort ||
    cursor.filter !== page.kind ||
    !["attachment", "a2a"].includes(cursor.kind) ||
    typeof cursor.id !== "string" ||
    cursor.id.length < 1 ||
    cursor.id.length > 128 ||
    !Number.isSafeInteger(cursor.value) ||
    cursor.value < (page.sort === "size" ? 0 : Date.UTC(1_000, 0, 1)) ||
    cursor.value > (page.sort === "size" ? 2_147_483_647 : Date.UTC(9999, 0, 1))
  )
    throw new Error("Invalid cursor");
  return cursor as Cursor;
}

type FileRow = WorkspaceFileRef & {
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  expiresAt: Date | null;
  uploadedById: string | null;
  uploaderOnly: boolean;
  uploaderName: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  conversationAgentId: string | null;
  threadId: string | null;
  threadTitle: string | null;
  assistantId: string | null;
  taskId: string | null;
  taskState: number | null;
  taskSourceAgentId: string | null;
  rootAgentId: string | null;
  taskLabel: string | null;
};

type Source = {
  type: "conversation" | "chatThread" | "a2aTask" | "draft";
  id: string | null;
  label: string | null;
  href: string | null;
};

function sourceForFile(row: FileRow, base: string): Source {
  if (row.kind === "a2a") {
    return {
      type: "a2aTask",
      id: row.taskId,
      label: row.taskLabel,
      href:
        row.taskId && row.taskSourceAgentId
          ? `${base}/work?${new URLSearchParams({ agent: row.taskSourceAgentId, a2a: row.taskId })}`
          : null,
    };
  }
  if (row.threadId && row.assistantId) {
    return {
      type: "chatThread",
      id: row.threadId,
      label: row.threadTitle,
      href: `${base}/chat?${new URLSearchParams({ assistant: row.assistantId, thread: row.threadId })}`,
    };
  }
  if (row.conversationId && row.conversationAgentId) {
    return {
      type: "conversation",
      id: row.conversationId,
      label: row.conversationTitle,
      href: `${base}/work?${new URLSearchParams({ agent: row.conversationAgentId, c: row.conversationId })}`,
    };
  }
  return { type: "draft", id: null, label: null, href: null };
}

function projectFile(
  row: FileRow,
  workspace: Pick<WorkspaceScope, "slug" | "ownerId">,
  actorUserId: string,
  now: Date,
) {
  const isOwner = workspace.ownerId === actorUserId;
  const source = sourceForFile(
    row,
    `/app/${encodeURIComponent(workspace.slug)}`,
  );
  const deleteBlockedReason =
    row.kind === "attachment"
      ? isOwner || row.uploadedById === actorUserId
        ? null
        : "forbidden"
      : !isOwner
        ? "forbidden"
        : row.taskId && (row.taskState === null || !terminal(row.taskState))
          ? "in_use"
          : null;
  // Reuse the existing credential- and source-scoped download routes. A link
  // is not a capability and cannot bypass their independent read policies.
  const downloadUrl =
    row.kind === "attachment"
      ? row.uploadedById === actorUserId ||
        (!row.uploaderOnly && source.type !== "draft")
        ? `/api/v1/attachments/${encodeURIComponent(row.id)}`
        : null
      : row.taskId && row.rootAgentId && row.expiresAt && row.expiresAt > now
        ? `/api/v1/a2a/files/${encodeURIComponent(row.id)}/download?${new URLSearchParams({ task: row.taskId })}`
        : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    uploader: row.uploadedById
      ? { id: row.uploadedById, name: row.uploaderName }
      : null,
    source,
    downloadUrl,
    canDelete: deleteBlockedReason === null,
    deleteBlockedReason,
  };
}

export function listWorkspaceFiles(scope: WorkspaceScope, page: FilePage) {
  return db.$transaction(
    async (tx) => {
      // Apply the shared access predicate in the same snapshot as the native
      // union and usage queries. Scope/ownership changes cannot race the read.
      const workspace = await tx.workspace.findFirst({
        where: workspaceScopeWhere(scope),
        select: { id: true, slug: true, ownerId: true },
      });
      if (!workspace) return null;
      const { id } = workspace;
      const sortColumn =
        page.sort === "size" ? Prisma.sql`f.size` : Prisma.sql`f."createdAt"`;
      const after = page.cursor
        ? Prisma.sql`WHERE (${sortColumn}, f.id COLLATE "C", f.kind) < (${
            page.sort === "size"
              ? page.cursor.value
              : Prisma.sql`${new Date(page.cursor.value).toISOString().slice(0, -1)}::timestamp`
          }, ${page.cursor.id}, ${page.cursor.kind})`
        : Prisma.empty;
      const rows = await tx.$queryRaw<FileRow[]>`
        WITH files AS (
          SELECT a.id, 'attachment'::text AS kind, a.name, a."mimeType", a.size,
                 a."createdAt", NULL::timestamp AS "expiresAt", a."uploadedById",
                 a."conversationId", a."chatThreadId", NULL::text AS "taskId", a."uploaderOnly"
          FROM "WorkspaceAttachment" a
          WHERE a."workspaceId" = ${id} AND a.status = 'ready' AND ${page.kind !== "a2a"}
          UNION ALL
          SELECT a.id, 'a2a'::text, a.filename, a."mimeType", a.size,
                 a."createdAt", a."expiresAt", NULL, NULL, NULL, a."taskId", false
          FROM "A2ATaskFile" a
          WHERE a."workspaceId" = ${id} AND a.status = 'ready' AND ${page.kind !== "attachment"}
            AND a."storagePath" IS NOT NULL AND a.size IS NOT NULL
        ), page AS (
          SELECT f.* FROM files f
          ${after}
          ORDER BY ${sortColumn} DESC, f.id COLLATE "C" DESC, f.kind DESC
          LIMIT ${page.limit + 1}
        )
        SELECT f.*, u.name AS "uploaderName",
               c.title AS "conversationTitle", ag.id AS "conversationAgentId",
               h.id AS "threadId", h.title AS "threadTitle", h."assistantId",
               CASE WHEN ctx.id IS NOT NULL THEN t.state END AS "taskState",
               CASE WHEN ctx."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                 AND NOT EXISTS (
                   SELECT 1 FROM "A2AEntryBinding" binding
                   WHERE binding."contextId" = ctx.id
                 ) THEN CASE ctx."targetKind"
                   WHEN 'local' THEN taskAgent.id
                   WHEN 'published' THEN taskEndpoint."sourceAgentId"
                 END END AS "taskSourceAgentId",
               COALESCE(rootAgent.id, endpoint."sourceAgentId") AS "rootAgentId",
               COALESCE(taskEndpoint.name, taskAgent.name) AS "taskLabel"
        FROM page f
        LEFT JOIN "User" u ON u.id = f."uploadedById"
        LEFT JOIN "Conversation" c ON c.id = f."conversationId"
        LEFT JOIN "Agent" ag ON ag.id = c."agentId" AND ag."workspaceId" = ${id}
        LEFT JOIN "ChatThread" h ON h.id = f."chatThreadId" AND h."workspaceId" = ${id}
        LEFT JOIN "A2ATask" t ON t.id = f."taskId"
        LEFT JOIN "A2AContext" ctx ON ctx.id = t."contextId" AND ctx."workspaceId" = ${id}
        LEFT JOIN "Agent" taskAgent ON taskAgent.id = ctx."agentId" AND taskAgent."workspaceId" = ${id}
        LEFT JOIN "AgentEndpoint" taskEndpoint ON taskEndpoint.id = ctx."endpointId" AND taskEndpoint."workspaceId" = ${id}
        LEFT JOIN "A2ATask" root ON root.id = COALESCE(t."rootTaskId", t.id)
          AND root."parentTaskId" IS NULL AND ctx.id IS NOT NULL
        LEFT JOIN "A2AContext" rootCtx ON rootCtx.id = root."contextId"
          AND rootCtx."workspaceId" = ${id}
        LEFT JOIN "Agent" rootAgent ON rootAgent.id = rootCtx."agentId" AND rootAgent."workspaceId" = ${id}
        LEFT JOIN "AgentEndpoint" endpoint ON endpoint.id = rootCtx."endpointId" AND endpoint."workspaceId" = ${id}
        ORDER BY ${sortColumn} DESC, f.id COLLATE "C" DESC, f.kind DESC`;
      const hasNext = rows.length > page.limit;
      if (hasNext) rows.pop();
      const last = hasNext ? rows.at(-1) : undefined;
      const nextCursor = last
        ? Buffer.from(
            JSON.stringify({
              id: last.id,
              kind: last.kind,
              filter: page.kind,
              sort: page.sort,
              value:
                page.sort === "size" ? last.size : last.createdAt.getTime(),
            }),
          ).toString("base64url")
        : null;
      const now = new Date();
      const workspaceBytes = Number(await workspaceStorageBytes(tx, id));
      let owner = null;
      if (workspace.ownerId === scope.actorUserId) {
        const overrides = await tx.user.findUniqueOrThrow({
          where: { id: workspace.ownerId },
          select: { storageQuotaBytes: true, maxOwnedWorkspaces: true },
        });
        const limits = await effectiveUserLimits(tx, overrides);
        owner = {
          usedBytes: Number(await ownedStorageBytes(tx, workspace.ownerId)),
          storageQuotaBytes: Number(limits.storageQuotaBytes),
        };
      }
      return {
        files: rows.map((row) =>
          projectFile(row, workspace, scope.actorUserId, now),
        ),
        nextCursor,
        usage: { workspaceBytes, owner },
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function deleteWorkspaceFile(
  scope: WorkspaceScope,
  file: WorkspaceFileRef,
): Promise<"deleted" | WorkspaceFileDeletionFailure> {
  const staged = await db.$transaction<
    | WorkspaceFileDeletionFailure
    | { id: string; workspaceId: string; storagePath: string }
  >(async (tx) => {
    const locked = await lockStorageWorkspace(tx, scope.id);
    if (locked?.status !== "active") return "not_found";
    await lockUserLimits(tx, locked.ownerId, scope.actorUserId);
    const currentScope = await resolveWorkspaceScope(
      { id: scope.id },
      scope.actorUserId,
      "read",
      tx,
    );
    if (!currentScope) return "not_found";
    const isOwner = currentScope.ownerId === currentScope.actorUserId;
    const result =
      file.kind === "attachment"
        ? await stageAttachmentDeletion(
            tx,
            workspaceScopeWhere(currentScope),
            file.id,
            isOwner ? undefined : currentScope.actorUserId,
          )
        : await stageWorkspaceTaskFileDeletion(
            tx,
            currentScope.id,
            file.id,
            isOwner,
          );
    if (typeof result === "string") return result;
    await writeAudit(tx, {
      actorId: currentScope.actorUserId,
      workspaceId: currentScope.id,
      action: "workspace.file.deleted",
      targetType:
        file.kind === "attachment" ? "WorkspaceAttachment" : "A2ATaskFile",
      targetId: file.id,
    });
    return result;
  });
  if (typeof staged === "string") return staged;
  try {
    // Delete physical data after committing the fence. If this fails or the
    // process exits, the existing sweepers still have the path and charge.
    if (file.kind === "attachment")
      await removeAttachmentPendingCleanup(staged);
    else await removeDeletedTaskFile(staged);
    return "deleted";
  } catch (error) {
    logSystemEvent("workspace.files.cleanup_failed", {
      error,
      level: "warn",
      workspaceId: scope.id,
      actorId: scope.actorUserId,
      attributes: { fileId: file.id, kind: file.kind },
    });
    return "storage_error";
  }
}
