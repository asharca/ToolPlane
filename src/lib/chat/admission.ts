import "server-only";
import {
  workspaceAccessWhere,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { Prisma, type ChatTurn } from "@prisma/client";
import { createHash } from "node:crypto";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { ChatAssistantRevisionConfigSchema } from "./revision-types";
import { canonicalJson } from "@/lib/pi-packages/artifact";
import { chatExecutionProgressChunk } from "./execution-stage";
import { db } from "@/lib/db";
import {
  attachmentIdsFromParts,
  claimWorkspaceAttachments,
} from "@/lib/attachments/messages";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import { inferModelPrimaryType } from "@/lib/agents/model-catalog";
import { modelReasoningSupported } from "@/lib/agents/model";
import {
  ChatServiceError,
  requireChatRemoteDeployment,
  projectActiveChatBranch,
} from "./shared";

export type ChatTurnAdmission = ChatTurn & {
  assistantMessageId: string;
  assistantParentId: string;
  historyLeafId: string;
  replayed: boolean;
};

export const CHAT_TURN_STALE_AFTER_MS = 5 * 60 * 1000;

export async function listRunningChatThreadIds(scope: WorkspaceScope) {
  const turns = await db.chatTurn.findMany({
    where: {
      thread: { workspace: workspaceScopeWhere(scope) },
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
        workspace: workspaceAccessWhere(userId),
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

export async function getChatThreadForExecution(
  userId: string,
  threadId: string,
) {
  const thread = await db.chatThread.findFirst({
    where: {
      id: threadId,
      workspace: workspaceAccessWhere(userId),
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
      reasoningEffort: config.reasoningEffort ?? null,
      modelProvider,
      mcpGrants: grants,
    },
    revisionConfig: config,
  });
}

/** Resolve a turn-local model without rebinding the thread's immutable revision. */
export async function resolveChatTurnModel(
  scope: WorkspaceScope,
  selection: { providerId: string; model: string },
  requirements: { tools: boolean; reasoning: boolean; modalities: string[] },
) {
  const provider = await db.modelProvider.findFirst({
    where: { id: selection.providerId, workspace: workspaceScopeWhere(scope) },
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
    (requirements.reasoning &&
      !modelReasoningSupported(provider, selection.model, record)) ||
    (record &&
      ((requirements.tools &&
        !record.capabilities.includes("function_calling")) ||
        requirements.modalities.some(
          (modality) => !record.inputModalities.includes(modality),
        )))
  )
    throw new ChatServiceError(400, "CHAT_MODEL_CAPABILITY_UNSUPPORTED");
  return { provider, modelId: selection.model };
}

export async function beginChatTurn(
  threadId: string,
  parts: Array<Record<string, unknown>>,
  scope: WorkspaceScope,
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
      workspaceId: scope.id,
      workspace: workspaceScopeWhere(scope),
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
      const thread = await tx.chatThread.findFirst({
        where: { id: threadId, workspace: workspaceScopeWhere(scope) },
        select: {
          activeMessageId: true,
          assistantId: true,
          title: true,
          workspaceId: true,
          assistantRevisionId: true,
          legacyRevisionUnresolved: true,
        },
      });
      if (!thread || thread.workspaceId !== scope.id) {
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
          existing.actorUserId !== scope.actorUserId ||
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
          actorUserId: scope.actorUserId,
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
            const changed = await tx.chatMessage.updateMany({
              where: {
                id: target.id,
                thread: { id: threadId, workspace: workspaceScopeWhere(scope) },
              },
              data: { siblingGroupId },
            });
            if (!changed.count)
              throw new ChatServiceError(404, "Chat message not found");
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
          workspaceId: scope.id,
          uploadedById: scope.actorUserId,
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
          const [updated] = await tx.chatMessage.updateManyAndReturn({
            where: {
              id: activePlaceholder.id,
              thread: { id: threadId, workspace: workspaceScopeWhere(scope) },
            },
            data: {
              turnId: turn.id,
              status: "success",
              parts: parts as Prisma.InputJsonValue,
            },
          });
          if (!updated)
            throw new ChatServiceError(404, "Chat message not found");
          userMessage = updated;
        } else {
          const siblingGroupId = target
            ? (target.siblingGroupId ?? turn.id)
            : null;
          if (target && !target.siblingGroupId) {
            const changed = await tx.chatMessage.updateMany({
              where: {
                id: target.id,
                thread: { id: threadId, workspace: workspaceScopeWhere(scope) },
              },
              data: { siblingGroupId },
            });
            if (!changed.count)
              throw new ChatServiceError(404, "Chat message not found");
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

      const updated = await tx.chatThread.updateMany({
        where: { id: threadId, workspace: workspaceScopeWhere(scope) },
        data: {
          activeMessageId: assistantMessageId,
          updatedAt: new Date(),
          ...(!thread.title && trigger === "submit-message"
            ? { title: conversationTitleFromParts(parts) }
            : {}),
        },
      });
      if (!updated.count)
        throw new ChatServiceError(404, "Chat thread not found");
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
