import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  A2AContext,
  A2AEntryBinding,
  Conversation,
  Deployment,
  Prisma,
  Sandbox,
} from "@prisma/client";
import { db } from "@/lib/db";
import { getAgentSandboxAutoStopSettings } from "@/lib/admin/settings";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import {
  allowProcessRestart,
  killProcess,
  livePort,
  liveStatus,
  startProcess,
} from "@/lib/process/supervisor";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { enqueueSandboxOperation } from "@/lib/sandboxes/lifecycle";
import {
  assertDockerVolumeExists,
  initializeDockerSessionWorkspace,
  createDockerVolume,
  digestDockerVolume,
  removeDockerSandboxRuntimeStrict,
  removeDockerSessionWorkspace,
  removeDockerVolumeStrict,
  sandboxVolumeName,
  stopDockerSandboxContainer,
} from "@/lib/sandboxes/runtime";
import {
  agentExecutionBusy,
  withAgentMaintenanceLease,
} from "./agent-execution-gate";
import { sandboxExecutionBusy } from "./sandbox-execution-gate";
import { requireAgentRevision } from "./revisions";
import { resolveAgentEnvironmentCredentials } from "./environment-credentials";
import { stopSessionMcp } from "@/lib/process/session-mcp";
import { agentSessionWorkspaceRoot } from "./session-paths";
import { materializeConversationAttachments } from "@/lib/attachments/work";
import { stopAgentSessionRuntime } from "./sandbox-runtime";
import { AgentRevisionConfigSchema } from "./revision-types";

export type AgentConversationSandboxInput = {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  contextId?: string;
};
export type AgentConversationSandbox = {
  sandboxId: string;
  deploymentId: string;
  workspaceRoot: string;
  workingDirectory: string;
  conversationId?: string;
  contextId?: string;
};
type ManagedConfig = {
  managedBy: string;
  agentId: string;
  sourceSandboxId: string;
};
type AgentSessionBinding = {
  conversation: Conversation | null;
  context: (A2AContext & { entryBindings: A2AEntryBinding[] }) | null;
  sandbox: (Sandbox & { deployment: Deployment }) | null;
};
import {
  beginAgentConversationSandboxAccess,
  sandboxAccesses as accesses,
} from "@/lib/sandboxes/activity";
export { beginAgentConversationSandboxAccess } from "@/lib/sandboxes/activity";
function managed(config: Prisma.JsonValue | null): ManagedConfig | null {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return null;
  if (
    config.managedBy !== "agent-conversation" ||
    typeof config.agentId !== "string" ||
    typeof config.sourceSandboxId !== "string"
  )
    return null;
  return {
    managedBy: config.managedBy,
    agentId: config.agentId,
    sourceSandboxId: config.sourceSandboxId,
  };
}
async function binding(
  tx: Prisma.TransactionClient,
  input: AgentConversationSandboxInput,
): Promise<AgentSessionBinding> {
  if (!input.conversationId && !input.contextId)
    throw new Error("Conversation or native context is required.");
  const agent = await tx.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
  });
  if (!agent) throw new Error("Agent not found in workspace.");
  const context = input.contextId
    ? await tx.a2AContext.findFirst({
        where: {
          id: input.contextId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          targetKind: "local",
        },
        include: { entryBindings: true },
      })
    : null;
  if (input.contextId && !context)
    throw new Error("Conversation/context does not belong to this Agent.");
  const conversationIds = new Set<string>();
  for (const entry of context?.entryBindings ?? []) {
    if (["chat", "control", "channel"].includes(entry.kind))
      conversationIds.add(entry.sourceId);
    if (entry.kind === "work") {
      const work = await tx.workSession.findFirst({
        where: {
          id: entry.sourceId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        },
        select: { conversationId: true },
      });
      if (work?.conversationId) conversationIds.add(work.conversationId);
    }
  }
  if (
    conversationIds.size > 1 ||
    (input.conversationId &&
      context &&
      !conversationIds.has(input.conversationId))
  )
    throw new Error("Native context is not bound to this conversation.");
  const conversationId = input.conversationId ?? [...conversationIds][0];
  const conversation = conversationId
    ? await tx.conversation.findFirst({
        where: {
          id: conversationId,
          agentId: input.agentId,
          agent: { workspaceId: input.workspaceId },
        },
      })
    : null;
  if (conversationId && !conversation)
    throw new Error("Conversation/context does not belong to this Agent.");
  const ids = [conversation?.sandboxId, context?.sandboxId].filter(
    (id): id is string => !!id,
  );
  if (new Set(ids).size > 1)
    throw new Error("Conversation/context sandbox mappings conflict.");
  const sandbox = ids[0]
    ? await tx.sandbox.findFirst({
        where: { id: ids[0], workspaceId: input.workspaceId },
        include: { deployment: true },
      })
    : null;
  if (
    ids.length &&
    (sandbox?.kind !== "docker" ||
      managed(sandbox.config)?.agentId !== input.agentId)
  )
    throw new Error("Conversation sandbox binding is invalid.");
  return { conversation, context, sandbox };
}

