import "server-only";
import {
  workspaceAccessWhere,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { posix } from "node:path";
import { Prisma, type WorkSessionStatus } from "@prisma/client";
import { TERMINAL } from "@/lib/a2a/model";
import { db } from "@/lib/db";
import { defaultConversationRuntimeSession } from "@/lib/agents/conversation-mutations";
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
import type { ExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { selectNewSessionRevision } from "@/lib/agents/evolution/rollout-selection";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import type {
  LoadedAgentPiPackages,
  ResolvedAgentPiPackage,
} from "@/lib/agents/resolve";
import type { ComposerReference } from "./composer-types";
import { resolveSubmittedAgentReferences } from "./agent-references";
import {
  claimWorkAttachments,
  workMessageParts,
  type PreparedWorkAttachment,
} from "@/lib/attachments/work";
import {
  canTransitionWorkSession,
  isWorkSessionReadOnly,
  READ_ONLY_WORK_SESSION_STATUSES,
} from "./state-machine";
import { insertWorkSession, updateWorkSessionStatus } from "./lifecycle";
import { workFailureText } from "./failures";
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
  | { ok: false; reason: "invalid_transition"; status: WorkSessionStatus };

const workSessionClientInclude = {
  a2aActor: { select: { name: true } },
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
        where: { supersededAt: null },
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
  status: WorkSessionStatus;
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
      isWorkSessionReadOnly(session.status) ||
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
  _runtimeKind: ExecutableAgentRuntimeKind,
  value: unknown,
  piPackages: readonly ResolvedAgentPiPackage[],
): void {
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
  const attachments = input.attachments ?? [];
  const { uploadedById } = input;
  if (
    (!task && !attachments.length && !input.references?.length) ||
    task.length > 20_000 ||
    (attachments.length && !uploadedById)
  )
    return null;
  const title = conversationTitleFromParts([
    {
      type: "text",
      text:
        task ||
        input.references?.[0]?.label ||
        input.attachments?.[0]?.name ||
        "",
    },
  ]);
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
    const references = await resolveSubmittedAgentReferences(
      tx,
      {
        workspaceId: input.workspaceId,
        agentId: agent.id,
        agentRevisionId: revision.id,
      },
      config,
      input.references,
    );
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
    const [installs, releases] = config.packages.length
      ? await Promise.all([
          tx.marketInstall.findMany({
            where: {
              id: { in: config.packages.map((pin) => pin.marketInstallId) },
              targetWorkspaceId: input.workspaceId,
            },
            include: { listing: true },
          }),
          tx.marketRelease.findMany({
            where: { id: { in: config.packages.map((pin) => pin.releaseId) } },
          }),
        ])
      : [[], []];
    const installsById = new Map(
      installs.map((install) => [install.id, install]),
    );
    const releasesById = new Map(
      releases.map((release) => [release.id, release]),
    );
    for (const pin of config.packages) {
      const marketInstall = installsById.get(pin.marketInstallId);
      const release = releasesById.get(pin.releaseId);
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
              resourceMap: (installsById.get(pkg.marketInstallId)
                ?.resourceMap ?? {}) as Prisma.InputJsonValue,
            })),
          },
        },
      });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: defaultConversationRuntimeSession(agent.id, conversation.id),
    });
    if (attachments.length && uploadedById) {
      await claimWorkAttachments(tx, {
        workspaceId: input.workspaceId,
        userId: uploadedById,
        conversationId: conversation.id,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        parts: [
          ...workMessageParts(task, attachments, references),
          ...(input.modelOverride
            ? [{ type: AGENT_MODEL_OVERRIDE_PART, data: input.modelOverride }]
            : []),
        ],
        textCharacters:
          task.length +
          references.reduce((total, item) => total + item.text.length, 0),
      },
    });
    return insertWorkSession(tx, "queued", {
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
        installedSkillIds: config.skills.map((skill) => skill.installedSkillId),
        knowledgeBaseIds: config.knowledgeBaseIds,
        sandboxId,
        workingDirectory,
      },
    });
  });
}

export function cancelWorkSession(workspaceId: string, workSessionId: string) {
  const now = new Date();
  return db.$transaction(async (tx): Promise<WorkSessionTransitionResult> => {
    const cancelling = await updateWorkSessionStatus(
      tx,
      { id: workSessionId, workspaceId, status: "running" },
      { status: "cancelling", cancelRequestedAt: now },
    );
    if (cancelling.count) {
      return { ok: true, changed: true, status: "cancelling" };
    }
    const stopped = await updateWorkSessionStatus(
      tx,
      {
        id: workSessionId,
        workspaceId,
        status: { in: ["queued", "waiting_user"] },
      },
      {
        status: "idle",
        error: null,
        waitingQuestion: null,
        cancelRequestedAt: now,
        completedAt: now,
      },
    );
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
        status: current.status,
      };
    }
    return { ok: false, reason: "invalid_transition", status: current.status };
  });
}

