import "server-only";
import { Prisma, type ChatTurn } from "@prisma/client";
import { createHash } from "node:crypto";
import { assertAssistantRemoteDeployment } from "@/lib/remote-mcp/classification";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { catalogToolNames } from "@/lib/process/mcp-grant-sync";
import {
  buildRevisionChangelogPage,
  diffRevisionMcpGrants,
  REVISION_CHANGELOG_PAGE_SIZE,
  revisionGrantsNewPermissions,
  type RevisionChangelogPage,
  type RevisionUpgradeDiff,
} from "@/lib/revisions/upgrade-diff";
import type { DeploymentForSpawn } from "@/lib/process/spawn-spec";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import {
  exposedMcpToolNames,
  sameToolNames,
} from "@/lib/workspace/mcp-tool-exposure";
import {
  ChatAssistantRevisionConfigSchema,
  type ChatAssistantRevisionConfig,
} from "./revision-types";
import { canonicalJson } from "@/lib/pi-packages/artifact";
import { chatExecutionProgressChunk } from "./execution-stage";
import { db } from "@/lib/db";
import {
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
} from "@/lib/attachments/messages";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import { inferModelPrimaryType } from "@/lib/agents/model-catalog";
import {
  chatBranchNavigation,
  chatMessagePath,
  latestChatBranchLeaf,
} from "./branches";
import type {
  CreateChatAssistantInput,
  CreateChatThreadInput,
  GenerateChatAssistantPromptInput,
  UpdateChatAssistantInput,
  UpdateChatThreadInput,
} from "./schemas";

export type ChatTurnAdmission = ChatTurn & {
  assistantMessageId: string;
  assistantParentId: string;
  historyLeafId: string;
  replayed: boolean;
};

export const CHAT_TURN_STALE_AFTER_MS = 5 * 60 * 1000;

const providerForClient = {
  select: { id: true, name: true, format: true, models: true },
} as const;

const grantForClient = {
  orderBy: { createdAt: "asc" as const },
  select: {
    deploymentId: true,
    allowedToolNames: true,
    deployment: {
      select: {
        id: true,
        name: true,
        source: true,
        status: true,
        server: {
          select: {
            name: true,
            slug: true,
            categories: { select: { slug: true } },
          },
        },
      },
    },
  },
} as const;

export class ChatServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export function requireChatRemoteDeployment(deployment: DeploymentForSpawn) {
  try {
    return assertAssistantRemoteDeployment(deployment);
  } catch {
    throw new ChatServiceError(
      400,
      "Assistants require a remote HTTP/SSE MCP connection, not a stdio gateway, local runtime, or Agent delegation endpoint",
    );
  }
}

type StoredChatMessage = {
  id: string;
  parentId: string | null;
  siblingGroupId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  parts: Prisma.JsonValue;
  createdAt: Date;
};

export type ChatBranchNode = {
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  modelId: string | null;
  createdAt: string;
  preview: string;
  active: boolean;
  awaitingInput: boolean;
};

function isAwaitingInput(message: Pick<StoredChatMessage, "role" | "parts">) {
  return (
    message.role === "user" &&
    Array.isArray(message.parts) &&
    message.parts.length === 0
  );
}

function projectActiveChatBranch<
  T extends { activeMessageId: string | null; messages: StoredChatMessage[] },
>(thread: T | null) {
  if (!thread) return null;
  const path = chatMessagePath(thread.messages, thread.activeMessageId);
  const activeIds = new Set(path.map((message) => message.id));
  const parentIds = new Set(
    thread.messages.flatMap((message) =>
      message.parentId ? [message.parentId] : [],
    ),
  );
  const leafCount = thread.messages.filter(
    (message) => !parentIds.has(message.id),
  ).length;
  return {
    ...thread,
    messages: path.filter((message) => !isAwaitingInput(message)),
    branch: {
      activeMessageId: path.at(-1)?.id ?? null,
      branchCount: leafCount,
      navigation: chatBranchNavigation(thread.messages, path),
      nodes: thread.messages.map<ChatBranchNode>((message) => ({
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        status: message.status,
        modelId: message.modelId,
        createdAt: message.createdAt.toISOString(),
        preview:
          messageTitle(
            Array.isArray(message.parts)
              ? (message.parts as Array<Record<string, unknown>>)
              : [],
          ) ?? (message.role === "user" ? "User message" : "Assistant message"),
        active: activeIds.has(message.id),
        awaitingInput: isAwaitingInput(message),
      })),
    },
  };
}

async function requireWorkspace(userId: string, workspaceId: string) {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) throw new ChatServiceError(404, "Workspace not found");
  return workspace;
}

async function withChatDeploymentLocks<T>(
  workspaceId: string,
  deploymentIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(deploymentIds)].sort();
  async function acquire(index: number): Promise<T> {
    const deploymentId = ordered[index];
    if (deploymentId === undefined) return operation();
    const result = await runMcpDeploymentOperation(
      workspaceId,
      deploymentId,
      () => acquire(index + 1),
    );
    if (!result.accepted)
      throw new ChatServiceError(409, "Workspace is draining");
    return result.value;
  }
  return acquire(0);
}

