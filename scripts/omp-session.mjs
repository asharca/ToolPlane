import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeSync, readFileSync } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { OmpFrameDecoder } from "./omp-rpc.mjs";
import { createOmpUi } from "./omp-ui.mjs";
import { verifyOmpRuntime, OMP_VERSION } from "./omp-install.mjs";
import { assembleOmpCapabilities } from "./omp-capabilities.mjs";
import { verifyPiPackageSnapshots } from "./pi-sdk-package-files.mjs";

// One real OMP process per turn. Conversation-scoped sessions and approved
// resources survive; platform history is never replayed after an interrupted run.
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const emit = (event) => writeSync(1, `${JSON.stringify(event)}\n`);
const fail = (code) => {
  throw new Error(code);
};
const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (
    (await lstat(path)).isSymbolicLink() ||
    (await realpath(path)) !== resolve(path)
  )
    fail("OMP_STATE_SCOPE");
}
if (
  config.ompVersion !== OMP_VERSION ||
  !config.agentRevisionId ||
  !config.token ||
  !config.sessionDir ||
  !config.runRoot
)
  fail("OMP_CONFIG_INVALID");
if (
  config.subagentMode !== undefined &&
  !["platform", "native"].includes(config.subagentMode)
)
  fail("OMP_CONFIG_INVALID");
if (config.subagentMode !== undefined && !config.capabilities)
  fail("OMP_CONFIG_INVALID");
if (
  config.subagentMode === "native" &&
  (!Number.isInteger(config.capabilities.policy?.maxConcurrency) ||
    config.capabilities.policy.maxConcurrency < 1 ||
    config.capabilities.policy.maxConcurrency > 8 ||
    !Number.isInteger(config.capabilities.policy?.maxDepth) ||
    config.capabilities.policy.maxDepth < 1 ||
    config.capabilities.policy.maxDepth > 4)
)
  fail("OMP_CONFIG_INVALID");
if (!(await verifyOmpRuntime(config.binary))) fail("OMP_RUNTIME_NOT_PREPARED");
await privateDirectory(config.sessionDir);
await privateDirectory(config.runRoot);
const agentDir = join(config.runRoot, "home", ".omp", "agent");
await privateDirectory(agentDir);
await privateDirectory(join(config.runRoot, "home"));
if (config.skillsRoot) {
  await mkdir(join(agentDir, "skills"), { recursive: true, mode: 0o700 });
  await symlink(
    config.skillsRoot,
    join(agentDir, "skills", "toolplane"),
    "dir",
  );
}
let totalBytes = 0;
if ((config.snapshot?.files?.length ?? 0) > 512) fail("OMP_CONFIG_LIMIT");
for (const file of config.snapshot?.files ?? []) {
  if (
    config.capabilities &&
    /^(?:agents|skills|hooks|extensions)\//.test(file.path)
  )
    fail("OMP_CONFIG_DUPLICATE_CAPABILITY");
  const path = resolve(agentDir, file.path);
  if (
    !within(agentDir, path) ||
    path === agentDir ||
    file.path.includes("\\") ||
    file.path.includes("\0")
  )
    fail("OMP_CONFIG_SCOPE");
  totalBytes += Buffer.byteLength(file.content);
  if (totalBytes > 4 * 1024 * 1024) fail("OMP_CONFIG_LIMIT");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, file.content, { flag: "wx", mode: 0o600 });
}
// Snapshot settings are flattened registry paths. JSON is valid YAML, but the
// on-disk loader expects nested mappings, not literal dotted object keys.
function nest(flat) {
  const result = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    if (
      parts.some((part) =>
        ["__proto__", "prototype", "constructor"].includes(part),
      )
    )
      fail("OMP_CONFIG_SCOPE");
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return result;
}
await writeFile(
  join(agentDir, "config.yml"),
  JSON.stringify(nest(config.snapshot?.settings ?? {})),
  { mode: 0o600 },
);
process.env.TOOLPLANE_RUNTIME_TOKEN = config.token;
const mcp = await import(pathToFileURL(config.mcpFactoryPath).href);
const tools = await mcp.createPiMcpTools(config.mcpConfig);
// These tools belong to the RPC host, not OMP's native MCP manager. Its catalog
// refresh removes every mcp__ name, including otherwise unrelated host tools.
// Keep Pi's factory/catalog unchanged and expose only OMP-owned names here.
const hostNames = new Map(
  tools.map((tool) => [tool.name, tool.name.replace(/^mcp__/, "tp__")]),
);
const factoryNames = new Map(
  [...hostNames].map(([factoryName, hostName]) => [hostName, factoryName]),
);
for (const tool of tools) {
  if (tool.name === "mcp_result_to_file") {
    const parameter = tool.parameters.properties.tool;
    tool.parameters = {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        tool: {
          ...parameter,
          enum: parameter.enum.map((name) => hostNames.get(name)),
        },
      },
    };
    const execute = tool.execute.bind(tool);
    tool.execute = (id, args, signal) =>
      execute(id, { ...args, tool: factoryNames.get(args.tool) }, signal);
  }
  tool.name = hostNames.get(tool.name);
}
const platformDelegationTools = tools
  .filter((tool) =>
    /^(?:pi_a2a_(?:peers|submit|status|cancel)|a2a_(?:send_message|get_task|cancel_task|list_agents))$/.test(
      tool.label,
    ),
  )
  .map((tool) => tool.name);
