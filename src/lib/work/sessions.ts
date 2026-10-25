import "server-only";
import { posix } from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { defaultConversationRuntimeSession } from "@/lib/agents/mutations";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { resolveModelContext } from "@/lib/agents/model";
import type { ReasoningEffort } from "@/lib/agents/constants";
import { pinCurrentAgentRevision } from "@/lib/agents/revisions";
import { AGENT_PI_PACKAGES_INCLUDE } from "@/lib/agents/pi-package-includes";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import type { ResolvedAgentPiPackage } from "@/lib/agents/resolve";
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
};

export type WorkSessionTransitionResult =
  | { ok: true; changed: boolean; status: WorkSessionStatus }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_input" }
  | { ok: false; reason: "invalid_transition"; status: string };

const workSessionClientInclude = {
  agent: {
    select: { id: true, name: true, runtimeKind: true, retiredAt: true },
  },
  agentRevision: { select: { id: true, agentId: true, config: true } },
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
  approvals: { orderBy: { requestedAt: "desc" as const } },
} satisfies Prisma.WorkSessionInclude;

const workSessionSummaryInclude = {
  agent: {
    select: { id: true, name: true, runtimeKind: true, retiredAt: true },
  },
  agentRevision: { select: { id: true, agentId: true, config: true } },
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
  agentRevision: { select: { id: true, agentId: true, config: true } },
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
  agentRevision: { id: string; agentId: string; config: unknown } | null;
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
    legacyRevisionUnresolved: session.legacyRevisionUnresolved,
    readOnly:
      session.runtimeKind !== "pi-sdk" ||
      session.legacyRevisionUnresolved ||
      !config ||
      session.agent.runtimeKind !== "pi-sdk" ||
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
        modelProviders: { select: { providerId: true, provider: true } },
        piPackages: AGENT_PI_PACKAGES_INCLUDE,
        runtime: {
          select: {
            id: true,
            kind: true,
            sandboxId: true,
            sandbox: {
              select: {
                id: true,
                workspaceId: true,
                kind: true,
                network: true,
              },
            },
          },
        },
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
            sandbox: { select: { kind: true, network: true } },
          },
        },
      },
    });
    if (agent?.runtimeKind !== "pi-sdk") return null;
    const revision = await pinCurrentAgentRevision(tx, agent.id);
    const config = revision.config;
    const pinnedProvider =
      agent.provider?.id === config.providerId
        ? agent.provider
        : agent.modelProviders.find(
            (entry) => entry.providerId === config.providerId,
          )?.provider;
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
      agent.runtime?.sandboxId === link.sandboxId ||
      link.sandbox.kind !== "docker" ||
      link.sandbox.network === "none"
    )
      return null;
    const sandboxId = link.sandboxId;
    agent.providerId = config.providerId;
    agent.model = config.model;
    agent.systemPrompt = config.systemPrompt;
    agent.maxSteps = config.maxSteps;
    const pinnedPackages = [];
    for (const pin of config.packages) {
      const binding = agent.piPackages.find(
        (item) => item.marketInstallId === pin.marketInstallId,
      );
      const release = await tx.marketRelease.findUnique({
        where: { id: pin.releaseId },
      });
      if (!binding || !release || release.checksum !== pin.integrity)
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      pinnedPackages.push({ ...binding, releaseId: pin.releaseId, release });
    }
    agent.piPackages = pinnedPackages;
    const piPackages = resolveAgentPiPackages(agent);

    const conversation = await tx.conversation.create({
      data: {
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        title: task.slice(0, 80),
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
              resourceMap: (agent.piPackages.find(
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
        parts: workMessageParts(task, attachments, input.references),
        textCharacters:
          task.length +
          (input.references ?? []).reduce(
            (total, item) => total + item.text.length,
            0,
          ),
      },
    });
    return tx.workSession.create({
      data: {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        sandboxId,
        conversationId: conversation.id,
        a2aActorId: input.a2aActorId,
        task,
        title: task.slice(0, 80),
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
          runtimeId: agent.runtime?.id ?? null,
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
            runtimeKind: "pi-sdk",
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

export function waitForWorkSessionApproval(
  workspaceId: string,
  workSessionId: string,
) {
  return transitionWorkSession(workspaceId, workSessionId, "waiting_approval");
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
        status: { in: ["running", "waiting_approval"] },
      },
      data: { status: "cancelling", cancelRequestedAt: now },
    });
    if (cancelling.count) {
      await tx.workApproval.updateMany({
        where: { workSessionId, status: "pending" },
        data: { status: "expired", resolvedAt: now },
      });
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

export async function resumeWorkSession(
  workspaceId: string,
  workSessionId: string,
  actorId?: string,
): Promise<WorkSessionTransitionResult> {
  return db.$transaction(async (tx) => {
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
        runtimeKind: "pi-sdk",
        agentRevisionId: work.agentRevisionId,
        legacyRevisionUnresolved: false,
        agent: { runtimeKind: "pi-sdk", retiredAt: null },
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
  } = {},
): Promise<WorkSessionTransitionResult> {
  const text = input.trim();
  if (!text || text.length > 20_000)
    return { ok: false, reason: "invalid_input" };

  return db.$transaction(async (tx) => {
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
        parts: workMessageParts(text, attachments, options.references),
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
    where: {
      workspaceId,
      status: { not: "archived" },
      ...(agentId ? { agentId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
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
    where: {
      id: workSessionId,
      workspace: {
        status: "active",
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
    },
    include: workSessionClientInclude,
  });
  return session
    ? { ...session, ...workSessionRevisionMetadata(session) }
    : null;
}

export async function archiveWorkSession(
  workspaceId: string,
  workSessionId: string,
) {
  const result = await db.workSession.updateMany({
    where: {
      id: workSessionId,
      workspaceId,
      status: { in: ["idle", "completed", "failed", "cancelled"] },
    },
    data: { status: "archived" },
  });
  return result.count === 1;
}
