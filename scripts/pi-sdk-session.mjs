#!/usr/bin/env node
// Trusted headless SDK host. Extension stdout is deliberately not a protocol channel.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { enforceNativeNamespaces } from "./pi-sdk-capabilities.mjs";
import { createNativeUi } from "./pi-sdk-ui.mjs";
import {
  configureNativeTodo,
  officialTodoPath,
} from "./pi-sdk-native-resources.mjs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
// Extension and native writable state belongs to this conversation, never /root.
for (const [name, directory] of Object.entries({
  HOME: join(config.agentDir, "home"),
  PI_CODING_AGENT_DIR: config.agentDir,
  XDG_CONFIG_HOME: join(config.agentDir, "xdg-config"),
  XDG_DATA_HOME: join(config.agentDir, "xdg-data"),
  XDG_CACHE_HOME: join(config.agentDir, "xdg-cache"),
  XDG_STATE_HOME: join(config.agentDir, "xdg-state"),
})) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env[name] = directory;
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
const fail = (code, reason) => {
  throw Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });
};
// Provider text may echo credentials or prompts; only a fixed reason leaves the host.
// The model base URL is always ToolPlane's proxy, so a connection failure means the
// sandbox cannot reach ToolPlane; upstream outages arrive as proxied HTTP statuses.
function modelFailureReason(errorMessage) {
  const message = String(errorMessage ?? "");
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
  if (/stream ended|finish_reason: network_error|terminated/i.test(message))
    return "STREAM_INCOMPLETE";
  if (/content_filter/i.test(message)) return "CONTENT_FILTER";
  return "PROVIDER_ERROR";
}
// Gateways that already sent HTTP 200 report an upstream that produced nothing,
// or a stream cut before finish_reason, as an in-stream error. Pi 0.87.1 does
// not classify either as transient.
const EMPTY_STREAM = /empty_stream|empty .{0,40}stream/i;
const TRANSIENT_STREAM =
  /empty_stream|empty .{0,40}stream|without finish_reason/i;
const MAX_MODEL_RETRIES = 10;
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
};
mkdirSync(config.cwd, { recursive: true });
mkdirSync(config.sessionsDir, { recursive: true });
const cwd = realpathSync(config.cwd),
  sessionsDir = realpathSync(config.sessionsDir);
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
let texts = [],
  usage,
  turnError,
  modelFailed = false,
  modelReason,
  modelRetried = 0,
  aborted = false;
