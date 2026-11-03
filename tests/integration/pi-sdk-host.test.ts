// @vitest-environment node
import { assertDefined } from "../assert-defined";
import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
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
    state: SdkState;
  };
  error?: { code: string };
};
type RequestContext = {
  runtimeToken: string;
  uiUrl?: string;
  mcpConfig: { servers: unknown[] };
  model: Record<string, unknown>;
  reasoningEffort?: string;
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
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"),
    agentDir = join(root, "private"),
    sessionsDir = join(root, "sessions");
  const requestEvents = new EventEmitter();
  await Promise.all(
    [workspace, agentDir, sessionsDir].map((path) => mkdir(path)),
  );
  const requests: Array<{
    authorization?: string;
    path?: string;
    body: {
      model: string;
      messages: Array<{ role: string }>;
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
    toolArgs: "{}",
    completionText: "SDK_COMPLETE",
    promptTokens: 20,
    mcpTool: "current_mcp",
    streamCompletion: undefined as
      | ((response: ServerResponse) => Promise<void>)
      | undefined,
    mcpSchema: { type: "object", properties: {} } as Record<string, unknown>,
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
      requests.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      });
      requestEvents.emit("request");
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
    sdkVersion: "0.87.1",
    packageRoot: resolve("."),
    cwd: workspace,
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
  async function launch(overrides = {}) {
    const configPath = join(agentDir, `config-${randomUUID()}.json`);
    await writeFile(configPath, JSON.stringify({ ...config, ...overrides }));
    const child = spawn(
      process.execPath,
      [resolve("scripts/pi-sdk-session.mjs"), configPath],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
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
    ) {
      const id = randomUUID();
      const result = new Promise<SdkResponse>((done, reject) =>
        pending.set(id, { resolve: done, reject }),
      );
      assertDefined(child.stdin).write(
        `${JSON.stringify({ id, type, message, context: current })}\n`,
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
    );
    expect(compacted.success).toBe(true);
    const result = assertDefined(compacted.result);
    expect(result.text).toContain("NATIVE_SUMMARY_FROM_PROVIDER");
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
    expect(assertDefined(continued.result).state).toMatchObject({
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
    });
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain(
      "NATIVE_SUMMARY_FROM_PROVIDER",
    );
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
          buildPiMcpConfig([
            {
              deploymentId: "toolplane-runtime",
              url: f.config.model.baseUrl.replace("/v1", "/mcp"),
            },
          ]),
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
      mcpConfig: JSON.parse(buildPiMcpConfig([server])),
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
      mcpConfig: JSON.parse(buildPiMcpConfig([server])),
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
        buildPiMcpConfig([{ ...server, url: `${server.url}-next` }]),
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
});
