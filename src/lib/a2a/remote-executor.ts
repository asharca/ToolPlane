import "server-only";
import { createHash } from "node:crypto";
import {
  Artifact,
  Part,
  AgentCard,
  Message,
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
  Task,
  TaskState,
  type SendMessageResult,
} from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { db } from "@/lib/db";
import {
  runtimeCanOperate,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { withLogContext } from "@/lib/observability/context";
import { createRemoteClient, remoteResult } from "./remote-client";
import { remoteCredential } from "./remote-registry";
import { assertRemoteGrant } from "./remote-policy";
import { isRemoteGrant, type TaskGrant } from "./principal";
import { RemoteA2AError } from "./remote-network";
import {
  lockTask,
  persist,
  transition,
  interruptTask,
  recordTaskSettled,
} from "./store";
import {
  terminal,
  settled,
  taskEvent,
  acceptsOutput,
  stampArtifactProvenance,
} from "./model";
import type { TaskExecutor } from "@/lib/agents/execution/executor";
import { prepareTaskFileParts, stageTaskFileTransfers } from "./task-files";
import { assertTaskFileReadAuthority, hydrateTaskParts } from "./files";
import { runtimeEnv } from "@/lib/runtime-env";
import { validateSend } from "./validation";

async function clientFor(
  row: A2ATask,
  cancellation = false,
  fileReception = false,
) {
  const grant = row.grant as unknown as TaskGrant;
  if (!isRemoteGrant(grant)) throw new RemoteA2AError();
  if (fileReception) await assertTaskFileReadAuthority(row.id);
  else await assertRemoteGrant(grant, db, cancellation);
  const remote = await db.remoteA2AAgent.findFirstOrThrow({
    where: { id: grant.remoteAgentId, workspaceId: grant.workspaceId },
  });
  // Check again after loading: a concurrent reconfiguration must not send a previous task to a new identity.
  if (fileReception) await assertTaskFileReadAuthority(row.id);
  else await assertRemoteGrant(grant, db, cancellation);
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        remote.id,
        remote.workspaceId,
        remote.revision,
        remote.cardUrl,
        remote.rpcUrl,
      ]),
    )
    .digest("hex");
  if (binding !== grant.targetBinding) throw new RemoteA2AError();
  return createRemoteClient(
    AgentCard.fromJSON(remote.card),
    remote.rpcUrl,
    remoteCredential(remote),
    {
      grant,
      taskId: row.id,
      contextId: row.contextId,
      rootTaskId: row.rootTaskId ?? row.id,
      parentTaskId: row.parentTaskId ?? undefined,
    },
  );
}
/** Poll observations persist an event only when the projected task content changes. */
function observationFingerprint(task: Task) {
  return JSON.stringify([
    task.status?.state,
    task.status?.message ? Message.toJSON(task.status.message) : null,
    task.artifacts.map((artifact) => Artifact.toJSON(artifact)),
    task.metadata ?? null,
  ]);
}
async function recordObservation(
  id: string,
  result: SendMessageResult,
  expectedLease?: string,
  expectedMessageId?: string,
) {
  const observation = remoteResult(result);
  let receiveFiles = false;
  const committed = await db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    if (
      terminal(row.state) ||
      (expectedLease && row.leaseToken !== expectedLease) ||
      (!expectedLease &&
        (row.phase !== "remote-waiting" ||
          row.remoteMessageId !== expectedMessageId))
    )
      return;
    const grant = row.grant as unknown as TaskGrant;
    if (!isRemoteGrant(grant)) throw new RemoteA2AError();
    await assertRemoteGrant(grant, tx, Boolean(row.cancelRequestedAt));
    if (row.deadlineAt <= new Date()) throw new RemoteA2AError();
    if (
      (row.remoteTaskId && row.remoteTaskId !== observation.taskId) ||
      (row.remoteContextId && row.remoteContextId !== observation.contextId)
    )
      throw new RemoteA2AError("Remote task binding changed.");
    const remote = await tx.remoteA2AAgent.findFirstOrThrow({
      where: { id: grant.remoteAgentId, workspaceId: grant.workspaceId },
    });
    const card = AgentCard.fromJSON(remote.card);
    const acceptedModes =
      SendMessageRequest.fromJSON(row.request).configuration
        ?.acceptedOutputModes ?? [];
    const allParts = [
      ...observation.artifacts.flatMap((artifact) => artifact.parts),
      ...(observation.message?.parts ?? []),
    ];
    if (
      allParts.some(
        (part) =>
          !acceptsOutput(
            card.defaultOutputModes,
            part.mediaType || "text/plain",
          ) || !acceptsOutput(acceptedModes, part.mediaType || "text/plain"),
      )
    )
      throw new RemoteA2AError("Remote output MIME type was not negotiated.");
    const context = await tx.a2AContext.findUniqueOrThrow({
      where: { id: row.contextId },
    });
    const task = Task.fromJSON(row.snapshot);
    const previous = observationFingerprint(task);
    for (const remoteArtifact of observation.artifacts) {
      const artifactId = createHash("sha256")
        .update(
          JSON.stringify([
            "remote-artifact",
            row.id,
            observation.taskId,
            remoteArtifact.artifactId,
          ]),
        )
        .digest("hex");
      const parts = await prepareTaskFileParts(
        tx,
        id,
        grant.workspaceId,
        remoteArtifact.parts,
        `output:artifact:${artifactId}`,
        context.expiresAt,
      );
      const artifact = stampArtifactProvenance(
        Artifact.fromJSON({
          artifactId,
          name: remoteArtifact.name || "result",
          parts: parts.map((part) => Part.toJSON(part)),
        }),
        {
          taskId: id,
          contextId: task.contextId,
          targetId: grant.remoteAgentId,
          targetKind: "remote",
        },
      );
      const index = task.artifacts.findIndex(
        (value) => value.artifactId === artifactId,
      );
      if (index < 0) task.artifacts.push(artifact);
      else task.artifacts[index] = artifact;
    }
    if (task.artifacts.length > 16)
      throw new RemoteA2AError("Remote artifact limit exceeded.");
    let statusMessage: Message | undefined;
    if (observation.message) {
      const messageId = createHash("sha256")
        .update(JSON.stringify([row.id, observation.message.messageId]))
        .digest("hex");
      const parts = await prepareTaskFileParts(
        tx,
        id,
        grant.workspaceId,
        observation.message.parts,
        `output:message:${messageId}`,
        context.expiresAt,
      );
      statusMessage = Message.fromJSON({
        messageId,
        taskId: id,
        contextId: row.contextId,
        role: "ROLE_AGENT",
        parts: parts.map((part) => Part.toJSON(part)),
      });
    }
    const hasFiles = allParts.some((part) => part.content?.$case !== "text");
    receiveFiles =
      hasFiles &&
      !!(await tx.a2ATaskFile.count({
        where: { taskId: id, status: { not: "ready" } },
      }));
    const observedState =
      observation.state === TaskState.TASK_STATE_SUBMITTED
        ? TaskState.TASK_STATE_WORKING
        : observation.state;
    const state = receiveFiles ? TaskState.TASK_STATE_WORKING : observedState;
    if (!terminal(observedState) && !observation.taskId)
      throw new RemoteA2AError();
    if (!task.status) throw new RemoteA2AError();
    if (task.status.state !== state) {
      // A peer may resume externally resolved input/auth without a local model round.
      if (
        [6, 8].includes(task.status.state) &&
        state === TaskState.TASK_STATE_WORKING
      )
        transition(task, TaskState.TASK_STATE_SUBMITTED);
      transition(task, state);
    }
    task.status = { ...task.status, state, message: statusMessage };
    // Keep the peer's actual state separate from the local scheduling projection.
    task.metadata = {
      ...task.metadata,
      toolplaneRemote: {
        state: TaskState[observation.state],
        outcome: "observed",
      },
      toolplaneFileDelivery: {
        state: receiveFiles ? "pending" : "ready",
        remoteState: observedState,
      },
    };
    const changed = observationFingerprint(task) !== previous;
    if (changed) task.status.timestamp = new Date().toISOString();
    const fields = {
      remoteTaskId: observation.taskId,
      remoteContextId: observation.contextId,
      remoteObservedState: observedState,
      remoteFilesStatus: receiveFiles ? "pending" : "ready",
      remotePollAt: new Date(Date.now() + 2000),
      remotePollFailures: 0,
      leaseToken: null,
      phase: receiveFiles
        ? "remote-file-receiving"
        : terminal(state)
          ? "done"
          : "remote-waiting",
    };
    const updated =
      changed || terminal(state) || expectedLease
        ? await persist(tx, row, task, taskEvent(task), fields)
        : await tx.a2ATask.update({ where: { id }, data: fields });
    if (row.state !== updated.state && settled(updated.state)) return updated;
  });
  if (receiveFiles) await stageTaskFileTransfers(id);
  if (committed) await recordTaskSettled(committed);
}
/** Submit exactly once per accepted local message. Subsequent work uses GetTask, not SendMessage retries. */
export const executeRemoteTask: TaskExecutor = async (row, signal) => {
  const grant = row.grant as unknown as TaskGrant;
  if (!isRemoteGrant(grant) || !row.leaseToken) throw new RemoteA2AError();
  const client = await clientFor(row);
  const input = SendMessageRequest.fromJSON(row.request);
  const message = input.message;
  if (!message) throw new RemoteA2AError();
  const outboundId = createHash("sha256")
    .update(
      JSON.stringify(["a2a-remote-message", grant.ownerKey, message.messageId]),
    )
    .digest("hex");
  const remote = await db.remoteA2AAgent.findFirstOrThrow({
    where: { id: grant.remoteAgentId, workspaceId: grant.workspaceId },
  });
  const card = AgentCard.fromJSON(remote.card);
  validateSend(input, card.defaultOutputModes);
  if (
    message.parts.some(
      (part) =>
        !acceptsOutput(card.defaultInputModes, part.mediaType || "text/plain"),
    )
  )
    throw new RemoteA2AError(
      "Remote Agent does not accept an input MIME type.",
    );
  const parts = await hydrateTaskParts(
    row.id,
    message.parts,
    runtimeEnv("NEXT_PUBLIC_APP_URL") || "http://localhost:3000",
  );
  await db.$transaction(async (tx) => {
    const current = await lockTask(tx, row.id);
    await assertRemoteGrant(grant, tx);
    if (
      current.leaseToken !== row.leaseToken ||
      current.cancelRequestedAt ||
      current.deadlineAt <= new Date() ||
      current.remoteMessageId === outboundId
    )
      throw new RemoteA2AError();
    await tx.a2ATask.update({
      where: { id: row.id },
      data: {
        remoteMessageId: outboundId,
        remoteDispatchedAt: new Date(),
        remoteCancelSentAt: null,
      },
    });
  });
  signal.throwIfAborted();
  // Local identity, tenant, authority metadata and unrelated task references are never forwarded.
  const request = SendMessageRequest.fromJSON({
    message: {
      messageId: outboundId,
      role: "ROLE_USER",
      parts: parts.map((part) => Part.toJSON(part)),
      ...(row.remoteTaskId
        ? { taskId: row.remoteTaskId, contextId: row.remoteContextId }
        : {}),
    },
    configuration: {
      returnImmediately: true,
      historyLength: 0,
      acceptedOutputModes: input.configuration?.acceptedOutputModes.length
        ? input.configuration.acceptedOutputModes
        : ["*/*"],
    },
  });
  const result = await client.sendMessage(request, { signal });
  await recordObservation(row.id, result, row.leaseToken);
  return { state: TaskState.TASK_STATE_WORKING, deferred: true };
};

