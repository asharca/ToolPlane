import "server-only";
import { posix } from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { defaultConversationRuntimeSession } from "@/lib/agents/mutations";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import { deleteAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import {
  AgentExecutionBusyError,
  withAgentDraftLease,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";
import { deleteWorkspaceAttachmentFile } from "@/lib/attachments/storage";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { resolveModelContext } from "@/lib/agents/model";
import type { ReasoningEffort } from "@/lib/agents/constants";
import { selectNewSessionRevision } from "@/lib/agents/evolution/rollout-selection";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import type {
  LoadedAgentPiPackages,
  ResolvedAgentPiPackage,
} from "@/lib/agents/resolve";
import type { ComposerReference } from "./composer-types";
import {
  claimWorkAttachments,
  workMessageParts,
  type PreparedWorkAttachment,
} from "@/lib/attachments/work";
import {
  allowedWorkSessionSources,
  type WorkSessionStatus,
} from "@/lib/work/state-machine";
import type { AgentModelOverride } from "@/lib/agents/chat-body";
import {
  AGENT_MODEL_OVERRIDE_PART,
  resolveAgentModelOverride,
} from "@/lib/agents/turn-model";

type CreateWorkSessionInput = {
  workspaceId: string;
  a2aActorId?: string;
  uploadedById?: string;
  agentId: string;
  sandboxId?: string;
  task: string;
  acceptanceCriteria?: string;
  workingDirectory?: string;
  attachments?: PreparedWorkAttachment[];
  references?: ComposerReference[];
  reasoningEffort?: ReasoningEffort;
  modelOverride?: AgentModelOverride;
};

export type WorkSessionTransitionResult =
  | { ok: true; changed: boolean; status: WorkSessionStatus }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_input" }
  | { ok: false; reason: "invalid_transition"; status: string };

const workSessionClientInclude = {
  agent: {
    select: {
      id: true,
      workspaceId: true,
      name: true,
      runtimeKind: true,
      retiredAt: true,
    },
  },
  agentRevision: {
    select: { id: true, agentId: true, version: true, config: true },
  },
  sandbox: {
    select: {
      id: true,
      name: true,
      kind: true,
      deploymentId: true,
      deployment: { select: { status: true } },
    },
  },
  conversation: {
    include: {
      messages: {
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
      },
    },
  },
} satisfies Prisma.WorkSessionInclude;

const workSessionSummaryInclude = {
  agent: {
    select: { id: true, name: true, runtimeKind: true, retiredAt: true },
  },
  agentRevision: {
    select: { id: true, agentId: true, version: true, config: true },
  },
  sandbox: {
    select: {
      id: true,
      name: true,
      kind: true,
      deploymentId: true,
      deployment: { select: { status: true } },
    },
  },
} as const;
const workSessionExecutionSelect = {
  agentId: true,
  agentRevisionId: true,
  legacyRevisionUnresolved: true,
  runtimeKind: true,
  runtimeSnapshot: true,
  status: true,
  conversationId: true,
  agent: { select: { runtimeKind: true, retiredAt: true } },
  agentRevision: {
    select: { id: true, agentId: true, version: true, config: true },
  },
  conversation: {
    select: { agentRevisionId: true, legacyRevisionUnresolved: true },
  },
} satisfies Prisma.WorkSessionSelect;

export function normalizeWorkDirectory(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1_000 || value.includes("\0"))
    return null;
  const input =
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/(?:opt\/data\/workspace|workspace)(?:\/|$)/, "") || ".";
  if (input.startsWith("/")) return null;
  const normalized = posix.normalize(input);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

export function workSessionWorkingDirectory(
  value: Prisma.JsonValue | null,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ".";
  return (
    normalizeWorkDirectory(
      (value as { workingDirectory?: unknown }).workingDirectory,
    ) ?? "."
  );
}
export function workSessionRevisionMetadata(session: {
  agentId: string;
  agentRevisionId: string | null;
  legacyRevisionUnresolved: boolean;
  runtimeKind: string;
  runtimeSnapshot: unknown;
  agent: { runtimeKind: string; retiredAt: Date | null };
  agentRevision: {
    id: string;
    agentId: string;
    version?: number;
    config: unknown;
  } | null;
  conversation?: {
    agentRevisionId: string | null;
    legacyRevisionUnresolved: boolean;
  };
}) {
  const revision = session.agentRevision;
  const parsed =
    revision &&
    revision.id === session.agentRevisionId &&
    revision.agentId === session.agentId
      ? AgentRevisionConfigSchema.safeParse(revision.config)
      : null;
  const config = parsed?.success ? parsed.data : null;
  const saved =
    session.runtimeSnapshot && typeof session.runtimeSnapshot === "object"
      ? (session.runtimeSnapshot as Record<string, unknown>)
      : {};
  const snapshotMatches =
    config &&
    saved.providerId === config.providerId &&
    saved.model === config.model;
  return {
    agentRevisionId: session.agentRevisionId,
    agentRevisionVersion: revision?.version ?? null,
    legacyRevisionUnresolved: session.legacyRevisionUnresolved,
    readOnly:
      session.runtimeKind !== "pi-sdk" ||
      session.legacyRevisionUnresolved ||
      !config ||
      session.agent.runtimeKind !== session.runtimeKind ||
      config.runtimeKind !== session.runtimeKind ||
      Boolean(session.agent.retiredAt) ||
      Boolean(
        session.conversation &&
          (session.conversation.legacyRevisionUnresolved ||
            session.conversation.agentRevisionId !== session.agentRevisionId),
      ),
    runtimeKind: config?.runtimeKind ?? session.runtimeKind,
    modelName:
      snapshotMatches && typeof saved.modelName === "string"
        ? saved.modelName
        : (config?.model ??
          (typeof saved.model === "string" ? saved.model : null)),
    contextWindow:
      snapshotMatches &&
      typeof saved.contextWindow === "number" &&
      saved.contextWindow > 0
        ? saved.contextWindow
        : null,
    contextWindowEstimated:
      !snapshotMatches || saved.contextWindowEstimated !== false,
  };
}

export function assertWorkPiPackageSnapshot(
  runtimeKind: string,
  value: unknown,
  piPackages: readonly ResolvedAgentPiPackage[],
): void {
  if (runtimeKind !== "pi-sdk") return;
  const saved =
    value && typeof value === "object" && "piPackages" in value
      ? value.piPackages
      : null;
  if (
    !Array.isArray(saved) ||
    saved.length !== piPackages.length ||
    !saved.every((item, index) => {
      const current = piPackages[index];
      return (
        item &&
        typeof item === "object" &&
        item.marketInstallId === current.marketInstallId &&
        item.releaseId === current.releaseId &&
        item.checksum === current.checksum &&
        item.mcpBindingsChecksum === current.mcpBindingsChecksum
      );
    })
  )
    throw new Error("PI_SDK_PACKAGE_SET_CHANGED");
}

export async function createWorkSession(input: CreateWorkSessionInput) {
  const task = input.task.trim();
  if (!task || task.length > 20_000) return null;
  const title = conversationTitleFromParts([{ type: "text", text: task }]);
  const workingDirectory = normalizeWorkDirectory(
    input.workingDirectory ?? ".",
  );
  if (!workingDirectory) return null;
  const acceptanceCriteria =
    input.acceptanceCriteria?.trim().slice(0, 20_000) || null;
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        providerId: true,
        model: true,
        runtimeKind: true,
        systemPrompt: true,
        maxSteps: true,
        provider: true,
        servers: { select: { deploymentId: true } },
        skills: { select: { installedSkillId: true } },
        toolkits: {
          select: {
            toolkitId: true,
            toolkit: {
              select: {
                servers: { select: { deploymentId: true } },
                skills: { select: { installedSkillId: true } },
              },
            },
          },
        },
        knowledgeBases: { select: { knowledgeBaseId: true } },
        sandboxes: {
          where: { sandbox: { workspaceId: input.workspaceId } },
          select: {
            sandboxId: true,
            isDefault: true,
            sandbox: { select: { kind: true, network: true, config: true } },
          },
        },
      },
    });
    if (agent?.runtimeKind !== "pi-sdk") return null;
    if (input.modelOverride)
      await resolveAgentModelOverride(
        input.workspaceId,
        input.modelOverride,
        agent.runtimeKind,
        tx,
      );
    const revision = await selectNewSessionRevision(tx, agent.id);
    const config = revision.config;
    const pinnedProvider =
      agent.provider?.id === config.providerId ? agent.provider : null;
    const modelContext =
      pinnedProvider && config.model
        ? resolveModelContext(pinnedProvider, config.model)
        : null;
    if (agent.sandboxes.length !== 1) return null;
    const link = agent.sandboxes[0];
    if (
      !link ||
      link.sandboxId !== config.sandboxTemplateId ||
      (input.sandboxId && input.sandboxId !== link.sandboxId) ||
      link.sandbox.kind !== "docker" ||
      link.sandbox.network === "none" ||
      (link.sandbox.config &&
        typeof link.sandbox.config === "object" &&
        !Array.isArray(link.sandbox.config) &&
        link.sandbox.config.readOnly === true)
    )
      return null;
    const sandboxId = link.sandboxId;
    agent.providerId = config.providerId;
    agent.model = config.model;
    agent.systemPrompt = config.systemPrompt;
    agent.maxSteps = config.maxSteps;
    const pinnedPackages: NonNullable<LoadedAgentPiPackages["piPackages"]> = [];
    for (const pin of config.packages) {
      const marketInstall = await tx.marketInstall.findFirst({
        where: {
          id: pin.marketInstallId,
          targetWorkspaceId: input.workspaceId,
        },
        include: { listing: true },
      });
      const release = await tx.marketRelease.findUnique({
        where: { id: pin.releaseId },
      });
      if (
        marketInstall?.listing.status !== "published" ||
        (marketInstall.status !== "ready" &&
          marketInstall.status !== "uninstalled") ||
        !release ||
        release.checksum !== pin.integrity ||
        release.listingId !== marketInstall.listingId
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      pinnedPackages.push({
        marketInstallId: pin.marketInstallId,
        marketInstall,
        releaseId: pin.releaseId,
        release,
      });
    }
    const piPackages = resolveAgentPiPackages({
      ...agent,
      agentRevisionId: revision.id,
      piPackages: pinnedPackages,
    });

    const conversation = await tx.conversation.create({
      data: {
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        title,
        ...(input.reasoningEffort && input.reasoningEffort !== "default"
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
      },
    });
    if (agent.runtimeKind === "pi-sdk")
      await tx.piSessionPackageSet.create({
        data: {
          conversationId: conversation.id,
          packages: {
            create: piPackages.map((pkg) => ({
              marketInstallId: pkg.marketInstallId,
              releaseId: pkg.releaseId,
              checksum: pkg.checksum,
              resourceMap: (pinnedPackages.find(
                (binding) => binding.marketInstallId === pkg.marketInstallId,
              )?.marketInstall.resourceMap ?? {}) as Prisma.InputJsonValue,
            })),
          },
        },
      });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(agent.id, conversation.id),
    });
    const attachments = input.attachments ?? [];
    if (attachments.length) {
      if (!input.uploadedById) return null;
      await claimWorkAttachments(tx, {
        workspaceId: input.workspaceId,
        userId: input.uploadedById,
        conversationId: conversation.id,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        parts: [
          ...workMessageParts(task, attachments, input.references),
          ...(input.modelOverride
            ? [{ type: AGENT_MODEL_OVERRIDE_PART, data: input.modelOverride }]
            : []),
        ],
        textCharacters:
          task.length +
          (input.references ?? []).reduce(
            (total, item) => total + item.text.length,
            0,
          ),
      },
    });
    return tx.workSession.create({
      omit: { uiProjection: true, uiLease: true },
      data: {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        sandboxId,
        conversationId: conversation.id,
        a2aActorId: input.a2aActorId,
        task,
        title,
        acceptanceCriteria,
        runtimeKind: agent.runtimeKind,
        runtimeSnapshot: {
          agentRevisionId: revision.id,
          providerId: agent.providerId,
          model: agent.model,
          modelName: modelContext?.modelName ?? config.model,
          contextWindow: modelContext?.maxTokens ?? null,
          contextWindowEstimated: modelContext?.estimated ?? true,
          systemPrompt: agent.systemPrompt,
          agentMaxSteps: agent.maxSteps,
          ...(agent.runtimeKind === "pi-sdk"
            ? {
                piPackages: piPackages.map(
                  ({
                    marketInstallId,
                    releaseId,
                    checksum,
                    mcpBindingsChecksum,
                  }) => ({
                    marketInstallId,
                    releaseId,
                    checksum,
                    ...(mcpBindingsChecksum ? { mcpBindingsChecksum } : {}),
                  }),
                ),
              }
            : {}),
          deploymentIds: config.mcpGrants.map((grant) => grant.deploymentId),
          installedSkillIds: config.skills.map(
            (skill) => skill.installedSkillId,
          ),
          knowledgeBaseIds: config.knowledgeBaseIds,
          sandboxId,
          workingDirectory,
        },
        status: "queued",
      },
      include: {
        conversation: true,
        sandbox: { include: { deployment: true } },
      },
    });
  });
}

