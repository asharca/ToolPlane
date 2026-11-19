import "server-only";
import {
  workspaceAccessWhere,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { Prisma } from "@prisma/client";
import {
  buildRevisionChangelogPage,
  diffRevisionMcpGrants,
  REVISION_CHANGELOG_PAGE_SIZE,
  revisionGrantsNewPermissions,
  type RevisionChangelogPage,
  type RevisionUpgradeDiff,
} from "@/lib/revisions/upgrade-diff";
import {
  ChatAssistantRevisionConfigSchema,
  type ChatAssistantRevisionConfig,
} from "./revision-types";
import { canonicalJson } from "@/lib/pi-packages/artifact";
import { db } from "@/lib/db";
import { latestChatBranchLeaf } from "./branches";
import type { CreateChatThreadInput, UpdateChatThreadInput } from "./schemas";
import {
  providerForClient,
  grantForClient,
  ChatServiceError,
  projectActiveChatBranch,
  assertChatRunsDeletable,
} from "./shared";

export async function createChatThread(
  userId: string,
  assistantId: string,
  input: CreateChatThreadInput,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${assistantId} FOR UPDATE`,
    );
    const assistant = await tx.chatAssistant.findFirst({
      where: {
        id: assistantId,
        workspace: workspaceAccessWhere(userId),
      },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!assistant) throw new ChatServiceError(404, "Chat assistant not found");
    const revision = assistant.revisions[0];
    if (!revision || revision.version !== assistant.currentRevisionVersion)
      throw new ChatServiceError(
        409,
        "Publish an Assistant revision before creating a thread",
      );
    return tx.chatThread.create({
      data: {
        workspaceId: assistant.workspaceId,
        assistantId,
        assistantRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        title: input.title ?? null,
      },
    });
  });
}

// Server Components call this after resolving an authorized workspace.
export async function getChatThreadForWorkspace(
  scope: WorkspaceScope,
  assistantId: string,
  threadId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, workspace: workspaceScopeWhere(scope), assistantId },
    include: {
      assistant: {
        include: {
          modelProvider: providerForClient,
          mcpGrants: grantForClient,
        },
      },
      messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      assistantRevision: true,
      turns: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  return projectActiveChatBranch(thread);
}

export async function getChatThreadForUser(userId: string, threadId: string) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: workspaceAccessWhere(userId),
    },
    include: {
      assistant: {
        include: {
          modelProvider: providerForClient,
          mcpGrants: grantForClient,
        },
      },
      messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      turns: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  return projectActiveChatBranch(thread);
}

export async function updateChatThread(
  userId: string,
  threadId: string,
  input: UpdateChatThreadInput,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findFirst({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      select: {
        assistantId: true,
        id: true,
        workspaceId: true,
        messages: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            parentId: true,
            siblingGroupId: true,
            role: true,
          },
        },
      },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");
    if (input.assistantId !== undefined)
      throw new ChatServiceError(
        400,
        "A thread's Assistant and revision cannot be rebound; create a new thread",
      );
    const activeMessageId = input.activeMessageId
      ? latestChatBranchLeaf(thread.messages, input.activeMessageId)
      : null;
    if (input.activeMessageId && !activeMessageId) {
      throw new ChatServiceError(404, "Chat message not found");
    }
    const [updated] = await tx.chatThread.updateManyAndReturn({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.activeMessageId !== undefined ? { activeMessageId } : {}),
      },
    });
    if (!updated) throw new ChatServiceError(404, "Chat thread not found");
    return updated;
  });
}

function diffAssistantRevisionConfigs(
  from: { version: number; config: ChatAssistantRevisionConfig } | null,
  to: { version: number; config: ChatAssistantRevisionConfig },
  name: (deploymentId: string) => string | null,
): RevisionUpgradeDiff {
  const changedFields: RevisionUpgradeDiff["changedFields"] = [];
  if (from?.config.systemPrompt !== to.config.systemPrompt)
    changedFields.push("systemPrompt");
  if (
    from?.config.modelProviderId !== to.config.modelProviderId ||
    from?.config.model !== to.config.model
  )
    changedFields.push("model");
  if (
    canonicalJson(from?.config.modelParameters ?? null) !==
    canonicalJson(to.config.modelParameters)
  )
    changedFields.push("modelParameters");
  if (from?.config.maxSteps !== to.config.maxSteps)
    changedFields.push("maxSteps");
  if (
    (from?.config.reasoningEffort ?? null) !==
    (to.config.reasoningEffort ?? null)
  )
    changedFields.push("reasoningEffort");
  const mcp = diffRevisionMcpGrants(
    from?.config.mcpGrants ?? [],
    to.config.mcpGrants,
    name,
  );
  return {
    fromVersion: from?.version ?? null,
    toVersion: to.version,
    changedFields,
    ...mcp,
    skillsAdded: [],
    skillsRemoved: [],
    skillsUpdated: [],
    grantsNewPermissions: revisionGrantsNewPermissions(mcp),
  };
}

export async function previewChatThreadRevisionUpgrade(
  userId: string,
  threadId: string,
  targetVersion: number,
) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: workspaceAccessWhere(userId),
    },
    select: {
      assistantId: true,
      workspaceId: true,
      legacyRevisionUnresolved: true,
      assistant: { select: { currentRevisionVersion: true } },
      assistantRevision: { select: { version: true, config: true } },
    },
  });
  if (!thread) throw new ChatServiceError(404, "Chat thread not found");
  if (thread.legacyRevisionUnresolved || !thread.assistantRevision)
    throw new ChatServiceError(
      409,
      "Legacy conversation revision is unresolved",
    );
  if (targetVersion !== thread.assistant.currentRevisionVersion)
    throw new ChatServiceError(
      409,
      "Only the current Assistant revision can be applied",
    );
  const target = await db.chatAssistantRevision.findUnique({
    where: {
      assistantId_version: {
        assistantId: thread.assistantId,
        version: targetVersion,
      },
    },
    select: { version: true, config: true },
  });
  if (!target) throw new ChatServiceError(404, "Assistant revision not found");
  const from = thread.assistantRevision
    ? {
        version: thread.assistantRevision.version,
        config: ChatAssistantRevisionConfigSchema.parse(
          thread.assistantRevision.config,
        ),
      }
    : null;
  const deployments = await db.deployment.findMany({
    where: { workspaceId: thread.workspaceId },
    select: { id: true, name: true, server: { select: { name: true } } },
  });
  const names = new Map(
    deployments.map((entry) => [
      entry.id,
      entry.name || entry.server?.name || null,
    ]),
  );
  return diffAssistantRevisionConfigs(
    from,
    {
      version: target.version,
      config: ChatAssistantRevisionConfigSchema.parse(target.config),
    },
    (id) => names.get(id) ?? null,
  );
}

/** Newest first; each entry compares a revision with the one published before it. */
export async function listChatAssistantRevisionChangelog(
  userId: string,
  assistantId: string,
  beforeVersion?: number,
): Promise<RevisionChangelogPage> {
  const assistant = await db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: workspaceAccessWhere(userId),
    },
    select: { workspaceId: true, currentRevisionVersion: true },
  });
  if (!assistant) throw new ChatServiceError(404, "Chat assistant not found");
  const rows = await db.chatAssistantRevision.findMany({
    where: {
      assistantId,
      ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
    },
    orderBy: { version: "desc" },
    take: REVISION_CHANGELOG_PAGE_SIZE + 1,
    select: { version: true, config: true, createdAt: true },
  });
  const revisions = rows.map((row) => ({
    version: row.version,
    createdAt: row.createdAt,
    config: ChatAssistantRevisionConfigSchema.parse(row.config),
  }));
  const deployments = await db.deployment.findMany({
    where: {
      workspaceId: assistant.workspaceId,
      id: {
        in: [
          ...new Set(
            revisions.flatMap((revision) =>
              revision.config.mcpGrants.map((grant) => grant.deploymentId),
            ),
          ),
        ],
      },
    },
    select: { id: true, name: true, server: { select: { name: true } } },
  });
  const names = new Map(
    deployments.map((entry) => [
      entry.id,
      entry.name || entry.server?.name || null,
    ]),
  );
  return buildRevisionChangelogPage(
    assistant.currentRevisionVersion,
    revisions,
    (from, to) =>
      diffAssistantRevisionConfigs(from, to, (id) => names.get(id) ?? null),
  );
}

/** Upgrade the revision pin in place, serialized with turn admission on the thread row. */
export async function upgradeChatThreadRevision(
  userId: string,
  threadId: string,
  targetVersion: number,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { id: true, assistantId: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${authorized.assistantId} FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findFirst({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      select: {
        assistantId: true,
        assistantRevisionId: true,
        legacyRevisionUnresolved: true,
      },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");
    if (thread.legacyRevisionUnresolved || !thread.assistantRevisionId)
      throw new ChatServiceError(
        409,
        "Legacy conversation revision is unresolved",
      );
    const assistant = await tx.chatAssistant.findFirst({
      where: {
        id: thread.assistantId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { currentRevisionVersion: true },
    });
    if (!assistant) throw new ChatServiceError(404, "Chat assistant not found");
    if (targetVersion !== assistant.currentRevisionVersion)
      throw new ChatServiceError(
        409,
        "Only the current Assistant revision can be applied",
      );
    const active = await tx.chatTurn.findFirst({
      where: { threadId, status: "pending" },
      select: { id: true },
    });
    if (active)
      throw new ChatServiceError(
        409,
        "This conversation has a Run in progress; stop or wait for it before upgrading",
      );
    const target = await tx.chatAssistantRevision.findUnique({
      where: {
        assistantId_version: {
          assistantId: thread.assistantId,
          version: targetVersion,
        },
      },
      select: { id: true },
    });
    if (!target)
      throw new ChatServiceError(404, "Assistant revision not found");
    const updated = await tx.chatThread.updateMany({
      where: { id: threadId, workspace: workspaceAccessWhere(userId) },
      data: { assistantRevisionId: target.id },
    });
    if (!updated.count)
      throw new ChatServiceError(404, "Chat thread not found");
    return { thread: { id: threadId } };
  });
}

export async function deleteChatThread(userId: string, threadId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
      select: { id: true },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");
    await assertChatRunsDeletable(tx, { threadId });
    const result = await tx.chatThread.deleteMany({
      where: {
        id: threadId,
        workspace: workspaceAccessWhere(userId),
      },
    });
    if (!result.count) throw new ChatServiceError(404, "Chat thread not found");
  });
}
