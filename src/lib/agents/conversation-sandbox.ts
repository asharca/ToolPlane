import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
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
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import {
  assertDockerVolumeExists,
  copyDockerVolume,
  removeDockerSandboxRuntimeStrict,
  removeDockerVolumeStrict,
  sandboxVolumeName,
  setDockerSandboxPaused,
  stopDockerSandboxContainer,
} from "@/lib/sandboxes/runtime";
import { readSandboxAllowSudo, readSandboxEnv } from "@/lib/sandboxes/env";
import {
  agentExecutionBusy,
  withAgentMaintenanceLease,
} from "./agent-execution-gate";
import { sandboxExecutionBusy } from "./sandbox-execution-gate";

export type AgentConversationSandboxInput = {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  contextId?: string;
};
export type AgentConversationSandbox = {
  sandboxId: string;
  deploymentId: string;
};
type ManagedConfig = {
  managedBy: string;
  agentId: string;
  sourceSandboxId: string;
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
  cleanup = false,
) {
  if (!input.conversationId && !input.contextId)
    throw new Error("Conversation or native context is required.");
  const agent = await tx.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    include: {
      sandboxes: { include: { sandbox: { include: { deployment: true } } } },
    },
  });
  if (!agent) throw new Error("Agent not found in workspace.");
  const source =
    agent.sandboxes.length === 1 ? agent.sandboxes[0].sandbox : null;
  if (
    !cleanup &&
    (!source ||
      source.workspaceId !== input.workspaceId ||
      source.kind !== "docker")
  )
    throw new Error("Agent requires exactly one assigned Docker sandbox.");
  const conversation = input.conversationId
    ? await tx.conversation.findFirst({
        where: {
          id: input.conversationId,
          agentId: input.agentId,
          agent: { workspaceId: input.workspaceId },
        },
      })
    : null;
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
  if ((input.conversationId && !conversation) || (input.contextId && !context))
    throw new Error("Conversation/context does not belong to this Agent.");
  if (conversation && context) {
    const entries = context.entryBindings;
    let matches = entries.some(
      (entry) =>
        ["chat", "control", "channel"].includes(entry.kind) &&
        entry.sourceId === conversation.id,
    );
    if (!matches) {
      const workIds = entries
        .filter((entry) => entry.kind === "work")
        .map((entry) => entry.sourceId);
      matches =
        workIds.length > 0 &&
        !!(await tx.workSession.findFirst({
          where: {
            id: { in: workIds },
            conversationId: conversation.id,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
          },
        }));
    }
    if (!matches)
      throw new Error("Native context is not bound to this conversation.");
  }
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
  if (ids.length) {
    const config = sandbox && managed(sandbox.config);
    if (
      sandbox?.kind !== "docker" ||
      config?.agentId !== input.agentId ||
      (!cleanup && config.sourceSandboxId !== source?.id)
    )
      throw new Error("Conversation sandbox binding is invalid.");
  }
  return { conversation, context, source, sandbox };
}

export async function findAgentConversationSandbox(
  input: AgentConversationSandboxInput & { cleanup?: boolean },
): Promise<AgentConversationSandbox | null> {
  if (input.cleanup) assertRuntimeOwner();
  const found = await binding(db, input, input.cleanup);
  return found.sandbox
    ? { sandboxId: found.sandbox.id, deploymentId: found.sandbox.deploymentId }
    : null;
}

