import "server-only";
import { nativeApprovalAdapter } from "./native-tool-approval";
import { withSandboxExecutionLease } from "./sandbox-execution-gate";
import { findAgentConversationSandbox } from "./conversation-sandbox";
import { PiRuntimeInterruptedError } from "./pi-harness";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
  runtimeAbortSignal,
  markRuntimeUncertain,
} from "@/lib/runtime/ownership-state";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { db } from "@/lib/db";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { effectiveStatus } from "@/lib/process/supervisor";
import { sandboxContainerName } from "@/lib/sandboxes/runtime";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
import { safeSkillFilePath, type SkillBundleFile } from "@/lib/skills/bundle";
import { skillLabel } from "@/lib/workspace/skill-label";
import {
  agentRuntimeBuiltinToolGroups,
  normalizeDisabledBuiltinTools,
} from "./runtime-kind";
import type { SkillForPrompt } from "./resolve";
import {
  RuntimeCommandsSchema,
  parseRuntimeUsage,
  type RuntimeCommand,
  type RuntimeUsage,
} from "./runtime-commands";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";
import { HOST_ONLY_COMMAND_NAMES } from "./runtime-commands";
import type { RuntimeCommandResult } from "./runtime-commands";
import { z } from "zod";
import type { ReasoningEffort } from "./constants";

export const PI_SDK_RUNTIME = {
  specs: [
    "@earendil-works/pi-coding-agent@0.87.1",
    "@earendil-works/pi-ai@0.87.1",
  ],
  directory: "/workspace/.toolplane/runtime-packages/pi-sdk-0.87.1",
  binary: "pi",
  ignoreScripts: true,
  allowBuilds: [],
} as const;

const PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 30 * 60_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const RUNTIME_TEMP_ROOT = "/workspace/.toolplane/runtime-tmp";
const NPM_CACHE = "/workspace/.toolplane/npm-cache";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SandboxAgentRuntimeKind =
  | "pi"
  | "pi-sdk"
  | "claude-code"
  | "dsh"
  | "hermes-rpc";

export type SandboxRuntimeProvider = {
  id: string;
  name: string;
  format: string;
};

export type SandboxRuntimeMcpServer = {
  deploymentId: string;
  url: string;
};

export type SandboxRuntimeMessage = {
  role: string;
  parts: Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
    data?: unknown;
    mimeType?: unknown;
    filename?: unknown;
    providerMetadata?: unknown;
  }>;
};
/** Native Pi expands once; finalInput is observed from the actual user message. */
export type AgentPromptInvocation = {
  name: string;
  source: {
    marketInstallId: string;
    releaseId: string;
    checksum: string;
    path: string;
  };
  version: string;
  rawArguments: string;
  arguments: string[];
  finalInput: string;
};

export type RunSandboxAgentTurnOptions = {
  runtimeKind: SandboxAgentRuntimeKind;
  workspaceId: string;
  agentId: string;
  sandboxId: string;
  conversationId?: string;
  a2aContextId?: string;
  provider: SandboxRuntimeProvider;
  modelId: string;
  maxSteps?: number;
  contextWindow: number;
  contextWindowEstimated?: boolean;
  modelProxyBase: string;
  runtimeAccessToken: string;
  nativeApprovalUrl?: string;
  systemPrompt?: string | null;
  piVersion?: string;
  disabledBuiltinTools?: readonly string[];
  messages: readonly SandboxRuntimeMessage[];
  skills?: readonly SkillForPrompt[];
  mcpServers?: readonly SandboxRuntimeMcpServer[];
  piPackages?: readonly {
    marketInstallId: string;
    releaseId: string;
    checksum: string;
    manifest: PiPackageManifestV1;
    mcpBindingsChecksum?: string;
  }[];
  workingDirectory?: string | null;
  runtimeSessionId?: string;
  command?: string;
  historyRequired?: boolean;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
  onCommands?: (commands: RuntimeCommand[]) => void | Promise<void>;
  onUsage?: (usage: RuntimeUsage) => void | Promise<void>;
  onPromptInvocation?: (
    invocation: AgentPromptInvocation,
  ) => void | Promise<void>;
  onCommandResult?: (result: RuntimeCommandResult) => void | Promise<void>;
};

export type SandboxRuntimeActivity = {
  type: "reasoning" | "tool";
  status: "running" | "completed" | "failed";
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  durationMs?: number;
  deploymentId?: string;
  originalToolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};

export type ClaudeStreamLine = {
  delta?: string;
  result?: string;
  assistantText?: string;
  contextTokens?: number;
  isError?: boolean;
  activities?: SandboxRuntimeActivity[];
};

export type PiStreamLine = {
  delta?: string;
  assistantText?: string;
  contextTokens?: number;
  error?: string;
  isError?: boolean;
  activities?: SandboxRuntimeActivity[];
};

export type DshStreamLine = {
  delta?: string;
  activities?: SandboxRuntimeActivity[];
};

type DockerExecOptions = {
  container: string;
  workdir: string;
  executable: string;
  user?: string;
  args?: string[];
  stdin?: string | Buffer;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  secrets?: readonly string[];
  piHarness?: boolean;
};

const installs = new Map<string, Promise<string>>();
const uncertainPiSandboxes = new Set<string>();

function byteSlice(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes
    ? value
    : `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

function displayValue(value: unknown, maxBytes = 20_000): string {
  if (typeof value === "string") return byteSlice(value, maxBytes);
  try {
    return byteSlice(JSON.stringify(value), maxBytes);
  } catch {
    return byteSlice(String(value), maxBytes);
  }
}

function safeSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return segment && segment !== "." && segment !== ".." ? segment : fallback;
}

function runtimeFilePath(
  part: SandboxRuntimeMessage["parts"][number],
): string | null {
  if (!part.providerMetadata || typeof part.providerMetadata !== "object")
    return null;
  const metadata = part.providerMetadata as Record<string, unknown>;
  const toolplane = metadata.toolplane;
  if (!toolplane || typeof toolplane !== "object") return null;
  const value = (toolplane as Record<string, unknown>).runtimePath;
  if (typeof value !== "string") return null;
  try {
    return normalizeSandboxWorkingDirectory(value);
  } catch {
    return null;
  }
}

function messagePartText(
  part: SandboxRuntimeMessage["parts"][number],
): string | null {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "work-tool" && part.toolName) {
    return [
      `[Recorded ${part.isError ? "failed" : "successful"} tool call: ${part.toolName}]`,
      `Input: ${displayValue(part.input)}`,
      `Output: ${displayValue(part.output)}`,
    ].join("\n");
  }
  if (part.type !== "file" && part.type !== "image") return null;
  const filename =
    (typeof part.filename === "string" ? part.filename.trim() : "") ||
    "attachment";
  const path = runtimeFilePath(part);
  if (path)
    return `[Attached file: ${filename.replace(/\s+/g, " ").slice(0, 240)} at ${path}]`;
  return `[Attached ${part.type === "image" ? "image" : "file"}: ${filename.replace(/\s+/g, " ").slice(0, 240)}; bytes are not mounted in this sandbox turn]`;
}

/** Resolve a user-selected path and prove it remains under /workspace. */
export function normalizeSandboxWorkingDirectory(value: unknown): string {
  if (value == null || value === "") return "/workspace";
  if (
    typeof value !== "string" ||
    value.length > 1_000 ||
    value.includes("\0")
  ) {
    throw new Error("Invalid sandbox working directory.");
  }
  const input =
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/workspace(?:\/|$)/, "") || ".";
  if (input.startsWith("/"))
    throw new Error("Sandbox working directory must be under /workspace.");
  const resolved = posix.resolve("/workspace", input);
  if (resolved !== "/workspace" && !resolved.startsWith("/workspace/")) {
    throw new Error("Sandbox working directory must be under /workspace.");
  }
  return resolved;
}

export function buildSandboxTranscript(
  messages: readonly SandboxRuntimeMessage[],
): string {
  return messages
    .flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = message.parts
        .flatMap((part) => {
          const value = messagePartText(part);
          return value?.trim() ? [value] : [];
        })
        .join("\n")
        .trim();
      return text ? [`### ${message.role.toUpperCase()}\n${text}`] : [];
    })
    .join("\n\n")
    .trim();
}