const hostToolOrigins = Object.fromEntries(
  tools.flatMap((tool) => {
    const match = /^tp__s(\d+)_/.exec(tool.name);
    const server = match && config.mcpConfig.servers[Number(match[1]) - 1];
    return server
      ? [
          [
            tool.name,
            { deploymentId: server.deploymentId, toolName: tool.label },
          ],
        ]
      : [];
  }),
);
const subagents =
  config.subagentMode === undefined ? config.capabilities?.subagents : [];
for (const child of subagents ?? []) {
  child.tools.push(
    ...tools
      .filter((tool) => {
        const match = /^tp__s(\d+)_/.exec(tool.name);
        const server = match && config.mcpConfig.servers[Number(match[1]) - 1];
        return (
          server &&
          child.definition.permissions.mcpTools.some(
            (grant) =>
              grant.deploymentId === server.deploymentId &&
              grant.tools.includes(tool.label),
          )
        );
      })
      .map((tool) => tool.name),
  );
}
const plugins = config.capabilities?.plugins ?? [];
verifyPiPackageSnapshots(plugins);
const loadedPlugins = await assembleOmpCapabilities({
  plugins,
  subagents,
  nativeRoleModels: config.capabilities?.nativeRoleModels ?? [],
  agentDir,
});
const pluginSettingsRoot = join(config.runRoot, "xdg-data", "omp", "plugins");
await mkdir(pluginSettingsRoot, { recursive: true, mode: 0o700 });
await writeFile(
  join(pluginSettingsRoot, "omp-plugins.lock.json"),
  JSON.stringify({
    plugins: {},
    settings: Object.fromEntries(
      loadedPlugins.map((plugin) => [plugin.name, plugin.config]),
    ),
  }),
  { mode: 0o600 },
);
const providers = {
  toolplane: {
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    apiKey: "TOOLPLANE_RUNTIME_TOKEN",
    authHeader: true,
    auth: "apiKey",
    models: [config.model],
  },
};
for (const child of [
  ...(subagents ?? []),
  ...(config.capabilities?.nativeRoleModels ?? []),
])
  providers[child.modelProvider] = {
    api: child.model.api,
    baseUrl: child.model.baseUrl,
    apiKey: "TOOLPLANE_RUNTIME_TOKEN",
    authHeader: true,
    auth: "apiKey",
    models: [child.model],
  };
