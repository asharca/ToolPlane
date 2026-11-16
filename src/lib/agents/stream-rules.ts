import { z } from "zod";

// Conservative save-time heuristic, not a proof of linear execution. Reject
// repeated groups containing repetition/alternation and backreferences.
function unsafePattern(pattern: string): boolean {
  const groups: Array<{ repeated: boolean; alternate: boolean }> = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      if (!inClass && /[1-9]/.test(pattern[i + 1] ?? "")) return true;
      i++;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (inClass) continue;
    if (char === "(") groups.push({ repeated: false, alternate: false });
    else if (char === "|") {
      for (const group of groups) group.alternate = true;
    } else if (char === ")") {
      const group = groups.pop();
      if (group && /^(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern.slice(i + 1))) {
        if (group.repeated || group.alternate) return true;
        for (const parent of groups) parent.repeated = true;
      }
    } else if (char === "*" || char === "+" || char === "{") {
      for (const group of groups) group.repeated = true;
    }
  }
  return /(?:\.\*|\.\+)[\s\S]*(?:\.\*|\.\+)/.test(pattern);
}

export const StreamRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
    target: z.enum(["assistant_text", "tool_call"]),
    toolName: z.string().trim().min(1).max(240).optional(),
    pattern: z
      .string()
      .min(1)
      .max(500)
      .superRefine((pattern, ctx) => {
        try {
          new RegExp(pattern);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "STREAM_RULE_PATTERN_INVALID",
          });
          return;
        }
        if (unsafePattern(pattern))
          ctx.addIssue({
            code: "custom",
            message: "STREAM_RULE_PATTERN_UNSAFE",
          });
      }),
    action: z.enum(["remind", "block"]),
    message: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      rule.target === "assistant_text" &&
      (rule.action === "block" || rule.toolName !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "STREAM_RULE_INVALID_TARGET",
        path: ["target"],
      });
  });

export const StreamRulesSchema = z
  .array(StreamRuleSchema)
  .max(50)
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (ids.has(rule.id))
        ctx.addIssue({
          code: "custom",
          message: "STREAM_RULE_DUPLICATE_ID",
          path: [index, "id"],
        });
      ids.add(rule.id);
    }
  });
export type StreamRule = z.infer<typeof StreamRuleSchema>;

export const StreamRuleTriggerSchema = z
  .object({
    id: z.string().min(1).max(240),
    ruleId: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    target: z.enum(["assistant_text", "tool_call"]),
    action: z.enum(["remind", "block"]),
    message: z.string().min(1).max(2000),
    toolName: z.string().max(240).optional(),
    toolCallId: z.string().max(1000).optional(),
    timestamp: z.number().finite(),
  })
  .strict();
export type StreamRuleTrigger = z.infer<typeof StreamRuleTriggerSchema>;
export const STREAM_RULE_TRIGGER_PART = "data-agent-stream-rule";
export type StreamRuleTriggerPart = {
  type: typeof STREAM_RULE_TRIGGER_PART;
  data: StreamRuleTrigger;
};

export function streamRuleValidationCode(error: z.ZodError): string {
  return (
    error.issues.find((issue) => issue.message.startsWith("STREAM_RULE_"))
      ?.message ?? "STREAM_RULES_INVALID"
  );
}
