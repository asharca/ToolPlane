import { assertDefined } from "../assert-defined";
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PI_SDK_RUNTIME,
  buildSandboxSkillBundles,
  buildSandboxTranscript,
  normalizeSandboxWorkingDirectory,
  parseClaudeStreamLine,
  parseDshEventLine,
  parsePiStreamLine,
  resolveSandboxMcpToolOrigin,
  sandboxRuntimeCanReachProxy,
  sandboxSkillBundleDigest,
  sandboxRuntimeSkillRoot,
  sandboxRuntimeStateRoot,
  waitForSandboxRuntimeInstall,
} from "@/lib/agents/sandbox-runtime";
import type { SkillForPrompt } from "@/lib/agents/resolve";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
  RUNTIME_COMMANDS_PART,
} from "@/lib/agents/runtime-commands";

describe("sandbox Agent runtime helpers", () => {
  it("rejects substituted snapshot metadata and metadata symlinks before loading executable bytes", async () => {
    const verifierPath = join(
      process.cwd(),
      "scripts/pi-sdk-package-files.mjs",
    );
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "pi-sdk-files-")),
    );
    const manifestPath = join(directory, "manifest.json");
    const descriptor = {
      checksum: "a".repeat(64),
      root: join(directory, "snapshot"),
      manifestPath,
    };
    const verify = () =>
      spawnSync(process.execPath, [verifierPath], {
        input: JSON.stringify([descriptor]),
        encoding: "utf8",
      });
    try {
      await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 1, kind: "pi-package", package: {} }),
      );
      expect(verify().stderr).toContain("PI_PACKAGE_CHECKSUM_MISMATCH");
      await rm(manifestPath);
      const substituted = join(directory, "substituted.json");
      await writeFile(substituted, "{}");
      await symlink(substituted, manifestPath);
      expect(verify().stderr).toContain("PI_PACKAGE_CHECKSUM_MISMATCH");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves SDK invocation names and conflict suffixes across saved catalogs without changing legacy case folding", () => {
    const commands = [
      { name: "Review" },
      { name: "review" },
      { name: "Review:1" },
      { name: "skill:MySkill" },
      { name: "new" },
    ];
    const history = [
      {
        parts: [
          {
            type: RUNTIME_COMMANDS_PART,
            data: { runtimeKind: "pi-sdk", commands },
          },
        ],
      },
    ];
    expect(
      sessionRuntimeCommands("pi-sdk", history).map((item) => item.name),
    ).toEqual(["compact", "Review", "review", "Review:1", "skill:MySkill"]);
    expect(sessionRuntimeCommands("pi", history)).toEqual([
      { name: "compact" },
    ]);
    expect(parseRuntimeCommand(" /Review:1 Keep Case ", "pi-sdk")).toEqual({
      name: "Review:1",
      args: "Keep Case",
    });
    expect(parseRuntimeCommand("/Review:1 Keep Case", "pi")).toEqual({
      name: "review:1",
      args: "Keep Case",
    });
    expect(parseRuntimeCommand("/FirstCommand", "pi-sdk")).toEqual({
      name: "FirstCommand",
      args: "",
    });
    expect(parseRuntimeCommand(`/${"a".repeat(101)}`, "pi-sdk")).toBeNull();
    expect(parseRuntimeCommand("/package/path", "pi-sdk")).toBeNull();
  });

  it("keeps work paths inside /workspace and never copies attachment bytes into the transcript", () => {
    expect(normalizeSandboxWorkingDirectory("/workspace/project/../src")).toBe(
      "/workspace/src",
    );
    expect(() => normalizeSandboxWorkingDirectory("../../etc")).toThrow(
      /under \/workspace/,
    );
    const transcript = buildSandboxTranscript([
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "notes.txt",
            data: "secret-base64",
            providerMetadata: {
              toolplane: { runtimePath: "/workspace/uploads/notes.txt" },
            },
          },
        ],
      },
    ]);
    expect(transcript).toContain("/workspace/uploads/notes.txt");
    expect(transcript).not.toContain("secret-base64");
  });

  it("parses Claude stream-json text and final results", () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        }),
      ),
    ).toEqual({ delta: "hello" });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "result",
          is_error: false,
          result: "done",
          usage: {
            input_tokens: 80,
            output_tokens: 10,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 2,
          },
        }),
      ),
    ).toEqual({ result: "done", contextTokens: 100 });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        }),
      ),
    ).toEqual({ activities: [{ type: "reasoning", status: "running" }] });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "Read",
                input: { path: "README.md" },
              },
            ],
          },
        }),
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "call-1",
          toolName: "Read",
          input: { path: "README.md" },
        },
      ],
    });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "contents",
                is_error: false,
              },
            ],
          },
        }),
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "completed",
          toolCallId: "call-1",
          output: "contents",
          isError: false,
        },
      ],
    });
    expect(parseClaudeStreamLine("not json")).toBeNull();
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "system",
          subtype: "status",
          compact_result: "failed",
          compact_error: "context too large",
        }),
      ),
    ).toEqual({ result: "context too large", isError: true });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "result",
          is_error: true,
          errors: ["Native error"],
        }),
      ),
    ).toEqual({ result: "Native error", isError: true });
  });

  it("parses historical Pi JSONL text and failures", () => {
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        }),
      ),
    ).toEqual({ delta: "hello" });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "checking files",
          },
        }),
      ),
    ).toEqual({
      activities: [
        { type: "reasoning", status: "running", delta: "checking files" },
      ],
    });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read_file",
          args: { path: "README.md" },
        }),
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "README.md" },
        },
      ],
    });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "toolplane_mcp_origin",
          toolCallId: "call-1",
          deploymentId: "dep-1",
          originalToolName: "read/file",
        }),
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "call-1",
          deploymentId: "dep-1",
          originalToolName: "read/file",
        },
      ],
    });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "read_file",
          result: "contents",
          isError: false,
        }),
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "completed",
          toolCallId: "call-1",
          toolName: "read_file",
          output: "contents",
          isError: false,
        },
      ],
    });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input: 80, output: 20, totalTokens: 100 },
          },
        }),
      ),
    ).toEqual({ assistantText: "done", contextTokens: 100 });
    expect(
      parsePiStreamLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "bad request",
          },
        }),
      ),
    ).toEqual({ error: "bad request", isError: true });
  });

  it("pins SDK install specs and disables package lifecycle scripts", () => {
    expect(PI_SDK_RUNTIME.specs).toEqual([
      "@earendil-works/pi-coding-agent@0.87.1",
      "@earendil-works/pi-ai@0.87.1",
    ]);
    expect(PI_SDK_RUNTIME).toMatchObject({
      ignoreScripts: true,
      allowBuilds: [],
    });
  });

  it("lets one cancelled caller stop waiting without cancelling a shared runtime install", async () => {
    const controller = new AbortController();
    let finishInstall!: (value: string) => void;
    const install = new Promise<string>((resolve) => {
      finishInstall = resolve;
    });
    const cancelled = waitForSandboxRuntimeInstall(install, controller.signal);
    const waiting = waitForSandboxRuntimeInstall(install);

    controller.abort();
    await expect(cancelled).rejects.toThrow("Sandbox runtime aborted.");
    finishInstall("/runtime/bin/pi");
    await expect(waiting).resolves.toBe("/runtime/bin/pi");
  });

  it("recovers MCP origin only from stable runtime aliases", () => {
    const servers = [
      { deploymentId: "dep-one", url: "https://runtime.example/one" },
      { deploymentId: "dep-two", url: "https://runtime.example/two" },
    ];
    expect(
      resolveSandboxMcpToolOrigin("mcp__s2_t4__search_files", servers),
    ).toEqual({ deploymentId: "dep-two" });
    expect(
      resolveSandboxMcpToolOrigin("mcp__tp_1_dep-one__read/file", servers),
    ).toEqual({
      deploymentId: "dep-one",
      originalToolName: "read/file",
    });
    expect(
      resolveSandboxMcpToolOrigin("tp_2_dep-two__write_file", servers),
    ).toEqual({
      deploymentId: "dep-two",
      originalToolName: "write_file",
    });
    expect(resolveSandboxMcpToolOrigin("bash", servers)).toBeNull();
  });

  it("parses archived DSH text, reasoning, and tool events", () => {
    expect(
      parseDshEventLine(
        '__EVENT__{"type":"text","delta":"hello"}',
        "__EVENT__",
      ),
    ).toEqual({ delta: "hello" });
    expect(
      parseDshEventLine(
        '__EVENT__{"type":"reasoning","status":"running","delta":"checking"}',
        "__EVENT__",
      ),
    ).toEqual({
      activities: [{ type: "reasoning", status: "running", delta: "checking" }],
    });
    expect(
      parseDshEventLine(
        '__EVENT__{"type":"tool","status":"running","toolCallId":"call-1","toolName":"bash","input":"{\\"command\\":\\"ls\\"}"}',
        "__EVENT__",
      ),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "ls" },
          isError: false,
        },
      ],
    });
  });

  it("preserves proxy isolation and safe historical state paths", () => {
    expect(sandboxRuntimeCanReachProxy("none")).toBe(false);
    expect(sandboxRuntimeCanReachProxy("isolated")).toBe(true);
    expect(sandboxRuntimeStateRoot("claude-code", "agent/a")).toBe(
      "/workspace/.toolplane/runtimes/claude-code/agents/agent_a",
    );
    expect(sandboxRuntimeStateRoot("dsh", "agent/a")).toBe(
      "/workspace/.toolplane/runtimes/dsh/agents/agent_a",
    );
    expect(sandboxRuntimeStateRoot("pi", "agent/a")).toBe(
      "/workspace/.toolplane/runtimes/pi/agents/agent_a",
    );
    expect(sandboxRuntimeStateRoot("pi", "..")).toBe(
      "/workspace/.toolplane/runtimes/pi/agents/agent",
    );
    expect(sandboxRuntimeSkillRoot("pi", "agent/a")).toBe(
      "/workspace/.toolplane/runtimes/pi/agents/agent_a/skills",
    );
    expect(sandboxRuntimeSkillRoot("claude-code", "agent/a")).toBe(
      `${sandboxRuntimeStateRoot("claude-code", "agent/a")}/skills`,
    );
  });

  it("projects complete skill directories with unique names and content-sensitive digests", () => {
    const bundles = buildSandboxSkillBundles([
      {
        skillId: null,
        slug: "Deploy Tool",
        name: "Deploy",
        content: "Always run the smoke check.",
        files: [
          { path: "references/checklist.md", content: "# Checklist" },
          {
            path: "scripts/deploy.sh",
            content: "ZWNobyBkZXBsb3k=",
            encoding: "base64",
          },
        ],
        skill: null,
      },
      {
        skillId: null,
        slug: "Deploy Tool",
        name: "Deploy again",
        content: "Second.",
        skill: null,
      },
    ] satisfies SkillForPrompt[]);
    expect(bundles.map((bundle) => bundle.directory)).toEqual([
      "deploy-tool",
      "deploy-tool-2",
    ]);
    expect(bundles[0]?.markdown).toContain("Always run the smoke check.");
    expect(bundles[0]?.files).toEqual([
      { path: "references/checklist.md", content: "# Checklist" },
      {
        path: "scripts/deploy.sh",
        content: "ZWNobyBkZXBsb3k=",
        encoding: "base64",
      },
    ]);
    expect(sandboxSkillBundleDigest(bundles)).toMatch(/^[a-f0-9]{64}$/);
    expect(sandboxSkillBundleDigest(bundles)).not.toBe(
      sandboxSkillBundleDigest([
        {
          ...assertDefined(bundles[0]),
          markdown: `${assertDefined(bundles[0]).markdown}\nChanged`,
        },
        assertDefined(bundles[1]),
      ]),
    );
  });
});
