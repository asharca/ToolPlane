import type { UIMessage } from 'ai';
import { z } from 'zod';
import {
  AGENT_STEP_BOUNDS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/lib/agents/constants';
import type { ModelParameters } from '@/lib/agents/model';

const nullableTrimmedString = (max: number) => z.string().trim().max(max).nullable();

const CustomModelParameterSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().trim().min(1).max(120),
    type: z.literal('string'),
    value: z.string().max(10_000),
  }).strict(),
  z.object({
    name: z.string().trim().min(1).max(120),
    type: z.literal('number'),
    value: z.number().finite(),
  }).strict(),
  z.object({
    name: z.string().trim().min(1).max(120),
    type: z.literal('boolean'),
    value: z.boolean(),
  }).strict(),
  z.object({
    name: z.string().trim().min(1).max(120),
    type: z.literal('json'),
    value: z.string().min(1).max(10_000).refine((value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, 'Invalid JSON'),
  }).strict(),
]);

export const ChatAssistantModelParametersSchema: z.ZodType<ModelParameters> = z.object({
  temperature: z.number().finite().min(0).max(2).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  customParameters: z.array(CustomModelParameterSchema).max(20).optional(),
}).strict().superRefine((parameters, context) => {
  const names = new Set<string>();
  parameters.customParameters?.forEach((parameter, index) => {
    if (names.has(parameter.name)) {
      context.addIssue({
        code: 'custom',
        message: 'Custom parameter names must be unique',
        path: ['customParameters', index, 'name'],
      });
    }
    names.add(parameter.name);
  });
});

const assistantFields = {
  name: z.string().trim().min(1).max(120),
  description: nullableTrimmedString(500).optional(),
  systemPrompt: nullableTrimmedString(50_000).optional(),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
  model: nullableTrimmedString(240).optional(),
  modelParameters: ChatAssistantModelParametersSchema.nullable().optional(),
  maxSteps: z.number().int()
    .min(AGENT_STEP_BOUNDS.min)
    .max(AGENT_STEP_BOUNDS.max)
    .optional(),
  deploymentIds: z.array(z.string().trim().min(1)).max(50)
    .transform((ids) => [...new Set(ids)]).optional(),
};

export const CreateChatAssistantSchema = z.object({
  workspaceId: z.string().trim().min(1),
  marketTemplateReleaseId: z.string().trim().min(1).max(240).optional(),
  ...assistantFields,
});

export const GenerateChatAssistantPromptSchema = z.object({
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  description: nullableTrimmedString(500).optional(),
  systemPrompt: nullableTrimmedString(50_000).optional(),
  modelProviderId: z.string().trim().min(1),
  model: z.string().trim().min(1).max(240),
}).strict();

export const UpdateChatAssistantSchema = z.object({
  ...assistantFields,
  name: assistantFields.name.optional(),
  pinned: z.boolean().optional(),
}).refine(
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
  value.assistantId !== undefined
  || value.title !== undefined
  || value.activeMessageId !== undefined
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
export type GenerateChatAssistantPromptInput = z.infer<typeof GenerateChatAssistantPromptSchema>;
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

export function parseChatAssistantModelParameters(raw: unknown): ModelParameters | undefined {
  const parsed = ChatAssistantModelParametersSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
