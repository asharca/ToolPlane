// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type RecordValue = Record<string, unknown>;
type ModelMessage = { role: string; content?: unknown; tool_call_id?: string };
type ModelRequest = {
  messages: ModelMessage[];
  stream: boolean;
  model: string;
};
type HostEvent = {
  type: string;
  operationId?: string;
  status?: string;
  text?: string;
  code?: string;
  message?: string;
  delta?: string;
};
type ProcessOutput = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
type NodeProcess = { child: ChildProcess; done: Promise<ProcessOutput> };
type StoredMessage = { role: string; content?: unknown; toolCallId?: string };
type SessionState = {
  entries: Array<{ type: string; message?: StoredMessage }>;
  main: Array<{ type: string; message?: StoredMessage }>;
  marker: {
    value: { version: number; source: string; messageCount: number };
  } | null;
  metadata?: { id: string };
  result?: {
    value: { operationId: string; startedAt: number; status: string };
  };
};
type HostInput = {
  action: "prepare" | "run" | "cancel" | "compact";
  packageRoot: string;
  directory: string;
  contextId: string;
  modelsPath: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text: string }>;
  }>;
  skills: unknown[];
  disabledBuiltinTools: string[];
  maxSteps: number;
  workingDirectory: string;
  legacyStatePath: string;
  historyRequired: boolean;
  communicationEnabled: boolean;
  mcpServers: unknown[];
  sessionRequired?: boolean;
  customInstructions?: string;
  nativeApprovalUrl: string;
  runtimeAccessToken: string;
  operationId?: string;
  taskId?: string;
};
const children = new Set<ChildProcess>();
const cleanups: Array<() => Promise<void>> = [];
const protocolTypes = [
  "prepared",
  "result",
  "error",
  "activity",
  "text_delta",
  "usage",
  "context_usage",
];