async function validateAssistantResources(
  workspaceId: string,
  input: Pick<UpdateChatAssistantInput, "modelProviderId" | "mcpGrants">,
) {
  if (input.modelProviderId) {
    const provider = await db.modelProvider.findFirst({
      where: { id: input.modelProviderId, workspaceId },
      select: { id: true },
    });
    if (!provider) throw new ChatServiceError(400, "Model provider not found");
  }

  const deploymentIds = input.mcpGrants?.map((grant) => grant.deploymentId);
  if (deploymentIds !== undefined) {
    const deployments = await db.deployment.findMany({
      where: {
        id: { in: deploymentIds },
        workspaceId,
        sandbox: { is: null },
        OR: [{ source: null }, { source: { not: "sandbox" } }],
      },
      select: {
        id: true,
        name: true,
        source: true,
        sourceRef: true,
        installCfg: true,
        serverId: true,
        server: { select: { name: true, slug: true, verifiedAt: true } },
      },
    });
    if (deployments.length !== new Set(deploymentIds).size) {
      throw new ChatServiceError(
        400,
        "One or more MCP deployments are invalid",
      );
    }
    const definitionChecksums: Record<string, string> = {};
    const grants = deployments.map((deployment) => {
      requireChatRemoteDeployment(deployment);
      const grant = input.mcpGrants?.find(
        (candidate) => candidate.deploymentId === deployment.id,
      );
      if (!grant) throw new ChatServiceError(400, "MCP grant is missing");
      const catalog = catalogToolNames(deployment.installCfg);
      definitionChecksums[deployment.id] = mcpDefinitionChecksum(deployment);
      return {
        deploymentId: deployment.id,
        allowedToolNames: catalog,
      };
    });
    return { grants, definitionChecksums };
  }
  return { grants: [], definitionChecksums: {} };
}

function revisionConfig(
  assistant: {
    systemPrompt: string | null;
    modelProviderId: string | null;
    model: string | null;
    modelParameters: unknown;
    maxSteps: number;
    mcpGrants: Array<{ deploymentId: string; allowedToolNames: string[] }>;
  },
  definitionChecksums: Readonly<Record<string, string>> = {},
) {
  return ChatAssistantRevisionConfigSchema.parse({
    schemaVersion: 1,
    systemPrompt: assistant.systemPrompt,
    modelProviderId: assistant.modelProviderId,
    model: assistant.model,
    modelParameters: assistant.modelParameters,
    maxSteps: assistant.maxSteps,
    mcpGrants: assistant.mcpGrants.map(
      ({ deploymentId, allowedToolNames }) => ({
        deploymentId,
        allowedToolNames,
        definitionChecksum: definitionChecksums[deploymentId],
      }),
    ),
  });
}

// Server Components call this after resolving an authorized workspace.
export async function listChatAssistantsForWorkspace(workspaceId: string) {
  return db.chatAssistant.findMany({
    where: { workspaceId },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      revisions: {
        orderBy: { version: "desc" },
        take: 2,
        select: { version: true, config: true },
      },
      threads: {
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          assistantRevisionId: true,
          legacyRevisionUnresolved: true,
          assistantRevision: { select: { version: true } },
          createdAt: true,
          updatedAt: true,
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, role: true, parts: true, createdAt: true },
          },
        },
      },
    },
  });
}

export async function listChatAssistantsForUser(
  userId: string,
  workspaceId: string,
) {
  await requireWorkspace(userId, workspaceId);
  return listChatAssistantsForWorkspace(workspaceId);
}

export async function listRunningChatThreadIds(
  userId: string,
  workspaceId: string,
) {
  await requireWorkspace(userId, workspaceId);
  const turns = await db.chatTurn.findMany({
    where: {
      thread: { workspaceId },
      status: "pending",
      OR: [
        { leaseExpiresAt: { gt: new Date() } },
        {
          leaseToken: null,
          createdAt: { gte: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS) },
        },
      ],
    },
    select: { threadId: true },
  });
  return turns.map((turn) => turn.threadId);
}

