// @vitest-environment node
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { stopNativeSessionHosts } from "../../scripts/native-runtime-stop.mjs";
import {
  createAdvisor,
  ADVISOR_REVIEW_TIMEOUT_MS,
} from "../../scripts/pi-sdk-advisor.mjs";

it.each(["deadline", "cancel"] as const)(
  "releases a nonresponsive advisor on %s",
  async (mode) => {
    vi.useFakeTimers();
    try {
      const events: Array<Record<string, unknown>> = [];
      const messages: Array<{ role: string; content: string }> = [];
      let stopped = false;
      let requestSignal: AbortSignal | undefined;
      const session = {
        messages,
        systemPrompt: "Review the task",
        steer: vi.fn(),
        followUp: vi.fn(),
      };
      const advisor = createAdvisor({
        modelRuntime: {
          registerProvider: vi.fn(),
          setRuntimeApiKey: vi.fn(),
          removeRuntimeApiKey: vi.fn(async () => {}),
          completeSimple: vi.fn(
            (
              _model: unknown,
              _context: unknown,
              options: { signal: AbortSignal },
            ) => {
              requestSignal = options.signal;
              // Exercise a provider that ignores cancellation and never resolves.
              return Promise.withResolvers().promise;
            },
          ),
        },
        emit: (event: Record<string, unknown>) => events.push(event),
        onUsage: vi.fn(),
        getSession: () => session,
        isAborted: () => stopped,
        getFailureReason: () => "PROVIDER_ERROR",
      });
      await advisor.start(
        { model: {}, cadence: "final", minSeverity: "info" },
        "token",
        "request",
      );
      messages.push({ role: "user", content: "Complete the task" });
      const review = advisor.review({
        message: { stopReason: "stop" },
        toolResults: [],
      });
      if (mode === "deadline")
        await vi.advanceTimersByTimeAsync(ADVISOR_REVIEW_TIMEOUT_MS);
      else {
        stopped = true;
        advisor.cancel();
      }
      await review;
      expect(requestSignal?.aborted).toBe(true);
      expect(session.followUp).not.toHaveBeenCalled();
      if (mode === "deadline")
        expect(events).toEqual([
          {
            type: "advisor_error",
            code: "ADVISOR_REVIEW_FAILED",
            reason: "TIMEOUT",
            durationMs: ADVISOR_REVIEW_TIMEOUT_MS,
          },
        ]);
      else expect(events).toEqual([]);
      await advisor.finish();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([
  "each_tool_batch",
  "final",
  "wrapped",
  "prose",
  "invalid",
  "http-error",
  "truncated",
  "truncated-json",
] as const)(
  "reviews through the real SDK and broker without blocking the main turn (%s)",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "toolplane-advisor-"));
    const driver = join(process.cwd(), "scripts/native-runtime-session.mjs");
    const host = join(process.cwd(), "scripts/pi-sdk-session.mjs");
    const statePath = join(dir, "state.json");
    const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
    const configPath = join(dir, "config.json");
    const inputPath = join(dir, "request.json");
    const extension = join(dir, "counter.mjs");
    const requests: Array<{
      model: string;
      messages: unknown[];
      reasoning_effort?: string;
      max_completion_tokens?: number;
    }> = [];
    let mainCalls = 0;
    const gateway = createHttpServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw);
        requests.push(body);
        expect(req.headers.authorization).toBe("Bearer advisor-test-token");
        const review = body.model === "reviewer";
        if (review && mode === "http-error") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "private-provider-diagnostic" },
            }),
          );
          return;
        }
        if (!review) mainCalls++;
        const tool = !review && mode === "each_tool_batch" && mainCalls === 1;
        let content = review
          ? mode === "invalid"
            ? "not JSON"
            : JSON.stringify([
                { severity: "info", message: "Cosmetic detail" },
                {
                  severity: "warning",
                  message: "Check the tool result before finishing",
                },
                {
                  severity: "critical",
                  message: "Verify the missing requirement",
                },
              ])
          : mainCalls > 1
            ? "MAIN_CONTINUES"
            : "MAIN_COMPLETE";
        if (review && mode === "wrapped")
          content = `<think>Ignore this reasoning: [{"severity":"critical","message":"REASONING_ONLY"}]</think>\nHere are the findings:\n\`\`\`json\n${content}\n\`\`\`\nReview complete.`;
        if (review && mode === "prose")
          content = `Not JSON: [invalid] then findings: ${content} Done.`;
        if (review && mode === "truncated")
          content = "<think>Unfinished internal reasoning";
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "counter-1",
                  type: "function",
                  function: { name: "increment", arguments: "{}" },
                },
              ],
            }
          : {
              role: "assistant",
              content,
              ...(review ? { reasoning_content: "REASONING_ONLY" } : {}),
            };
        for (const chunk of [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: tool
                  ? "tool_calls"
                  : review && mode.startsWith("truncated")
                    ? "length"
                    : "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          },
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixed", object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    const listening = Promise.withResolvers<void>();
    gateway.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    let daemon: ChildProcess | undefined;
    try {
      const address = gateway.address();
      if (!address || typeof address === "string")
        throw new Error("No gateway address");
      const home = join(dir, "home");
      const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local/state"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NODE_CHANNEL_FD: undefined,
        NODE_CHANNEL_SERIALIZATION_MODE: undefined,
      };
      await mkdir(join(dir, "sessions"));
      await mkdir(join(dir, "private"));
      await writeFile(
        extension,
        `export default pi => { pi.registerTool({name:'increment',label:'Counter',description:'Count',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'COUNTER_OK'}],details:{count:1}};}}); };`,
      );
      await writeFile(
        join(dir, "mcp.mjs"),
        "export async function createPiMcpTools(){return [];}",
      );
      const model = {
        id: "primary",
        toolplaneProviderId: "primary-provider",
        name: "Primary",
        provider: "toolplane",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      await writeFile(
        configPath,
        JSON.stringify({
          sdkVersion: "1.5.2",
          compatibleSdkVersions: ["1.5.2"],
          packageRoot: process.cwd(),
          cwd: dir,
          workspaceRoot: dir,
          sharedDir: join(dir, "shared"),
          agentDir: join(dir, "private"),
          sessionsDir: join(dir, "sessions"),
          statePath,
          packageSetChecksum: "empty",
          agentRevisionId: "pinned",
          model,
          systemPrompt: "Verify results before finishing.",
          defaultTools: [],
          excludeTools: [],
          packages: [],
          resources: {
            extensions: [extension],
            skills: [],
            prompts: [],
            themes: [],
          },
          packageVerifierPath: join(
            process.cwd(),
            "scripts/pi-sdk-package-files.mjs",
          ),
          mcpFactoryPath: join(dir, "mcp.mjs"),
          hostOnlyCommands: [],
        }),
      );
      await writeFile(
        inputPath,
        JSON.stringify({
          kind: "pi-sdk",
          binary: process.execPath,
          args: [host, configPath],
          cwd: dir,
          statePath,
          signature: "advisor",
          message: "Complete this task",
          context: {
            runtimeToken: "advisor-test-token",
            model,
            mcpConfig: { servers: [] },
            advisor: {
              providerId: "review-provider",
              model: {
                ...model,
                id: "reviewer",
                toolplaneProviderId: "review-provider",
                provider: "toolplane-advisor",
                reasoning: true,
              },
              cadence: mode === "each_tool_batch" ? mode : "final",
              minSeverity: "warning",
            },
          },
        }),
      );
      daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
        env,
        stdio: "ignore",
      });
      await expect
        .poll(() => existsSync(socketPath), { timeout: 10000 })
        .toBe(true);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [driver, inputPath],
        { env, timeout: 20000 },
      );
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const result = events.find(
        (event) => event.type === "toolplane_sdk_response",
      );
      expect(result.success).toBe(true);
      expect(result.result.usage.modelUsage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: "primary-provider",
            model: "primary",
          }),
          expect.objectContaining({
            providerId: "review-provider",
            model: "reviewer",
          }),
        ]),
      );
      expect(
        requests.filter((request) => request.model === "reviewer"),
      ).toHaveLength(1);
      expect(
        requests.find((request) => request.model === "reviewer")
          ?.reasoning_effort,
      ).toBe("minimal");
      expect(
        requests.find((request) => request.model === "reviewer")
          ?.max_completion_tokens,
      ).toBe(8192);
      if (
        mode === "invalid" ||
        mode === "http-error" ||
        mode.startsWith("truncated")
      ) {
        expect(mainCalls).toBe(1);
        expect(result.result.text).toContain("MAIN_COMPLETE");
        expect(
          events.find((event) => event.type === "advisor_error"),
        ).toMatchObject({
          code: "ADVISOR_REVIEW_FAILED",
          reason:
            mode === "invalid"
              ? "INVALID_OUTPUT"
              : mode === "http-error"
                ? "HTTP_503"
                : "OUTPUT_TRUNCATED",
        });
        expect(JSON.stringify(events)).not.toContain(
          "private-provider-diagnostic",
        );
        expect(result.result.advisories).toBeUndefined();
      } else {
        expect(mainCalls).toBe(2);
        expect(result.result.text).toContain("MAIN_CONTINUES");
        const advice = events.find(
          (event) => event.type === "advisor_suggestions",
        ).advisory;
        expect(
          advice.suggestions.map((note: { severity: string }) => note.severity),
        ).toEqual(["critical", "warning"]);
        expect(result.result.advisories).toEqual([advice]);
        expect(
          JSON.stringify(
            requests.filter((request) => request.model === "primary").at(-1)
              ?.messages,
          ),
        ).toContain("Verify the missing requirement");
        expect(JSON.stringify(advice)).not.toContain("REASONING_ONLY");
      }
      // Invalid JSON consumes tokens; an HTTP rejection carries Pi's zero-token usage.
      if (mode === "http-error") {
        expect(result.result.advisorUsage).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
        });
        expect(result.result.usage.inputTokens).toBe(20);
      } else {
        expect(result.result.advisorUsage).toMatchObject({
          inputTokens: 20,
          outputTokens: 5,
        });
        expect(result.result.usage.inputTokens).toBe(
          mode === "invalid" || mode.startsWith("truncated") ? 40 : 60,
        );
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const stopped = once(daemon, "exit");
        daemon.kill("SIGTERM");
        await stopped;
      }
      gateway.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      gateway.close(() => closed.resolve());
      await closed.promise;
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);

