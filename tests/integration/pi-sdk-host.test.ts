// @vitest-environment node
import { assertDefined } from "../assert-defined";
import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PI_SDK_VERSION, PI_SDK_VERSIONS } from "@/lib/agents/pi-version";
import {
  AgentSecretObfuscator,
  restoreModelResponse,
} from "@/lib/agents/secret-obfuscation";
import {
  buildPiMcpConfig,
  nativePiMcpToolName,
  parsePiStreamLine,
  piMcpExtensionSource,
} from "@/lib/agents/sandbox-runtime";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  startTaskOutput,
  publishTaskText,
  publishTaskActivity,
  publishTaskStage,
  finishTaskOutput,
  taskOutput,
} from "@/lib/agents/execution/live-output";
import { executionOutputResponse } from "@/lib/agents/execution/live-output-stream";

const RESULT_FILE_BYTES = 10 * 1024 * 1024;
const TaskSourceSchema = z.object({
  subagentId: z.string(),
  subagentName: z.string(),
  parentToolCallId: z.string(),
  depth: z.number(),
});
type SdkState = {
  sessionId: string;
  sessionFile: string;
  sessionPersisted: boolean;
};
type SdkResponse = {
  type: string;
  id: string;
  success: boolean;
  result?: {
    text: string;
    commands: Array<{ name: string }>;
    commandResult?: { command: string; text: string; status: string };
    sessionEntries?: {
      userEntryId: string;
      userParentEntryId: string | null;
      leafEntryId: string;
    };
    fork?: {
      forked: boolean;
      entryId: string;
      contextOnly: boolean;
      filesRewound: boolean;
      externalEffectsRewound: boolean;
    };
    state: SdkState;
    disposition?: "queued" | "handled" | "cleared";
    queue?: {
      messages: Array<{ id: string; mode: string; text: string }>;
      pendingMessageCount: number;
    };
    actualModel?: { providerId: string; model: string };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      actualModel?: { providerId: string; model: string };
      modelUsage?: Array<{
        providerId: string;
        model: string;
        inputTokens: number;
      }>;
    };
  };
  error?: { code: string };
};
type RequestContext = {
  runtimeToken: string;
  uiUrl?: string;
  toolApprovalBridge?: boolean;
  mcpConfig: { servers: unknown[] };
  model: Record<string, unknown>;
  reasoningEffort?: string;
  modelRetries?: number;
  fallbackModels?: Array<Record<string, unknown>>;
  roleModels?: { compaction?: Record<string, unknown> };
};
const children = new Set<ChildProcess>();
const cleanups: Array<() => Promise<void>> = [];
function completion(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string,
  promptTokens = 20,
) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", ...delta },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 5,
        total_tokens: promptTokens + 5,
      },
    },
  ])
    response.write(
      `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled", ...chunk })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}
// A gateway that already answered 200 reports an upstream that produced nothing
// as an in-stream error (observed from sub2api as `empty_stream`).
function emptyStream(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ error: { message: "empty_stream", type: "upstream_error" } })}\n\n`,
  );
}
async function setup(workspaceSubdirectory = "") {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace", workspaceSubdirectory),
    agentDir = join(root, "private"),
    sessionsDir = join(root, "sessions");
  // Mirror the Agent-wide HOME contract without reading or writing the runner's home.
  const home = join(root, "home");
  const requestEvents = new EventEmitter();
  await Promise.all(
    [workspace, agentDir, sessionsDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const requests: Array<{
    authorization?: string;
    path?: string;
    body: {
      model: string;
      messages: Array<{ role: string; content?: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    };
  }> = [];
  const behavior = {
    tool: "increment",
    pause: false,
    pauseUi: false,
    cancelUi: false,
    failUiPoll: false,
    failTodoProjection: false,
    todoQuota: false,
    approvalStatus: "allowed",
    approvalExpired: false,
    toolArgs: "{}",
    completionText: "SDK_COMPLETE",
    promptTokens: 20,
    mcpTool: "current_mcp",
    streamCompletion: undefined as
      | ((response: ServerResponse) => Promise<void>)
      | undefined,
    mcpSchema: { type: "object", properties: {} } as Record<string, unknown>,
    secretObfuscator: undefined as AgentSecretObfuscator | undefined,
    modelResponse: undefined as
      | undefined
      | ((
          body: (typeof requests)[number]["body"],
          response: ServerResponse,
        ) => void),
  };
  const mcpRequests: Array<{
    authorization?: string;
    path?: string;
    method: string;
    params?: unknown;
  }> = [];
  const uiCalls: Array<{
    authorization?: string;
    path?: string;
    action: string;
    id?: string;
    request?: { id: string; method: string; [key: string]: unknown };
    todos?: Array<{ id: number; text: string; done: boolean }>;
  }> = [];
  const dialogs = new Map<string, string>();
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      if (
        /^\/api\/v1\/agent-runtime\/tasks\/[^/]+\/tool-approvals$/.test(
          request.url ?? "",
        )
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: behavior.approvalStatus,
            allowed:
              body.action === "consume" &&
              behavior.approvalStatus === "allowed",
            expiresAt: new Date(
              Date.now() + (behavior.approvalExpired ? -1 : 120_000),
            ).toISOString(),
          }),
        );
        return;
      }
      if (
        /^\/api\/v1\/agent-runtime\/tasks\/[^/]+\/ui$/.test(request.url ?? "")
      ) {
        uiCalls.push({
          ...body,
          path: request.url,
          authorization: request.headers.authorization,
        });
        if (
          body.action === "todos" &&
          body.todos.length &&
          behavior.todoQuota
        ) {
          response.writeHead(413, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (
          body.action === "todos" &&
          body.todos.length &&
          behavior.failTodoProjection
        ) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (body.action === "request") {
          dialogs.set(body.request.id, body.request.method);
          requestEvents.emit("ui-request");
        }
        if (body.action === "poll" && behavior.failUiPoll) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        const id = body.request?.id ?? body.id;
        const method = dialogs.get(id);
        const nativeResponse =
          body.action === "request" || body.action === "poll"
            ? !behavior.pauseUi &&
              ["select", "confirm", "input", "editor"].includes(method ?? "")
              ? {
                  type: "extension_ui_response",
                  id,
                  ...(behavior.cancelUi
                    ? { cancelled: true }
                    : method === "confirm"
                      ? { confirmed: true }
                      : { value: `${method}-answer` }),
                }
              : undefined
            : undefined;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ response: nativeResponse }));
        return;
      }
      if (request.url === "/mcp" || request.url === "/mcp-next") {
        mcpRequests.push({
          authorization: request.headers.authorization,
          path: request.url,
          method: body.method,
          params: body.params,
        });
        const mcp = new Server(
          { name: "sdk-regression", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: behavior.mcpTool,
              description: "Real fixture MCP tool",
              inputSchema: behavior.mcpSchema as { type: "object" },
            },
          ],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: "text", text: "CURRENT_MCP_OK" }],
          structuredContent: {
            calls: mcpRequests.filter((entry) => entry.method === "tools/call")
              .length,
          },
        }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await mcp.connect(transport);
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers))
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          const result = await transport.handleRequest(
            new Request(`http://localhost${request.url}`, {
              method: "POST",
              headers,
              body: raw,
            }),
            { parsedBody: body },
          );
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(await result.text());
        } finally {
          await mcp.close();
        }
        return;
      }
      if (
        request.url === "/secret-gateway/v1/chat/completions" &&
        behavior.secretObfuscator
      ) {
        const upstream = await fetch(
          `http://${request.headers.host}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              behavior.secretObfuscator.redactRequest(body, "openai"),
            ),
          },
        );
        const restored = restoreModelResponse(
          upstream,
          behavior.secretObfuscator,
        );
        response.writeHead(
          restored.status,
          Object.fromEntries(restored.headers),
        );
        const reader = assertDefined(restored.body).getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            response.write(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        response.end();
        return;
      }
      requests.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      });
      requestEvents.emit("request");
      if (behavior.modelResponse) {
        behavior.modelResponse(body, response);
        return;
      }
      if (behavior.pause) return;
      if (behavior.streamCompletion) {
        await behavior.streamCompletion(response);
        return;
      }
      if (behavior.tool && body.messages.at(-1)?.role !== "tool") {
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "count-call",
                type: "function",
                function: { name: behavior.tool, arguments: behavior.toolArgs },
              },
            ],
          },
          "tool_calls",
        );
      } else
        completion(
          response,
          { content: behavior.completionText },
          "stop",
          behavior.promptTokens,
        );
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  const extension = join(workspace, "extension.ts"),
    collision = join(workspace, "collision.mjs"),
    factory = join(agentDir, "mcp.mjs");
  await writeFile(
    join(workspace, "SKILL.md"),
    "---\nname: dynamic-skill\ndescription: Dynamic skill\n---\nUse the counter.\n",
  );
  await writeFile(
    join(workspace, "DynamicPrompt.md"),
    "---\ndescription: Dynamic prompt\n---\nSay prompt answer.\n",
  );
  await writeFile(
    extension,
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
  let count: number = 0;
  pi.on('session_start', (_,ctx) => { if(!ctx.hasUI || ctx.mode!=='rpc')throw new Error('NATIVE_RPC_UI_REQUIRED');for (const entry of ctx.sessionManager.getBranch()) if(entry.type==='custom' && entry.customType==='count') count=entry.data; });
  pi.on('resources_discover', () => ({ skillPaths: [${JSON.stringify(join(workspace, "SKILL.md"))}], promptPaths: [${JSON.stringify(join(workspace, "DynamicPrompt.md"))}] }));
  pi.on('input', e => e.text==='handled' ? { action:'handled' } : undefined);
  pi.registerTool({name:'increment',label:'Counter',description:'Increment counter',parameters:{type:'object',properties:{}},async execute(_,args,signal,update,ctx){count++;pi.appendEntry('count',count);writeFileSync(join(ctx.cwd,'count.txt'),String(count));return {content:[{type:'text',text:String(count)}],details:{count}};}});
  pi.registerTool({name:'fail_tool',label:'Fail',description:'Fail tool',parameters:{type:'object',properties:{}},async execute(){throw new Error('private-tool-secret');}});
  pi.registerCommand('CaseCmd',{description:'Case command',handler:async()=>{console.log('UNTRUSTED_STDOUT');pi.sendMessage({customType:'counter',content:'count='+count,display:true});}});
  pi.registerCommand('Silent',{handler:async()=>{pi.sendMessage({customType:'hidden',content:'HIDDEN_CONTEXT_ONLY',display:false});}});
  pi.registerCommand('Replace',{handler:async(args,ctx)=>{await ctx.newSession();}});
  pi.registerCommand('Fork',{handler:async(args,ctx)=>{const entry=ctx.sessionManager.getBranch().find(e=>e.type==='message'&&e.message.role==='user');await ctx.fork(entry.id);}});
  pi.registerCommand('Switch',{handler:async(args,ctx)=>{await ctx.switchSession(args);}});
  pi.registerCommand('Reload',{handler:async(args,ctx)=>{await ctx.reload();}});
  pi.registerCommand('Tree',{handler:async(args,ctx)=>{await ctx.navigateTree(args);}});
  pi.registerCommand('Dialogs',{handler:async(args,ctx)=>{
    const results=[await ctx.ui.select('Select one',['first','second']),await ctx.ui.confirm('Confirm action','Native extension decision'),await ctx.ui.input('Input text','placeholder'),await ctx.ui.editor('Edit text','prefill')];
    pi.sendMessage({customType:'dialogs',content:JSON.stringify(results),display:true});
    ctx.ui.notify('Native notification','warning');ctx.ui.setStatus('native','ready');ctx.ui.setWidget('native',['line'],{placement:'belowEditor'});ctx.ui.setTitle('Native title');ctx.ui.setEditorText('draft');ctx.ui.setStatus('native',undefined);ctx.ui.setWidget('native',undefined);
  }});
  // This real child-process integration exercises native SDK timeout delivery;
  // fake timers in the test runner cannot advance the separately spawned host.
  pi.registerCommand('Timeout',{handler:async(args,ctx)=>{const result=await ctx.ui.confirm('Timeout','expires',{timeout:30});pi.sendMessage({customType:'timeout',content:String(result),display:true});}});
  pi.registerCommand('Signal',{handler:async(args,ctx)=>{const c=new AbortController();queueMicrotask(()=>c.abort());const result=await ctx.ui.input('Signal','cancel',{signal:c.signal});pi.sendMessage({customType:'signal',content:String(result),display:true});}});
  pi.registerCommand('AlreadyAborted',{handler:async(args,ctx)=>{const c=new AbortController();c.abort();const result=await ctx.ui.select('Never shown',[],{signal:c.signal});pi.sendMessage({customType:'signal',content:String(result),display:true});}});
}`,
  );
  await writeFile(
    collision,
    `export default pi=>{pi.registerCommand('CaseCmd',{handler:async()=>{pi.sendMessage({customType:'collision',content:'SECOND_COMMAND',display:true});}});};`,
  );
  await writeFile(factory, piMcpExtensionSource({ eventFd: 3 }));
  const config = {
    sdkVersion: PI_SDK_VERSION,
    compatibleSdkVersions: PI_SDK_VERSIONS,
    packageRoot: resolve("."),
    cwd: workspace,
    workspaceRoot: root,
    sharedDir: join(root, "agent-shared"),
    agentDir,
    sessionsDir,
    statePath: join(agentDir, "state.json"),
    packageSetChecksum: "empty-reviewed-set",
    agentRevisionId: "revision-one",
    model: {
      id: "controlled",
      name: "Controlled",
      api: "openai-completions",
      provider: "toolplane",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    systemPrompt: "Use the requested tool.",
    defaultTools: [],
    resources: {
      extensions: [extension],
      skills: [],
      prompts: [],
      themes: [],
    },
    packages: [],
    packageVerifierPath: resolve("scripts/pi-sdk-package-files.mjs"),
    mcpFactoryPath: factory,
    hostOnlyCommands: ["login", "logout"],
    historyRequired: false,
  };
  const context = {
    runtimeToken: "test-runtime-first",
    uiUrl: `http://127.0.0.1:${address.port}/api/v1/agent-runtime/tasks/fixture-task/ui`,
    mcpConfig: { servers: [] },
    model: config.model,
  } satisfies RequestContext;
  async function launch(
    overrides = {},
    onEvent?: (event: Record<string, unknown>) => void,
  ) {
    const configPath = join(agentDir, `config-${randomUUID()}.json`);
    await writeFile(configPath, JSON.stringify({ ...config, ...overrides }));
    const child = spawn(
      process.execPath,
      [resolve("scripts/pi-sdk-session.mjs"), configPath],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          NODE_CHANNEL_FD: undefined,
          NODE_CHANNEL_SERIALIZATION_MODE: undefined,
        },
      },
    );
    children.add(child);
    let stdout = "",
      stderr = "";
    assertDefined(child.stdout).on("data", (chunk) => {
      stdout += chunk;
    });
    assertDefined(child.stderr).on("data", (chunk) => {
      stderr += chunk;
    });
    const events: Array<Record<string, unknown>> = [],
      pending = new Map<
        string,
        { resolve: (r: SdkResponse) => void; reject: (e: Error) => void }
      >();
    const stream = child.stdio[3];
    if (!(stream instanceof Readable)) throw new Error("Missing event fd");
    createInterface({ input: stream }).on("line", (line) => {
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event);
      if (event.type === "toolplane_sdk_response") {
        pending.get(event.id)?.resolve(event);
        pending.delete(event.id);
      }
    });
    child.on("close", () => {
      children.delete(child);
      for (const entry of pending.values())
        entry.reject(new Error(`Host exited: ${stderr}`));
      pending.clear();
    });
    function request(
      type: string,
      message?: string,
      current: RequestContext = context,
      extra: Record<string, unknown> = {},
    ) {
      const id = randomUUID();
      const {
        promise: result,
        resolve,
        reject,
      } = Promise.withResolvers<SdkResponse>();
      pending.set(id, { resolve, reject });
      assertDefined(child.stdin).write(
        `${JSON.stringify({ id, type, message, context: current, ...extra })}\n`,
      );
      return result;
    }
    async function stop() {
      const closed = once(child, "close");
      assertDefined(child.stdin).end();
      await closed;
    }
    return { child, request, stop, events, output: () => ({ stdout, stderr }) };
  }
  return {
    root,
    workspace,
    config,
    context,
    requests,
    requestEvents,
    mcpRequests,
    uiCalls,
    behavior,
    launch,
    extension,
    collision,
  };
}
afterEach(async () => {
  for (const child of children) {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  children.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
describe("official Pi SDK headless session host", () => {
  it.each([true, false, undefined])(
    "loads only bounded project instruction files when contextFiles=%s",
    async (contextFiles) => {
      const f = await setup("project");
      const project = f.workspace;
      const workspaceRoot = join(f.root, "workspace");
      const otherSession = join(f.root, "other-session");
      await mkdir(otherSession);
      await Promise.all([
        writeFile(join(project, "AGENTS.md"), "SESSION_INSTRUCTION_MARKER"),
        writeFile(
          join(workspaceRoot, "CLAUDE.md"),
          "WORKSPACE_INSTRUCTION_MARKER",
        ),
        writeFile(
          join(f.config.agentDir, "AGENTS.md"),
          "AGENT_INSTRUCTION_MARKER",
        ),
        writeFile(join(f.root, "AGENTS.md"), "OUTSIDE_ROOT_INSTRUCTION_MARKER"),
        writeFile(
          join(otherSession, "AGENTS.md"),
          "OTHER_SESSION_PRIVATE_MARKER",
        ),
      ]);
      await symlink(
        join(otherSession, "AGENTS.md"),
        join(project, "AGENTS.override.md"),
      );
      const host = await f.launch({
        contextFiles,
        cwd: project,
        workspaceRoot,
      });
      const response = await host.request("prompt", "Use increment");
      expect(response.success).toBe(true);
      const systemMessages = JSON.stringify(
        f.requests[0]?.body.messages.filter(
          (message) => message.role === "system",
        ),
      );
      for (const marker of [
        "SESSION_INSTRUCTION_MARKER",
        "WORKSPACE_INSTRUCTION_MARKER",
        "AGENT_INSTRUCTION_MARKER",
      ]) {
        if (contextFiles === true) expect(systemMessages).toContain(marker);
        else expect(systemMessages).not.toContain(marker);
      }
      expect(systemMessages).not.toContain("OUTSIDE_ROOT_INSTRUCTION_MARKER");
      expect(systemMessages).not.toContain("OTHER_SESSION_PRIVATE_MARKER");
      await host.stop();
    },
    60000,
  );
  it("blocks native bash side effects while succeeding and persisting the rule event", async () => {
    const f = await setup();
    f.behavior.tool = "bash";
    f.behavior.toolArgs = JSON.stringify({
      command: "printf forbidden > blocked.txt",
    });
    const host = await f.launch({
      defaultTools: ["bash"],
      streamRules: [
        {
          id: "no-write",
          name: "No shell writes",
          target: "tool_call",
          toolName: "bash",
          pattern: "blocked\\.txt",
          action: "block",
          message: "Do not write blocked.txt.",
        },
      ],
    });
    for (let turn = 0; turn < 2; turn++) {
      const result = await host.request("prompt", "Run the shell command");
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.result?.text).toContain("SDK_COMPLETE");
      await expect(
        readFile(join(f.workspace, "blocked.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    const triggers = host.events.filter(
      (event) => event.type === "stream_rule_triggered",
    );
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({
      trigger: {
        ruleId: "no-write",
        target: "tool_call",
        action: "block",
        toolName: "bash",
        toolCallId: "count-call",
      },
    });
    const failedTools = host.events.filter(
      (event) => event.type === "tool_execution_end" && event.isError,
    );
    expect(failedTools).toHaveLength(2);
    expect(JSON.stringify(failedTools)).toContain("Do not write blocked.txt.");
    const saved = JSON.parse(await readFile(f.config.statePath, "utf8"));
    expect(saved.sessionPersisted).toBe(true);
    expect(await readFile(saved.sessionFile, "utf8")).toContain(
      "toolplane.stream-rule",
    );
  }, 60000);

  it("matches text across stream chunks and injects one reminder per rule per prompt", async () => {
    const f = await setup();
    let requests = 0;
    f.behavior.tool = "";
    const textEvents = new EventEmitter();
    f.behavior.streamCompletion = async (response) => {
      if (requests++ > 0) {
        completion(response, { content: "Corrected response" }, "stop");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [index, content] of [
        "CROSS_",
        "CHUNK",
        " CROSS_CHUNK",
      ].entries()) {
        const received = once(textEvents, "delta");
        response.write(
          `data: ${JSON.stringify({ id: "rules", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: { ...(index === 0 ? { role: "assistant" } : {}), content }, finish_reason: null }] })}\n\n`,
        );
        await received;
      }
      response.end(
        `data: ${JSON.stringify({ id: "rules", object: "chat.completion.chunk", created: 1, model: "controlled", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const host = await f.launch(
      {
        streamRules: [
          {
            id: "text-reminder",
            name: "Text reminder",
            target: "assistant_text",
            pattern: "CROSS_CHUNK",
            action: "remind",
            message: "Replace the flagged phrase.",
          },
        ],
      },
      (event) => {
        const update = event.assistantMessageEvent;
        if (
          event.type === "message_update" &&
          update &&
          typeof update === "object" &&
          "type" in update &&
          update.type === "text_delta"
        )
          textEvents.emit("delta");
      },
    );
    const result = await host.request("prompt", "Answer now");
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      host.events.filter((event) => event.type === "stream_rule_triggered"),
    ).toHaveLength(1);
    expect(f.requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(
      "Replace the flagged phrase.",
    );
  }, 60000);

  it("allows a matching tool reminder and delivers its message to the model", async () => {
    const f = await setup();
    const host = await f.launch({
      streamRules: [
        {
          id: "counter-reminder",
          name: "Counter reminder",
          target: "tool_call",
          toolName: "increment",
          pattern: "^\\{",
          action: "remind",
          message: "Report the actual counter value.",
        },
      ],
    });
    const result = await host.request("prompt", "Increment the counter");
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      Number(await readFile(join(f.workspace, "count.txt"), "utf8")),
    ).toBeGreaterThan(0);
    expect(
      host.events.filter((event) => event.type === "stream_rule_triggered"),
    ).toHaveLength(1);
    expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(
      "Report the actual counter value.",
    );
  }, 60000);
  it("navigates before an edited user turn without summarizing discarded context or rewinding files", async () => {
    const f = await setup();
    const host = await f.launch();
    f.behavior.completionText = "KEPT_ASSISTANT";
    const kept = await host.request("prompt", "KEPT_USER");
    expect(kept.success).toBe(true);
    f.behavior.completionText = "DISCARDED_ASSISTANT";
    const discarded = await host.request("prompt", "DISCARDED_USER");
    const target = assertDefined(
      assertDefined(discarded.result).sessionEntries,
    );
    expect(target.userEntryId).not.toBe(
      assertDefined(assertDefined(kept.result).sessionEntries).userEntryId,
    );
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("2");
    f.behavior.tool = "";
    f.behavior.completionText = "EDITED_ASSISTANT";
    const edited = await host.request("prompt", "EDITED_USER", f.context, {
      navigateBeforeEntryId: target.userEntryId,
    });
    expect(edited.success).toBe(true);
    const context = JSON.stringify(f.requests.at(-1)?.body);
    expect(context).toContain("KEPT_USER");
    expect(context).toContain("KEPT_ASSISTANT");
    expect(context).toContain("EDITED_USER");
    expect(context).not.toContain("DISCARDED_USER");
    expect(context).not.toContain("DISCARDED_ASSISTANT");
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("2");
    const persisted = await readFile(
      assertDefined(edited.result).state.sessionFile,
      "utf8",
    );
    expect(persisted).toContain("DISCARDED_USER");
    const retryTarget = assertDefined(
      assertDefined(edited.result).sessionEntries,
    ).userEntryId;
    const retried = await host.request("prompt", "EDITED_USER", f.context, {
      navigateBeforeEntryId: retryTarget,
    });
    expect(retried.success).toBe(true);
    expect(
      f.requests
        .at(-1)
        ?.body.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    const before = f.requests.length;
    expect(
      await host.request("prompt", "never sent", f.context, {
        navigateBeforeEntryId: "missing-entry",
      }),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_ENTRY_NOT_FOUND" },
    });
    expect(f.requests).toHaveLength(before);
  }, 60_000);

  it("forks a user-only native tree durably into a separate session and continues only that prefix", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch();
    const first = await host.request("prompt", "BRANCH_PREFIX");
    await host.request("prompt", "EXCLUDED_BRANCH_SUFFIX");
    const sourceFile = assertDefined(first.result).state.sessionFile;
    const sourceBefore = await readFile(sourceFile, "utf8");
    const targetRoot = `${f.root}-fork`;
    cleanups.push(() => rm(targetRoot, { recursive: true, force: true }));
    const target = {
      workspaceRoot: targetRoot,
      cwd: join(targetRoot, "workspace"),
      sessionsDir: join(targetRoot, "sessions"),
      statePath: join(targetRoot, "private", "state.json"),
    };
    await mkdir(join(targetRoot, "private"), { recursive: true });
    const fork = await host.request("fork", undefined, f.context, {
      entryId: assertDefined(assertDefined(first.result).sessionEntries)
        .userEntryId,
      target,
    });
    expect(fork).toMatchObject({
      success: true,
      result: {
        fork: {
          forked: true,
          contextOnly: true,
          filesRewound: false,
          externalEffectsRewound: false,
        },
      },
    });
    expect(await readFile(sourceFile, "utf8")).toBe(sourceBefore);
    const state = JSON.parse(await readFile(target.statePath, "utf8"));
    expect(state).toMatchObject({
      sessionPersisted: true,
      agentRevisionId: "revision-one",
    });
    const branchFile = await readFile(state.sessionFile, "utf8");
    expect(branchFile).toContain("BRANCH_PREFIX");
    expect(branchFile).not.toContain("EXCLUDED_BRANCH_SUFFIX");
    const branch = await f.launch({
      ...target,
      agentDir: join(targetRoot, "private"),
      historyRequired: true,
      resources: { extensions: [], skills: [], prompts: [], themes: [] },
    });
    expect(
      (await branch.request("prompt", "BRANCH_CONTINUATION")).success,
    ).toBe(true);
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain("BRANCH_PREFIX");
    expect(JSON.stringify(f.requests.at(-1)?.body)).not.toContain(
      "EXCLUDED_BRANCH_SUFFIX",
    );
  }, 60_000);

  it("injects steering only after the running native tool and changes the next model request", async () => {
    const f = await setup();
    const toolStarted = Promise.withResolvers<void>();
    f.behavior.streamCompletion = async (response) => {
      if (f.requests.length === 1) {
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "steer-tool",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command:
                      "while [ ! -f release-tool ]; do sleep 0.01; done; printf TOOL_FINISHED",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        const steered = JSON.stringify(
          f.requests.at(-1)?.body.messages,
        ).includes("STEER_NEW_DIRECTION");
        completion(
          response,
          { content: steered ? "STEER_APPLIED" : "OLD_DIRECTION" },
          "stop",
        );
      }
    };
    const host = await f.launch({ defaultTools: ["bash"] }, (event) => {
      if (event.type === "tool_execution_start") toolStarted.resolve();
    });
    const run = host.request("prompt", "Run the waiting tool, then answer");
    await toolStarted.promise;
    const queued = await host.request("steer", "STEER_NEW_DIRECTION");
    expect(queued).toMatchObject({
      success: true,
      result: {
        disposition: "queued",
        queue: {
          pendingMessageCount: 1,
          messages: [{ mode: "steer", text: "STEER_NEW_DIRECTION" }],
        },
      },
    });
    expect(
      host.events.some((event) => event.type === "queued_message_consumed"),
    ).toBe(false);
    await writeFile(join(f.workspace, "release-tool"), "release");
    const result = await run;
    expect(result).toMatchObject({
      success: true,
      result: { text: "STEER_APPLIED" },
    });
    const toolEnd = host.events.findIndex(
      (event) => event.type === "tool_execution_end",
    );
    const consumed = host.events.findIndex(
      (event) => event.type === "queued_message_consumed",
    );
    expect(consumed).toBeGreaterThan(toolEnd);
    expect(host.events[consumed]).toMatchObject({
      message: { mode: "steer", text: "STEER_NEW_DIRECTION" },
    });
    expect(f.requests).toHaveLength(2);
    expect(host.events).toContainEqual({
      type: "message_queue",
      queue: { messages: [], pendingMessageCount: 0 },
    });
    await host.stop();
  }, 60_000);

  it("runs follow-up after the assistant finishes and records actual consumption, not acceptance", async () => {
    const f = await setup();
    const firstRequest = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.behavior.streamCompletion = async (response) => {
      if (f.requests.length === 1) {
        firstRequest.resolve();
        await release.promise;
        completion(response, { content: "FIRST_TURN_FINISHED" }, "stop");
      } else {
        const followed = JSON.stringify(
          f.requests.at(-1)?.body.messages,
        ).includes("FOLLOW_UP_NOW");
        completion(
          response,
          { content: followed ? "FOLLOW_UP_EXECUTED" : "MISSING_FOLLOW_UP" },
          "stop",
        );
      }
    };
    const host = await f.launch();
    expect(await host.request("steer", "idle")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_QUEUE_NOT_RUNNING" },
    });
    const run = host.request("prompt", "Answer the first turn");
    await firstRequest.promise;
    expect(
      await host.request("steer", "DISCARD_BEFORE_DELIVERY"),
    ).toMatchObject({ success: true });
    expect(await host.request("clear_queue")).toMatchObject({
      success: true,
      result: {
        disposition: "cleared",
        queue: { pendingMessageCount: 0, messages: [] },
      },
    });
    const identity = {
      messageId: "durable-follow-up",
      deduplicate: true as const,
    };
    expect(
      await host.request("follow_up", "FOLLOW_UP_NOW", f.context, identity),
    ).toMatchObject({
      success: true,
      result: { disposition: "queued", queue: { pendingMessageCount: 1 } },
    });
    expect(
      await host.request("follow_up", "FOLLOW_UP_NOW", f.context, identity),
    ).toMatchObject({
      success: true,
      result: { disposition: "queued", queue: { pendingMessageCount: 1 } },
    });
    expect(
      host.events.some((event) => event.type === "queued_message_consumed"),
    ).toBe(false);
    release.resolve();
    const result = await run;
    expect(result).toMatchObject({
      success: true,
      result: { text: "FOLLOW_UP_EXECUTED" },
    });
    expect(f.requests).toHaveLength(2);
    expect(
      host.events.filter((event) => event.type === "queued_message_consumed"),
    ).toEqual([
      expect.objectContaining({
        assistantText: "FIRST_TURN_FINISHED",
        message: expect.objectContaining({
          mode: "follow_up",
          text: "FOLLOW_UP_NOW",
        }),
      }),
    ]);
    const transcript = await readFile(
      assertDefined(result.result).state.sessionFile,
      "utf8",
    );
    expect(transcript.indexOf("FIRST_TURN_FINISHED")).toBeLessThan(
      transcript.indexOf("FOLLOW_UP_NOW"),
    );
    expect(transcript.indexOf("FOLLOW_UP_NOW")).toBeLessThan(
      transcript.indexOf("FOLLOW_UP_EXECUTED"),
    );
    await host.stop();
  }, 60_000);
  it("hides registered credentials from the provider while native bash receives real restored arguments", async () => {
    const f = await setup();
    const value = "fixture-registered-environment-secret";
    f.behavior.secretObfuscator = new AgentSecretObfuscator({
      SERVICE_TOKEN: value,
    });
    const placeholder = f.behavior.secretObfuscator.redact(value);
    f.behavior.tool = "bash";
    f.behavior.toolArgs = JSON.stringify({
      command: `printf '%s' '${placeholder}' | tee secret-result.txt`,
    });
    f.behavior.completionText = `Used ${placeholder}`;
    const model = {
      ...f.config.model,
      baseUrl: f.config.model.baseUrl.replace("/v1", "/secret-gateway/v1"),
    };
    const host = await f.launch({ defaultTools: ["bash"], model });
    const result = await host.request(
      "prompt",
      `Use the requested tool with ${value}`,
      { ...f.context, model },
    );
    expect(result.success).toBe(true);
    expect(await readFile(join(f.workspace, "secret-result.txt"), "utf8")).toBe(
      value,
    );
    expect(f.requests.length).toBeGreaterThanOrEqual(2);
    // Includes the user's first prompt, restored assistant tool replay, and bash
    // stdout in the second request. None may expose plaintext to the provider.
    for (const request of f.requests) {
      expect(JSON.stringify(request.body)).not.toContain(value);
      expect(JSON.stringify(request.body)).toContain(placeholder);
    }
    await host.stop();
  }, 60000);
  it("runs two independent child SDK sessions concurrently with inherited authority and source-scoped results", async () => {
    const f = await setup();
    const waiting: ServerResponse[] = [];
    f.behavior.modelResponse = (body, response) => {
      const hasTask = body.tools?.some((tool) => tool.function.name === "task");
      if (hasTask) {
        if (body.messages.at(-1)?.role === "tool")
          completion(response, { content: "TASK_PARENT_COMPLETE" }, "stop");
        else
          completion(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "task-batch",
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      context: "SHARED_BACKGROUND",
                      tasks: [
                        {
                          id: "alpha",
                          description: "Alpha",
                          prompt: "CHILD_ALPHA",
                        },
                        {
                          id: "beta",
                          description: "Beta",
                          prompt: "CHILD_BETA",
                        },
                      ],
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          );
        return;
      }
      // Pi extension tools are additive to defaultTools; inherit the actual parent loadout.
      const parentTools = assertDefined(f.requests[0]?.body.tools)
        .map((tool) => tool.function.name)
        .filter((name) => name !== "task")
        .sort();
      expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual(
        parentTools,
      );
      expect(JSON.stringify(body.messages)).toContain("SHARED_BACKGROUND");
      if (body.messages.at(-1)?.role === "tool") {
        completion(response, { content: "CHILD_RESULT_1" }, "stop");
        return;
      }
      waiting.push(response);
      // A serial implementation never reaches this barrier and cannot complete.
      if (waiting.length === 2)
        waiting.forEach((child) => {
          completion(
            child,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "increment-child",
                  type: "function",
                  function: { name: "increment", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
        });
    };
    const host = await f.launch({
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/task.mjs"),
      ],
      defaultTools: ["task", "increment"],
      nativeSubagentPolicy: { maxConcurrency: 2, maxDepth: 1 },
    });
    const result = await host.request("prompt", "Dispatch the children");
    expect(result).toMatchObject({
      success: true,
      result: {
        text: "TASK_PARENT_COMPLETE",
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    });
    const taskEnd = host.events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolCallId === "task-batch",
    );
    expect(taskEnd).toMatchObject({
      isError: false,
      result: {
        details: {
          status: "completed",
          results: [
            {
              id: "alpha",
              status: "completed",
              text: expect.stringMatching(/^CHILD_RESULT_[01]$/),
            },
            {
              id: "beta",
              status: "completed",
              text: expect.stringMatching(/^CHILD_RESULT_[01]$/),
            },
          ],
        },
      },
    });
    const childEvents = host.events.filter((event) => event.source);
    const sources = childEvents.map((event) =>
      TaskSourceSchema.parse(event.source),
    );
    expect(new Set(sources.map((source) => source.subagentId)).size).toBe(2);
    const increments = childEvents.filter(
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "increment",
    );
    expect(increments).toHaveLength(2);
    for (const event of increments)
      expect(event.result).toMatchObject({ details: { count: 1 } });
    const liveId = randomUUID();
    startTaskOutput(liveId);
    for (const event of childEvents)
      expect(event.source).toMatchObject({
        parentToolCallId: "task-batch",
        depth: 1,
      });
    for (const event of childEvents) {
      const parsed = parsePiStreamLine(JSON.stringify(event));
      expect(parsed?.delta).toBeUndefined();
      for (const activity of parsed?.activities ?? [])
        expect(activity.source).toMatchObject(
          TaskSourceSchema.parse(event.source),
        );
      for (const activity of parsed?.activities ?? [])
        publishTaskActivity(liveId, activity);
    }
    const liveTools = assertDefined(taskOutput(liveId)).activities.filter(
      (activity) => activity.toolName === "increment",
    );
    expect(liveTools).toHaveLength(2);
    expect(liveTools.every((activity) => activity.status === "completed")).toBe(
      true,
    );
    finishTaskOutput(liveId, "completed");
    const childDirs = await readdir(join(f.workspace, ".toolplane-subagents"));
    expect(childDirs).toHaveLength(2);
    for (const directory of childDirs) {
      const files = await readdir(
        join(f.workspace, ".toolplane-subagents", directory),
      );
      const transcript = await readFile(
        join(
          f.workspace,
          ".toolplane-subagents",
          directory,
          assertDefined(files.find((file) => file.endsWith(".jsonl"))),
        ),
        "utf8",
      );
      expect(JSON.parse(transcript.split("\n")[0]).cwd).toBe(f.workspace);
    }
    expect(
      f.requests.every(
        (request) => request.authorization === "Bearer test-runtime-first",
      ),
    ).toBe(true);
    await host.stop();
  }, 60000);

  it.each([false, true])(
    "isolates a failed child and cascades parent abort (abort=%s)",
    async (abort) => {
      const f = await setup();
      const ready = Promise.withResolvers<void>();
      let childRequests = 0;
      f.behavior.modelResponse = (body, response) => {
        if (body.tools?.some((tool) => tool.function.name === "task")) {
          if (body.messages.at(-1)?.role === "tool") {
            completion(response, { content: "PARENT_RECOVERED" }, "stop");
            return;
          }
          completion(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "task-batch",
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      tasks: [
                        { id: "one", description: "One", prompt: "One child" },
                        { id: "two", description: "Two", prompt: "Two child" },
                      ],
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          );
        } else {
          childRequests++;
          if (childRequests === 2) ready.resolve();
          if (abort) return;
          if (childRequests === 1) {
            response.writeHead(503);
            response.end("private-provider-secret");
          } else completion(response, { content: "SURVIVING_CHILD" }, "stop");
        }
      };
      const host = await f.launch({
        optionalBuiltinExtensions: [
          resolve("scripts/pi-optional-tools/task.mjs"),
        ],
        defaultTools: ["task"],
        nativeSubagentPolicy: { maxConcurrency: 2, maxDepth: 1 },
      });
      const pending = host.request("prompt", "Dispatch children");
      await ready.promise;
      if (abort)
        expect(await host.request("abort")).toMatchObject({ success: true });
      const result = await pending;
      expect(result).toMatchObject(
        abort
          ? { success: false, error: { code: "PI_SDK_ABORTED" } }
          : { success: true, result: { text: "PARENT_RECOVERED" } },
      );
      const ended = host.events.filter(
        (event) => event.type === "tool_execution_end" && event.source,
      );
      expect(ended).toHaveLength(2);
      const statuses = ended.map(
        (event) => z.object({ status: z.string() }).parse(event.result).status,
      );
      expect(statuses.sort()).toEqual(
        abort ? ["cancelled", "cancelled"] : ["completed", "failed"],
      );
      if (!abort)
        expect(
          host.events.find(
            (event) =>
              event.type === "tool_execution_end" &&
              event.toolCallId === "task-batch",
          ),
        ).toMatchObject({
          isError: true,
          result: { details: { status: "partial_failure" } },
        });
      expect(JSON.stringify(host.events)).not.toContain(
        "private-provider-secret",
      );
      await host.stop();
    },
    60000,
  );
  it("keeps Python imports from changing skill files across continued native turns", async () => {
    const f = await setup();
    const skill = join(f.workspace, "python-skill");
    await mkdir(skill);
    await writeFile(join(skill, "gb_layout.py"), "VALUE = 42\n");
    f.behavior.tool = "bash";
    const code = `import sys; sys.path.insert(0, ${JSON.stringify(skill)}); import gb_layout; from pathlib import Path; Path("python-result.txt").write_text(str(gb_layout.VALUE))`;
    f.behavior.toolArgs = JSON.stringify({ command: `python3 -c '${code}'` });
    const first = await f.launch({ defaultTools: ["bash"] });
    expect(
      (await first.request("prompt", "Run the Python skill")).success,
    ).toBe(true);
    expect(await readFile(join(f.workspace, "python-result.txt"), "utf8")).toBe(
      "42",
    );
    expect(await readdir(skill)).toEqual(["gb_layout.py"]);
    await first.stop();
    const resumed = await f.launch({
      defaultTools: ["bash"],
      historyRequired: true,
    });
    expect(
      (await resumed.request("prompt", "Run the Python skill again")).success,
    ).toBe(true);
    expect(await readdir(skill)).toEqual(["gb_layout.py"]);
  }, 60000);

  it("continues copied native history after workspace rebasing without changing transcript bodies or revision pins", async () => {
    const f = await setup();
    const first = await f.launch();
    const initial = await first.request(
      "prompt",
      "Persist native counter history",
    );
    expect(initial.success).toBe(true);
    const initialState = assertDefined(initial.result).state;
    await first.stop();
    const transcript = await readFile(initialState.sessionFile, "utf8");
    const end = transcript.indexOf("\n");
    const header = JSON.parse(transcript.slice(0, end));
    const body = transcript.slice(end + 1);
    await writeFile(
      initialState.sessionFile,
      `${JSON.stringify({ ...header, cwd: "/workspace/workspace" })}\n${body}`,
    );
    const saved = JSON.parse(await readFile(f.config.statePath, "utf8"));
    await writeFile(
      f.config.statePath,
      JSON.stringify({
        ...saved,
        sessionFile: `/workspace/${relative(f.root, initialState.sessionFile)}`,
      }),
    );
    await writeFile(
      join(f.root, ".toolplane-shared-migration.json"),
      JSON.stringify({
        sourceSandboxId: "legacy-sandbox",
        legacyWorkspaceRoot: "/workspace",
      }),
    );
    const resumed = await f.launch({
      workspaceRoot: f.root,
      historyRequired: true,
    });
    const result = await resumed.request(
      "prompt",
      "Continue the same native counter",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(assertDefined(result.result).state.sessionId).toBe(
      initialState.sessionId,
    );
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("2");
    const continued = await readFile(initialState.sessionFile, "utf8");
    expect(continued.slice(continued.indexOf("\n") + 1)).toContain(body);
    expect(JSON.parse(continued.split("\n")[0]).cwd).toBe(f.workspace);
    expect(
      JSON.parse(await readFile(f.config.statePath, "utf8")),
    ).toMatchObject({
      sessionFile: initialState.sessionFile,
      agentRevisionId: f.config.agentRevisionId,
      packageSetChecksum: f.config.packageSetChecksum,
    });
  }, 60000);
  it("resumes legacy Pi 0.87.1 saved state on 1.5.2 and rewrites its SDK version", async () => {
    const f = await setup();
    const first = await f.launch();
    const initial = await first.request(
      "prompt",
      "Persist native counter history",
    );
    expect(initial.success).toBe(true);
    const original = assertDefined(initial.result).state;
    await first.stop();
    const transcript = await readFile(original.sessionFile, "utf8");
    const saved = JSON.parse(await readFile(f.config.statePath, "utf8"));
    await writeFile(
      f.config.statePath,
      JSON.stringify({ ...saved, sdkVersion: "0.87.1" }),
    );

    const resumed = await f.launch({ historyRequired: true });
    const result = await resumed.request(
      "prompt",
      "Continue the native counter",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(assertDefined(result.result).state.sessionId).toBe(
      original.sessionId,
    );
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("2");
    expect(await readFile(original.sessionFile, "utf8")).toContain(transcript);
    expect(
      JSON.parse(await readFile(f.config.statePath, "utf8")),
    ).toMatchObject({
      sdkVersion: PI_SDK_VERSION,
      sessionFile: original.sessionFile,
      sessionId: original.sessionId,
    });
  }, 60000);
  it("streams reasoning and successive text through the runtime parser before completion", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const allowText = Promise.withResolvers<void>();
    const allowCompletion = Promise.withResolvers<void>();
    f.behavior.streamCompletion = async (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        response.write(
          `data: ${JSON.stringify({
            id: "controlled",
            object: "chat.completion.chunk",
            created: 1,
            model: "controlled",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      chunk({ role: "assistant", reasoning_content: "Checking the request" });
      await allowText.promise;
      chunk({ content: "FIRST_PART" });
      await allowCompletion.promise;
      chunk({ content: "_SECOND_PART" });
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    };
    const host = await f.launch();
    const pending = host.request("prompt", "Stream the answer");
    const parsed = () =>
      host.events.map((event) => parsePiStreamLine(JSON.stringify(event)));
    const text = () =>
      parsed()
        .map((event) => event?.delta ?? "")
        .join("");
    try {
      await expect
        .poll(() => parsed().flatMap((event) => event?.activities ?? []), {
          timeout: 15_000,
        })
        .toContainEqual({
          type: "reasoning",
          status: "running",
          delta: "Checking the request",
        });
      expect(text()).toBe("");
      expect(
        host.events.some((event) => event.type === "toolplane_sdk_response"),
      ).toBe(false);
      allowText.resolve();
      await expect.poll(text, { timeout: 15_000 }).toBe("FIRST_PART");
      expect(
        host.events.some((event) => event.type === "toolplane_sdk_response"),
      ).toBe(false);
      allowCompletion.resolve();
      const result = await pending;
      expect(result.success).toBe(true);
      expect(assertDefined(result.result).text).toBe("FIRST_PART_SECOND_PART");
      expect(text()).toBe("FIRST_PART_SECOND_PART");
      expect(
        parsed().flatMap((event) => event?.activities ?? []),
      ).toContainEqual({
        type: "reasoning",
        status: "completed",
      });
    } finally {
      allowText.resolve();
      allowCompletion.resolve();
      await pending;
    }
  }, 60000);
  it("projects actual native bash execution, reasoning and text to SSE before the host finishes", async () => {
    const f = await setup();
    const id = randomUUID();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    f.behavior.streamCompletion = async (response) => {
      if (calls++ === 0) {
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "live-bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "sleep 1; printf 42 > live-result.txt",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        response.write(
          `data: ${JSON.stringify({
            id: "live",
            object: "chat.completion.chunk",
            created: 1,
            model: "controlled",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      emit({
        role: "assistant",
        reasoning_content: "Read the native tool result",
      });
      emit({ content: "FIRST_NATIVE_FRAGMENT" });
      await release.promise;
      emit({ content: "_FINAL" });
      emit({}, "stop");
      response.end("data: [DONE]\n\n");
    };
    startTaskOutput(id, { runtimeKind: "pi-sdk" });
    const host = await f.launch({ defaultTools: ["bash"] }, (event) => {
      if (event.type === "model_request") publishTaskStage(id, "waiting-model");
      const parsed = parsePiStreamLine(JSON.stringify(event));
      if (parsed?.delta) publishTaskText(id, parsed.delta);
      for (const activity of parsed?.activities ?? [])
        publishTaskActivity(id, activity);
    });
    const current = () => ({
      workspaceId: "native-host-fixture",
      userId: "fixture",
      output: taskOutput(id),
      settled: false,
    });
    const response = executionOutputResponse(
      new Request("http://localhost/events"),
      current(),
      async () => current(),
    );
    const reader = assertDefined(response.body).getReader();
    const frames: string[] = [];
    const consuming = (async () => {
      while (true) {
        const frame = await reader.read();
        if (frame.done) return;
        frames.push(new TextDecoder().decode(frame.value));
      }
    })();
    const pending = host.request(
      "prompt",
      "Run the native bash tool and report its result",
    );
    try {
      await expect
        .poll(
          () =>
            frames.some(
              (frame) =>
                frame.includes('"toolName":"bash"') &&
                frame.includes('"status":"running"'),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect
        .poll(
          () => frames.some((frame) => frame.includes("FIRST_NATIVE_FRAGMENT")),
          { timeout: 15_000 },
        )
        .toBe(true);
      expect(
        host.events.some((event) => event.type === "toolplane_sdk_response"),
      ).toBe(false);
      expect(await readFile(join(f.workspace, "live-result.txt"), "utf8")).toBe(
        "42",
      );
      expect(taskOutput(id)?.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool",
            toolName: "bash",
            status: "completed",
          }),
          expect.objectContaining({
            type: "reasoning",
            text: "Read the native tool result",
          }),
        ]),
      );
      release.resolve();
      expect((await pending).success).toBe(true);
      finishTaskOutput(id, "completed");
      await expect
        .poll(() => frames.some((frame) => frame.includes('"done":true')))
        .toBe(true);
      expect(taskOutput(id)?.text).toBe("FIRST_NATIVE_FRAGMENT_FINAL");
    } finally {
      release.resolve();
      await pending;
      await reader.cancel();
      await consuming;
    }
  }, 60000);
  it("switches the admitted model and provider URL per prompt, then restores the default without losing history", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch();
    const first = await host.request("prompt", "Retain the first model turn");
    expect(first.success).toBe(true);
    const original = assertDefined(first.result).state;
    const alternate = await host.request("prompt", "Use the override", {
      ...f.context,
      runtimeToken: "test-runtime-override",
      model: {
        ...f.config.model,
        id: "alternate",
        baseUrl: f.config.model.baseUrl.replace("/v1", "/alternate/v1"),
      },
    });
    expect(alternate.success).toBe(true);
    expect(assertDefined(alternate.result).state.sessionId).toBe(
      original.sessionId,
    );
    const restored = await host.request(
      "prompt",
      "Use the pinned default again",
    );
    expect(restored.success).toBe(true);
    expect(assertDefined(restored.result).state.sessionId).toBe(
      original.sessionId,
    );
    expect(f.requests.map((request) => request.body.model)).toEqual([
      "controlled",
      "alternate",
      "controlled",
    ]);
    expect(f.requests.map((request) => request.path)).toEqual([
      "/v1/chat/completions",
      "/alternate/v1/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(f.requests.map((request) => request.authorization)).toEqual([
      "Bearer test-runtime-first",
      "Bearer test-runtime-override",
      "Bearer test-runtime-first",
    ]);
    expect(
      f.requests[2].body.messages.filter((message) => message.role === "user"),
    ).toHaveLength(3);
  }, 60000);
  it("returns the native /compact summary and preserves the same session file across restart", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch();
    // Exceed native keepRecentTokens with separate turns so real preparation has history to compact.
    const history = "NATIVE_COMPACTION_SOURCE ".repeat(4000);
    const first = await host.request(
      "prompt",
      `First retained turn: ${history}`,
    );
    expect(first.success).toBe(true);
    const original = assertDefined(first.result).state;
    expect(
      (await host.request("prompt", `Second retained turn: ${history}`))
        .success,
    ).toBe(true);
    f.behavior.completionText = "NATIVE_SUMMARY_FROM_PROVIDER";
    const compacted = await host.request(
      "prompt",
      "/compact retain the native compaction marker",
      {
        ...f.context,
        roleModels: {
          compaction: {
            ...f.config.model,
            provider: "toolplane-summary",
            id: "summary",
            toolplaneProviderId: "summary",
            baseUrl: f.config.model.baseUrl.replace("/v1", "/summary/v1"),
          },
        },
      },
    );
    expect(compacted.success).toBe(true);
    const result = assertDefined(compacted.result);
    expect(result.text).toContain("NATIVE_SUMMARY_FROM_PROVIDER");
    expect(result.actualModel).toEqual({
      providerId: "summary",
      model: "summary",
    });
    expect(f.requests.at(-1)).toMatchObject({
      path: "/summary/v1/chat/completions",
      body: { model: "summary" },
    });
    expect(result.commandResult).toEqual({
      command: "compact",
      text: result.text,
      status: "completed",
    });
    expect(result.state).toMatchObject({
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
    });
    const entries = (await readFile(original.sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: result.text }),
    );
    await host.stop();
    f.behavior.completionText = "SDK_CONTINUED";
    const reopened = await f.launch({ historyRequired: true });
    const continued = await reopened.request(
      "prompt",
      "Continue the compacted session",
    );
    expect(continued.success).toBe(true);
    expect(f.requests.at(-1)?.body.model).toBe("controlled");
    expect(assertDefined(continued.result).state).toMatchObject({
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
    });
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain(
      "NATIVE_SUMMARY_FROM_PROVIDER",
    );
  }, 60000);
  it("settles /compact on a short session as a completed no-op without a model call", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch();
    const first = await host.request("prompt", "hi");
    expect(first.success).toBe(true);
    const requests = f.requests.length;
    const compacted = await host.request("prompt", "/compact");
    expect(compacted.success).toBe(true);
    expect(assertDefined(compacted.result).commandResult).toEqual({
      command: "compact",
      text: "Nothing to compact (session too small)",
      status: "completed",
    });
    expect(f.requests).toHaveLength(requests);
    const sessionFile = assertDefined(first.result).state.sessionFile;
    const entries = (await readFile(sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
    const continued = await host.request("prompt", "Continue");
    expect(continued.success).toBe(true);
  }, 60000);
  it("automatically compacts native session history at the SDK threshold and resumes its persisted projection", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch();
    const history = "NATIVE_AUTO_COMPACTION_SOURCE ".repeat(4000);
    const first = await host.request(
      "prompt",
      `First retained turn: ${history}`,
    );
    expect(first.success).toBe(true);
    expect(
      (await host.request("prompt", `Second retained turn: ${history}`))
        .success,
    ).toBe(true);
    f.behavior.promptTokens = 120000;
    f.behavior.completionText = "NATIVE_AUTO_SUMMARY";
    const completed = await host.request(
      "prompt",
      "Complete the current turn near the context limit",
    );
    expect(completed.success).toBe(true);
    const state = assertDefined(completed.result).state;
    expect(state.sessionId).toBe(assertDefined(first.result).state.sessionId);
    const entries = (await readFile(state.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "compaction",
        summary: expect.stringContaining("NATIVE_AUTO_SUMMARY"),
      }),
    );
    await host.stop();
    f.behavior.promptTokens = 20;
    f.behavior.completionText = "AFTER_NATIVE_AUTO_COMPACTION";
    const resumed = await f.launch({ historyRequired: true });
    expect(
      (await resumed.request("prompt", "Continue after automatic compaction"))
        .success,
    ).toBe(true);
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain(
      "NATIVE_AUTO_SUMMARY",
    );
  }, 60000);
  it("applies configured reasoning through the native session and retains its JSONL record", async () => {
    const f = await setup();
    f.behavior.tool = "";
    const host = await f.launch({
      reasoningEffort: "high",
      model: { ...f.config.model, reasoning: true },
    });
    const result = await host.request(
      "prompt",
      "Use the configured reasoning level",
      {
        ...f.context,
        model: { ...f.config.model, reasoning: true },
        reasoningEffort: "high",
      },
    );
    expect(result.success).toBe(true);
    const state = assertDefined(result.result).state;
    const entries = (await readFile(state.sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "thinking_level_change",
        thinkingLevel: "high",
      }),
    );
    await host.stop();
    const reopened = await f.launch({
      reasoningEffort: "high",
      historyRequired: true,
      model: { ...f.config.model, reasoning: true },
    });
    const continued = await reopened.request(
      "prompt",
      "Continue with the configured reasoning level",
      {
        ...f.context,
        model: { ...f.config.model, reasoning: true },
        reasoningEffort: "high",
      },
    );
    expect(continued.success).toBe(true);
    expect(assertDefined(continued.result).state.sessionId).toBe(
      state.sessionId,
    );
  }, 60000);
  it("rejects duplicate extension commands instead of exposing load-order aliases", async () => {
    const f = await setup();
    const host = await f.launch({
      resources: {
        ...f.config.resources,
        extensions: [f.extension, f.collision],
      },
    });
    expect(await host.request("prompt", "Do not run")).toMatchObject({
      success: false,
    });
    expect(f.requests).toEqual([]);
  }, 60000);
  it("loads an explicitly enabled optional extension through the native SDK", async () => {
    const f = await setup();
    // Reuse the real counter extension, but load it via the optional-host config path.
    const host = await f.launch({
      resources: { ...f.config.resources, extensions: [] },
      optionalBuiltinExtensions: [f.extension],
      defaultTools: ["increment"],
    });
    expect(await host.request("prompt", "Use increment")).toMatchObject({
      success: true,
    });
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
    await host.stop();
  }, 60000);
  it("emits unified edit patches independently of the bounded tool output", async () => {
    const f = await setup();
    await writeFile(join(f.workspace, "edit.txt"), "before\n");
    f.behavior.tool = "edit";
    f.behavior.toolArgs = JSON.stringify({
      path: "edit.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    const host = await f.launch({ defaultTools: ["edit"] });
    expect((await host.request("prompt", "Edit the file")).success).toBe(true);
    expect(await readFile(join(f.workspace, "edit.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "edit",
        truncated: false,
        patch: expect.stringMatching(/@@[\s\S]*-before[\s\S]*\+after/),
        firstChangedLine: 1,
      }),
    );
    f.behavior.toolArgs = JSON.stringify({
      path: "edit.txt",
      edits: [
        {
          oldText: "after",
          newText: `${f.context.runtimeToken}\n${"变".repeat(30_000)}`,
        },
      ],
    });
    expect((await host.request("prompt", "Make a large edit")).success).toBe(
      true,
    );
    const last = host.events
      .filter((event) => event.type === "tool_execution_end")
      .at(-1);
    expect(last).toMatchObject({ toolName: "edit", truncated: true });
    expect(Buffer.byteLength(String(last?.patch))).toBeLessThanOrEqual(65_536);
    expect(String(last?.patch)).toContain("[REDACTED]");
    expect(String(last?.patch)).not.toContain(f.context.runtimeToken);
    expect(String(last?.patch)).not.toContain("\uFFFD");
  }, 60000);
  it.each(["python", "javascript"] as const)(
    "retains %s eval variables across turns, interrupts timeouts and resets explicitly",
    async (language) => {
      const f = await setup();
      f.behavior.tool = "eval";
      const host = await f.launch({
        optionalBuiltinExtensions: [
          resolve("scripts/pi-optional-tools/eval.mjs"),
        ],
        defaultTools: ["eval"],
      });
      const cell = async (code: string, options = {}) => {
        f.behavior.toolArgs = JSON.stringify({ language, code, ...options });
        const response = await host.request("prompt", "Execute this eval cell");
        // A failed cell must stay a tool result, not fail or lose the native turn.
        expect(response.success, JSON.stringify(response)).toBe(true);
        const event = host.events.findLast(
          (event) =>
            event.type === "tool_execution_end" && event.toolName === "eval",
        );
        expect(event).toBeDefined();
        return event;
      };
      expect(
        await cell(
          language === "python"
            ? "counter = 41\nprint('initialized')"
            : "let counter = 41; console.log('initialized')",
        ),
      ).toMatchObject({
        isError: false,
        result: { details: { language, output: "initialized\n" } },
      });
      expect(
        await cell(
          language === "python"
            ? "counter += 1\ncounter"
            : "counter += 1; counter",
        ),
      ).toMatchObject({
        result: { details: { output: "42\n" } },
      });
      expect(
        await cell(
          language === "python" ? "while True: pass" : "while (true) {}",
          { timeoutSeconds: 1 },
        ),
      ).toMatchObject({
        isError: true,
        result: { details: { reason: "EVAL_TIMEOUT" } },
      });
      const recovered = await cell("counter");
      expect(recovered, JSON.stringify(recovered)).toMatchObject({
        isError: false,
        result: { details: { output: "42\n" } },
      });
      expect(
        await cell(
          language === "python" ? "'counter' in globals()" : "typeof counter",
          { reset: true },
        ),
      ).toMatchObject({
        isError: false,
        result: {
          details: {
            stateReset: true,
            output: language === "python" ? "False\n" : "undefined\n",
          },
        },
      });
      await host.stop();
    },
    60000,
  );

  it("discloses eval state loss after a host restart without losing the native session", async () => {
    const f = await setup();
    const options = {
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/eval.mjs"),
      ],
      defaultTools: ["eval"],
    };
    f.behavior.tool = "eval";
    f.behavior.toolArgs = JSON.stringify({
      language: "javascript",
      code: "let retained = 7",
    });
    const first = await f.launch(options);
    const initial = await first.request("prompt", "Initialize eval state");
    expect(initial.success).toBe(true);
    await first.stop();
    f.behavior.toolArgs = JSON.stringify({
      language: "javascript",
      code: "typeof retained",
    });
    const resumed = await f.launch({ ...options, historyRequired: true });
    const result = await resumed.request(
      "prompt",
      "Continue after restarting host",
    );
    expect(result).toMatchObject({
      success: true,
      result: {
        state: { sessionId: assertDefined(initial.result).state.sessionId },
      },
    });
    expect(resumed.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "eval",
        isError: false,
        result: expect.objectContaining({
          details: expect.objectContaining({
            stateReset: true,
            notice: expect.any(String),
            output: "undefined\n",
          }),
        }),
      }),
    );
    await resumed.stop();
  }, 60000);

  it("restarts an uninterruptible Python eval cell and explicitly reports lost state", async () => {
    const f = await setup();
    f.behavior.tool = "eval";
    f.behavior.toolArgs = JSON.stringify({
      language: "python",
      code: "import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True: pass",
      timeoutSeconds: 1,
    });
    const host = await f.launch({
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/eval.mjs"),
      ],
      defaultTools: ["eval"],
    });
    expect(
      (await host.request("prompt", "Interrupt a noncooperative cell")).success,
    ).toBe(true);
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "eval",
        isError: true,
        result: expect.objectContaining({
          details: expect.objectContaining({
            reason: "EVAL_TIMEOUT",
            stateReset: true,
            notice: expect.any(String),
          }),
        }),
      }),
    );
    f.behavior.toolArgs = JSON.stringify({ language: "python", code: "6 * 7" });
    expect(
      (await host.request("prompt", "Use the replacement kernel")).success,
    ).toBe(true);
    expect(
      host.events.findLast((event) => event.type === "tool_execution_end"),
    ).toMatchObject({
      isError: false,
      result: {
        details: {
          output: "42\n",
          stateReset: true,
          notice: expect.any(String),
        },
      },
    });
    await host.stop();
  }, 60000);

  it("bounds retained eval output while draining both standard output streams", async () => {
    const f = await setup();
    f.behavior.tool = "eval";
    f.behavior.toolArgs = JSON.stringify({
      language: "python",
      code: "import sys\nprint('x' * 100000)\nprint('stderr', file=sys.stderr)\n42",
    });
    const host = await f.launch({
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/eval.mjs"),
      ],
      defaultTools: ["eval"],
    });
    const result = await host.request("prompt", "Bound a large cell output");
    expect(result.success).toBe(true);
    const entries = (
      await readFile(assertDefined(result.result).state.sessionFile, "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const message = entries.findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "eval",
    ).message;
    expect(message.isError).toBe(false);
    expect(message.details.truncated).toBe(true);
    expect(Buffer.byteLength(message.details.output)).toBeLessThanOrEqual(
      50 * 1024,
    );
    await host.stop();
  }, 60000);

  it("cascades native abort into the Python cell and retains the interrupted kernel", async () => {
    const f = await setup();
    f.behavior.tool = "eval";
    f.behavior.toolArgs = JSON.stringify({
      language: "python",
      code: "from pathlib import Path\nretained = 42\nPath('eval-started').write_text('ready')\nwhile True: pass",
    });
    const host = await f.launch({
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/eval.mjs"),
      ],
      defaultTools: ["eval"],
    });
    const watcher = watch(f.workspace);
    cleanups.push(async () => {
      watcher.close();
    });
    const started = once(watcher, "change");
    const turn = host.request("prompt", "Abort this running cell");
    await started;
    watcher.close();
    expect((await host.request("abort")).success).toBe(true);
    expect(await turn).toMatchObject({
      success: false,
      error: { code: "PI_SDK_ABORTED" },
    });
    f.behavior.toolArgs = JSON.stringify({
      language: "python",
      code: "retained",
    });
    expect((await host.request("prompt", "Continue after abort")).success).toBe(
      true,
    );
    expect(
      host.events.findLast((event) => event.type === "tool_execution_end"),
    ).toMatchObject({
      isError: false,
      result: { details: { output: "42\n" } },
    });
    await host.stop();
  }, 60000);

  it("returns a fixed failed tool result when the sandbox has no python3", async () => {
    const f = await setup();
    const environmentExtension = join(f.workspace, "without-python.mjs");
    await writeFile(
      environmentExtension,
      `export default pi => { pi.on('session_start', () => { process.env.PATH = ${JSON.stringify(join(f.root, "no-executables"))}; }); };`,
    );
    f.behavior.tool = "eval";
    f.behavior.toolArgs = JSON.stringify({ language: "python", code: "42" });
    const host = await f.launch({
      resources: { ...f.config.resources, extensions: [environmentExtension] },
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/eval.mjs"),
      ],
      defaultTools: ["eval"],
    });
    expect(
      (await host.request("prompt", "Use unavailable Python")).success,
    ).toBe(true);
    expect(
      host.events.findLast((event) => event.type === "tool_execution_end"),
    ).toMatchObject({
      isError: true,
      result: { details: { reason: "EVAL_PYTHON_UNAVAILABLE" } },
    });
    await host.stop();
  }, 60000);
  it("debugs a real Node program through the optional native SDK tool and releases it at agent end", async () => {
    const f = await setup();
    const program = join(f.workspace, "debug-fixture.cjs");
    await writeFile(program, "const value = 40;\nconst answer = value + 2;\nconsole.log(answer);\n");
    const actions = [
      { action: "launch", program, language: "node" },
      { action: "set_breakpoints", file: program, lines: [3] },
      { action: "continue" },
      { action: "evaluate", expr: "answer" },
      { action: "continue" },
    ];
    let next = 0;
    f.behavior.streamCompletion = async (response) => {
      const action = actions[next++];
      if (action) completion(response, { tool_calls: [{ index: 0, id: `debug-${next}`, type: "function", function: { name: "debug", arguments: JSON.stringify(action) } }] }, "tool_calls");
      else completion(response, { content: "DEBUG_COMPLETE" }, "stop");
    };
    const host = await f.launch({
      resources: { ...f.config.resources, extensions: [] },
      optionalBuiltinExtensions: [resolve("scripts/pi-optional-tools/debug.mjs")],
      defaultTools: ["debug"],
    });
    const response = await host.request("prompt", "Debug the program");
    expect(response).toMatchObject({ success: true, result: { text: "DEBUG_COMPLETE" } });
    const results = host.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "debug");
    expect(results).toHaveLength(actions.length);
    expect(results.some((event) => event.isError)).toBe(false);
    const history = await readFile(assertDefined(response.result).state.sessionFile, "utf8");
    expect(history).toContain('\\"value\\":\\"42\\"');
    expect(history).toContain('\\"state\\":\\"terminated\\"');
    await host.stop();
  }, 60000);
  it("runs real tools, preserves custom branch state on restart and isolates stdout", async () => {
    const f = await setup(),
      host = await f.launch();
    const result = await host.request("prompt", "Use increment");
    expect(result).toMatchObject({
      success: true,
      result: { text: "SDK_COMPLETE", state: { sessionPersisted: true } },
    });
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
    expect(
      host.events
        .filter((event) =>
          [
            "model_request",
            "tool_execution_start",
            "tool_execution_end",
          ].includes(String(event.type)),
        )
        .map((event) => event.type),
    ).toEqual([
      "model_request",
      "tool_execution_start",
      "tool_execution_end",
      "model_request",
    ]);
    const jsonl = await readFile(
      assertDefined(result.result).state.sessionFile,
      "utf8",
    );
    expect(
      jsonl
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toContainEqual(
      expect.objectContaining({ type: "custom", customType: "count", data: 1 }),
    );
    await host.stop();
    const restarted = await f.launch();
    const command = await restarted.request("prompt", "/CaseCmd");
    expect(command).toMatchObject({
      success: true,
      result: {
        text: "Pi 扩展 · counter\ncount=1",
        commandResult: { command: "CaseCmd", status: "completed" },
        state: { sessionId: assertDefined(result.result).state.sessionId },
      },
    });
    expect(restarted.output().stdout).toContain("UNTRUSTED_STDOUT");
    expect(JSON.stringify(restarted.events)).not.toContain("UNTRUSTED_STDOUT");
    expect(f.requests.map((r) => r.authorization)).toEqual([
      "Bearer test-runtime-first",
      "Bearer test-runtime-first",
    ]);
  }, 60000);
  it("settles input hooks and commands without model calls and exposes dynamic resources", async () => {
    const f = await setup(),
      host = await f.launch();
    expect(await host.request("get_commands")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_CONTEXT_REQUIRED" },
    });
    expect(await host.request("prompt", "handled")).toMatchObject({
      success: true,
      result: { text: "" },
    });
    const result = await host.request("prompt", "/CaseCmd");
    const names = assertDefined(result.result).commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "CaseCmd",
        "skill:dynamic-skill",
        "DynamicPrompt",
        "compact",
      ]),
    );
    expect(await host.request("prompt", "/Silent")).toMatchObject({
      success: true,
      result: { commandResult: { command: "Silent", status: "completed" } },
    });
    expect(await host.request("prompt", "/casecmd")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_COMMAND_UNKNOWN" },
    });
    expect(f.requests).toEqual([]);
    expect(host.events.some((event) => event.type === "model_request")).toBe(
      false,
    );
    expect(
      host.events.filter((e) => e.type === "toolplane_sdk_response"),
    ).toHaveLength(5);
    await host.stop();
    expect(
      await (await f.launch()).request("prompt", "/CaseCmd"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_SESSION_MISSING" },
    });
  }, 60000);
  it("discovers and calls pinned native tools through the SDK StreamableHTTP transport", async () => {
    const f = await setup();
    f.behavior.mcpTool = "a2a_publish_artifact";
    f.behavior.tool = nativePiMcpToolName(0, 0, "a2a_publish_artifact");
    const host = await f.launch();
    const result = await host.request(
      "prompt",
      "Publish with the runtime tool",
      {
        ...f.context,
        mcpConfig: JSON.parse(
          buildPiMcpConfig(
            [
              {
                deploymentId: "toolplane-runtime",
                url: f.config.model.baseUrl.replace("/v1", "/mcp"),
              },
            ],
            RESULT_FILE_BYTES,
          ),
        ),
      },
    );
    expect(result).toMatchObject({
      success: true,
      result: { text: "SDK_COMPLETE" },
    });
    expect(f.mcpRequests.map((entry) => entry.method)).toEqual([
      "tools/list",
      "tools/call",
    ]);
    expect(f.requests.at(-1)?.body.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "CURRENT_MCP_OK",
    });
    expect(
      host.events.some((event) => event.type === "toolplane_mcp_unavailable"),
    ).toBe(false);
  }, 60000);

  it("resumes the same persisted session and files with a revised MCP toolset", async () => {
    const f = await setup();
    const server = {
      name: "Fixture MCP",
      deploymentId: "fixture",
      url: f.config.model.baseUrl.replace("/v1", "/mcp"),
    };
    const context = {
      ...f.context,
      mcpConfig: JSON.parse(buildPiMcpConfig([server], RESULT_FILE_BYTES)),
    };
    f.behavior.tool = nativePiMcpToolName(0, 0, "current_mcp");
    const host = await f.launch();
    const first = await host.request(
      "prompt",
      "Remember the original revision",
      context,
    );
    expect(first.success).toBe(true);
    const original = assertDefined(first.result).state;
    await writeFile(join(f.workspace, "retained.txt"), "retained user file");
    // The broker stops the idle old host on signature mismatch before forwarding
    // the new turn. Its response was emitted only after persist() completed.
    await host.stop();
    f.behavior.mcpTool = "new_revision_tool";
    f.behavior.mcpSchema = {
      type: "object",
      properties: { optional: { type: "string" } },
    };
    f.behavior.tool = nativePiMcpToolName(0, 0, "new_revision_tool");
    const next = await f.launch({
      agentRevisionId: "revision-two",
      historyRequired: true,
    });
    const continued = await next.request(
      "prompt",
      "Continue in the same conversation",
      context,
    );
    expect(continued.success).toBe(true);
    expect(assertDefined(continued.result).state).toMatchObject({
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
    });
    expect(await readFile(join(f.workspace, "retained.txt"), "utf8")).toBe(
      "retained user file",
    );
    expect(f.requests.at(-1)?.body.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Remember the original revision" }],
      }),
    );
    expect(
      f.mcpRequests
        .filter((entry) => entry.method === "tools/call")
        .map((entry) => entry.params),
    ).toEqual([
      { name: "current_mcp", arguments: {} },
      { name: "new_revision_tool", arguments: {} },
    ]);
  }, 60000);

  it("uses current model credentials and MCP definitions on successive contexts, rejecting tool schema changes", async () => {
    const f = await setup();
    f.behavior.tool = nativePiMcpToolName(0, 0, "current_mcp");
    const host = await f.launch();
    const server = {
      name: "Fixture MCP",
      deploymentId: "fixture",
      url: f.config.model.baseUrl.replace("/v1", "/mcp"),
    };
    const first = {
      ...f.context,
      runtimeToken: "test-runtime-first",
      mcpConfig: JSON.parse(buildPiMcpConfig([server], RESULT_FILE_BYTES)),
      model: f.config.model,
    };
    expect((await host.request("prompt", "Call MCP", first)).success).toBe(
      true,
    );
    f.behavior.mcpSchema = { properties: {}, type: "object" };
    const second = {
      ...first,
      runtimeToken: "test-runtime-replacement",
      mcpConfig: JSON.parse(
        buildPiMcpConfig(
          [{ ...server, url: `${server.url}-next` }],
          RESULT_FILE_BYTES,
        ),
      ),
    };
    expect((await host.request("prompt", "Continue", second)).success).toBe(
      true,
    );
    expect(f.requests.map((r) => r.authorization)).toEqual([
      "Bearer test-runtime-first",
      "Bearer test-runtime-first",
      "Bearer test-runtime-replacement",
      "Bearer test-runtime-replacement",
    ]);
    expect(f.mcpRequests).toEqual([
      {
        authorization: "Bearer test-runtime-first",
        path: "/mcp",
        method: "tools/list",
        params: undefined,
      },
      {
        authorization: "Bearer test-runtime-first",
        path: "/mcp",
        method: "tools/call",
        params: { name: "current_mcp", arguments: {} },
      },
      {
        authorization: "Bearer test-runtime-replacement",
        path: "/mcp-next",
        method: "tools/list",
        params: undefined,
      },
      {
        authorization: "Bearer test-runtime-replacement",
        path: "/mcp-next",
        method: "tools/call",
        params: { name: "current_mcp", arguments: {} },
      },
    ]);
    expect(
      f.requests
        .filter((r) => r.body.messages.at(-1)?.role === "tool")
        .map((r) => r.body.messages.at(-1)),
    ).toEqual([
      expect.objectContaining({ content: "CURRENT_MCP_OK" }),
      expect.objectContaining({ content: "CURRENT_MCP_OK" }),
    ]);
    expect(host.events).toContainEqual({
      type: "toolplane_mcp_origin",
      toolCallId: "count-call",
      deploymentId: "fixture",
      originalToolName: "current_mcp",
    });
    f.behavior.mcpTool = "different";
    expect(
      await host.request("prompt", "Reject changed tools", second),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_TOOLSET_CHANGED" },
    });
    expect(await readFile(f.config.statePath, "utf8")).not.toMatch(
      /test-runtime/,
    );
    expect(
      await readFile(
        assertDefined((await host.request("get_state")).result).state
          .sessionFile,
        "utf8",
      ),
    ).not.toContain("test-runtime-replacement");
  }, 60000);
  it("rebounds real new/fork/switch sessions and keeps replacement identity after restart", async () => {
    const f = await setup(),
      host = await f.launch();
    const original = assertDefined(
      (await host.request("prompt", "Use increment")).result,
    ).state;
    const forked = assertDefined(
      (await host.request("prompt", "/Fork")).result,
    ).state;
    expect(forked.sessionFile).not.toBe(original.sessionFile);
    const switched = assertDefined(
      (await host.request("prompt", `/Switch ${original.sessionFile}`)).result,
    ).state;
    expect(switched.sessionFile).toBe(original.sessionFile);
    const replacement = assertDefined(
      (await host.request("prompt", "/Replace")).result,
    ).state;
    expect(replacement.sessionId).not.toBe(original.sessionId);
    f.behavior.tool = "";
    const persisted = assertDefined(
      (await host.request("prompt", "Persist replacement")).result,
    ).state;
    expect(persisted.sessionFile).toBe(replacement.sessionFile);
    await host.stop();
    const resumed = await f.launch();
    expect(
      assertDefined((await resumed.request("prompt", "/CaseCmd")).result).state
        .sessionFile,
    ).toBe(persisted.sessionFile);
  }, 60000);
  it("preserves the package checksum error and prevents extension execution", async () => {
    const f = await setup();
    const host = await f.launch({
      packages: [
        {
          checksum: "invalid",
          root: join(f.root, "snapshot"),
          manifestPath: join(f.root, "manifest.json"),
        },
      ],
    });
    expect(await host.request("prompt", "/CaseCmd")).toMatchObject({
      success: false,
      error: { code: "PI_PACKAGE_CHECKSUM_MISMATCH" },
    });
    expect(f.requests).toEqual([]);
    expect(host.output().stdout).not.toContain("UNTRUSTED_STDOUT");
  });
  it("fails closed for lost files, missing state, changed package identity and extension load failures", async () => {
    const f = await setup(),
      host = await f.launch();
    const original = assertDefined(
      (await host.request("prompt", "Use increment")).result,
    ).state;
    await host.stop();
    expect(
      await (
        await f.launch({ packageSetChecksum: "different-reviewed-set" })
      ).request("prompt", "No replay"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_PACKAGE_SET_CHANGED" },
    });
    await rm(original.sessionFile);
    expect(
      await (await f.launch()).request("prompt", "No replay"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_SESSION_MISSING" },
    });
    await rm(f.config.statePath);
    expect(
      await (await f.launch({ historyRequired: true })).request(
        "prompt",
        "No replay",
      ),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_SESSION_MISSING" },
    });
    await writeFile(
      f.extension,
      'export default () => { throw new Error("private-loader-secret"); };',
    );
    const broken = await f.launch();
    expect(await broken.request("prompt", "Do not call model")).toMatchObject({
      success: false,
      error: { code: "PI_EXTENSION_LOAD_FAILED" },
    });
    expect(JSON.stringify(broken.events)).not.toContain(
      "private-loader-secret",
    );
    expect(f.requests).toHaveLength(2);
  }, 60000);
  it.each(["denied", "expired"])(
    "keeps a real native turn successful after %s tool approval",
    async (status) => {
      const f = await setup();
      f.behavior.approvalStatus = status === "expired" ? "pending" : "denied";
      f.behavior.approvalExpired = status === "expired";
      const host = await f.launch();
      const result = await host.request("prompt", "Use increment", {
        ...f.context,
        toolApprovalBridge: true,
      });
      expect(result).toMatchObject({
        success: true,
        result: { state: { sessionPersisted: true }, text: "SDK_COMPLETE" },
      });
      await expect(
        readFile(join(f.workspace, "count.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(
        "TOOL_APPROVAL_DENIED: Tool execution was not approved.",
      );
      expect(host.events).toContainEqual(
        expect.objectContaining({
          type: "tool_execution_end",
          toolName: "increment",
          isError: true,
        }),
      );
    },
    60000,
  );
  it("executes an approved native call once with the captured parameters", async () => {
    const f = await setup();
    const host = await f.launch();
    expect(
      await host.request("prompt", "Use increment", {
        ...f.context,
        toolApprovalBridge: true,
      }),
    ).toMatchObject({ success: true });
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "increment",
        isError: false,
      }),
    );
  }, 60000);

  it("keeps the turn alive after a failed tool call, retains reload failure, and rejects outside dynamic resource paths", async () => {
    const f = await setup();
    f.behavior.tool = "fail_tool";
    const host = await f.launch();
    // The model receives the failed result and answers; the turn and session survive.
    expect(await host.request("prompt", "Call fail_tool")).toMatchObject({
      success: true,
      result: { state: { sessionPersisted: true } },
    });
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "fail_tool",
        isError: true,
      }),
    );
    await writeFile(
      f.extension,
      'export default () => { throw new Error("reload-secret"); };',
    );
    expect(await host.request("prompt", "/Reload")).toMatchObject({
      success: false,
      error: { code: "PI_EXTENSION_LOAD_FAILED" },
    });
    await host.stop();
    await rm(f.config.statePath);
    const outside = join(f.root, "Outside.md");
    await writeFile(outside, "Outside prompt");
    await writeFile(
      f.extension,
      `export default pi=>{pi.on('resources_discover',()=>({promptPaths:[${JSON.stringify(outside)}]}));};`,
    );
    const denied = await f.launch();
    expect(await denied.request("prompt", "Never run model")).toMatchObject({
      success: false,
      error: { code: "PI_EXTENSION_RESOURCE_DENIED" },
    });
  }, 60000);
  it("delivers native extension dialogs and notifications with the current task bearer, without tool approval injection", async () => {
    const f = await setup();
    const host = await f.launch();
    const result = await host.request("prompt", "/Dialogs");
    expect(result.success).toBe(true);
    expect(result.result?.text).toContain(
      '["select-answer",true,"input-answer","editor-answer"]',
    );
    expect(
      f.uiCalls
        .filter((call) => call.action === "request")
        .map((call) => call.request?.method),
    ).toEqual([
      "select",
      "confirm",
      "input",
      "editor",
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
      "setStatus",
      "setWidget",
    ]);
    expect(
      f.uiCalls
        .filter((call) => call.action === "request")
        .map((call) => call.request),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "select",
          title: "Select one",
          options: ["first", "second"],
        }),
        expect.objectContaining({
          method: "notify",
          message: "Native notification",
          notifyType: "warning",
        }),
        expect.objectContaining({
          method: "setWidget",
          widgetKey: "native",
          widgetLines: ["line"],
          widgetPlacement: "belowEditor",
        }),
        expect.objectContaining({ method: "set_editor_text", text: "draft" }),
      ]),
    );
    expect(
      f.uiCalls.every(
        (call) => call.authorization === "Bearer test-runtime-first",
      ),
    ).toBe(true);
    const firstCalls = f.uiCalls.length;
    const replacement = {
      ...f.context,
      runtimeToken: "test-runtime-replacement",
      uiUrl: f.context.uiUrl.replace("fixture-task", "next-task"),
    };
    expect(
      (await host.request("prompt", "/Dialogs", replacement)).success,
    ).toBe(true);
    expect(
      f.uiCalls
        .slice(firstCalls)
        .every(
          (call) =>
            call.authorization === "Bearer test-runtime-replacement" &&
            call.path?.includes("next-task"),
        ),
    ).toBe(true);
    expect(f.requests).toEqual([]);
    // Ordinary tools remain native; no platform approval readiness/check call is made.
    expect(
      (await host.request("prompt", "Use increment", replacement)).success,
    ).toBe(true);
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
    expect(
      f.uiCalls.every((call) =>
        ["request", "poll", "resolve", "todos"].includes(call.action),
      ),
    ).toBe(true);
  }, 60000);
  it("retires native dialogs on timeout, extension signal, and host abort without leaving a blocked command", async () => {
    const f = await setup();
    f.behavior.pauseUi = true;
    const host = await f.launch();
    expect((await host.request("prompt", "/Timeout")).result?.text).toContain(
      "false",
    );
    expect((await host.request("prompt", "/Signal")).result?.text).toContain(
      "undefined",
    );
    const dialogCount = f.uiCalls.filter(
      (call) => call.action === "request",
    ).length;
    expect((await host.request("prompt", "/AlreadyAborted")).success).toBe(
      true,
    );
    expect(f.uiCalls.filter((call) => call.action === "request")).toHaveLength(
      dialogCount,
    );
    const requested = once(f.requestEvents, "ui-request");
    const turn = host.request("prompt", "/Dialogs");
    await requested;
    expect((await host.request("abort")).success).toBe(true);
    expect(await turn).toMatchObject({
      success: false,
      error: { code: "PI_SDK_ABORTED" },
    });
    const pendingIds = f.uiCalls
      .filter(
        (call) =>
          call.action === "request" &&
          ["confirm", "input", "select"].includes(call.request?.method ?? ""),
      )
      .map((call) => call.request?.id);
    expect(
      f.uiCalls
        .filter((call) => call.action === "resolve")
        .map((call) => call.id),
    ).toEqual(pendingIds);
    f.behavior.pauseUi = false;
    expect((await host.request("prompt", "/Dialogs")).success).toBe(true);
  }, 60000);
  it("polls native dialog responses, preserves cancelled defaults, and retires failed transport requests", async () => {
    const f = await setup();
    const host = await f.launch();
    f.behavior.pauseUi = true;
    const requested = once(f.requestEvents, "ui-request");
    const turn = host.request("prompt", "/Dialogs");
    await requested;
    f.behavior.pauseUi = false;
    expect((await turn).success).toBe(true);
    expect(f.uiCalls.some((call) => call.action === "poll")).toBe(true);
    f.behavior.cancelUi = true;
    expect((await host.request("prompt", "/Dialogs")).result?.text).toContain(
      "[null,false,null,null]",
    );
    f.behavior.pauseUi = true;
    f.behavior.failUiPoll = true;
    expect((await host.request("prompt", "/Dialogs")).success).toBe(false);
    const failed = f.uiCalls
      .filter(
        (call) =>
          call.action === "request" && call.request?.method === "select",
      )
      .at(-1);
    expect(f.uiCalls).toContainEqual(
      expect.objectContaining({ action: "resolve", id: failed?.request?.id }),
    );
    // The first model/tool turn can write native history before UI delivery fails.
    // Its persisted session pointer must survive that failed result and restart.
    f.behavior.pauseUi = false;
    f.behavior.failUiPoll = false;
    f.behavior.cancelUi = false;
    f.behavior.failTodoProjection = true;
    f.behavior.tool = "todo";
    f.behavior.toolArgs = JSON.stringify({
      action: "add",
      text: "Keep native state after delivery failure",
    });
    expect(
      await host.request(
        "prompt",
        "Create native todo before UI delivery fails",
      ),
    ).toMatchObject({ success: false, error: { code: "PI_SDK_UI_FAILED" } });
    const retained = JSON.parse(
      await readFile(f.config.statePath, "utf8"),
    ) as SdkState;
    expect(retained.sessionPersisted).toBe(true);
    expect(await readFile(retained.sessionFile, "utf8")).toContain(
      "Keep native state after delivery failure",
    );
    await host.stop();
    f.behavior.failTodoProjection = false;
    f.behavior.tool = "";
    const reopened = await f.launch({ historyRequired: true });
    const continued = await reopened.request(
      "prompt",
      "Continue the saved native session",
    );
    expect(continued.success).toBe(true);
    expect(continued.result?.state).toMatchObject({
      sessionId: retained.sessionId,
      sessionFile: retained.sessionFile,
    });
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([
      { id: 1, text: "Keep native state after delivery failure", done: false },
    ]);
  }, 60000);
  it("uses the installed native todo extension and projects current branch state across restart, tree navigation, and clears", async () => {
    const f = await setup();
    f.behavior.tool = "todo";
    f.behavior.toolArgs = JSON.stringify({
      action: "add",
      text: "native first",
    });
    const host = await f.launch();
    const first = await host.request("prompt", "Add first todo");
    expect(first.success).toBe(true);
    expect(
      f.requests[0].body.tools?.filter((tool) => tool.function.name === "todo"),
    ).toHaveLength(1);
    const session = assertDefined(first.result).state;
    const entries = (await readFile(session.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstTodoResult = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo",
    );
    expect(firstTodoResult.message.details).toMatchObject({
      action: "add",
      todos: [{ id: 1, text: "native first", done: false }],
      nextId: 2,
    });
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([{ id: 1, text: "native first", done: false }]);
    f.behavior.toolArgs = JSON.stringify({
      action: "add",
      text: "native second",
    });
    expect((await host.request("prompt", "Add second todo")).success).toBe(
      true,
    );
    await host.stop();
    const resumed = await f.launch({ historyRequired: true });
    expect((await resumed.request("prompt", "/todos")).result?.text).toContain(
      "/todos",
    );
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toHaveLength(2);
    expect(
      f.uiCalls.filter((call) => call.request?.method === "notify").at(-1)
        ?.request?.message,
    ).toContain("native second");
    expect(
      (await resumed.request("prompt", `/Tree ${firstTodoResult.id}`)).success,
    ).toBe(true);
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([{ id: 1, text: "native first", done: false }]);
    f.behavior.toolArgs = JSON.stringify({ action: "clear" });
    expect((await resumed.request("prompt", "Clear todos")).success).toBe(true);
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([]);
    expect((await resumed.request("prompt", "/Replace")).success).toBe(true);
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([]);
  }, 60000);
  it("prefers an admitted package's todo tool and rejects a conflicting package-only todos command", async () => {
    const f = await setup();
    await writeFile(
      f.extension,
      `export default pi=>{let n=0;pi.registerTool({name:'todo',label:'Package todo',description:'Native package todo',parameters:{type:'object',properties:{}},async execute(){n++;return {content:[{type:'text',text:'PACKAGE_TODO'}],details:{todos:n===1?[{id:7,text:'package state',done:true}]:n===2?[{title:'custom todo schema',completed:false}]:[{id:8,text:'x'.repeat(300000),done:false}]}};}});};`,
    );
    f.behavior.tool = "todo";
    const host = await f.launch();
    expect((await host.request("prompt", "Use package todo")).success).toBe(
      true,
    );
    expect(
      f.requests[0].body.tools?.filter((tool) => tool.function.name === "todo"),
    ).toHaveLength(1);
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([{ id: 7, text: "package state", done: true }]);
    f.behavior.todoQuota = true;
    expect(
      (await host.request("prompt", "Use package's custom todo schema"))
        .success,
    ).toBe(true);
    expect(
      f.uiCalls.filter((call) => call.action === "todos").at(-1)?.todos,
    ).toEqual([]);
    expect(
      f.uiCalls.some(
        (call) =>
          call.request?.method === "notify" &&
          String(call.request.message).includes(
            "previously displayed list is stale",
          ),
      ),
    ).toBe(true);
    f.behavior.todoQuota = false;
    const oversized = await host.request(
      "prompt",
      "Keep the oversized native state intact",
    );
    expect(oversized.success).toBe(true);
    expect(
      f.uiCalls.filter((call) => call.request?.method === "notify").at(-1)
        ?.request,
    ).toMatchObject({
      notifyType: "warning",
      message: expect.stringContaining("previously displayed list is stale"),
    });
    const nativeEntries = (
      await readFile(assertDefined(oversized.result).state.sessionFile, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      nativeEntries
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "todo",
        )
        .at(-1).message.details.todos[0].text,
    ).toHaveLength(300000);
    await host.stop();
    await writeFile(
      f.extension,
      `export default pi=>{pi.registerCommand('todos',{handler:async()=>{}});};`,
    );
    const collision = await f.launch({ historyRequired: true });
    expect(await collision.request("prompt", "/todos")).toMatchObject({
      success: false,
      error: { code: "PI_CAPABILITY_CONFLICT" },
    });
  }, 60000);
  it("keeps json mode noninteractive when an execution has no UI transport", async () => {
    const f = await setup();
    await writeFile(
      f.extension,
      `export default pi=>{pi.on('session_start',(_,ctx)=>{if(ctx.hasUI||ctx.mode!=='json')throw new Error('UNEXPECTED_UI');});};`,
    );
    f.behavior.tool = "todo";
    f.behavior.toolArgs = JSON.stringify({
      action: "add",
      text: "native without web",
    });
    const host = await f.launch();
    expect(
      (
        await host.request("prompt", "Use native todo without UI", {
          ...f.context,
          uiUrl: undefined,
        })
      ).success,
    ).toBe(true);
    expect(f.uiCalls).toEqual([]);
  }, 60000);
  it("keeps abort parsing live while the model is pending and does not report interrupted success", async () => {
    const f = await setup();
    f.behavior.pause = true;
    const host = await f.launch(),
      turn = host.request("prompt", "Pause model");
    if (!f.requests.length) await once(f.requestEvents, "request");
    await expect
      .poll(
        () =>
          host.events.filter((event) => event.type === "model_request").length,
      )
      .toBe(1);
    expect(host.events.some((event) => event.type === "message_update")).toBe(
      false,
    );
    expect((await host.request("abort")).success).toBe(true);
    expect(await turn).toMatchObject({
      success: false,
      error: { code: "PI_SDK_ABORTED" },
    });
    expect(f.requests).toHaveLength(1);
    // The interrupted turn keeps its history; the next message continues instead
    // of failing with PI_SDK_SESSION_MISSING.
    await host.stop();
    f.behavior.pause = false;
    f.behavior.tool = "";
    expect(
      await (await f.launch({ historyRequired: true })).request(
        "prompt",
        "Continue after stop",
      ),
    ).toMatchObject({ success: true });
  }, 60000);
  it("reports model failures as fixed reasons without provider text", async () => {
    const f = await setup();
    f.behavior.tool = "";
    f.behavior.streamCompletion = async (response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "upstream-secret unavailable" } }),
      );
    };
    const host = await f.launch();
    const unavailable = await host.request("prompt", "Provider outage");
    expect(unavailable).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "HTTP_503" },
    });
    expect(JSON.stringify(unavailable)).not.toContain("upstream-secret");
    f.behavior.streamCompletion = async (response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "api_error",
            code: "TOOLPLANE_MODEL_GATEWAY_FAILED",
            message: "TOOLPLANE_MODEL_GATEWAY_FAILED",
          },
        }),
      );
    };
    expect(
      await host.request("prompt", "Gateway internal failure"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "GATEWAY_ERROR" },
    });
    const closed = createServer();
    await once(closed.listen(0, "127.0.0.1"), "listening");
    const { port } = closed.address() as { port: number };
    await once(closed.close(), "close");
    expect(
      await host.request("prompt", "Wrong runtime origin", {
        ...f.context,
        model: { ...f.config.model, baseUrl: `http://127.0.0.1:${port}/v1` },
      }),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "UNREACHABLE" },
    });
  }, 60000);
  it("retries an empty gateway stream within the turn budget, then reports the reason and retry count", async () => {
    const f = await setup();
    f.behavior.tool = "";
    let empty = 1;
    f.behavior.streamCompletion = async (response) => {
      if (empty-- > 0) return emptyStream(response);
      completion(response, { content: "RECOVERED" }, "stop");
    };
    const host = await f.launch();
    expect(
      await host.request("prompt", "Retry once", {
        ...f.context,
        modelRetries: 2,
      }),
    ).toMatchObject({ success: true, result: { text: "RECOVERED" } });
    expect(f.requests).toHaveLength(2);
    // The failed attempt is not replayed to the model as an assistant turn.
    expect(f.requests[1].body.messages.at(-1)?.role).toBe("user");

    f.behavior.streamCompletion = async (response) => emptyStream(response);
    const exhausted = await host.request("prompt", "Keep failing", {
      ...f.context,
      modelRetries: 1,
    });
    expect(exhausted).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "EMPTY_STREAM RETRIED_1" },
    });
    expect(f.requests).toHaveLength(4);

    // Retries off: one request, no retry count.
    expect(
      await host.request("prompt", "No retry", {
        ...f.context,
        modelRetries: 0,
      }),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "EMPTY_STREAM" },
    });
    expect(f.requests).toHaveLength(5);
  }, 60000);
  it("exhausts same-model retries before switching gateways without duplicating the prompt, then resets next turn", async () => {
    const f = await setup();
    f.behavior.tool = "";
    f.behavior.streamCompletion = async (response) => {
      if (f.requests.at(-1)?.body.model === "controlled") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "private upstream outage" } }),
        );
      } else completion(response, { content: "FALLBACK_RECOVERED" }, "stop");
    };
    const host = await f.launch();
    const result = await host.request("prompt", "Use the fallback", {
      ...f.context,
      model: { ...f.config.model, toolplaneProviderId: "primary" },
      modelRetries: 1,
      fallbackModels: [
        {
          ...f.config.model,
          provider: "toolplane-secondary",
          id: "backup",
          toolplaneProviderId: "secondary",
          baseUrl: f.config.model.baseUrl.replace("/v1", "/secondary/v1"),
        },
      ],
    });
    expect(result).toMatchObject({
      success: true,
      result: {
        text: "FALLBACK_RECOVERED",
        actualModel: { providerId: "secondary", model: "backup" },
        usage: {
          actualModel: { providerId: "secondary", model: "backup" },
          modelUsage: expect.arrayContaining([
            expect.objectContaining({
              providerId: "secondary",
              model: "backup",
              inputTokens: 20,
            }),
          ]),
        },
      },
    });
    expect(f.requests.map((request) => request.body.model)).toEqual([
      "controlled",
      "controlled",
      "backup",
    ]);
    expect(f.requests.at(-1)?.path).toBe("/secondary/v1/chat/completions");
    for (const request of f.requests)
      expect(
        request.body.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    f.behavior.streamCompletion = undefined;
    expect(await host.request("prompt", "Next turn")).toMatchObject({
      success: true,
    });
    expect(f.requests.at(-1)?.body.model).toBe("controlled");
  }, 60000);
  it("never switches models or replays a native tool after its execution starts", async () => {
    const f = await setup();
    f.behavior.streamCompletion = async (response) => {
      if (f.requests.at(-1)?.body.messages.at(-1)?.role === "tool") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unavailable" } }));
      } else
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "once",
                type: "function",
                function: { name: "increment", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
    };
    const result = await (await f.launch()).request(
      "prompt",
      "Increment once",
      { ...f.context, fallbackModels: [{ ...f.config.model, id: "backup" }] },
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "HTTP_503" },
    });
    expect(f.requests.map((request) => request.body.model)).toEqual([
      "controlled",
      "controlled",
    ]);
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
  }, 60000);
  it("does not use fallback for a non-retryable provider rejection", async () => {
    const f = await setup();
    f.behavior.streamCompletion = async (response) => {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: "private rejection" } }));
    };
    const result = await (await f.launch()).request("prompt", "Rejected", {
      ...f.context,
      fallbackModels: [{ ...f.config.model, id: "backup" }],
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "HTTP_401" },
    });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private rejection");
  }, 60000);

  it("rewinds real native tool results out of the next model request while retaining the report and abandoned tree across resume", async () => {
    const f = await setup();
    const options = {
      optionalBuiltinExtensions: ["checkpoint", "rewind", "context_notes"].map(
        (name) => resolve(`scripts/pi-optional-tools/${name}.mjs`),
      ),
      defaultTools: ["checkpoint", "rewind", "context_notes", "bash"],
    };
    let host = await f.launch(options);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      let sent = false;
      f.behavior.streamCompletion = async (response) => {
        if (sent)
          return completion(
            response,
            { content: "CONTINUE_FROM_REPORT" },
            "stop",
          );
        sent = true;
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          "tool_calls",
        );
      };
      const result = await host.request("prompt", `Use ${name}`);
      expect(
        result,
        JSON.stringify({ result, output: host.output() }),
      ).toMatchObject({ success: true });
      return result;
    };
    await invoke("context_notes", {
      action: "add",
      text: "CHECKPOINT_BRANCH_NOTE",
    });
    await invoke("checkpoint", { goal: "Explore and report" });
    await invoke("bash", { command: "printf 'ABANDONED_NATIVE_RESULT_ONE'" });
    await invoke("bash", { command: "printf 'ABANDONED_NATIVE_RESULT_TWO'" });
    await invoke("context_notes", {
      action: "add",
      text: "ABANDONED_BRANCH_NOTE",
    });
    await host.stop();
    host = await f.launch({ ...options, historyRequired: true });
    const report = "RETAINED_FINDINGS: exploration established the safe path.";
    const rewound = await invoke("rewind", { report });
    const nextProviderContext = JSON.stringify(
      f.requests.at(-1)?.body.messages,
    );
    expect(nextProviderContext).toContain(report);
    expect(nextProviderContext).not.toContain("ABANDONED_NATIVE_RESULT_ONE");
    expect(nextProviderContext).not.toContain("ABANDONED_NATIVE_RESULT_TWO");
    expect(nextProviderContext).toContain("CHECKPOINT_BRANCH_NOTE");
    expect(nextProviderContext).not.toContain("ABANDONED_BRANCH_NOTE");
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "context_maintenance",
        marker: expect.objectContaining({ kind: "rewind", report }),
      }),
    );
    const journal = await readFile(
      assertDefined(rewound.result).state.sessionFile,
      "utf8",
    );
    expect(journal).toContain("ABANDONED_NATIVE_RESULT_ONE");
    expect(journal).toContain("ABANDONED_NATIVE_RESULT_TWO");
    expect(journal).toContain('"type":"branch_summary"');
    await host.stop();
    host = await f.launch({ ...options, historyRequired: true });
    f.behavior.streamCompletion = async (response) =>
      completion(response, { content: "RESUMED_REPORT" }, "stop");
    expect(await host.request("prompt", "Continue after rewind")).toMatchObject(
      { success: true },
    );
    const resumedContext = JSON.stringify(f.requests.at(-1)?.body.messages);
    expect(resumedContext).toContain(report);
    expect(resumedContext).not.toContain("ABANDONED_NATIVE_RESULT_ONE");
    expect(resumedContext).not.toContain("ABANDONED_NATIVE_RESULT_TWO");
    expect(resumedContext).toContain("CHECKPOINT_BRANCH_NOTE");
    expect(resumedContext).not.toContain("ABANDONED_BRANCH_NOTE");
    await host.stop();
  }, 60000);

  it("generates a handoff with the admitted model, commits compaction, and preserves branch notes through compaction and resume", async () => {
    const f = await setup();
    const options = {
      optionalBuiltinExtensions: [
        resolve("scripts/pi-optional-tools/context_notes.mjs"),
      ],
      defaultTools: ["context_notes"],
    };
    let host = await f.launch(options);
    const note = "PERSISTENT_BRANCH_NOTE";
    const invoke = async (args: Record<string, unknown>) => {
      let sent = false;
      f.behavior.streamCompletion = async (response) => {
        if (sent)
          return completion(response, { content: "NOTES_DONE" }, "stop");
        sent = true;
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: {
                  name: "context_notes",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
          "tool_calls",
        );
      };
      const result = await host.request("prompt", "Maintain branch notebook");
      expect(
        result,
        JSON.stringify({ result, output: host.output() }),
      ).toMatchObject({ success: true });
      return result;
    };
    const added = await invoke({ action: "add", text: note });
    const sessionFile = assertDefined(added.result).state.sessionFile;
    const entries = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const noteId = entries.find(
      (entry) => entry.customType === "toolplane.context-notes",
    ).data.notes[0].id;
    for (let turn = 1; turn <= 4; turn++) {
      f.behavior.streamCompletion = async (response) =>
        completion(response, { content: `ROUND_${turn}` }, "stop");
      expect(
        await host.request("prompt", `Recent round ${turn}`),
      ).toMatchObject({ success: true });
    }
    const document =
      "## Goal\nContinue safely\n## Completed\nExploration\n## In progress\nImplementation\n## Key files\nworker.ts\n## Next steps\nFinish the change";
    f.behavior.streamCompletion = async (response) =>
      completion(response, { content: document }, "stop");
    const requestsBefore = f.requests.length;
    const handedOff = await host.request(
      "prompt",
      "/handoff focus on remaining work",
    );
    expect(
      handedOff,
      JSON.stringify({ handedOff, output: host.output() }),
    ).toMatchObject({
      success: true,
      result: {
        text: document,
        commandResult: { command: "handoff", status: "completed" },
      },
    });
    expect(f.requests).toHaveLength(requestsBefore + 1);
    expect(f.requests.at(-1)?.body.model).toBe(f.config.model.id);
    expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(
      "focus on remaining work",
    );
    expect(host.events).toContainEqual(
      expect.objectContaining({
        type: "context_maintenance",
        marker: expect.objectContaining({ kind: "handoff", summary: document }),
      }),
    );
    const compacted = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const compaction = compacted.findLast(
      (entry) => entry.type === "compaction",
    );
    expect(compaction).toMatchObject({
      summary: document,
      details: { method: "handoff" },
    });
    expect(
      compacted.find((entry) => entry.id === compaction.firstKeptEntryId)
        .message.content,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Recent round 2" }),
      ]),
    );
    await host.stop();
    host = await f.launch({ ...options, historyRequired: true });
    await invoke({ action: "list" });
    expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(note);
    expect(JSON.stringify(f.requests.at(-1)?.body.messages)).toContain(
      "Recent round 4",
    );
    await invoke({ action: "remove", id: noteId });
    const removed = host.events
      .filter((event) => event.type === "tool_execution_end")
      .at(-1);
    expect(removed).toMatchObject({
      isError: false,
      result: { details: { notes: [] } },
    });
    await invoke({ action: "add", text: "x".repeat(17000) });
    expect(
      host.events.filter((event) => event.type === "tool_execution_end").at(-1),
    ).toMatchObject({ isError: true });
    const afterLimit = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      afterLimit.findLast(
        (entry) => entry.customType === "toolplane.context-notes",
      ).data.notes,
    ).toEqual([]);
    await host.stop();
  }, 60000);
});
