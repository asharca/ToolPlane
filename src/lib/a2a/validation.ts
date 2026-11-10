import {
  DEFAULT_A2A_TASK_FILES,
  DEFAULT_TRANSPORT_POLICY,
  MAX_A2A_INLINE_BYTES,
  permitsTransportProtocol,
  type A2AFileLimits,
  type TransportPolicy,
} from "@/lib/transport-policy";
import { z } from "zod";
import {
  A2A_LIMITS,
  acceptsOutput,
  A2A_FILE_DELIVERY_EXTENSION,
} from "./model";
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  PushNotificationNotSupportedError,
  ExtensionSupportRequiredError,
} from "@a2a-js/sdk/errors";
import { SendMessageRequest, Role } from "@a2a-js/sdk";

type SendPolicy = TransportPolicy &
  Partial<Pick<A2AFileLimits, "a2aTaskFiles">>;

const Id = z.string().min(1).max(200);
const OptionalId = Id.or(z.literal("")).optional();
const Metadata = z.record(z.string(), z.unknown());
const Part = z
  .object({
    text: z.string().max(A2A_LIMITS.inputCharacters).optional(),
    raw: z
      .string()
      .max(Math.ceil(MAX_A2A_INLINE_BYTES / 3) * 4)
      .optional(),
    url: z.string().min(1).max(8192).optional(),
    data: z.object({ toolplaneFileId: Id }).strict().optional(),
    metadata: Metadata.optional(),
    filename: z.string().max(200).optional(),
    mediaType: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((part, ctx) => {
    if (part.raw !== undefined) {
      const decoded = Buffer.from(part.raw, "base64");
      if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.raw) ||
        decoded.length > MAX_A2A_INLINE_BYTES ||
        decoded.toString("base64") !== part.raw
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Inline files require canonical base64 within the maximum file size.",
        });
    }
    const keys = ["text", "raw", "url", "data"].filter((key) =>
      Object.hasOwn(part, key),
    );
    if (keys.length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "Part requires exactly one content field.",
      });
  });
const Message = z
  .object({
    messageId: Id,
    contextId: OptionalId,
    taskId: OptionalId,
    role: z.union([z.literal("ROLE_USER"), z.literal(1)]),
    parts: z.array(Part).min(1).max(32),
    metadata: Metadata.optional(),
    extensions: z.array(z.string().max(2000)).max(16).optional(),
    referenceTaskIds: z.array(Id).max(16).optional(),
  })
  .strict();