export async function finalizeWorkSessionCancellation(
  workspaceId: string,
  workSessionId: string,
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId, status: "cancelling" },
      select: { agentId: true },
    });
    if (!work) return false;
    const active = await tx.$queryRaw<{ id: string }[]>`
      SELECT root.id FROM "A2AEntryBinding" binding
      JOIN "A2AContext" ctx ON ctx.id = binding."contextId"
      JOIN "A2ATask" root ON root."contextId" = ctx.id AND root."parentTaskId" IS NULL
      WHERE binding.kind = 'work' AND binding."sourceId" = ${workSessionId}
        AND ctx."workspaceId" = ${workspaceId} AND ctx."agentId" = ${work.agentId}
        AND (root.state NOT IN (${Prisma.join(TERMINAL)}) OR EXISTS (
          SELECT 1 FROM "A2ATask" child
          JOIN "A2AContext" child_ctx ON child_ctx.id = child."contextId"
          WHERE child."rootTaskId" = root.id AND child_ctx."workspaceId" = ${workspaceId}
            AND child.state NOT IN (${Prisma.join(TERMINAL)})
        )) LIMIT 1`;
    if (active.length) return false;
    const result = await updateWorkSessionStatus(
      tx,
      { id: workSessionId, workspaceId, status: "cancelling" },
      {
        status: "idle",
        error: null,
        waitingQuestion: null,
        completedAt: new Date(),
      },
    );
    return result.count === 1;
  });
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
  scope: WorkspaceScope,
  workSessionId: string,
): Promise<WorkSessionTransitionResult> {
  return withWorkSessionInputLease(scope.id, workSessionId, async (tx) => {
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspace: workspaceScopeWhere(scope) },
      select: workSessionExecutionSelect,
    });
    if (!work) return { ok: false, reason: "not_found" } as const;
    if (work.status !== "failed" || workSessionRevisionMetadata(work).readOnly)
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    const updated = await updateWorkSessionStatus(
      tx,
      {
        id: workSessionId,
        workspace: workspaceScopeWhere(scope),
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
      {
        status: "queued",
        a2aActorId: scope.actorUserId,
        result: null,
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    );
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
  const attachments = options.attachments ?? [];
  const { uploadedById } = options;
  if (
    (!text && !attachments.length && !options.references?.length) ||
    text.length > 20_000 ||
    (attachments.length && !uploadedById)
  )
    return { ok: false, reason: "invalid_input" };

  return withWorkSessionInputLease(workspaceId, workSessionId, async (tx) => {
    const work = await tx.workSession.findFirst({
      where: { id: workSessionId, workspaceId },
      select: workSessionExecutionSelect,
    });
    if (!work) return { ok: false, reason: "not_found" } as const;
    if (!work.agentRevision || workSessionRevisionMetadata(work).readOnly)
      return {
        ok: false,
        reason: "invalid_transition",
        status: work.status,
      } as const;
    if (!canTransitionWorkSession(work.status, "queued")) {
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
    const references = await resolveSubmittedAgentReferences(
      tx,
      {
        workspaceId,
        agentId: work.agentId,
        agentRevisionId: work.agentRevision.id,
      },
      AgentRevisionConfigSchema.parse(work.agentRevision.config),
      options.references,
    );

    const updated = await updateWorkSessionStatus(
      tx,
      { id: workSessionId, workspaceId, status: work.status },
      {
        status: "queued",
        ...(options.a2aActorId ? { a2aActorId: options.a2aActorId } : {}),
        result: null,
        artifacts: [],
        error: null,
        waitingQuestion: null,
        completedAt: null,
        cancelRequestedAt: null,
      },
    );
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
    if (attachments.length && uploadedById) {
      await claimWorkAttachments(tx, {
        workspaceId,
        userId: uploadedById,
        conversationId: work.conversationId,
        attachments,
      });
    }
    await tx.message.create({
      data: {
        conversationId: work.conversationId,
        role: "user",
        parts: [
          ...workMessageParts(text, attachments, references),
          ...(options.modelOverride
            ? [{ type: AGENT_MODEL_OVERRIDE_PART, data: options.modelOverride }]
            : []),
        ],
        textCharacters:
          text.length +
          references.reduce((total, item) => total + item.text.length, 0),
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
      status: { notIn: READ_ONLY_WORK_SESSION_STATUSES },
      ...(agentId ? { agentId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: workSessionSummaryInclude,
  });
  return sessions.map((session) => ({
    ...session,
    error: workFailureText(session.error),
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
    ? {
        ...session,
        error: workFailureText(session.error),
        ...workSessionRevisionMetadata(session),
      }
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
      workspace: workspaceAccessWhere(userId),
    },
    include: workSessionClientInclude,
  });
  return session &&
    session.agent.workspaceId === session.workspaceId &&
    session.agentId === session.conversation.agentId
    ? {
        ...session,
        error: workFailureText(session.error),
        ...workSessionRevisionMetadata(session),
      }
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
          where: {
            workspaceId,
            conversationId: work.conversationId,
            status: "ready",
          },
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
