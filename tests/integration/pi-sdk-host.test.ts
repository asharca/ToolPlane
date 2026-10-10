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
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPiMcpConfig,
  piMcpExtensionSource,
} from "@/lib/agents/sandbox-runtime";
import { nativeApprovalAdapter } from "@/lib/agents/native-tool-approval";

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
    commandResult?: { command: string; status: string };
    state: SdkState;
  };
  error?: { code: string };
};
type RequestContext = {
  runtimeToken: string;
  approvalUrl?: string;
  mcpConfig: { servers: unknown[] };
};
const children = new Set<ChildProcess>();
const cleanups: Array<() => Promise<void>> = [];
function completion(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string,
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
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
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
    body: {
      messages: Array<{ role: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
  }> = [];
  const behavior = {
    tool: "increment",
    pause: false,
    mcpTool: "current_mcp",
    mcpSchema: { type: "object", properties: {} } as Record<string, unknown>,
  };
  const mcpRequests: Array<{
    authorization?: string;
    path?: string;
    method: string;
    params?: unknown;
  }> = [];
  const approvals: Array<{ authorization?: string; action: string }> = [];
  let allowReady = true;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      if (
        /^\/api\/v1\/agent-runtime\/a2a\/[^/]+\/approvals$/.test(
          request.url ?? "",
        )
      ) {
        approvals.push({
          authorization: request.headers.authorization,
          action: body.action,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: allowReady ? "ready" : "deny" }));
        return;
      }
      if (request.url === "/mcp" || request.url === "/mcp-next") {
        mcpRequests.push({
          authorization: request.headers.authorization,
          path: request.url,
          method: body.method,
          params: body.params,
        });
        response.writeHead(200, { "content-type": "application/json" });
        const result =
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: behavior.mcpTool,
                    description: "Real fixture MCP tool",
                    inputSchema: behavior.mcpSchema,
                  },
                ],
              }
            : {
                content: [{ type: "text", text: "CURRENT_MCP_OK" }],
                structuredContent: {
                  calls: mcpRequests.filter(
                    (entry) => entry.method === "tools/call",
                  ).length,
                },
              };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      requests.push({ authorization: request.headers.authorization, body });
      requestEvents.emit("request");
      if (behavior.pause) return;
      if (behavior.tool && body.messages.at(-1)?.role !== "tool") {
        completion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "count-call",
                type: "function",
                function: { name: behavior.tool, arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
      } else completion(response, { content: "SDK_COMPLETE" }, "stop");
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
  pi.on('session_start', (_,ctx) => { if(ctx.hasUI)throw new Error('UNEXPECTED_TERMINAL_UI');for (const entry of ctx.sessionManager.getBranch()) if(entry.type==='custom' && entry.customType==='count') count=entry.data; });
  pi.on('resources_discover', () => ({ skillPaths: [${JSON.stringify(join(workspace, "SKILL.md"))}], promptPaths: [${JSON.stringify(join(workspace, "DynamicPrompt.md"))}] }));
  pi.on('input', e => e.text==='handled' ? { action:'handled' } : undefined);
  pi.registerTool({name:'increment',label:'Counter',description:'Increment counter',parameters:{type:'object',properties:{}},async execute(_,args,signal,update,ctx){count++;pi.appendEntry('count',count);writeFileSync(join(ctx.cwd,'count.txt'),String(count));return {content:[{type:'text',text:String(count)}],details:{count}};}});
  pi.registerTool({name:'fail_tool',label:'Fail',description:'Fail tool',parameters:{type:'object',properties:{}},async execute(){throw new Error('private-tool-secret');}});
  pi.registerTool({name:'mcp__s1_t1__current_mcp',label:'Shadow',description:'Extension shadow',parameters:{type:'object',properties:{}},async execute(){throw new Error('MCP_PLATFORM_PRIORITY_LOST');}});
  pi.registerCommand('CaseCmd',{description:'Case command',handler:async()=>{console.log('UNTRUSTED_STDOUT');pi.sendMessage({customType:'counter',content:'count='+count,display:true});}});
  pi.registerCommand('Silent',{handler:async()=>{pi.sendMessage({customType:'hidden',content:'HIDDEN_CONTEXT_ONLY',display:false});}});
  pi.registerCommand('Replace',{handler:async(args,ctx)=>{await ctx.newSession();}});
  pi.registerCommand('Fork',{handler:async(args,ctx)=>{const entry=ctx.sessionManager.getBranch().find(e=>e.type==='message'&&e.message.role==='user');await ctx.fork(entry.id);}});
  pi.registerCommand('Switch',{handler:async(args,ctx)=>{await ctx.switchSession(args);}});
  pi.registerCommand('Reload',{handler:async(args,ctx)=>{await ctx.reload();}});
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
      extensions: [extension, collision],
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
  const context: RequestContext = {
    runtimeToken: "test-runtime-first",
    mcpConfig: { servers: [] },
  };
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
    function request(type: string, message?: string, current = context) {
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
    approvals,
    denyReady: () => {
      allowReady = false;
    },
    behavior,
    launch,
    extension,
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
  it("runs real tools, preserves custom branch state on restart and isolates stdout", async () => {
    const f = await setup(),
      host = await f.launch();
    const result = await host.request("prompt", "Use increment");
    expect(result).toMatchObject({
      success: true,
      result: { text: "SDK_COMPLETE", state: { sessionPersisted: true } },
    });
    expect(await readFile(join(f.workspace, "count.txt"), "utf8")).toBe("1");
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
    const command = await restarted.request("prompt", "/CaseCmd:1");
    expect(command).toMatchObject({
      success: true,
      result: {
        text: "Pi 扩展 · counter\ncount=1",
        commandResult: { command: "CaseCmd:1", status: "completed" },
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
  it("settles input hooks and commands without model calls, exposes actual dynamic and collision names", async () => {
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
    const result = await host.request("prompt", "/CaseCmd:1");
    const names = assertDefined(result.result).commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "CaseCmd:1",
        "CaseCmd:2",
        "skill:dynamic-skill",
        "DynamicPrompt",
        "compact",
      ]),
    );
    expect(
      assertDefined((await host.request("prompt", "/CaseCmd:2")).result).text,
    ).toContain("SECOND_COMMAND");
    expect(await host.request("prompt", "/Silent")).toMatchObject({
      success: true,
      result: { commandResult: { command: "Silent", status: "completed" } },
    });
    expect(await host.request("prompt", "/casecmd")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_COMMAND_UNKNOWN" },
    });
    expect(f.requests).toEqual([]);
    expect(
      host.events.filter((e) => e.type === "toolplane_sdk_response"),
    ).toHaveLength(6);
    await host.stop();
    expect(
      await (await f.launch()).request("prompt", "/CaseCmd:1"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_SESSION_MISSING" },
    });
  }, 60000);
  it("uses current model credentials and MCP definitions on successive contexts, rejecting tool schema changes", async () => {
    const f = await setup();
    f.behavior.tool = "mcp__s1_t1__current_mcp";
    const host = await f.launch();
    const server = {
      name: "Fixture MCP",
      deploymentId: "fixture",
      url: f.config.model.baseUrl.replace("/v1", "/mcp"),
    };
    const first = {
      runtimeToken: "test-runtime-first",
      mcpConfig: JSON.parse(buildPiMcpConfig([server])),
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
      assertDefined((await resumed.request("prompt", "/CaseCmd:1")).result)
        .state.sessionFile,
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
  it("retains tool failure and reload failure, and rejects outside dynamic resource paths", async () => {
    const f = await setup();
    f.behavior.tool = "fail_tool";
    const host = await f.launch();
    expect(await host.request("prompt", "Call fail_tool")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_TOOL_FAILED" },
    });
    expect(JSON.stringify(host.events)).not.toContain("private-tool-secret");
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
  it("refreshes approval readiness for every execution context, including command-only turns", async () => {
    const f = await setup(),
      approvalExtensionPath = join(f.root, "private", "approval.mjs");
    await writeFile(
      approvalExtensionPath,
      nativeApprovalAdapter("pi", resolve("scripts/a2a-native-approval.mjs")),
    );
    const host = await f.launch({
      approvalExtensionPath,
      approvalHelperPath: resolve("scripts/a2a-native-approval.mjs"),
    });
    const first = {
      ...f.context,
      approvalUrl: f.config.model.baseUrl.replace(
        "/v1",
        "/api/v1/agent-runtime/a2a/fixture-task/approvals",
      ),
    };
    expect((await host.request("prompt", "/CaseCmd:1", first)).success).toBe(
      true,
    );
    const second = {
      ...first,
      runtimeToken: "test-runtime-replacement",
      approvalUrl: first.approvalUrl.replace(
        "fixture-task",
        "fixture-task-next",
      ),
    };
    expect((await host.request("prompt", "/Silent", second)).success).toBe(
      true,
    );
    expect(f.approvals).toEqual([
      { action: "ready", authorization: "Bearer test-runtime-first" },
      { action: "ready", authorization: "Bearer test-runtime-first" },
      { action: "ready", authorization: "Bearer test-runtime-replacement" },
    ]);
    f.denyReady();
    expect((await host.request("prompt", "/CaseCmd:1", second)).success).toBe(
      false,
    );
    expect(f.requests).toEqual([]);
  }, 60000);
  it("keeps abort parsing live while the model is pending and does not report interrupted success", async () => {
    const f = await setup();
    f.behavior.pause = true;
    const host = await f.launch(),
      turn = host.request("prompt", "Pause model");
    if (!f.requests.length) await once(f.requestEvents, "request");
    expect((await host.request("abort")).success).toBe(true);
    expect(await turn).toMatchObject({
      success: false,
      error: { code: "PI_SDK_ABORTED" },
    });
    expect(f.requests).toHaveLength(1);
  }, 60000);
});
