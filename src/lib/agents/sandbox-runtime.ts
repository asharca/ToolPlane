import "server-only";
import { attachedFileText } from "@/lib/attachments/attached-file-text";
import type { StreamRule, StreamRuleTrigger } from "./stream-rules";
import { withSandboxSessionLease } from "./sandbox-execution-gate";
import {
  findAgentConversationSandbox,
  type AgentConversationSandbox,
} from "./conversation-sandbox";
import { PiRuntimeInterruptedError } from "./pi-harness";
import type { ContextMaintenance } from "./context-maintenance";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { attachmentHardLimit } from "./attachment-limits";
import { modelReasoningSupported } from "./model";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import { effectiveStatus } from "@/lib/process/supervisor";
import {
  sandboxContainerName,
  syncDockerSandboxEnvironment,
} from "@/lib/sandboxes/runtime";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
import type { SkillBundleFile } from "@/lib/skills/bundle";
import { skillLabel } from "@/lib/workspace/skill-label";
import type { SkillForPrompt } from "./resolve";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "./runtime-commands";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";
import { z } from "zod";
import type { ReasoningEffort } from "./constants";
import {
  agentSessionWorkingDirectory,
  agentSessionWorkspaceRoot,
  type AgentSessionIdentity,
} from "./session-paths";
import type { AgentExecutionStage } from "./execution-stages";
import {
  isSupportedPiVersion,
  PI_SDK_VERSION,
  PI_SDK_VERSIONS,
} from "./pi-version";
import type {
  AgentMessageQueue,
  QueuedAgentMessage,
  QueueControl,
} from "./execution/message-queue";
import type { AdvisorSuggestions } from "./advisor";
import {
  inspectPiSdkCapabilities,
  type PiSdkCapabilityInventory,
  type PiSdkPreflightInput,
} from "./sandbox-runtime/preflight";
import type {
  AgentRuntimeKind,
  ExecutableAgentRuntimeKind,
} from "./runtime-kind";
import { assertAssignedDockerSandbox } from "./sandbox-runtime/materialization";
import {
  runTrackedDockerExec,
  SANDBOX_NODE_FLAG,
  redact,
} from "./sandbox-runtime/docker-exec";
import {
  runRetiredHarnessDrain,
  type PiHarnessBinding,
  type PiHarnessOperationResult,
} from "./sandbox-runtime/retired-harness";
import {
  stopPiSessionInSandbox,
  forkPiSessionInSandbox,
} from "./sandbox-runtime/session-lifecycle";
import { runPiSdk } from "./sandbox-runtime/pi-runner";