function mapping(
  input: AgentConversationSandboxInput,
  found: AgentSessionBinding,
  sandbox: { id: string; deploymentId: string },
): AgentConversationSandbox {
  const identity = {
    conversationId: found.conversation?.id,
    a2aContextId: found.context?.id ?? input.contextId,
  };
  const workspaceRoot = agentSessionWorkspaceRoot(identity);
  return {
    sandboxId: sandbox.id,
    deploymentId: sandbox.deploymentId,
    workspaceRoot,
    workingDirectory: workspaceRoot,
    ...(identity.conversationId
      ? { conversationId: identity.conversationId }
      : {}),
    ...(identity.a2aContextId ? { contextId: identity.a2aContextId } : {}),
  };
}

export async function findAgentConversationSandbox(
  input: AgentConversationSandboxInput & { cleanup?: boolean },
): Promise<AgentConversationSandbox | null> {
  if (input.cleanup) assertRuntimeOwner();
  const found = await binding(db, input);
  if (!found.sandbox) return null;
  const result = mapping(input, found, found.sandbox);
  // Before migration, history/file readers must still see the original volume root.
  if (
    (found.sandbox.config as Record<string, unknown> | null)?.scope !== "agent"
  )
    return {
      ...result,
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace",
    };
  return result;
}

