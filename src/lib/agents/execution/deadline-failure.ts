import type { A2ATask } from "@prisma/client";
import { TaskState } from "@a2a-js/sdk";

/** Classify the task's total deadline, not an inferred provider/tool timeout. */
export function taskDeadlineFailure(
  row: Pick<A2ATask, "state" | "phase" | "uiProjection">,
): string {
  let code: string;
  let detail: string;
  if (row.phase.includes("file-")) {
    code = "PI_TASK_FILE_TIMEOUT";
    detail = "The task deadline was reached during file delivery.";
  } else if (row.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    code = "PI_TASK_INPUT_TIMEOUT";
    detail = "The task deadline was reached while waiting for your response.";
  } else if (row.state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    code = "PI_TASK_AUTH_TIMEOUT";
    detail = "The task deadline was reached while waiting for authorization.";
  } else if (row.phase === "waiting") {
    code = "PI_TASK_DEPENDENCY_TIMEOUT";
    detail = "The task deadline was reached while waiting for child tasks.";
  } else {
    const stage = (row.uiProjection as { executionStage?: unknown } | null)
      ?.executionStage;
    if (row.state === TaskState.TASK_STATE_SUBMITTED && stage !== "preparing") {
      code = "PI_TASK_QUEUE_TIMEOUT";
      detail =
        "The task expired before execution was admitted. This is not a model response timeout.";
    } else {
      switch (stage) {
        case "preparing":
          code = "PI_TASK_PREPARATION_TIMEOUT";
          detail =
            "The task deadline was reached during execution preparation.";
          break;
        case "waiting-model":
          code = "PI_TASK_MODEL_TIMEOUT";
          detail =
            "The task deadline was reached while waiting for a model response.";
          break;
        case "generating":
          code = "PI_TASK_GENERATION_TIMEOUT";
          detail =
            "The task deadline was reached while the model was generating a response.";
          break;
        case "tool-running":
          code = "PI_TASK_TOOL_TIMEOUT";
          detail =
            "The task deadline was reached while a tool was running. Its outcome may be incomplete; check the result before retrying.";
          break;
        default:
          code = "PI_TASK_TIMEOUT";
          detail =
            "The task deadline was reached; the exact execution stage was not recorded.";
      }
    }
  }
  return `${code}: ${detail} The deadline includes queueing, preparation and execution. No automatic replay was performed.`;
}
