import "server-only";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { safeAttachmentFilename } from "@/lib/attachments/storage";
import { redactText, sanitizeLog } from "@/lib/observability/redaction";
import { decryptSecretText } from "@/lib/security/secrets";
import { effectiveStatus } from "@/lib/process/supervisor";
import { workspaceAccessWhere } from "@/lib/workspace/scope";
import {
  beginAgentConversationSandboxAccess,
  findAgentConversationSandbox,
} from "./conversation-sandbox";
import {
  runSandboxSessionExport,
  sandboxRuntimeStateRoot,
} from "./sandbox-runtime";
import { projectContent } from "@/lib/conversation/content-projection";
import {
  assertNever,
  type ContentBlock,
  type ContentStep,
} from "@/lib/conversation/content-blocks";
import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";
import { ADVISOR_SUGGESTIONS_PART } from "./advisor";
import { assistantSegments } from "./message-segments";
import { collectSessionPluginSecretsForRedaction } from "@/lib/plugins/runtime-env";

export const SESSION_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const exportFailures = defineFailures({
  UNAUTHORIZED: "Authentication is required.",
  NOT_FOUND: "Conversation not found.",
  SESSION_EXPORT_FORMAT_INVALID: "Choose jsonl, html, or md.",
  SESSION_EXPORT_NATIVE_UNAVAILABLE:
    "Native export is unavailable for this historical session. Use Markdown.",
  SESSION_EXPORT_SANDBOX_NOT_RUNNING:
    "Start the Agent sandbox before exporting this format.",
  SESSION_EXPORT_SANDBOX_BUSY: "A sandbox lifecycle operation is in progress.",
  SESSION_EXPORT_NATIVE_MISSING:
    "No persisted Pi session is available. Use Markdown.",
  SESSION_EXPORT_NATIVE_INVALID:
    "The persisted Pi session cannot be exported. Use Markdown.",
  SESSION_EXPORT_TOO_LARGE: "The session export exceeds the 8 MiB limit.",
  SESSION_EXPORT_FAILED: "Session export failed.",
} as const);
export type SessionExportFailureCode = FailureCodeOf<typeof exportFailures>;
const exportFailureStatus: Record<SessionExportFailureCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SESSION_EXPORT_FORMAT_INVALID: 400,
  SESSION_EXPORT_NATIVE_UNAVAILABLE: 409,
  SESSION_EXPORT_SANDBOX_NOT_RUNNING: 409,
  SESSION_EXPORT_SANDBOX_BUSY: 409,
  SESSION_EXPORT_NATIVE_MISSING: 409,
  SESSION_EXPORT_NATIVE_INVALID: 409,
  SESSION_EXPORT_TOO_LARGE: 413,
  SESSION_EXPORT_FAILED: 500,
};
class SessionExportError extends Error {
  constructor(readonly code: SessionExportFailureCode) {
    super(code);
  }
}
function failure(code: SessionExportFailureCode) {
  return Response.json(
    { error: exportFailures.text(code), code },
    {
      status: exportFailureStatus[code],
      headers: { "Cache-Control": "no-store" },
    },
  );
}
function assertSize(value: string) {
  if (Buffer.byteLength(value) > SESSION_EXPORT_MAX_BYTES)
    throw new SessionExportError("SESSION_EXPORT_TOO_LARGE");
}

