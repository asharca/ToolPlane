import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { getAgentForRun } from "@/lib/agents/queries";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { agentRuntimeTokenFromRequest } from "@/lib/agents/runtime-access";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { originFromRequest } from "@/lib/http/origin";
import { parseJson } from "@/lib/agents/public-api/body";
import { withLogContext } from "@/lib/observability/context";
import {
  NativeUiAction,
  NativeUiResponse,
  applyNativeUiAction,
  nativeUiProjection,
  nativeUiView,
  respondNativeUi,
} from "./native-ui";
import { uiReply, uiFailure } from "./ui-http";
import { WindowLimiter } from "@/lib/a2a/transport-limits";
import { TaskState } from "@a2a-js/sdk";
import { lockTask } from "@/lib/a2a/store";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { assertLocalGrant } from "@/lib/a2a/local-policy";
import { refreshTaskStorage } from "@/lib/a2a/quotas";
const runtimeRequests = new WindowLimiter(600, 4096);

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function withWorkUiLease<T>(
  scope: {
    conversationId?: string;
    workspaceId: string;
    agentId: string;
    agentRevisionId: string;
  },
  token: string,
  run: (enabled: boolean) => Promise<T>,
) {
  const work = scope.conversationId
    ? await db.workSession.findFirst({
        where: { ...scope, status: "running" },
        select: { id: true },
      })
    : null;
  if (!work) return run(false);
  const lease = digest(token);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WorkSession" WHERE id=${work.id} FOR UPDATE`;
    const current = await tx.workSession.findUniqueOrThrow({
      where: { id: work.id },
    });
    if (
      current.workspaceId !== scope.workspaceId ||
      current.agentId !== scope.agentId ||
      current.agentRevisionId !== scope.agentRevisionId ||
      current.status !== "running" ||
      current.cancelRequestedAt
    )
      throw new TaskNotFoundError();
    const projection = nativeUiProjection(current.uiProjection);
    projection.lease = lease;
    projection.dialogs = [];
    await tx.workSession.update({
      where: { id: work.id },
      data: {
        uiLease: lease,
        uiProjection: projection as unknown as Prisma.InputJsonValue,
      },
    });
  });
  try {
    return await run(true);
  } finally {
    await db.workSession.updateMany({
      where: { id: work.id, uiLease: lease },
      data: { uiLease: null },
    });
  }
}
export async function handleSessionUi(req: Request) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== "POST")
        return uiReply({ error: "Method not allowed." }, 405);
      if (req.headers.has("origin"))
        return uiReply({ error: "Runtime credential required." }, 403);
      const token = await agentRuntimeTokenFromRequest(req);
      const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "");
      if (!token?.conversationId || token.a2aTaskId || !bearer)
        return uiReply({ error: "Runtime credential required." }, 401);
      runtimeRequests.take(`${token.conversationId}:${digest(bearer)}`);
      if (!(await resolveAgentRuntimeGrant(token)))
        throw new TaskNotFoundError();
      if (
        req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        return uiReply({ error: "Expected JSON." }, 415);
      const input = await parseJson(req, NativeUiAction, 262_144);
      if (!input.ok)
        return uiReply(
          { error: "Invalid native UI request." },
          input.reason === "too_large" ? 413 : 400,
        );
      return await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "WorkSession" WHERE "conversationId"=${token.conversationId} FOR UPDATE`;
        if (!rows[0]) throw new TaskNotFoundError();
        const work = await tx.workSession.findUniqueOrThrow({
          where: { id: rows[0].id },
        });
        if (
          work.workspaceId !== token.workspaceId ||
          work.agentId !== token.agentId ||
          work.agentRevisionId !== token.agentRevisionId ||
          work.sandboxId !== token.sandboxId ||
          work.status !== "running" ||
          work.cancelRequestedAt ||
          work.uiLease !== digest(bearer)
        )
          throw new TaskNotFoundError();
        const { projection, result } = applyNativeUiAction(
          work.uiProjection,
          work.uiLease,
          token.exp * 1000,
          input.value,
        );
        if (input.value.action !== "poll")
          await tx.workSession.update({
            where: { id: work.id },
            data: {
              uiProjection: projection as unknown as Prisma.InputJsonValue,
            },
          });
        return uiReply(result);
      });
    } catch (error) {
      return uiFailure(error);
    }
  });
}
export async function handleWorkUi(
  req: Request,
  slug: string,
  workSessionId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!["GET", "POST"].includes(req.method))
        return uiReply({ error: "Method not allowed." }, 405);
      if (req.headers.has("authorization"))
        return uiReply({ error: "Console session required." }, 401);
      const site = req.headers.get("sec-fetch-site");
      if (
        (site && !["same-origin", "none"].includes(site)) ||
        ((req.method !== "GET" || req.headers.has("origin")) &&
          req.headers.get("origin") !== originFromRequest(req))
      )
        return uiReply({ error: "Same-origin request required." }, 403);
      if (new URL(req.url).search)
        return uiReply({ error: "Invalid query." }, 400);
      const principal = await resolveRequestPrincipal(req);
      if (
        principal?.credential !== "session" ||
        !(await db.user.count({
          where: { id: principal.user.id, status: "active" },
        }))
      )
        return uiReply({ error: "Console session required." }, 401);
      const workspace = await getWorkspaceForUser(slug, principal.user.id);
      if (workspace?.status !== "active") throw new TaskNotFoundError();
      if (
        req.method === "POST" &&
        req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
          "application/json"
      )
        return uiReply({ error: "Expected JSON." }, 415);
      const input =
        req.method === "POST"
          ? await parseJson(req, NativeUiResponse, 262_144)
          : null;
      if (input && !input.ok)
        return uiReply(
          { error: "Invalid native UI response." },
          input.reason === "too_large" ? 413 : 400,
        );
      return await db.$transaction(async (tx) => {
        const binding = await tx.a2AEntryBinding.findFirst({
          where: {
            kind: "work",
            sourceId: workSessionId,
            context: { workspaceId: workspace.id, targetKind: "local" },
          },
        });
        // Match task-ui's lock order: task first, then Work.
        const task = binding ? await lockTask(tx, binding.lastTaskId) : null;
        await tx.$queryRaw`SELECT id FROM "WorkSession" WHERE id=${workSessionId} FOR UPDATE`;
        const work = await tx.workSession.findFirst({
          where: {
            id: workSessionId,
            workspaceId: workspace.id,
            a2aActorId: principal.user.id,
          },
        });
        if (!work) throw new TaskNotFoundError();
        const grant = task?.grant as unknown as TaskGrant;
        if (
          task &&
          (!isLocalGrant(grant) ||
            grant.workspaceId !== work.workspaceId ||
            grant.agentId !== work.agentId ||
            grant.actorId !== principal.user.id ||
            grant.agentRevisionId !== work.agentRevisionId ||
            grant.ancestorTaskIds.length ||
            task.parentTaskId ||
            task.rootTaskId !== task.id ||
            grant.entryPolicy?.kind !== "work" ||
            grant.entryPolicy.sourceId !== work.id ||
            grant.entryPolicy.sourceAgentId !== work.agentId)
        )
          throw new TaskNotFoundError();
        const live = work.status === "running" && !work.cancelRequestedAt;
        const taskLive =
          !task ||
          (task.leaseToken === work.uiLease &&
            task.phase === "executing" &&
            task.state === TaskState.TASK_STATE_WORKING &&
            !task.cancelRequestedAt &&
            task.deadlineAt > new Date());
        if (live) {
          const agent = await getAgentForRun(work.agentId, work.workspaceId);
          if (!agent || !work.agentRevisionId) throw new TaskNotFoundError();
          await resolvePinnedAgent(agent, work.agentRevisionId, {
            workspaceId: work.workspaceId,
          });
          if (task && taskLive && isLocalGrant(grant))
            await assertLocalGrant(grant, tx);
        }
        if (input?.ok) {
          if (!live || !work.uiLease) throw new TaskNotFoundError();
          if (task) {
            if (
              !isLocalGrant(grant) ||
              task.leaseToken !== work.uiLease ||
              task.phase !== "executing" ||
              task.state !== TaskState.TASK_STATE_WORKING ||
              task.cancelRequestedAt ||
              task.deadlineAt <= new Date()
            )
              throw new TaskNotFoundError();
            await assertLocalGrant(grant, tx);
          }
          const projection = respondNativeUi(
            work.uiProjection,
            work.uiLease,
            input.value,
          );
          await tx.workSession.update({
            where: { id: work.id },
            data: {
              uiProjection: projection as unknown as Prisma.InputJsonValue,
            },
          });
          if (task) {
            await tx.a2ATask.update({
              where: { id: task.id },
              data: {
                uiProjection: projection as unknown as Prisma.InputJsonValue,
              },
            });
            await refreshTaskStorage(tx, task.id);
          }
          return uiReply({ ok: true });
        }
        const view = nativeUiView(
          work.uiProjection,
          work.uiLease,
          live && taskLive,
        );
        const status =
          view.uiRequests.length || work.status === "waiting_user"
            ? "input-required"
            : ["idle", "completed", "archived"].includes(work.status)
              ? "completed"
              : ["cancelled", "cancelling"].includes(work.status)
                ? "cancelled"
                : work.status === "failed"
                  ? "failed"
                  : work.status === "queued"
                    ? "queued"
                    : "running";
        return uiReply({ execution: { id: work.id, status, ...view } });
      });
    } catch (error) {
      return uiFailure(error);
    }
  });
}