export async function transitionWorkSession(
  workspaceId: string,
  workSessionId: string,
  status: WorkSessionStatus,
  data: Prisma.WorkSessionUpdateManyMutationInput = {},
): Promise<WorkSessionTransitionResult> {
  const sources = allowedWorkSessionSources(status).filter(
    (source) => source !== status,
  );
  const updated = await db.workSession.updateMany({
    where: {
      id: workSessionId,
      workspaceId,
      status: { in: sources },
      ...(["queued", "running"].includes(status)
        ? {
            runtimeKind: { in: ["pi-sdk"] },
            agentRevisionId: { not: null },
            legacyRevisionUnresolved: false,
            conversation: {
              legacyRevisionUnresolved: false,
              agentRevisionId: { not: null },
            },
          }
        : {}),
    },
    data: { status, ...data },
  });
  if (updated.count === 1) return { ok: true, changed: true, status };

  const current = await db.workSession.findFirst({
    where: { id: workSessionId, workspaceId },
    select: { status: true },
  });
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status === status) return { ok: true, changed: false, status };
  return { ok: false, reason: "invalid_transition", status: current.status };
}

export function startWorkSession(workspaceId: string, workSessionId: string) {
  return transitionWorkSession(workspaceId, workSessionId, "running", {
    error: null,
    waitingQuestion: null,
    startedAt: new Date(),
  });
}