export type SandboxSkillBundle = {
  directory: string;
  markdown: string;
  files: SkillBundleFile[];
};

function sandboxSkillDirectoryName(
  skill: SkillForPrompt,
  used: Set<string>,
): string {
  const label = skillLabel({
    skillId: skill.skillId,
    skill: skill.skill,
    name: skill.name ?? null,
    slug: skill.slug ?? null,
    source: skill.source ?? null,
  });
  const base =
    label.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  let directory = base;
  for (let suffix = 2; used.has(directory); suffix += 1)
    directory = `${base}-${suffix}`;
  used.add(directory);
  return directory;
}

export function buildSandboxSkillBundles(
  skills: readonly SkillForPrompt[],
): SandboxSkillBundle[] {
  const usedDirectories = new Set<string>();
  return skills.map((skill) => ({
    directory: sandboxSkillDirectoryName(skill, usedDirectories),
    markdown: buildInstalledSkillMarkdown(skill),
    files: installedSkillExtraFiles(skill),
  }));
}

export function sandboxSkillBundleDigest(
  bundles: readonly SandboxSkillBundle[],
): string {
  return createHash("sha256").update(JSON.stringify(bundles)).digest("hex");
}

export function waitForSandboxRuntimeInstall<T>(
  install: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return install;
  if (signal.aborted)
    return Promise.reject(new Error("Sandbox runtime aborted."));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Sandbox runtime aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void install.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function piProviderProtocol(format: string): string {
  if (format === "anthropic") return "anthropic-messages";
  if (format === "openai-responses") return "openai-responses";
  if (format === "openai") return "openai-completions";
  throw new Error(`Pi does not support provider format: ${format}.`);
}

function httpUrl(value: string, label: string): string {
  if (value.length > 4_000) throw new Error(`${label} is too long.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function mcpName(server: SandboxRuntimeMcpServer, index: number): string {
  const stem = safeSegment(server.deploymentId, "server").slice(0, 20);
  return `tp_${index + 1}_${stem}`.slice(0, 32);
}

export function resolveSandboxMcpToolOrigin(
  toolName: string | undefined,
  servers: readonly SandboxRuntimeMcpServer[],
): Pick<SandboxRuntimeActivity, "deploymentId" | "originalToolName"> | null {
  if (!toolName) return null;
  const pi = /^mcp__s(\d+)_t\d+__/.exec(toolName);
  if (pi) {
    const server = servers[Number(pi[1]) - 1];
    // Pi's generated suffix is sanitized and can be truncated. The extension
    // reports the exact name separately, so do not present this fallback as raw.
    return server ? { deploymentId: server.deploymentId } : null;
  }
  for (const [index, server] of servers.entries()) {
    const alias = mcpName(server, index);
    for (const prefix of [`mcp__${alias}__`, `${alias}__`]) {
      if (!toolName.startsWith(prefix) || toolName.length === prefix.length)
        continue;
      return {
        deploymentId: server.deploymentId,
        originalToolName: toolName.slice(prefix.length),
      };
    }
  }
  return null;
}

export function sandboxRuntimeCanReachProxy(network: string): boolean {
  return network !== "none";
}

export function sandboxRuntimeStateRoot(
  runtimeKind: SandboxAgentRuntimeKind,
  agentId: string,
): string {
  return `/workspace/.toolplane/runtimes/${runtimeKind}/agents/${safeSegment(agentId, "agent")}`;
}

export function sandboxRuntimeSkillRoot(
  runtimeKind: SandboxAgentRuntimeKind,
  agentId: string,
): string {
  return `${sandboxRuntimeStateRoot(runtimeKind, agentId)}/skills`;
}

export function sandboxRuntimeExecWrapper(controlPrefix: string): string {
  return `pid_file=$1; shift; umask 077; printf '%s\\n' "$$" > "$pid_file"; trap 'rm -f -- "$pid_file"' EXIT; printf '${controlPrefix}%s\\n' "$$"; "$@"`;
}

export function buildPiModelsConfig(options: {
  provider: SandboxRuntimeProvider;
  modelId: string;
  modelProxyBase: string;
}): string {
  return JSON.stringify(
    {
      providers: {
        toolplane: {
          name: options.provider.name || "ToolPlane",
          baseUrl: httpUrl(options.modelProxyBase, "model proxy URL"),
          api: piProviderProtocol(options.provider.format),
          apiKey: "$TOOLPLANE_RUNTIME_TOKEN",
          models: [
            {
              id: options.modelId,
              name: options.modelId,
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 16_384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  );
}

export function buildPiMcpConfig(
  servers: readonly SandboxRuntimeMcpServer[],
): string {
  return JSON.stringify({
    servers: servers.map((server, index) => ({
      name: mcpName(server, index),
      deploymentId: server.deploymentId,
      url: httpUrl(server.url, "MCP proxy URL"),
    })),
  });
}

/** Native Pi names use zero-based server/catalog positions, not raw MCP wire names. */
export function nativePiMcpToolName(
  serverIndex: number,
  toolIndex: number,
  wireName: string,
): string {
  const suffix = String(wireName).replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__s${serverIndex + 1}_t${toolIndex + 1}__${suffix}`.slice(0, 63);
}

/** Loaded explicitly with --extension; it discovers and invokes ToolPlane MCP tools over JSON-RPC. */
export function piMcpExtensionSource(
  options: { eventFd?: 1 | 3 } = {},
): string {
  return String.raw`import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_REGISTERED_TOOLS = 256;

function short(value, max = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, max);
}

async function readLimited(response) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    throw new Error('MCP response exceeded its byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel('MCP response byte limit exceeded').catch(() => undefined);
        throw new Error('MCP response exceeded its byte limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function rpc(server, method, params, signal) {
  const token = process.env.TOOLPLANE_RUNTIME_TOKEN;
  if (!token) throw new Error('Missing ToolPlane runtime token');
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error('MCP request exceeded its byte limit');
  }
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(server.url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await readLimited(response);
  if (!response.ok) throw new Error('MCP HTTP ' + response.status + ': ' + short(text));
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('MCP returned invalid JSON');
  }
  if (payload && payload.error) throw new Error(short(payload.error.message || payload.error));
  return payload && payload.result ? payload.result : {};
}

const nativePiMcpToolName = ${nativePiMcpToolName.toString()};

function toolParameters(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const encoded = new TextEncoder().encode(JSON.stringify(schema));
  if (encoded.byteLength > MAX_SCHEMA_BYTES) throw new Error('MCP tool schema exceeded its byte limit');
  return schema;
}

function textContent(value) {
  return { type: 'text', text: short(value, MAX_RESPONSE_BYTES) };
}

function toPiContent(part) {
  if (part && part.type === 'text' && typeof part.text === 'string') return textContent(part.text);
  if (part && part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
    return { type: 'image', data: part.data, mimeType: part.mimeType };
  }
  if (part && part.type === 'resource' && part.resource && typeof part.resource.text === 'string') {
    return textContent(part.resource.text);
  }
  if (part && part.type === 'resource_link') return textContent('[resource: ' + String(part.uri || '') + ']');
  if (part && part.type === 'audio') return textContent('[audio content: ' + String(part.mimeType || 'unknown') + ']');
  return textContent(part);
}

function errorText(content) {
  return content.map((part) => part && part.type === 'text' ? String(part.text || '') : '').filter(Boolean).join('\n');
}

export async function createPiMcpTools(config) {
  if (!config || !Array.isArray(config.servers)) throw new Error('Invalid ToolPlane Pi MCP config');

  let registeredTools = 0;
  const definitions = [];
  for (let serverIndex = 0; serverIndex < config.servers.length; serverIndex += 1) {
    const server = config.servers[serverIndex];
    if (!server || typeof server.name !== 'string' || typeof server.deploymentId !== 'string' || typeof server.url !== 'string') {
      throw new Error('Invalid ToolPlane MCP server entry');
    }
    const catalog = await rpc(server, 'tools/list');
    const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
      const tool = tools[toolIndex];
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      if (registeredTools >= MAX_REGISTERED_TOOLS) throw new Error('MCP tool catalog exceeded its limit');
      const wireName = tool.name;
      definitions.push({
        name: nativePiMcpToolName(serverIndex, toolIndex, wireName),
        label: wireName,
        description: short((tool.description || '') + '\nMCP server: ' + server.name),
        parameters: toolParameters(tool.inputSchema),
        async execute(toolCallId, params, signal) {
          writeSync(${options.eventFd ?? 1}, JSON.stringify({
            type: 'toolplane_mcp_origin',
            toolCallId,
            deploymentId: server.deploymentId,
            originalToolName: wireName,
          }) + '\n');
          const result = await rpc(server, 'tools/call', { name: wireName, arguments: params || {} }, signal);
          const content = Array.isArray(result.content) ? result.content : [];
          if (result.isError) throw new Error(errorText(content) || 'MCP tool returned an error');
          return {
            content: content.length ? content.map(toPiContent) : [textContent(result.structuredContent ?? '')],
            details: result.structuredContent ?? null,
          };
        },
      });
      registeredTools += 1;
    }
  }
  return definitions;
}

export default async function toolplaneMcpExtension(pi) {
  const configPath = process.env.TOOLPLANE_PI_MCP_CONFIG;
  if (!configPath) throw new Error('Missing ToolPlane Pi MCP config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const tool of await createPiMcpTools(config)) pi.registerTool(tool);
}
`;
}

function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function piContextTokens(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const total = usageNumber(usage.totalTokens);
  if (total !== null) return total;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  return input !== null && output !== null ? input + output : null;
}

function claudeContextTokens(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const values = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].map(usageNumber);
  return values.some((item) => item !== null)
    ? values.reduce<number>((total, item) => total + (item ?? 0), 0)
    : null;
}

function piMessageResult(message: unknown): PiStreamLine | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.role !== "assistant") return null;
  const content = Array.isArray(value.content) ? value.content : [];
  const assistantText = content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? [(part as Record<string, unknown>).text as string]
        : [],
    )
    .join("");
  const isError =
    value.stopReason === "error" || value.stopReason === "aborted";
  const error =
    typeof value.errorMessage === "string"
      ? value.errorMessage
      : isError
        ? `Pi request ${String(value.stopReason)}.`
        : "";
  const contextTokens = piContextTokens(value.usage);
  if (!assistantText && !error && contextTokens === null) return null;
  return {
    ...(assistantText ? { assistantText } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(error ? { error } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export function parsePiStreamLine(line: string): PiStreamLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.type === "toolplane_mcp_origin" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.deploymentId === "string" &&
    typeof payload.originalToolName === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: payload.toolCallId,
          deploymentId: payload.deploymentId,
          originalToolName: payload.originalToolName,
        },
      ],
    };
  }
  if (
    payload.type === "message_update" &&
    payload.assistantMessageEvent &&
    typeof payload.assistantMessageEvent === "object"
  ) {
    const event = payload.assistantMessageEvent as Record<string, unknown>;
    if (event.type === "text_delta" && typeof event.delta === "string")
      return { delta: event.delta };
    if (event.type === "thinking_start") {
      return { activities: [{ type: "reasoning", status: "running" }] };
    }
    if (event.type === "thinking_delta" && typeof event.delta === "string") {
      return {
        activities: [
          { type: "reasoning", status: "running", delta: event.delta },
        ],
      };
    }
    if (event.type === "thinking_end") {
      return { activities: [{ type: "reasoning", status: "completed" }] };
    }
  }
  if (
    payload.type === "tool_execution_start" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: payload.args,
        },
      ],
    };
  }
  if (
    payload.type === "tool_execution_end" &&
    typeof payload.toolCallId === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: payload.isError === true ? "failed" : "completed",
          toolCallId: payload.toolCallId,
          ...(typeof payload.toolName === "string"
            ? { toolName: payload.toolName }
            : {}),
          output: payload.result,
          isError: payload.isError === true,
        },
      ],
    };
  }
  if (payload.type === "message_end" || payload.type === "turn_end") {
    return piMessageResult(payload.message);
  }
  if (payload.type === "agent_end" && Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const result = piMessageResult(payload.messages[index]);
      if (result) return result;
    }
  }
  return null;
}

