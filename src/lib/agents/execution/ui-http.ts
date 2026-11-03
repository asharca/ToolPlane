import "server-only";
import { z } from "zod";
import {
  TaskNotFoundError,
  RequestMalformedError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { TaskState } from "@a2a-js/sdk";
import { agentRuntimeTokenFromRequest } from "@/lib/agents/runtime-access";
import { parseJson } from "@/lib/agents/public-api/body";
import { withLogContext } from "@/lib/observability/context";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { sessionActor } from "@/lib/a2a/console-http";
import { A2AHttpError } from "@/lib/a2a/principal";
import { WindowLimiter } from "@/lib/a2a/transport-limits";
import {
  NativeUiAction,
  NativeUiResponse,
  NativeUiProjectionLimitError,
} from "./native-ui";
import { readTaskUi, respondTaskUi, updateTaskUi } from "./task-ui";
const limiter = new WindowLimiter(600, 4096);
export const uiReply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      vary: "Cookie, Authorization",
    },
  });
export function uiFailure(error: unknown) {
  const status =
    error instanceof NativeUiProjectionLimitError
      ? 413
      : error instanceof A2AHttpError
        ? error.status
        : error instanceof TaskNotFoundError
          ? 404
          : error instanceof AgentRevisionError
            ? 403
            : error instanceof RequestMalformedError
              ? 400
              : error instanceof UnsupportedOperationError
                ? 409
                : 500;
  return uiReply(
    {
      error:
        "The native UI operation was not authorized or could not be completed.",
    },
    status,
  );
}
export function uiStatus(state: number, phase: string, waiting: boolean) {
  if (state === TaskState.TASK_STATE_COMPLETED) return "completed";
  if (state === TaskState.TASK_STATE_CANCELED) return "cancelled";
  if (
    [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED].includes(state)
  )
    return "failed";
  if (
    waiting ||
    state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    state === TaskState.TASK_STATE_AUTH_REQUIRED
  )
    return "input-required";
  return phase === "queued" ? "queued" : "running";
}
export async function handleRuntimeUi(req: Request, taskId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== "POST")
        return uiReply({ error: "Method not allowed." }, 405);
      if (req.headers.has("origin"))
        return uiReply({ error: "Runtime credential required." }, 403);
      const token = await agentRuntimeTokenFromRequest(req);
      if (!token || token.a2aTaskId !== taskId)
        return uiReply({ error: "Runtime credential required." }, 401);
      limiter.take(`${taskId}:${token.a2aLeaseToken}`);
      if (
        req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        return uiReply({ error: "Expected JSON." }, 415);
      const parsed = await parseJson(req, NativeUiAction, 262_144);
      if (!parsed.ok)
        return uiReply(
          { error: "Invalid native UI request." },
          parsed.reason === "too_large" ? 413 : 400,
        );
      return uiReply(await updateTaskUi(token, parsed.value));
    } catch (error) {
      return uiFailure(error);
    }
  });
}
export async function handleConsoleUi(
  req: Request,
  slug: string,
  agentId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!["GET", "POST"].includes(req.method))
        return uiReply({ error: "Method not allowed." }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      const params = new URL(req.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return uiReply({ error: "Invalid query." }, 400);
      const input = z
        .object({
          rootTaskId: z.string().min(1).max(200),
          taskId: z.string().min(1).max(200),
        })
        .strict()
        .safeParse(Object.fromEntries(params));
      if (!input.success) return uiReply({ error: "Invalid query." }, 400);
      const { rootTaskId, taskId } = input.data;
      if (req.method === "POST") {
        if (
          req.headers
            .get("content-type")
            ?.split(";")[0]
            .trim()
            .toLowerCase() !== "application/json"
        )
          return uiReply({ error: "Expected JSON." }, 415);
        const parsed = await parseJson(req, NativeUiResponse, 262_144);
        if (!parsed.ok)
          return uiReply(
            { error: "Invalid native UI response." },
            parsed.reason === "too_large" ? 413 : 400,
          );
        await respondTaskUi(ctx, rootTaskId, taskId, parsed.value);
        return uiReply({ ok: true });
      }
      const { row, ...view } = await readTaskUi(ctx, rootTaskId, taskId);
      return uiReply({
        execution: {
          id: row.id,
          status: uiStatus(row.state, row.phase, view.uiRequests.length > 0),
          ...view,
        },
      });
    } catch (error) {
      return uiFailure(error);
    }
  });
}
