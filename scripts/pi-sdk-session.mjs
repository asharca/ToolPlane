#!/usr/bin/env node
// Trusted headless SDK host. Extension stdout is deliberately not a protocol channel.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { enforceNativeNamespaces } from "./pi-sdk-capabilities.mjs";
import { createNativeUi } from "./pi-sdk-ui.mjs";
import { createAdvisor } from "./pi-sdk-advisor.mjs";
import {
  configureNativeTodo,
  officialTodoPath,
} from "./pi-sdk-native-resources.mjs";
import { createContextMaintenance } from "./pi-sdk-context.mjs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
// Native tools inherit this: importing a skill must not add files to its pinned snapshot.
process.env.PYTHONDONTWRITEBYTECODE = "1";
// Pi state belongs to this conversation; HOME/XDG (CLI logins, user installs)
// are the Agent-wide directories passed by the runtime, never /root.
mkdirSync(config.agentDir, { recursive: true, mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = config.agentDir;
for (const name of [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
  mkdirSync(process.env[name], { recursive: true, mode: 0o700 });
}
const userBin = join(process.env.HOME, ".local/bin");
if (!(process.env.PATH ?? "").split(":").includes(userBin))
  process.env.PATH = `${userBin}:${process.env.PATH ?? ""}`;
// The trusted runtime supplies Agent-wide files linked into each conversation workspace.
mkdirSync(config.sharedDir, { recursive: true });
try {
  lstatSync(join(config.workspaceRoot, "shared"));
} catch {
  symlinkSync(config.sharedDir, join(config.workspaceRoot, "shared"));
}
const sdkEntry = realpathSync(
  join(
    config.packageRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  ),
);
const sdk = await import(pathToFileURL(sdkEntry).href);
const { InMemoryCredentialStore } = await import(
  pathToFileURL(
    join(
      dirname(
        findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdkEntry)),
      ),
      "dist/index.js",
    ),
  ).href
);
const { verifyPiPackageSnapshots, canonicalJson } = await import(
  pathToFileURL(config.packageVerifierPath).href
);
const { createPiMcpTools } = await import(
  pathToFileURL(config.mcpFactoryPath).href
);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(sdkEntry), "..", "package.json"), "utf8"),
).version;
const { parseCommandArgs } = await import(
  pathToFileURL(join(dirname(sdkEntry), "core/prompt-templates.js")).href
);
const { theme } = await import(
  pathToFileURL(join(dirname(sdkEntry), "modes/interactive/theme/theme.js"))
    .href
);
const todoPath = officialTodoPath(sdkEntry);
let promptInvocation;
function sessionEntries() {
  if (!runtime || !turnExistingEntries) return undefined;
  const manager = runtime.session.sessionManager;
  const entry = manager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        !turnExistingEntries.has(entry.id),
    );
  if (!entry) return undefined;
  return {
    userEntryId: entry.id,
    userParentEntryId: entry.parentId,
    leafEntryId: manager.getLeafId(),
  };
}
let turnExistingEntries;
const fail = (code, reason) => {
  throw Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });
};
// Pi rejects manual compaction of a short or freshly compacted session before
// any model call; the session is unchanged, so report its notice as the result.
const COMPACTION_NOOPS = new Set([
  "Nothing to compact (session too small)",
  "Already compacted",
]);
const compact = (session, instructions) =>
  session.compact(instructions).catch((error) => {
    if (COMPACTION_NOOPS.has(error?.message)) return { summary: error.message };
    throw error;
  });
// Provider text may echo credentials or prompts; only a fixed reason leaves the host.
// The model base URL is always ToolPlane's proxy, so a connection failure means the
// sandbox cannot reach ToolPlane; upstream outages arrive as proxied HTTP statuses.
function modelFailureReason(errorMessage) {
  const message = String(errorMessage ?? "");
  if (/\bTOOLPLANE_MODEL_GATEWAY_FAILED\b/.test(message))
    return "GATEWAY_ERROR";
  const status =
    /^([1-5]\d\d)\b/.exec(message)?.[1] ??
    /\(([1-5]\d\d)\):/.exec(message)?.[1];
  if (status) return `HTTP_${status}`;
  if (/timed? ?out|ETIMEDOUT/i.test(message)) return "TIMEOUT";
  if (
    /connection error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(
      message,
    )
  )
    return "UNREACHABLE";
  if (EMPTY_STREAM.test(message)) return "EMPTY_STREAM";
  if (
    /stream ended|without finish_reason|finish_reason: network_error|terminated/i.test(
      message,
    )
  )
    return "STREAM_INCOMPLETE";
  if (/content_filter/i.test(message)) return "CONTENT_FILTER";
  return "PROVIDER_ERROR";
}
// Gateways that already sent HTTP 200 report an upstream that produced nothing,
// or a stream cut before finish_reason, as an in-stream error. Pi 1.5.2 does
// not classify either as transient.
const EMPTY_STREAM = /empty_stream|empty .{0,40}stream/i;
const TRANSIENT_STREAM =
  /empty_stream|empty .{0,40}stream|without finish_reason/i;
const MAX_MODEL_RETRIES = 10;
const toolSources = new AsyncLocalStorage();
const emit = (event) => writeFileSync(3, `${JSON.stringify(event)}\n`);
const within = (root, path) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
};
// Generated MCP adapters reuse platform customTools here; external Pi connects through its own installation.
globalThis[Symbol.for("toolplane.pi.host-context.v1")] = {
  kind: "toolplane-sdk",
  platformMcp: true,
  runTasks,
  getEventSource: () => toolSources.getStore(),
};
mkdirSync(config.cwd, { recursive: true });
mkdirSync(config.sessionsDir, { recursive: true });
const cwd = realpathSync(config.cwd),
  sessionsDir = realpathSync(config.sessionsDir);
// Pi's default discovery walks to filesystem root before applying overrides.
// Discover only approved directories so even reading cannot cross a session boundary.
function projectContextFiles() {
  if (config.contextFiles !== true) return { agentsFiles: [] };
  const workspaceRoot = realpathSync(config.workspaceRoot);
  if (!within(workspaceRoot, cwd)) fail("PI_SDK_SESSION_SCOPE");
  const directories = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    directories.unshift(dir);
    if (dir === workspaceRoot) break;
  }
  directories.unshift(realpathSync(config.agentDir));
  const allowedDirectories = new Set(directories);
  const seen = new Set();
  const agentsFiles = [];
  for (const dir of allowedDirectories) {
    for (const name of [
      "AGENTS.override.md",
      "AGENTS.md",
      "AGENTS.MD",
      "CLAUDE.md",
      "CLAUDE.MD",
    ]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const actual = realpathSync(path);
      if (!allowedDirectories.has(dirname(actual))) continue;
      if (!lstatSync(actual).isFile()) continue;
      if (!seen.has(actual)) {
        agentsFiles.push({
          path,
          content: readFileSync(actual, "utf8").replace(/^\uFEFF/, ""),
        });
        seen.add(actual);
      }
      break;
    }
  }
  return { agentsFiles };
}
const packageRoots = (config.packages ?? []).map((p) => resolve(p.root));
function allowedResource(path, base = cwd) {
  if (typeof path !== "string" || /^(npm:|git:|https?:)/.test(path))
    fail("PI_EXTENSION_RESOURCE_DENIED");
  let actual;
  try {
    actual = realpathSync(resolve(base, path));
  } catch {
    fail("PI_EXTENSION_RESOURCE_DENIED");
  }
  if (packageRoots.some((root) => within(root, actual))) return actual;
  if (
    !within(cwd, actual) ||
    within(realpathSync(config.agentDir), actual) ||
    within(join(cwd, ".pi"), actual) ||
    within(join(cwd, ".toolplane"), actual)
  )
    fail("PI_EXTENSION_RESOURCE_DENIED");
  return actual;
}
function sessionPath(path) {
  if (typeof path !== "string" || !existsSync(path))
    fail("PI_SDK_SESSION_MISSING");
  const actual = realpathSync(path);
  if (!within(sessionsDir, actual)) fail("PI_SDK_SESSION_SCOPE");
  const fd = openSync(actual, "r"),
    buffer = Buffer.alloc(64 * 1024);
  let header;
  try {
    const bytes = readSync(fd, buffer, 0, buffer.length, 0),
      end = buffer.subarray(0, bytes).indexOf(10);
    if (end < 0) fail("PI_SDK_SESSION_MISSING");
    header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
  } finally {
    closeSync(fd);
  }
  if (header.type !== "session" || resolve(header.cwd) !== cwd)
    fail("PI_SDK_SESSION_SCOPE");
  return actual;
}
let runtime,
  unsubscribe,
  active,
  context,
  initialError,
  toolSignature,
  toolMap = new Map(),
  customTools = [];
