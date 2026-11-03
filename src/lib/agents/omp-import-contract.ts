import { z } from "zod";
import {
  PrivatePluginInputSchema,
  NativeRoleModelsSchema,
  OmpModelHintSchema,
  NativeRoleModelSchema,
} from "./capability-contracts";

export const OMP_IMPORT_MAX_BYTES = 96 * 1024 * 1024;
const jsonRecord = z.record(z.string(), z.json());
const id = z.string().min(1).max(240);
const path = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/[\\\0]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
export const OmpImportIssueSchema = z
  .object({
    id,
    path: z.string().max(1000),
    code: id,
    message: z.string().max(2000),
    severity: z.enum(["warning", "blocked"]),
    resourceId: id.optional(),
  })
  .strict();
export const OmpImportBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("omp-import"),
    ompVersion: z.string().min(1).max(80),
    name: z.string().min(1).max(240).optional(),
    settings: jsonRecord,
    instructions: z
      .array(z.object({ path, content: z.string() }).strict())
      .max(512),
    skills: z
      .array(
        z
          .object({
            id: id.refine((value) => value.startsWith("skill:")),
            name: id,
            content: z.string(),
            files: z
              .array(
                z
                  .object({
                    path,
                    content: z.string(),
                    encoding: z.literal("base64").optional(),
                  })
                  .strict(),
              )
              .max(512),
          })
          .strict(),
      )
      .max(512),
    plugins: z
      .array(
        z
          .object({
            id: id.refine((value) => value.startsWith("plugin:")),
            plugin: PrivatePluginInputSchema,
          })
          .strict(),
      )
      .max(128),
    mcpServers: z
      .array(
        z
          .object({
            id: id.refine((value) => value.startsWith("mcp:")),
            name: id,
            config: jsonRecord,
            requiredSecrets: z
              .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
              .max(100),
          })
          .strict(),
      )
      .max(128),
    issues: z.array(OmpImportIssueSchema).max(2048),
    model: z
      .object({ provider: id.optional(), model: id.optional() })
      .strict()
      .optional(),
    modelRoles: z.record(id, OmpModelHintSchema).optional(),
    taskModelOverrides: z.record(id, OmpModelHintSchema).optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const ids = [
      "settings",
      "instructions",
      ...bundle.skills.map((v) => v.id),
      ...bundle.plugins.map((v) => v.id),
      ...bundle.mcpServers.map((v) => v.id),
    ];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Duplicate resource IDs" });
  });
export const OmpImportRequestSchema = z
  .object({
    bundle: OmpImportBundleSchema,
    runtimeKind: z.enum(["pi-sdk", "omp"]),
    excludedIds: z.array(id).max(1024).default([]),
    name: z.string().trim().min(1).max(240).optional(),
    providerId: id.optional(),
    model: id.optional(),
    roleModels: z.record(id, NativeRoleModelsSchema).optional(),
    inspectMcp: z.boolean().default(false),
    mcpConfigs: z.record(id, jsonRecord).optional(),
    mcpSecrets: z
      .record(
        id,
        z.record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.string().max(16000),
        ),
      )
      .optional(),
    confirmed: z.boolean().optional(),
    previewChecksum: z.string().max(4096).optional(),
  })
  .strict();
export const OmpImportPreviewSchema = z
  .object({
    checksum: z.string(),
    canImport: z.boolean(),
    resources: z.array(
      z
        .object({
          id,
          kind: z.enum(["settings", "instructions", "skill", "plugin", "mcp"]),
          name: z.string(),
          status: z.enum(["ready", "blocked", "excluded"]),
          messages: z.array(z.string()),
          requiredSecrets: z.array(z.string()).optional(),
          config: jsonRecord.optional(),
          tools: z
            .array(
              z
                .object({
                  name: z.string(),
                  description: z.string().optional(),
                  inputSchema: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .strict(),
    ),
    issues: z.array(OmpImportIssueSchema),
    model: OmpImportBundleSchema.shape.model,
    nativeRoles: z
      .array(
        z
          .object({
            resourceId: id,
            path,
            name: id,
            modelHint: OmpModelHintSchema.optional(),
            mapping: NativeRoleModelSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type OmpImportBundle = z.infer<typeof OmpImportBundleSchema>;
export type OmpImportRequest = z.infer<typeof OmpImportRequestSchema>;
export type OmpImportPreview = z.infer<typeof OmpImportPreviewSchema>;
export type OmpImportIssue = z.infer<typeof OmpImportIssueSchema>;