export function parseClaudeStreamLine(line: string): ClaudeStreamLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.type === "system" &&
    payload.subtype === "status" &&
    (payload.compact_result === "failed" ||
      typeof payload.compact_error === "string")
  ) {
    return {
      result:
        typeof payload.compact_error === "string"
          ? payload.compact_error
          : "Compaction failed.",
      isError: true,
    };
  }
  if (
    payload.type === "stream_event" &&
    payload.event &&
    typeof payload.event === "object"
  ) {
    const event = payload.event as Record<string, unknown>;
    if (
      event.type === "content_block_start" &&
      event.content_block &&
      typeof event.content_block === "object"
    ) {
      const block = event.content_block as Record<string, unknown>;
      if (block.type === "thinking") {
        return { activities: [{ type: "reasoning", status: "running" }] };
      }
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        return {
          activities: [
            {
              type: "tool",
              status: "running",
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
            },
          ],
        };
      }
    }
    const delta = event.delta;
    if (
      event.type === "content_block_delta" &&
      delta &&
      typeof delta === "object"
    ) {
      const block = delta as Record<string, unknown>;
      if (block.type === "text_delta" && typeof block.text === "string")
        return { delta: block.text };
      if (
        block.type === "thinking_delta" &&
        typeof block.thinking === "string"
      ) {
        return {
          activities: [
            { type: "reasoning", status: "running", delta: block.thinking },
          ],
        };
      }
    }
  }
  if (payload.type === "result") {
    const contextTokens = claudeContextTokens(payload.usage);
    return {
      ...(typeof payload.result === "string"
        ? { result: payload.result }
        : Array.isArray(payload.errors)
          ? {
              result: payload.errors
                .filter((error) => typeof error === "string")
                .join("\n"),
            }
          : {}),
      ...(contextTokens !== null ? { contextTokens } : {}),
      ...(payload.is_error === true ? { isError: true } : {}),
    };
  }
  if (
    payload.type === "assistant" &&
    payload.message &&
    typeof payload.message === "object"
  ) {
    const content = (payload.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const assistantText = content
      .flatMap((part) =>
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? [(part as Record<string, unknown>).text as string]
          : [],
      )
      .join("");
    const activities = content.flatMap((part): SandboxRuntimeActivity[] => {
      if (!part || typeof part !== "object") return [];
      const block = part as Record<string, unknown>;
      if (
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        typeof block.name !== "string"
      )
        return [];
      return [
        {
          type: "tool",
          status: "running",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        },
      ];
    });
    const contextTokens = claudeContextTokens(
      (payload.message as Record<string, unknown>).usage,
    );
    return assistantText || contextTokens !== null || activities.length
      ? {
          ...(assistantText ? { assistantText } : {}),
          ...(contextTokens !== null ? { contextTokens } : {}),
          ...(activities.length ? { activities } : {}),
        }
      : null;
  }
  if (
    payload.type === "user" &&
    payload.message &&
    typeof payload.message === "object"
  ) {
    const content = (payload.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const activities = content.flatMap((part): SandboxRuntimeActivity[] => {
      if (!part || typeof part !== "object") return [];
      const block = part as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
        return [];
      return [
        {
          type: "tool",
          status: block.is_error === true ? "failed" : "completed",
          toolCallId: block.tool_use_id,
          output: block.content,
          isError: block.is_error === true,
        },
      ];
    });
    return activities.length ? { activities } : null;
  }
  return null;
}

export function parseDshEventLine(
  line: string,
  prefix: string,
): DshStreamLine | null {
  if (!prefix || !line.startsWith(prefix)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (payload.type === "text" && typeof payload.delta === "string")
    return { delta: payload.delta };
  if (
    payload.type === "reasoning" &&
    (payload.status === "running" || payload.status === "completed")
  ) {
    return {
      activities: [
        {
          type: "reasoning",
          status: payload.status,
          ...(typeof payload.delta === "string"
            ? { delta: payload.delta }
            : {}),
        },
      ],
    };
  }
  if (
    payload.type === "tool" &&
    typeof payload.toolCallId === "string" &&
    (payload.status === "running" ||
      payload.status === "completed" ||
      payload.status === "failed")
  ) {
    let input = payload.input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        /* keep malformed tool arguments readable */
      }
    }
    return {
      activities: [
        {
          type: "tool",
          status: payload.status,
          toolCallId: payload.toolCallId,
          ...(typeof payload.toolName === "string"
            ? { toolName: payload.toolName }
            : {}),
          ...(payload.input === undefined ? {} : { input }),
          ...(payload.output === undefined ? {} : { output: payload.output }),
          isError: payload.isError === true || payload.status === "failed",
        },
      ],
    };
  }
  return null;
}

function dockerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...extra,
  };
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (text, secret) => (secret ? text.split(secret).join("[REDACTED]") : text),
    value,
  );
}

function runDockerOnce(args: string[], timeoutMs = 10_000): Promise<void> {
  assertRuntimeOwner(true);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: dockerEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      markRuntimeUncertain();
      finish(new Error("Docker cleanup timed out."));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES)
        stderr += chunk.toString();
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) =>
      code === 0
        ? finish()
        : finish(
            new Error(
              stderr.trim() || `Docker cleanup failed (${code ?? "unknown"}).`,
            ),
          ),
    );
  });
}

async function terminateDockerExec(
  container: string,
  pid: number | null,
  pidFile: string,
  confirm = false,
): Promise<void> {
  const script = `
pid=$1
pid_file=$2
if [ -z "$pid" ] && [ -r "$pid_file" ]; then pid=$(cat "$pid_file" 2>/dev/null || true); fi
rm -f -- "$pid_file"
case "$pid" in ''|*[!0-9]*) exit 3 ;; esac
pids=''
kill_tree() {
  for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do kill_tree "$child"; done
  pids="$pids $1"
  kill -KILL "$1" 2>/dev/null || true
}
kill_tree "$pid"
if [ "$3" = confirm ]; then
  for stopped in $pids; do
    attempts=0
    while kill -0 "$stopped" 2>/dev/null; do
      stat=$(cat "/proc/$stopped/stat" 2>/dev/null || true)
      case "$stat" in ''|*') Z '*) break ;; esac
      attempts=$((attempts + 1))
      [ "$attempts" -lt 50 ] || exit 4
      sleep 0.1
    done
  done
fi
`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await runDockerOnce([
        "exec",
        container,
        "sh",
        "-c",
        script,
        "toolplane-kill",
        pid == null ? "" : String(pid),
        pidFile,
        confirm ? "confirm" : "",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (confirm) {
    uncertainPiSandboxes.add(container);
    markRuntimeUncertain();
    throw new Error(
      "PI_PROCESS_STOP_UNCONFIRMED: runtime owner recovery is required before reopening this sandbox.",
    );
  }
}

function runTrackedDockerExec(options: DockerExecOptions): Promise<string> {
  const ownerSignal = runtimeAbortSignal();
  const signal = ownerSignal
    ? options.signal
      ? AbortSignal.any([options.signal, ownerSignal])
      : ownerSignal
    : options.signal;
  return trackRuntimeOperation(() =>
    runTrackedDockerExecOwned({ ...options, signal }),
  );
}
function runTrackedDockerExecOwned(
  options: DockerExecOptions,
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Sandbox runtime aborted."));
  const commandEnv = options.env ?? {};
  for (const [key, value] of Object.entries(commandEnv)) {
    if (!ENV_NAME.test(key) || value.includes("\0"))
      throw new Error("Invalid sandbox runtime environment.");
  }
  const executionId = randomUUID();
  const controlPrefix = `__TOOLPLANE_RUNTIME_PID_${executionId}__`;
  const pidFile = `/tmp/toolplane-runtime-${executionId}.pid`;
  const wrapper = sandboxRuntimeExecWrapper(controlPrefix);
  const dockerArgs = [
    "exec",
    "-i",
    ...(options.user ? ["--user", options.user] : []),
    "-w",
    options.workdir,
    ...Object.keys(commandEnv).flatMap((key) => ["--env", key]),
    options.container,
    "sh",
    "-c",
    wrapper,
    "toolplane-runtime",
    pidFile,
    options.executable,
    ...(options.args ?? []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerArgs, {
      env: dockerEnv(commandEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const secrets = options.secrets ?? [];
    const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    let stdout = "";
    let stderr = "";
    let prelude = "";
    let preludeDone = false;
    let innerPid: number | null = null;
    let stopError: Error | null = null;
    let stopping: Promise<void> | null = null;
    let terminationError: unknown;
    let aborted = false;
    let settled = false;
    let callbackChain = Promise.resolve();
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = () => {
      if (stopping) return;
      stopping = terminateDockerExec(
        options.container,
        innerPid,
        pidFile,
        options.piHarness,
      )
        .catch((error: unknown) => {
          terminationError = error;
        })
        .finally(() => {
          child.kill("SIGKILL");
        });
    };
    const stop = (error: Error) => {
      if (!stopError) stopError = error;
      terminate();
      if (!forceKillTimer)
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const appendStdout = (chunk: string) => {
      if (!chunk) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > maxStdout) {
        stop(new Error("Sandbox runtime output exceeded its limit."));
        return;
      }
      stdout += chunk;
      const onStdout = options.onStdout;
      if (onStdout)
        callbackChain = callbackChain.then(() => onStdout.call(options, chunk));
    };
    const consumeStdout = (chunk: string) => {
      if (preludeDone) return appendStdout(chunk);
      prelude += chunk;
      const newline = prelude.indexOf("\n");
      if (newline < 0) return;
      const firstLine = prelude.slice(0, newline).replace(/\r$/, "");
      const rest = prelude.slice(newline + 1);
      prelude = "";
      preludeDone = true;
      if (firstLine.startsWith(controlPrefix)) {
        const pid = Number(firstLine.slice(controlPrefix.length));
        if (Number.isSafeInteger(pid) && pid > 0) innerPid = pid;
      } else {
        appendStdout(`${firstLine}\n`);
      }
      if (stopError) terminate();
      appendStdout(rest);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if (options.piHarness && code !== 0 && !spawnError) terminate();
      if (stopping) await stopping;
      if (terminationError) return reject(terminationError);
      try {
        await callbackChain;
      } catch (error) {
        reject(error);
        return;
      }
      if (stopError)
        return reject(
          options.piHarness && aborted
            ? new PiRuntimeInterruptedError(
                "Pi driver stopped before its operation settled.",
                { cause: stopError },
              )
            : stopError,
        );
      if (spawnError)
        return reject(
          options.piHarness &&
            ["EPIPE", "ECONNRESET", "ECONNABORTED"].includes(
              (spawnError as NodeJS.ErrnoException).code ?? "",
            )
            ? new PiRuntimeInterruptedError(
                "Pi driver transport disconnected.",
                { cause: spawnError },
              )
            : spawnError,
        );
      if (code !== 0) {
        const detail = redact(stderr.trim(), secrets);
        if (options.piHarness && (signal || code === 137 || code === 143)) {
          return reject(
            new PiRuntimeInterruptedError(
              detail || "Pi driver process was terminated.",
            ),
          );
        }
        return reject(
          new Error(
            detail ||
              `Sandbox command failed (${signal ?? code ?? "unknown"}).`,
          ),
        );
      }
      resolve(stdout);
    };
    const onAbort = () => {
      aborted = true;
      stop(new Error("Sandbox runtime aborted."));
    };
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            `Sandbox runtime timed out after ${options.timeoutMs ?? TURN_TIMEOUT_MS}ms.`,
          ),
        ),
      options.timeoutMs ?? TURN_TIMEOUT_MS,
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) =>
      consumeStdout(stdoutDecoder.write(chunk)),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES)
        stderr += stderrDecoder.write(chunk);
    });
    child.once("error", (error) => void finish(null, null, error));
    child.once(
      options.piHarness ? "close" : "exit",
      (code, signal) => void finish(code, signal),
    );
    if (options.piHarness) {
      const onTransportError = (error: NodeJS.ErrnoException) =>
        stop(
          ["EPIPE", "ECONNRESET", "ECONNABORTED"].includes(error.code ?? "")
            ? new PiRuntimeInterruptedError(
                "Pi driver transport disconnected.",
                { cause: error },
              )
            : error,
        );
      child.stdin?.on("error", onTransportError);
      child.stdout?.on("error", onTransportError);
      child.stderr?.on("error", onTransportError);
    }
    child.stdin?.end(options.stdin ?? "");
  });
}
export type PiSdkCapabilityInventory = {
  commands: string[];
  tools: string[];
  prompts: { name: string; path: string }[];
  skills: string[];
};