export async function ensureAgentConversationSandbox(
  input: AgentConversationSandboxInput & { signal?: AbortSignal },
): Promise<AgentConversationSandbox> {
  assertRuntimeOwner();
  input.signal?.throwIfAborted();
  const initial = await binding(db, input);
  const session = initial.conversation ?? initial.context;
  if (!session?.agentRevisionId || session.legacyRevisionUnresolved)
    throw new Error("Historical Agent sessions are read-only.");
  const revision = await requireAgentRevision(
    db,
    input.agentId,
    session.agentRevisionId,
  );
  const environment = revision.config.environment;
  const authorize = () =>
    resolveAgentEnvironmentCredentials({
      ...input,
      conversationId: initial.conversation?.id,
      agentRevisionId: revision.id,
    });
  await authorize();
  const allocated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${input.agentId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
    const current = await binding(tx, input);
    for (const owner of [current.conversation, current.context]) {
      if (
        owner &&
        (owner.agentRevisionId !== revision.id ||
          owner.legacyRevisionUnresolved)
      )
        throw new Error("Session revision changed.");
    }
    const oldConfig = current.sandbox?.config as Record<string, unknown> | null;
    if (oldConfig?.readOnly === true && oldConfig?.migrationArchive !== true)
      throw new Error("Historical Agent sessions are read-only.");
    if (
      current.sandbox &&
      oldConfig?.scope !== "agent" &&
      oldConfig?.agentRevisionId !== revision.id
    )
      throw new Error("Session sandbox revision does not match.");
    const existing = await tx.sandbox.findFirst({
      where: {
        workspaceId: input.workspaceId,
        AND: [
          { config: { path: ["managedBy"], equals: "agent-conversation" } },
          { config: { path: ["agentId"], equals: input.agentId } },
          { config: { path: ["scope"], equals: "agent" } },
        ],
      },
      include: { deployment: true },
    });
    if (existing) {
      const config = existing.config as Record<string, unknown> | null;
      if (
        config?.readOnly === true ||
        typeof config?.agentRevisionId !== "string"
      )
        throw new Error("Historical Agent sessions are read-only.");
      if (
        current.conversation &&
        Array.isArray(config?.pendingWorkspaceDeletes) &&
        config.pendingWorkspaceDeletes.includes(current.conversation.id)
      )
        throw new Error(
          "Conversation sandbox deletion requires recovery; its saved mapping was retained.",
        );
      const pin = await tx.agentRevision.findFirst({
        where: { id: config.agentRevisionId, agentId: input.agentId },
        select: { config: true },
      });
      if (!pin) throw new Error("AGENT_SHARED_ENVIRONMENT_CONFLICT");
      const pinned = AgentRevisionConfigSchema.parse(pin.config);
      if (
        pinned.runtimeKind !== revision.config.runtimeKind ||
        !isDeepStrictEqual(pinned.environment, environment)
      )
        throw new Error("AGENT_SHARED_ENVIRONMENT_CONFLICT");
      return existing;
    }
    const id = randomUUID();
    const deployment = await tx.deployment.create({
      data: {
        workspaceId: input.workspaceId,
        name: `Agent sandbox: ${input.agentId}`,
        source: "sandbox",
        sourceRef: environment.image,
        status: "copying",
        installCfg: {
          sandboxId: id,
          kind: "docker",
          image: environment.image,
          network: environment.network,
          volumeName: sandboxVolumeName(id),
          resourceLimits: environment.resourceLimits,
          ...("ompVersion" in environment
            ? { ompVersion: environment.ompVersion }
            : { piVersion: environment.piVersion }),
        },
      },
    });
    return tx.sandbox.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        deploymentId: deployment.id,
        name: `Agent ${input.agentId}`,
        slug: `agent-${id}`,
        kind: "docker",
        image: environment.image,
        network: environment.network,
        config: {
          managedBy: "agent-conversation",
          scope: "agent",
          agentId: input.agentId,
          sourceSandboxId: revision.config.sandboxTemplateId ?? "revision",
          agentRevisionId: revision.id,
        },
      },
      include: { deployment: true },
    });
  });
  const bindExistingOwners = async () =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${input.agentId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
      const latest = await binding(tx, input);
      for (const owner of [latest.conversation, latest.context]) {
        if (
          owner &&
          (owner.agentRevisionId !== revision.id ||
            owner.legacyRevisionUnresolved)
        )
          throw new Error("Session revision changed.");
      }
      if (latest.sandbox?.id !== allocated.id)
        throw new Error("Conversation/context sandbox mappings changed.");
      if (latest.conversation && !latest.conversation.sandboxId)
        await tx.conversation.update({
          where: { id: latest.conversation.id },
          data: { sandboxId: allocated.id },
        });
      if (latest.context && !latest.context.sandboxId)
        await tx.a2AContext.update({
          where: { id: latest.context.id },
          data: { sandboxId: allocated.id },
        });
    });
  // Reusing a live shared environment is not a disruptive lifecycle mutation.
  if (
    initial.sandbox?.id === allocated.id &&
    allocated.deployment.status === "running" &&
    liveStatus(allocated.deploymentId) === "running"
  ) {
    const release = beginAgentConversationSandboxAccess(allocated.id);
    try {
      await assertDockerVolumeExists(sandboxVolumeName(allocated.id));
      await authorize();
      await bindExistingOwners();
      input.signal?.throwIfAborted();
      if (liveStatus(allocated.deploymentId) === "running")
        return mapping(input, initial, allocated);
    } finally {
      release();
    }
  }
  const result = await enqueueSandboxOperation(
    input.workspaceId,
    allocated.id,
    async () => {
      input.signal?.throwIfAborted();
      const sandbox = await db.sandbox.findFirstOrThrow({
        where: { id: allocated.id, workspaceId: input.workspaceId },
        include: { deployment: true },
      });
      if (sandbox.deployment.status === "copying") {
        await createDockerVolume(sandboxVolumeName(sandbox.id));
        await db.deployment.update({
          where: { id: sandbox.deploymentId },
          data: { status: "provisioning" },
        });
      } else if (
        [
          "copy_failed",
          "deleting",
          "restoring",
          "restore_failed",
          "restore_cleanup_required",
        ].includes(sandbox.deployment.status)
      ) {
        throw new Error(
          "Conversation sandbox requires recovery; its saved mapping was retained.",
        );
      }
      await assertDockerVolumeExists(sandboxVolumeName(sandbox.id));
      const current = await binding(db, input);
      const config = sandbox.config as Record<string, unknown> | null;
      if (
        current.conversation &&
        Array.isArray(config?.pendingWorkspaceDeletes) &&
        config.pendingWorkspaceDeletes.includes(current.conversation.id)
      )
        throw new Error(
          "Conversation sandbox deletion requires recovery; its saved mapping was retained.",
        );
      const destination = mapping(input, current, sandbox);
      if (current.sandbox?.id !== sandbox.id) {
        const initialize = async () => {
          let source:
            | { volumeName: string; checksum: string; sourceSandboxId?: string }
            | undefined;
          if (current.sandbox) {
            const old = current.sandbox;
            if (
              [
                "copying",
                "copy_failed",
                "deleting",
                "restoring",
                "restore_failed",
                "restore_cleanup_required",
              ].includes(old.deployment.status)
            )
              throw new Error(
                "Conversation sandbox requires recovery; its saved mapping was retained.",
              );
            await stopAgentSandboxSessionMcp(old.id, input.workspaceId);
            await killProcess(old.deploymentId, {
              preventRestart: true,
              finalStatus: "stopped",
            });
            await stopDockerSandboxContainer(old.id);
            source = {
              volumeName: sandboxVolumeName(old.id),
              checksum: await digestDockerVolume(sandboxVolumeName(old.id)),
              sourceSandboxId: old.id,
            };
          } else if (environment.initialSnapshot) {
            const snapshot = environment.initialSnapshot;
            const frozen = await db.sandboxSnapshot.findFirst({
              where: {
                id: snapshot.snapshotId,
                volumeName: snapshot.volumeName,
                status: "ready",
                sandboxId: revision.config.sandboxTemplateId ?? "",
                sandbox: { workspaceId: input.workspaceId },
              },
              include: { sandbox: { select: { config: true } } },
            });
            const config = frozen?.sandbox?.config as Record<
              string,
              unknown
            > | null;
            if (
              !frozen ||
              config?.readOnly === true ||
              (await digestDockerVolume(snapshot.volumeName)) !==
                snapshot.checksum
            )
              throw new Error(
                "Pinned environment snapshot is unavailable or its digest changed.",
              );
            source = {
              volumeName: snapshot.volumeName,
              checksum: snapshot.checksum,
            };
          }
          await initializeDockerSessionWorkspace(
            sandboxVolumeName(sandbox.id),
            destination.workspaceRoot.slice("/workspace/".length),
            source,
          );
          if (current.conversation && !current.sandbox)
            await materializeConversationAttachments({
              workspaceId: input.workspaceId,
              conversationId: current.conversation.id,
              volumeName: sandboxVolumeName(sandbox.id),
              workspaceRoot: destination.workspaceRoot,
            });
          await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${input.agentId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
            const latest = await binding(tx, input);
            for (const owner of [latest.conversation, latest.context]) {
              if (
                owner &&
                (owner.agentRevisionId !== revision.id ||
                  owner.legacyRevisionUnresolved)
              )
                throw new Error("Session revision changed.");
            }
            if (latest.sandbox?.id !== current.sandbox?.id)
              throw new Error(
                "Conversation/context sandbox mappings changed during migration.",
              );
            if (latest.conversation) {
              const work = await tx.workSession.findFirst({
                where: {
                  conversationId: latest.conversation.id,
                  workspaceId: input.workspaceId,
                  agentId: input.agentId,
                },
                select: { id: true },
              });
              await tx.conversation.update({
                where: { id: latest.conversation.id },
                data: { sandboxId: sandbox.id },
              });
              await tx.workSession.updateMany({
                where: {
                  conversationId: latest.conversation.id,
                  workspaceId: input.workspaceId,
                  agentId: input.agentId,
                },
                data: { sandboxId: sandbox.id },
              });
              await tx.a2AContext.updateMany({
                where: {
                  workspaceId: input.workspaceId,
                  agentId: input.agentId,
                  targetKind: "local",
                  ...(current.sandbox
                    ? { sandboxId: current.sandbox.id }
                    : { sandboxId: null }),
                  entryBindings: {
                    some: {
                      OR: [
                        {
                          kind: { in: ["chat", "control", "channel"] },
                          sourceId: latest.conversation.id,
                        },
                        ...(work ? [{ kind: "work", sourceId: work.id }] : []),
                      ],
                    },
                  },
                },
                data: { sandboxId: sandbox.id },
              });
            }
            if (latest.context)
              await tx.a2AContext.update({
                where: { id: latest.context.id },
                data: { sandboxId: sandbox.id },
              });
            await tx.piSessionPackageSet.updateMany({
              where: {
                OR: [
                  {
                    conversation: {
                      agentId: input.agentId,
                      agent: { workspaceId: input.workspaceId },
                      sandboxId: sandbox.id,
                    },
                  },
                  {
                    context: {
                      agentId: input.agentId,
                      workspaceId: input.workspaceId,
                      targetKind: "local",
                      sandboxId: sandbox.id,
                    },
                  },
                ],
              },
              data: { sandboxId: sandbox.id },
            });
            if (current.sandbox) {
              const config = current.sandbox.config as Record<
                string,
                Prisma.JsonValue
              >;
              await tx.sandbox.update({
                where: { id: current.sandbox.id },
                data: {
                  config: {
                    ...config,
                    readOnly: true,
                    migrationArchive: true,
                    retainedUntilAgentDeletion: true,
                    migratedToSandboxId: sandbox.id,
                  } as Prisma.InputJsonValue,
                },
              });
            }
          });
        };
        if (current.sandbox)
          await enqueueSandboxOperation(
            input.workspaceId,
            current.sandbox.id,
            initialize,
          );
        else await initialize();
      } else {
        await bindExistingOwners();
      }
      const environmentVariables = await authorize();
      if (liveStatus(sandbox.deploymentId) !== "running") {
        const deployment = await db.deployment.findUniqueOrThrow({
          where: { id: sandbox.deploymentId },
        });
        const spec = resolveSpawnSpec(deployment);
        if (spec.kind !== "sandbox")
          throw new Error("Invalid session sandbox deployment.");
        spec.env = environmentVariables;
        allowProcessRestart(deployment.id);
        await startProcess(deployment.id, spec, {
          awaitReady: true,
          workspaceId: input.workspaceId,
        });
      }
      accesses.set(sandbox.id, {
        active: accesses.get(sandbox.id)?.active ?? 0,
        usedAt: Date.now(),
      });
      return destination;
    },
  );
  if (!result) throw new Error("Workspace is being deleted.");
  return result;
}
export async function stopAgentSandboxSessionMcp(
  sandboxId: string,
  workspaceId: string,
): Promise<void> {
  assertRuntimeOwner();
  const [conversations, contexts] = await Promise.all([
    db.conversation.findMany({ where: { sandboxId, agent: { workspaceId } } }),
    db.a2AContext.findMany({
      where: { sandboxId, workspaceId, targetKind: "local" },
    }),
  ]);
  for (const session of conversations) {
    if (session.agentRevisionId)
      await stopSessionMcp({
        workspaceId,
        agentId: session.agentId,
        agentRevisionId: session.agentRevisionId,
        conversationId: session.id,
      });
  }
  for (const session of contexts) {
    if (session.agentRevisionId && session.agentId)
      await stopSessionMcp({
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        agentRevisionId: session.agentRevisionId,
        a2aContextId: session.id,
      });
  }
}

