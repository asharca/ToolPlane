import { z } from "zod";

const id = z.string().min(1).max(240);
export const NativeRoleModelSchema = z
  .object({ providerId: id, model: id })
  .strict();
export const NativeRoleModelsSchema = z.record(
  z.string().min(1).max(1000),
  NativeRoleModelSchema,
);
export const OmpModelHintSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^@?[A-Za-z0-9_-]+(?:[./:+-][A-Za-z0-9_-]+)*$/);
export const SubagentPermissionsSchema = z
  .object({
    builtinTools: z.array(id).max(256),
    mcpTools: z
      .array(
        z.object({ deploymentId: id, tools: z.array(id).max(256) }).strict(),
      )
      .max(128),
    skillIds: z.array(id).max(256),
    // Absence is an empty effective grant, but must not alter historical checksums.
    pluginInstallIds: z.array(id).max(256).optional(),
  })
  .strict();
export const SubagentDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeKind: z.literal("omp"),
    systemPrompt: z.string().min(1).max(100_000),
    name: z.string().min(1).max(240).optional(),
    model: z.object({ providerId: id, model: id }).strict().nullable(),
    permissions: SubagentPermissionsSchema,
    description: z.string().max(10_000).default(""),
    contextPolicy: z.enum(["isolated", "inherit"]).default("isolated"),
    allowNested: z.boolean().default(false),
    maxDepth: z.number().int().min(1).max(4).default(1),
    maxConcurrency: z.number().int().min(1).max(8).default(1),
    maxSteps: z.number().int().min(1).max(1_000),
  })
  .strict();
export const SubagentBindingSchema = z
  .object({ subagentId: id, versionId: id, enabled: z.boolean() })
  .strict();
export const SubagentPinSchema = z
  .object({
    subagentId: id,
    versionId: id,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SubagentDefinition = z.infer<typeof SubagentDefinitionSchema>;
export type SubagentBinding = z.infer<typeof SubagentBindingSchema>;
export type SubagentPin = z.infer<typeof SubagentPinSchema>;

const safePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/[\\\0]/.test(path) &&
      path
        .split("/")
        .every((part) => !!part && part !== "." && part !== "..") &&
      !/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.[^/]*|\.git)(?:\/|$)/i.test(path),
  );
export const PrivatePluginInputSchema = z
  .object({
    name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,99}$/),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
      .default("1.0.0"),
    runtimeKind: z.enum(["omp", "pi-sdk"]),
    files: z
      .array(
        z
          .object({
            path: safePath,
            content: z.string().max(24 * 1024 * 1024),
            encoding: z.enum(["utf8", "base64"]).optional(),
            mode: z.union([z.literal(420), z.literal(493)]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
    hooks: z.array(safePath).max(256).default([]),
    extensions: z.array(safePath).max(256).default([]),
    tools: z.array(safePath).max(256).default([]),
    commands: z.array(safePath).max(256).default([]),
    subagents: z.array(safePath).max(256).optional(),
    nativeRoleModels: NativeRoleModelsSchema.optional(),
    config: z.record(z.string(), z.json()).optional(),
    enabledFeatures: z
      .array(z.string().min(1).max(240))
      .max(256)
      .nullable()
      .optional(),
    platform: z.enum(["linux", "any"]).optional(),
    arch: z.enum(["x64", "arm64", "any"]).optional(),
  })
  .strict();
export type PrivatePluginInput = z.infer<typeof PrivatePluginInputSchema>;