export async function getChatAssistantForWorkspace(
  workspaceId: string,
  assistantId: string,
) {
  return db.chatAssistant.findFirst({
    where: { id: assistantId, workspaceId },
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      threads: {
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
}

export async function getChatAssistantForUser(
  userId: string,
  assistantId: string,
) {
  return db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    include: {
      modelProvider: providerForClient,
      mcpGrants: grantForClient,
      threads: {
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      },
    },
  });
}

export async function getChatTurnReplay(
  userId: string,
  threadId: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const turn = await db.chatTurn.findFirst({
    where: {
      threadId,
      idempotencyKey,
      thread: {
        workspace: {
          status: "active",
          OR: [
            { ownerId: userId, owner: { status: "active" } },
            { members: { some: { userId, user: { status: "active" } } } },
          ],
        },
      },
    },
    include: { thread: { select: { workspaceId: true } } },
  });
  if (!turn) return null;
  if (turn.actorUserId !== userId)
    throw new ChatServiceError(
      403,
      "This idempotency key belongs to another user",
    );
  if (turn.requestHash !== requestHash)
    throw new ChatServiceError(
      409,
      "Idempotency key was already used for a different request",
    );
  if (
    turn.status === "pending" &&
    !turn.startedAt &&
    !turn.leaseToken &&
    !turn.stopRequestedAt
  )
    return null;
  return { runId: turn.id, workspaceId: turn.thread.workspaceId };
}

export async function createChatAssistant(
  userId: string,
  input: CreateChatAssistantInput,
) {
  await requireWorkspace(userId, input.workspaceId);
  return withChatDeploymentLocks(
    input.workspaceId,
    (input.mcpGrants ?? []).map((grant) => grant.deploymentId),
    async () => {
      const { definitionChecksums, grants } = await validateAssistantResources(
        input.workspaceId,
        input,
      );
      const data = {
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt ?? null,
        modelProviderId: input.modelProviderId ?? null,
        model: input.model ?? null,
        modelParameters: input.modelParameters
          ? (input.modelParameters as Prisma.InputJsonValue)
          : Prisma.DbNull,
        maxSteps: input.maxSteps ?? AGENT_STEP_BOUNDS.default,
        mcpGrants: {
          create: grants,
        },
      };
      return db.$transaction(async (tx) => {
        const assistant = await tx.chatAssistant.create({
          data,
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
        await tx.chatAssistantRevision.create({
          data: {
            assistantId: assistant.id,
            version: 1,
            config: revisionConfig(
              assistant,
              definitionChecksums,
            ) as Prisma.InputJsonValue,
          },
        });
        const published = await tx.chatAssistant.update({
          where: { id: assistant.id },
          data: { currentRevisionVersion: 1 },
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
        return published;
      });
    },
  );
}

export async function updateChatAssistant(
  userId: string,
  assistantId: string,
  input: UpdateChatAssistantInput,
) {
  const assistant = await db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    include: {
      mcpGrants: true,
      revisions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!assistant) throw new ChatServiceError(404, "Chat assistant not found");
  if (assistant.currentRevisionVersion !== input.expectedRevision)
    throw new ChatServiceError(
      409,
      "Assistant revision changed; reload before publishing",
    );
  // Name, description and pin state are not part of the executable revision; changing them
  // must not make existing conversations look outdated.
  const changesRevision =
    input.systemPrompt !== undefined ||
    input.modelProviderId !== undefined ||
    input.model !== undefined ||
    input.modelParameters !== undefined ||
    input.maxSteps !== undefined ||
    input.mcpGrants !== undefined;
  if (!changesRevision) {
    const access = {
      status: "active" as const,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    };
    const claimed = await db.chatAssistant.updateMany({
      where: {
        id: assistantId,
        currentRevisionVersion: input.expectedRevision,
        workspace: access,
      },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
    });
    if (claimed.count !== 1)
      throw new ChatServiceError(
        409,
        "Assistant revision changed; reload before publishing",
      );
    const updated = await db.chatAssistant.findFirst({
      where: { id: assistantId, workspace: access },
      include: { modelProvider: providerForClient, mcpGrants: grantForClient },
    });
    if (!updated) throw new ChatServiceError(404, "Chat assistant not found");
    return updated;
  }
  const grantsToPublish = input.mcpGrants ?? assistant.mcpGrants;
  return withChatDeploymentLocks(
    assistant.workspaceId,
    [...assistant.mcpGrants, ...grantsToPublish].map(
      (grant) => grant.deploymentId,
    ),
    async () => {
      const { definitionChecksums, grants } = await validateAssistantResources(
        assistant.workspaceId,
        { ...input, mcpGrants: grantsToPublish },
      );

      return db.$transaction(async (tx) => {
        const claimed = await tx.chatAssistant.updateMany({
          where: {
            id: assistantId,
            currentRevisionVersion: input.expectedRevision,
            workspace: {
              status: "active",
              OR: [{ ownerId: userId }, { members: { some: { userId } } }],
            },
          },
          data: { currentRevisionVersion: input.expectedRevision },
        });
        if (claimed.count !== 1)
          throw new ChatServiceError(
            409,
            "Assistant revision changed; reload before publishing",
          );
        if (input.mcpGrants !== undefined) {
          await tx.chatAssistantMcpGrant.deleteMany({ where: { assistantId } });
          if (grants.length)
            await tx.chatAssistantMcpGrant.createMany({
              data: grants.map((grant) => ({ assistantId, ...grant })),
            });
        }
        const updated = await tx.chatAssistant.update({
          where: { id: assistantId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.systemPrompt !== undefined
              ? { systemPrompt: input.systemPrompt }
              : {}),
            ...(input.modelProviderId !== undefined
              ? {
                  modelProviderId: input.modelProviderId,
                  ...(input.modelProviderId === null &&
                  input.model === undefined
                    ? { model: null }
                    : {}),
                }
              : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.modelParameters !== undefined
              ? {
                  modelParameters: input.modelParameters
                    ? (input.modelParameters as Prisma.InputJsonValue)
                    : Prisma.DbNull,
                }
              : {}),
            ...(input.maxSteps !== undefined
              ? { maxSteps: input.maxSteps }
              : {}),
          },
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
        await tx.chatAssistantRevision.create({
          data: {
            assistantId,
            version: input.expectedRevision + 1,
            config: revisionConfig(
              updated,
              definitionChecksums,
            ) as Prisma.InputJsonValue,
          },
        });
        return tx.chatAssistant.update({
          where: { id: assistantId },
          data: { currentRevisionVersion: input.expectedRevision + 1 },
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
      });
    },
  );
}

/**
 * Follow MCP catalog, exposure and connection changes for grants the current
 * assistant revision holds by publishing the next revision with only those
 * grants refreshed. Returns the new version, or null when already current.
 */
export async function refreshAssistantRevisionMcpGrants(assistantId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ChatAssistant" WHERE id=${assistantId} FOR UPDATE`;
    const assistant = await tx.chatAssistant.findUnique({
      where: { id: assistantId },
      select: {
        currentRevisionVersion: true,
        mcpGrants: { include: { deployment: true } },
      },
    });
    if (!assistant?.currentRevisionVersion) return null;
    const current = await tx.chatAssistantRevision.findUnique({
      where: {
        assistantId_version: {
          assistantId,
          version: assistant.currentRevisionVersion,
        },
      },
    });
    if (!current) return null;
    const applied = ChatAssistantRevisionConfigSchema.parse(current.config);
    let stale = false;
    const mcpGrants = applied.mcpGrants.map((grant) => {
      const live = assistant.mcpGrants.find(
        (entry) => entry.deploymentId === grant.deploymentId,
      );
      // A removed grant is a revocation; runtime already narrows it.
      if (!live) return grant;
      const next = {
        deploymentId: grant.deploymentId,
        definitionChecksum: mcpDefinitionChecksum(live.deployment),
        allowedToolNames: exposedMcpToolNames(
          live.deployment,
          live.allowedToolNames,
        ),
      };
      if (
        next.definitionChecksum !== grant.definitionChecksum ||
        !sameToolNames(next.allowedToolNames, grant.allowedToolNames)
      )
        stale = true;
      return next;
    });
    if (!stale) return null;
    const version = assistant.currentRevisionVersion + 1;
    await tx.chatAssistantRevision.create({
      data: {
        assistantId,
        version,
        config: ChatAssistantRevisionConfigSchema.parse({
          ...applied,
          mcpGrants,
        }) as Prisma.InputJsonValue,
      },
    });
    await tx.chatAssistant.update({
      where: { id: assistantId },
      data: { currentRevisionVersion: version },
    });
    return { version };
  });
}

export async function copyChatAssistant(
  userId: string,
  assistantId: string,
  input: {
    name: string;
    expectedRevision: number;
    mcpGrants: NonNullable<CreateChatAssistantInput["mcpGrants"]>;
  },
) {
  const source = await getChatAssistantForUser(userId, assistantId);
  if (!source) throw new ChatServiceError(404, "Chat assistant not found");
  return withChatDeploymentLocks(
    source.workspaceId,
    input.mcpGrants.map((grant) => grant.deploymentId),
    async () => {
      const { definitionChecksums, grants } = await validateAssistantResources(
        source.workspaceId,
        { mcpGrants: input.mcpGrants },
      );
      return db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${assistantId} FOR UPDATE`,
        );
        const current = await tx.chatAssistant.findFirst({
          where: {
            id: assistantId,
            currentRevisionVersion: input.expectedRevision,
            workspace: {
              status: "active",
              OR: [{ ownerId: userId }, { members: { some: { userId } } }],
            },
          },
          include: {
            revisions: { where: { version: input.expectedRevision }, take: 1 },
          },
        });
        if (!current?.revisions[0])
          throw new ChatServiceError(
            409,
            "Assistant revision changed or is unresolved; reload before copying",
          );
        const config = ChatAssistantRevisionConfigSchema.parse(
          current.revisions[0].config,
        );
        const copy = await tx.chatAssistant.create({
          data: {
            workspaceId: current.workspaceId,
            name: input.name,
            description: current.description,
            systemPrompt: config.systemPrompt,
            modelProviderId: config.modelProviderId,
            model: config.model,
            modelParameters: config.modelParameters
              ? (config.modelParameters as Prisma.InputJsonValue)
              : Prisma.DbNull,
            maxSteps: config.maxSteps,
            mcpGrants: {
              create: grants,
            },
          },
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
        await tx.chatAssistantRevision.create({
          data: {
            assistantId: copy.id,
            version: 1,
            config: {
              ...config,
              mcpGrants: grants.map(({ deploymentId, allowedToolNames }) => ({
                deploymentId,
                allowedToolNames,
                definitionChecksum: definitionChecksums[deploymentId],
              })),
            } as Prisma.InputJsonValue,
          },
        });
        return tx.chatAssistant.update({
          where: { id: copy.id },
          data: { currentRevisionVersion: 1 },
          include: {
            modelProvider: providerForClient,
            mcpGrants: grantForClient,
          },
        });
      });
    },
  );
}

export async function getChatPromptGenerationModel(
  userId: string,
  input: Pick<
    GenerateChatAssistantPromptInput,
    "workspaceId" | "modelProviderId"
  >,
) {
  await requireWorkspace(userId, input.workspaceId);
  const provider = await db.modelProvider.findFirst({
    where: { id: input.modelProviderId, workspaceId: input.workspaceId },
  });
  if (!provider) throw new ChatServiceError(400, "Model provider not found");
  return provider;
}

async function assertChatRunsDeletable(
  tx: Prisma.TransactionClient,
  where: Prisma.ChatTurnWhereInput,
) {
  // Call only after locking every scoped thread; admission takes the same row lock.
  const unresolved = await tx.chatTurn.findFirst({
    where: {
      ...where,
      OR: [
        { status: "pending" },
        {
          confirmations: {
            some: { status: { in: ["executing", "execution_unknown"] } },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (unresolved)
    throw new ChatServiceError(
      409,
      "Cannot delete conversation records while a Run is active or an external tool outcome remains unresolved",
    );
}

export async function deleteChatAssistant(userId: string, assistantId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${assistantId} FOR UPDATE`,
    );
    const assistant = await tx.chatAssistant.findFirst({
      where: {
        id: assistantId,
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
      select: {
        id: true,
      },
    });
    if (!assistant) throw new ChatServiceError(404, "Chat assistant not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "assistantId" = ${assistantId} ORDER BY "id" FOR UPDATE`,
    );
    await assertChatRunsDeletable(tx, { thread: { assistantId } });
    await tx.chatAssistant.delete({ where: { id: assistant.id } });
  });
}

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
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
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
  workspaceId: string,
  assistantId: string,
  threadId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, workspaceId, assistantId },
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
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
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
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
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
    return tx.chatThread.update({
      where: { id: threadId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.activeMessageId !== undefined ? { activeMessageId } : {}),
      },
    });
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
      workspace: {
        status: "active",
        OR: [
          { ownerId: userId, owner: { status: "active" } },
          { members: { some: { userId, user: { status: "active" } } } },
        ],
      },
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
      workspace: {
        status: "active",
        OR: [
          { ownerId: userId, owner: { status: "active" } },
          { members: { some: { userId, user: { status: "active" } } } },
        ],
      },
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
        workspace: {
          status: "active",
          OR: [
            { ownerId: userId, owner: { status: "active" } },
            { members: { some: { userId, user: { status: "active" } } } },
          ],
        },
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
    const thread = await tx.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      select: {
        assistantId: true,
        assistantRevisionId: true,
        legacyRevisionUnresolved: true,
      },
    });
    if (thread.legacyRevisionUnresolved || !thread.assistantRevisionId)
      throw new ChatServiceError(
        409,
        "Legacy conversation revision is unresolved",
      );
    const assistant = await tx.chatAssistant.findUniqueOrThrow({
      where: { id: thread.assistantId },
      select: { currentRevisionVersion: true },
    });
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
    await tx.chatThread.update({
      where: { id: threadId },
      data: { assistantRevisionId: target.id },
    });
    return { thread: { id: threadId } };
  });
}

