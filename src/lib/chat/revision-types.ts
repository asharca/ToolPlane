import { z } from "zod";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import { ChatAssistantModelParametersSchema } from "./schemas";

const reference = z.string().trim().min(1).max(240);

export const ChatAssistantRevisionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    systemPrompt: z.string().max(50_000).nullable(),
    modelProviderId: reference.nullable(),
    model: z.string().trim().min(1).max(240).nullable(),
    modelParameters: ChatAssistantModelParametersSchema.nullable(),
    maxSteps: z
      .number()
      .int()
      .min(AGENT_STEP_BOUNDS.min)
      .max(AGENT_STEP_BOUNDS.max),
    mcpGrants: z
      .array(
        z
          .object({
            deploymentId: reference,
            definitionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
            allowedToolNames: z.array(reference).max(1_000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type ChatAssistantRevisionConfig = z.infer<
  typeof ChatAssistantRevisionConfigSchema
>;
