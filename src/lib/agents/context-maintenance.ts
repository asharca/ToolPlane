import { z } from "zod";

export const CONTEXT_MAINTENANCE_PART = "data-context-maintenance";
export const ContextMaintenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rewind"),
      at: z.string().datetime(),
      checkpointId: z.string().min(1).max(200),
      entryId: z.string().min(1).max(200),
      report: z.string().min(1).max(32000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("handoff"),
      at: z.string().datetime(),
      summary: z.string().min(1).max(200000),
      firstKeptEntryId: z.string().min(1).max(200),
    })
    .strict(),
]);
export type ContextMaintenance = z.infer<typeof ContextMaintenanceSchema>;
