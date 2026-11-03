import "server-only";
import type { Prisma } from "@prisma/client";
import { TaskState } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { assertLocalGrant } from "@/lib/a2a/local-policy";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { lockTask } from "@/lib/a2a/store";
import { refreshTaskStorage, A2AQuotaError } from "@/lib/a2a/quotas";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import type { ConsoleActor } from "@/lib/a2a/console-service";
import {
  applyNativeUiAction,
  nativeUiView,
  nativeUiProjection,
  respondNativeUi,
  NativeUiProjectionLimitError,
  type NativeUiAction,
  type NativeUiResponse,
} from "./native-ui";
import type { z } from "zod";

async function live(tx: Prisma.TransactionClient, id: string, lease: string) {
  const row = await lockTask(tx, id);
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    row.leaseToken !== lease ||
    row.phase !== "executing" ||
    row.cancelRequestedAt ||
    row.deadlineAt <= new Date() ||
    row.state !== TaskState.TASK_STATE_WORKING
  )
    throw new TaskNotFoundError();
  await assertLocalGrant(grant, tx);
  return { row, grant };
}
export async function updateTaskUi(
  token: AgentRuntimeTokenPayload,
  input: z.infer<typeof NativeUiAction>,
) {
  await assertLocalRuntimeToken(token);
  if (!token.a2aTaskId || !token.a2aLeaseToken) throw new TaskNotFoundError();
  const taskId = token.a2aTaskId,
    lease = token.a2aLeaseToken;
  return db.$transaction(async (tx) => {
    const { row, grant } = await live(tx, taskId, lease);
    const work =
      grant.entryPolicy?.kind === "work" && !grant.ancestorTaskIds.length
        ? await tx.workSession.findFirst({
            where: {
              id: grant.entryPolicy.sourceId,
              workspaceId: grant.workspaceId,
              agentId: grant.agentId,
              agentRevisionId: grant.agentRevisionId,
              a2aActorId: grant.actorId,
              conversationId: token.conversationId,
              sandboxId: token.sandboxId,
              status: "running",
              cancelRequestedAt: null,
            },
          })
        : null;
    if (
      grant.entryPolicy?.kind === "work" &&
      !grant.ancestorTaskIds.length &&
      !work
    )
      throw new TaskNotFoundError();
    const { projection, result } = applyNativeUiAction(
      work && !nativeUiProjection(row.uiProjection).lease
        ? { ...nativeUiProjection(work.uiProjection), activities: [] }
        : row.uiProjection,
      lease,
      row.deadlineAt.getTime(),
      input,
    );
    if (input.action !== "poll") {
      await tx.a2ATask.update({
        where: { id: taskId },
        data: { uiProjection: projection as unknown as Prisma.InputJsonValue },
      });
      if (work)
        await tx.workSession.update({
          where: { id: work.id },
          data: {
            uiLease: lease,
            uiProjection: projection as unknown as Prisma.InputJsonValue,
          },
        });
      try {
        await refreshTaskStorage(tx, taskId);
      } catch (error) {
        if (error instanceof A2AQuotaError)
          throw new NativeUiProjectionLimitError(
            "Task display storage quota exhausted.",
          );
        throw error;
      }
    }
    return result;
  });
}
export async function readTaskUi(
  ctx: ConsoleActor,
  rootTaskId: string,
  taskId: string,
) {
  await getConsoleTaskTree(ctx, rootTaskId, taskId);
  const row = await db.a2ATask.findUniqueOrThrow({ where: { id: taskId } });
  const grant = row.grant as unknown as TaskGrant;
  if (
    !isLocalGrant(grant) ||
    grant.actorId !== ctx.actorId ||
    grant.workspaceId !== ctx.workspaceId ||
    row.rootTaskId !== rootTaskId
  )
    throw new TaskNotFoundError();
  if (
    row.leaseToken &&
    row.phase === "executing" &&
    row.state === TaskState.TASK_STATE_WORKING &&
    !row.cancelRequestedAt &&
    row.deadlineAt > new Date()
  )
    await db.$transaction((tx) => live(tx, row.id, row.leaseToken as string));
  return {
    row,
    ...nativeUiView(
      row.uiProjection,
      row.leaseToken,
      row.phase === "executing" &&
        row.state === TaskState.TASK_STATE_WORKING &&
        !row.cancelRequestedAt &&
        row.deadlineAt > new Date(),
    ),
  };
}
export async function respondTaskUi(
  ctx: ConsoleActor,
  rootTaskId: string,
  taskId: string,
  response: z.infer<typeof NativeUiResponse>,
) {
  await getConsoleTaskTree(ctx, rootTaskId, taskId);
  return db.$transaction(async (tx) => {
    const initial = await tx.a2ATask.findUniqueOrThrow({
      where: { id: taskId },
    });
    if (!initial.leaseToken) throw new TaskNotFoundError();
    const { row, grant } = await live(tx, taskId, initial.leaseToken);
    if (
      grant.actorId !== ctx.actorId ||
      grant.workspaceId !== ctx.workspaceId ||
      row.rootTaskId !== rootTaskId
    )
      throw new TaskNotFoundError();
    const projection = respondNativeUi(
      row.uiProjection,
      initial.leaseToken,
      response,
    );
    await tx.a2ATask.update({
      where: { id: taskId },
      data: { uiProjection: projection as unknown as Prisma.InputJsonValue },
    });
    try {
      await refreshTaskStorage(tx, taskId);
    } catch (error) {
      if (error instanceof A2AQuotaError)
        throw new NativeUiProjectionLimitError(
          "Task display storage quota exhausted.",
        );
      throw error;
    }
  });
}
