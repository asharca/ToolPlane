import { z } from "zod";

export const ADVISOR_SUGGESTIONS_PART = "data-advisor-suggestions";
export const AdvisorSuggestionsSchema = z
  .object({
    id: z.string().min(1).max(240),
    providerId: z.string().min(1).max(240),
    model: z.string().min(1).max(240),
    cadence: z.enum(["each_tool_batch", "final"]),
    suggestions: z
      .array(
        z
          .object({
            severity: z.enum(["info", "warning", "critical"]),
            message: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type AdvisorSuggestions = z.infer<typeof AdvisorSuggestionsSchema>;