export function waitForWorkSessionUser(
  workspaceId: string,
  workSessionId: string,
  question?: string,
) {
  return transitionWorkSession(workspaceId, workSessionId, "waiting_user", {
    waitingQuestion: question?.trim().slice(0, 20_000) || null,
  });
}

export function failWorkSession(
  workspaceId: string,
  workSessionId: string,
  error: string,
) {
  return transitionWorkSession(workspaceId, workSessionId, "failed", {
    error: error.trim().slice(0, 500) || "Work failed.",
    completedAt: new Date(),
  });
}

export function cancelWorkSession(workspaceId: string, workSessionId: string) {
  const now = new Date();
  return db.$transaction(async (tx): Promise<WorkSessionTransitionResult> => {
    const cancelling = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: { in: ["running"] },
      },
      data: { status: "cancelling", cancelRequestedAt: now },
    });
    if (cancelling.count) {
      return { ok: true, changed: true, status: "cancelling" };
    }
    const stopped = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: { in: ["queued", "waiting_user"] },
      },
      data: {
        status: "idle",
        error: null,
        waitingQuestion: null,
        cancelRequestedAt: now,
        completedAt: now,
      },
    });
    if (stopped.count) return { ok: true, changed: true, status: "idle" };
    const current = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: { status: true },
    });
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status === "cancelling" || current.status === "cancelled") {
      return {
        ok: true,
        changed: false,
        status: current.status as WorkSessionStatus,
      };
    }
    return { ok: false, reason: "invalid_transition", status: current.status };
  });
}

