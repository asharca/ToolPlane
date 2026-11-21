// @vitest-environment node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { GET, POST, DELETE } from "@/app/api/v1/mcp/[deploymentId]/rpc/route";
import { sample } from "@/lib/process/mcp-callbacks";

const suffix = randomUUID();
const users: string[] = [];
const workspaces: string[] = [];
let deploymentId: string, personal: string, other: string, toolkit: string;
let requests = 0;
const upstream = createServer((req, res) => {
  requests++;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: "SAMPLED" }, null],
    [{}, "stop"],
  ]) {
    res.write(
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "fixture", created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  }
  res.end("data: [DONE]\n\n");
});

describe("gateway and callback workspace authority", () => {
  beforeAll(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    for (const label of ["owner", "other"]) {
      const user = await db.user.create({
        data: {
          email: `${label}-${suffix}@example.test`,
          passwordHash: "fixture",
        },
      });
      users.push(user.id);
      const ws = await db.workspace.create({
        data: { ownerId: user.id, slug: `${label}-${suffix}`, name: label },
      });
      workspaces.push(ws.id);
    }
    deploymentId = (
      await db.deployment.create({
        data: { workspaceId: workspaces[0], source: "remote" },
      })
    ).id;
    const set = await db.toolkit.create({
      data: {
        name: "retired",
        slug: suffix,
        workspaceId: workspaces[0],
        servers: { create: { deploymentId } },
      },
    });
    personal = (await createApiToken(users[0], "personal")).token;
    other = (await createApiToken(users[1], "personal")).token;
    toolkit = (await createApiToken(users[0], "legacy", { toolkitId: set.id }))
      .token;
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: workspaces[0],
        name: "test",
        apiKey: "fixture",
        format: "openai",
        models: ["fixture"],
        baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      },
    });
    await db.workspace.update({
      where: { id: workspaces[0] },
      data: { defaultModel: "fixture", defaultModelProviderId: provider.id },
    });
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  });
  it("does not treat a known deployment/session id as authority on any verb", async () => {
    for (const [verb, handler] of [
      ["POST", POST],
      ["GET", GET],
      ["DELETE", DELETE],
    ] as const) {
      const request = (token: string) =>
        handler(
          new Request("http://localhost/api/mcp", {
            method: verb,
            headers: {
              authorization: `Bearer ${token}`,
              "mcp-session-id": "known",
            },
            ...(verb === "POST"
              ? {
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "ping",
                    id: 1,
                  }),
                }
              : {}),
          }),
          { params: Promise.resolve({ deploymentId }) },
        );
      expect((await request(other)).status).toBe(404);
      expect((await request(toolkit)).status).toBe(401);
      expect((await request(personal)).status).toBe(503); // Authorized, deployment is not running.
    }
  });
  it("dispatches to the workspace provider only while this deployment has live opt-in", async () => {
    const params = {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "hello" },
        },
      ],
      maxTokens: 16,
    };
    const ask = (workspaceId: string) =>
      sample(
        { workspaceId, deploymentId },
        params,
        AbortSignal.timeout(10_000),
      );
    await expect(ask(workspaces[0])).rejects.toThrow("MCP_SAMPLING_DISABLED");
    await db.deployment.update({
      where: { id: deploymentId },
      data: { samplingEnabled: true },
    });
    await expect(ask(workspaces[1])).rejects.toThrow("MCP_SAMPLING_DISABLED");
    expect(requests).toBe(0);
    expect(await ask(workspaces[0])).toMatchObject({
      model: "fixture",
      content: { type: "text", text: "SAMPLED" },
    });
    await db.deployment.update({
      where: { id: deploymentId },
      data: { samplingEnabled: false },
    });
    await expect(ask(workspaces[0])).rejects.toThrow("MCP_SAMPLING_DISABLED");
    expect(requests).toBe(1);
  });
});