async function removeManagedSandbox(
  sandboxId: string,
  workspaceId: string,
): Promise<void> {
  const result = await enqueueSandboxOperation(
    workspaceId,
    sandboxId,
    async () => {
      const sandbox = await db.sandbox.findFirst({
        where: { id: sandboxId, workspaceId },
        include: {
          snapshots: true,
          workSessions: {
            where: {
              status: { in: ["queued", "running"] },
            },
            take: 1,
          },
          a2aContexts: {
            include: { tasks: { where: { completedAt: null }, take: 1 } },
          },
        },
      });
      if (!sandbox) return true;
      if (!managed(sandbox.config))
        throw new Error("Not a managed conversation sandbox.");
      if (accesses.get(sandbox.id)?.active)
        throw new Error(
          "Conversation sandbox has active file or terminal access.",
        );
      if (
        sandbox.workSessions.length ||
        sandbox.a2aContexts.some((context) => context.tasks.length)
      )
        throw new Error(
          "Conversation sandbox still has queued or active work; cancel it before deletion.",
        );
      await db.deployment.update({
        where: { id: sandbox.deploymentId },
        data: { status: "deleting" },
      });
      await stopAgentSandboxSessionMcp(sandbox.id, workspaceId);
      await killProcess(sandbox.deploymentId, {
        preventRestart: true,
        finalStatus: "deleting",
      });
      for (const snapshot of sandbox.snapshots)
        await removeDockerVolumeStrict(snapshot.volumeName);
      await removeDockerSandboxRuntimeStrict(
        sandbox.id,
        sandboxVolumeName(sandbox.id),
      );
      await db.$transaction(async (tx) => {
        // Delete owners, never detach a surviving conversation and allow a later
        // turn to recreate an empty workspace after partially successful cleanup.
        await tx.conversation.deleteMany({
          where: { sandboxId: sandbox.id, agent: { workspaceId } },
        });
        await tx.a2AContext.deleteMany({
          where: { sandboxId: sandbox.id, workspaceId },
        });
        await tx.deployment.delete({ where: { id: sandbox.deploymentId } });
      });
      accesses.delete(sandbox.id);
      return true;
    },
  );
  if (!result) throw new Error("Workspace is being deleted.");
}

