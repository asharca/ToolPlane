import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

export const workFailures = defineFailures({
  WORK_EXECUTION_FAILED:
    "Work execution failed. Review the transcript, then resume it.",
  WORK_INTERRUPTED:
    "Work was interrupted by a server restart. Review the transcript, then resume it.",
  WORK_READ_ONLY: "Historical Work is read-only. Start a new Work session.",
  WORK_SANDBOX_UNAVAILABLE: "Work sandbox is unavailable.",
  WORK_IDENTITY_UNAVAILABLE: "Work execution identity is unavailable.",
  WORK_MESSAGE_UNAVAILABLE: "Work user message is unavailable.",
  AGENT_BUDGET_EXCEEDED: "The agent has reached its budget limit.",
  MODEL_OVERRIDE_UNAVAILABLE: "The selected model is unavailable.",
  PI_SDK_MODEL_FAILED:
    "The model request failed. Check the provider and try again.",
  PI_MCP_TOOLS_UNAVAILABLE:
    "A required MCP server is unavailable. Check the Agent's MCP settings.",
  PI_SDK_PACKAGE_SET_CHANGED:
    "Enabled packages changed. Start a new Work to use them.",
  PI_TASK_TIMEOUT:
    "The task reached its total time limit. Review the transcript before retrying.",
});

export type WorkFailureCode = FailureCodeOf<typeof workFailures>;

export function workFailureText(stored: string | null) {
  if (stored === null) return null;
  return workFailures.text(
    workFailures.is(stored) ? stored : "WORK_EXECUTION_FAILED",
  );
}
