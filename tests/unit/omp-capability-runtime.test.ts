// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpUi } from "../../scripts/omp-ui.mjs";
import { describe, expect, it, vi } from "vitest";
import {
  guardedHookApi,
  loadPinnedPlugin,
  drainOmpHooks,
} from "../../scripts/omp-hooks.mjs";
import {
  resolvePluginEntries,
  preparePinnedSubagentTaskInput,
  prepareNativeSubagentTaskInput,
  assembleOmpCapabilities,
} from "../../scripts/omp-capabilities.mjs";
import { buildPrivatePluginManifest } from "@/lib/plugins/local";
import { PrivatePluginInputSchema } from "@/lib/agents/capability-contracts";
import {
  NativeUiAction,
  applyNativeUiAction,
  nativeUiView,
  respondNativeUi,
} from "@/lib/agents/execution/native-ui";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureOmpInstalled } from "../../scripts/omp-install.mjs";
import { migrateNativeSessionPaths } from "../../scripts/native-session-paths.mjs";

describe("conversation native state and shared pinned installation", () => {
  it.each([
    "",
    '{"type":"title","v":1,"title":"Native task","updatedAt":0,"pad":"    "}\n',
  ])(
    "rebases native routing metadata with prefix %j while retaining messages, pins and mode",
    async (prefix) => {
      const root = await mkdtemp(join(tmpdir(), "omp-session-migrate-"));
      const sessionsDir = join(root, ".toolplane", "sessions");
      const statePath = join(sessionsDir, ".toolplane-session.json");
      const sessionFile = join(sessionsDir, "history.jsonl");
      const body =
        '{"type":"message","id":"retained","message":{"role":"user","content":"/workspace/original.txt"}}\n';
      try {
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(
          join(root, ".toolplane-shared-migration.json"),
          JSON.stringify({ legacyWorkspaceRoot: "/workspace" }),
        );
        await writeFile(
          sessionFile,
          `${prefix}${JSON.stringify({ type: "session", id: "native-session", cwd: "/workspace/project" })}\n${body}`,
        );
        const saved = {
          cwd: "/workspace/project",
          agentRevisionId: "pinned",
          subagentMode: "native",
          nativePolicy: { maxDepth: 2, maxConcurrency: 3 },
          hadMessages: true,
        };
        await writeFile(statePath, JSON.stringify(saved));
        await migrateNativeSessionPaths({
          workspaceRoot: root,
          sessionsDir,
          statePath,
        });
        const migrated = await readFile(sessionFile, "utf8");
        expect(migrated.slice(0, prefix.length)).toBe(prefix);
        const routed = migrated.slice(prefix.length);
        expect(routed.slice(routed.indexOf("\n") + 1)).toBe(body);
        expect(JSON.parse(routed.split("\n")[0])).toMatchObject({
          id: "native-session",
          cwd: join(root, "project"),
        });
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
          ...saved,
          cwd: join(root, "project"),
        });
        await migrateNativeSessionPaths({
          workspaceRoot: root,
          sessionsDir,
          statePath,
        });
        expect(await readFile(sessionFile, "utf8")).toBe(migrated);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not treat a fresh workspace's initialization marker as missing legacy history", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-session-fresh-"));
    const sessionsDir = join(root, "sessions");
    try {
      await mkdir(sessionsDir);
      await writeFile(
        join(root, ".toolplane-shared-migration.json"),
        JSON.stringify({
          sourceSandboxId: null,
          legacyWorkspaceRoot: null,
        }),
      );
      await expect(
        migrateNativeSessionPaths({
          workspaceRoot: root,
          sessionsDir,
          statePath: join(sessionsDir, ".toolplane-session.json"),
        }),
      ).resolves.toBeUndefined();
      expect(await readdir(sessionsDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "coalesces same-process downloads and rejects unpinned bytes without leaving a partial artifact",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omp-install-race-"));
      const path = join(root, "omp");
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response("not-the-pinned-artifact"),
        );
      try {
        const results = await Promise.allSettled([
          ensureOmpInstalled(path),
          ensureOmpInstalled(path),
        ]);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(results).toEqual([
          {
            status: "rejected",
            reason: expect.objectContaining({
              message: "OMP_ARTIFACT_DIGEST_MISMATCH",
            }),
          },
          {
            status: "rejected",
            reason: expect.objectContaining({
              message: "OMP_ARTIFACT_DIGEST_MISMATCH",
            }),
          },
        ]);
        expect(await readdir(root)).toEqual([]);
        await expect(ensureOmpInstalled(path)).rejects.toThrow(
          "OMP_ARTIFACT_DIGEST_MISMATCH",
        );
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        fetch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "serializes separate native hosts and releases the shared installer lock when its owner exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omp-install-hosts-"));
      const installer = pathToFileURL(
        join(process.cwd(), "scripts/omp-install.mjs"),
      ).href;
      const events = new EventEmitter();
      const downloads = [0, 0];
      const children: ChildProcess[] = [];
      const launch = (index: number) => {
        const source = `import { ensureOmpInstalled } from ${JSON.stringify(installer)};
globalThis.fetch = async () => { console.log('download'); await new Promise(() => {}); };
console.log('requested'); await ensureOmpInstalled(${JSON.stringify(join(root, "omp"))});`;
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", source],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              NODE_CHANNEL_FD: undefined,
              NODE_CHANNEL_SERIALIZATION_MODE: undefined,
            },
          },
        );
        children.push(child);
        if (!child.stdout) throw new Error("Missing installer stdout");
        createInterface({ input: child.stdout }).on("line", (line) => {
          if (line === "download") downloads[index]++;
          events.emit(`${index}:${line}`);
        });
        child.stderr?.resume();
        return child;
      };
      try {
        const downloaded = once(events, "0:download", {
          signal: AbortSignal.timeout(5000),
        });
        const first = launch(0);
        await downloaded;
        const requested = once(events, "1:requested", {
          signal: AbortSignal.timeout(5000),
        });
        launch(1);
        await requested;
        await delay(150);
        expect(downloads).toEqual([1, 0]);
        const acquired = once(events, "1:download", {
          signal: AbortSignal.timeout(5000),
        });
        const exited = once(first, "exit");
        first.kill("SIGKILL");
        await exited;
        await acquired;
        expect(downloads).toEqual([1, 1]);
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }),
        );
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});

