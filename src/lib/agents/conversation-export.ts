import "server-only";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { safeAttachmentFilename } from "@/lib/attachments/storage";
import { redactText, sanitizeLog } from "@/lib/observability/redaction";
import { decryptSecretText } from "@/lib/security/secrets";
import { effectiveStatus } from "@/lib/process/supervisor";
import {
  beginAgentConversationSandboxAccess,
  findAgentConversationSandbox,
} from "./conversation-sandbox";
import {
  runSandboxSessionExport,
  sandboxRuntimeStateRoot,
} from "./sandbox-runtime";
import {
  toContentBlocks,
  workContentParts,
} from "@/lib/conversation/content-blocks";
import { assistantSegments } from "./message-segments";
import { agentTimelineDisplayParts } from "./turn-timeline";

export const SESSION_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const errors = {
  UNAUTHORIZED: [401, "Authentication is required."],
  NOT_FOUND: [404, "Conversation not found."],
  SESSION_EXPORT_FORMAT_INVALID: [400, "Choose jsonl, html, or md."],
  SESSION_EXPORT_NATIVE_UNAVAILABLE: [
    409,
    "Native export is unavailable for this historical session. Use Markdown.",
  ],
  SESSION_EXPORT_SANDBOX_NOT_RUNNING: [
    409,
    "Start the Agent sandbox before exporting this format.",
  ],
  SESSION_EXPORT_SANDBOX_BUSY: [
    409,
    "A sandbox lifecycle operation is in progress.",
  ],
  SESSION_EXPORT_NATIVE_MISSING: [
    409,
    "No persisted Pi session is available. Use Markdown.",
  ],
  SESSION_EXPORT_NATIVE_INVALID: [
    409,
    "The persisted Pi session cannot be exported. Use Markdown.",
  ],
  SESSION_EXPORT_TOO_LARGE: [
    413,
    "The session export exceeds the 8 MiB limit.",
  ],
  SESSION_EXPORT_FAILED: [500, "Session export failed."],
} as const;
type ErrorCode = keyof typeof errors;
class SessionExportError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
function failure(code: ErrorCode) {
  const [status, error] = errors[code];
  return Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
function assertSize(value: string) {
  if (Buffer.byteLength(value) > SESSION_EXPORT_MAX_BYTES)
    throw new SessionExportError("SESSION_EXPORT_TOO_LARGE");
}

/** Known values cover bare echoes; the shared sanitizer covers structured credentials. */
async function exportSecrets(workspaceId: string, agentId: string) {
  const [credentials, providers] = await Promise.all([
    db.agentEnvironmentCredential.findMany({
      // Include revoked references: historical tool output can still contain them.
      where: { workspaceId, agentId },
      select: { id: true, name: true, encryptedValue: true },
    }),
    db.modelProvider.findMany({
      where: { workspaceId },
      select: { apiKey: true },
    }),
  ]);
  const secrets = providers.map((provider) => provider.apiKey).filter(Boolean);
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
  const normalized = agentTimelineDisplayParts(parts).map((part) =>
    ["work-tool", "tool"].includes(part.type)
      ? workContentParts([part], true)[0]
      : part,
  );
  const blocks = toContentBlocks(message.id, normalized, { streaming: false });
  const content: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") content.push(block.text);
    else if (block.kind === "file")
      content.push(
        `Attachment: ${block.filename ?? "attachment"} (${block.mediaType})`,
      );
    else if (block.kind === "stream-rule")
      content.push(
        `### Stream rule: ${block.trigger.name} — ${block.trigger.action}\n\n${block.trigger.message}`,
      );
    else if (block.kind === "context-maintenance")
      content.push(
        block.data.kind === "rewind"
          ? `### Rewind\n\n${block.data.report}`
          : `### Handoff\n\n${block.data.summary}`,
      );
    else
      for (const step of block.steps) {
        if (step.kind === "thinking")
          content.push(`### Reasoning\n\n${step.text}`);
        if (step.kind === "tool") {
          content.push(`### Tool: ${step.toolName} — ${step.status}`);
          if (step.input !== undefined)
            content.push(`Input:\n\n${fenced(step.input)}`);
          if (step.output !== undefined)
            content.push(`Output:\n\n${fenced(step.output)}`);
          if (step.errorText)
            content.push(`Error:\n\n${fenced(step.errorText)}`);
        }
      }
  }
  if (!blocks.some((block) => block.kind === "text" && block.text)) {
    content.push(...assistantSegments(parts).map((segment) => segment.text));
  }
  // Child activity is a transcript summary, not an executable runtime grant.
  for (const part of parts) {
    const activity =
      part.type === "data-subagent-activity"
        ? part.data
        : part.source
          ? part
          : null;
    if (activity && typeof activity === "object") {
      const entry = activity as Record<string, unknown>;
      content.push(
        `### Subagent ${entry.type === "reasoning" ? "reasoning" : "tool"}: ${entry.toolName ?? "activity"} — ${entry.status ?? "recorded"}`,
      );
      if (entry.text) content.push(textValue(entry.text));
      if (entry.input !== undefined)
        content.push(`Input:\n\n${fenced(entry.input)}`);
      if (entry.output !== undefined)
        content.push(`Output:\n\n${fenced(entry.output)}`);
    }
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
    const code =
      typeof result.error === "string" && Object.hasOwn(errors, result.error)
        ? (result.error as ErrorCode)
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
          workspace: {
            status: "active",
            OR: [
              { ownerId: user.id },
              { members: { some: { userId: user.id } } },
            ],
          },
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
            status: "active",
            OR: [
              { ownerId: user.id },
              { members: { some: { userId: user.id } } },
            ],
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