const childRuns = new Set();
const childSlots = new Set();
async function acquireChildSlot(signal) {
  const limit = Math.max(
    1,
    Math.min(8, config.nativeSubagentPolicy?.maxConcurrency ?? 1),
  );
  while (childSlots.size >= limit) {
    if (signal.aborted) return;
    await Promise.race(childSlots);
  }
  if (signal.aborted) return;
  let release;
  const slot = new Promise((done) => {
    release = () => {
      childSlots.delete(slot);
      done();
    };
  });
  childSlots.add(slot);
  return release;
}
let turnController;
const CHILD_TIMEOUT_MS = 300_000;
const CHILD_OUTPUT_CHARS = 20_000;
async function cancelChildren() {
  turnController?.abort();
  await Promise.all([...childRuns]);
}
async function runTasks(parentToolCallId, args, signal) {
  const invalid =
    !args ||
    !Array.isArray(args.tasks) ||
    args.tasks.length < 1 ||
    args.tasks.length > 8 ||
    (args.context !== undefined &&
      (typeof args.context !== "string" || args.context.length > 100000)) ||
    Object.keys(args).some((key) => !["tasks", "context"].includes(key)) ||
    args.tasks.some(
      (task) =>
        !task ||
        typeof task !== "object" ||
        Object.keys(task).some(
          (key) => !["id", "description", "prompt"].includes(key),
        ) ||
        typeof task.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(task.id) ||
        typeof task.description !== "string" ||
        !task.description.trim() ||
        task.description.length > 240 ||
        typeof task.prompt !== "string" ||
        !task.prompt.trim() ||
        task.prompt.length > 100000,
    ) ||
    new Set(args.tasks.map((task) => task.id.toLowerCase())).size !==
      args.tasks.length;
  if (invalid || !active || !runtime || !turnController)
    return {
      content: [
        {
          type: "text",
          text: "TASK_INPUT_INVALID: Supply 1–8 uniquely named, non-empty tasks.",
        },
      ],
      isError: true,
      details: { reason: "TASK_INPUT_INVALID", results: [] },
    };
  const maxConcurrency = Math.max(
    1,
    Math.min(8, config.nativeSubagentPolicy?.maxConcurrency ?? 1),
  );
  const maxDepth = config.nativeSubagentPolicy?.maxDepth ?? 1;
  if (maxDepth < 1)
    return {
      content: [
        {
          type: "text",
          text: "TASK_DEPTH_EXCEEDED: Subagents cannot spawn further children.",
        },
      ],
      isError: true,
      details: { reason: "TASK_DEPTH_EXCEEDED", results: [] },
    };
  const batchSignal = AbortSignal.any([
    turnController.signal,
    ...(signal ? [signal] : []),
  ]);
  const tools = runtime.session
    .getActiveToolNames()
    .filter((name) => name !== "task");
  const results = new Array(args.tasks.length);
  let next = 0;
  const batch = Promise.all(
    Array.from(
      { length: Math.min(maxConcurrency, args.tasks.length) },
      async () => {
        while (next < args.tasks.length) {
          const index = next++;
          results[index] = await runChild(
            args.tasks[index],
            args.context,
            parentToolCallId,
            tools,
            batchSignal,
          );
        }
      },
    ),
  );
  childRuns.add(batch);
  try {
    await batch;
  } finally {
    childRuns.delete(batch);
  }
  const isError = results.some((result) => result.status !== "completed");
  const details = {
    status: isError ? "partial_failure" : "completed",
    results,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError,
  };
}
async function runChild(
  task,
  sharedContext,
  parentToolCallId,
  tools,
  parentSignal,
) {
  const source = {
    subagentId: `${task.id}-${randomUUID()}`,
    subagentName: task.description,
    parentToolCallId: parentToolCallId.slice(0, 240),
    depth: 1,
  };
  const started = Date.now();
  const release = await acquireChildSlot(parentSignal);
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let timedOut = false,
    session,
    childUi,
    unsubscribeChild,
    lastMessage,
    uiFailed = false;
  let stop = Promise.resolve();
  const cancel = () => {
    childUi?.cancel();
    stop = session?.abort().catch(() => {}) ?? Promise.resolve();
  };
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHILD_TIMEOUT_MS);
  const lifecycle = (status, output) =>
    emit({
      type:
        status === "running" ? "tool_execution_start" : "tool_execution_end",
      source,
      toolCallId: source.subagentId,
      toolName: "task",
      ...(status === "running"
        ? { args: { id: task.id, description: task.description } }
        : { isError: status !== "completed", result: { status, ...output } }),
    });
  lifecycle("running");
  let result;
  try {
    if (signal.aborted) throw new Error("cancelled");
    const root = join(cwd, ".toolplane-subagents");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink() || !within(cwd, realpathSync(root)))
      throw new Error("scope");
    const directory = join(root, source.subagentId);
    mkdirSync(directory, { mode: 0o700 });
    childUi = createNativeUi({
      getContext: () => context,
      theme,
      source,
      onError: () => {
        uiFailed = true;
      },
    });
    const manager = sdk.SessionManager.create(cwd, directory);
    const child = await factory(
      { cwd, sessionManager: manager },
      { tools, ui: childUi, source },
    );
    session = child.session;
    unsubscribeChild = session.subscribe((entry) => {
      event(entry, source, session.model);
      if (entry.type === "message_end" && entry.message.role === "assistant")
        lastMessage = entry.message;
      if (
        entry.type === "message_end" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo"
      )
        void childUi.projectTodos(manager).catch(() => {
          uiFailed = true;
        });
    });
    allowTransientStreamRetry(session);
    await session.bindExtensions({
      mode: context?.uiUrl ? "rpc" : "json",
      uiContext: context?.uiUrl ? childUi.uiContext : undefined,
      onError: () => {
        uiFailed = true;
      },
    });
    applyConfiguredThinkingLevel(session);
    if (signal.aborted) {
      cancel();
      throw new Error("cancelled");
    }
    await session.prompt(
      [
        sharedContext ? `Shared background:\n${sharedContext}` : "",
        `Assignment (${task.id}): ${task.description}\n${task.prompt}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    await session.waitForIdle();
    await childUi.drain();
    if (
      signal.aborted ||
      uiFailed ||
      !lastMessage ||
      ["error", "aborted"].includes(lastMessage.stopReason)
    )
      throw new Error("failed");
    const text = contentText(lastMessage.content);
    result = {
      id: task.id,
      status: "completed",
      text: text.slice(0, CHILD_OUTPUT_CHARS),
      truncated: text.length > CHILD_OUTPUT_CHARS,
    };
  } catch {
    const status = timedOut
      ? "timed_out"
      : signal.aborted
        ? "cancelled"
        : "failed";
    result = {
      id: task.id,
      status,
      text: "",
      truncated: false,
      reason: {
        timed_out: "TASK_TIMEOUT",
        cancelled: "TASK_CANCELLED",
        failed: "TASK_EXECUTION_FAILED",
      }[status],
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    childUi?.cancel();
    await stop;
    await session?.abort().catch(() => {});
    await childUi?.drain().catch(() => {});
    unsubscribeChild?.();
    session?.dispose();
    release?.();
  }
  result.durationMs = Date.now() - started;
  lifecycle(result.status, result);
  return result;
}
const contextMaintenance = createContextMaintenance({
  sdk,
  getSession: () => runtime.session,
  emit,
  onUsage: (value) => {
    usage ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    usage.inputTokens += value.input ?? 0;
    usage.outputTokens += value.output ?? 0;
    usage.cacheReadTokens += value.cacheRead ?? 0;
    usage.cacheWriteTokens += value.cacheWrite ?? 0;
    usage.costUsd += value.cost?.total ?? 0;
  },
});
globalThis[Symbol.for("toolplane.pi.host-context.v1")].contextMaintenance =
  contextMaintenance.bridge;
let texts = [],
  usage,
  turnError,
  modelFailed = false,
  modelReason,
  modelRetried = 0,
  aborted = false;
const streamRules = (config.streamRules ?? []).map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern),
}));
let ruleText = "",
  ruleTriggers = [],
  remindedRules = new Set(),
  ruleDeliveries = [];
function triggerRule(rule, toolCall) {
  const trigger = {
    id: randomUUID(),
    ruleId: rule.id,
    name: rule.name,
    target: rule.target,
    action: rule.action,
    message: rule.message,
    ...(toolCall
      ? { toolName: toolCall.toolName, toolCallId: toolCall.toolCallId }
      : {}),
    timestamp: Date.now(),
  };
  ruleTriggers.push(trigger);
  runtime.session.sessionManager.appendCustomEntry(
    "toolplane.stream-rule",
    trigger,
  );
  emit({ type: "stream_rule_triggered", trigger });
  if (rule.action === "remind") {
    remindedRules.add(rule.id);
    // The envelope keeps a reminder beginning with '/' from becoming a command.
    const delivery = runtime.session
      .steer(`<system-reminder>\n${rule.message}\n</system-reminder>`)
      .catch(() => {
        turnError = "PI_STREAM_RULE_DELIVERY_FAILED";
      });
    ruleDeliveries.push(delivery);
    return delivery;
  }
}
let toolStarted = false,
  fallbackIndex = 0,
  actualModel;
const modelIdentity = (model) =>
  model?.toolplaneProviderId
    ? { providerId: model.toolplaneProviderId, model: model.id }
    : undefined;
function recordUsage(value, model, response = false) {
  const identity = modelIdentity(model);
  if (response && identity) actualModel = identity;
  usage ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  if (actualModel) usage.actualModel = actualModel;
  const delta = {
    inputTokens: value?.input ?? 0,
    outputTokens: value?.output ?? 0,
    cacheReadTokens: value?.cacheRead ?? 0,
    cacheWriteTokens: value?.cacheWrite ?? 0,
    costUsd: value?.cost?.total ?? 0,
  };
  for (const key of Object.keys(delta)) usage[key] += delta[key];
  if (identity) {
    usage.modelUsage ??= [];
    let entry = usage.modelUsage.find(
      (entry) =>
        entry.providerId === identity.providerId &&
        entry.model === identity.model,
    );
    if (!entry) {
      entry = {
        ...identity,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      usage.modelUsage.push(entry);
    }
    for (const key of Object.keys(delta)) entry[key] += delta[key];
  }
}
const transientModelFailure = (message) =>
  message?.stopReason === "error" &&
  (/^(HTTP_(429|5\d\d)|TIMEOUT|EMPTY_STREAM|STREAM_INCOMPLETE)$/.test(
    modelFailureReason(message.errorMessage),
  ) ||
    /rate.?limit|too many requests|overload|service unavailable/i.test(
      String(message.errorMessage ?? ""),
    ));
let runtimeProviders = new Set(["toolplane"]);
let lastState;
let queuedInputs = [];
let queueRequest;
let queueOperation = Promise.resolve();
let acceptingQueue = false;
let queueContinuation = Promise.resolve();
const queueReceipts = new Map();
const queueState = () => ({
  messages: ["steer", "follow_up"].flatMap((mode) =>
    queuedInputs
      .filter((item) => item.mode === mode)
      .map(({ id, mode, text }) => ({ id, mode, text })),
  ),
  pendingMessageCount: queuedInputs.length,
});
const emitQueue = () => emit({ type: "message_queue", queue: queueState() });
const nativeUi = createNativeUi({
  getContext: () => context,
  theme,
  onError: () => {
    turnError = "PI_SDK_UI_FAILED";
  },
});
const settingsManager = sdk.SettingsManager.inMemory({
  defaultTools: config.defaultTools,
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  retry: { enabled: false },
});
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(config.agentDir, "model-cache.json"),
  refreshOnCreate: false,
});
modelRuntime.registerProvider("toolplane", {
  baseUrl: config.model.baseUrl,
  api: config.model.api,
  apiKey: "$TOOLPLANE_RUNTIME_TOKEN",
  authHeader: true,
  models: [config.model],
});
const advisor = createAdvisor({
  modelRuntime,
  emit,
  onUsage: (value) => recordUsage(value, context.advisor?.model),
  getFailureReason: modelFailureReason,
  getSession: () => runtime.session,
  isAborted: () => aborted,
});
const packageReferences = config.packages.map(
  ({ marketInstallId, releaseId, checksum, mcpBindingsChecksum }) => ({
    marketInstallId,
    releaseId,
    checksum,
    ...(mcpBindingsChecksum ? { mcpBindingsChecksum } : {}),
  }),
);
let saved;
try {
  if (config.workspaceRoot) {
    const { migrateNativeSessionPaths } = await import(
      "./native-session-paths.mjs"
    );
    await migrateNativeSessionPaths(config);
  }
  if (sdkVersion !== config.sdkVersion) fail("PI_SDK_VERSION_MISMATCH");
  if (!existsSync(config.statePath) && config.historyRequired)
    fail("PI_SDK_SESSION_MISSING");
  if (existsSync(config.statePath)) {
    saved = JSON.parse(readFileSync(config.statePath, "utf8"));
    if (
      saved.runtimeKind !== "pi-sdk" ||
      !config.compatibleSdkVersions.includes(saved.sdkVersion)
    )
      fail("PI_SDK_SESSION_MISSING");
    // Only an explicitly changed, server-authorized revision can change packages.
    // SessionManager.open below keeps the same persisted transcript and files.
    const revisionChanged =
      typeof config.agentRevisionId === "string" &&
      saved.agentRevisionId !== config.agentRevisionId;
    if (
      !revisionChanged &&
      saved.packageSetChecksum !== config.packageSetChecksum
    )
      fail("PI_SDK_PACKAGE_SET_CHANGED");
    if (
      !revisionChanged &&
      saved.packageReferences &&
      canonicalJson(saved.packageReferences) !==
        canonicalJson(packageReferences)
    )
      fail("PI_SDK_PACKAGE_SET_CHANGED");
    if (!saved.sessionPersisted) fail("PI_SDK_SESSION_MISSING");
    sessionPath(saved.sessionFile);
  }
} catch (error) {
  initialError = error.code ?? "PI_SDK_SESSION_MISSING";
}
function state() {
  const session = runtime?.session;
  if (!session)
    return {
      sessionId: saved?.sessionId ?? null,
      sessionFile: saved?.sessionFile ?? null,
      sessionPersisted: saved?.sessionPersisted ?? false,
    };
  const sessionFile = session.sessionFile ?? null;
  if (sessionFile && !within(sessionsDir, resolve(sessionFile)))
    fail("PI_SDK_SESSION_SCOPE");
  return {
    sessionId: session.sessionManager.getSessionId(),
    sessionFile,
    sessionPersisted: Boolean(sessionFile && existsSync(sessionFile)),
  };
}
function persist() {
  const value = {
    runtimeKind: "pi-sdk",
    sdkVersion: config.sdkVersion,
    ...state(),
    packageSetChecksum: config.packageSetChecksum,
    packageReferences,
    agentRevisionId: config.agentRevisionId,
  };
  const temporary = `${config.statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, config.statePath);
  lastState = value;
}
// Fork through Pi's canonical tree, without changing the source session or copying files.
function forkSession(request) {
  const target = request.target;
  const sourceState = lastState ?? saved;
  if (!sourceState?.sessionPersisted) fail("PI_SDK_SESSION_MISSING");
  if (
    !target ||
    typeof request.entryId !== "string" ||
    typeof target.workspaceRoot !== "string" ||
    typeof target.cwd !== "string" ||
    typeof target.sessionsDir !== "string" ||
    typeof target.statePath !== "string" ||
    resolve(target.workspaceRoot) === resolve(config.workspaceRoot) ||
    dirname(resolve(target.workspaceRoot)) !==
      dirname(resolve(config.workspaceRoot)) ||
    !within(resolve(target.workspaceRoot), resolve(target.cwd)) ||
    !within(resolve(target.workspaceRoot), resolve(target.sessionsDir)) ||
    !within(resolve(target.workspaceRoot), resolve(target.statePath))
  )
    fail("PI_SDK_SESSION_SCOPE");
  mkdirSync(target.cwd, { recursive: true, mode: 0o700 });
  mkdirSync(target.sessionsDir, { recursive: true, mode: 0o700 });
  if (existsSync(target.statePath)) fail("PI_SDK_SESSION_EXISTS");
  const manager = sdk.SessionManager.open(
    sessionPath(sourceState.sessionFile),
    target.sessionsDir,
    target.cwd,
  );
  if (!manager.getEntry(request.entryId)) fail("PI_SDK_ENTRY_NOT_FOUND");
  const file = manager.createBranchedSession(request.entryId);
  if (!file || !existsSync(file)) fail("PI_SDK_SESSION_MISSING");
  const value = {
    ...sourceState,
    sessionId: manager.getSessionId(),
    sessionFile: file,
    sessionPersisted: true,
  };
  const temporary = `${target.statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, target.statePath);
  return {
    forked: true,
    entryId: request.entryId,
    contextOnly: true,
    filesRewound: false,
    externalEffectsRewound: false,
  };
}
// Category split of the current request context. Pi only reports a total, so the
// provider-anchored total stays authoritative and categories use Pi's chars/4 estimate;
// messages absorb the remainder, as in omp's /context.
const SYSTEM_PROMPT_SECTIONS = new Set(["preamble", "addendum"]);
const textTokens = (text) => Math.ceil(text.length / 4);
function contextBreakdown(session) {
  const sections = new Map();
  let content = "",
    messageTokens = 0,
    anchored = false;
  for (const message of session.messages) {
    if (message.role !== "system") {
      messageTokens += sdk.estimateTokens(message);
      // Same anchor rule as Pi: aborted/failed replies carry no trustworthy usage.
      if (
        message.role === "assistant" &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "error" &&
        message.usage &&
        sdk.calculateContextTokens(message.usage) > 0
      )
        anchored = true;
      continue;
    }
    content +=
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    for (const [name, value] of Object.entries(message.sections ?? {}))
      if (value === null) sections.delete(name);
      else sections.set(name, value);
  }
  const categories = {
    systemPrompt: 0,
    systemTools: textTokens(
      JSON.stringify(
        session.agent.state.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ),
    ),
    systemContext: textTokens(content),
    instructionFiles: 0,
    skills: 0,
    messages: 0,
  };
  if (!sections.size && !content)
    categories.systemPrompt = textTokens(session.systemPrompt);
  for (const [name, text] of sections) {
    const tokens = textTokens(text);
    if (SYSTEM_PROMPT_SECTIONS.has(name)) categories.systemPrompt += tokens;
    else if (name === "project_context") categories.instructionFiles += tokens;
    else if (name === "skills") categories.skills += tokens;
    else categories.systemContext += tokens;
  }
  const nonMessageTokens =
    categories.systemPrompt +
    categories.systemTools +
    categories.systemContext +
    categories.instructionFiles +
    categories.skills;
  // Pi returns null after compaction until a newer reply reports usage.
  const reported = anchored ? session.getContextUsage()?.tokens : undefined;
  const estimated = typeof reported !== "number" || reported <= 0;
  const usedTokens = estimated ? nonMessageTokens + messageTokens : reported;
  categories.messages = Math.max(0, usedTokens - nonMessageTokens);
  return { usedTokens, estimated, categories };
}
// Display-only: a malformed transcript must not fail an otherwise completed turn.
function contextBreakdownResult(session) {
  try {
    return { contextBreakdown: contextBreakdown(session) };
  } catch {
    return {};
  }
}
function diagnostics(services) {
  const loader = services.resourceLoader;
  if (
    services.diagnostics.some((d) => d.type === "error") ||
    loader.getExtensions().errors.length ||
    [loader.getSkills(), loader.getPrompts(), loader.getThemes()].some((r) =>
      r.diagnostics.some((d) => d.type === "error" || d.type === "collision"),
    )
  )
    fail("PI_EXTENSION_LOAD_FAILED");
  enforceNativeNamespaces({
    extensions: loader.getExtensions().extensions,
    skills: loader.getSkills().skills,
    prompts: loader.getPrompts().prompts,
    toolNames: customTools.map((t) => t.name),
    hostCommands: config.hostOnlyCommands ?? [],
  });
}
function commands() {
  if (!runtime) return [];
  return [
    ...runtime.session.extensionRunner
      .getRegisteredCommands()
      .map((c) => ({ name: c.invocationName, description: c.description })),
    ...runtime.session.promptTemplates.map((c) => ({
      name: c.name,
      description: c.description,
    })),
    ...runtime.services.resourceLoader.getSkills().skills.map((s) => ({
      name: `skill:${s.name}`,
      description: s.description,
    })),
    { name: "compact", description: "Compact session" },
  ].filter((c) => !(config.hostOnlyCommands ?? []).includes(c.name));
}
const contentText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
// Tool input/output for the transcript and the workspace Agent tool log; bounded so one large
// result (for example `cat` of a big file) cannot bloat the event stream.
const TOOL_PAYLOAD_CHARS = 20_000;
function toolPayload(value) {
  if (value === undefined) return undefined;
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > TOOL_PAYLOAD_CHARS
    ? `${text.slice(0, TOOL_PAYLOAD_CHARS)}…[truncated]`
    : value;
}
function toolPatch(event) {
  const details = event.result?.details;
  if (
    !["edit", "write"].includes(event.toolName) ||
    typeof details?.patch !== "string"
  )
    return {};
  const patch = context?.runtimeToken
    ? details.patch.split(context.runtimeToken).join("[REDACTED]")
    : details.patch;
  const bytes = Buffer.from(patch);
  const truncated = bytes.length > 65_536;
  return {
    patch: truncated
      ? new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(0, 65_536),
          { stream: true },
        )
      : patch,
    truncated,
    ...(Number.isInteger(details.firstChangedLine) &&
    details.firstChangedLine > 0
      ? { firstChangedLine: details.firstChangedLine }
      : {}),
  };
}
function event(event, source, sourceModel) {
  if (!active) return;
  if (!source && event.type === "queue_update" && queueRequest) {
    const mode = queueRequest.type;
    const native = mode === "steer" ? event.steering : event.followUp;
    const known = queuedInputs.filter((item) => item.mode === mode).length;
    if (native.length > known) {
      queuedInputs.push({
        id: queueRequest.messageId ?? queueRequest.id,
        mode,
        text: queueRequest.message,
        injectedText: native.at(-1),
      });
    }
  }
  if (
    !source &&
    event.type === "message_start" &&
    event.message.role === "user"
  ) {
    const text = contentText(event.message.content);
    let index = queuedInputs.findIndex(
      (item) => item.mode === "steer" && item.injectedText === text,
    );
    if (index < 0)
      index = queuedInputs.findIndex((item) => item.injectedText === text);
    if (index >= 0) {
      const [message] = queuedInputs.splice(index, 1);
      emit({
        type: "queued_message_consumed",
        message: { id: message.id, mode: message.mode, text },
        assistantText: texts.join("\n\n"),
      });
      texts = [];
      emitQueue();
    }
  }
  if (!source && event.type === "auto_retry_start")
    modelRetried = event.attempt;
  if (
    !source &&
    event.type === "message_start" &&
    event.message?.role === "assistant"
  )
    ruleText = "";
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (
      update?.type === "text_delta" &&
      typeof update.delta === "string" &&
      streamRules.some(
        (rule) =>
          rule.target === "assistant_text" && !remindedRules.has(rule.id),
      )
    ) {
      ruleText += update.delta;
      for (const rule of streamRules)
        if (
          rule.target === "assistant_text" &&
          !remindedRules.has(rule.id) &&
          rule.regex.test(ruleText)
        )
          triggerRule(rule);
    }
    if (
      [
        "text_start",
        "text_delta",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
      ].includes(update?.type)
    )
      emit({
        type: "message_update",
        ...(source ? { source } : {}),
        assistantMessageEvent: { type: update.type, delta: update.delta },
      });
  }
  if (event.type === "tool_execution_start") {
    // Even a failed/unknown tool may already have changed external state.
    toolStarted = true;
    emit({
      type: event.type,
      ...(source ? { source } : {}),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: toolPayload(event.args),
    });
  }
  // A failed tool call (for example a shell command exiting non-zero) is an
  // ordinary result the model reads and reacts to; it does not fail the turn.
  if (event.type === "tool_execution_end")
    emit({
      type: event.type,
      ...(source ? { source } : {}),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      result: toolPayload(event.result),
      ...toolPatch(event),
    });
  if (event.type === "message_end") {
    if (source) {
      if (event.message.role === "assistant")
        recordUsage(event.message.usage, sourceModel);
      return;
    }
    if (
      event.message.role === "toolResult" &&
      event.message.toolName === "todo"
    )
      queueMicrotask(() => {
        void nativeUi.projectTodos(runtime.session.sessionManager).catch(() => {
          turnError = "PI_SDK_UI_FAILED";
        });
      });
    const message = event.message;
    if (message.role === "user" && promptInvocation) {
      const invocation = {
        ...promptInvocation,
        finalInput: contentText(message.content),
      };
      runtime.session.sessionManager.appendCustomEntry(
        "toolplane.prompt-invocation",
        invocation,
      );
      emit({ type: "prompt_invocation", invocation });
      promptInvocation = undefined;
    }
    if (message.role === "custom" && message.display !== false)
      texts.push(
        `Pi 扩展 · ${message.customType}\n${contentText(message.content)}`,
      );
    if (message.role === "assistant") {
      modelFailed =
        message.stopReason === "error" || message.stopReason === "aborted";
      modelReason =
        message.stopReason === "error"
          ? modelFailureReason(message.errorMessage)
          : undefined;
      const text = contentText(message.content);
      if (text) texts.push(text);
      recordUsage(message.usage, runtime.session.model, true);
    }
  }
}

// Session setup and reload recompute settings from storage, so apply after them.
function applyRetryBudget() {
  const retries = config.modelRetries ?? 0;
  settingsManager.applyOverrides({
    retry: { enabled: retries > 0, maxRetries: retries },
  });
}
function applyConfiguredThinkingLevel(session) {
  const level = config.reasoningEffort;
  if (level === undefined || level === "default") return;
  if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
    fail("PI_SDK_REASONING_INVALID");
  // Pi 1.5.2 clamps to the current model and persists the change in this session only.
  session.setThinkingLevel(level, { persist: false });
}
// Pinned 1.5.2 exposes no retry matcher setting; extend its instance check so
// empty/incomplete gateway streams retry under the same budget and backoff.
function allowTransientStreamRetry(session) {
  const piRetryable = session._isRetryableError;
  if (typeof piRetryable !== "function") fail("PI_SDK_VERSION_MISMATCH");
  if (piRetryable.toolplane) return;
  const retryable = (message) =>
    piRetryable.call(session, message) ||
    transientModelFailure(message) ||
    (message?.stopReason === "error" &&
      TRANSIENT_STREAM.test(String(message.errorMessage ?? "")));
  retryable.toolplane = true;
  session._isRetryableError = retryable;
  const prepareRetry = session._prepareRetry;
  const summarize = session._runDefaultCompaction;
  if (
    typeof prepareRetry !== "function" ||
    typeof summarize !== "function" ||
    typeof session._omitRecoveryAttempt !== "function"
  )
    fail("PI_SDK_VERSION_MISMATCH");
  session._prepareRetry = async (message) => {
    if (await prepareRetry.call(session, message)) return true;
    // Stay inside Pi's continuation loop: do not replay the prompt or extensions.
    if (!active || aborted || toolStarted || !transientModelFailure(message))
      return false;
    const next = config.fallbackModels?.[fallbackIndex++];
    if (!next) return false;
    await session.setModel(next, { persist: false });
    session._retryAttempt = 0;
    modelRetried = 0;
    texts = [];
    session._omitRecoveryAttempt(message);
    return true;
  };
  // Pi 1.5.2 has no independent compaction-model setting. Both manual and
  // automatic compaction share this model-parameterized summarization boundary;
  // replacing its argument avoids mutating the in-flight conversational model.
  session._runDefaultCompaction = async (preparation, model, ...args) => {
    const selected = config.roleModels?.compaction ?? model;
    const result = await summarize.call(
      session,
      preparation,
      selected,
      ...args,
    );
    if (result?.usage) recordUsage(result.usage, selected, !actualModel);
    return result;
  };
}
const approvedToolArguments = new WeakMap();
const approvalDenied = () => ({
  block: true,
  reason: "TOOL_APPROVAL_DENIED: Tool execution was not approved.",
});
async function approveToolCall(event) {
  if (!context?.toolApprovalBridge) return;
  const admitted = context;
  try {
    const url = new URL(admitted.uiUrl);
    if (
      !/^\/api\/v1\/agent-runtime\/tasks\/[^/]+\/ui$/.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      return approvalDenied();
    url.pathname = url.pathname.replace(/\/ui$/, "/tool-approvals");
    // Capture once; any later extension mutation is rejected by the final native hook.
    const argumentsJson = canonicalJson(event.input);
    const args = JSON.parse(argumentsJson);
    const toolName = event.toolName,
      toolCallId = event.toolCallId;
    const post = async (action) => {
      if (aborted || admitted !== context)
        throw new Error("TOOL_APPROVAL_DENIED");
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${admitted.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, toolCallId, toolName, arguments: args }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("TOOL_APPROVAL_DENIED");
      return response.json();
    };
    let result = await post("request");
    const deadline = Math.min(
      Date.now() + 120_000,
      Date.parse(result.expiresAt) || Date.now() + 120_000,
    );
    while (result.status === "pending" && Date.now() < deadline && !aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await post("poll");
    }
    if (!["approved", "allowed"].includes(result.status) || aborted) {
      await post("consume").catch(() => {});
      return approvalDenied();
    }
    result = await post("consume");
    if (result.allowed !== true || admitted !== context || aborted)
      return approvalDenied();
    approvedToolArguments.set(event.input, {
      argumentsJson,
      toolName,
      toolCallId,
    });
    return;
  } catch {
    // Native Pi turns a blocked call into an isError tool result, never a turn error.
    return approvalDenied();
  }
}
async function bindSession(session) {
  unsubscribe?.();
  unsubscribe = session.subscribe(event);
  allowTransientStreamRetry(session);
  const beforeToolCall = session.agent.beforeToolCall;
  if (!beforeToolCall?.toolplaneApproval) {
    const checked = async (call) => {
      const result = await beforeToolCall?.(call);
      if (result?.block || !context?.toolApprovalBridge) return result;
      const approved = approvedToolArguments.get(call.args);
      approvedToolArguments.delete(call.args);
      return approved?.argumentsJson === canonicalJson(call.args) &&
        approved.toolName === call.toolCall.name &&
        approved.toolCallId === call.toolCall.id
        ? result
        : approvalDenied();
    };
    checked.toolplaneApproval = true;
    session.agent.beforeToolCall = checked;
  }
  await session.bindExtensions({
    mode: context?.uiUrl ? "rpc" : "json",
    uiContext: context?.uiUrl ? nativeUi.uiContext : undefined,
    onError: () => {
      turnError = "PI_EXTENSION_LOAD_FAILED";
    },
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: async (options) => {
        if (options?.parentSession) sessionPath(options.parentSession);
        return runtime.newSession(options);
      },
      fork: (id, options) => runtime.fork(id, options),
      switchSession: (path, options) =>
        runtime.switchSession(sessionPath(path), options),
      navigateTree: (id, options) => runtime.session.navigateTree(id, options),
      reload: async () => {
        await verifyPiPackageSnapshots(config.packages);
        await runtime.session.reload();
        applyRetryBudget();
        diagnostics(runtime.services);
        persist();
      },
    },
  });
  diagnostics(runtime.services);
  if (turnError) fail(turnError);
  applyConfiguredThinkingLevel(session);
  persist();
}
async function factory(
  { cwd: nextCwd, sessionManager, sessionStartEvent },
  child,
) {
  if (
    realpathSync(nextCwd) !== cwd ||
    !within(
      child ? join(cwd, ".toolplane-subagents") : sessionsDir,
      resolve(sessionManager.getSessionDir()),
    )
  )
    fail("PI_SDK_SESSION_SCOPE");
  await verifyPiPackageSnapshots(config.packages);
  const ui = child?.ui ?? nativeUi;
  const sessionSettings = child
    ? sdk.SettingsManager.inMemory({
        defaultTools: child.tools,
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        retry: {
          enabled: (config.modelRetries ?? 0) > 0,
          maxRetries: config.modelRetries ?? 0,
        },
      })
    : settingsManager;
  const extensions = [
    ...config.resources.extensions,
    ...(config.optionalBuiltinExtensions ?? []),
    todoPath,
  ];
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir: config.agentDir,
    modelRuntime,
    settingsManager: sessionSettings,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: projectContextFiles,
      additionalExtensionPaths: extensions,
      extensionFactories: [
        {
          name: "toolplane-stream-rules",
          hidden: true,
          factory: (pi) => {
            pi.on("tool_call", async (call) => {
              if (!active) return;
              const input = JSON.stringify(call.input);
              const blocked = [];
              for (const rule of streamRules) {
                if (
                  rule.target !== "tool_call" ||
                  (rule.toolName && rule.toolName !== call.toolName) ||
                  (rule.action === "remind" && remindedRules.has(rule.id)) ||
                  !rule.regex.test(input)
                )
                  continue;
                await triggerRule(rule, call);
                if (rule.action === "block") blocked.push(rule.message);
              }
              // Pi turns a blocked call into an isError tool result and continues.
              // Never use terminate: a rejected tool is not a failed Agent turn.
              if (blocked.length)
                return { block: true, reason: blocked.join("\n\n") };
            });
          },
        },
        {
          name: "toolplane-web-projection",
          hidden: true,
          factory: (pi) => {
            contextMaintenance.extension(pi);
            const project = (_event, ctx) =>
              ui.projectTodos(ctx.sessionManager);
            pi.on("session_start", project);
            pi.on("session_tree", project);
            pi.on("before_provider_request", () => {
              if (active)
                emit({
                  type: "model_request",
                  ...(child ? { source: child.source } : {}),
                });
            });
            pi.on("tool_call", approveToolCall);
            pi.on("turn_end", (boundary) => advisor.review(boundary));
          },
        },
      ],
      additionalSkillPaths: config.resources.skills,
      additionalPromptTemplatePaths: config.resources.prompts,
      additionalThemePaths: config.resources.themes,
      systemPrompt: config.systemPrompt,
      extensionsOverride: (base) => configureNativeTodo(base, todoPath),
    },
  });
  diagnostics(services);
  const loader = services.resourceLoader,
    extend = loader.extendResources.bind(loader),
    reload = loader.reload.bind(loader);
  loader.extendResources = (paths) => {
    verifyPiPackageSnapshots(config.packages);
    const validated = {};
    for (const key of ["skillPaths", "promptPaths", "themePaths"])
      validated[key] = (paths[key] ?? []).map((entry) => ({
        ...entry,
        path: allowedResource(entry.path, entry.metadata?.baseDir ?? cwd),
      }));
    extend(validated);
    diagnostics(services);
  };
  loader.reload = async (...args) => {
    await verifyPiPackageSnapshots(config.packages);
    await reload(...args);
    diagnostics(services);
  };
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    model: config.model,
    ...(child ? { tools: child.tools } : {}),
    excludeTools: [...(config.excludeTools ?? []), ...(child ? ["task"] : [])],
    customTools: child
      ? customTools.map((tool) => ({
          ...tool,
          execute: (...args) =>
            toolSources.run(child.source, () => tool.execute(...args)),
        }))
      : customTools,
  });
  return { ...result, services, diagnostics: services.diagnostics };
}
async function refreshContext(next) {
  if (
    !next ||
    typeof next.runtimeToken !== "string" ||
    !next.runtimeToken ||
    !next.mcpConfig ||
    !Array.isArray(next.mcpConfig.servers)
  )
    fail("PI_SDK_CONTEXT_REQUIRED");
  if (
    next.model?.provider !== "toolplane" ||
    typeof next.model.id !== "string" ||
    typeof next.model.baseUrl !== "string"
  )
    fail("PI_SDK_MODEL_REQUIRED");
  // Turn-scoped model/auth; neither the immutable revision nor packages change.
  config.model = next.model;
  config.reasoningEffort = next.reasoningEffort;
  config.fallbackModels = next.fallbackModels ?? [];
  config.roleModels = next.roleModels;
  // Workspace setting, live per turn: retries one failed model request in place.
  config.modelRetries =
    Number.isInteger(next.modelRetries) &&
    next.modelRetries >= 0 &&
    next.modelRetries <= MAX_MODEL_RETRIES
      ? next.modelRetries
      : 0;
  const models = [
    config.model,
    ...config.fallbackModels,
    ...Object.values(config.roleModels ?? {}),
  ];
  for (const model of models) {
    if (
      !model ||
      (model.provider !== "toolplane" &&
        !/^toolplane-[A-Za-z0-9_-]+$/.test(model.provider))
    )
      fail("PI_SDK_MODEL_REQUIRED");
    if (models.find((entry) => entry.provider === model.provider) !== model)
      continue;
    modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: "$TOOLPLANE_RUNTIME_TOKEN",
      authHeader: true,
      models: [
        ...new Map(
          models
            .filter((entry) => entry.provider === model.provider)
            .map((entry) => [entry.id, entry]),
        ).values(),
      ],
    });
    runtimeProviders.add(model.provider);
    await modelRuntime.setRuntimeApiKey(model.provider, next.runtimeToken);
  }
  context = next;
  process.env.TOOLPLANE_RUNTIME_TOKEN = next.runtimeToken;
  const definitions = await createPiMcpTools(next.mcpConfig);
  const signature = canonicalJson(
    definitions
      .map((t) => ({ name: t.name, parameters: t.parameters }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  if (toolSignature !== undefined && signature !== toolSignature)
    fail("PI_SDK_TOOLSET_CHANGED");
  toolMap = new Map(definitions.map((t) => [t.name, t]));
  if (toolSignature === undefined)
    customTools = definitions.map((tool) => {
      const name = tool.name;
      return {
        ...tool,
        execute: (...args) => {
          if (!context || !active) fail("PI_SDK_CONTEXT_REQUIRED");
          return toolMap.get(name).execute(...args);
        },
      };
    });
  toolSignature = signature;
}
async function handle(request) {
  const respond = (success, result, code, reason) =>
    emit({
      type: "toolplane_sdk_response",
      id: request.id,
      success,
      ...(success
        ? { result }
        : {
            error: { code, message: code, ...(reason ? { reason } : {}) },
            ...(result ? { result } : {}),
          }),
    });
  if (!request || typeof request.id !== "string") return;
  if (request.type === "abort") {
    try {
      aborted = true;
      advisor.cancel();
      await cancelChildren();
      nativeUi.cancel();
      await runtime?.session.abort();
      respond(true, {
        text: "Request aborted",
        commands: commands(),
        state: state(),
      });
    } catch {
      respond(false, undefined, "PI_SDK_ABORT_FAILED");
    }
    return;
  }
  if (["steer", "follow_up", "clear_queue"].includes(request.type)) {
    queueOperation = queueOperation
      .catch(() => {})
      .then(async () => {
        if (
          !active ||
          !acceptingQueue ||
          !runtime ||
          (request.type !== "clear_queue" && !runtime.session.isStreaming)
        ) {
          respond(false, undefined, "PI_SDK_QUEUE_NOT_RUNNING");
          return;
        }
        if (
          request.type !== "clear_queue" &&
          (typeof request.message !== "string" ||
            !request.message.trim() ||
            request.message.length > 100_000)
        ) {
          respond(false, undefined, "PI_SDK_QUEUE_INVALID");
          return;
        }
        if (request.deduplicate && queueReceipts.has(request.messageId)) {
          respond(true, {
            disposition: queueReceipts.get(request.messageId),
            queue: queueState(),
          });
          return;
        }
        if (
          request.type !== "clear_queue" &&
          (queuedInputs.length >= 32 ||
            Buffer.byteLength(JSON.stringify(queueState())) +
              Buffer.byteLength(JSON.stringify(request.message)) >
              1024 * 1024)
        ) {
          respond(false, undefined, "PI_SDK_QUEUE_FULL");
          return;
        }
        try {
          let disposition;
          if (request.type === "clear_queue") {
            runtime.session.clearQueue();
            queuedInputs = [];
            disposition = "cleared";
          } else {
            queueRequest = request;
            disposition = await runtime.session[
              request.type === "steer" ? "steer" : "followUp"
            ](request.message);
            if (disposition === "queued" && !runtime.session.isStreaming) {
              const pending = runtime.session.clearQueue();
              queueContinuation = (async () => {
                for (const text of [...pending.steering, ...pending.followUp]) {
                  if (aborted) break;
                  await runtime.session.sendUserMessage(text);
                }
              })();
            }
          }
          if (request.deduplicate && typeof request.messageId === "string")
            queueReceipts.set(request.messageId, disposition);
          emitQueue();
          respond(true, { disposition, queue: queueState() });
        } catch {
          respond(false, undefined, "PI_SDK_QUEUE_INVALID");
        } finally {
          queueRequest = undefined;
        }
      });
    return;
  }
  if (active) {
    respond(false, undefined, "PI_SDK_BUSY");
    return;
  }
  if (request.type === "fork") {
    try {
      if (initialError) fail(initialError);
      respond(true, { text: "", fork: forkSession(request) });
    } catch (error) {
      respond(
        false,
        undefined,
        /^PI_[A-Z_]+$/.test(error.code ?? "")
          ? error.code
          : "PI_SDK_FORK_FAILED",
      );
    }
    return;
  }
  if (request.type === "get_state" || request.type === "get_commands") {
    if (initialError) respond(false, undefined, initialError);
    else if (request.type === "get_commands" && !runtime)
      respond(false, undefined, "PI_SDK_CONTEXT_REQUIRED");
    else respond(true, { text: "", commands: commands(), state: state() });
    return;
  }
  if (!["prompt", "compact"].includes(request.type)) {
    respond(false, undefined, "PI_SDK_REQUEST_INVALID");
    return;
  }
  active = request.id;
  turnController = new AbortController();
  nativeUi.start();
  texts = [];
  usage = undefined;
  turnError = undefined;
  aborted = false;
  modelFailed = false;
  modelReason = undefined;
  modelRetried = 0;
  ruleText = "";
  ruleTriggers = [];
  remindedRules = new Set();
  ruleDeliveries = [];
  turnExistingEntries = undefined;
  acceptingQueue = true;
  queueReceipts.clear();
  toolStarted = false;
  fallbackIndex = 0;
  actualModel = undefined;
  let terminal;
  try {
    if (initialError) fail(initialError);
    await verifyPiPackageSnapshots(config.packages);
    if (runtime && lastState?.sessionPersisted)
      sessionPath(lastState.sessionFile);
    await refreshContext(request.context);
    if (aborted) fail("PI_SDK_ABORTED");
    if (!runtime) {
      const manager = saved
        ? sdk.SessionManager.open(sessionPath(saved.sessionFile), sessionsDir)
        : sdk.SessionManager.create(cwd, sessionsDir);
      if (saved && manager.getSessionId() !== saved.sessionId)
        fail("PI_SDK_SESSION_MISSING");
      runtime = await sdk.createAgentSessionRuntime(factory, {
        cwd,
        agentDir: config.agentDir,
        sessionManager: manager,
      });
      runtime.setRebindSession(bindSession);
      await bindSession(runtime.session);
    }
    // Always select the admitted model, including the pinned default on a turn
    // without an override. Session history survives and global defaults do not change.
    await runtime.session.setModel(config.model, { persist: false });
    applyConfiguredThinkingLevel(runtime.session);
    applyRetryBudget();
    await nativeUi.projectTodos(runtime.session.sessionManager);
    await advisor.start(context.advisor, context.runtimeToken, request.id);
    let command;
    let compaction;
    if (request.navigateBeforeEntryId !== undefined) {
      const entry = runtime.session.sessionManager.getEntry(
        request.navigateBeforeEntryId,
      );
      if (entry?.type !== "message" || entry.message.role !== "user")
        fail("PI_SDK_ENTRY_NOT_FOUND");
      // Pi treats a user target as its parent, including null/root. Never summarize.
      const navigation = await runtime.session.navigateTree(entry.id, {
        summarize: false,
      });
      if (navigation.cancelled || navigation.aborted)
        fail("PI_SDK_NAVIGATION_CANCELLED");
    }
    turnExistingEntries = new Set(
      runtime.session.sessionManager.getEntries().map((entry) => entry.id),
    );
    if (request.type === "compact") {
      command = "compact";
      compaction = await compact(runtime.session, request.customInstructions);
    } else {
      if (typeof request.message !== "string") fail("PI_SDK_REQUEST_INVALID");
      command = /^\/([^\s]+)(?:\s|$)/.exec(request.message)?.[1];
      const template = runtime.session.promptTemplates.find(
        (p) => p.name === command,
      );
      if (template) {
        const source = config.packages.find((p) =>
          within(p.root, template.filePath),
        );
        if (!source) fail("PI_PROMPT_SOURCE_REQUIRED");
        const rawArguments = request.message.slice(command.length + 1).trim();
        promptInvocation = {
          name: template.name,
          source: {
            marketInstallId: source.marketInstallId,
            releaseId: source.releaseId,
            checksum: source.checksum,
            path: relative(source.root, template.filePath),
          },
          version: source.releaseId,
          rawArguments,
          arguments: parseCommandArgs(rawArguments),
        };
      }
      if (command && !commands().some((c) => c.name === command))
        fail("PI_SDK_COMMAND_UNKNOWN");
      if (command === "compact")
        compaction = await compact(
          runtime.session,
          request.message.slice("/compact".length).trim() || undefined,
        );
      else await runtime.session.prompt(request.message);
    }
    if (compaction) texts.push(compaction.summary);
    let current;
    do {
      current = runtime.session;
      await current.waitForIdle();
      await queueOperation;
      await queueContinuation;
    } while (current !== runtime.session);
    await Promise.all(ruleDeliveries);
    if (aborted) fail("PI_SDK_ABORTED");
    const handoffSummary = await contextMaintenance.settle();
    if (handoffSummary) texts.push(handoffSummary);
    if (turnError) fail(turnError);
    if (modelFailed)
      fail(
        "PI_SDK_MODEL_FAILED",
        modelReason && modelRetried > 0
          ? `${modelReason} RETRIED_${modelRetried}`
          : modelReason,
      );
    diagnostics(runtime.services);
    await nativeUi.projectTodos(runtime.session.sessionManager);
    await nativeUi.drain();
    if (turnError) fail(turnError);
    persist();
    const text =
      texts.join("\n\n") ||
      (command ? `Pi command /${command} completed.` : "");
    if (usage) emit({ type: "usage", ...usage });
    terminal = {
      success: true,
      result: {
        text,
        commands: commands(),
        queue: queueState(),
        ...advisor.result,
        ...(usage ? { usage } : {}),
        ...(sessionEntries() ? { sessionEntries: sessionEntries() } : {}),
        ...(actualModel ? { actualModel } : {}),
        ...contextBreakdownResult(runtime.session),
        streamRuleTriggers: ruleTriggers,
        ...(command
          ? { commandResult: { command, text, status: "completed" } }
          : {}),
        state: state(),
      },
    };
  } catch (error) {
    try {
      await cancelChildren();
      nativeUi.cancel();
      if (runtime) await runtime.session.abort();
    } catch {
      /* preserve original failure */
    }
    const code = /^PI_[A-Z_]+$/.test(error.code ?? "")
      ? error.code
      : "PI_SDK_REQUEST_FAILED";
    // Model/UI delivery failure or stop ends this turn only. Keep the history Pi
    // already wrote so the next message continues; nothing is replayed.
    if (
      runtime &&
      (code === "PI_SDK_MODEL_FAILED" ||
        code === "PI_SDK_ABORTED" ||
        code === "PI_SDK_UI_FAILED" ||
        code === "PI_STREAM_RULE_DELIVERY_FAILED")
    )
      try {
        persist();
      } catch {
        /* the original failure stays authoritative */
      }
    terminal = {
      success: false,
      code,
      reason: code === "PI_SDK_MODEL_FAILED" ? error.reason : undefined,
      // Tokens already spent on a failed turn still count toward the budget.
      result:
        usage || ruleTriggers.length || sessionEntries()
          ? {
              ...(usage ? { usage } : {}),
              ...advisor.result,
              ...(actualModel ? { actualModel } : {}),
              ...(ruleTriggers.length
                ? { streamRuleTriggers: ruleTriggers }
                : {}),
              ...(sessionEntries() ? { sessionEntries: sessionEntries() } : {}),
            }
          : undefined,
    };
  } finally {
    acceptingQueue = false;
    await queueOperation;
    if (queuedInputs.length) {
      runtime?.session.clearQueue();
      queuedInputs = [];
      emitQueue();
    }
    await advisor.finish();
    nativeUi.cancel();
    contextMaintenance.clear();
    await nativeUi.drain();
    context = undefined;
    toolMap = new Map();
    promptInvocation = undefined;
    delete process.env.TOOLPLANE_RUNTIME_TOKEN;
    for (const provider of runtimeProviders)
      await modelRuntime.removeRuntimeApiKey(provider).catch(() => {});
    runtimeProviders = new Set(["toolplane"]);
    active = undefined;
    respond(terminal.success, terminal.result, terminal.code, terminal.reason);
  }
}
process.on("unhandledRejection", () => {
  turnError = "PI_SDK_ASYNC_FAILED";
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
    process.exitCode = 1;
    input.close();
    return;
  }
  try {
    void handle(JSON.parse(line));
  } catch {
    /* invalid JSON has no request identity */
  }
});
input.on("close", () => {
  void (async () => {
    nativeUi.cancel();
    await nativeUi.drain();
    await cancelChildren();
    await runtime?.session.abort();
    await runtime?.dispose();
  })().finally(() => process.exit());
});
