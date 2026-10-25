import type { Sandbox } from "@prisma/client";
import type { SkillBundleFile } from "@/lib/skills/bundle";
import { z } from "zod";
import { AGENT_STEP_BOUNDS } from "./constants";

const reference = z.string().trim().min(1).max(240);
const references = z.array(reference).max(1_000);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);

// Reuse the serializable Sandbox model subset, never its arbitrary config JSON
// (which can contain connection material). Images must be immutable digests.
const sandboxDefinitionSchema = z
  .object({
    kind: z.literal("docker"),
    image: z
      .string()
      .min(1)
      .max(1_000)
      .regex(/@sha256:[a-f0-9]{64}$/),
    network: z.enum(["isolated", "none"]),
  })
  .strict() satisfies z.ZodType<Pick<Sandbox, "kind" | "image" | "network">>;

export const AgentEnvironmentSnapshotSchema = sandboxDefinitionSchema
  .extend({
    piVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    initialSnapshot: z
      .object({
        snapshotId: reference,
        volumeName: reference,
        checksum,
      })
      .strict()
      .nullable(),
    resourceLimits: z
      .object({
        memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        cpus: z.number().finite().positive(),
        pidsLimit: z.number().int().positive(),
      })
      .strict(),
    credentialReferences: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            credentialId: reference,
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

const skillFileSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    content: z.string().max(10_000_000),
    encoding: z.literal("base64").optional(),
  })
  .strict() satisfies z.ZodType<SkillBundleFile>;

export const AgentSkillSnapshotSchema = z
  .object({
    installedSkillId: reference,
    name: z.string().min(1).max(240),
    slug: reference,
    description: z.string().max(10_000).nullable(),
    markdown: z.string().max(1_000_000),
    files: z.array(skillFileSchema).max(1_000),
    checksum,
    userInvocable: z.boolean(),
    agentInvocable: z.boolean(),
    effort: reference,
  })
  .strict();

export type AgentEnvironmentSnapshot = z.infer<
  typeof AgentEnvironmentSnapshotSchema
>;
export type AgentSkillSnapshot = z.infer<typeof AgentSkillSnapshotSchema>;

export const AgentA2APolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z
      .array(
        z
          .object({
            kind: z.enum(["local", "remote"]),
            targetId: reference,
            capabilityIds: references,
            maxCalls: z.number().int().positive(),
            maxDepth: z.number().int().positive(),
            maxConcurrent: z.number().int().positive(),
            timeoutSeconds: z.number().int().positive(),
            maxInputBytes: z.number().int().positive(),
            dataAllowance: z.literal("text_only"),
            // Authorization reservations, not measured provider/remote billing.
            budget: z
              .object({
                currency: z.string().regex(/^[A-Z]{3}$/),
                maxAuthorizedCostMicros: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER),
                authorizedCostPerCallMicros: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export type AgentA2APolicy = z.infer<typeof AgentA2APolicySchema>;

// Resource identifiers and credential references only. Runtime materialization
// resolves live grants and secrets separately; it must never persist their values.
export const AgentRevisionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeKind: z.literal("pi-sdk"),
    systemPrompt: z.string().max(50_000).nullable(),
    providerId: reference.nullable(),
    model: reference.nullable(),
    modelProviderIds: references,
    maxSteps: z
      .number()
      .int()
      .min(AGENT_STEP_BOUNDS.min)
      .max(AGENT_STEP_BOUNDS.max),
    disabledBuiltinTools: references,
    sandboxTemplateId: reference.nullable(),
    environment: AgentEnvironmentSnapshotSchema,
    skills: z.array(AgentSkillSnapshotSchema).max(1_000),
    knowledgeBaseIds: references,
    packages: z
      .array(
        z
          .object({
            marketInstallId: reference,
            releaseId: reference,
            integrity: z.string().min(1).max(240),
          })
          .strict(),
      )
      .max(1_000),
    mcpGrants: z
      .array(
        z
          .object({
            deploymentId: reference,
            definitionChecksum: checksum,
            runtimeImageDigest: z
              .string()
              .regex(/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/)
              .nullable(),
            runtimeFilesChecksum: checksum,
            allowedToolNames: references,
          })
          .strict(),
      )
      .max(1_000),
    a2a: z
      .object({
        inboundEnabled: z.boolean(),
        outboundEnabled: z.boolean(),
        policy: AgentA2APolicySchema,
      })
      .strict(),
  })
  .strict();

export type AgentRevisionConfig = z.infer<typeof AgentRevisionConfigSchema>;
