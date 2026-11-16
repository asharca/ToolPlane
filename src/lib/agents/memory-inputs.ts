import { z } from "zod";

export const AGENT_MEMORY_LIMIT = 500;
export const AgentMemoryContent = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => Array.from(value).length <= 2000 && !value.includes("\0"),
    "Memory must contain at most 2000 characters and no NUL bytes.",
  );
export const MemoryRetainInput = z
  .object({ content: AgentMemoryContent })
  .strict();
export const MemoryRecallInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !value.includes("\0")),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export const MemoryForgetInput = z
  .object({ id: z.string().min(1).max(256) })
  .strict();

export const AGENT_MEMORY_ERRORS = {
  AGENT_MEMORY_INVALID: "Memory content or search input is invalid.",
  AGENT_MEMORY_SECRET_DETECTED:
    "Memory cannot contain credentials. Remove secrets before saving.",
  AGENT_MEMORY_LIMIT_REACHED:
    "This Agent has reached its 500-memory limit. Delete existing memories before saving more.",
  AGENT_MEMORY_NOT_FOUND:
    "Memory or Agent was not found in this workspace and Agent scope.",
  AGENT_MEMORY_FAILED:
    "The memory operation could not be completed. Try again.",
} as const;

export class AgentMemoryError extends Error {
  constructor(public readonly reason: keyof typeof AGENT_MEMORY_ERRORS) {
    super(AGENT_MEMORY_ERRORS[reason]);
    this.name = "AgentMemoryError";
  }
}