export async function deleteAgentConversationSandboxes(
  input: { workspaceId: string; agentId: string; conversationId?: string },
  afterCleanup?: () => Promise<void>,
): Promise<void> {
  await withAgentMaintenanceLease(input.agentId, () =>
    trackRuntimeOperation(async () => {
      if (input.conversationId) {
        const found = await binding(db, {
          ...input,
          conversationId: input.conversationId,
        });
        const conversation = found.conversation;
        const cleanup =
          afterCleanup ??
          (async () => {
            await db.conversation.deleteMany({
              where: {
                id: input.conversationId,
                agentId: input.agentId,
                agent: { workspaceId: input.workspaceId },
              },
            });
          });
        if (conversation?.agentRevisionId)
          await stopSessionMcp({
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            conversationId: conversation.id,
            agentRevisionId: conversation.agentRevisionId,
          });
        if (conversation) {
          const work = await db.workSession.findFirst({
            where: {
              conversationId: conversation.id,
              workspaceId: input.workspaceId,
              agentId: input.agentId,
            },
            select: { id: true },
          });
          const contexts = await db.a2AContext.findMany({
            where: {
              workspaceId: input.workspaceId,
              agentId: input.agentId,
              targetKind: "local",
              sandboxId: found.sandbox?.id,
              entryBindings: {
                some: {
                  OR: [
                    {
                      kind: { in: ["chat", "control", "channel"] },
                      sourceId: conversation.id,
                    },
                    ...(work ? [{ kind: "work", sourceId: work.id }] : []),
                  ],
                },
              },
            },
          });
          for (const context of contexts)
            if (context.agentRevisionId)
              await stopSessionMcp({
                workspaceId: input.workspaceId,
                agentId: input.agentId,
                a2aContextId: context.id,
                agentRevisionId: context.agentRevisionId,
              });
        }
        if (found.sandbox && conversation) {
          const sandbox = found.sandbox;
          const result = await enqueueSandboxOperation(
            input.workspaceId,
            sandbox.id,
            async () => {
              const row = await db.sandbox.findFirstOrThrow({
                where: { id: sandbox.id, workspaceId: input.workspaceId },
              });
              const config = row.config as Record<string, Prisma.JsonValue>;
              if (config.scope !== "agent") {
                // A legacy volume is an indivisible recovery source; deleting one
                // owner cannot discard another Context's retained work/history.
                await killProcess(sandbox.deploymentId, {
                  preventRestart: true,
                  finalStatus: "stopped",
                });
                await stopDockerSandboxContainer(sandbox.id);
                await db.sandbox.update({
                  where: { id: sandbox.id },
                  data: {
                    config: {
                      ...config,
                      readOnly: true,
                      migrationArchive: true,
                      retainedUntilAgentDeletion: true,
                    } as Prisma.InputJsonValue,
                  },
                });
                await cleanup();
                return true;
              }
              if (liveStatus(sandbox.deploymentId) === "running") {
                const port = livePort(sandbox.deploymentId);
                if (!port)
                  throw new Error(
                    "Cannot prove conversation terminal idleness.",
                  );
                const response = await fetch(
                  `http://127.0.0.1:${port}/terminal/activity`,
                  { signal: AbortSignal.timeout(5000) },
                );
                if (
                  !response.ok ||
                  ((await response.json()) as { active?: unknown }).active !== 0
                )
                  throw new Error(
                    "Conversation sandbox has active terminal sessions.",
                  );
              }
              const pending = new Set(
                Array.isArray(config.pendingWorkspaceDeletes)
                  ? config.pendingWorkspaceDeletes.filter(
                      (id): id is string => typeof id === "string",
                    )
                  : [],
              );
              pending.add(conversation.id);
              await db.sandbox.update({
                where: { id: sandbox.id },
                data: {
                  config: {
                    ...config,
                    pendingWorkspaceDeletes: [...pending],
                  } as Prisma.InputJsonValue,
                },
              });
              await stopAgentSessionRuntime({
                workspaceId: input.workspaceId,
                agentId: input.agentId,
                sandboxId: sandbox.id,
                conversationId: conversation.id,
              });
              await removeDockerSessionWorkspace(
                sandboxVolumeName(sandbox.id),
                agentSessionWorkspaceRoot({
                  conversationId: conversation.id,
                }).slice("/workspace/".length),
              );
              await cleanup();
              pending.delete(conversation.id);
              await db.sandbox.update({
                where: { id: sandbox.id },
                data: {
                  config: {
                    ...config,
                    pendingWorkspaceDeletes: [...pending],
                  } as Prisma.InputJsonValue,
                },
              });
              return true;
            },
          );
          if (!result) throw new Error("Workspace is being deleted.");
        } else await cleanup();
        return;
      }
      const sandboxes = await db.sandbox.findMany({
        where: {
          workspaceId: input.workspaceId,
          config: { path: ["managedBy"], equals: "agent-conversation" },
          ...(input.conversationId
            ? {
                conversations: {
                  some: { id: input.conversationId, agentId: input.agentId },
                },
              }
            : {}),
        },
      });
      for (const sandbox of sandboxes)
        if (managed(sandbox.config)?.agentId === input.agentId)
          await removeManagedSandbox(sandbox.id, input.workspaceId);
      await afterCleanup?.();
    }),
  );
}