/** Executes native factories only inside the credential-free, offline capture image. */
export async function preflightPiSdkCapabilities(input: {
  piPackages?: RunSandboxAgentTurnOptions["piPackages"];
  skills?: readonly SkillForPrompt[];
  toolNames?: readonly string[];
  signal?: AbortSignal;
}): Promise<PiSdkCapabilityInventory> {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    const ownerSignal = runtimeAbortSignal();
    const signal = ownerSignal
      ? input.signal
        ? AbortSignal.any([ownerSignal, input.signal])
        : ownerSignal
      : input.signal;
    const name = `toolplane-pi-preflight-${randomUUID()}`;
    const directory = await mkdtemp(`${tmpdir()}/toolplane-pi-preflight-`);
    const command = (args: string[], stdin?: string) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "docker",
          args,
          { env: dockerEnv(), timeout: 30_000, maxBuffer: 1024 * 1024, signal },
          (error, stdout) =>
            error
              ? reject(
                  new Error("PI_CAPABILITY_PREFLIGHT_FAILED", { cause: error }),
                )
              : resolve(stdout),
        );
        child.stdin?.end(stdin);
      });
    let created = false;
    try {
      const packages = (input.piPackages ?? []).map((item) => ({
        ...item,
        manifest: parsePiPackageReleaseManifest(item.manifest, item.checksum),
      }));
      await chmod(directory, 0o755);
      for (const source of [
        "pi-sdk-preflight.mjs",
        "pi-sdk-capabilities.mjs",
        "pi-sdk-package-files.mjs",
      ]) {
        await writeFile(
          `${directory}/${source}`,
          await readFile(`${process.cwd()}/scripts/${source}`),
          { mode: 0o444 },
        );
      }
      await command([
        "create",
        "--name",
        name,
        "-i",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,mode=1777,size=256m",
        "--mount",
        `type=bind,source=${directory},target=/opt/toolplane-preflight,readonly`,
        "--entrypoint",
        "/usr/bin/env",
        "toolplane-pi-package-capture:0.87.1",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=/tmp",
        "node",
        "/opt/toolplane-preflight/pi-sdk-preflight.mjs",
      ]);
      created = true;
      const output = await command(
        ["start", "-ai", name],
        JSON.stringify({
          packages,
          skills: buildSandboxSkillBundles(input.skills ?? []),
          toolNames: input.toolNames ?? [],
          hostCommands: HOST_ONLY_COMMAND_NAMES,
        }),
      );
      const result: unknown = JSON.parse(output);
      const failure = z
        .object({
          error: z.enum(["PI_CAPABILITY_CONFLICT", "PI_EXTENSION_LOAD_FAILED"]),
          detail: z.string().max(2048).optional(),
        })
        .safeParse(result);
      if (failure.success)
        throw new Error(failure.data.error, {
          cause: failure.data.detail
            ? new Error(failure.data.detail)
            : undefined,
        });
      return z
        .object({
          commands: z.array(z.string()),
          tools: z.array(z.string()),
          skills: z.array(z.string()),
          prompts: z.array(z.object({ name: z.string(), path: z.string() })),
        })
        .parse(result);
    } finally {
      if (created) await runDockerOnce(["rm", "-f", name]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function writeSandboxFile(
  container: string,
  path: string,
  content: string | Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const script = 'set -eu; umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"';
  await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "sh",
    args: ["-c", script, "toolplane-write", path],
    stdin: content,
    signal,
    timeoutMs: 30_000,
  });
}

async function materializeSandboxSkills(
  container: string,
  skillRoot: string,
  skills: readonly SkillForPrompt[],
  signal?: AbortSignal,
): Promise<void> {
  const bundles = buildSandboxSkillBundles(skills);
  const digest = sandboxSkillBundleDigest(bundles);
  const marker = `${skillRoot}/.toolplane-skills.sha256`;
  const unchanged = await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "sh",
    args: [
      "-c",
      'test -r "$1" && [ "$(cat "$1")" = "$2" ]',
      "toolplane-check-skills",
      marker,
      digest,
    ],
    signal,
    timeoutMs: 10_000,
  }).then(
    () => true,
    () => false,
  );
  if (unchanged) return;
  if (signal?.aborted) throw new Error("Sandbox runtime aborted.");
  const reset = `
set -eu
root=$1
case "$root" in /workspace/.toolplane/runtimes/*/agents/*/skills) ;; *) exit 2 ;; esac
rm -rf -- "$root"
mkdir -p "$root"
`;
  await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "sh",
    args: ["-c", reset, "toolplane-reset-skills", skillRoot],
    signal,
    timeoutMs: 30_000,
  });
  for (const bundle of bundles) {
    const directory = `${skillRoot}/${bundle.directory}`;
    await writeSandboxFile(
      container,
      `${directory}/SKILL.md`,
      bundle.markdown,
      signal,
    );
    for (const file of bundle.files) {
      const path = safeSkillFilePath(file.path);
      if (!path) continue;
      await writeSandboxFile(
        container,
        `${directory}/${path}`,
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : file.content,
        signal,
      );
    }
  }
  await writeSandboxFile(container, marker, digest, signal);
}

async function removeSandboxFiles(
  container: string,
  paths: string[],
): Promise<void> {
  if (!paths.length) return;
  await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "rm",
    args: ["-f", "--", ...paths],
    timeoutMs: 10_000,
  }).catch(() => undefined);
}

async function assertAssignedDockerSandbox(
  options: Pick<
    RunSandboxAgentTurnOptions,
    "workspaceId" | "agentId" | "sandboxId" | "conversationId" | "a2aContextId"
  >,
  cleanup = false,
): Promise<string> {
  if (options.conversationId || options.a2aContextId) {
    const mapped = await findAgentConversationSandbox({
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      conversationId: options.conversationId,
      contextId: options.a2aContextId,
      cleanup,
    });
    if (!mapped || mapped.sandboxId !== options.sandboxId)
      throw new Error("The sandbox does not match this conversation/context.");
    const sandbox = await db.sandbox.findFirst({
      where: {
        id: mapped.sandboxId,
        workspaceId: options.workspaceId,
        kind: "docker",
      },
      select: {
        network: true,
        deploymentId: true,
        deployment: { select: { status: true } },
      },
    });
    if (
      !sandbox ||
      !sandboxRuntimeCanReachProxy(sandbox.network) ||
      effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !==
        "running"
    )
      throw new Error("The conversation sandbox is not ready.");
    return sandbox.deploymentId;
  }
  const link = await db.agentSandbox.findUnique({
    where: {
      agentId_sandboxId: {
        agentId: options.agentId,
        sandboxId: options.sandboxId,
      },
    },
    select: {
      agent: { select: { workspaceId: true } },
      sandbox: {
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          network: true,
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      },
    },
  });
  if (
    !link ||
    link.agent.workspaceId !== options.workspaceId ||
    link.sandbox.workspaceId !== options.workspaceId
  ) {
    throw new Error("The sandbox is not assigned to this Agent.");
  }
  if (link.sandbox.kind !== "docker")
    throw new Error(
      "Pi, Claude Code, and DeepSeek Harness require a Docker sandbox.",
    );
  if (!sandboxRuntimeCanReachProxy(link.sandbox.network)) {
    throw new Error(
      "The assigned Docker sandbox has networking disabled and cannot reach the model proxy.",
    );
  }
  if (
    effectiveStatus(
      link.sandbox.deploymentId,
      link.sandbox.deployment.status,
    ) !== "running"
  ) {
    throw new Error("The assigned Docker sandbox is not running.");
  }
  return link.sandbox.deploymentId;
}