export async function ensureAgentConversationSandbox(
  input: AgentConversationSandboxInput & { signal?: AbortSignal },
): Promise<AgentConversationSandbox> {
  assertRuntimeOwner();
  input.signal?.throwIfAborted();
  const initial = await binding(db, input);
  if (!initial.source) throw new Error("Agent sandbox source is unavailable.");
  const sourceId = initial.source.id;
  const prepare = async () => {
    input.signal?.throwIfAborted();
    if (!initial.sandbox) {
      const cfg = initial.source?.deployment.installCfg as {
        volumeName?: string;
      } | null;
      await assertDockerVolumeExists(
        cfg?.volumeName || sandboxVolumeName(sourceId),
      );
    }
    const allocated = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${input.agentId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`;
      const current = await binding(tx, input);
      if (!current.source || current.source.id !== sourceId)
        throw new Error("Agent sandbox assignment changed.");
      if (
        !current.sandbox &&
        [
          "provisioning",
          "copying",
          "copy_failed",
          "restoring",
          "restore_failed",
          "restore_cleanup_required",
          "upgrading",
          "deleting",
        ].includes(current.source.deployment.status)
      )
        throw new Error("Agent sandbox source requires recovery.");
      if (current.sandbox) {
        if (current.conversation && !current.conversation.sandboxId)
          await tx.conversation.update({
            where: { id: current.conversation.id },
            data: { sandboxId: current.sandbox.id },
          });
        if (current.context && !current.context.sandboxId)
          await tx.a2AContext.update({
            where: { id: current.context.id },
            data: { sandboxId: current.sandbox.id },
          });
        return {
          sandbox: current.sandbox,
          source: current.source,
          created: false,
        };
      }
      const id = randomUUID();
      const sourceConfig =
        current.source.config &&
        typeof current.source.config === "object" &&
        !Array.isArray(current.source.config)
          ? current.source.config
          : {};
      const config = {
        ...sourceConfig,
        managedBy: "agent-conversation",
        agentId: input.agentId,
        sourceSandboxId: current.source.id,
      };
      const deployment = await tx.deployment.create({
        data: {
          workspaceId: input.workspaceId,
          name: `Conversation sandbox: ${input.agentId}`,
          source: "sandbox",
          sourceRef: current.source.image,
          status: "copying",
          installCfg: {
            sandboxId: id,
            kind: "docker",
            image: current.source.image,
            network: current.source.network,
            volumeName: sandboxVolumeName(id),
            env: readSandboxEnv(config),
            allowSudo: readSandboxAllowSudo(config),
          },
        },
      });
      const sandbox = await tx.sandbox.create({
        data: {
          id,
          workspaceId: input.workspaceId,
          deploymentId: deployment.id,
          name: `Conversation ${input.conversationId ?? input.contextId}`,
          slug: `conversation-${id}`,
          kind: "docker",
          image: current.source.image,
          network: current.source.network,
          config,
        },
        include: { deployment: true },
      });
      if (current.conversation)
        await tx.conversation.update({
          where: { id: current.conversation.id },
          data: { sandboxId: id },
        });
      if (current.context)
        await tx.a2AContext.update({
          where: { id: current.context.id },
          data: { sandboxId: id },
        });
      return { sandbox, source: current.source, created: true };
    });
    const { sandbox, source, created } = allocated;
    if (created) {
      try {
        if (accesses.get(source.id)?.active)
          throw new Error("Source sandbox has active file or terminal access.");
        const cfg =
          source.deployment.installCfg &&
          typeof source.deployment.installCfg === "object" &&
          !Array.isArray(source.deployment.installCfg)
            ? source.deployment.installCfg
            : {};
        // Persist intent before freezing: owner recovery must unpause even when
        // the copying process dies before its finally block can run.
        await db.deployment.update({
          where: { id: source.deploymentId },
          data: {
            installCfg: { ...cfg, agentConversationSnapshotPaused: true },
          },
        });
        try {
          await setDockerSandboxPaused(source.id, true);
          await copyDockerVolume(
            typeof cfg.volumeName === "string"
              ? cfg.volumeName
              : sandboxVolumeName(source.id),
            sandboxVolumeName(sandbox.id),
          );
          await db.deployment.update({
            where: { id: sandbox.deploymentId },
            data: { status: "provisioning" },
          });
        } finally {
          await setDockerSandboxPaused(source.id, false);
          await db.deployment.update({
            where: { id: source.deploymentId },
            data: { installCfg: cfg as Prisma.InputJsonObject },
          });
        }
      } catch (error) {
        await db.deployment.update({
          where: { id: sandbox.deploymentId },
          data: { status: "copy_failed" },
        });
        throw error;
      }
    } else if (
      [
        "copying",
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
    input.signal?.throwIfAborted();
    if (
      sandbox.deployment.status === "running" &&
      liveStatus(sandbox.deploymentId) === "running"
    ) {
      const finish = beginWorkspaceOperation(input.workspaceId);
      if (!finish) throw new Error("Workspace is being deleted.");
      let release: (() => void) | undefined;
      try {
        release = beginAgentConversationSandboxAccess(sandbox.id);
        await assertDockerVolumeExists(sandboxVolumeName(sandbox.id));
        return { sandboxId: sandbox.id, deploymentId: sandbox.deploymentId };
      } finally {
        release?.();
        finish();
      }
    }
    await enqueueSandboxOperation(input.workspaceId, sandbox.id, async () => {
      await assertDockerVolumeExists(sandboxVolumeName(sandbox.id));
      const deployment = await db.deployment.findUniqueOrThrow({
        where: { id: sandbox.deploymentId },
      });
      allowProcessRestart(deployment.id);
      await startProcess(deployment.id, resolveSpawnSpec(deployment), {
        awaitReady: true,
        workspaceId: input.workspaceId,
      });
      accesses.set(sandbox.id, {
        active: accesses.get(sandbox.id)?.active ?? 0,
        usedAt: Date.now(),
      });
    });
    return { sandboxId: sandbox.id, deploymentId: sandbox.deploymentId };
  };
  const result = initial.sandbox
    ? await prepare()
    : await enqueueSandboxOperation(input.workspaceId, sourceId, prepare);
  if (!result) throw new Error("Workspace is being deleted.");
  return result;
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
              status: { in: ["queued", "running", "waiting_approval"] },
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
  if (
    context.sandbox.conversations.length ||
    context.sandbox.a2aContexts.length > 1
  ) {
    await db.a2AContext.update({
      where: { id: context.id },
      data: { sandboxId: null },
    });
    return;
  }
  await withAgentMaintenanceLease(input.agentId, () =>
    removeManagedSandbox(context.sandboxId as string, input.workspaceId),
  );
}

export async function stopIdleAgentConversationSandboxes(): Promise<void> {
  assertRuntimeOwner();
  const idleBefore = Date.now() - 15 * 60_000;
  const sandboxes = await db.sandbox.findMany({
    where: { config: { path: ["managedBy"], equals: "agent-conversation" } },
    include: {
      deployment: true,
      conversations: true,
      workSessions: {
        where: { status: { in: ["queued", "running", "waiting_approval"] } },
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
      agentExecutionBusy(config.agentId) ||
      sandboxExecutionBusy(sandbox.id) ||
      accesses.get(sandbox.id)?.active ||
      sandbox.workSessions.length ||
      sandbox.a2aContexts.some((context) => context.tasks.length > 0)
    )
      continue;
    await withAgentMaintenanceLease(config.agentId, async () => {
      if (
        sandbox.deployment.status === "deleting" ||
        (!sandbox.conversations.length && !sandbox.a2aContexts.length)
      ) {
        await removeManagedSandbox(sandbox.id, sandbox.workspaceId);
      } else if (
        sandbox.deployment.status === "stopping" ||
        (sandbox.deployment.status === "running" &&
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