describe("pinned native task inputs", () => {
  const children = new Map([
    [
      "tp-isolated",
      { tools: ["todo", "ask"], definition: { contextPolicy: "isolated" } },
    ],
    [
      "tp-inherited",
      { tools: ["todo"], definition: { contextPolicy: "inherit" } },
    ],
  ]);
  it("retains the explicit assignment contract without importing isolated parent history or injecting eval tools", () => {
    const input = {
      context: "Use API contract v2",
      tasks: [
        {
          agent: "tp-isolated",
          task: "Check the result",
          solutionSpace: "one result",
        },
      ],
    };
    const prepared = preparePinnedSubagentTaskInput(input, children, () => {
      throw new Error("Parent history must remain isolated");
    });
    expect(prepared.context).toBe("Use API contract v2");
    expect(prepared.tasks[0].task).toBe("Check the result");
    expect(prepared.tasks[0]).not.toHaveProperty("tools");
  });
  it("rejects parent-hosted tools and unknown subagent identities", () => {
    expect(() =>
      preparePinnedSubagentTaskInput(
        { agent: "tp-isolated", tools: ["parent_secret"], task: "Read" },
        children,
        () => [],
      ),
    ).toThrow("OMP_SUBAGENT_PARENT_TOOLS_FORBIDDEN");
    expect(() =>
      preparePinnedSubagentTaskInput(
        { agent: "unknown", task: "Read" },
        children,
        () => [],
      ),
    ).toThrow("OMP_SUBAGENT_UNAVAILABLE");
  });
  it("inherits only bounded conversation messages for an explicitly inheriting child", () => {
    const prepared = preparePinnedSubagentTaskInput(
      {
        context: "Current contract",
        tasks: [{ agent: "tp-inherited", task: "Continue" }],
      },
      children,
      () => [
        {
          type: "message",
          message: { role: "user", content: "Earlier request" },
        },
        {
          type: "message",
          message: { role: "system", content: "Private system instruction" },
        },
      ],
    );
    expect(prepared.context).toBe("Current contract");
    expect(prepared.tasks[0].task).toContain("Earlier request");
    expect(prepared.tasks[0].task).not.toContain("Private system instruction");
    expect(() =>
      preparePinnedSubagentTaskInput(
        { agent: "tp-inherited", task: "Continue" },
        children,
        () => [
          {
            type: "message",
            message: { role: "user", content: "x".repeat(128 * 1024) },
          },
        ],
      ),
    ).toThrow("OMP_SUBAGENT_CONTEXT_LIMIT");
  });
});

