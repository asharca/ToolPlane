#!/usr/bin/env node
// Trusted headless SDK host. Extension stdout is deliberately not a protocol channel.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdkEntry = realpathSync(join(config.packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
const sdk = await import(pathToFileURL(sdkEntry).href);
const { InMemoryCredentialStore } = await import(pathToFileURL(join(dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(sdkEntry))), 'dist/index.js')).href);
const { verifyPiPackageSnapshots, canonicalJson } = await import(pathToFileURL(config.packageVerifierPath).href);
const { createPiMcpTools } = await import(pathToFileURL(config.mcpFactoryPath).href);
const sdkVersion = JSON.parse(readFileSync(join(dirname(sdkEntry), '..', 'package.json'), 'utf8')).version;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const emit = (event) => writeFileSync(3, `${JSON.stringify(event)}\n`);
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); };
// Generated MCP adapters reuse platform customTools here; external Pi connects through its own installation.
globalThis[Symbol.for('toolplane.pi.host-context.v1')] = { kind: 'toolplane-sdk', platformMcp: true };
mkdirSync(config.cwd, { recursive: true });
mkdirSync(config.sessionsDir, { recursive: true });
const cwd = realpathSync(config.cwd), sessionsDir = realpathSync(config.sessionsDir);
const packageRoots = (config.packages ?? []).map((p) => resolve(p.root));
function allowedResource(path, base = cwd) {
  if (typeof path !== 'string' || /^(npm:|git:|https?:)/.test(path)) fail('PI_EXTENSION_RESOURCE_DENIED');
  let actual;
  try { actual = realpathSync(resolve(base, path)); } catch { fail('PI_EXTENSION_RESOURCE_DENIED'); }
  if (packageRoots.some((root) => within(root, actual))) return actual;
  if (!within(cwd, actual) || within(realpathSync(config.agentDir), actual) || within(join(cwd, '.pi'), actual) || within(join(cwd, '.toolplane'), actual)) fail('PI_EXTENSION_RESOURCE_DENIED');
  return actual;
}
function sessionPath(path) {
  if (typeof path !== 'string' || !existsSync(path)) fail('PI_SDK_SESSION_MISSING');
  const actual = realpathSync(path);
  if (!within(sessionsDir, actual)) fail('PI_SDK_SESSION_SCOPE');
  const fd = openSync(actual, 'r'), buffer = Buffer.alloc(64 * 1024);
  let header;
  try {
    const bytes = readSync(fd, buffer, 0, buffer.length, 0), end = buffer.subarray(0, bytes).indexOf(10);
    if (end < 0) fail('PI_SDK_SESSION_MISSING');
    header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
  } finally { closeSync(fd); }
  if (header.type !== 'session' || resolve(header.cwd) !== cwd) fail('PI_SDK_SESSION_SCOPE');
  return actual;
}
let runtime, unsubscribe, active, context, initialError, toolSignature, toolMap = new Map(), customTools = [];
let texts = [], usage, turnError, aborted = false;
let lastState;
const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: config.defaultTools, packages: [], extensions: [], skills: [], prompts: [], themes: [], compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(config.agentDir, 'model-cache.json'), refreshOnCreate: false });
modelRuntime.registerProvider('toolplane', { baseUrl: config.model.baseUrl, api: config.model.api, apiKey: '$TOOLPLANE_RUNTIME_TOKEN', authHeader: true, models: [config.model] });
let saved;
try {
  if (config.sdkVersion !== '0.87.1' || sdkVersion !== '0.87.1') fail('PI_SDK_VERSION_MISMATCH');
  if (!existsSync(config.statePath) && config.historyRequired) fail('PI_SDK_SESSION_MISSING');
  if (existsSync(config.statePath)) {
    saved = JSON.parse(readFileSync(config.statePath, 'utf8'));
    if (saved.runtimeKind !== 'pi-sdk' || saved.sdkVersion !== '0.87.1') fail('PI_SDK_SESSION_MISSING');
    if (saved.packageSetChecksum !== config.packageSetChecksum) fail('PI_SDK_PACKAGE_SET_CHANGED');
    if (!saved.sessionPersisted) fail('PI_SDK_SESSION_MISSING');
    sessionPath(saved.sessionFile);
  }
} catch (error) { initialError = error.code ?? 'PI_SDK_SESSION_MISSING'; }
function state() {
  const session = runtime?.session;
  if (!session) return { sessionId: saved?.sessionId ?? null, sessionFile: saved?.sessionFile ?? null, sessionPersisted: saved?.sessionPersisted ?? false };
  const sessionFile = session.sessionFile ?? null;
  if (sessionFile && !within(sessionsDir, resolve(sessionFile))) fail('PI_SDK_SESSION_SCOPE');
  return { sessionId: session.sessionManager.getSessionId(), sessionFile, sessionPersisted: Boolean(sessionFile && existsSync(sessionFile)) };
}
function persist() {
  const value = { runtimeKind: 'pi-sdk', sdkVersion: '0.87.1', ...state(), packageSetChecksum: config.packageSetChecksum };
  const temporary = `${config.statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, config.statePath);
  lastState = value;
}
function diagnostics(services) {
  const loader = services.resourceLoader;
  if (services.diagnostics.some((d) => d.type === 'error') || loader.getExtensions().errors.length || [loader.getSkills(), loader.getPrompts(), loader.getThemes()].some((r) => r.diagnostics.some((d) => d.type === 'error'))) fail('PI_EXTENSION_LOAD_FAILED');
}
function commands() {
  if (!runtime) return [];
  return [...runtime.session.extensionRunner.getRegisteredCommands().map((c) => ({ name: c.invocationName, description: c.description })),
    ...runtime.session.promptTemplates.map((c) => ({ name: c.name, description: c.description })),
    ...runtime.services.resourceLoader.getSkills().skills.map((s) => ({ name: `skill:${s.name}`, description: s.description })),
    { name: 'compact', description: 'Compact session' }].filter((c) => !(config.hostOnlyCommands ?? []).includes(c.name));
}
const contentText = (content) => typeof content === 'string' ? content : (content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
function event(event) {
  if (!active) return;
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') emit({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
  if (event.type === 'tool_execution_start') emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName });
  if (event.type === 'tool_execution_end') {
    emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
    if (event.isError) turnError = 'PI_SDK_TOOL_FAILED';
  }
  if (event.type === 'message_end') {
    const message = event.message;
    if (message.role === 'custom' && message.display !== false) texts.push(`Pi 扩展 · ${message.customType}\n${contentText(message.content)}`);
    if (message.role === 'assistant') {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') turnError = 'PI_SDK_MODEL_FAILED';
      const text = contentText(message.content); if (text) texts.push(text);
      if (message.usage) {
        usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
        usage.inputTokens += message.usage.input ?? 0; usage.outputTokens += message.usage.output ?? 0;
        usage.cacheReadTokens += message.usage.cacheRead ?? 0; usage.cacheWriteTokens += message.usage.cacheWrite ?? 0;
        usage.costUsd += message.usage.cost?.total ?? 0;
      }
    }
  }
}
async function bindSession(session) {
  unsubscribe?.();
  unsubscribe = session.subscribe(event);
  await session.bindExtensions({ mode: 'json', onError: () => { turnError = 'PI_EXTENSION_LOAD_FAILED'; },
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: async (options) => { if (options?.parentSession) sessionPath(options.parentSession); return runtime.newSession(options); },
      fork: (id, options) => runtime.fork(id, options),
      switchSession: (path, options) => runtime.switchSession(sessionPath(path), options),
      navigateTree: (id, options) => runtime.session.navigateTree(id, options),
      reload: async () => { await verifyPiPackageSnapshots(config.packages); await runtime.session.reload(); diagnostics(runtime.services); persist(); },
    },
  });
  diagnostics(runtime.services);
  if (turnError) fail(turnError);
  persist();
}
async function factory({ cwd: nextCwd, sessionManager, sessionStartEvent }) {
  if (realpathSync(nextCwd) !== cwd || !within(sessionsDir, resolve(sessionManager.getSessionDir()))) fail('PI_SDK_SESSION_SCOPE');
  await verifyPiPackageSnapshots(config.packages);
  const extensions = [...(config.approvalExtensionPath && context?.approvalUrl ? [config.approvalExtensionPath] : []), ...config.resources.extensions];
  const services = await sdk.createAgentSessionServices({ cwd, agentDir: config.agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: extensions, additionalSkillPaths: config.resources.skills, additionalPromptTemplatePaths: config.resources.prompts,
      additionalThemePaths: config.resources.themes, systemPrompt: config.systemPrompt,
      extensionsOverride: (base) => { if (config.approvalExtensionPath && context?.approvalUrl) base.extensions.sort((a, b) => Number(b.resolvedPath === config.approvalExtensionPath) - Number(a.resolvedPath === config.approvalExtensionPath)); return base; },
    },
  });
  diagnostics(services);
  const loader = services.resourceLoader, extend = loader.extendResources.bind(loader), reload = loader.reload.bind(loader);
  loader.extendResources = (paths) => {
    verifyPiPackageSnapshots(config.packages);
    const validated = {};
    for (const key of ['skillPaths', 'promptPaths', 'themePaths']) validated[key] = (paths[key] ?? []).map((entry) => ({ ...entry, path: allowedResource(entry.path, entry.metadata?.baseDir ?? cwd) }));
    extend(validated); diagnostics(services);
  };
  loader.reload = async (...args) => { await verifyPiPackageSnapshots(config.packages); await reload(...args); diagnostics(services); };
  const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: config.model, excludeTools: config.excludeTools, customTools });
  return { ...result, services, diagnostics: services.diagnostics };
}
async function refreshContext(next) {
  if (!next || typeof next.runtimeToken !== 'string' || !next.runtimeToken || !next.mcpConfig || !Array.isArray(next.mcpConfig.servers)) fail('PI_SDK_CONTEXT_REQUIRED');
  context = next;
  process.env.TOOLPLANE_RUNTIME_TOKEN = next.runtimeToken;
  if (next.approvalUrl) process.env.TOOLPLANE_APPROVAL_URL = next.approvalUrl; else delete process.env.TOOLPLANE_APPROVAL_URL;
  if (next.approvalUrl) {
    if (!config.approvalHelperPath || !config.approvalExtensionPath) fail('PI_SDK_APPROVAL_REQUIRED');
    const { approvalReady } = await import(pathToFileURL(config.approvalHelperPath).href);
    await approvalReady();
  }
  await modelRuntime.setRuntimeApiKey('toolplane', next.runtimeToken);
  const definitions = await createPiMcpTools(next.mcpConfig);
  const signature = canonicalJson(definitions.map((t) => ({ name: t.name, parameters: t.parameters })).sort((a, b) => a.name.localeCompare(b.name)));
  if (toolSignature !== undefined && signature !== toolSignature) fail('PI_SDK_TOOLSET_CHANGED');
  if (runtime && Boolean(next.approvalUrl) !== Boolean(runtime.approvalRequired)) fail('PI_SDK_TOOLSET_CHANGED');
  toolMap = new Map(definitions.map((t) => [t.name, t]));
  if (toolSignature === undefined) customTools = definitions.map((tool) => {
    const name = tool.name;
    return { ...tool, execute: (...args) => { if (!context || !active) fail('PI_SDK_CONTEXT_REQUIRED'); return toolMap.get(name).execute(...args); } };
  });
  toolSignature = signature;
}
async function handle(request) {
  const respond = (success, result, code) => emit({ type: 'toolplane_sdk_response', id: request.id, success, ...(success ? { result } : { error: { code, message: code } }) });
  if (!request || typeof request.id !== 'string') return;
  if (request.type === 'abort') {
    try { aborted = true; await runtime?.session.abort(); respond(true, { text: 'Request aborted', commands: commands(), state: state() }); } catch { respond(false, undefined, 'PI_SDK_ABORT_FAILED'); }
    return;
  }
  if (active) { respond(false, undefined, 'PI_SDK_BUSY'); return; }
  if (request.type === 'get_state' || request.type === 'get_commands') {
    if (initialError) respond(false, undefined, initialError);
    else if (request.type === 'get_commands' && !runtime) respond(false, undefined, 'PI_SDK_CONTEXT_REQUIRED');
    else respond(true, { text: '', commands: commands(), state: state() });
    return;
  }
  if (!['prompt', 'compact'].includes(request.type)) { respond(false, undefined, 'PI_SDK_REQUEST_INVALID'); return; }
  active = request.id; texts = []; usage = undefined; turnError = undefined; aborted = false;
  let terminal;
  try {
    if (initialError) fail(initialError);
    await verifyPiPackageSnapshots(config.packages);
    if (runtime && lastState?.sessionPersisted) sessionPath(lastState.sessionFile);
    await refreshContext(request.context);
    if (aborted) fail('PI_SDK_ABORTED');
    if (!runtime) {
      const manager = saved ? sdk.SessionManager.open(sessionPath(saved.sessionFile), sessionsDir) : sdk.SessionManager.create(cwd, sessionsDir);
      if (saved && manager.getSessionId() !== saved.sessionId) fail('PI_SDK_SESSION_MISSING');
      runtime = await sdk.createAgentSessionRuntime(factory, { cwd, agentDir: config.agentDir, sessionManager: manager });
      runtime.approvalRequired = Boolean(context.approvalUrl);
      runtime.setRebindSession(bindSession);
      await bindSession(runtime.session);
    }
    let command;
    if (request.type === 'compact') { command = 'compact'; await runtime.session.compact(request.customInstructions); }
    else {
      if (typeof request.message !== 'string') fail('PI_SDK_REQUEST_INVALID');
      command = /^\/([^\s]+)(?:\s|$)/.exec(request.message)?.[1];
      if (command && !commands().some((c) => c.name === command)) fail('PI_SDK_COMMAND_UNKNOWN');
      if (command === 'compact') await runtime.session.compact(request.message.slice('/compact'.length).trim() || undefined);
      else await runtime.session.prompt(request.message);
    }
    let current;
    do { current = runtime.session; await current.waitForIdle(); } while (current !== runtime.session);
    if (aborted) fail('PI_SDK_ABORTED');
    if (turnError) fail(turnError);
    diagnostics(runtime.services); persist();
    const text = texts.join('\n\n') || (command ? `Pi command /${command} completed.` : '');
    if (usage) emit({ type: 'usage', ...usage });
    terminal = { success: true, result: { text, commands: commands(), ...(usage ? { usage } : {}), ...(command ? { commandResult: { command, text, status: 'completed' } } : {}), state: state() } };
  } catch (error) {
    try { if (runtime) await runtime.session.abort(); } catch { /* preserve original failure */ }
    terminal = { success: false, code: /^PI_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'PI_SDK_REQUEST_FAILED' };
  } finally {
    context = undefined; toolMap = new Map(); delete process.env.TOOLPLANE_RUNTIME_TOKEN; delete process.env.TOOLPLANE_APPROVAL_URL;
    await modelRuntime.removeRuntimeApiKey('toolplane').catch(() => {}); active = undefined;
    respond(terminal.success, terminal.result, terminal.code);
  }
}
process.on('unhandledRejection', () => { turnError = 'PI_SDK_ASYNC_FAILED'; });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) { process.exitCode = 1; input.close(); return; }
  try { void handle(JSON.parse(line)); } catch { /* invalid JSON has no request identity */ }
});
input.on('close', () => { void (async () => { await runtime?.session.abort(); await runtime?.dispose(); })().finally(() => process.exit()); });