await writeFile(join(agentDir, "models.yml"), JSON.stringify({ providers }), {
  mode: 0o600,
});
const policyPath = join(config.runRoot, "policy.json");
await writeFile(
  policyPath,
  JSON.stringify({
    modelSelector: `toolplane/${config.model.id}`,
    nativeRoleModels: (config.capabilities?.nativeRoleModels ?? []).map(
      ({ modelSelector }) => ({ modelSelector }),
    ),
    tools: config.tools,
    disabledTools: config.disabledTools,
    hostToolOrigins,
    hostTools: tools.map(({ name, label }) => ({ name, label })),
    skillIdentities: (config.skillIdentities ?? []).flatMap((skill) => [
      skill,
      {
        ...skill,
        path: join(agentDir, "skills", "toolplane", skill.directory),
      },
    ]),
    subagentMode: config.subagentMode,
    agentDir,
    platformDelegationTools,
    ...(config.capabilities
      ? {
          subagents,
          policy: config.capabilities.policy,
          authorizeBase: config.authorizeBase,
        }
      : {}),
    uiUrl: config.uiUrl,
    cwd: config.cwd,
    plugins: loadedPlugins,
  }),
  { mode: 0o600 },
);
const marker = join(config.sessionDir, ".toolplane-session.json");
if (config.workspaceRoot) {
  const { migrateNativeSessionPaths } = await import(
    "./native-session-paths.mjs"
  );
  await migrateNativeSessionPaths({
    ...config,
    sessionsDir: config.sessionDir,
    statePath: marker,
  });
}
let saved;
try {
  saved = JSON.parse(await readFile(marker, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (config.historyRequired && !saved) fail("OMP_SESSION_MISSING");
if (saved && saved.cwd !== config.cwd) fail("OMP_SESSION_SCOPE");
// Delegation settings are frozen per pinned revision; only the revision-upgrade
// service may move a session to another revision with different settings.
if (
  saved &&
  saved.agentRevisionId === config.agentRevisionId &&
  (saved.subagentMode !== config.subagentMode ||
    (config.subagentMode === "native" &&
      JSON.stringify(saved.nativePolicy) !==
        JSON.stringify(config.capabilities?.policy)))
)
  fail("OMP_SESSION_MODE_MISMATCH");
const environment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  TERM: "dumb",
  NO_COLOR: "1",
  HOME: join(config.runRoot, "home"),
  PI_CODING_AGENT_DIR: agentDir,
  PI_NATIVES_DIR: config.nativesDir,
  XDG_CONFIG_HOME: join(config.runRoot, "xdg-config"),
  XDG_DATA_HOME: join(config.runRoot, "xdg-data"),
  XDG_CACHE_HOME: join(config.runRoot, "xdg-cache"),
  XDG_STATE_HOME: join(config.runRoot, "xdg-state"),
  TOOLPLANE_RUNTIME_TOKEN: config.token,
  TOOLPLANE_OMP_POLICY: policyPath,
  PI_NO_TITLE: "1",
  PI_NO_PTY: "1",
  PI_TELEMETRY: "0",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
};
const overlayPath = join(config.runRoot, "platform.yml");
await writeFile(
  overlayPath,
  JSON.stringify({
    mcp: { enableProjectConfig: false },
    enabledModels: [
      `toolplane/${config.model.id}`,
      ...(subagents ?? []).map((child) => child.modelSelector),
    ],
    enabledProviders: [],
    disabledProviders: [
      "claude",
      "claude-plugins",
      "codex",
      "gemini",
      "github",
      "opencode",
      "cursor",
      "windsurf",
      "agents-md",
      "omp-plugins",
    ],
    modelRoles: Object.fromEntries(
      [
        "default",
        "smol",
        "slow",
        "plan",
        "advisor",
        "vision",
        "tiny",
        "memory",
      ].map((role) => [role, `toolplane/${config.model.id}`]),
    ),
  }),
  { mode: 0o600 },
);
const args = [
  "--mode",
  "rpc-ui",
  "--cwd",
  config.cwd,
  "--session-dir",
  config.sessionDir,
  "--model",
  `toolplane/${config.model.id}`,
  "--no-context-files",
  "--no-rules",
  "--config",
  overlayPath,
  "--trusted-extension",
  config.policyExtension,
  ...(config.tools.length
    ? ["--tools", config.tools.join(",")]
    : ["--no-tools"]),
];
for (const file of config.snapshot?.files ?? []) {
  if (
    !config.capabilities &&
    /^(extensions\/.*|hooks\/(pre|post)\/.*)\.(?:[cm]?js|ts)$/.test(file.path)
  )
    args.push("--trusted-extension", join(agentDir, file.path));
}
if (config.systemPrompt?.trim()) {
  const path = join(config.runRoot, "system.md");
  await writeFile(path, config.systemPrompt, { mode: 0o600 });
  args.push("--system-prompt", path);
}
const appended = [
  ...(config.snapshot?.files ?? [])
    .filter(
      (file) =>
        ["APPEND_SYSTEM.md", "SYSTEM.md", "RULES.md", "AGENTS.md"].includes(
          file.path,
        ) || file.path.startsWith("rules/"),
    )
    .map((file) => file.content),
  ...(config.subagentMode === "native"
    ? [
        `Native task delegation: create a temporary role for each assignment using tasks[].agent (a short role name), tasks[].task (the full role instructions and assignment), and tasks[].name (invocation handle). Roles are created on demand; no platform Agent or pre-registered definition is required. Imported roles use their frozen, authorized model mappings; other temporary roles inherit your exact model. All tasks inherit only authorized tools. Do not supply model, sourceSession, taskFile, or eval-defined tools. The parent alone maintains todos${platformDelegationTools.length ? " and alone uses platform Agent delegation tools. Use native tasks for parallel work inside this sandbox; use platform Agents for work that needs their own skills, tools or sandbox" : ""}.`,
        "The host rewrites each accepted tasks[].agent role name to a unique tp-native-* execution identity after applying its pinned instructions, model and tool limits. Normalized tool-call history and task results can show that internal identity. It is not a different role or an instruction to retry: submit the requested role name once, use the invocation handle to await its result, and never repeat successful work merely because an internal identity appears.",
      ]
    : []),
  ...(loadedPlugins.some((plugin) => plugin.nativeRoles?.length)
    ? [
        `Imported package role prompts available through tasks[].agent: ${loadedPlugins.flatMap((plugin) => plugin.nativeRoles ?? []).join(", ")}. These roles retain their package instructions, explicitly mapped models (otherwise the parent model), and narrowed tools.`,
      ]
    : []),
  ...(subagents?.length
    ? [
        "Platform subagent roles and exact call names. Use the call name in tasks[].agent, not a top-level agent field:",
        JSON.stringify(
          subagents.map(({ name, nativeName }) => ({
            role: name,
            callName: nativeName,
          })),
        ),
      ]
    : []),
].join("\n\n");
if (appended) {
  const path = join(config.runRoot, "append.md");
  await writeFile(path, appended, { mode: 0o600 });
  args.push("--append-system-prompt", path);
}
if (config.reasoningEffort && config.reasoningEffort !== "default")
  args.push("--thinking", config.reasoningEffort);
const child = spawn(config.binary, args, {
  cwd: environment.HOME,
  env: environment,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
// Native diagnostics may contain sandbox paths or provider payloads. They are not
// the application protocol and must not be copied into persisted platform logs.
child.stderr.resume();
const decoder = new OmpFrameDecoder();
const pending = new Map();
const hostCalls = new Map();
const seenHostCalls = new Set();
const childSources = new Map();
function childSource(payload) {
  const id = payload?.id ?? payload?.progress?.id;
  const definition = (subagents ?? []).find(
    (child) =>
      child.nativeName === (payload?.agent ?? payload?.progress?.agent),
  );
  let nativeSource;
  if (
    config.subagentMode === "native" &&
    id &&
    childSources.get(id)?.depth === undefined
  ) {
    try {
      nativeSource = JSON.parse(
        readFileSync(
          join(agentDir, "native-sources", `${encodeURIComponent(id)}.json`),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const source = {
    ...childSources.get(id),
    ...nativeSource,
    subagentId: id,
    ...(definition
      ? {
          subagentVersionId: definition.versionId,
          subagentName: definition.name,
        }
      : {}),
    ...(payload?.parentToolCallId
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
  };
  childSources.set(id, source);
  return source;
}
let closed = false,
  stopping = false,
  failure,
  promptId,
  promptResult,
  settled = false,
  commandText = "";
let text = "",
  commands = [],
  usage,
  modelFailed = false,
  chain = Promise.resolve();
let readyResolve, readyReject, resultResolve, resultReject;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
const result = new Promise((resolve, reject) => {
  resultResolve = resolve;
  resultReject = reject;
});
// Install handlers immediately: startup failure may precede waiting for result.
void result.catch(() => {});
function send(frame) {
  if (child.stdin.destroyed || closed) return;
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line) > decoder.maxFrameBytes)
    fail("OMP_RPC_INPUT_LIMIT");
  child.stdin.write(line);
}
function rpc(type, payload = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("OMP_RPC_COMMAND_TIMEOUT"));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, type, ...payload });
  });
}
const ui = createOmpUi({
  url: config.uiUrl,
  token: config.token,
  send,
  onError: () => {
    void stop("OMP_UI_FAILED");
  },
});
function finish() {
  if (promptResult && settled) resultResolve(promptResult);
}
function publishCommands(value) {
  commands = (value ?? [])
    .filter(
      (item) =>
        typeof item.name === "string" &&
        /^[a-z][a-z0-9_:-]{0,99}$/i.test(item.name) &&
        !config.hostOnlyCommands.includes(item.name) &&
        ![
          "login",
          "logout",
          "model",
          "modelpreset",
          "settings",
          "resume",
          "session",
          "fork",
          "new",
          "clear",
          "exit",
          "quit",
        ].includes(item.name),
    )
    .slice(0, 200)
    .map((item) => ({
      name: item.name,
      ...(typeof item.description === "string"
        ? { description: item.description.slice(0, 1000) }
        : {}),
    }));
  emit({ type: "omp_commands", commands });
}
const contentText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
const toolPayload = (value) => {
  if (value === undefined) return undefined;
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  return encoded.length > 20_000
    ? `${encoded.slice(0, 20_000)}…[truncated]`
    : value;
};
async function frame(event) {
  if (event.type === "ready") {
    decoder.ready(event);
    readyResolve();
    return;
  }
  if (event.type === "rpc_frame_error" || event.type === "extension_error")
    fail("OMP_RUNTIME_EXTENSION_FAILED");
  if (event.type === "response") {
    const request = pending.get(event.id);
    if (request) {
      pending.delete(event.id);
      clearTimeout(request.timer);
      if (!event.success) request.reject(new Error("OMP_RPC_COMMAND_FAILED"));
      else request.resolve(event.data);
    }
    if (event.id === promptId) {
      if (!event.success) fail("OMP_PROMPT_REJECTED");
      if (event.data?.agentInvoked === false) {
        promptResult = { status: "completed" };
        settled = true;
        finish();
      }
    }
    return;
  }
  if (event.type === "prompt_result" && event.id === promptId) {
    promptResult = event;
    settled = event.sessionSettled === true;
    finish();
    return;
  }
  if (event.type === "session_settled") {
    settled = true;
    finish();
    return;
  }
  if (event.type === "extension_ui_request") {
    if (
      event.method === "setStatus" &&
      event.statusKey === "toolplane.executionStage" &&
      event.statusText === "waiting-model" &&
      !event.source
    ) {
      emit({ type: "model_request" });
      return;
    }
    void ui.request(event).catch(() => stop("OMP_UI_FAILED"));
    return;
  }
  if (event.type === "available_commands_update") {
    publishCommands(event.commands);
    return;
  }
  if (event.type === "command_output") {
    const output =
      typeof event.text === "string"
        ? event.text
        : typeof event.content === "string"
          ? event.content
          : "";
    commandText += output;
    return;
  }
  if (event.type === "host_tool_cancel") {
    hostCalls.get(event.targetId)?.abort();
    return;
  }
  if (event.type === "host_tool_call") {
    const tool = tools?.find((tool) => tool.name === event.toolName);
    const controller = new AbortController();
    hostCalls.set(event.id, controller);
    void (async () => {
      try {
        if (seenHostCalls.has(event.toolCallId) || seenHostCalls.size >= 4096)
          fail("OMP_HOST_TOOL_REPLAY_DENIED");
        seenHostCalls.add(event.toolCallId);
        if (!tool) fail("OMP_HOST_TOOL_UNAVAILABLE");
        const output = await tool.execute(
          event.toolCallId,
          event.arguments,
          controller.signal,
        );
        send({ type: "host_tool_result", id: event.id, result: output });
      } catch {
        send({
          type: "host_tool_result",
          id: event.id,
          isError: true,
          result: {
            content: [
              {
                type: "text",
                text: "Authorized MCP invocation failed; external outcome may be unknown. Do not automatically replay.",
              },
            ],
          },
        });
      } finally {
        hostCalls.delete(event.id);
      }
    })();
    return;
  }
  if (event.type === "subagent_event") {
    const source = childSource(event.payload);
    const nested = event.payload?.event;
    if (
      [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
      ].includes(nested?.type)
    ) {
      const projected = {
        type: nested.type,
        toolName: nested.toolName,
        toolCallId: nested.toolCallId,
        args: toolPayload(nested.args),
        result: toolPayload(nested.result ?? nested.partialResult),
        isError: nested.isError === true,
      };
      emit({ type: "omp_child_event", source, event: projected });
      if (nested.type !== "tool_execution_update")
        await ui.activity({
          type: "tool",
          status:
            nested.type === "tool_execution_end"
              ? nested.isError
                ? "failed"
                : "completed"
              : "running",
          source,
          toolName: nested.toolName,
          toolCallId: `${source.subagentId}:${nested.toolCallId}`,
          ...(projected.args === undefined ? {} : { input: projected.args }),
          ...(projected.result === undefined
            ? {}
            : { output: projected.result }),
          isError: nested.isError === true,
        });
      if (
        nested.type === "tool_execution_end" &&
        nested.toolName === "todo" &&
        !nested.isError &&
        nested.result?.details?.phases
      )
        await ui.todos(nested.result.details.phases, source);
    }
    if (
      nested?.type === "message_update" &&
      nested.assistantMessageEvent?.type === "thinking_delta"
    )
      emit({
        type: "omp_child_event",
        source,
        event: {
          type: "thinking_delta",
          delta: nested.assistantMessageEvent.delta,
        },
      });
    if (
      nested?.type === "message_end" &&
      nested.message?.role === "assistant"
    ) {
      const childText = contentText(nested.message.content).slice(0, 20_000);
      const thinking = (nested.message.content ?? [])
        .filter((part) => part.type === "thinking")
        .map((part) => part.thinking)
        .join("\n")
        .slice(0, 20_000);
      if (thinking)
        await ui.activity({
          type: "reasoning",
          status: "completed",
          delta: thinking,
          source,
        });
      if (childText) {
        const isError = ["error", "aborted"].includes(
          nested.message.stopReason,
        );
        emit({
          type: "omp_child_event",
          source,
          event: { type: "message_end", text: childText, isError },
        });
        await ui.activity({
          type: "tool",
          status: isError ? "failed" : "completed",
          source,
          toolName: "task",
          toolCallId: `omp-child:${source.subagentId}:result`,
          output: childText,
          isError,
        });
      }
    }
    return;
  }
  if (
    event.type === "subagent_lifecycle" ||
    event.type === "subagent_progress"
  ) {
    const source = childSource(event.payload);
    const status = event.payload?.status ?? event.payload?.progress?.status;
    if (event.type !== "subagent_lifecycle") return;
    emit({
      type: "omp_subagent",
      subagentId: source.subagentId,
      status,
      source,
    });
    await ui.activity({
      type: "tool",
      toolName: "task",
      toolCallId: `omp-child:${source.subagentId}`,
      source,
      status: ["completed", "failed", "aborted", "cancelled"].includes(status)
        ? status === "completed"
          ? "completed"
          : "failed"
        : "running",
    });
    return;
  }
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
    return;
  }
  if (
    [
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ].includes(event.type)
  ) {
    emit({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.args === undefined ? {} : { args: toolPayload(event.args) }),
      ...(event.result === undefined
        ? {}
        : { result: toolPayload(event.result) }),
      isError: event.isError === true,
    });
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "todo" &&
      !event.isError &&
      event.result?.details?.phases
    )
      await ui.todos(event.result.details.phases);
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const message = event.message;
    modelFailed =
      message.stopReason === "error" || message.stopReason === "aborted";
    const part = contentText(message.content);
    if (part) text += (text ? "\n\n" : "") + part;
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
    // Retain authoritative final messages in OMP's session, not the compacted agent_end.
  }
  if (
    event.type === "notice" &&
    event.level === "error" &&
    ["session-persistence", "btw-history"].includes(event.source)
  )
    fail("OMP_SESSION_PERSISTENCE_FAILED");
}
async function stop(code) {
  if (stopping) return;
  stopping = true;
  failure ??= code;
  readyReject(new Error(failure));
  resultReject(new Error(failure));
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(failure));
  }
  pending.clear();
  for (const controller of hostCalls.values()) controller.abort();
  await ui.close().catch(() => {});
  if (closed) return;
  send({ type: "abort_and_restore_queue", id: randomUUID() });
  child.stdin.end();
  const terminate = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }, 500);
  const kill = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2000);
  child.once("close", () => {
    clearTimeout(terminate);
    clearTimeout(kill);
  });
}
const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
reader.on("line", (line) => {
  chain = chain
    .then(() => {
      const event = decoder.decode(line);
      if (event) return frame(event);
    })
    .catch(() => stop("OMP_RPC_PROTOCOL_FAILED"));
});
child.stdin.on("error", () => {
  if (!closed) void stop("OMP_RPC_PIPE_CLOSED");
});
child.once("error", () => {
  void stop("OMP_PROCESS_FAILED");
});
const exited = new Promise((resolve) =>
  child.once("close", (code, signal) => {
    closed = true;
    void chain.then(() => {
      if (code !== 0 || signal || !promptResult || !settled) {
        failure ??= "OMP_PROCESS_INTERRUPTED";
        readyReject(new Error(failure));
        resultReject(new Error(failure));
      }
      resolve();
    });
  }),
);
const startupTimer = setTimeout(() => stop("OMP_READY_TIMEOUT"), 60_000);
const interrupt = () => {
  void stop("OMP_ABORTED");
};
process.once("SIGTERM", interrupt);
process.once("SIGINT", interrupt);
try {
  await ready;
  clearTimeout(startupTimer);
  await rpc("negotiate_protocol", { protocolVersion: 2 });
  await rpc("set_ask_dialog", { enabled: true });
  await rpc("set_subagent_subscription", { level: "events" });
  await rpc("set_event_filter", { events: null, messageUpdates: "delta" });
  const opened = await rpc("open_session", {
    sessionDir: config.sessionDir,
    provider: "toolplane",
    modelId: config.model.id,
  });
  if (opened.cancelled || (saved?.hadMessages && !opened.resumed))
    fail("OMP_SESSION_MISSING");
  await writeFile(
    marker,
    JSON.stringify({
      cwd: config.cwd,
      agentRevisionId: config.agentRevisionId,
      subagentMode: config.subagentMode,
      ...(config.subagentMode === "native"
        ? { nativePolicy: config.capabilities?.policy }
        : {}),
      hadMessages: saved?.hadMessages ?? false,
    }),
    { mode: 0o600 },
  );
  await rpc("set_host_tools", {
    tools: tools.map(({ name, label, description, parameters }) => ({
      name,
      label,
      description,
      parameters,
      loadMode: "essential",
    })),
  });
  publishCommands((await rpc("get_available_commands")).commands);
  const state = await rpc("get_state");
  await ui.todos(state.todoPhases);
  if (
    config.command &&
    !commands.some(
      (command) => command.name === config.command.slice(1).split(/\s/)[0],
    )
  )
    fail("OMP_COMMAND_UNAVAILABLE");
  promptId = randomUUID();
  send({
    type: "prompt",
    id: promptId,
    message: config.command || config.message,
  });
  const completed = await result;
  const finalState = await rpc("get_state");
  await writeFile(
    marker,
    JSON.stringify({
      cwd: config.cwd,
      agentRevisionId: config.agentRevisionId,
      subagentMode: config.subagentMode,
      ...(config.subagentMode === "native"
        ? { nativePolicy: config.capabilities?.policy }
        : {}),
      hadMessages: finalState.messageCount > 0,
    }),
    { mode: 0o600 },
  );
  await ui.todos(finalState.todoPhases);
  if (finalState.contextUsage?.tokens)
    emit({ type: "omp_context", tokens: finalState.contextUsage.tokens });
  await ui.close();
  child.stdin.end();
  await exited; // Drain all output, including late persistence failures.
  decoder.end();
  if (failure) fail(failure);
  const success = completed.status === "completed" && !modelFailed;
  emit({
    type: "toolplane_omp_response",
    success,
    result: {
      text,
      commands,
      usage,
      ...(config.command
        ? {
            commandResult: {
              command: config.command,
              text: commandText || text,
              status: success ? "completed" : "failed",
            },
          }
        : {}),
    },
    ...(success
      ? {}
      : {
          error: {
            code:
              completed.status === "aborted"
                ? "OMP_ABORTED"
                : "OMP_MODEL_FAILED",
          },
        }),
  });
} catch (error) {
  await stop(
    /^OMP_[A-Z_]+$/.test(error.message) ? error.message : "OMP_RUNTIME_FAILED",
  );
  await exited;
  emit({
    type: "toolplane_omp_response",
    success: false,
    error: { code: failure },
  });
} finally {
  clearTimeout(startupTimer);
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
  delete process.env.TOOLPLANE_RUNTIME_TOKEN;
  await rm(config.runRoot, { recursive: true, force: true });
}
