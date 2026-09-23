import { z } from 'zod';
import { A2A_LIMITS, acceptsOutput } from './model';
import { ContentTypeNotSupportedError, RequestMalformedError, PushNotificationNotSupportedError,
  ExtensionSupportRequiredError } from '@a2a-js/sdk/errors';
import { SendMessageRequest, Role } from '@a2a-js/sdk';

const Id = z.string().min(1).max(200);
const OptionalId = Id.or(z.literal('')).optional();
const Metadata = z.record(z.string(), z.unknown());
const Part = z.object({ text: z.string().max(A2A_LIMITS.inputCharacters).optional(),
  raw: z.string().optional(), url: z.string().optional(), data: z.unknown().optional(),
  metadata: Metadata.optional(), filename: z.string().max(200).optional(), mediaType: z.string().max(200).optional(),
}).strict().superRefine((part, ctx) => {
  const keys = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(part, key));
  if (keys.length !== 1) ctx.addIssue({ code: 'custom', message: 'Part requires exactly one content field.' });
});
const Message = z.object({ messageId: Id, contextId: OptionalId, taskId: OptionalId,
  role: z.union([z.literal('ROLE_USER'), z.literal(1)]), parts: z.array(Part).min(1).max(32),
  metadata: Metadata.optional(), extensions: z.array(z.string().max(2000)).max(16).optional(),
  referenceTaskIds: z.array(Id).max(16).optional(),
}).strict();
const History = z.number().int().nonnegative().max(10_000).optional();
const Tenant = z.string().max(200).optional();
const Send = z.object({ tenant: Tenant, message: Message, metadata: Metadata.optional(), configuration: z.object({
  acceptedOutputModes: z.array(z.string().max(200)).max(16).optional(),
  historyLength: History, returnImmediately: z.boolean().optional(),
  taskPushNotificationConfig: z.unknown().optional(),
}).strict().optional() }).strict();
const Get = z.object({ tenant: Tenant, id: Id, historyLength: History }).strict();
const TaskId = z.object({ tenant: Tenant, id: Id }).strict();
const Cancel = z.object({ tenant: Tenant, id: Id, metadata: Metadata.optional() }).strict();
const List = z.object({ tenant: Tenant, contextId: OptionalId,
  status: z.union([z.number().int().min(0).max(8), z.enum(['TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
    'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'])]).optional(),
  pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().max(2048).optional(),
  historyLength: History, statusTimestampAfter: z.string().datetime({ offset: true }).optional(),
  includeArtifacts: z.boolean().optional(),
}).strict();
const Rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number().int().safe(), z.null()]).optional(),
  method: z.string().min(1).max(100), params: z.unknown().optional(),
}).strict();
export { Rpc, Send as A2ASendSchema, Get as A2AGetSchema, Cancel as A2ACancelSchema, List as A2AListSchema };
/** Validate before SDK fromJSON: it intentionally coerces values and selects oneofs. */
export function validateParams(method: string, raw: unknown, outputModes: readonly string[] = ['text/plain']) {
  const schema = method === 'SendMessage' || method === 'SendStreamingMessage' ? Send
    : method === 'GetTask' ? Get : method === 'CancelTask' ? Cancel : method === 'SubscribeToTask' ? TaskId
    : method === 'ListTasks' ? List : null;
  if (!schema) return;
  if (!schema.safeParse(raw).success) throw new RequestMalformedError('Invalid A2A method parameters.');
  if (method === 'SendMessage' || method === 'SendStreamingMessage') validateSend(SendMessageRequest.fromJSON(raw), outputModes);
}
export function validateSend(request: SendMessageRequest, outputModes: readonly string[] = ['text/plain']) {
  const message = request.message;
  if (!message || !message.messageId || message.role !== Role.ROLE_USER || !message.parts.length) throw new RequestMalformedError('A user message with messageId and parts is required.');
  if (request.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
  if (message.extensions.length) throw new ExtensionSupportRequiredError('This service does not support message extensions.');
  if (message.parts.some((part) => part.content?.$case !== 'text' || (part.mediaType && part.mediaType !== 'text/plain'))) throw new ContentTypeNotSupportedError('This service accepts text/plain only.');
  const text = message.parts.map((part) => part.content?.value ?? '').join('\n');
  if (!text.trim() || text.length > A2A_LIMITS.inputCharacters) throw new RequestMalformedError('Input is empty or exceeds the service input limit.');
  const modes = request.configuration?.acceptedOutputModes ?? [];
  if (!outputModes.some((mode) => acceptsOutput(modes, mode))) throw new ContentTypeNotSupportedError('Requested output media types are not supported by this service.');
}