export async function finalizeWorkSessionCancellation(
  workspaceId: string,
  workSessionId: string,
) {
  const result = await db.workSession.updateMany({
    where: { id: workSessionId, workspaceId, status: "cancelling" },
    data: {
      status: "idle",
      error: null,
      waitingQuestion: null,
      completedAt: new Date(),
    },
  });
  return result.count === 1;
}

// Admission must commit before deletion can take the Agent maintenance lease;
// otherwise a concurrent input could requeue a workspace being removed.
async function withWorkSessionInputLease(
  workspaceId: string,
  workSessionId: string,
  update: (
    tx: Prisma.TransactionClient,
  ) => Promise<WorkSessionTransitionResult>,
): Promise<WorkSessionTransitionResult> {
  const work = await db.workSession.findFirst({
    where: { id: workSessionId, workspaceId },
    select: { agentId: true, status: true },
  });
  if (!work) return { ok: false, reason: "not_found" };
  try {
    return await withAgentDraftLease(work.agentId, () =>
      db.$transaction(update),
    );
  } catch (error) {
    if (!(error instanceof AgentExecutionBusyError)) throw error;
    return { ok: false, reason: "invalid_transition", status: work.status };
  }
}

export async function resumeWorkSession(
  workspaceId: string,
  workSessionId: string,
  actorId?: string,
): Promise<WorkSessionTransitionResult> {
  return withWorkSessionInputLease(workspaceId, workSessionId, async (tx) => {
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: workSessionExecutionSelect,
    });
    if (!work) return { ok: false, reason: "not_found" } as const;
    if (work.status !== "failed" || workSessionRevisionMetadata(work).readOnly)
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    const updated = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: "failed",
        runtimeKind: work.runtimeKind,
        agentRevisionId: work.agentRevisionId,
        legacyRevisionUnresolved: false,
        agent: { runtimeKind: work.runtimeKind, retiredAt: null },
        conversation: {
          agentRevisionId: work.agentRevisionId,
          legacyRevisionUnresolved: false,
        },
      },
      data: {
        status: "queued",
        ...(actorId ? { a2aActorId: actorId } : {}),
        result: null,
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
    return updated.count === 1
      ? ({ ok: true, changed: true, status: "queued" } as const)
      : ({
          ok: false,
          reason: "invalid_transition",
          status: work.status,
        } as const);
  });
}