let lastState;
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
  if (config.sdkVersion !== "0.87.1" || sdkVersion !== "0.87.1")
    fail("PI_SDK_VERSION_MISMATCH");
  if (!existsSync(config.statePath) && config.historyRequired)
    fail("PI_SDK_SESSION_MISSING");
  if (existsSync(config.statePath)) {
    saved = JSON.parse(readFileSync(config.statePath, "utf8"));
    if (saved.runtimeKind !== "pi-sdk" || saved.sdkVersion !== "0.87.1")
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
    sdkVersion: "0.87.1",
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
function event(event) {
  if (!active) return;
  if (event.type === "auto_retry_start") modelRetried = event.attempt;
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
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
        assistantMessageEvent: { type: update.type, delta: update.delta },
      });
  }
  if (event.type === "tool_execution_start")
    emit({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: toolPayload(event.args),
    });
  // A failed tool call (for example a shell command exiting non-zero) is an
  // ordinary result the model reads and reacts to; it does not fail the turn.
  if (event.type === "tool_execution_end")
    emit({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      result: toolPayload(event.result),
    });
  if (event.type === "message_end") {
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
      if (message.usage) {
        usage ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        };
        usage.inputTokens += message.usage.input ?? 0;
        usage.outputTokens += message.usage.output ?? 0;
        usage.cacheReadTokens += message.usage.cacheRead ?? 0;
        usage.cacheWriteTokens += message.usage.cacheWrite ?? 0;
        usage.costUsd += message.usage.cost?.total ?? 0;
      }
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
  // Pi 0.87.1 clamps to the current model and persists the change in this session only.
  session.setThinkingLevel(level, { persist: false });
}
// Pinned 0.87.1 exposes no retry matcher setting; extend its instance check so
// empty/incomplete gateway streams retry under the same budget and backoff.
function allowTransientStreamRetry(session) {
  const piRetryable = session._isRetryableError;
  if (typeof piRetryable !== "function") fail("PI_SDK_VERSION_MISMATCH");
  if (piRetryable.toolplane) return;
  const retryable = (message) =>
    piRetryable.call(session, message) ||
    (message?.stopReason === "error" &&
      TRANSIENT_STREAM.test(String(message.errorMessage ?? "")));
  retryable.toolplane = true;
  session._isRetryableError = retryable;
}
async function bindSession(session) {
  unsubscribe?.();
  unsubscribe = session.subscribe(event);
  allowTransientStreamRetry(session);
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
async function factory({ cwd: nextCwd, sessionManager, sessionStartEvent }) {
  if (
    realpathSync(nextCwd) !== cwd ||
    !within(sessionsDir, resolve(sessionManager.getSessionDir()))
  )
    fail("PI_SDK_SESSION_SCOPE");
  await verifyPiPackageSnapshots(config.packages);
  const extensions = [...config.resources.extensions, todoPath];
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir: config.agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: extensions,
      extensionFactories: [
        {
          name: "toolplane-web-projection",
          hidden: true,
          factory: (pi) => {
            const project = (_event, ctx) =>
              nativeUi.projectTodos(ctx.sessionManager);
            pi.on("session_start", project);
            pi.on("session_tree", project);
            pi.on("before_provider_request", () => {
              if (active) emit({ type: "model_request" });
            });
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
    excludeTools: config.excludeTools,
    customTools,
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
  // Workspace setting, live per turn: retries one failed model request in place.
  config.modelRetries =
    Number.isInteger(next.modelRetries) &&
    next.modelRetries >= 0 &&
    next.modelRetries <= MAX_MODEL_RETRIES
      ? next.modelRetries
      : 0;
  modelRuntime.registerProvider("toolplane", {
    baseUrl: config.model.baseUrl,
    api: config.model.api,
    apiKey: "$TOOLPLANE_RUNTIME_TOKEN",
    authHeader: true,
    models: [config.model],
  });
  context = next;
  process.env.TOOLPLANE_RUNTIME_TOKEN = next.runtimeToken;
  await modelRuntime.setRuntimeApiKey("toolplane", next.runtimeToken);
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
        : { error: { code, message: code, ...(reason ? { reason } : {}) } }),
    });
  if (!request || typeof request.id !== "string") return;
  if (request.type === "abort") {
    try {
      aborted = true;
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
  if (active) {
    respond(false, undefined, "PI_SDK_BUSY");
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
  nativeUi.start();
  texts = [];
  usage = undefined;
  turnError = undefined;
  aborted = false;
  modelFailed = false;
  modelReason = undefined;
  modelRetried = 0;
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
    let command;
    let compaction;
    if (request.type === "compact") {
      command = "compact";
      compaction = await runtime.session.compact(request.customInstructions);
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
        compaction = await runtime.session.compact(
          request.message.slice("/compact".length).trim() || undefined,
        );
      else await runtime.session.prompt(request.message);
    }
    if (compaction) texts.push(compaction.summary);
    let current;
    do {
      current = runtime.session;
      await current.waitForIdle();
    } while (current !== runtime.session);
    if (aborted) fail("PI_SDK_ABORTED");
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
        ...(usage ? { usage } : {}),
        ...(command
          ? { commandResult: { command, text, status: "completed" } }
          : {}),
        state: state(),
      },
    };
  } catch (error) {
    try {
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
        code === "PI_SDK_UI_FAILED")
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
    };
  } finally {
    nativeUi.cancel();
    await nativeUi.drain();
    context = undefined;
    toolMap = new Map();
    promptInvocation = undefined;
    delete process.env.TOOLPLANE_RUNTIME_TOKEN;
    await modelRuntime.removeRuntimeApiKey("toolplane").catch(() => {});
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
    await runtime?.session.abort();
    await runtime?.dispose();
  })().finally(() => process.exit());
});