function startNode(
  script: string,
  args: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
) {
  const child = spawn(process.execPath, [resolve(script), ...args], {
    cwd: resolve("."),
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<ProcessOutput>((resolveOutput, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      resolveOutput({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

function protocol(
  output: ProcessOutput,
  terminal: "prepared" | "result" | "error",
) {
  expect(output.stdout, output.stderr).toMatch(/\n$/);
  const events = output.stdout
    .trimEnd()
    .split("\n")
    .map((line): HostEvent => JSON.parse(line));
  for (const event of events) {
    expect(protocolTypes, JSON.stringify(event)).toContain(event.type);
    if (event.type === "result")
      expect(["completed", "declined", "aborted", "failed"]).toContain(
        event.status,
      );
  }
  expect(events.at(-1)?.type, output.stdout + output.stderr).toBe(terminal);
  expect(
    events.filter((event) =>
      ["prepared", "result", "error"].includes(event.type),
    ),
  ).toHaveLength(1);
  expect(output.signal).toBeNull();
  if (terminal === "error") expect(output.code).not.toBe(0);
  else expect(output.code, output.stderr).toBe(0);
  expect(output.stdout + output.stderr).not.toMatch(
    /test-runtime-(first|replacement)/,
  );
  return assertDefined(events.at(-1));
}

function sendCompletion(
  response: ServerResponse,
  delta: RecordValue,
  finish: string,
) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
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
      `data: ${JSON.stringify({ id: "chatcmpl-controlled", object: "chat.completion.chunk", created: 1, model: "controlled", ...chunk })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: ModelRequest[] = [],
    approvals: Array<RecordValue & { authorization?: string }> = [],
    errors: string[] = [];
  const requestEvents = new EventEmitter();
  const behavior = {
    tool: undefined as
      | { id: string; name: string; arguments: RecordValue }
      | undefined,
    allow: false,
    pauseFirst: false,
    pauseAfterTool: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      if (request.method !== "POST")
        throw new Error(`Unexpected method ${request.method}`);
      if (
        ![
          "Bearer test-runtime-first",
          "Bearer test-runtime-replacement",
        ].includes(request.headers.authorization ?? "")
      )
        throw new Error("Missing scoped runtime credential");
      if (request.url === "/api/v1/agent-runtime/a2a/host-task/approvals") {
        approvals.push({
          ...body,
          authorization: request.headers.authorization,
        });
        const exactCall =
          body.action === "check" &&
          body.callId === behavior.tool?.id &&
          body.toolName === behavior.tool?.name &&
          JSON.stringify(body.input) ===
            JSON.stringify(behavior.tool?.arguments);
        const status =
          body.action === "ready"
            ? "ready"
            : exactCall && behavior.allow
              ? "allow"
              : "deny";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status }));
        return;
      }
      if (request.url !== "/v1/chat/completions")
        throw new Error(`Unexpected model endpoint ${request.url}`);
      requests.push(body as ModelRequest);
      requestEvents.emit("request");
      if (!body.stream || body.model !== "controlled")
        throw new Error("Expected controlled streaming model");
      const hasToolResult = body.messages.some(
        (message: ModelMessage) =>
          message.role === "tool" && message.tool_call_id === behavior.tool?.id,
      );
      if (behavior.pauseFirst || (behavior.pauseAfterTool && hasToolResult))
        return;
      if (behavior.tool && !hasToolResult) {
        sendCompletion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: behavior.tool.id,
                type: "function",
                function: {
                  name: behavior.tool.name,
                  arguments: JSON.stringify(behavior.tool.arguments),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        sendCompletion(response, { content: "HOST_COMPLETE" }, "stop");
      }
    })().catch((error: unknown) => {
      errors.push(String(error));
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Controlled fixture rejected the request" },
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    await new Promise<void>((done, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : done()));
    });
    expect(errors).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind a local port");
  const base = `http://127.0.0.1:${address.port}`;
  const modelsPath = join(root, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        toolplane: {
          name: "Controlled host model",
          baseUrl: `${base}/v1`,
          api: "openai-completions",
          apiKey: "$TOOLPLANE_RUNTIME_TOKEN",
          models: [
            {
              id: "controlled",
              name: "Controlled",
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const input: HostInput = {
    action: "prepare",
    packageRoot: resolve("."),
    directory: join(root, "harness"),
    contextId: "host-context",
    modelsPath,
    providerId: "toolplane",
    modelId: "controlled",
    systemPrompt: "Use only the configured tools.",
    messages: [
      { role: "user", parts: [{ type: "text", text: "CURRENT_USER_ONCE" }] },
    ],
    skills: [],
    disabledBuiltinTools: [],
    maxSteps: 8,
    workingDirectory: root,
    legacyStatePath: join(root, "legacy.json"),
    historyRequired: false,
    communicationEnabled: false,
    mcpServers: [],
    nativeApprovalUrl: `${base}/api/v1/agent-runtime/a2a/host-task/approvals`,
    runtimeAccessToken: "test-runtime-first",
  };
  async function launch(overrides: Partial<HostInput> = {}) {
    const config = { ...input, ...overrides };
    const path = join(root, `input-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(config));
    return startNode("scripts/pi-harness-session.mjs", [path], {
      TOOLPLANE_RUNTIME_TOKEN: config.runtimeAccessToken,
      TOOLPLANE_APPROVAL_URL: config.nativeApprovalUrl,
    });
  }
  async function run(overrides: Partial<HostInput> = {}) {
    return (await launch(overrides)).done;
  }
  async function prepare() {
    const result = protocol(await run(), "prepared");
    expect(result.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    return assertDefined(result.operationId);
  }
  async function state(action = "inspect", operationId?: string) {
    const output = await startNode("tests/fixtures/pi-harness-host-state.mjs", [
      action,
      input.directory,
      input.contextId,
      input.legacyStatePath,
      operationId ?? "",
    ]).done;
    expect(output.code, output.stdout + output.stderr).toBe(0);
    return JSON.parse(output.stdout) as SessionState;
  }
  async function waitForRequests(count: number, driver: NodeProcess) {
    await new Promise<void>((done, reject) => {
      const check = () => {
        if (requests.length >= count) {
          requestEvents.off("request", check);
          done();
        }
      };
      requestEvents.on("request", check);
      check();
      void driver.done.then((output) => {
        requestEvents.off("request", check);
        reject(
          new Error(
            `Driver exited before pause: ${output.stdout} ${output.stderr}`,
          ),
        );
      }, reject);
    });
  }
  return {
    root,
    input,
    requests,
    approvals,
    behavior,
    launch,
    run,
    prepare,
    state,
    waitForRequests,
  };
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  children.clear();
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});

function messages(state: SessionState, role: string) {
  return state.main.flatMap((entry) =>
    entry.type === "message" && entry.message?.role === role
      ? [entry.message]
      : [],
  );
}

describe("real Pi native host protocol and persistent Session", () => {
  it("prepares without a model call, returns the terminal operation on reentry and cancel, and accepts no duplicate user message", async () => {
    const fixture = await setup();
    const operationId = await fixture.prepare();
    expect(fixture.requests).toEqual([]);
    expect((await fixture.state()).marker?.value).toEqual({
      version: 1,
      source: "empty",
      messageCount: 0,
    });
    const binding = {
      action: "run" as const,
      operationId,
      taskId: "host-task",
    };
    const output = await fixture.run(binding);
    const completed = protocol(output, "result");
    const events = output.stdout
      .trimEnd()
      .split("\n")
      .map((line): HostEvent => JSON.parse(line));
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("HOST_COMPLETE");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["usage", "context_usage"]),
    );
    expect(completed).toMatchObject({
      status: "completed",
      text: "HOST_COMPLETE",
    });
    expect(fixture.requests).toHaveLength(1);
    const changedPrompt = [
      {
        role: "user",
        parts: [{ type: "text", text: "MUST_NOT_APPEND_OR_REPROMPT" }],
      },
    ];
    expect(
      protocol(
        await fixture.run({ ...binding, messages: changedPrompt }),
        "result",
      ),
    ).toEqual(completed);
    expect(
      protocol(await fixture.run({ ...binding, action: "cancel" }), "result"),
    ).toEqual(completed);
    expect(fixture.requests).toHaveLength(1);
    expect(messages(await fixture.state(), "user")).toHaveLength(1);
    expect(JSON.stringify(messages(await fixture.state(), "user"))).toContain(
      "CURRENT_USER_ONCE",
    );
  }, 60_000);

  it.each(["missing", "corrupt"] as const)(
    "reports a %s native database without recreating it or losing evidence",
    async (condition) => {
      const fixture = await setup();
      const operationId = await fixture.prepare();
      const database = join(
        fixture.input.directory,
        `${fixture.input.contextId}.sqlite`,
      );
      const evidence = Buffer.from("CORRUPT_SQLITE_EVIDENCE_DO_NOT_REPLACE");
      if (condition === "missing") await rm(database);
      else await writeFile(database, evidence);
      const before = (await readdir(fixture.input.directory)).sort();
      const result = protocol(
        await fixture.run({ action: "run", operationId, taskId: "host-task" }),
        "error",
      );
      expect(result.code).toBe(
        condition === "missing" ? "PI_SESSION_MISSING" : "PI_SESSION_CORRUPT",
      );
      expect((await readdir(fixture.input.directory)).sort()).toEqual(before);
      if (condition === "missing")
        await expect(readFile(database)).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(await readFile(database)).toEqual(evidence);
      expect(fixture.requests).toEqual([]);
    },
    60_000,
  );

  it("does not recreate a previously bound context when the next task prepares", async () => {
    const fixture = await setup();
    await fixture.prepare();
    const database = join(
      fixture.input.directory,
      `${fixture.input.contextId}.sqlite`,
    );
    await rm(database);
    const result = protocol(
      await fixture.run({ action: "prepare", sessionRequired: true }),
      "error",
    );
    expect(result.code).toBe("PI_SESSION_MISSING");
    await expect(readFile(database)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.requests).toEqual([]);
  }, 60_000);

  it("denies the exact native write before any filesystem side effect", async () => {
    const fixture = await setup();
    const path = join(fixture.root, "denied-write.txt");
    fixture.behavior.tool = {
      id: "denied-write",
      name: "write",
      arguments: { path, content: "MUST_NOT_WRITE" },
    };
    const operationId = await fixture.prepare();
    const result = protocol(
      await fixture.run({ action: "run", operationId, taskId: "host-task" }),
      "result",
    );
    expect(result.status).toBe("aborted");
    expect(result.text).toMatch(/not approved|refus|denied/i);
    expect(
      fixture.approvals.filter((entry) => entry.action === "ready"),
    ).toHaveLength(1);
    expect(
      fixture.approvals.filter((entry) => entry.action === "check"),
    ).toEqual([
      {
        action: "check",
        callId: "denied-write",
        toolName: "write",
        input: { path, content: "MUST_NOT_WRITE" },
        authorization: "Bearer test-runtime-first",
      },
    ]);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.requests).toHaveLength(1);
  }, 60_000);

  it("resumes the same operation after SIGKILL without repeating a settled approved write", async () => {
    const fixture = await setup();
    const path = join(fixture.root, "count.txt");
    fixture.behavior.tool = {
      id: "counted-write",
      name: "bash",
      arguments: { command: `printf 'effect\n' >> '${path}'` },
    };
    fixture.behavior.allow = true;
    fixture.behavior.pauseAfterTool = true;
    const operationId = await fixture.prepare();
    const binding = {
      action: "run" as const,
      operationId,
      taskId: "host-task",
    };
    const first = await fixture.launch(binding);
    await fixture.waitForRequests(2, first);
    expect(await readFile(path, "utf8")).toBe("effect\n");
    first.child.kill("SIGKILL");
    expect((await first.done).signal).toBe("SIGKILL");
    const interrupted = await fixture.state();
    expect(
      messages(interrupted, "toolResult").filter(
        (message) => message.toolCallId === "counted-write",
      ),
    ).toHaveLength(1);
    fixture.behavior.pauseAfterTool = false;
    const result = protocol(
      await fixture.run({
        ...binding,
        runtimeAccessToken: "test-runtime-replacement",
      }),
      "result",
    );
    expect(result).toMatchObject({
      status: "completed",
      text: "HOST_COMPLETE",
    });
    expect(await readFile(path, "utf8")).toBe("effect\n");
    expect(fixture.requests).toHaveLength(3);
    expect(
      fixture.approvals.filter((entry) => entry.action === "check"),
    ).toHaveLength(1);
    expect(
      fixture.approvals
        .filter((entry) => entry.action === "ready")
        .map((entry) => entry.authorization),
    ).toEqual(["Bearer test-runtime-first", "Bearer test-runtime-replacement"]);
    expect(messages(await fixture.state(), "user")).toHaveLength(1);
    expect(protocol(await fixture.run(binding), "result")).toEqual(result);
    expect(fixture.requests).toHaveLength(3);
    expect(await readFile(path, "utf8")).toBe("effect\n");
  }, 60_000);

  it("persists requestAbort after an interrupted driver and never resumes a canceled operation", async () => {
    const fixture = await setup();
    fixture.behavior.pauseFirst = true;
    const operationId = await fixture.prepare();
    const binding = {
      action: "run" as const,
      operationId,
      taskId: "host-task",
    };
    const first = await fixture.launch(binding);
    await fixture.waitForRequests(1, first);
    first.child.kill("SIGKILL");
    expect((await first.done).signal).toBe("SIGKILL");
    const aborted = protocol(
      await fixture.run({ ...binding, action: "cancel" }),
      "result",
    );
    expect(aborted.status).toBe("aborted");
    expect(protocol(await fixture.run(binding), "result")).toEqual(aborted);
    expect(fixture.requests).toHaveLength(1);
    expect(messages(await fixture.state(), "user")).toHaveLength(1);
  }, 60_000);

  it("imports legacy JSONL once into the native main lane without executing historical tools", async () => {
    const fixture = await setup();
    await fixture.state("legacy");
    fixture.input.historyRequired = true;
    const original = await readFile(`${fixture.input.legacyStatePath}.jsonl`);
    const operationId = await fixture.prepare();
    const imported = await fixture.state();
    expect(imported.marker?.value).toEqual({
      version: 1,
      source: "legacy",
      messageCount: 4,
    });
    expect(
      imported.main.filter((entry) => entry.type === "message"),
    ).toHaveLength(4);
    expect(messages(imported, "toolResult")).toHaveLength(1);
    expect(fixture.requests).toEqual([]);
    expect(
      fixture.approvals.filter((entry) => entry.action === "check"),
    ).toEqual([]);
    const oldToolPath = join(
      fixture.input.directory,
      "old-tool-must-not-run.txt",
    );
    await expect(readFile(oldToolPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(`${fixture.input.legacyStatePath}.jsonl`)).toEqual(
      original,
    );
    const binding = {
      action: "run" as const,
      operationId,
      taskId: "host-task",
    };
    expect(protocol(await fixture.run(binding), "result").status).toBe(
      "completed",
    );
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.stringify(fixture.requests[0].messages)).toContain(
      "LEGACY_USER_ONCE",
    );
    expect(JSON.stringify(fixture.requests[0].messages)).toContain(
      "LEGACY_ASSISTANT_ONCE",
    );
    await writeFile(
      `${fixture.input.legacyStatePath}.jsonl`,
      "Changed old file must not be read after the durable migration marker.",
    );
    expect(protocol(await fixture.run(binding), "result").status).toBe(
      "completed",
    );
    await fixture.prepare();
    const reopened = await fixture.state();
    expect(reopened.marker).toEqual(imported.marker);
    expect(messages(reopened, "user")).toHaveLength(2);
    expect(messages(reopened, "toolResult")).toHaveLength(1);
    expect(fixture.requests).toHaveLength(1);
    await expect(readFile(oldToolPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("atomically rolls back imported entries when the migration marker cannot commit", async () => {
    const fixture = await setup();
    await fixture.state("legacy");
    fixture.input.historyRequired = true;
    const original = await readFile(`${fixture.input.legacyStatePath}.jsonl`);
    await fixture.state("reject-import");
    protocol(await fixture.run(), "error");
    const rejected = await fixture.state();
    expect(rejected.marker).toBeNull();
    expect(
      rejected.entries.filter((entry) => entry.type === "message"),
    ).toEqual([]);
    expect(rejected.main).toEqual([]);
    expect(await readFile(`${fixture.input.legacyStatePath}.jsonl`)).toEqual(
      original,
    );
    expect(fixture.requests).toEqual([]);
    await fixture.state("allow-import");
    await fixture.prepare();
    const committed = await fixture.state();
    expect(committed.marker?.value).toEqual({
      version: 1,
      source: "legacy",
      messageCount: 4,
    });
    expect(
      committed.main.filter((entry) => entry.type === "message"),
    ).toHaveLength(4);
    expect(
      committed.entries.filter((entry) => entry.type === "message"),
    ).toHaveLength(4);
    await fixture.prepare();
    expect((await fixture.state()).main).toEqual(committed.main);
  }, 60_000);

  it.each(["missing", "corrupt"] as const)(
    "rejects %s required legacy history rather than committing empty history",
    async (condition) => {
      const fixture = await setup();
      fixture.input.historyRequired = true;
      const evidence = "not a legacy session\n";
      if (condition === "corrupt")
        await writeFile(`${fixture.input.legacyStatePath}.jsonl`, evidence);
      const result = protocol(await fixture.run(), "error");
      expect(result.code).toBe(
        condition === "missing" ? "PI_SESSION_MISSING" : "PI_SESSION_CORRUPT",
      );
      if (condition === "corrupt")
        expect(
          await readFile(`${fixture.input.legacyStatePath}.jsonl`, "utf8"),
        ).toBe(evidence);
      await expect(
        readFile(
          join(fixture.input.directory, `${fixture.input.contextId}.sqlite`),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.requests).toEqual([]);
    },
    60_000,
  );

  it("resumes interrupted compaction on the same native lane without admitting another prompt", async () => {
    const fixture = await setup();
    await fixture.state("long-legacy");
    const original = await readFile(`${fixture.input.legacyStatePath}.jsonl`);
    await fixture.prepare();
    fixture.behavior.pauseFirst = true;
    const driver = await fixture.launch({
      action: "compact",
      customInstructions: "Retain important details",
      nativeApprovalUrl: "",
    });
    await fixture.waitForRequests(1, driver);
    const interruptedAt = Date.now();
    driver.child.kill("SIGKILL");
    expect((await driver.done).signal).toBe("SIGKILL");
    const busy = protocol(
      await fixture.run({
        action: "compact",
        customInstructions: "Different instructions",
      }),
      "error",
    );
    expect(busy.code).toBe("PI_LANE_BUSY");
    expect(fixture.requests).toHaveLength(1);
    fixture.behavior.pauseFirst = false;
    const output = await fixture.run({
      action: "compact",
      customInstructions: "Retain important details",
      nativeApprovalUrl: "",
      runtimeAccessToken: "test-runtime-replacement",
    });
    const result = protocol(output, "result");
    expect(result.status).toBe("completed");
    expect(result.text).toContain("HOST_COMPLETE");
    expect(result.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const after = await fixture.state("inspect", result.operationId);
    expect(after.metadata?.id).toBe(fixture.input.contextId);
    expect(after.result?.value).toMatchObject({
      operationId: result.operationId,
      status: "completed",
    });
    expect(assertDefined(after.result).value.startedAt).toBeLessThanOrEqual(
      interruptedAt,
    );
    expect(
      after.entries.filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(after.main.some((entry) => entry.type === "compaction")).toBe(true);
    expect(JSON.stringify(after.entries)).not.toContain("CURRENT_USER_ONCE");
    expect(
      output.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some(
          (event) => event.type === "usage" && event.usage.inputTokens === 20,
        ),
    ).toBe(true);
    expect(fixture.approvals).toEqual([]);
    expect(await readFile(`${fixture.input.legacyStatePath}.jsonl`)).toEqual(
      original,
    );
  }, 60_000);

  it("refuses to compact a missing native Session instead of invoking the legacy CLI", async () => {
    const fixture = await setup();
    const result = protocol(
      await fixture.run({ action: "compact", customInstructions: "" }),
      "error",
    );
    expect(result.code).toBe("PI_SESSION_MISSING");
    expect(fixture.requests).toEqual([]);
  }, 60_000);
});
