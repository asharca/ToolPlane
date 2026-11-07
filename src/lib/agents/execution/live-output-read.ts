import "server-only";
import { Task, TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { z } from "zod";
import { settled } from "@/lib/a2a/model";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
import { redactText } from "@/lib/observability/redaction";
import { taskOutput } from "./live-output";
import type { LiveTaskOutput } from "./live-output-types";

const stage = z.enum([
  "queued",
  "preparing",
  "waiting-model",
  "generating",
  "tool-running",
]);
const replaySchema = z.object({
  taskId: z.string(),
  text: z.string().max(65_536),
  truncated: z.boolean().optional(),
  activities: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["runtime", "reasoning", "tool"]),
        status: z.enum(["running", "completed", "failed", "cancelled"]),
        text: z.string().optional(),
        runtimeKind: z.string().optional(),
        source: z
          .object({
            subagentId: z.string(),
            subagentVersionId: z.string().optional(),
            subagentName: z.string().optional(),
            parentToolCallId: z.string().optional(),
            depth: z.number().optional(),
          })
          .optional(),
        toolCallId: z.string().optional(),
        toolName: z.string().optional(),
        durationMs: z.number().optional(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        isError: z.boolean().optional(),
      }),
    )
    .max(49),
  startedAt: z.number().optional(),
  runtimeKind: z.string().optional(),
  modelName: z.string().optional(),
});
/** Ledger recovery never interprets remote metadata as locally observed tools. */
export function readTaskOutput(row: A2ATask): LiveTaskOutput {
  const done = settled(row.state);
  const local = isLocalGrant(row.grant as unknown as TaskGrant);
  const task = Task.fromJSON(row.snapshot);
  const parts = task.artifacts.length
    ? task.artifacts.flatMap((artifact) => artifact.parts)
    : (task.status?.message?.parts ?? []);
  const observedText =
    local && !done
      ? ""
      : redactText(
          parts
            .flatMap((part) =>
              part.content?.$case === "text" ? [part.content.value] : [],
            )
            .join("\n"),
        );
  const text = observedText.slice(0, 65_536);
  const live = local ? taskOutput(row.id) : null;
  if (live && (done ? live.done : live.active))
    return done && !live.text ? { ...live, text } : live;
  const replay = local
    ? replaySchema.safeParse(task.metadata?.toolplaneLiveOutput)
    : null;
  if (done && replay?.success && replay.data.taskId === row.id)
    return {
      ...replay.data,
      text: replay.data.text || text,
      active: false,
      done: true,
    };
  const executionStage = z
    .object({ executionStage: stage.optional() })
    .safeParse(row.uiProjection);
  const failed =
    row.state === TaskState.TASK_STATE_FAILED ||
    row.state === TaskState.TASK_STATE_REJECTED;
  return {
    taskId: row.id,
    text,
    ...(observedText.length > 65_536 ? { truncated: true } : {}),
    activities:
      done && local
        ? [
            {
              id: "runtime:final",
              type: "runtime",
              status:
                row.state === TaskState.TASK_STATE_CANCELED
                  ? "cancelled"
                  : failed
                    ? "failed"
                    : "completed",
            },
          ]
        : [],
    active: !done,
    done,
    startedAt: row.createdAt.getTime(),
    ...(local ? { runtimeKind: row.executionBackend } : {}),
    ...(!done
      ? {
          executionStage:
            row.phase === "queued"
              ? "queued"
              : executionStage.success && executionStage.data.executionStage
                ? executionStage.data.executionStage
                : "preparing",
        }
      : {}),
  };
}
