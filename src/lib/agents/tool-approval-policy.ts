import { z } from "zod";
import { FEEDBACK_TOOL_NAME } from "@/lib/feedback/types";
export const ToolApprovalPolicySchema = z
  .object({
    mode: z.enum(["off", "write", "exec", "all"]),
    overrides: z
      .record(z.string().min(1).max(512), z.enum(["ask", "allow", "deny"]))
      .optional(),
  })
  .strict();
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>;

export function isFeedbackToolName(tool: string): boolean {
  return (
    tool === FEEDBACK_TOOL_NAME ||
    /^mcp__s\d+_t\d+__toolplane_feedback$/.test(tool)
  );
}

export function toolApprovalDecision(
  policy: ToolApprovalPolicy | undefined,
  tool: string,
) {
  if (isFeedbackToolName(tool)) return "ask";
  const override =
    policy?.overrides && Object.hasOwn(policy.overrides, tool)
      ? policy.overrides[tool]
      : undefined;
  if (override) return override;
  const mode = policy?.mode ?? "off";
  const kind = ["read", "grep", "find", "ls"].includes(tool)
    ? "read"
    : ["edit", "write"].includes(tool)
      ? "write"
      : "exec";
  return mode === "all" ||
    (mode === "write" && kind !== "read") ||
    (mode === "exec" && kind === "exec")
    ? "ask"
    : "allow";
}