/** File retry may refresh expiring sources through GetTask, but never calls SendMessage. */
export async function refreshRemoteTaskFileSources(
  row: A2ATask,
  signal?: AbortSignal,
) {
  if (!row.remoteTaskId || row.remoteObservedState == null) return;
  const client = await clientFor(row, false, true);
  const result = await client.getTask(
    GetTaskRequest.fromJSON({ id: row.remoteTaskId, historyLength: 0 }),
    { signal },
  );
  const observation = remoteResult(result);
  if (
    observation.taskId !== row.remoteTaskId ||
    observation.contextId !== row.remoteContextId ||
    (terminal(row.remoteObservedState) &&
      observation.state !== row.remoteObservedState)
  )
    throw new RemoteA2AError("Remote file source binding changed.");
  await assertTaskFileReadAuthority(row.id);
  await db.$transaction(async (tx) => {
    const current = await lockTask(tx, row.id);
    if (
      current.phase !== "remote-file-failed" ||
      current.remoteMessageId !== row.remoteMessageId ||
      terminal(current.state)
    )
      throw new RemoteA2AError();
    const grant = current.grant as unknown as TaskGrant;
    if (!isRemoteGrant(grant)) throw new RemoteA2AError();
    const context = await tx.a2AContext.findUniqueOrThrow({
      where: { id: row.contextId },
    });
    for (const artifact of observation.artifacts) {
      const artifactId = createHash("sha256")
        .update(
          JSON.stringify([
            "remote-artifact",
            row.id,
            observation.taskId,
            artifact.artifactId,
          ]),
        )
        .digest("hex");
      await prepareTaskFileParts(
        tx,
        row.id,
        grant.workspaceId,
        artifact.parts,
        `output:artifact:${artifactId}`,
        context.expiresAt,
        row.id,
        undefined,
        true,
      );
    }
    if (observation.message) {
      const messageId = createHash("sha256")
        .update(JSON.stringify([row.id, observation.message.messageId]))
        .digest("hex");
      await prepareTaskFileParts(
        tx,
        row.id,
        grant.workspaceId,
        observation.message.parts,
        `output:message:${messageId}`,
        context.expiresAt,
        row.id,
        undefined,
        true,
      );
    }
  });
}
let polling = false;
/** Separate bounded observer loop: remote waiting does not occupy a native model execution slot. */
export async function reconcileRemoteTasks() {
  if (polling || !runtimeCanOperate()) return;
  polling = true;
  try {
    const rows = await db.a2ATask.findMany({
      where: {
        phase: "remote-waiting",
        state: { in: [2, 6, 8] },
        OR: [{ remotePollAt: null }, { remotePollAt: { lte: new Date() } }],
      },
      orderBy: { remotePollAt: "asc" },
      take: 4,
    });
    await Promise.all(
      rows.map(async (row) => {
        const grant = row.grant as unknown as TaskGrant;
        if (!isRemoteGrant(grant)) return;
        await trackRuntimeOperation(() =>
          withLogContext(
            {
              workspaceId: grant.workspaceId,
              actorId: grant.actorId,
              agentId: grant.sourceAgentId,
              suppressPayload: true,
            },
            async () => {
              const release = beginWorkspaceOperation(grant.workspaceId);
              try {
                if (
                  !release ||
                  !row.remoteTaskId ||
                  row.deadlineAt <= new Date()
                )
                  throw new RemoteA2AError();
                const client = await clientFor(
                  row,
                  Boolean(row.cancelRequestedAt),
                );
                const ownerSignal = runtimeAbortSignal();
                const signal = AbortSignal.any([
                  AbortSignal.timeout(
                    Math.max(
                      1,
                      Math.min(15_000, row.deadlineAt.getTime() - Date.now()),
                    ),
                  ),
                  ...(ownerSignal ? [ownerSignal] : []),
                ]);
                const current = await db.a2ATask.findUniqueOrThrow({
                  where: { id: row.id },
                });
                if (
                  current.phase !== "remote-waiting" ||
                  terminal(current.state) ||
                  current.remoteMessageId !== row.remoteMessageId
                )
                  return;
                let result: Task;
                if (current.cancelRequestedAt && !current.remoteCancelSentAt) {
                  await assertRemoteGrant(grant, db, true);
                  const marked = await db.a2ATask.updateMany({
                    where: {
                      id: row.id,
                      remoteCancelSentAt: null,
                      phase: "remote-waiting",
                      remoteMessageId: row.remoteMessageId,
                    },
                    data: { remoteCancelSentAt: new Date() },
                  });
                  if (!marked.count) return;
                  try {
                    result = await client.cancelTask(
                      CancelTaskRequest.fromJSON({ id: row.remoteTaskId }),
                      { signal },
                    );
                  } catch {
                    result = await client.getTask(
                      GetTaskRequest.fromJSON({
                        id: row.remoteTaskId,
                        historyLength: 0,
                      }),
                      { signal },
                    );
                  }
                } else
                  result = await client.getTask(
                    GetTaskRequest.fromJSON({
                      id: row.remoteTaskId,
                      historyLength: 0,
                    }),
                    { signal },
                  );
                await recordObservation(
                  row.id,
                  result,
                  undefined,
                  row.remoteMessageId ?? undefined,
                );
              } catch {
                // Only failed reads get bounded retries. Never retry a business submission or unconfirmed cancellation.
                let live = true;
                try {
                  await assertRemoteGrant(
                    grant,
                    db,
                    Boolean(row.cancelRequestedAt),
                  );
                } catch {
                  live = false;
                }
                if (
                  !live ||
                  !row.remoteTaskId ||
                  row.remotePollFailures >= 4 ||
                  row.deadlineAt <= new Date()
                ) {
                  await interruptTask(row.id, "Remote observation stopped.", {
                    remoteMessageId: row.remoteMessageId,
                    phase: "remote-waiting",
                  });
                } else
                  await db.a2ATask.updateMany({
                    where: {
                      id: row.id,
                      phase: "remote-waiting",
                      remoteMessageId: row.remoteMessageId,
                    },
                    data: {
                      remotePollFailures: { increment: 1 },
                      remotePollAt: new Date(
                        Date.now() +
                          Math.min(16_000, 2000 * 2 ** row.remotePollFailures),
                      ),
                    },
                  });
              } finally {
                release?.();
              }
            },
            true,
          ),
        );
      }),
    );
  } finally {
    polling = false;
  }
}
