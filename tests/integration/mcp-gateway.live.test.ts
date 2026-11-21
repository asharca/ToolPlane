// @vitest-environment node
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proxyMcpRpcRequest } from "@/lib/process/mcp-gateway";

const state = vi.hoisted(() => ({ port: 0 }));
vi.mock("@/lib/process/supervisor", () => ({
  livePort: () => state.port,
  liveRedactionValues: () => [],
}));
vi.mock("@/lib/observability/events", () => ({ recordEvent: async () => {} }));
const run = promisify(execFile);
const deployment = {
  id: "everything",
  workspaceId: "test",
  mcpToolExposure: "all",
  mcpAllowedTools: [],
  principalKey: "alice",
};
const endpoint = "http://localhost/api/v1/mcp/everything/rpc";
const pinned = "@modelcontextprotocol/server-everything@2.3.1";

describe.skipIf(process.env.SANDBOX_DOCKER_SMOKE !== "1")(
  "official everything server over isolated stdio and the gateway",
  () => {
    const container = `mcp-everything-live-${randomUUID()}`;
    const client = new Client(
      { name: "live", version: "1" },
      { capabilities: { sampling: {}, elicitation: { form: {} } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: (input, init) =>
        proxyMcpRpcRequest(new Request(input, init), deployment),
    });
    let directory: string;
    let bridge: ChildProcess;
    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "toolplane-everything-"));
      await writeFile(path.join(directory, "package.json"), '{"private":true}');
      await run(
        "pnpm",
        [
          "--dir",
          directory,
          "--config.node-linker=hoisted",
          "add",
          "--ignore-scripts",
          pinned,
        ],
        { timeout: 120_000 },
      );
      const image = process.env.MCP_TEST_NODE_IMAGE || "node:26-bookworm-slim";
      assert(
        process.getuid && process.getgid,
        "Docker smoke requires POSIX IDs",
      );
      const args = [
        "run",
        "--rm",
        "-i",
        "--name",
        container,
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--pids-limit",
        "128",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--mount",
        `type=bind,source=${directory},target=/fixture,readonly`,
        image,
        "node",
        "/fixture/node_modules/@modelcontextprotocol/server-everything/dist/index.js",
      ];
      bridge = spawn(process.execPath, ["scripts/mcp-stdio-bridge.mjs"], {
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MCP_COMMAND: "docker",
          MCP_IMAGE: image,
          MCP_CONTAINER_NAME: container,
          MCP_ARGS: JSON.stringify(args),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      assert(bridge.stderr && bridge.stdout);
      bridge.stderr.on("data", (d) => {
        diagnostics = (diagnostics + d).slice(-2000);
      });
      const ready = Promise.withResolvers<void>();
      bridge.once("error", ready.reject);
      bridge.once("exit", () =>
        ready.reject(new Error(`Bridge exited: ${diagnostics}`)),
      );
      bridge.stdout.on("data", (data) => {
        const m = /LISTENING (\d+)/.exec(String(data));
        if (m) {
          state.port = Number(m[1]);
          ready.resolve();
        }
      });
      await ready.promise;
      client.setRequestHandler(CreateMessageRequestSchema, (req) => ({
        role: "assistant",
        model: "test-client",
        content: {
          type: "text",
          text: `client sampled: ${JSON.stringify(req.params.messages)}`,
        },
      }));
      client.setRequestHandler(ElicitRequestSchema, () => ({
        action: "accept",
        content: { name: "MCP Live" },
      }));
      await client.connect(transport);
    }, 180_000);
    afterAll(async () => {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
      if (bridge && bridge.exitCode === null && !bridge.signalCode) {
        const closed = once(bridge, "exit");
        bridge.kill("SIGTERM");
        await run("docker", ["rm", "-f", container]).catch(() => undefined);
        await closed;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 25_000);

    it("reads a resource, renders a prompt and completes arguments", async () => {
      const listed = await client.listResources();
      const resource = await client.readResource({
        uri: listed.resources[0].uri,
      });
      expect(resource.contents[0]).toHaveProperty("text");
      const prompt = await client.getPrompt({
        name: "args-prompt",
        arguments: { city: "Paris" },
      });
      expect(JSON.stringify(prompt.messages)).toContain("Paris");
      const result = await client.complete({
        ref: { type: "ref/prompt", name: "completable-prompt" },
        argument: { name: "department", value: "Eng" },
      });
      expect(result.completion.values).toContain("Engineering");
    });
    it("round trips server sampling and elicitation requests", async () => {
      const sample = await client.callTool({
        name: "trigger-sampling-request",
        arguments: { prompt: "MCP_LIVE_SAMPLE" },
      });
      expect(sample.isError).not.toBe(true);
      expect(JSON.stringify(sample.content)).toContain("client sampled:");
      const form = await client.callTool({
        name: "trigger-elicitation-request",
        arguments: {},
      });
      expect(JSON.stringify(form.content)).toContain("Name: MCP Live");
    });
    it("accepts a batch only on the session that actually negotiated 2025-03-26", async () => {
      const version = "2025-03-26";
      const call = (payload: unknown, session?: string) =>
        proxyMcpRpcRequest(
          new Request(endpoint, {
            method: "POST",
            body: JSON.stringify(payload),
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(session
                ? { "mcp-session-id": session, "mcp-protocol-version": version }
                : {}),
            },
          }),
          deployment,
        );
      const init = await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" },
        },
      });
      const session = init.headers.get("mcp-session-id");
      assert(session, "initialize must return a session ID");
      const batch = ["a", "b"].map((id) => ({
        jsonrpc: "2.0",
        id,
        method: "ping",
      }));
      try {
        expect(await init.text()).toContain(`"protocolVersion":"${version}"`);
        await call(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          session,
        );
        const response = await call(batch, session);
        expect(response.status).toBe(200);
        const stream = await response.text();
        for (const { id } of batch) expect(stream).toContain(`"id":"${id}"`);
        expect((await call(batch, transport.sessionId)).status).toBe(400);
      } finally {
        await proxyMcpRpcRequest(
          new Request(endpoint, {
            method: "DELETE",
            headers: { "mcp-session-id": session },
          }),
          deployment,
        );
      }
    });
    it("delivers unsolicited list changes to the subscribed client", async () => {
      const changed = Promise.withResolvers<void>();
      client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        changed.resolve(),
      );
      await client.callTool({
        name: "trigger-list-changed",
        arguments: { list: "prompts" },
      });
      await changed.promise;
    });
    it("streams intermediate progress and survives the previous 30s deadline", async () => {
      const progress: number[] = [];
      const start = Date.now();
      const result = await client.callTool(
        {
          name: "trigger-long-running-operation",
          arguments: { duration: 31, steps: 3 },
        },
        undefined,
        { timeout: 45_000, onprogress: (p) => progress.push(p.progress) },
      );
      expect(Date.now() - start).toBeGreaterThan(30_000);
      expect(progress).toEqual([1, 2, 3]);
      expect(JSON.stringify(result.content)).toContain("completed");
    }, 50_000);
    it("cancels a running operation without invalidating the session", async () => {
      const session = transport.sessionId;
      assert(session);
      const post = (message: Record<string, unknown>) =>
        proxyMcpRpcRequest(
          new Request(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "mcp-session-id": session,
            },
            body: JSON.stringify({ jsonrpc: "2.0", ...message }),
            signal: AbortSignal.timeout(4000),
          }),
          deployment,
        );
      const id = "cancel-live";
      const response = await post({
        id,
        method: "tools/call",
        params: {
          name: "trigger-long-running-operation",
          arguments: { duration: 60, steps: 120 },
          _meta: { progressToken: "cancel-progress" },
        },
      });
      assert(response.body);
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      expect((await reader.read()).value).toContain("notifications/progress");
      expect(
        (
          await post({
            method: "notifications/cancelled",
            params: { requestId: id },
          })
        ).status,
      ).toBe(202);
      let tail = "";
      for (
        let next = await reader.read();
        !next.done;
        next = await reader.read()
      )
        tail += next.value;
      expect(tail).toContain("MCP_REQUEST_CANCELLED");
      expect(await client.ping()).toEqual({});
    });
    it("rejects a stolen session id under a different principal", async () => {
      const session = transport.sessionId;
      assert(session);
      const other = await proxyMcpRpcRequest(
        new Request(endpoint, {
          headers: { "mcp-session-id": session },
        }),
        { ...deployment, principalKey: "mallory" },
      );
      expect(other.status).toBe(404);
    });
  },
);
