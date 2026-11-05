// @vitest-environment node
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
import { describe, expect, it } from "vitest";
import {
  NativeUiAction,
  applyNativeUiAction,
  nativeUiView,
  respondNativeUi,
} from "@/lib/agents/execution/native-ui";
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