export async function deleteAgentContextSandbox(input: {
  workspaceId: string;
  agentId: string;
  contextId: string;
}): Promise<void> {
  assertRuntimeOwner();
  const context = await db.a2AContext.findFirst({
    where: {
      id: input.contextId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    },
    include: {
      sandbox: { include: { conversations: true, a2aContexts: true } },
    },
  });
  if (!context?.sandbox) return;
  if (managed(context.sandbox.config)?.agentId !== input.agentId)
    throw new Error("Invalid context sandbox.");
  if (context.agentRevisionId)
    await stopSessionMcp({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      a2aContextId: context.id,
      agentRevisionId: context.agentRevisionId,
    });
  // Releasing a Context must never remove the Agent's shared volume or detach
  // another identity. Its historical mapping remains available to readers.
}

export async function stopIdleAgentConversationSandboxes(): Promise<void> {
  assertRuntimeOwner();
  const { enabled: autoStopEnabled } = await getAgentSandboxAutoStopSettings();
  const idleBefore = Date.now() - 15 * 60_000;
  const sandboxes = await db.sandbox.findMany({
    where: { config: { path: ["managedBy"], equals: "agent-conversation" } },
    include: {
      deployment: true,
      conversations: true,
      workSessions: {
        where: { status: { in: ["queued", "running"] } },
        take: 1,
      },
      a2aContexts: {
        include: {
          tasks: {
            where: {
              OR: [
                { completedAt: null },
                {
                  nativeOperationId: { not: null },
                  state: { in: [1, 2, 3, 6, 8] },
                },
              ],
            },
            take: 1,
          },
        },
      },
    },
  });
  for (const sandbox of sandboxes) {
    const config = managed(sandbox.config);
    if (
      !config ||
      (sandbox.config as Record<string, unknown> | null)?.migrationArchive ===
        true ||
      agentExecutionBusy(config.agentId) ||
      sandboxExecutionBusy(sandbox.id) ||
      accesses.get(sandbox.id)?.active ||
      sandbox.workSessions.length ||
      sandbox.a2aContexts.some((context) => context.tasks.length > 0)
    )
      continue;
    await withAgentMaintenanceLease(config.agentId, async () => {
      if (sandbox.deployment.status === "deleting") {
        await removeManagedSandbox(sandbox.id, sandbox.workspaceId);
      } else if (
        sandbox.deployment.status === "stopping" ||
        (sandbox.deployment.status === "running" &&
          autoStopEnabled &&
          (accesses.get(sandbox.id)?.usedAt ??
            sandbox.deployment.updatedAt.getTime()) < idleBefore)
      ) {
        await enqueueSandboxOperation(
          sandbox.workspaceId,
          sandbox.id,
          async () => {
            if (accesses.get(sandbox.id)?.active) return;
            if (sandbox.deployment.status !== "stopping") {
              const port = livePort(sandbox.deploymentId);
              if (!port) return;
              const response = await fetch(
                `http://127.0.0.1:${port}/terminal/activity`,
                { signal: AbortSignal.timeout(5000) },
              );
              if (!response.ok) return; // Older bridges cannot prove PTY idleness.
              const activity = (await response.json()) as { active?: unknown };
              if (activity.active !== 0) return;
            }
            await db.deployment.update({
              where: { id: sandbox.deploymentId },
              data: { status: "stopping" },
            });
            await stopAgentSandboxSessionMcp(sandbox.id, sandbox.workspaceId);
            await killProcess(sandbox.deploymentId, {
              finalStatus: "stopping",
            });
            await stopDockerSandboxContainer(sandbox.id);
            await db.deployment.update({
              where: { id: sandbox.deploymentId },
              data: { status: "stopped" },
            });
          },
        );
      }
    });
  }
}