export async function reserveChatBranch(
  userId: string,
  threadId: string,
  anchorMessageId: string,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        activeMessageId: true,
        turns: {
          where: {
            status: "pending",
            createdAt: { gte: new Date(Date.now() - CHAT_TURN_STALE_AFTER_MS) },
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");

    const anchor = await tx.chatMessage.findFirst({
      where: { id: anchorMessageId, threadId, role: "assistant" },
      select: {
        id: true,
        children: {
          where: { role: "user" },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!anchor)
      throw new ChatServiceError(
        400,
        "A branch must start from an assistant message",
      );

    const turn = await tx.chatTurn.create({
      data: { threadId, status: "completed", completedAt: new Date() },
    });
    const reservations = [];
    const reservationCount = anchor.children.length ? 1 : 2;
    for (let index = 0; index < reservationCount; index += 1) {
      reservations.push(
        await tx.chatMessage.create({
          data: {
            threadId,
            turnId: turn.id,
            parentId: anchor.id,
            role: "user",
            parts: [] as Prisma.InputJsonValue,
          },
        }),
      );
    }

    const reservation = reservations.at(-1);
    if (!reservation)
      throw new Error("Chat branch reservation is unavailable.");
    const activated = thread.turns.length === 0;
    const activeMessageId = activated ? reservation.id : thread.activeMessageId;
    await tx.chatThread.update({
      where: { id: threadId },
      data: { activeMessageId, updatedAt: new Date() },
    });
    return { messages: reservations, activeMessageId, activated };
  });
}

export async function deleteReservedChatBranch(
  userId: string,
  threadId: string,
  messageId: string,
) {
  return db.$transaction(async (tx) => {
    const authorized = await tx.chatThread.findFirst({
      where: {
        id: threadId,
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
      select: { id: true },
    });
    if (!authorized) throw new ChatServiceError(404, "Chat thread not found");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
    );
    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: { id: true, activeMessageId: true },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");

    const message = await tx.chatMessage.findFirst({
      where: { id: messageId, threadId },
      select: {
        id: true,
        parentId: true,
        role: true,
        parts: true,
        children: { take: 1, select: { id: true } },
      },
    });
    if (
      message?.role !== "user" ||
      !Array.isArray(message.parts) ||
      message.parts.length > 0 ||
      message.children.length > 0
    ) {
      throw new ChatServiceError(400, "Only an empty branch can be deleted");
    }

    await tx.chatMessage.delete({ where: { id: message.id } });
    const activeMessageId =
      thread.activeMessageId === message.id
        ? message.parentId
        : thread.activeMessageId;
    await tx.chatThread.update({
      where: { id: threadId },
      data: { activeMessageId, updatedAt: new Date() },
    });
    return { activeMessageId };
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
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
      select: { id: true },
    });
    if (!thread) throw new ChatServiceError(404, "Chat thread not found");
    await assertChatRunsDeletable(tx, { threadId });
    const result = await tx.chatThread.deleteMany({
      where: {
        id: threadId,
        workspace: {
          status: "active",
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
      },
    });
    if (!result.count) throw new ChatServiceError(404, "Chat thread not found");
  });
}

export async function getChatThreadForExecution(
  userId: string,
  threadId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    include: {
      assistant: {
        // Execution below replaces mutable configuration with the pinned snapshot.
        include: {
          modelProvider: true,
          mcpGrants: {
            where: {
              deployment: {
                sandbox: { is: null },
                OR: [{ source: null }, { source: { not: "sandbox" } }],
              },
            },
            select: {
              deploymentId: true,
              allowedToolNames: true,
              deployment: {
                select: {
                  sourceRef: true,
                  name: true,
                  source: true,
                  installCfg: true,
                  serverId: true,
                  server: {
                    select: {
                      name: true,
                      categories: { select: { slug: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      assistantRevision: true,
    },
  });
  if (!thread) return null;
  if (thread.legacyRevisionUnresolved || !thread.assistantRevision)
    throw new ChatServiceError(
      409,
      "Historical Assistant revision is unresolved; history is read-only. Create a new thread to execute.",
    );
  const config = ChatAssistantRevisionConfigSchema.parse(
    thread.assistantRevision.config,
  );

  const modelProvider = config.modelProviderId
    ? await db.modelProvider.findFirst({
        where: { id: config.modelProviderId, workspaceId: thread.workspaceId },
      })
    : null;
  const grants = thread.assistant.mcpGrants.flatMap((grant) => {
    const approved = config.mcpGrants.find(
      (candidate) => candidate.deploymentId === grant.deploymentId,
    );
    if (!approved) return [];
    requireChatRemoteDeployment(grant.deployment);
    if (mcpDefinitionChecksum(grant.deployment) !== approved.definitionChecksum)
      throw new ChatServiceError(
        409,
        "Pinned MCP connection changed; publish a new Assistant revision and create a new thread",
      );
    return [
      {
        ...grant,
        allowedToolNames: approved.allowedToolNames.filter((name) =>
          grant.allowedToolNames.includes(name),
        ),
      },
    ];
  });
  return projectActiveChatBranch({
    ...thread,
    assistant: {
      ...thread.assistant,
      ...config,
      modelProvider,
      mcpGrants: grants,
    },
    revisionConfig: config,
  });
}

/** Resolve a turn-local model without rebinding the thread's immutable revision. */
export async function resolveChatTurnModel(
  workspaceId: string,
  selection: { providerId: string; model: string },
  requirements: { tools: boolean; reasoning: boolean; modalities: string[] },
) {
  const provider = await db.modelProvider.findFirst({
    where: { id: selection.providerId, workspaceId },
    include: { modelRecords: true },
  });
  if (!provider?.apiKey.trim())
    throw new ChatServiceError(400, "CHAT_MODEL_PROVIDER_UNAVAILABLE");
  if (!provider.models.includes(selection.model))
    throw new ChatServiceError(400, "CHAT_MODEL_NOT_AVAILABLE");
  const record = provider.modelRecords.find(
    (model) => model.modelId === selection.model,
  );
  if (
    (record?.primaryType ?? inferModelPrimaryType(selection.model)) !==
      "text" ||
    (record &&
      ((requirements.tools &&
        !record.capabilities.includes("function_calling")) ||
        (requirements.reasoning &&
          !record.capabilities.includes("reasoning")) ||
        requirements.modalities.some(
          (modality) => !record.inputModalities.includes(modality),
        )))
  )
    throw new ChatServiceError(400, "CHAT_MODEL_CAPABILITY_UNSUPPORTED");
  return { provider, modelId: selection.model };
}

function preserveChatModelPart(
  saved: Prisma.JsonValue,
  parts: Array<Record<string, unknown>>,
) {
  const modelPart = Array.isArray(saved)
    ? saved.find(
        (part) =>
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          part.type === "data-model",
      )
    : undefined;
  return modelPart && !parts.some((part) => part.type === "data-model")
    ? [modelPart, ...parts]
    : parts;
}

function messageTitle(parts: Array<Record<string, unknown>>): string | null {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  return text ? text.slice(0, 80) : null;
}

export async function beginChatTurn(
  threadId: string,
  parts: Array<Record<string, unknown>>,
  attachmentOwner: { workspaceId: string; userId: string },
  request: {
    trigger?: "submit-message" | "regenerate-message";
    messageId?: string;
    clientLastMessageId?: string;
    modelId?: string;
    modelProviderId?: string;
    expectedAssistantId?: string;
    expectedAssistantRevisionId?: string;
    idempotencyKey?: string;
    requestHash?: string;
  } = {},
): Promise<ChatTurnAdmission> {
  const trigger = request.trigger ?? "submit-message";
  const attachmentIds =
    trigger === "submit-message" ? attachmentIdsFromParts(parts) : [];
  const authorizedThread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspaceId: attachmentOwner.workspaceId,
      workspace: {
        status: "active",
        OR: [
          { ownerId: attachmentOwner.userId },
          { members: { some: { userId: attachmentOwner.userId } } },
        ],
      },
    },
    select: { id: true },
  });
  if (!authorizedThread)
    throw new ChatServiceError(404, "Chat thread not found");

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`,
      );
      const thread = await tx.chatThread.findUnique({
        where: { id: threadId },
        select: {
          activeMessageId: true,
          assistantId: true,
          title: true,
          workspaceId: true,
          assistantRevisionId: true,
          legacyRevisionUnresolved: true,
        },
      });
      if (!thread || thread.workspaceId !== attachmentOwner.workspaceId) {
        throw new ChatServiceError(404, "Chat thread not found");
      }
      if (thread.legacyRevisionUnresolved || !thread.assistantRevisionId)
        throw new ChatServiceError(
          409,
          "Historical configuration is unresolved; create a new thread",
        );
      const idempotencyKey = request.idempotencyKey;
      if (!idempotencyKey)
        throw new ChatServiceError(400, "An idempotency key is required");
      const requestHash =
        request.requestHash ??
        createHash("sha256")
          .update(
            canonicalJson({
              parts,
              trigger,
              messageId: request.messageId ?? null,
              modelId: request.modelId ?? null,
              modelProviderId: request.modelProviderId ?? null,
            }),
          )
          .digest("hex");
      const existing = await tx.chatTurn.findFirst({
        where: { threadId, idempotencyKey },
        include: { messages: { where: { role: "assistant" }, take: 1 } },
      });
      if (existing) {
        if (
          existing.actorUserId !== attachmentOwner.userId ||
          existing.requestHash !== requestHash
        )
          throw new ChatServiceError(
            409,
            "Idempotency key was used for a different request",
          );
        const message = existing.messages[0];
        if (!message?.parentId)
          throw new ChatServiceError(409, "Run snapshot is unavailable");
        return {
          ...existing,
          assistantMessageId: message.id,
          assistantParentId: message.parentId,
          historyLeafId: message.parentId,
          replayed: true,
        };
      }
      if (
        await tx.chatTurn.findFirst({
          where: { threadId, status: "pending" },
          select: { id: true },
        })
      )
        throw new ChatServiceError(409, "A chat turn is already running");

      if (
        request.expectedAssistantId &&
        thread.assistantId !== request.expectedAssistantId
      ) {
        throw new ChatServiceError(
          409,
          "Chat assistant changed; retry the message",
        );
      }
      if (
        request.expectedAssistantRevisionId &&
        thread.assistantRevisionId !== request.expectedAssistantRevisionId
      )
        throw new ChatServiceError(
          409,
          "Chat revision changed; retry the message",
        );

      const targetId =
        request.messageId ??
        (trigger === "regenerate-message"
          ? request.clientLastMessageId
          : undefined);
      const target = targetId
        ? await tx.chatMessage.findFirst({
            where: { id: targetId, threadId },
            select: {
              id: true,
              parentId: true,
              siblingGroupId: true,
              turnId: true,
              role: true,
              status: true,
              parts: true,
            },
          })
        : null;
      if (targetId && !target)
        throw new ChatServiceError(404, "Chat message not found");

      const turn = await tx.chatTurn.create({
        data: {
          threadId,
          idempotencyKey,
          requestHash,
          actorUserId: attachmentOwner.userId,
          assistantRevisionId: thread.assistantRevisionId,
        },
      });
      let assistantParentId: string;
      let historyLeafId: string;
      let assistantMessageId: string;

      if (trigger === "regenerate-message") {
        if (
          !target ||
          (target.role !== "assistant" && target.role !== "user")
        ) {
          throw new ChatServiceError(
            400,
            "A user or assistant message is required for regeneration",
          );
        }
        assistantParentId =
          target.role === "assistant" ? (target.parentId ?? "") : target.id;
        if (!assistantParentId)
          throw new ChatServiceError(
            400,
            "The selected message cannot be regenerated",
          );
        historyLeafId = assistantParentId;

        {
          let siblingGroupId =
            target.role === "assistant"
              ? (target.siblingGroupId ?? turn.id)
              : null;
          if (target.role === "assistant" && !target.siblingGroupId) {
            await tx.chatMessage.update({
              where: { id: target.id },
              data: { siblingGroupId },
            });
          } else if (target.role === "user") {
            const assistantSiblings = await tx.chatMessage.findMany({
              where: { threadId, parentId: target.id, role: "assistant" },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true, siblingGroupId: true },
            });
            if (assistantSiblings.length) {
              siblingGroupId =
                assistantSiblings.find((message) => message.siblingGroupId)
                  ?.siblingGroupId ?? turn.id;
              await tx.chatMessage.updateMany({
                where: {
                  id: { in: assistantSiblings.map((message) => message.id) },
                  siblingGroupId: null,
                },
                data: { siblingGroupId },
              });
            }
          }
          const assistantMessage = await tx.chatMessage.create({
            data: {
              threadId,
              turnId: turn.id,
              parentId: assistantParentId,
              siblingGroupId,
              role: "assistant",
              status: "pending",
              modelId: request.modelId ?? null,
              parts:
                request.modelProviderId && request.modelId
                  ? [
                      {
                        type: "data-model",
                        data: {
                          providerId: request.modelProviderId,
                          model: request.modelId,
                        },
                      },
                    ]
                  : [],
            },
          });
          assistantMessageId = assistantMessage.id;
        }
      } else {
        if (request.messageId && target?.role !== "user") {
          throw new ChatServiceError(
            400,
            "Only user messages can be edited and resent",
          );
        }
        await claimWorkspaceAttachments(tx, {
          ids: attachmentIds,
          workspaceId: attachmentOwner.workspaceId,
          uploadedById: attachmentOwner.userId,
          scope: { chatThreadId: threadId },
        });
        const activePlaceholder =
          !target && thread.activeMessageId
            ? await tx.chatMessage.findFirst({
                where: {
                  id: thread.activeMessageId,
                  threadId,
                  role: "user",
                  parts: { equals: [] },
                },
                select: { id: true },
              })
            : null;
        let userMessage: { id: string };
        if (activePlaceholder) {
          userMessage = await tx.chatMessage.update({
            where: { id: activePlaceholder.id },
            data: {
              turnId: turn.id,
              status: "success",
              parts: parts as Prisma.InputJsonValue,
            },
          });
        } else {
          const siblingGroupId = target
            ? (target.siblingGroupId ?? turn.id)
            : null;
          if (target && !target.siblingGroupId) {
            await tx.chatMessage.update({
              where: { id: target.id },
              data: { siblingGroupId },
            });
          }
          userMessage = await tx.chatMessage.create({
            data: {
              threadId,
              turnId: turn.id,
              parentId: target ? target.parentId : thread.activeMessageId,
              siblingGroupId,
              role: "user",
              parts: parts as Prisma.InputJsonValue,
            },
          });
        }
        assistantParentId = userMessage.id;
        historyLeafId = userMessage.id;
        const assistantMessage = await tx.chatMessage.create({
          data: {
            threadId,
            turnId: turn.id,
            parentId: assistantParentId,
            role: "assistant",
            status: "pending",
            modelId: request.modelId ?? null,
            parts:
              request.modelProviderId && request.modelId
                ? [
                    {
                      type: "data-model",
                      data: {
                        providerId: request.modelProviderId,
                        model: request.modelId,
                      },
                    },
                  ]
                : [],
          },
        });
        assistantMessageId = assistantMessage.id;
      }

      await tx.chatRunEvent.create({
        data: {
          turnId: turn.id,
          generation: turn.generation,
          sequence: 1,
          payload: chatExecutionProgressChunk(turn.id, "queued", 1),
        },
      });

      await tx.chatThread.update({
        where: { id: threadId },
        data: {
          activeMessageId: assistantMessageId,
          updatedAt: new Date(),
          ...(!thread.title && trigger === "submit-message"
            ? { title: conversationTitleFromParts(parts) }
            : {}),
        },
      });
      return {
        ...turn,
        assistantMessageId,
        assistantParentId,
        historyLeafId,
        replayed: false,
      };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new ChatServiceError(409, "A chat turn is already running");
    }
    throw error;
  }
}

export async function getChatHistoryForExecution(
  userId: string,
  threadId: string,
  leafMessageId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    select: {
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          parentId: true,
          role: true,
          parts: true,
          createdAt: true,
        },
      },
    },
  });
  if (!thread) throw new ChatServiceError(404, "Chat thread not found");
  const path = chatMessagePath(thread.messages, leafMessageId);
  if (path.at(-1)?.id !== leafMessageId)
    throw new ChatServiceError(404, "Chat message not found");
  return path;
}

export async function completeChatTurn(
  threadId: string,
  turnId: string,
  assistantMessageId: string,
  parts: Array<Record<string, unknown>>,
  fence?: { leaseToken: string; generation: number },
) {
  return db.$transaction(async (tx) => {
    const updated = await tx.chatTurn.updateMany({
      where: {
        id: turnId,
        threadId,
        status: "pending",
        ...(fence
          ? { ...fence, leaseExpiresAt: { gt: new Date() } }
          : { leaseToken: null }),
      },
      data: { status: "completed", error: null, completedAt: new Date() },
    });
    if (!updated.count) return false;
    const persisted = await tx.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
      select: {
        generation: true,
        lastEventSequence: true,
        stopRequestedAt: true,
      },
    });
    if (persisted.stopRequestedAt)
      await tx.chatTurn.update({
        where: { id: turnId },
        data: { status: "cancelled" },
      });
    const savedMessage = await tx.chatMessage.findUniqueOrThrow({
      where: { id: assistantMessageId },
      select: { parts: true },
    });
    const message = await tx.chatMessage.updateMany({
      where: {
        id: assistantMessageId,
        threadId,
        turnId,
        role: "assistant",
        status: "pending",
      },
      data: {
        status: persisted.stopRequestedAt ? "cancelled" : "success",
        parts: preserveChatModelPart(
          savedMessage.parts,
          parts,
        ) as Prisma.InputJsonValue,
      },
    });
    if (message.count !== 1)
      throw new ChatServiceError(409, "Chat response is no longer pending");
    await tx.chatThread.updateMany({
      where: { id: threadId, activeMessageId: assistantMessageId },
      data: { updatedAt: new Date() },
    });
    await tx.chatRunEvent.create({
      data: {
        turnId,
        generation: persisted.generation,
        sequence: persisted.lastEventSequence + 1,
        payload: persisted.stopRequestedAt
          ? { type: "abort" }
          : { type: "finish" },
      },
    });
    return true;
  });
}

export async function finishChatTurn(
  threadId: string,
  turnId: string,
  status: "failed" | "cancelled",
  error?: string,
  assistantMessageId?: string,
  parts?: Array<Record<string, unknown>>,
  fence?: { leaseToken: string; generation: number },
) {
  return db.$transaction(async (tx) => {
    const turn = await tx.chatTurn.updateMany({
      where: {
        id: turnId,
        threadId,
        status: "pending",
        ...(fence
          ? { ...fence, leaseExpiresAt: { gt: new Date() } }
          : { leaseToken: null }),
      },
      data: {
        status,
        error: error?.slice(0, 500) ?? null,
        completedAt: new Date(),
      },
    });
    if (!turn.count) return false;
    const persisted = await tx.chatTurn.findUniqueOrThrow({
      where: { id: turnId },
      select: { generation: true, lastEventSequence: true },
    });
    if (assistantMessageId) {
      const savedMessage = await tx.chatMessage.findUniqueOrThrow({
        where: { id: assistantMessageId },
        select: { parts: true },
      });
      const message = await tx.chatMessage.updateMany({
        where: { id: assistantMessageId, threadId, turnId, status: "pending" },
        data: {
          status,
          ...(parts
            ? {
                parts: preserveChatModelPart(
                  savedMessage.parts,
                  parts,
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      if (message.count !== 1)
        throw new ChatServiceError(409, "Chat response is no longer pending");
    }
    await tx.chatRunEvent.create({
      data: {
        turnId,
        generation: persisted.generation,
        sequence: persisted.lastEventSequence + 1,
        payload:
          status === "cancelled"
            ? { type: "abort" }
            : {
                type: "error",
                errorText: error?.slice(0, 500) ?? "Chat turn failed",
              },
      },
    });
    return true;
  });
}