it("stops only one conversation's resident SDK host while preserving its sibling and saved native state", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolplane-session-stop-"));
  const driver = join(process.cwd(), "scripts/native-runtime-session.mjs");
  const host = join(process.cwd(), "scripts/pi-sdk-session.mjs");
  const daemons: ChildProcess[] = [];
  // Sibling conversations share one isolated Agent home, not the runner's home.
  const home = join(root, "home");
  const environment = {
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
  };
  const prepare = async (name: string) => {
    const cwd = join(root, name, "workspace");
    const stateRoot = join(root, name, ".toolplane", "runtime");
    const configPath = join(stateRoot, "host", "native.json");
    const statePath = join(stateRoot, "sessions", "native.json");
    const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
    await Promise.all(
      [cwd, join(stateRoot, "host"), join(stateRoot, "sessions", "native")].map(
        (path) => mkdir(path, { recursive: true }),
      ),
    );
    const extension = join(cwd, "counter.mjs");
    const factory = join(stateRoot, "host", "mcp.mjs");
    await writeFile(
      extension,
      "export default pi => { let count=0; pi.registerCommand('Ping',{handler:async()=>{ pi.sendMessage({customType:'counter',content:'count='+ ++count,display:true}); }}); };",
    );
    await writeFile(
      factory,
      "export async function createPiMcpTools(){ return []; }",
    );
    const model = {
      id: "test",
      name: "Test",
      api: "openai-completions",
      provider: "toolplane",
      baseUrl: "http://127.0.0.1:1/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await writeFile(
      configPath,
      JSON.stringify({
        sdkVersion: "1.5.2",
        compatibleSdkVersions: ["1.5.2", "0.87.1"],
        packageRoot: process.cwd(),
        cwd,
        workspaceRoot: join(root, name),
        sharedDir: join(root, "shared"),
        agentDir: stateRoot,
        sessionsDir: join(stateRoot, "sessions", "native"),
        statePath,
        packageSetChecksum: "empty",
        agentRevisionId: "pinned",
        model,
        systemPrompt: "Counter fixture",
        defaultTools: [],
        excludeTools: [],
        packages: [],
        resources: {
          extensions: [extension],
          skills: [],
          prompts: [],
          themes: [],
        },
        packageVerifierPath: join(
          process.cwd(),
          "scripts/pi-sdk-package-files.mjs",
        ),
        mcpFactoryPath: factory,
        hostOnlyCommands: [],
      }),
    );
    const inputPath = join(root, name, "request.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        kind: "pi-sdk",
        binary: process.execPath,
        args: [host, configPath],
        cwd,
        statePath,
        signature: name,
        command: "/Ping",
        context: {
          runtimeToken: `token-${name}`,
          model,
          mcpConfig: { servers: [] },
        },
      }),
    );
    const daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
      stdio: "ignore",
      env: environment,
    });
    daemons.push(daemon);
    await expect
      .poll(() => existsSync(socketPath), { timeout: 10000 })
      .toBe(true);
    const request = async (patch?: Record<string, unknown>) => {
      if (patch)
        await writeFile(
          inputPath,
          JSON.stringify({
            ...JSON.parse(await readFile(inputPath, "utf8")),
            ...patch,
          }),
        );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [driver, inputPath],
        { timeout: 20000, env: environment },
      );
      const result = stdout.trim().split("\n").at(-1);
      if (!result) throw new Error("Native runtime returned no response");
      return JSON.parse(result);
    };
    return { stateRoot, statePath, socketPath, daemon, request };
  };
  try {
    const first = await prepare("first");
    const second = await prepare("second");
    expect(await first.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=1") },
    });
    expect(await second.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=1") },
    });
    // Even a real failed model turn establishes native user identity. Both the
    // failure metadata and fork acknowledgement must survive broker allowlists.
    const failed = await first.request({
      command: null,
      message: "BROKER_NATIVE_USER",
    });
    expect(failed).toMatchObject({
      success: false,
      result: {
        sessionEntries: {
          userEntryId: expect.any(String),
          leafEntryId: expect.any(String),
        },
      },
    });
    const destination = join(root, "branched");
    const forked = await first.request({
      type: "fork",
      entryId: failed.result.sessionEntries.userEntryId,
      target: {
        workspaceRoot: destination,
        cwd: join(destination, "workspace"),
        sessionsDir: join(destination, "sessions"),
        statePath: join(destination, "sessions", "state.json"),
      },
    });
    expect(forked).toMatchObject({
      success: true,
      result: {
        fork: {
          forked: true,
          entryId: failed.result.sessionEntries.userEntryId,
          contextOnly: true,
          filesRewound: false,
          externalEffectsRewound: false,
        },
      },
    });
    expect(
      JSON.parse(
        await readFile(join(destination, "sessions", "state.json"), "utf8"),
      ),
    ).toMatchObject({ sessionPersisted: true, agentRevisionId: "pinned" });
    const stopped = once(first.daemon, "exit");
    await stopNativeSessionHosts(first.stateRoot);
    await stopped;
    expect(existsSync(first.socketPath)).toBe(false);
    expect(existsSync(first.statePath)).toBe(true);
    expect(existsSync(second.socketPath)).toBe(true);
    expect(await second.request()).toMatchObject({
      success: true,
      result: { text: expect.stringContaining("count=2") },
    });
    await stopNativeSessionHosts(first.stateRoot);
  } finally {
    await Promise.all(
      daemons.map(async (daemon) => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) return;
        const stopped = once(daemon, "exit");
        daemon.kill("SIGTERM");
        await stopped;
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("settles real SDK commands without agent_end, rotates context, and kills disconnected process groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toolplane-sdk-daemon-"));
  const home = join(dir, "home");
  const environment = {
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
  };
  const driver = join(process.cwd(), "scripts/native-runtime-session.mjs");
  const host = join(process.cwd(), "scripts/pi-sdk-session.mjs");
  const statePath = join(dir, "state.json");
  const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
  const inputPath = join(dir, "input.json");
  const configPath = join(dir, "config.json");
  const extension = join(dir, "extension.mjs");
  const started = join(dir, "started");
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "agent"));
  await writeFile(
    join(dir, "mcp.mjs"),
    "export async function createPiMcpTools() { return []; }",
  );
  await writeFile(
    extension,
    `
import { writeFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
export default function(pi) {
  let count = 0;
  pi.registerCommand('Case', { description: 'real command', handler: async () => {
    count++;
    pi.sendMessage({ customType: 'daemon-test', content: 'count=' + count, display: true });
    console.log('untrusted stdout must not become protocol');
    // Exercise the broker's non-terminal event lane; state remains host-private.
    writeFileSync(3, JSON.stringify({ type: 'context_maintenance', marker: {
      kind: 'rewind', at: '2026-11-15T00:00:00.000Z', checkpointId: 'checkpoint-node',
      entryId: 'report-node', report: 'Retained investigation report'
    } }) + '\\n');
    writeFileSync(${JSON.stringify(join(dir, "context"))}, process.env.TOOLPLANE_RUNTIME_TOKEN);
    // Exercise the broker's raw tool-event path, distinct from response results.
    writeSync(3, JSON.stringify({ type: 'tool_execution_end', toolCallId: 'edit-patch', toolName: 'edit', patch: '--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new\\n', truncated: true, firstChangedLine: 1 }) + '\\n');
    writeFileSync(3, JSON.stringify({ type: 'tool_execution_end', toolCallId: 'child-call', toolName: 'bash', isError: false, result: 'CHILD_OK', source: { subagentId: 'local-child', subagentName: 'Local child', parentToolCallId: 'task-batch', depth: 1, untrustedExtra: 'discard' } }) + '\\n');
  }});
  pi.registerCommand('Wait', { handler: async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    writeFileSync(${JSON.stringify(started)}, String(child.pid));
    await Promise.withResolvers().promise;
  }});
}
`,
  );
  await writeFile(
    configPath,
    JSON.stringify({
      sdkVersion: "1.5.2",
      compatibleSdkVersions: ["1.5.2", "0.87.1"],
      packageRoot: process.cwd(),
      cwd: dir,
      workspaceRoot: dir,
      sharedDir: join(dir, "agent-shared"),
      agentDir: join(dir, "agent"),
      sessionsDir: join(dir, "sessions"),
      statePath,
      packageSetChecksum: "empty-package-set",
      model: {
        id: "test",
        name: "Test",
        api: "openai-completions",
        provider: "toolplane",
        toolplaneProviderId: "primary",
        baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      systemPrompt: "SDK daemon command fixture",
      defaultTools: [],
      excludeTools: [],
      resources: {
        extensions: [extension],
        skills: [],
        prompts: [],
        themes: [],
      },
      packages: [],
      packageVerifierPath: join(
        process.cwd(),
        "scripts/pi-sdk-package-files.mjs",
      ),
      mcpFactoryPath: join(dir, "mcp.mjs"),
      hostOnlyCommands: [],
    }),
  );
  const job = {
    kind: "pi-sdk",
    runId: "broker-queue-regression",
    binary: process.execPath,
    args: [host, configPath],
    sdkConfigPath: configPath,
    packageRoot: process.cwd(),
    statePath,
    signature: "sdk-stable",
    command: "/Case",
    message: "",
    history: [{ role: "user", text: "never seeded" }],
    context: {
      runtimeToken: "first-test-token",
      mcpConfig: { servers: [] },
      model: JSON.parse(await readFile(configPath, "utf8")).model,
      modelRetries: 0,
      fallbackModels: [] as Array<Record<string, unknown>>,
    },
  };
  await writeFile(inputPath, JSON.stringify(job));
  let daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
    stdio: "ignore",
    env: environment,
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    // Real detached processes/filesystem signals cannot be driven with Vitest fake clocks.
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("SDK daemon fixture timed out");
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }
  };
  try {
    await until(() => existsSync(socketPath));
    const run = async () => {
      await writeFile(inputPath, JSON.stringify(job));
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [driver, inputPath],
        { timeout: 20_000, env: environment },
      );
      return stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    const first = await run();
    const response = first.filter(
      (event) => event.type === "toolplane_sdk_response",
    );
    expect(response).toHaveLength(1);
    expect(response[0], JSON.stringify(response[0])).toMatchObject({
      success: true,
      result: {
        text: expect.stringContaining("count=1"),
        commands: expect.arrayContaining([
          { name: "Case", description: "real command" },
        ]),
        commandResult: {
          command: "Case",
          text: expect.stringContaining("count=1"),
          status: "completed",
        },
        streamRuleTriggers: [],
        // Without a model response the total is Pi's estimate; the broker must keep it.
        contextBreakdown: {
          usedTokens: expect.any(Number),
          estimated: true,
          categories: expect.objectContaining({
            systemPrompt: expect.any(Number),
            messages: expect.any(Number),
          }),
        },
        queue: { messages: [], pendingMessageCount: 0 },
      },
    });
    expect(response[0].result).not.toHaveProperty("state");
    expect(first).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "edit-patch",
        toolName: "edit",
        patch: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
        truncated: true,
        firstChangedLine: 1,
      }),
    );
    expect(first.find((event) => event.toolCallId === "child-call")).toEqual({
      type: "tool_execution_end",
      toolCallId: "child-call",
      toolName: "bash",
      isError: false,
      result: "CHILD_OK",
      source: {
        subagentId: "local-child",
        subagentName: "Local child",
        parentToolCallId: "task-batch",
        depth: 1,
      },
    });
    expect(JSON.stringify(first)).not.toContain("untrusted stdout");
    expect(first).toContainEqual({ type: "context_maintenance", marker: {
      kind: "rewind", at: "2026-11-15T00:00:00.000Z", checkpointId: "checkpoint-node",
      entryId: "report-node", report: "Retained investigation report",
    } });
    expect(first.some((event) => event.type === "agent_end")).toBe(false);
    const sdkState = JSON.parse(await readFile(statePath, "utf8"));
    expect(sdkState).toMatchObject({
      runtimeKind: "pi-sdk",
      sdkVersion: "1.5.2",
      sessionPersisted: false,
    });
    expect(sdkState).not.toHaveProperty("seeded");
    // Command lookup is case-sensitive and failures use the SDK response envelope.
    job.command = "/case";
    const unsupported = await run();
    expect(unsupported).toEqual([
      {
        type: "toolplane_sdk_response",
        id: expect.any(String),
        success: false,
        error: {
          code: "PI_SDK_COMMAND_UNKNOWN",
          message: "PI_SDK_COMMAND_UNKNOWN",
        },
      },
    ]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(sdkState);
    job.command = "/Case";
    job.context.runtimeToken = "second-test-token";
    const second = await run();
    expect(
      second.find((event) => event.type === "toolplane_sdk_response"),
    ).toMatchObject({
      success: true,
      result: {
        text: expect.stringContaining("count=2"),
        commandResult: {
          command: "Case",
          text: expect.stringContaining("count=2"),
          status: "completed",
        },
      },
    });
    expect(await readFile(join(dir, "context"), "utf8")).toBe(
      "second-test-token",
    );
    expect(await readFile(statePath, "utf8")).not.toContain("test-token");
    const socket = createConnection(socketPath);
    await once(socket, "connect");
    socket.write(`${JSON.stringify({ ...job, command: "/Wait" })}\n`);
    await until(() => existsSync(started));
    const descendantPid = Number(await readFile(started, "utf8"));
    const control = (runId: string) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<Record<string, unknown>>();
      const client = createConnection(socketPath);
      let output = "";
      client.once("connect", () =>
        client.write(
          `${JSON.stringify({
            ...job,
            runId,
            control: { type: "clear_queue" },
          })}\n`,
        ),
      );
      client.on("data", (chunk) => {
        output += chunk;
      });
      client.once("error", reject);
      client.once("end", () => resolve(JSON.parse(output.trim())));
      return promise;
    };
    expect(await control("different-round")).toMatchObject({
      success: false,
      error: { code: "PI_SDK_QUEUE_NOT_RUNNING" },
    });
    expect(await control(job.runId)).toMatchObject({
      success: true,
      result: {
        disposition: "cleared",
        queue: { messages: [], pendingMessageCount: 0 },
      },
    });
    // A second socket must not attach to an already-running SDK request.
    const busy = await run();
    expect(busy).toEqual([
      {
        type: "toolplane_sdk_response",
        success: false,
        error: { code: "PI_SDK_BUSY", message: "PI_SDK_BUSY" },
      },
    ]);
    const stopped = once(daemon, "exit");
    socket.destroy();
    await stopped;
    expect(existsSync(socketPath)).toBe(false);
    await until(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    });
    daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
      stdio: "ignore",
      env: environment,
    });
    await until(() => existsSync(socketPath));
    const lost = await run();
    expect(
      lost.find((event) => event.type === "toolplane_sdk_response"),
    ).toMatchObject({
      success: false,
      error: {
        code: "PI_SDK_SESSION_MISSING",
        message: "PI_SDK_SESSION_MISSING",
      },
    });
    // A revision participates in the production signature. An idle old broker
    // must stop before a changed toolset can reach its already-created SDK host.
    const upgradeSocket = createConnection(socketPath);
    await once(upgradeSocket, "connect");
    const upgradeResponse = once(upgradeSocket, "data");
    const upgradedHostStopped = once(daemon, "exit");
    upgradeSocket.write(
      `${JSON.stringify({ ...job, signature: "sdk-new-revision" })}\n`,
    );
    expect(JSON.parse(String((await upgradeResponse)[0]).trim())).toEqual({
      type: "toolplane_session_restart",
    });
    await upgradedHostStopped;
    expect(existsSync(socketPath)).toBe(false);
    // The resident broker re-serializes host responses; model failure reasons
    // must survive it as fixed tokens. The fixture model URL is unreachable.
    await rm(statePath);
    daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
      stdio: "ignore",
      env: environment,
    });
    await until(() => existsSync(socketPath));
    job.command = "";
    job.message = "Reach the model";
    job.context.modelRetries = 1;
    const unreachable = await run();
    expect(
      unreachable.find((event) => event.type === "toolplane_sdk_response"),
    ).toMatchObject({
      success: false,
      error: { code: "PI_SDK_MODEL_FAILED", reason: "UNREACHABLE RETRIED_1" },
      result: {
        actualModel: { providerId: "primary", model: "test" },
        usage: { actualModel: { providerId: "primary", model: "test" } },
      },
    });
    const beforeRuleRestart = once(daemon, "exit");
    daemon.kill("SIGTERM");
    await beforeRuleRestart;
    await rm(statePath);
    const gateway = createServer((request, response) => {
      void (async () => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        const body = JSON.parse(raw);
        const afterTool = body.messages.at(-1)?.role === "tool";
        const delta = afterTool
          ? { content: "BLOCKED_BUT_SUCCEEDED" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "broker-block",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: `printf forbidden > ${JSON.stringify(join(dir, "blocked-by-rule"))}`,
                    }),
                  },
                },
              ],
            };
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
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: afterTool ? "stop" : "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          },
        ])
          response.write(
            `data: ${JSON.stringify({ id: "broker-rules", object: "chat.completion.chunk", created: 1, model: "test", ...chunk })}\n\n`,
          );
        response.end("data: [DONE]\n\n");
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    try {
      const address = gateway.address();
      if (!address || typeof address === "string")
        throw new Error("Missing gateway address");
      const rule = {
        id: "broker-shell",
        name: "Broker shell rule",
        target: "tool_call",
        toolName: "bash",
        pattern: "blocked-by-rule",
        action: "block",
        message: "Shell write blocked by stream rule.",
      };
      const hostConfig = JSON.parse(await readFile(configPath, "utf8"));
      await writeFile(
        configPath,
        JSON.stringify({
          ...hostConfig,
          defaultTools: ["bash"],
          streamRules: [rule],
        }),
      );
      job.context.model = {
        ...job.context.model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      };
      job.context.modelRetries = 0;
      job.message = "Call bash";
      daemon = spawn(process.execPath, [driver, inputPath, "serve"], {
        stdio: "ignore",
        env: environment,
      });
      await until(() => existsSync(socketPath));
      const events = await run();
      expect(
        events.find((event) => event.type === "stream_rule_triggered"),
      ).toMatchObject({
        trigger: {
          ruleId: rule.id,
          action: "block",
          toolName: "bash",
          toolCallId: "broker-block",
          message: rule.message,
        },
      });
      expect(
        events.find((event) => event.type === "toolplane_sdk_response"),
      ).toMatchObject({
        success: true,
        result: {
          text: "BLOCKED_BUT_SUCCEEDED",
          streamRuleTriggers: [
            expect.objectContaining({ ruleId: rule.id, action: "block" }),
          ],
        },
      });
      expect(existsSync(join(dir, "blocked-by-rule"))).toBe(false);
    } finally {
      gateway.closeAllConnections();
      gateway.close();
      await once(gateway, "close");
    }
    {
      // Exercise real HTTP requests, Pi continuation and the broker whitelist together.
      const attempts: string[] = [];
      const gateway = createServer((request, response) => {
        void (async () => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          const input = JSON.parse(raw);
          attempts.push(input.model);
          if (input.model === "primary") {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ error: { message: "private upstream outage" } }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({ id: "fallback", object: "chat.completion.chunk", created: 1, model: "backup", choices: [{ index: 0, delta: { role: "assistant", content: "BROKER_FALLBACK_OK" }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ id: "fallback", object: "chat.completion.chunk", created: 1, model: "backup", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        })().catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      await once(gateway.listen(0, "127.0.0.1"), "listening");
      try {
        const address = gateway.address();
        if (!address || typeof address === "string")
          throw new Error("Missing gateway address");
        job.context.modelRetries = 1;
        job.message = "Recover through the broker";
        job.context.model = {
          ...job.context.model,
          id: "primary",
          baseUrl: `http://127.0.0.1:${address.port}/primary/v1`,
        };
        job.context.fallbackModels = [
          {
            ...job.context.model,
            provider: "toolplane-backup",
            id: "backup",
            toolplaneProviderId: "secondary",
            baseUrl: `http://127.0.0.1:${address.port}/backup/v1`,
          },
        ];
        const recovered = await run();
        expect(attempts).toEqual(["primary", "primary", "backup"]);
        expect(
          recovered.find((event) => event.type === "toolplane_sdk_response"),
        ).toMatchObject({
          success: true,
          result: {
            text: "BROKER_FALLBACK_OK",
            actualModel: { providerId: "secondary", model: "backup" },
            usage: {
              actualModel: { providerId: "secondary", model: "backup" },
              modelUsage: expect.arrayContaining([
                expect.objectContaining({
                  providerId: "secondary",
                  model: "backup",
                  inputTokens: 10,
                }),
              ]),
            },
          },
        });
      } finally {
        gateway.closeAllConnections();
        const closed = Promise.withResolvers<void>();
        gateway.close(() => closed.resolve());
        await closed.promise;
      }
    }
    {
      job.context.fallbackModels = [];
      const gateway = createHttpServer((request, response) => {
        request.resume();
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
      });
      await once(gateway.listen(0, "127.0.0.1"), "listening");
      try {
        const address = gateway.address();
        if (!address || typeof address === "string")
          throw new Error("Missing gateway fixture address");
        job.context.model = {
          ...job.context.model,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        };
        job.context.modelRetries = 0;
        const failed = await run();
        expect(
          failed.find((event) => event.type === "toolplane_sdk_response"),
        ).toMatchObject({
          success: false,
          error: { code: "PI_SDK_MODEL_FAILED", reason: "GATEWAY_ERROR" },
        });
      } finally {
        gateway.closeAllConnections();
        const closed = Promise.withResolvers<void>();
        gateway.close(() => closed.resolve());
        await closed.promise;
      }
    }
  } finally {
    // Ask the daemon to stop its detached host process group before removing files.
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = once(daemon, "exit");
      daemon.kill("SIGTERM");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