const History = z.number().int().nonnegative().max(10_000).optional();
const Tenant = z.string().max(200).optional();
const Send = z
  .object({
    tenant: Tenant,
    message: Message,
    metadata: Metadata.optional(),
    configuration: z
      .object({
        acceptedOutputModes: z.array(z.string().max(200)).max(16).optional(),
        historyLength: History,
        returnImmediately: z.boolean().optional(),
        taskPushNotificationConfig: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const Get = z
  .object({ tenant: Tenant, id: Id, historyLength: History })
  .strict();
const TaskId = z.object({ tenant: Tenant, id: Id }).strict();
const Cancel = z
  .object({ tenant: Tenant, id: Id, metadata: Metadata.optional() })
  .strict();
const List = z
  .object({
    tenant: Tenant,
    contextId: OptionalId,
    status: z
      .union([
        z.number().int().min(0).max(8),
        z.enum([
          "TASK_STATE_UNSPECIFIED",
          "TASK_STATE_SUBMITTED",
          "TASK_STATE_WORKING",
          "TASK_STATE_COMPLETED",
          "TASK_STATE_FAILED",
          "TASK_STATE_CANCELED",
          "TASK_STATE_INPUT_REQUIRED",
          "TASK_STATE_REJECTED",
          "TASK_STATE_AUTH_REQUIRED",
        ]),
      ])
      .optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().max(2048).optional(),
    historyLength: History,
    statusTimestampAfter: z.string().datetime({ offset: true }).optional(),
    includeArtifacts: z.boolean().optional(),
  })
  .strict();
const Rpc = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z
      .union([z.string().max(200), z.number().int().safe(), z.null()])
      .optional(),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();
export {
  Rpc,
  Send as A2ASendSchema,
  Get as A2AGetSchema,
  Cancel as A2ACancelSchema,
  List as A2AListSchema,
};
/** Validate before SDK fromJSON: it intentionally coerces values and selects oneofs. */
export function validateParams(
  method: string,
  raw: unknown,
  outputModes: readonly string[] = ["text/plain"],
  policy: SendPolicy = DEFAULT_TRANSPORT_POLICY,
) {
  const schema =
    method === "SendMessage" || method === "SendStreamingMessage"
      ? Send
      : method === "GetTask"
        ? Get
        : method === "CancelTask"
          ? Cancel
          : method === "SubscribeToTask"
            ? TaskId
            : method === "ListTasks"
              ? List
              : null;
  if (!schema) return;
  if (!schema.safeParse(raw).success)
    throw new RequestMalformedError("Invalid A2A method parameters.");
  if (method === "SendMessage" || method === "SendStreamingMessage")
    validateSend(SendMessageRequest.fromJSON(raw), outputModes, policy);
}
export function validateSend(
  request: SendMessageRequest,
  outputModes: readonly string[] = ["text/plain"],
  policy: SendPolicy = DEFAULT_TRANSPORT_POLICY,
) {
  const message = request.message;
  if (
    !message?.messageId ||
    message.role !== Role.ROLE_USER ||
    !message.parts.length
  )
    throw new RequestMalformedError(
      "A user message with messageId and parts is required.",
    );
  if (
    [
      request.metadata,
      message.metadata,
      ...message.parts.map((part) => part.metadata),
    ].some(
      (metadata) =>
        metadata && Object.hasOwn(metadata, "toolplanePromptInvocation"),
    )
  )
    throw new RequestMalformedError(
      "Native prompt invocation metadata is server-owned.",
    );
  if (request.configuration?.taskPushNotificationConfig)
    throw new PushNotificationNotSupportedError();
  if (message.extensions.some((uri) => uri !== A2A_FILE_DELIVERY_EXTENSION.uri))
    throw new ExtensionSupportRequiredError(
      "This service does not support the requested message extension.",
    );
  let characters = 0;
  let files = 0;
  for (const part of message.parts) {
    if (
      part.metadata?.toolplaneFileId !== undefined &&
      (part.content?.$case !== "data" ||
        part.metadata.toolplaneFileId !== part.content.value.toolplaneFileId)
    )
      throw new RequestMalformedError(
        "Reserved file metadata must match an owned file handle.",
      );
    const content = part.content;
    if (content?.$case === "text") {
      if (part.mediaType && part.mediaType !== "text/plain")
        throw new ContentTypeNotSupportedError(
          "Text Parts require text/plain.",
        );
      characters += content.value.length;
    } else if (
      content?.$case === "raw" ||
      content?.$case === "url" ||
      content?.$case === "data"
    ) {
      files++;
      if (
        !part.mediaType ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(part.mediaType)
      )
        throw new ContentTypeNotSupportedError(
          "File Parts require a concrete MIME type.",
        );
      if (part.filename && /[\p{Cc}/\\]/u.test(part.filename))
        throw new RequestMalformedError("Invalid file name.");
      if (
        content.$case === "raw" &&
        content.value.byteLength > policy.a2aInlineBytes
      )
        throw new RequestMalformedError(
          `Inline files exceed the ${policy.a2aInlineBytes / 1024} KiB limit; use a URL.`,
        );
      if (content.$case === "url") {
        try {
          const url = new URL(content.value);
          if (
            !permitsTransportProtocol(url.protocol, policy) ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error();
        } catch {
          throw new RequestMalformedError(
            "File URLs require HTTPS without credentials or fragments.",
          );
        }
      }
      if (
        content.$case === "data" &&
        (typeof content.value.toolplaneFileId !== "string" ||
          Object.keys(content.value).length !== 1)
      )
        throw new ContentTypeNotSupportedError(
          "Only owned file handles are supported as internal data Parts.",
        );
    } else throw new ContentTypeNotSupportedError("Unsupported Part content.");
  }
  if (
    (!files &&
      !message.parts.some(
        (part) => part.content?.$case === "text" && part.content.value.trim(),
      )) ||
    characters > A2A_LIMITS.inputCharacters ||
    files > (policy.a2aTaskFiles ?? DEFAULT_A2A_TASK_FILES)
  )
    throw new RequestMalformedError(
      "Input is empty or exceeds the service input limit.",
    );
  const modes = request.configuration?.acceptedOutputModes ?? [];
  if (
    modes.some(
      (mode) =>
        !/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+))$/i.test(
          mode,
        ),
    )
  )
    throw new ContentTypeNotSupportedError(
      "Requested output modes must be MIME types or MIME wildcards.",
    );
  if (
    !outputModes.some(
      (mode) =>
        acceptsOutput(modes, mode) ||
        modes.some((accepted) => acceptsOutput([mode], accepted)),
    )
  )
    throw new ContentTypeNotSupportedError(
      "Requested output media types are not supported by this service.",
    );
}