/** Known values cover bare echoes; the shared sanitizer covers structured credentials. */
async function exportSecrets(workspaceId: string, agentId: string) {
  const [credentials, providers, pluginSecrets] = await Promise.all([
    db.agentEnvironmentCredential.findMany({
      // Include revoked references: historical tool output can still contain them.
      where: { workspaceId, agentId },
      select: { id: true, name: true, encryptedValue: true },
    }),
    db.modelProvider.findMany({
      where: { workspaceId },
      select: { apiKey: true },
    }),
    collectSessionPluginSecretsForRedaction(workspaceId, agentId),
  ]);
  const secrets = [
    ...providers.map((provider) => provider.apiKey).filter(Boolean),
    ...pluginSecrets,
  ];
  for (const credential of credentials) {
    const value = JSON.parse(decryptSecretText(credential.encryptedValue));
    if (
      value.id !== credential.id ||
      value.name !== credential.name ||
      value.workspaceId !== workspaceId ||
      value.agentId !== agentId ||
      typeof value.value !== "string"
    )
      throw new SessionExportError("SESSION_EXPORT_FAILED");
    secrets.push(value.value);
  }
  return secrets;
}
function sanitize(value: unknown, secrets: readonly string[]) {
  // Runtime grants are JWTs. Also remove expired grants and bare copied JWTs,
  // which cannot be recovered from the current turn's in-memory secret list.
  const tokens =
    JSON.stringify(value)?.match(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    ) ?? [];
  return sanitizeLog(value, [...secrets, ...tokens]).data;
}
function textValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}
function fenced(value: unknown): string {
  const text = textValue(value);
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}\n${text}\n${fence}`;
}
function field(data: unknown, key: string): unknown {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)[key]
    : undefined;
}
function payloadMarkdown(input: unknown, output: unknown): string[] {
  return [
    ...(input === undefined ? [] : [`Input:\n\n${fenced(input)}`]),
    ...(output === undefined ? [] : [`Output:\n\n${fenced(output)}`]),
  ];
}
function dataStepMarkdown(
  step: Extract<ContentStep, { kind: "data" }>,
): string[] {
  const value = (key: string) => field(step.data, key);
  switch (step.type) {
    case "data-subagent-activity": {
      // Child activity is a transcript summary, not an executable runtime grant.
      const text = value("text");
      return [
        `### Subagent ${value("type") === "reasoning" ? "reasoning" : "tool"}: ${value("toolName") ?? "activity"} — ${value("status") ?? "recorded"}`,
        ...(text ? [textValue(text)] : []),
        ...payloadMarkdown(value("input"), value("output")),
      ];
    }
    case "data-hook-activity": {
      const result = value("result");
      return [
        `### Hook: ${value("pluginName") ?? "hook"} — ${value("event") ?? "event"} — ${value("status") ?? "recorded"}${result ? ` (${result})` : ""}`,
      ];
    }
    case "data-work-runtime": {
      const text = value("text");
      return [
        `### Runtime: ${value("status") ?? "recorded"}`,
        ...(typeof text === "string" && text ? [text] : []),
      ];
    }
    case ADVISOR_SUGGESTIONS_PART: {
      const model = value("model");
      const suggestions = value("suggestions");
      return [
        `### Advisor${typeof model === "string" ? `: ${model}` : ""}`,
        (Array.isArray(suggestions) ? suggestions : [])
          .map(
            (item) =>
              `- ${field(item, "severity") ?? "info"}: ${field(item, "message") ?? ""}`,
          )
          .join("\n"),
      ];
    }
    default:
      return assertNever(step.type);
  }
}
function stepMarkdown(step: ContentStep): string[] {
  switch (step.kind) {
    case "thinking":
      return [`### Reasoning\n\n${step.text}`];
    case "tool":
      return [
        `### Tool: ${step.toolName} — ${step.status}`,
        ...payloadMarkdown(step.input, step.output),
        ...(step.errorText ? [`Error:\n\n${fenced(step.errorText)}`] : []),
      ];
    case "data":
      return dataStepMarkdown(step);
    default:
      return assertNever(step);
  }
}
function blockMarkdown(block: ContentBlock): string[] {
  switch (block.kind) {
    case "text":
      return [block.text];
    case "file":
      return [
        `Attachment: ${block.filename ?? "attachment"} (${block.mediaType})${block.producer ? ` — ${block.producer}` : ""}`,
      ];
    case "stream-rule":
      return [
        `### Stream rule: ${block.trigger.name} — ${block.trigger.action}\n\n${block.trigger.message}`,
      ];
    case "context-maintenance":
      return [
        block.data.kind === "rewind"
          ? `### Rewind\n\n${block.data.report}`
          : `### Handoff\n\n${block.data.summary}`,
      ];
    case "process":
      return block.steps.flatMap(stepMarkdown);
    default:
      return assertNever(block);
  }
}
function markdownMessage(message: {
  id: string;
  role: string;
  parts: unknown;
}) {
  const parts = Array.isArray(message.parts)
    ? message.parts.filter(
        (part): part is { type: string; [key: string]: unknown } =>
          !!part && typeof part === "object" && typeof part.type === "string",
      )
    : [];
  const blocks = projectContent(message.id, parts, { streaming: false });
  // Composer references are the user's context, outside the reply content.
  const content = parts.flatMap((part) =>
    part.type === "text" && part.reference
      ? [
          `### Reference: @${field(part.reference, "label") ?? "reference"}\n\n${fenced(part.text)}`,
        ]
      : [],
  );
  content.push(...blocks.flatMap(blockMarkdown));
  if (!blocks.some((block) => block.kind === "text" && block.text)) {
    content.push(...assistantSegments(parts).map((segment) => segment.text));
  }
  return `## ${message.role}\n\n${content.join("\n\n")}\n\n`;
}
async function markdown(
  conversationId: string,
  title: string,
  secrets: readonly string[],
) {
  const chunks = [`# ${title}\n\n`];
  let bytes = Buffer.byteLength(chunks[0]);
  let cursor: string | undefined;
  for (;;) {
    const messages = await db.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
      take: 25,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, role: true, parts: true },
    });
    for (const message of messages) {
      const safe = sanitize(message, secrets) as typeof message;
      const chunk = markdownMessage(safe);
      bytes += Buffer.byteLength(chunk);
      if (bytes > SESSION_EXPORT_MAX_BYTES)
        throw new SessionExportError("SESSION_EXPORT_TOO_LARGE");
      chunks.push(chunk);
    }
    if (messages.length < 25) break;
    cursor = messages.at(-1)?.id;
  }
  return chunks.join("");
}
async function nativeExport(
  input: Parameters<typeof runSandboxSessionExport>[0],
) {
  const result: unknown = JSON.parse(await runSandboxSessionExport(input));
  if (!result || typeof result !== "object")
    throw new SessionExportError("SESSION_EXPORT_FAILED");
  if ("error" in result) {
    const code = exportFailures.is(result.error)
      ? result.error
      : "SESSION_EXPORT_FAILED";
    throw new SessionExportError(code);
  }
  if (!("content" in result) || typeof result.content !== "string")
    throw new SessionExportError("SESSION_EXPORT_FAILED");
  const content = Buffer.from(result.content, "base64").toString("utf8");
  assertSize(content);
  return content;
}

