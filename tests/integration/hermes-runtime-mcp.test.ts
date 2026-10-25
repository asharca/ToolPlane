// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/v1/agent-runtimes/[runtimeId]/mcp/route";
let userId = "";
let workspaceId = "";
let agentId = "";
let runtimeId = "";
let conversationId = "";
let sandboxId = "";
let deploymentId = "";
beforeAll(async () => {
  const suffix = randomUUID();
  const user = await db.user.create({
    data: { email: `retired-mcp-${suffix}@test.dev`, passwordHash: "x" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `retired-mcp-${suffix}`,
      name: "Retained Hermes MCP history",
      ownerId: user.id,
    },
  });
  workspaceId = workspace.id;
  // Seed retained pre-cutover data directly: the creation API intentionally rejects Hermes.
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: "Retained Agent",
      slug: "retained-agent",
      runtimeKind: "hermes",
      retiredAt: new Date(),
    },
  });
  agentId = agent.id;
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Retained storage",
      source: "sandbox",
      sourceRef: "nousresearch/hermes-agent:retained",
      status: "stopped",
    },
  });
  deploymentId = deployment.id;
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId,
      name: "Retained files",
      slug: "retained-files",
      kind: "hermes",
      image: "nousresearch/hermes-agent:retained",
      network: "none",
    },
  });
  sandboxId = sandbox.id;
  const runtime = await db.agentRuntime.create({
    data: {
      workspaceId,
      agentId,
      sandboxId,
      kind: "hermes",
      image: "nousresearch/hermes-agent:retained",
      status: "stopped",
    },
  });
  runtimeId = runtime.id;
  const conversation = await db.conversation.create({
    data: {
      agentId,
      sandboxId,
      title: "Retained history",
      legacyRevisionUnresolved: true,
      messages: {
        create: {
          role: "user",
          parts: [{ type: "text", text: "Historical message" }],
        },
      },
    },
  });
  conversationId = conversation.id;
});
afterAll(async () => {
  if (agentId) await db.conversation.deleteMany({ where: { agentId } });
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
describe("retired Hermes runtime MCP with real retained data", () => {
  it.each(["initialize", "tools/list", "tools/call"])(
    "rejects %s without resuming or deleting the retained session",
    async (method) => {
      const response = await POST(
        new Request(`http://localhost/api/v1/agent-runtimes/${runtimeId}/mcp`, {
          method: "POST",
          headers: {
            authorization: "Bearer revoked-legacy-client",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              name: "retained__shell",
              arguments: { command: "must not execute" },
            },
          }),
        }),
      );
      expect(response.status).toBe(410);
      expect(
        await db.agentRuntime.findUnique({ where: { id: runtimeId } }),
      ).toMatchObject({ agentId, sandboxId, status: "stopped" });
      expect(
        await db.deployment.findUnique({ where: { id: deploymentId } }),
      ).toMatchObject({ status: "stopped" });
      expect(
        await db.conversation.findUnique({
          where: { id: conversationId },
          include: { messages: true },
        }),
      ).toMatchObject({
        agentId,
        sandboxId,
        legacyRevisionUnresolved: true,
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "Historical message" }],
          },
        ],
      });
    },
  );
});