export async function appendWorkSessionInput(
  workspaceId: string,
  workSessionId: string,
  input: string,
  options: {
    a2aActorId?: string;
    uploadedById?: string;
    attachments?: PreparedWorkAttachment[];
    references?: ComposerReference[];
    reasoningEffort?: ReasoningEffort;
    modelOverride?: AgentModelOverride;
  } = {},
): Promise<WorkSessionTransitionResult> {
  const text = input.trim();
  if (!text || text.length > 20_000)
    return { ok: false, reason: "invalid_input" };

  return withWorkSessionInputLease(workspaceId, workSessionId, async (tx) => {
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: workSessionExecutionSelect,
    });
    if (!work) return { ok: false, reason: "not_found" } as const;
    if (workSessionRevisionMetadata(work).readOnly)
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    if (
      !["idle", "waiting_user", "completed", "failed"].includes(work.status)
    ) {
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    }
    if (options.modelOverride)
      await resolveAgentModelOverride(
        workspaceId,
        options.modelOverride,
        work.runtimeKind,
        tx,
      );

    const updated = await tx.workSession.updateMany({
      where: {
        id: workSessionId,
        workspaceId,
        status: work.status,
      },
      data: {
        status: "queued",
        ...(options.a2aActorId ? { a2aActorId: options.a2aActorId } : {}),
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    });
    if (updated.count !== 1) {
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    }
    if (options.reasoningEffort) {
      await tx.conversation.update({
        where: { id: work.conversationId },
        data: {
          reasoningEffort:
            options.reasoningEffort === "default"
              ? null
              : options.reasoningEffort,
        },
      });
    }
    const attachments = options.attachments ?? [];
    if (attachments.length) {
      if (!options.uploadedById)
        return { ok: false, reason: "invalid_input" } as const;
      await claimWorkAttachments(tx, {
        workspaceId,
        userId: options.uploadedById,
        conversationId: work.conversationId,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: work.conversationId,
        role: "user",
        parts: [
          ...workMessageParts(text, attachments, options.references),
          ...(options.modelOverride
            ? [{ type: AGENT_MODEL_OVERRIDE_PART, data: options.modelOverride }]
            : []),
        ],
        textCharacters:
          text.length +
          (options.references ?? []).reduce(
            (total, item) => total + item.text.length,
            0,
          ),
      },
    });
    return { ok: true, changed: true, status: "queued" } as const;
  });
}

