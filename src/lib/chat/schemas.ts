import type { UIMessage } from 'ai';
import { z } from 'zod';
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/agents/constants';

const nullableTrimmedString = (max: number) => z.string().trim().max(max).nullable();

const assistantFields = {
  name: z.string().trim().min(1).max(120),
  systemPrompt: nullableTrimmedString(50_000).optional(),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
  model: nullableTrimmedString(240).optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
  deploymentIds: z.array(z.string().trim().min(1)).max(50)
    .transform((ids) => [...new Set(ids)]).optional(),
};

export const CreateChatAssistantSchema = z.object({
  workspaceId: z.string().trim().min(1),
  marketTemplateReleaseId: z.string().trim().min(1).max(240).optional(),
  ...assistantFields,
});

export const UpdateChatAssistantSchema = z.object({ ...assistantFields, name: assistantFields.name.optional() }).refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field is required' },
);

export const CreateChatThreadSchema = z.object({
  title: nullableTrimmedString(200).optional(),
});

export const UpdateChatThreadSchema = z.object({
  assistantId: z.string().trim().min(1).optional(),
  title: nullableTrimmedString(200).optional(),
  activeMessageId: z.string().trim().min(1).optional(),
}).refine((value) => (
  value.assistantId !== undefined || value.title !== undefined || value.activeMessageId !== undefined
), {
  message: 'At least one field is required',
});

export const ChatBranchMutationSchema = z.object({
  messageId: z.string().trim().min(1),
});

const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  parts: z.array(z.record(z.string(), z.unknown())).max(200),
}).passthrough();

export const CreateChatTurnSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(500),
  trigger: z.enum(['submit-message', 'regenerate-message']).default('submit-message'),
  messageId: z.string().min(1).optional(),
  webSearchEnabled: z.boolean().default(false),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).refine(
  (value) => value.messages.at(-1)?.role === 'user',
  { message: 'The last message must be from the user' },
);

export type CreateChatAssistantInput = z.infer<typeof CreateChatAssistantSchema>;
export type UpdateChatAssistantInput = z.infer<typeof UpdateChatAssistantSchema>;
export type CreateChatThreadInput = z.infer<typeof CreateChatThreadSchema>;
export type UpdateChatThreadInput = z.infer<typeof UpdateChatThreadSchema>;
export type CreateChatTurnInput = {
  messages: UIMessage[];
  trigger: 'submit-message' | 'regenerate-message';
  messageId?: string;
  webSearchEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
};

export function parseChatTurn(raw: unknown): CreateChatTurnInput | null {
  const result = CreateChatTurnSchema.safeParse(raw);
  return result.success ? result.data as unknown as CreateChatTurnInput : null;
}