async function ensureRuntimeInstalled(
  container: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Sandbox runtime aborted.");
  const runtime = PI_SDK_RUNTIME;
  const binary = `${runtime.directory}/node_modules/.bin/${runtime.binary}`;
  const cacheKey = `${container}:${runtime.directory}`;
  const existing = installs.get(cacheKey);
  if (existing) return waitForSandboxRuntimeInstall(existing, signal);
  const install = (async () => {
    const found = await runTrackedDockerExec({
      container,
      workdir: "/workspace",
      executable: "test",
      args: ["-x", binary],
      timeoutMs: 10_000,
    }).then(
      () => true,
      () => false,
    );
    if (!found) {
      const installCommand = {
        executable: "sh",
        args: [
          "-c",
          'set -eu; prefix=$1; shift; mkdir -p "$prefix"; rm -rf -- "$prefix/node_modules"; cd "$prefix"; exec "$@"',
          "toolplane-pnpm-install",
          runtime.directory,
          "pnpm",
          "add",
          "--save-prod",
          "--ignore-workspace",
          "--save-exact",
          ...(runtime.ignoreScripts ? ["--ignore-scripts"] : []),
          ...runtime.allowBuilds.map((name) => `--allow-build=${name}`),
          "--store-dir",
          `${NPM_CACHE}/pnpm-store`,
          ...runtime.specs,
        ],
      };
      await runTrackedDockerExec({
        container,
        workdir: "/workspace",
        ...installCommand,
        timeoutMs: PACKAGE_INSTALL_TIMEOUT_MS,
      }).catch((error) => {
        throw new Error(
          `Could not install ${runtime.specs.join(" and ")} in the assigned sandbox: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    await runTrackedDockerExec({
      container,
      workdir: "/workspace",
      executable: "test",
      args: ["-x", binary],
      timeoutMs: 10_000,
    });
    await runTrackedDockerExec({
      container,
      workdir: runtime.directory,
      executable: "node",
      args: [
        "-e",
        "const fs=require('node:fs'); if(Number(process.versions.node.split('.')[0])!==26 || process.platform!=='linux') throw Error('package_platform_mismatch'); for(const name of ['@earendil-works/pi-coding-agent','@earendil-works/pi-ai']) if(JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version!=='0.87.1') throw Error('PI_SDK_VERSION_MISMATCH');",
      ],
      timeoutMs: 30_000,
    });
    return binary;
  })();
  installs.set(cacheKey, install);
  const cleanup = () => {
    if (installs.get(cacheKey) === install) installs.delete(cacheKey);
  };
  void install.then(cleanup, cleanup);
  return waitForSandboxRuntimeInstall(install, signal);
}

async function reportContextUsage(
  options: RunSandboxAgentTurnOptions,
  usedTokens: number,
  estimated: boolean,
) {
  if (
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0 ||
    !options.onContextUsage
  )
    return;
  await options.onContextUsage({
    usedTokens: Math.round(usedTokens),
    maxTokens: options.contextWindow,
    modelName: options.modelId,
    estimated: estimated || options.contextWindowEstimated === true,
  });
}

async function reportActivities(
  options: RunSandboxAgentTurnOptions,
  activities: readonly SandboxRuntimeActivity[],
  mcpServers: readonly SandboxRuntimeMcpServer[] = [],
) {
  if (!options.onActivity) return;
  for (const activity of activities) {
    const origin =
      activity.type === "tool"
        ? resolveSandboxMcpToolOrigin(activity.toolName, mcpServers)
        : null;
    const enriched = {
      ...activity,
      ...(activity.deploymentId || !origin?.deploymentId
        ? {}
        : { deploymentId: origin.deploymentId }),
      ...(activity.originalToolName || !origin?.originalToolName
        ? {}
        : { originalToolName: origin.originalToolName }),
    };
    await options.onActivity({
      ...enriched,
      ...(enriched.delta
        ? { delta: redact(enriched.delta, [options.runtimeAccessToken]) }
        : {}),
      ...(enriched.toolName
        ? { toolName: redact(enriched.toolName, [options.runtimeAccessToken]) }
        : {}),
      ...(enriched.deploymentId
        ? {
            deploymentId: redact(enriched.deploymentId, [
              options.runtimeAccessToken,
            ]),
          }
        : {}),
      ...(enriched.originalToolName
        ? {
            originalToolName: redact(enriched.originalToolName, [
              options.runtimeAccessToken,
            ]),
          }
        : {}),
      ...(enriched.input === undefined
        ? {}
        : {
            input: redact(displayValue(enriched.input), [
              options.runtimeAccessToken,
            ]),
          }),
      ...(enriched.output === undefined
        ? {}
        : {
            output: redact(displayValue(enriched.output), [
              options.runtimeAccessToken,
            ]),
          }),
    });
  }
}

export function parseClaudeRuntimeMetadata(line: string): {
  commands?: RuntimeCommand[];
  usage?: RuntimeUsage;
} {
  let event: {
    type?: unknown;
    subtype?: unknown;
    slash_commands?: unknown[];
    commands?: { name?: unknown; description?: unknown }[];
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
    total_cost_usd?: unknown;
  } | null;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const subtype = event?.subtype;
  if (
    event?.type === "system" &&
    (event.subtype === "init" || event.subtype === "commands_changed")
  ) {
    const catalog =
      event.subtype === "init" ? event.slash_commands : event.commands;
    const commands = RuntimeCommandsSchema.safeParse(
      Array.isArray(catalog)
        ? catalog.slice(0, 200).map((item) =>
            subtype === "init"
              ? { name: item }
              : {
                  name:
                    typeof item === "object" && item !== null && "name" in item
                      ? item.name
                      : undefined,
                  ...(typeof item === "object" &&
                  item !== null &&
                  "description" in item &&
                  item.description
                    ? { description: item.description }
                    : {}),
                },
          )
        : undefined,
    );
    if (commands.success) return { commands: commands.data };
  }
  if (event?.type === "result" && event.usage) {
    const usage = parseRuntimeUsage({
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
      ...(typeof event.total_cost_usd === "number" &&
      Number.isFinite(event.total_cost_usd) &&
      event.total_cost_usd >= 0
        ? { costUsd: event.total_cost_usd }
        : {}),
    });
    if (usage) return { usage };
  }
  return {};
}

async function runNativeSessionExec(
  options: RunSandboxAgentTurnOptions,
  exec: DockerExecOptions,
  sdk: { configPath: string; packageSetChecksum: string; mcpConfig: unknown },
) {
  if (!options.runtimeSessionId) throw new Error("PI_SDK_SESSION_MISSING");
  const id = randomUUID();
  const driverPath = `${RUNTIME_TEMP_ROOT}/${id}-session.mjs`;
  const inputPath = `${RUNTIME_TEMP_ROOT}/${id}-session.json`;
  try {
    await writeSandboxFile(
      exec.container,
      driverPath,
      await readFile(
        `${process.cwd()}/scripts/native-runtime-session.mjs`,
        "utf8",
      ),
      options.signal,
    );
    await writeSandboxFile(
      exec.container,
      inputPath,
      JSON.stringify({
        kind: "pi-sdk",
        binary: exec.executable,
        args: exec.args,
        statePath: `${sandboxRuntimeStateRoot("pi-sdk", options.agentId)}/sessions/${options.runtimeSessionId}.json`,
        signature: createHash("sha256")
          .update(
            JSON.stringify({
              binary: exec.executable,
              args: exec.args,
              sdkVersion: "0.87.1",
              packageSetChecksum: sdk.packageSetChecksum,
              nativeApproval: Boolean(options.nativeApprovalUrl),
              workdir: exec.workdir,
              model: options.modelId,
              provider: options.provider,
              system: options.systemPrompt,
              skills: options.skills,
              reasoningEffort: options.reasoningEffort,
            }),
          )
          .digest("hex"),
        command: options.command,
        message: buildSandboxTranscript(options.messages.slice(-1)),
        context: {
          runtimeToken: options.runtimeAccessToken,
          approvalUrl: options.nativeApprovalUrl,
          mcpConfig: sdk.mcpConfig,
        },
      }),
      options.signal,
    );
    return await runTrackedDockerExec({
      ...exec,
      executable: "node",
      args: [driverPath, inputPath],
      stdin: undefined,
    });
  } finally {
    await removeSandboxFiles(exec.container, [driverPath, inputPath]);
  }
}

export const piSdkPackageReferencesSchema = z
  .array(
    z
      .object({
        marketInstallId: z.string().min(1),
        releaseId: z.string().min(1),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        mcpBindingsChecksum: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  )
  .max(16);

export function recoverPiSdkPackageReferences(value: unknown) {
  const proof = z
    .object({
      packageSetChecksum: z.string(),
      packages: piSdkPackageReferencesSchema,
    })
    .safeParse(value);
  if (
    !proof.success ||
    new Set(proof.data.packages.map((pkg) => pkg.marketInstallId)).size !==
      proof.data.packages.length
  )
    throw new Error("PI_SDK_LEGACY_RECOVERY_REQUIRED");
  const checksum = createHash("sha256")
    .update(JSON.stringify(proof.data.packages))
    .digest("hex");
  if (checksum !== proof.data.packageSetChecksum)
    throw new Error("PI_SDK_LEGACY_RECOVERY_REQUIRED");
  return proof.data.packages;
}

/** Read before overwriting private config; a checksum alone cannot recover a preimage. */
export async function readLegacyPiSdkPackageReferences(input: {
  sandboxId: string;
  agentId: string;
  runtimeSessionId: string;
}) {
  const root = sandboxRuntimeStateRoot("pi-sdk", input.agentId);
  const output = await runTrackedDockerExec({
    container: sandboxContainerName(input.sandboxId),
    workdir: "/workspace",
    executable: "node",
    args: [
      "-e",
      `
      const fs = require('node:fs');
      const [statePath, configPath] = process.argv.slice(1);
      if (!fs.existsSync(statePath)) {
        throw Error('PI_SDK_LEGACY_RECOVERY_REQUIRED');
      } else {
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (saved.runtimeKind !== 'pi-sdk' || saved.sdkVersion !== '0.87.1') throw Error('PI_SDK_LEGACY_RECOVERY_REQUIRED');
        const config = saved.packageReferences ? null : JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const refs = (saved.packageReferences ?? config.packages).map(({marketInstallId, releaseId, checksum, mcpBindingsChecksum}) => ({marketInstallId, releaseId, checksum, ...(mcpBindingsChecksum ? {mcpBindingsChecksum} : {})}));
        process.stdout.write(JSON.stringify({ packageSetChecksum: saved.packageSetChecksum, packages: refs }));
      }
    `,
      `${root}/sessions/${safeSegment(input.runtimeSessionId, "runtime session")}.json`,
      `${root}/host/${safeSegment(input.runtimeSessionId, "runtime session")}.json`,
    ],
    timeoutMs: 10_000,
    maxStdoutBytes: 32_000,
  }).catch(() => {
    throw new Error("PI_SDK_LEGACY_RECOVERY_REQUIRED");
  });
  const refs: unknown = JSON.parse(output);
  return recoverPiSdkPackageReferences(refs);
}

async function runPiSdk(
  options: RunSandboxAgentTurnOptions,
  container: string,
  workdir: string,
  skillRoot: string,
  mcpServers: readonly SandboxRuntimeMcpServer[],
): Promise<string> {
  const runtimeSessionId = options.runtimeSessionId ?? randomUUID();
  options = { ...options, runtimeSessionId };
  const stateRoot = sandboxRuntimeStateRoot("pi-sdk", options.agentId);
  const privateRoot = `${stateRoot}/host`;
  const hostPath = `${privateRoot}/pi-sdk-session.mjs`;
  const verifierPath = `${privateRoot}/pi-sdk-package-files.mjs`;
  const factoryPath = `${privateRoot}/pi-mcp.mjs`;
  const configPath = `${privateRoot}/${runtimeSessionId}.json`;
  const approvalHelperPath = `${privateRoot}/a2a-native-approval.mjs`;
  const approvalExtensionPath = `${privateRoot}/approval-pi.mjs`;
  const packages = [...(options.piPackages ?? [])]
    .sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId))
    .map((item) => {
      const manifest = parsePiPackageReleaseManifest(
        item.manifest,
        item.checksum,
      );
      return {
        marketInstallId: item.marketInstallId,
        releaseId: item.releaseId,
        checksum: item.checksum,
        manifest,
        ...(item.mcpBindingsChecksum
          ? { mcpBindingsChecksum: item.mcpBindingsChecksum }
          : {}),
        root: `${stateRoot}/packages/${item.checksum}/snapshot`,
        manifestPath: `${stateRoot}/packages/${item.checksum}/manifest.json`,
      };
    });
  if (
    packages.length > 16 ||
    new Set(packages.map((item) => item.marketInstallId)).size !==
      packages.length
  )
    throw new Error("PI_PACKAGE_UNAVAILABLE");
  const packageSetChecksum = createHash("sha256")
    .update(
      JSON.stringify(
        packages.map(
          ({ marketInstallId, releaseId, checksum, mcpBindingsChecksum }) => ({
            marketInstallId,
            releaseId,
            checksum,
            ...(mcpBindingsChecksum ? { mcpBindingsChecksum } : {}),
          }),
        ),
      ),
    )
    .digest("hex");
  for (const [path, source] of [
    [hostPath, "pi-sdk-session.mjs"],
    [verifierPath, "pi-sdk-package-files.mjs"],
    [`${privateRoot}/pi-sdk-capabilities.mjs`, "pi-sdk-capabilities.mjs"],
    [approvalHelperPath, "a2a-native-approval.mjs"],
  ]) {
    await writeSandboxFile(
      container,
      path,
      await readFile(`${process.cwd()}/scripts/${source}`, "utf8"),
      options.signal,
    );
  }
  await writeSandboxFile(
    container,
    factoryPath,
    piMcpExtensionSource({ eventFd: 3 }),
    options.signal,
  );
  if (options.nativeApprovalUrl) {
    httpUrl(options.nativeApprovalUrl, "native approval URL");
    await writeSandboxFile(
      container,
      approvalExtensionPath,
      nativeApprovalAdapter(approvalHelperPath),
      options.signal,
    );
  }
  await runTrackedDockerExec({
    container,
    workdir,
    executable: "node",
    args: [verifierPath, "materialize"],
    stdin: JSON.stringify(packages),
    signal: options.signal,
    timeoutMs: 120_000,
  });
  const resources = {
    extensions: [] as string[],
    skills: [skillRoot],
    prompts: [] as string[],
    themes: [] as string[],
  };
  for (const item of packages)
    for (const kind of ["extensions", "skills", "prompts", "themes"] as const)
      resources[kind].push(
        ...item.manifest.package.resources[kind].map(
          (path) => `${item.root}/${path}`,
        ),
      );
  const models = JSON.parse(buildPiModelsConfig(options)).providers.toolplane;
  const excludeTools = normalizeDisabledBuiltinTools(
    "pi-sdk",
    options.disabledBuiltinTools,
  );
  await writeSandboxFile(
    container,
    configPath,
    JSON.stringify({
      sdkVersion: "0.87.1",
      packageRoot: PI_SDK_RUNTIME.directory,
      cwd: workdir,
      agentDir: stateRoot,
      sessionsDir: `${stateRoot}/sessions/${runtimeSessionId}`,
      statePath: `${stateRoot}/sessions/${runtimeSessionId}.json`,
      packageSetChecksum,
      historyRequired: Boolean(
        options.historyRequired ||
          options.messages.some((message) => message.role === "assistant"),
      ),
      reasoningEffort: options.reasoningEffort,
      model: {
        ...models.models[0],
        ...(options.reasoningEffort && options.reasoningEffort !== "default"
          ? { reasoning: true }
          : {}),
        provider: "toolplane",
        api: models.api,
        baseUrl: models.baseUrl,
        contextWindow: options.contextWindow,
      },
      systemPrompt: options.systemPrompt?.trim() ?? "",
      excludeTools,
      defaultTools: agentRuntimeBuiltinToolGroups("pi-sdk")
        .flatMap((group) => group.tools)
        .filter((name) => !excludeTools.includes(name)),
      resources,
      packages: packages.map(({ manifest: _manifest, ...item }) => item),
      packageVerifierPath: verifierPath,
      mcpFactoryPath: factoryPath,
      ...(options.nativeApprovalUrl
        ? { approvalHelperPath, approvalExtensionPath }
        : {}),
      hostOnlyCommands: HOST_ONLY_COMMAND_NAMES,
    }),
    options.signal,
  );
  let buffer = "",
    text = "",
    streamed = "",
    error = "",
    terminal = false;
  const consume = async (line: string) => {
    const event = JSON.parse(line);
    if (event.type === "prompt_invocation") {
      await options.onPromptInvocation?.(
        event.invocation as AgentPromptInvocation,
      );
      return;
    }
    if (event.type === "toolplane_sdk_response") {
      terminal = true;
      if (!event.success) {
        error = String(event.error?.code ?? "PI_SDK_FAILED");
        return;
      }
      text = redact(String(event.result?.text ?? ""), [
        options.runtimeAccessToken,
      ]);
      const commands = RuntimeCommandsSchema.safeParse(event.result?.commands);
      if (commands.success) await options.onCommands?.(commands.data);
      const usage = parseRuntimeUsage(event.result?.usage);
      if (usage) await options.onUsage?.(usage);
      const result = event.result?.commandResult;
      if (
        result &&
        typeof result.command === "string" &&
        typeof result.text === "string" &&
        (result.status === "completed" || result.status === "failed")
      ) {
        await options.onCommandResult?.({
          command: result.command,
          text: redact(result.text, [options.runtimeAccessToken]),
          status: result.status,
        });
        if (result.status === "failed") error = "PI_SDK_COMMAND_FAILED";
      }
      return;
    }
    const parsed = parsePiStreamLine(line);
    if (parsed?.delta) {
      const delta = redact(parsed.delta, [options.runtimeAccessToken]);
      streamed += delta;
      await options.onTextDelta?.(delta);
    }
    if (parsed?.activities)
      await reportActivities(options, parsed.activities, mcpServers);
    if (parsed?.contextTokens !== undefined)
      await reportContextUsage(options, parsed.contextTokens, false);
    if (parsed?.isError) error = "PI_SDK_FAILED";
  };
  await runNativeSessionExec(
    options,
    {
      container,
      workdir,
      executable: "node",
      args: [hostPath, configPath],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TURN_TIMEOUT_MS,
      secrets: [options.runtimeAccessToken],
      env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" },
      onStdout: async (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) await consume(line);
        }
      },
    },
    {
      configPath,
      packageSetChecksum,
      mcpConfig: JSON.parse(buildPiMcpConfig(mcpServers)),
    },
  );
  if (buffer.trim()) await consume(buffer.trim());
  if (!terminal) throw new Error("PI_SDK_PROTOCOL_ERROR");
  if (error) throw new Error(error);
  if (text.startsWith(streamed) && text.length > streamed.length)
    await options.onTextDelta?.(text.slice(streamed.length));
  return text;
}

export async function runSandboxAgentTurn(
  options: RunSandboxAgentTurnOptions,
): Promise<string> {
  if (options.runtimeKind !== "pi-sdk")
    throw new Error("AGENT_RUNTIME_RETIRED");
  try {
    return await withSandboxExecutionLease(options.sandboxId, () =>
      runExclusiveSandboxAgentTurn(options),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = redact(message, [options.runtimeAccessToken]);
    const stack = error instanceof Error ? error.stack : undefined;
    if (
      safeMessage === message &&
      (!stack || redact(stack, [options.runtimeAccessToken]) === stack)
    )
      throw error;
    // Never retain a raw runtime cause/stack containing execution credentials.
    const safeError =
      error instanceof PiRuntimeInterruptedError
        ? new PiRuntimeInterruptedError(safeMessage)
        : new Error(safeMessage);
    if (error instanceof Error) safeError.name = error.name;
    throw safeError;
  }
}

async function runExclusiveSandboxAgentTurn(
  options: RunSandboxAgentTurnOptions,
): Promise<string> {
  if (
    !options.runtimeAccessToken ||
    options.runtimeAccessToken.length > 8_192 ||
    /[\0\r\n]/.test(options.runtimeAccessToken)
  ) {
    throw new Error("Invalid sandbox runtime access token.");
  }
  if (
    !options.modelId.trim() ||
    options.modelId.length > 500 ||
    options.modelId.includes("\0")
  ) {
    throw new Error("Invalid sandbox runtime model.");
  }
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error("Invalid sandbox runtime context window.");
  }
  if (
    options.runtimeSessionId &&
    !/^[a-zA-Z0-9_-]{1,200}$/.test(options.runtimeSessionId)
  )
    throw new Error("Invalid runtime session.");
  const sandboxDeploymentId = await assertAssignedDockerSandbox(options);
  const container = sandboxContainerName(options.sandboxId);
  const workdir = normalizeSandboxWorkingDirectory(options.workingDirectory);
  const prompt = buildSandboxTranscript(options.messages);
  if (!prompt && !options.command)
    throw new Error("The sandbox runtime turn has no user-visible message.");
  const mcpServers = (options.mcpServers ?? []).filter(
    (server) => server.deploymentId !== sandboxDeploymentId,
  );
  const skillRoot = sandboxRuntimeSkillRoot(
    options.runtimeKind,
    options.agentId,
  );
  if (options.piVersion !== undefined && options.piVersion !== "0.87.1")
    throw new Error("PI_SDK_VERSION_MISMATCH");
  await ensureRuntimeInstalled(container, options.signal);
  await materializeSandboxSkills(
    container,
    skillRoot,
    options.skills ?? [],
    options.signal,
  );
  return runPiSdk(options, container, workdir, skillRoot, mcpServers);
}

export type PiHarnessOperationResult = {
  status: "completed" | "declined" | "aborted" | "failed";
  text: string;
  operationId?: string;
};

type PiHarnessBinding = {
  taskId: string;
  contextId: string;
  operationId: string;
};

export async function cancelPiHarnessOperation(
  options: {
    workspaceId: string;
    agentId: string;
    sandboxId: string;
    a2aContextId: string;
    timeoutMs?: number;
  },
  binding: PiHarnessBinding,
): Promise<PiHarnessOperationResult> {
  // Drain only an already-bound old operation; never prepare a session or install a runtime.
  return withSandboxExecutionLease(options.sandboxId, async () => {
    assertRuntimeOwner();
    const task = await db.a2ATask.findFirst({
      where: {
        id: binding.taskId,
        contextId: binding.contextId,
        nativeOperationId: binding.operationId,
        executionBackend: "pi-harness",
        context: { workspaceId: options.workspaceId },
      },
      select: { context: { select: { agentId: true } } },
    });
    if (
      task?.context.agentId !== options.agentId ||
      options.a2aContextId !== binding.contextId ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(binding.operationId)
    )
      throw new Error("Native cleanup operation binding changed.");
    await assertAssignedDockerSandbox(options, true);
    const container = sandboxContainerName(options.sandboxId);
    const id = randomUUID();
    const inputPath = `${RUNTIME_TEMP_ROOT}/${id}-cancel.json`;
    const hostPath = `${RUNTIME_TEMP_ROOT}/${id}-drain.mjs`;
    await writeSandboxFile(
      container,
      hostPath,
      await readFile(`${process.cwd()}/scripts/pi-harness-drain.mjs`, "utf8"),
    );
    try {
      await writeSandboxFile(
        container,
        inputPath,
        JSON.stringify({ ...binding, agentId: options.agentId }),
      );
      const output = await runTrackedDockerExec({
        container,
        workdir: "/workspace",
        executable: "node",
        args: [hostPath, inputPath],
        timeoutMs: options.timeoutMs ?? 15_000,
        env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" },
      });
      let result: PiHarnessOperationResult | undefined;
      for (const line of output.split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        result = z
          .object({
            status: z.enum(["completed", "declined", "aborted", "failed"]),
            text: z.string(),
            operationId: z.string().optional(),
          })
          .parse(event);
      }
      if (!result)
        throw new Error(
          "PI_PROTOCOL_ERROR: cancellation did not return a terminal result.",
        );
      return result;
    } finally {
      await removeSandboxFiles(container, [inputPath, hostPath]);
    }
  });
}