export async function listWorkSessions(workspaceId: string, agentId?: string) {
  const sessions = await db.workSession.findMany({
    omit: { uiProjection: true, uiLease: true },
    where: {
      workspaceId,
      status: { not: "archived" },
      ...(agentId ? { agentId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: workSessionSummaryInclude,
  });
  return sessions.map((session) => ({
    ...session,
    ...workSessionRevisionMetadata(session),
  }));
}

export async function getWorkSession(
  workspaceId: string,
  workSessionId: string,
  agentId?: string,
  conversationId?: string,
) {
  const session = await db.workSession.findFirst({
    omit: { uiProjection: true, uiLease: true },
    where: {
      id: workSessionId,
      workspaceId,
      ...(agentId ? { agentId } : {}),
      ...(conversationId ? { conversationId } : {}),
    },
    include: workSessionClientInclude,
  });
  return session
    ? { ...session, ...workSessionRevisionMetadata(session) }
    : null;
}

export async function getWorkSessionForUser(
  userId: string,
  workSessionId: string,
) {
  const session = await db.workSession.findFirst({
    omit: { uiProjection: true, uiLease: true },
    where: {
      id: workSessionId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    include: workSessionClientInclude,
  });
  return session &&
    session.agent.workspaceId === session.workspaceId &&
    session.agentId === session.conversation.agentId
    ? { ...session, ...workSessionRevisionMetadata(session) }
    : null;
}

export async function deleteWorkSession(
  workspaceId: string,
  workSessionId: string,
): Promise<boolean> {
  const target = await db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspaceId,
      agent: { workspaceId },
      conversation: { agent: { workspaceId } },
    },
    select: { agentId: true, conversation: { select: { agentId: true } } },
  });
  if (!target || target.agentId !== target.conversation.agentId) return false;
  return withAgentMaintenanceLease(target.agentId, async () => {
    const work = await db.workSession.findFirst({
      where: {
        id: workSessionId,
        workspaceId,
        agentId: target.agentId,
        agent: { workspaceId },
        conversation: { agentId: target.agentId, agent: { workspaceId } },
      },
      select: { conversationId: true, status: true },
    });
    if (!work) return false;
    if (
      !["idle", "completed", "failed", "cancelled", "archived"].includes(
        work.status,
      )
    )
      throw new Error(
        "Work is queued or running. Stop it before deleting the conversation.",
      );
    await deleteAgentConversationSandboxes(
      {
        workspaceId,
        agentId: target.agentId,
        conversationId: work.conversationId,
      },
      async () => {
        const attachments = await db.workspaceAttachment.findMany({
          where: { workspaceId, conversationId: work.conversationId },
          select: { storagePath: true },
        });
        for (const attachment of attachments)
          await deleteWorkspaceAttachmentFile(
            workspaceId,
            attachment.storagePath,
          );
        // Commit FK cleanup before the lifecycle clears its pending-delete
        // marker. Shared Agent sandbox/deployment rows are never deleted.
        await db.conversation.delete({ where: { id: work.conversationId } });
      },
    );
    return true;
  });
}