export async function handleConversationExport(
  req: Request,
  agentId: string,
  conversationId: string,
) {
  try {
    const user = await resolveRequestUser(req);
    if (!user) return failure("UNAUTHORIZED");
    const conversation = await db.conversation.findFirst({
      where: {
        id: conversationId,
        agentId,
        publicApiConversation: null,
        agent: {
          workspace: workspaceAccessWhere(user.id),
        },
      },
      include: { agent: true, sandbox: { include: { deployment: true } } },
    });
    if (!conversation) return failure("NOT_FOUND");
    const format = new URL(req.url).searchParams.get("format");
    if (format !== "jsonl" && format !== "html" && format !== "md")
      return failure("SESSION_EXPORT_FORMAT_INVALID");
    const secrets = await exportSecrets(
      conversation.agent.workspaceId,
      agentId,
    );
    const title = String(
      sanitize(conversation.title || "Conversation", secrets),
    );
    let content: string;
    if (format === "md")
      content = await markdown(conversationId, title, secrets);
    else {
      if (
        conversation.agent.runtimeKind !== "pi-sdk" ||
        conversation.agent.retiredAt ||
        conversation.legacyRevisionUnresolved ||
        !conversation.agentRevisionId
      )
        return failure("SESSION_EXPORT_NATIVE_UNAVAILABLE");
      const sandbox = conversation.sandbox;
      if (
        !sandbox ||
        effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !==
          "running"
      )
        return failure("SESSION_EXPORT_SANDBOX_NOT_RUNNING");
      const mapping = await findAgentConversationSandbox({
        workspaceId: conversation.agent.workspaceId,
        agentId,
        conversationId,
      });
      if (!mapping) return failure("SESSION_EXPORT_NATIVE_MISSING");
      let release: () => void;
      try {
        release = beginAgentConversationSandboxAccess(mapping.sandboxId);
      } catch {
        return failure("SESSION_EXPORT_SANDBOX_BUSY");
      }
      try {
        const input = {
          sandboxId: mapping.sandboxId,
          stateRoot: sandboxRuntimeStateRoot(
            "pi-sdk",
            agentId,
            mapping.workspaceRoot,
          ),
          runtimeSessionId:
            conversation.runtimeSessionId?.trim() || conversationId,
          signal: req.signal,
        };
        const raw = await nativeExport(input);
        const jsonl = `${raw
          .trimEnd()
          .split("\n")
          .map((line) => JSON.stringify(sanitize(JSON.parse(line), secrets)))
          .join("\n")}\n`;
        assertSize(jsonl);
        // Render HTML only from sanitized native entries, never from raw credentials.
        content =
          format === "jsonl" ? jsonl : await nativeExport({ ...input, jsonl });
      } finally {
        release();
      }
    }
    const currentUser = await resolveRequestUser(req);
    if (!currentUser || currentUser.id !== user.id)
      return failure("UNAUTHORIZED");
    const authorized = await db.conversation.findFirst({
      where: {
        id: conversationId,
        agentId,
        publicApiConversation: null,
        agent: {
          workspace: {
            id: conversation.agent.workspaceId,
            ...workspaceAccessWhere(currentUser.id),
          },
        },
      },
      select: { id: true },
    });
    if (!authorized) return failure("NOT_FOUND");
    assertSize(content);
    const filename = `${redactText(title, secrets)
      .replace(/[\p{Cc}/\\]/gu, "-")
      .slice(0, 100)}.${format}`;
    const fallback = safeAttachmentFilename(
      `conversation-${conversationId.slice(0, 64)}.${format}`,
    );
    const encoded = encodeURIComponent(filename.toWellFormed()).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(content, {
      headers: {
        "Content-Type":
          format === "html"
            ? "text/html; charset=utf-8"
            : format === "jsonl"
              ? "application/x-ndjson; charset=utf-8"
              : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        "Content-Length": String(Buffer.byteLength(content)),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (error) {
    return failure(
      error instanceof SessionExportError
        ? error.code
        : "SESSION_EXPORT_FAILED",
    );
  }
}
