// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createConversation } from "@/lib/agents/mutations";
import { getAgentForRun, getConversation } from "@/lib/agents/queries";
import { resolveAgentRequestSession } from "@/lib/agents/request-session";
import { isAgentRuntimeGrantCurrent } from "@/lib/agents/runtime-grant";
import { serveHistoricalSandboxFiles } from "@/lib/agents/historical-sandbox";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";

const stamp = randomUUID();
let userId = "";
let workspaceId = "";
let providerId = "";
let sequence = 0;
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `agent-entrances-${stamp}@test.invalid`,
      passwordHash: "fixture",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      ownerId: userId,
      slug: `agent-entrances-${stamp}`,
      name: "Agent entrances",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Fixture",
      format: "openai",
      baseUrl: "https://fixture.test.invalid",
      apiKey: "fixture",
      models: ["original", "future"],
    },
  });
  providerId = provider.id;
});
afterAll(async () => {
  if (workspaceId) {
    await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
});
async function fixture() {
  const slug = `entrance-${++sequence}`;
  const deployment = await db.deployment.create({
    data: { workspaceId, source: "sandbox", status: "stopped" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: slug,
      slug,
      kind: "docker",
      network: "isolated",
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: slug,
      slug,
      runtimeKind: "pi-sdk",
      providerId,
      model: "original",
      systemPrompt: "Original prompt",
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  const revision = await publishFixtureAgentRevision(workspaceId, agent.id);
  const conversation = await createConversation(workspaceId, agent.id);
  if (!conversation) throw new Error("Missing conversation fixture");
  return { agent, sandbox, revision, conversation };
}

describe.sequential("Agent execution entrance revision boundaries", () => {
  it("keeps resource requests and metadata on the session revision after a new publication", async () => {
    const { agent, revision, conversation } = await fixture();
    expect(conversation).toMatchObject({
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { model: "future", systemPrompt: "Future prompt" },
    });
    const future = await publishFixtureAgentRevision(workspaceId, agent.id);
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live) throw new Error("Missing Agent fixture");
    const resolved = await resolveAgentRequestSession(live, {
      conversationId: conversation.id,
    });
    expect(resolved.agent).toMatchObject({
      agentRevisionId: revision.id,
      model: "original",
      systemPrompt: "Original prompt",
    });
    expect(resolved.mcpContext.agentRevisionId).toBe(revision.id);
    const view = await getConversation(conversation.id, workspaceId);
    expect(view).toMatchObject({
      readOnly: false,
      agentRevisionId: revision.id,
      runtimeKind: "pi-sdk",
      modelName: "original",
      contextWindow: null,
      contextWindowEstimated: null,
      boundSandbox: null,
    });
    expect(
      (await createConversation(workspaceId, agent.id))?.agentRevisionId,
    ).toBe(future.id);
  });
  it("keeps unresolved history readable without selecting a current revision or template", async () => {
    const { agent } = await fixture();
    const history = await db.conversation.create({
      data: {
        agentId: agent.id,
        messages: {
          create: {
            role: "assistant",
            parts: [{ type: "text", text: "Retained history" }],
          },
        },
      },
    });
    const view = await getConversation(history.id, workspaceId);
    expect(view).toMatchObject({
      readOnly: true,
      agentRevisionId: null,
      legacyRevisionUnresolved: true,
      runtimeKind: null,
      modelName: null,
      boundSandbox: null,
    });
    expect(view?.messages).toHaveLength(1);
    const live = await getAgentForRun(agent.id, workspaceId);
    if (!live) throw new Error("Missing Agent fixture");
    await expect(
      resolveAgentRequestSession(live, { conversationId: history.id }),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("rejects mismatched Work and Conversation pins rather than repinning either record", async () => {
    const { agent, revision, conversation } = await fixture();
    const future = await publishFixtureAgentRevision(workspaceId, agent.id);
    const work = await db.workSession.create({
      data: {
        workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        agentRevisionId: future.id,
        legacyRevisionUnresolved: false,
        runtimeKind: "pi-sdk",
        runtimeSnapshot: {},
        task: "Mismatched session",
      },
    });
    try {
      const live = await getAgentForRun(agent.id, workspaceId);
      if (!live) throw new Error("Missing Agent fixture");
      await expect(
        resolveAgentRequestSession(live, { workSessionId: work.id }),
      ).rejects.toMatchObject({ status: 410 });
      expect(await getConversation(conversation.id, workspaceId)).toMatchObject(
        { readOnly: true, agentRevisionId: revision.id },
      );
    } finally {
      await db.workSession.delete({ where: { id: work.id } });
    }
  });
  it("rechecks live provider authorization against the exact persisted sandbox and revision", async () => {
    const { agent, sandbox, revision, conversation } = await fixture();
    await db.conversation.update({
      where: { id: conversation.id },
      data: { sandboxId: sandbox.id },
    });
    const token = {
      workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      providerId,
      deploymentIds: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(true);
    await expect(
      isAgentRuntimeGrantCurrent({ ...token, sandboxId: "another-sandbox" }),
    ).resolves.toBe(false);
    await db.agent.update({
      where: { id: agent.id },
      data: { providerId: null },
    });
    await expect(isAgentRuntimeGrantCurrent(token)).resolves.toBe(false);
    expect(
      await db.conversation.findUnique({ where: { id: conversation.id } }),
    ).toMatchObject({ agentRevisionId: revision.id, sandboxId: sandbox.id });
  });
  it.each(["shell_exec", "write_file", "delete_file"])(
    "denies historical %s without starting any runtime",
    async (name) => {
      const response = await serveHistoricalSandboxFiles(
        new Request("http://toolplane.test/sandbox/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { path: "history.txt" } },
          }),
        }),
        ["rpc"],
        null,
      );
      expect(response.status).toBe(410);
    },
  );
});