describe("task-generated native roles", () => {
  it("materializes distinct private invocation definitions without platform pins", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-native-roles-"));
    const roles = new Map<string, string>();
    try {
      const prepared = await prepareNativeSubagentTaskInput(
        {
          context: "shared contract",
          tasks: [
            {
              agent: "researcher",
              name: "ResearchA",
              task: "Read the API and report findings",
              solutionSpace: "one API",
            },
            {
              agent: "researcher",
              name: "ResearchB",
              task: "Read the tests and report findings",
              solutionSpace: "one suite",
            },
          ],
        },
        {
          agentDir: root,
          tools: ["read", "task", "ask", "todo"],
          modelSelector: "toolplane/parent-model",
          register: (name: string, role: string) => roles.set(name, role),
        },
      );
      expect(prepared.context).toBe("shared contract");
      expect(prepared.tasks[0].agent).not.toBe(prepared.tasks[1].agent);
      expect(roles.size).toBe(2);
      for (const task of prepared.tasks) {
        expect(roles.get(task.agent)).toBe("researcher");
        const definition = await readFile(
          join(root, "agents", `${task.agent}.md`),
          "utf8",
        );
        expect(definition).toContain('model: "toolplane/parent-model"');
        expect(definition).toContain('tools: ["read","task","ask"]');
        expect(definition).toContain('spawns: "*"');
        expect(definition).toContain(task.task);
        expect(task).not.toHaveProperty("tools");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("selects independent reviewed role models while intersecting tools and refusing unreviewed source bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-mapped-roles-"));
    const input = PrivatePluginInputSchema.parse({
      name: "mapped-roles",
      runtimeKind: "omp",
      subagents: ["backend.md", "frontend.md"],
      nativeRoleModels: {
        "backend.md": {
          providerId: "backend-provider",
          model: "backend-model",
        },
        "frontend.md": {
          providerId: "frontend-provider",
          model: "frontend-model",
        },
      },
      files: [
        {
          path: "backend.md",
          content:
            '---\nname: backend\nmodel: "@backend"\ntools: ["read", "bash"]\n---\nImplement the API.',
        },
        {
          path: "frontend.md",
          content:
            '---\nname: frontend\nmodel: "@frontend"\ntools: ["read"]\n---\nImplement the UI.',
        },
      ],
    });
    const plugin = {
      marketInstallId: "install",
      releaseId: "release",
      checksum: "fixture",
      root,
      manifest: buildPrivatePluginManifest(input),
    };
    try {
      await expect(
        assembleOmpCapabilities({
          plugins: [plugin],
          agentDir: join(root, "unreviewed"),
        }),
      ).rejects.toThrow("OMP_PLUGIN_ROLE_MODEL_UNAUTHORIZED");
      await assembleOmpCapabilities({
        plugins: [plugin],
        agentDir: root,
        nativeRoleModels: [
          {
            marketInstallId: "install",
            releaseId: "release",
            path: "package/backend.md",
            modelSelector: "backend-provider/backend-model",
          },
          {
            marketInstallId: "install",
            releaseId: "release",
            path: "package/frontend.md",
            modelSelector: "frontend-provider/frontend-model",
          },
        ],
      });
      const registeredModels = new Map<string, string>();
      const prepared = await prepareNativeSubagentTaskInput(
        {
          tasks: [
            { agent: "backend", task: "Build API" },
            { agent: "frontend", task: "Build UI" },
          ],
        },
        {
          agentDir: root,
          tools: ["read", "task"],
          modelSelector: "parent/default",
          register: (name: string, _role: string, model: string) =>
            registeredModels.set(name, model),
        },
      );
      const backend = await readFile(
        join(root, "agents", `${prepared.tasks[0].agent}.md`),
        "utf8",
      );
      const frontend = await readFile(
        join(root, "agents", `${prepared.tasks[1].agent}.md`),
        "utf8",
      );
      expect(backend).toContain('model: "backend-provider/backend-model"');
      expect(frontend).toContain('model: "frontend-provider/frontend-model"');
      expect(registeredModels.get(prepared.tasks[0].agent)).toBe(
        "backend-provider/backend-model",
      );
      expect(registeredModels.get(prepared.tasks[1].agent)).toBe(
        "frontend-provider/frontend-model",
      );
      expect(backend).toContain('tools: ["read"]');
      expect(frontend).toContain('tools: ["read"]');
      expect(backend).not.toContain("parent/default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    { tools: ["parent_secret"] },
    { model: "other/key" },
    { sourceSession: "other-session" },
    { taskFile: "/private/assignment" },
  ])("rejects native authorization overrides %j", async (override) => {
    const root = await mkdtemp(join(tmpdir(), "omp-native-denied-"));
    try {
      await expect(
        prepareNativeSubagentTaskInput(
          { tasks: [{ agent: "researcher", task: "Read", ...override }] },
          {
            agentDir: root,
            tools: ["read"],
            modelSelector: "toolplane/parent",
            register: () => {
              throw new Error("Must not register an unauthorized role");
            },
          },
        ),
      ).rejects.toThrow("OMP_NATIVE_TASK_OVERRIDE_FORBIDDEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects task-file-only and path-like role definitions", async () => {
    const options = {
      agentDir: "/unreachable",
      tools: ["read"],
      modelSelector: "toolplane/parent",
      register: () => {},
    };
    await expect(
      prepareNativeSubagentTaskInput(
        { tasks: [{ agent: "../../escape", task: "Read" }] },
        options,
      ),
    ).rejects.toThrow("OMP_NATIVE_TASK_INVALID");
    await expect(
      prepareNativeSubagentTaskInput(
        { tasks: [{ agent: "researcher", taskFile: "/private" }] },
        options,
      ),
    ).rejects.toThrow("OMP_NATIVE_TASK_INVALID");
  });
});

function hookHarness() {
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>
  >();
  return {
    handlers,
    pi: {
      on(
        event: string,
        handler: (
          event: unknown,
          ctx: unknown,
        ) => Promise<{ block?: boolean } | undefined>,
      ) {
        handlers.set(event, handler);
      },
    },
  };
}
describe("pinned OMP plugin execution", () => {
  it("fails closed once and never replays a throwing blocking hook", async () => {
    const { pi, handlers } = hookHarness();
    let hookCalls = 0,
      sideEffects = 0;
    const records: { id: string; status: string; durationMs: number }[] = [];
    const api = guardedHookApi(pi, {
      onInvocation: (record) => {
        records.push(record);
      },
    });
    api.on("tool_call", async () => {
      hookCalls++;
      throw new Error("private plugin error");
    });
    for (let i = 0; i < 2; i++) {
      const result = await handlers.get("tool_call")?.({}, {});
      if (!result?.block) sideEffects++;
      expect(result?.block).toBe(true);
    }
    expect(hookCalls).toBe(1);
    expect(sideEffects).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed" });
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(records)).not.toContain("private plugin error");
  });

  it("bounds an awaiting blocking hook and poisons subsequent invocations", async () => {
    const { pi, handlers } = hookHarness();
    let calls = 0;
    const records: { status: string }[] = [];
    guardedHookApi(pi, {
      timeoutMs: 5,
      onInvocation: (record) => {
        records.push(record);
      },
    }).on("before_subagent_spawn", () => {
      calls++;
      return Promise.withResolvers().promise;
    });
    const handler = handlers.get("before_subagent_spawn");
    expect((await handler?.({}, {}))?.block).toBe(true);
    expect((await handler?.({}, {}))?.block).toBe(true);
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("timed_out");
  });

  it("drains awaited hook reports before completing without changing the blocking result", async () => {
    const { pi, handlers } = hookHarness();
    const reporting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    guardedHookApi(pi, {
      onInvocation: async () => {
        reporting.resolve();
        await release.promise;
      },
    }).on("tool_call", () => ({ block: true }));
    const invocation = handlers.get("tool_call")?.({}, {});
    await reporting.promise;
    let drained = false;
    const drain = drainOmpHooks().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    release.resolve();
    expect(await invocation).toEqual({ block: true });
    await drain;
    expect(drained).toBe(true);
  });

  it("keeps stop hooks fail-closed and does not let record failures change the denial", async () => {
    const { pi, handlers } = hookHarness();
    let aborted = 0;
    const api = guardedHookApi(pi, {
      onInvocation: () => {
        throw new Error("record unavailable");
      },
    });
    api.on("session_stop", () => {
      throw new Error("private stop failure");
    });
    expect(
      await handlers.get("session_stop")?.(
        {},
        {
          abort() {
            aborted++;
          },
        },
      ),
    ).toMatchObject({ decision: "block" });
    expect(aborted).toBe(1);
  });

  it("resolves selected feature entrypoints without executing helper modules or disabled features", () => {
    const file = (path: string, content = "export default () => {}") => ({
      type: "file",
      path: `package/${path}`,
      content: Buffer.from(content).toString("base64"),
    });
    const pkg = {
      resources: { hooks: [], extensions: [], tools: [], commands: [] },
      entries: [
        file(
          "package.json",
          JSON.stringify({
            omp: {
              hooks: "hooks",
              extensions: ["extensions"],
              features: { optional: { default: true, hooks: ["optional.ts"] } },
            },
          }),
        ),
        file("hooks/index.ts"),
        file("hooks/helper.ts"),
        file("optional.ts"),
        file("extensions/index.ts"),
        file("extensions/helper.ts"),
      ],
    };
    expect(resolvePluginEntries(pkg, []).hooks).toEqual([
      "package/hooks/index.ts",
    ]);
    expect(resolvePluginEntries(pkg, null).hooks).toEqual([
      "package/hooks/index.ts",
      "package/optional.ts",
    ]);
    expect(resolvePluginEntries(pkg, []).extensions).toEqual([
      "package/extensions/index.ts",
    ]);
    const broken = {
      ...pkg,
      entries: pkg.entries.filter(
        (entry) => entry.path !== "package/hooks/index.ts",
      ),
    };
    expect(() => resolvePluginEntries(broken, [])).toThrow(
      "OMP_PLUGIN_ENTRY_MISSING",
    );
  });
});

it("preserves native custom-tool cancellation and context argument order", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-pinned-tool-"));
  try {
    const path = join(root, "tool.mjs");
    await writeFile(
      path,
      `export default api => ({ name: 'inspect', description: 'Inspect real factory ABI', parameters: { type: 'object' }, async execute(id, params, onUpdate, ctx, signal) { return { content: [{ type: 'text', text: JSON.stringify({ id, cwd: api.cwd, child: ctx.agent.id, aborted: signal.aborted, update: typeof onUpdate }) }] }; } });`,
    );
    const tools: {
      execute: (
        id: string,
        params: object,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: object,
      ) => Promise<{ content: { text: string }[] }>;
    }[] = [];
    await loadPinnedPlugin(
      {
        on() {},
        registerTool(value: (typeof tools)[number]) {
          tools.push(value);
        },
      },
      {
        installId: "plugin-install",
        name: "test-plugin",
        resources: { tools: [path] },
      },
      { cwd: root },
    );
    const controller = new AbortController();
    controller.abort();
    const result = await tools[0]?.execute(
      "call-id",
      {},
      controller.signal,
      () => {},
      { agent: { id: "native-child", kind: "main" } },
    );
    expect(JSON.parse(result?.content[0].text ?? "null")).toEqual({
      id: "call-id",
      cwd: root,
      child: "native-child",
      aborted: true,
      update: "function",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("native child attribution persistence", () => {
  const action = (value: unknown) => NativeUiAction.parse(value);
  const apply = (projection: unknown, input: unknown) =>
    applyNativeUiAction(projection, "lease", Date.now() + 60_000, action(input))
      .projection;
  const todo = (id: number, text: string) => ({ id, text, done: false });
  it("keeps root and simultaneous same-definition child todos separate across reload and clear", () => {
    let p = apply(null, { action: "todos", todos: [todo(1, "parent")] });
    const a = { subagentId: "invocation-a", subagentVersionId: "version" };
    const b = { subagentId: "invocation-b", subagentVersionId: "version" };
    p = apply(p, { action: "todos", source: a, todos: [todo(1, "child a")] });
    p = apply(JSON.parse(JSON.stringify(p)), {
      action: "todos",
      source: b,
      todos: [todo(1, "child b")],
    });
    p = apply(p, { action: "todos", todos: [todo(2, "parent updated")] });
    expect(p.todos.map((item) => item.text)).toEqual([
      "child a",
      "child b",
      "parent updated",
    ]);
    p = apply(p, { action: "todos", source: a, todos: [] });
    expect(p.todos.map((item) => item.text)).toEqual([
      "child b",
      "parent updated",
    ]);
  });

  it("persists distinct child tool identities and source-labelled dialogs without flattening", () => {
    const source = {
      subagentId: "child-a",
      subagentName: "Reviewer",
      subagentVersionId: "pinned-version",
    };
    let p = apply(null, {
      action: "activity",
      activity: {
        type: "tool",
        status: "running",
        source,
        toolCallId: "child-a:tool-1",
        toolName: "read",
      },
    });
    p = apply(p, {
      action: "activity",
      activity: {
        type: "tool",
        status: "completed",
        source,
        toolCallId: "child-a:tool-1",
        toolName: "read",
        output: "actual result",
      },
    });
    p = apply(p, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: "child-a:ask",
        source,
        method: "ask",
        title: "Review question",
        questions: [
          {
            id: "q",
            question: "Proceed?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });
    const view = nativeUiView(JSON.parse(JSON.stringify(p)), "lease", true);
    expect(view.activities).toHaveLength(1);
    expect(view.activities[0]).toMatchObject({
      source,
      output: "actual result",
      status: "completed",
    });
    expect(view.uiRequests[0]).toMatchObject({ id: "child-a:ask", source });
    expect(view.todos).toEqual([]);
    expect(nativeUiView(p, "another-lease", true).uiRequests).toEqual([]);
  });

  it("derives browser response source from the stored dialog and rejects an explicit mismatch", () => {
    const source = { subagentId: "invocation-a", subagentVersionId: "version" };
    const p = apply(null, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: "question",
        method: "confirm",
        title: "Continue",
        message: "Proceed?",
        source,
      },
    });
    expect(() =>
      respondNativeUi(JSON.parse(JSON.stringify(p)), "lease", {
        type: "extension_ui_response",
        id: "question",
        confirmed: true,
        source: { ...source, subagentId: "invocation-b" },
      }),
    ).toThrow("source does not match");
    expect(() =>
      respondNativeUi(JSON.parse(JSON.stringify(p)), "stale-lease", {
        type: "extension_ui_response",
        id: "question",
        confirmed: true,
      }),
    ).toThrow("stale or already answered");
    const answered = respondNativeUi(JSON.parse(JSON.stringify(p)), "lease", {
      type: "extension_ui_response",
      id: "question",
      confirmed: true,
    });
    expect(answered.dialogs[0].response).toMatchObject({
      confirmed: true,
      source,
    });
    const cancelled = respondNativeUi(JSON.parse(JSON.stringify(p)), "lease", {
      type: "extension_ui_response",
      id: "question",
      cancelled: true,
    });
    expect(cancelled.dialogs[0].response).toMatchObject({
      cancelled: true,
      source,
    });
  });

  it("separates same-name child widgets and identical local tool IDs by native invocation", () => {
    const a = { subagentId: "invocation-a", subagentVersionId: "same-version" };
    const b = { subagentId: "invocation-b", subagentVersionId: "same-version" };
    let p = apply(null, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: "status-a",
        method: "setStatus",
        statusKey: "progress",
        statusText: "A",
        source: a,
      },
    });
    p = apply(p, {
      action: "request",
      request: {
        type: "extension_ui_request",
        id: "status-b",
        method: "setStatus",
        statusKey: "progress",
        statusText: "B",
        source: b,
      },
    });
    p = apply(p, {
      action: "activity",
      activity: {
        type: "tool",
        status: "running",
        toolCallId: "local-tool",
        source: a,
      },
    });
    p = apply(p, {
      action: "activity",
      activity: {
        type: "tool",
        status: "completed",
        toolCallId: "local-tool",
        source: b,
      },
    });
    const view = nativeUiView(JSON.parse(JSON.stringify(p)));
    expect(view.uiEvents).toHaveLength(2);
    expect(view.activities).toHaveLength(2);
    expect(
      view.activities.map((activity) => activity.source.subagentId),
    ).toEqual(["invocation-a", "invocation-b"]);
  });
});

it("waits for the real child-scoped dialog response and retires pending input on parent cancellation", async () => {
  let projection: unknown = null;
  let registered: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe(
        "Bearer scoped-runtime-test-token",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = NativeUiAction.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const result = applyNativeUiAction(
        projection,
        "lease",
        Date.now() + 60_000,
        input,
      );
      projection = result.projection;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.result));
      if (input.action === "request") registered?.();
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const responses: Record<string, unknown>[] = [];
  const ui = createOmpUi({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/agent-runtime/sessions/ui`,
    token: "scoped-runtime-test-token",
    send: (frame: Record<string, unknown>) => responses.push(frame),
    onError: () => {},
  });
  const frame = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "ask",
    title: "Reviewer",
    source: {
      subagentId: "native-invocation",
      subagentVersionId: "fixed-version",
    },
    questions: [
      {
        id: "q",
        question: "Proceed?",
        options: [{ label: "Proceed" }, { label: "Stop" }],
      },
    ],
  });
  try {
    const seen = Promise.withResolvers<void>();
    registered = seen.resolve;
    const request = ui.request(frame("child-question"));
    await seen.promise;
    expect(responses).toEqual([]);
    expect(nativeUiView(projection, "lease", true).uiRequests[0]).toMatchObject(
      { source: { subagentId: "native-invocation" } },
    );
    projection = respondNativeUi(projection, "lease", {
      type: "extension_ui_response",
      id: "child-question",
      answers: [{ id: "q", selectedOptions: ["Stop"] }],
    });
    await request;
    expect(responses[0]).toMatchObject({
      id: "child-question",
      source: frame("child-question").source,
      answers: [{ id: "q", selectedOptions: ["Stop"] }],
    });
    const secondSeen = Promise.withResolvers<void>();
    registered = secondSeen.resolve;
    const pending = ui.request(frame("cancelled-child-question"));
    await secondSeen.promise;
    await ui.close();
    await pending;
    expect(responses[1]).toMatchObject({
      id: "cancelled-child-question",
      cancelled: true,
    });
    expect(nativeUiView(projection, "lease", true).uiRequests).toEqual([]);
  } finally {
    await ui.close();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

it("persists bounded hook invocation outcomes idempotently and rejects identity reuse", () => {
  const hook = {
    id: "hook-0",
    pluginInstallId: "install",
    pluginName: "plugin",
    event: "tool_call",
    status: "completed",
    durationMs: 4,
    result: "blocked",
    source: { subagentId: "child" },
  };
  const apply = (projection: unknown, record: unknown) =>
    applyNativeUiAction(
      projection,
      "lease",
      Date.now() + 60_000,
      NativeUiAction.parse({ action: "hook", hook: record }),
    ).projection;
  let projection = apply(null, hook);
  projection = apply(JSON.parse(JSON.stringify(projection)), hook);
  expect(nativeUiView(projection).hooks).toHaveLength(1);
  expect(() =>
    apply(JSON.parse(JSON.stringify(projection)), {
      ...hook,
      pluginInstallId: "another",
    }),
  ).toThrow("Hook invocation ID was reused");
  for (let index = 1; index < 70; index++)
    projection = apply(projection, { ...hook, id: `hook-${index}` });
  const persisted = nativeUiView(JSON.parse(JSON.stringify(projection))).hooks;
  expect(persisted).toHaveLength(64);
  expect(persisted[0].id).toBe("hook-6");
  expect(persisted[63]).toMatchObject({
    id: "hook-69",
    result: "blocked",
    source: { subagentId: "child" },
  });
});

it("executes only live-granted child plugin hooks/tools and persists actual HTTP hook records", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-hook-scope-"));
  const previousToken = process.env.TOOLPLANE_RUNTIME_TOKEN;
  process.env.TOOLPLANE_RUNTIME_TOKEN = "hook-test-token";
  let projection: unknown = null;
  let live = true;
  let authorizations = 0;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("content-type", "application/json");
      if (req.url === "/authorize") {
        authorizations++;
        res.end(JSON.stringify({ allowed: live }));
        return;
      }
      expect(req.headers.authorization).toBe("Bearer hook-test-token");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const action = NativeUiAction.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const applied = applyNativeUiAction(
        projection,
        "lease",
        Date.now() + 60_000,
        action,
      );
      projection = JSON.parse(JSON.stringify(applied.projection));
      res.end(JSON.stringify(applied.result));
    } catch {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  const handlers = new Map<
    string,
    (payload: unknown, ctx: unknown) => Promise<unknown>
  >();
  const tools: {
    execute: (
      id: string,
      params: object,
      signal: undefined,
      update: undefined,
      ctx: object,
    ) => Promise<unknown>;
  }[] = [];
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const marker = join(root, "executions");
    const path = join(root, "hook.mjs");
    await writeFile(marker, "");
    await writeFile(
      path,
      `import { appendFile } from 'node:fs/promises'; export default api => { api.on('tool_call', async () => { await appendFile(${JSON.stringify(marker)}, 'hook\\n'); return { block: true }; }); api.registerTool({ name: 'plugin_tool', description: 'Real scoped plugin tool', parameters: { type: 'object' }, async execute() { await appendFile(${JSON.stringify(marker)}, 'tool\\n'); return { content: [] }; } }); };`,
    );
    await loadPinnedPlugin(
      {
        on(
          event: string,
          handler: (payload: unknown, ctx: unknown) => Promise<unknown>,
        ) {
          handlers.set(event, handler);
        },
        registerTool(tool: (typeof tools)[number]) {
          tools.push(tool);
        },
      },
      {
        installId: "install",
        name: "scoped-plugin",
        resources: { hooks: [path] },
      },
      {
        uiUrl: `${base}/api/v1/agent-runtime/sessions/ui`,
        subagents: [
          {
            nativeName: "allowed",
            name: "Allowed",
            versionId: "version",
            definition: { permissions: { pluginInstallIds: ["install"] } },
          },
          {
            nativeName: "denied",
            name: "Denied",
            versionId: "version",
            definition: { permissions: { pluginInstallIds: [] } },
          },
        ],
        authorizePlugin: async () =>
          (await (await fetch(`${base}/authorize`)).json()).allowed === true,
      },
    );
    const child = {
      agent: { kind: "sub", name: "allowed", id: "invocation", depth: 1 },
      ui: {},
    };
    expect(
      await handlers.get("tool_call")?.(
        {},
        { ...child, agent: { ...child.agent, name: "denied" } },
      ),
    ).toBeUndefined();
    expect(authorizations).toBe(0);
    expect(await handlers.get("tool_call")?.({}, child)).toEqual({
      block: true,
    });
    expect(nativeUiView(projection).hooks).toHaveLength(1);
    expect(nativeUiView(projection).hooks[0]).toMatchObject({
      pluginInstallId: "install",
      pluginName: "scoped-plugin",
      event: "tool_call",
      status: "completed",
      result: "blocked",
      source: { subagentId: "invocation", subagentVersionId: "version" },
    });
    await tools[0].execute("tool-call", {}, undefined, undefined, child);
    live = false;
    expect(await handlers.get("tool_call")?.({}, child)).toBeUndefined();
    await expect(
      tools[0].execute("tool-call-2", {}, undefined, undefined, child),
    ).rejects.toThrow("OMP_PLUGIN_SCOPE_DENIED");
    expect(await readFile(marker, "utf8")).toBe("hook\ntool\n");
    expect(nativeUiView(projection).hooks).toHaveLength(1);
  } finally {
    await handlers.get("session_shutdown")?.({}, {});
    const closed = once(server, "close");
    server.close();
    await closed;
    if (previousToken === undefined) delete process.env.TOOLPLANE_RUNTIME_TOKEN;
    else process.env.TOOLPLANE_RUNTIME_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
