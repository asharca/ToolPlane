import { z } from "zod";

export const ToolApprovalPolicySchema = z
  .object({
    mode: z.enum(["off", "write", "exec", "all"]),
    overrides: z
      .record(z.string().min(1).max(512), z.enum(["ask", "allow", "deny"]))
      .optional(),
  })
  .strict();
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>;

export function toolApprovalDecision(
  policy: ToolApprovalPolicy | undefined,
  tool: string,
) {
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
