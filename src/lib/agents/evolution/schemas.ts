import { z } from "zod";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
const id = z.string().min(1).max(500),
  text = z.string(),
  money = z.string().regex(/^\d+$/);
export const evolutionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("conversation"), conversationId: id }).strict(),
  z.object({ kind: z.literal("task"), taskId: id }).strict(),
]);
export const privateSkillSchema = z
  .object({
    name: z.string().min(1).max(240),
    description: z.string().max(10_000).default(""),
    markdown: z.string().min(1).max(100_000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            content: z.string().max(1_000_000),
            encoding: z.literal("base64").optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const recordedToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/),
    description: z.string().max(2000),
    inputSchema: z.record(z.string(), z.json()),
    calls: z
      .array(
        z
          .object({
            arguments: z.record(z.string(), z.json()),
            result: z.json(),
            isError: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const casePayload = z
  .object({
    name: text,
    input: text,
    expected: text,
    criterion: z.enum(["exact", "contains", "rubric"]).default("exact"),
    recordedTools: z.array(recordedToolSchema).max(100).default([]),
    requiredTools: z.array(id).max(100).default([]),
  })
  .strict();
const playbook = z
  .object({
    scope: evolutionScopeSchema,
    content: text,
    reviewedById: id.nullable(),
    reflectionId: id.optional(),
  })
  .strict();
const episodePayload = z
  .object({
    taskId: id,
    conversationId: id.nullable(),
    revisionId: id,
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    summary: text,
    failureCode: text.nullable(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costMicros: money,
    toolCalls: z.number().int().nonnegative().default(0),
    toolFailures: z.number().int().nonnegative().default(0),
  })
  .strict();
export const reflectionCheckpoint = z
  .object({
    episodes: z.array(episodePayload.extend({ id }).strict()),
    feedback: z.array(
      z
        .object({
          id,
          rating: z.enum(["positive", "negative"]),
          comment: text,
          conversationId: id,
          parts: z.json(),
        })
        .strict(),
    ),
    output: z.json().optional(),
  })
  .strict();
const schemas = {
  episode: episodePayload,
  "episode-ingest": z.object({ taskId: id }).strict(),
  "tool-call": z
    .object({ taskId: id, toolCallId: id, toolName: text, sourceId: id })
    .strict(),
  "isolation-container": z
    .object({
      containerName: z.string().regex(/^toolplane-evolution-[a-f0-9-]{36}$/),
      jobId: id,
      imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
  playbook,
  "playbook-version": playbook
    .extend({
      playbookId: id,
      version: z.number().int().positive(),
      status: z.enum(["pending", "approved", "rejected", "archived"]),
    })
    .strict(),
  turn: z
    .object({
      taskId: id,
      conversationId: id.nullable(),
      enabled: z.boolean(),
      agentScopeAllowed: z.boolean().default(false),
      entries: z.array(
        z
          .object({ id, version: z.number().int().positive(), content: text })
          .strict(),
      ),
      text,
    })
    .strict(),
  proposal: z
    .object({
      kind: z.enum(["prompt", "skill"]),
      title: text,
      rationale: text,
      baseRevisionId: id,
      candidateRevisionId: id.nullable(),
      reviewedById: id.nullable(),
      before: AgentRevisionConfigSchema,
      after: AgentRevisionConfigSchema,
      newSkill: privateSkillSchema.nullable(),
      evidence: z
        .object({ episodeIds: z.array(id), feedbackIds: z.array(id) })
        .strict(),
      reflectionKey: id.optional(),
    })
    .strict(),
  case: casePayload,
  evaluation: z
    .object({
      proposalId: id,
      baselineRevisionId: id,
      candidateRevisionId: id,
      cases: z.array(casePayload.extend({ id }).strict()),
      pareto: z
        .enum([
          "candidate_dominates",
          "baseline_dominates",
          "tradeoff",
          "equal",
        ])
        .nullable(),
      excludedCapabilities: z.array(text).optional(),
    })
    .strict(),
  result: z
    .object({
      evaluationId: id,
      caseId: id,
      variant: z.enum(["baseline", "candidate"]),
      output: text,
      quality: z.number().min(0).max(1),
      costMicros: money,
      judgeCostMicros: money,
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      failureCode: text.nullable(),
      criterion: z.enum(["exact", "contains", "rubric"]),
      caseSnapshot: casePayload.extend({ id }).strict(),
      executionImageId: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  reflection: z
    .object({ baseRevisionId: id, checkpoint: reflectionCheckpoint.optional() })
    .strict(),
  rollout: z
    .object({
      proposalId: id,
      evaluationId: id,
      percentage: z.number().int().min(1).max(100),
      baselineRevisionId: id,
      candidateRevisionId: id,
      promotedRevisionId: id.optional(),
      rollbackRevisionId: id.optional(),
    })
    .strict(),
  charge: z
    .object({
      jobId: id,
      usage: z
        .object({
          inputTokens: z.number().nonnegative(),
          outputTokens: z.number().nonnegative(),
          cacheReadTokens: z.number().nonnegative(),
          cacheWriteTokens: z.number().nonnegative(),
          costUsd: z.number().nonnegative().optional(),
        })
        .strict(),
      providerId: id,
      model: id,
    })
    .strict(),
} as const;
export type EvolutionRecordKind = keyof typeof schemas;
export type EvolutionPayload = {
  [K in EvolutionRecordKind]: {
    kind: K;
    payload: z.infer<(typeof schemas)[K]>;
  };
}[EvolutionRecordKind];
export function parseEvolutionPayload<K extends EvolutionRecordKind>(
  kind: K,
  value: unknown,
): z.infer<(typeof schemas)[K]>;
export function parseEvolutionPayload(
  kind: string,
  value: unknown,
): z.infer<(typeof schemas)[EvolutionRecordKind]>;
export function parseEvolutionPayload(kind: string, value: unknown) {
  if (!Object.hasOwn(schemas, kind))
    throw new Error("INVALID_EVOLUTION_RECORD");
  return schemas[kind as EvolutionRecordKind].parse(value);
}
