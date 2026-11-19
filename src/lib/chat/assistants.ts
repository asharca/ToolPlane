import "server-only";
import {
  workspaceAccessWhere,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { Prisma } from "@prisma/client";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { catalogToolNames } from "@/lib/process/mcp-grant-sync";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import {
  exposedMcpToolNames,
  sameToolNames,
} from "@/lib/workspace/mcp-tool-exposure";
import { ChatAssistantRevisionConfigSchema } from "./revision-types";
import { db } from "@/lib/db";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import type {
  CreateChatAssistantInput,
  GenerateChatAssistantPromptInput,
  UpdateChatAssistantInput,
} from "./schemas";
import {
  providerForClient,
  grantForClient,
  ChatServiceError,
  requireChatRemoteDeployment,
  assertChatRunsDeletable,
} from "./shared";

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

export function revisionConfig(
  assistant: {
    systemPrompt: string | null;
    modelProviderId: string | null;
    model: string | null;
    modelParameters: unknown;
    maxSteps: number;
    reasoningEffort: string | null;
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
    ...(assistant.reasoningEffort != null
      ? { reasoningEffort: assistant.reasoningEffort }
      : {}),
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
export async function listChatAssistantsForWorkspace(scope: WorkspaceScope) {
  return db.chatAssistant.findMany({
    where: { workspace: workspaceScopeWhere(scope) },
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

export async function getChatAssistantForUser(
  userId: string,
  assistantId: string,
) {
  return db.chatAssistant.findFirst({
    where: {
      id: assistantId,
      workspace: workspaceAccessWhere(userId),
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

export async function createChatAssistant(
  scope: WorkspaceScope,
  input: Omit<CreateChatAssistantInput, "workspaceId">,
) {
  return withChatDeploymentLocks(
    scope.id,
    (input.mcpGrants ?? []).map((grant) => grant.deploymentId),
    async () => {
      const { definitionChecksums, grants } = await validateAssistantResources(
        scope.id,
        input,
      );
      const data = {
        workspaceId: scope.id,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt ?? null,
        modelProviderId: input.modelProviderId ?? null,
        model: input.model ?? null,
        modelParameters: input.modelParameters
          ? (input.modelParameters as Prisma.InputJsonValue)
          : Prisma.DbNull,
        maxSteps: input.maxSteps ?? AGENT_STEP_BOUNDS.default,
        reasoningEffort: input.reasoningEffort ?? null,
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
      workspace: workspaceAccessWhere(userId),
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
    input.reasoningEffort !== undefined ||
    input.mcpGrants !== undefined;
  if (!changesRevision) {
    const access = {
      status: "active" as const,
      ...workspaceAccessWhere(userId),
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
            workspace: workspaceAccessWhere(userId),
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
            ...(input.reasoningEffort !== undefined
              ? { reasoningEffort: input.reasoningEffort }
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
            workspace: workspaceAccessWhere(userId),
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
            reasoningEffort: config.reasoningEffort ?? null,
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
  scope: WorkspaceScope,
  input: Pick<GenerateChatAssistantPromptInput, "modelProviderId">,
) {
  const provider = await db.modelProvider.findFirst({
    where: { id: input.modelProviderId, workspace: workspaceScopeWhere(scope) },
  });
  if (!provider) throw new ChatServiceError(400, "Model provider not found");
  return provider;
}

export async function deleteChatAssistant(userId: string, assistantId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ChatAssistant" WHERE "id" = ${assistantId} FOR UPDATE`,
    );
    const assistant = await tx.chatAssistant.findFirst({
      where: {
        id: assistantId,
        workspace: workspaceAccessWhere(userId),
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
    const deleted = await tx.chatAssistant.deleteMany({
      where: { id: assistant.id, workspace: workspaceAccessWhere(userId) },
    });
    if (!deleted.count)
      throw new ChatServiceError(404, "Chat assistant not found");
  });
}