export const SANDBOX_TURN_PREPARER = `
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
process.umask(0o077);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function directory(value) {
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(value) !== value) throw Error("SESSION_WORKSPACE_SCOPE");
}
function write(file) {
  directory(path.dirname(file.path));
  const temporary = file.path + ".toolplane-" + randomUUID();
  try {
    fs.writeFileSync(temporary, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file.path);
  } finally { fs.rmSync(temporary, { force: true }); }
}
(async () => {
  for (const value of input.directories ?? []) directory(value);
  for (const file of input.files) write(file);
  if (input.skills) {
    const { root, digest, files } = input.skills;
    let previous;
    try { previous = fs.readFileSync(path.join(root, ".toolplane-skills.sha256"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous !== digest) {
      fs.rmSync(root, { recursive: true, force: true });
      directory(root);
      for (const file of files) write(file);
      write({ path: path.join(root, ".toolplane-skills.sha256"), content: digest });
    }
  }
  if (input.packages?.length) {
    // These absolute paths select restored adapters inside this session's sandbox, not server modules.
    const verifier = await import(pathToFileURL(input.verifierPath).href);
    verifier.materializePiPackageSnapshots(input.packages);
  }
  let runtimeReady = true;
  if (input.runtime?.kind === "pi-sdk") {
    // The installer lives at a runtime-selected conversation workspace path.
    const installer = await import(pathToFileURL(input.runtime.installerPath).href);
    runtimeReady = await installer.verifyPiSdkRuntime(input.runtime.directory);
  }
  process.stdout.write(JSON.stringify({ runtimeReady }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export const PI_SDK_RUNTIME = {
  specs: [
    `@earendil-works/pi-coding-agent@${PI_SDK_VERSION}`,
    `@earendil-works/pi-ai@${PI_SDK_VERSION}`,
  ],
  directory: `/workspace/.toolplane/runtime-packages/pi-sdk-${PI_SDK_VERSION}`,
  binary: "pi",
  ignoreScripts: true,
  allowBuilds: [],
} as const;

export const TURN_TIMEOUT_MS = 30 * 60_000;
/** Never below the default and never before the task deadline, which stays the effective limit. */
export function sandboxTurnTimeoutMs(deadlineAt: Date) {
  return Math.max(TURN_TIMEOUT_MS, deadlineAt.getTime() - Date.now() + 60_000);
}

export type SandboxRuntimeProvider = {
  id: string;
  name: string;
  format: string;
};

export type SandboxRuntimeMcpServer = {
  deploymentId: string;
  url: string;
  /** Display name shown to the model; defaults to the generated alias. */
  label?: string;
  /** Per-request budget; sandbox commands need longer than ordinary MCP calls. */
  timeoutMs?: number;
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

export type PiSessionEntries = {
  userEntryId: string;
  userParentEntryId: string | null;
  leafEntryId: string;
};

export type RunSandboxAgentTurnOptions = {
  runtimeKind: ExecutableAgentRuntimeKind;
  workspaceId: string;
  agentId: string;
  agentRevisionId?: string;
  sandboxId: string;
  conversationId?: string;
  a2aContextId?: string;
  provider: SandboxRuntimeProvider;
  modelId: string;
  maxSteps?: number;
  contextWindow: number;
  contextWindowEstimated?: boolean;
  modelInput?: readonly ("text" | "image")[];
  maxOutputTokens?: number;
  modelProxyBase: string;
  runtimeAccessToken: string;
  nativeUiUrl?: string;
  systemPrompt?: string | null;
  contextFiles?: boolean;
  piVersion?: string;
  disabledBuiltinTools?: readonly string[];
  optionalBuiltinTools?: readonly string[];
  nativeSubagentPolicy?: { maxConcurrency: number; maxDepth: number };
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
  navigateBeforeEntryId?: string;
  onSessionEntries?: (entries: PiSessionEntries) => void | Promise<void>;
  reasoningEffort?: ReasoningEffort;
  streamRules?: readonly StreamRule[];
  onStreamRule?: (trigger: StreamRuleTrigger) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTextDelta?: (text: string) => void | Promise<void>;
  onActivity?: (activity: SandboxRuntimeActivity) => void | Promise<void>;
  onExecutionStage?: (stage: AgentExecutionStage) => void | Promise<void>;
  /** The model now answering after a fallback switch. */
  onModelSelected?: (model: {
    providerId: string;
    model: string;
  }) => void | Promise<void>;
  onContextUsage?: (usage: ContextUsageSnapshot) => void | Promise<void>;
  onCommands?: (commands: RuntimeCommand[]) => void | Promise<void>;
  onUsage?: (usage: RuntimeUsage) => void | Promise<void>;
  onAdvisorSuggestions?: (advisory: AdvisorSuggestions) => void | Promise<void>;
  onPromptInvocation?: (
    invocation: AgentPromptInvocation,
  ) => void | Promise<void>;
  onCommandResult?: (result: RuntimeCommandResult) => void | Promise<void>;
  messageQueue?: Omit<QueueControl, "send">;
  onMessageQueue?: (queue: AgentMessageQueue) => void | Promise<void>;
  onQueuedMessage?: (
    message: QueuedAgentMessage,
    assistantText: string,
  ) => void | Promise<void>;
  onContextMaintenance?: (marker: ContextMaintenance) => void | Promise<void>;
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
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  isError?: boolean;
  source?: {
    subagentId: string;
    subagentVersionId?: string;
    subagentName?: string;
    parentToolCallId?: string;
    depth?: number;
  };
};

export function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return segment && segment !== "." && segment !== ".." ? segment : fallback;
}

function runtimeFilePath(
  part: SandboxRuntimeMessage["parts"][number],
  identity?: AgentSessionIdentity,
): string | null {
  if (!part.providerMetadata || typeof part.providerMetadata !== "object")
    return null;
  const metadata = part.providerMetadata as Record<string, unknown>;
  const toolplane = metadata.toolplane;
  if (!toolplane || typeof toolplane !== "object") return null;
  const value = (toolplane as Record<string, unknown>).runtimePath;
  if (typeof value !== "string") return null;
  try {
    return identity
      ? agentSessionWorkingDirectory(identity, value)
      : normalizeSandboxWorkingDirectory(value);
  } catch {
    return null;
  }
}

function messagePartText(
  part: SandboxRuntimeMessage["parts"][number],
  identity?: AgentSessionIdentity,
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
  const path = runtimeFilePath(part, identity);
  if (path) return attachedFileText(filename, path);
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
  identity?: AgentSessionIdentity,
): string {
  return messages
    .flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = message.parts
        .flatMap((part) => {
          const value = messagePartText(part, identity);
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

export function httpUrl(value: string, label: string): string {
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

/** Agent-wide CLI state (logins, user installs) shared by every conversation. */
export const SANDBOX_AGENT_HOME = "/workspace/.toolplane/agent-home";

export function sandboxAgentHomeEnvironment(): Record<string, string> {
  return {
    HOME: SANDBOX_AGENT_HOME,
    XDG_CONFIG_HOME: `${SANDBOX_AGENT_HOME}/.config`,
    XDG_DATA_HOME: `${SANDBOX_AGENT_HOME}/.local/share`,
    XDG_CACHE_HOME: `${SANDBOX_AGENT_HOME}/.cache`,
    XDG_STATE_HOME: `${SANDBOX_AGENT_HOME}/.local/state`,
  };
}

export function sandboxRuntimeStateRoot(
  runtimeKind: AgentRuntimeKind,
  agentId: string,
  workspaceRoot = "/workspace",
): string {
  return `${workspaceRoot}/.toolplane/runtimes/${runtimeKind}/agents/${safeSegment(agentId, "agent")}`;
}

export function sandboxRuntimeSkillRoot(
  runtimeKind: AgentRuntimeKind,
  agentId: string,
  workspaceRoot = "/workspace",
  revisionId?: string,
): string {
  const root = sandboxRuntimeStateRoot(runtimeKind, agentId, workspaceRoot);
  return revisionId
    ? `${root}/revisions/${safeSegment(revisionId, "revision")}/skills`
    : `${root}/skills`;
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
      ...(server.label ? { label: server.label.slice(0, 80) } : {}),
      ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
    })),
    resultFileBytes: attachmentHardLimit(),
  });
}

/** Executes native factories only inside the credential-free, offline capture image. */
export async function preflightPiSdkCapabilities(
  input: PiSdkPreflightInput,
): Promise<PiSdkCapabilityInventory> {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    const ownerSignal = runtimeAbortSignal();
    const signal = ownerSignal
      ? input.signal
        ? AbortSignal.any([ownerSignal, input.signal])
        : ownerSignal
      : input.signal;
    return inspectPiSdkCapabilities(input, signal);
  });
}

/** Source and target have already been authorized and provisioned by the Work service. */
export async function forkWorkPiSession(input: {
  workspaceId: string;
  agentId: string;
  source: AgentConversationSandbox;
  target: AgentConversationSandbox;
  sourceConversationId: string;
  targetConversationId: string;
  entryId: string;
  workingDirectory?: string;
  signal?: AbortSignal;
}) {
  assertRuntimeOwner();
  const source = await findAgentConversationSandbox({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.sourceConversationId,
  });
  const target = await findAgentConversationSandbox({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.targetConversationId,
  });
  if (
    !source ||
    !target ||
    source.sandboxId !== target.sandboxId ||
    source.workspaceRoot !== input.source.workspaceRoot ||
    target.workspaceRoot !== input.target.workspaceRoot
  )
    throw new Error("PI_SDK_SESSION_SCOPE");
  return withSandboxSessionLease(
    source.sandboxId,
    input.sourceConversationId,
    () => forkPiSessionInSandbox(input, source, target),
  );
}

/** Caller holds the sandbox execution lease; no other conversation/container is stopped. */
export async function stopAgentSessionRuntime(input: {
  workspaceId: string;
  agentId: string;
  sandboxId: string;
  conversationId?: string;
  a2aContextId?: string;
}): Promise<void> {
  assertRuntimeOwner();
  const mapped = await findAgentConversationSandbox({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    contextId: input.a2aContextId,
    cleanup: true,
  });
  if (!mapped || mapped.sandboxId !== input.sandboxId)
    throw new Error("The sandbox does not match this conversation/context.");
  const sandbox = await db.sandbox.findFirst({
    where: {
      id: mapped.sandboxId,
      workspaceId: input.workspaceId,
      kind: "docker",
    },
    select: { deploymentId: true, deployment: { select: { status: true } } },
  });
  if (!sandbox) throw new Error("Conversation sandbox binding is invalid.");
  if (
    effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !==
    "running"
  )
    return;
  const workspaceRoot = mapped.workspaceRoot;
  const stateRoot = sandboxRuntimeStateRoot(
    "pi-sdk",
    input.agentId,
    workspaceRoot,
  );
  const container = sandboxContainerName(input.sandboxId);
  await stopPiSessionInSandbox(container, workspaceRoot, stateRoot);
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
  conversationId?: string;
  a2aContextId?: string;
}) {
  const workspaceRoot =
    input.conversationId || input.a2aContextId
      ? agentSessionWorkspaceRoot(input)
      : "/workspace";
  const root = sandboxRuntimeStateRoot("pi-sdk", input.agentId, workspaceRoot);
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
        if (saved.runtimeKind !== 'pi-sdk' || !${JSON.stringify(PI_SDK_VERSIONS)}.includes(saved.sdkVersion)) throw Error('PI_SDK_LEGACY_RECOVERY_REQUIRED');
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
/** Read-only export runs beside an active turn, never through the model/broker queue. */
export async function runSandboxSessionExport(input: {
  sandboxId: string;
  stateRoot: string;
  runtimeSessionId: string;
  jsonl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  assertRuntimeOwner();
  const source = await readFile(
    posix.join(process.cwd(), "scripts/pi-sdk-session-export.mjs"),
    "utf8",
  );
  return runTrackedDockerExec({
    container: sandboxContainerName(input.sandboxId),
    workdir: "/tmp",
    executable: "node",
    args: [SANDBOX_NODE_FLAG, "--input-type=module", "-"],
    stdin: `${source}\nawait exportSession(${JSON.stringify({
      stateRoot: input.stateRoot,
      runtimeSessionId: safeSegment(input.runtimeSessionId, "runtime session"),
      packageRoot: PI_SDK_RUNTIME.directory,
      ...(input.jsonl === undefined ? {} : { jsonl: input.jsonl }),
    })});\n`,
    signal: input.signal,
    timeoutMs: 30_000,
    maxStdoutBytes: 12 * 1024 * 1024,
  });
}

export async function runSandboxAgentTurn(
  options: RunSandboxAgentTurnOptions,
): Promise<string> {
  if (options.runtimeKind !== "pi-sdk")
    throw new Error("AGENT_RUNTIME_RETIRED");
  if (options.reasoningEffort && options.reasoningEffort !== "default") {
    const provider = await db.modelProvider.findFirst({
      where: { id: options.provider.id, workspaceId: options.workspaceId },
      include: {
        modelRecords: { where: { modelId: options.modelId } },
      },
    });
    if (
      !provider ||
      !modelReasoningSupported(
        provider,
        options.modelId,
        provider.modelRecords[0],
      )
    )
      options = { ...options, reasoningEffort: undefined };
  }
  // A turn without a durable session still gets a private one-shot session.
  const session =
    options.runtimeSessionId ??
    options.a2aContextId ??
    options.conversationId ??
    randomUUID();
  try {
    return await withSandboxSessionLease(
      options.sandboxId,
      session,
      async () => {
        await options.onExecutionStage?.("preparing");
        return runSessionSandboxAgentTurn(options);
      },
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

async function runSessionSandboxAgentTurn(
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
  const assigned = await assertAssignedDockerSandbox(options);
  if (assigned.identity) options = { ...options, ...assigned.identity };
  const sandboxDeploymentId = assigned.deploymentId;
  const container = sandboxContainerName(options.sandboxId);
  const workspaceRoot = assigned.workspaceRoot ?? "/workspace";
  const workdir =
    assigned.identity && workspaceRoot !== "/workspace"
      ? agentSessionWorkingDirectory(
          assigned.identity,
          options.workingDirectory,
        )
      : normalizeSandboxWorkingDirectory(options.workingDirectory);
  const prompt = buildSandboxTranscript(options.messages);
  if (!prompt && !options.command)
    throw new Error("The sandbox runtime turn has no user-visible message.");
  const mcpServers = (options.mcpServers ?? []).filter(
    (server) => server.deploymentId !== sandboxDeploymentId,
  );
  const skillRoot = sandboxRuntimeSkillRoot(
    options.runtimeKind,
    options.agentId,
    workspaceRoot,
    options.agentRevisionId,
  );
  if (
    options.piVersion !== undefined &&
    !isSupportedPiVersion(options.piVersion)
  )
    throw new Error("PI_SDK_VERSION_MISMATCH");
  try {
    return await runPiSdk(
      options,
      container,
      workdir,
      skillRoot,
      workspaceRoot,
      mcpServers,
    );
  } finally {
    // Commands of this turn may have installed packages into the shared rootfs.
    void syncDockerSandboxEnvironment(options.sandboxId, {
      replay: true,
    }).catch(() => undefined);
  }
}

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
  return withSandboxSessionLease(
    options.sandboxId,
    options.a2aContextId,
    async () => {
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
      return runRetiredHarnessDrain(container, options, binding);
    },
  );
}
