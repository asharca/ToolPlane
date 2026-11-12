// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { acquireConversationOperation } from "@/lib/agents/conversation-operations";
import {
  GET,
  POST,
} from "@/app/api/v1/agents/[agentId]/conversations/[conversationId]/revision/route";
import { GET as getContentDiff } from "@/app/api/v1/agents/[agentId]/revisions/diff/route";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () => (auth.userId ? { id: auth.userId } : null),
}));

const stamp = randomUUID();
let userId: string,
  outsiderId: string,
  workspaceId: string,
  agentId: string,
  otherAgentId: string;
let oldRevisionId: string, newRevisionId: string;
const config: AgentRevisionConfig = {
  schemaVersion: 1,
  runtimeKind: "pi-sdk",
  systemPrompt: "Original prompt",
  providerId: null,
  model: null,
  modelProviderIds: [],
  maxSteps: 10,
  disabledBuiltinTools: [],
  sandboxTemplateId: null,
  externalSandboxes: [],
  environment: {
    kind: "docker",
    image: `fixture@sha256:${"a".repeat(64)}`,
    network: "isolated",
    piVersion: "0.87.1",
    initialSnapshot: null,
    resourceLimits: { memoryBytes: 1024 * 1024 * 512, cpus: 1, pidsLimit: 128 },
    credentialReferences: [],
  },
  skills: [],
  knowledgeBaseIds: [],
  packages: [],
  mcpGrants: [],
  a2a: {
    inboundEnabled: false,
    outboundEnabled: false,
    policy: { schemaVersion: 1, targets: [] },
  },
};
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `agent-upgrade-${stamp}@example.invalid`,
      passwordHash: "fixture",
    },
  });
  userId = user.id;
  outsiderId = (
    await db.user.create({
      data: {
        email: `agent-upgrade-outsider-${stamp}@example.invalid`,
        passwordHash: "fixture",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: "Agent upgrade fixture",
        slug: `agent-upgrade-${stamp}`,
        ownerId: userId,
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "upgrade",
        name: "Upgrade",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
  otherAgentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "other",
        name: "Other",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
  oldRevisionId = (
    await db.agentRevision.create({ data: { agentId, version: 1, config } })
  ).id;
  newRevisionId = (
    await db.agentRevision.create({
      data: {
        agentId,
        version: 2,
        config: { ...config, systemPrompt: "Updated prompt", maxSteps: 12 },
      },
    })
  ).id;
  await db.agent.update({
    where: { id: agentId },
    data: { currentRevisionVersion: 2 },
  });
  auth.userId = userId;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({
    where: { id: { in: [userId, outsiderId].filter(Boolean) } },
  });
  await db.$disconnect();
});

async function createSession(status = "idle") {
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Saved files",
      source: "sandbox",
      sourceRef: "docker",
    },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: "Existing volume",
      slug: `sandbox-${randomUUID()}`,
      kind: "docker",
      image: config.environment.image,
      network: "isolated",
      config: {
        managedBy: "agent-conversation",
        agentId,
        sourceSandboxId: "revision",
        agentRevisionId: oldRevisionId,
      },
    },
  });
  const conversation = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: oldRevisionId,
      legacyRevisionUnresolved: false,
      sandboxId: sandbox.id,
      title: "Retained title",
      messages: {
        create: {
          role: "user",
          parts: [{ type: "text", text: "Retained transcript" }],
        },
      },
    },
    include: { messages: true },
  });
  const work = await db.workSession.create({
    data: {
      workspaceId,
      agentId,
      agentRevisionId: oldRevisionId,
      legacyRevisionUnresolved: false,
      runtimeKind: "pi-sdk",
      conversationId: conversation.id,
      sandboxId: sandbox.id,
      status,
      task: "Retained task",
      artifacts: ["/workspace/retained.txt"],
      runtimeSnapshot: {
        agentRevisionId: oldRevisionId,
        agentMaxSteps: 10,
        workingDirectory: "saved-project",
        deploymentIds: ["obsolete-deployment"],
        piPackages: [],
      },
    },
  });
  return { conversation, work, sandbox };
}
function request(
  method: "GET" | "POST",
  conversationId: string,
  targetVersion = 2,
  routeAgentId = agentId,
) {
  const url = `http://localhost/api/v1/agents/${routeAgentId}/conversations/${conversationId}/revision`;
  const req =
    method === "GET"
      ? new Request(`${url}?targetVersion=${targetVersion}`)
      : new Request(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetVersion }),
        });
  return (method === "GET" ? GET : POST)(req, {
    params: Promise.resolve({ agentId: routeAgentId, conversationId }),
  });
}
it("upgrades Conversation and linked Work in place, retaining messages, sandbox and artifacts", async () => {
  const { conversation, work, sandbox } = await createSession();
  const preview = await request("GET", conversation.id);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    diff: {
      fromVersion: 1,
      toVersion: 2,
      changedFields: ["systemPrompt", "maxSteps"],
    },
  });
  const response = await request("POST", conversation.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    conversationId: conversation.id,
    version: 2,
  });
  const saved = await db.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
    include: { messages: true, workSession: true, sandbox: true },
  });
  expect(saved).toMatchObject({
    id: conversation.id,
    agentRevisionId: newRevisionId,
    title: "Retained title",
    sandboxId: sandbox.id,
  });
  expect(saved.messages).toEqual(conversation.messages);
  expect(saved.workSession).toMatchObject({
    id: work.id,
    agentRevisionId: newRevisionId,
    artifacts: ["/workspace/retained.txt"],
    task: "Retained task",
  });
  expect(saved.workSession?.runtimeSnapshot).toMatchObject({
    agentRevisionId: newRevisionId,
    agentMaxSteps: 12,
    systemPrompt: "Updated prompt",
    workingDirectory: "saved-project",
    deploymentIds: [],
    piPackages: [],
  });
  expect(saved.sandbox?.config).toMatchObject({
    agentRevisionId: newRevisionId,
  });
});
it("rejects another Agent's URL, non-current targets, and users outside the workspace", async () => {
  const { conversation } = await createSession();
  expect((await request("POST", conversation.id, 2, otherAgentId)).status).toBe(
    404,
  );
  const nonCurrent = await request("POST", conversation.id, 1);
  expect(nonCurrent.status).toBe(409);
  expect(await nonCurrent.json()).toEqual({
    error: "targetRevisionNotCurrent",
  });
  auth.userId = outsiderId;
  try {
    expect((await request("POST", conversation.id)).status).toBe(404);
  } finally {
    auth.userId = userId;
  }
  expect(
    (
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      })
    ).agentRevisionId,
  ).toBe(oldRevisionId);
});
it("rejects queued Work and an admitted conversation turn without moving either pin", async () => {
  const { conversation, work } = await createSession("queued");
  expect((await request("POST", conversation.id)).status).toBe(409);
  await db.workSession.update({
    where: { id: work.id },
    data: { status: "idle" },
  });
  const release = acquireConversationOperation(conversation.id);
  try {
    expect((await request("POST", conversation.id)).status).toBe(409);
  } finally {
    release?.();
  }
  expect(
    (
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      })
    ).agentRevisionId,
  ).toBe(oldRevisionId);
  expect(
    (await db.workSession.findUniqueOrThrow({ where: { id: work.id } }))
      .agentRevisionId,
  ).toBe(oldRevisionId);
});

it("upgrades one shared-sandbox session without moving another pin or its environment, and rejects implicit environment cutover", async () => {
  const { conversation, sandbox } = await createSession();
  const sharedConfig = {
    managedBy: "agent-conversation",
    scope: "agent",
    agentId,
    sourceSandboxId: "revision",
    agentRevisionId: oldRevisionId,
  };
  await db.sandbox.update({
    where: { id: sandbox.id },
    data: { config: sharedConfig },
  });
  const other = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: oldRevisionId,
      legacyRevisionUnresolved: false,
      sandboxId: sandbox.id,
    },
  });
  expect((await request("POST", conversation.id)).status).toBe(200);
  expect(
    (await db.sandbox.findUniqueOrThrow({ where: { id: sandbox.id } })).config,
  ).toEqual(sharedConfig);
  expect(
    (await db.conversation.findUniqueOrThrow({ where: { id: other.id } }))
      .agentRevisionId,
  ).toBe(oldRevisionId);
  const changedEnvironment = await db.agentRevision.create({
    data: {
      agentId,
      version: 3,
      config: {
        ...config,
        environment: { ...config.environment, network: "none" },
      },
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { currentRevisionVersion: 3 },
  });
  const response = await request("POST", conversation.id, 3);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "AGENT_SHARED_ENVIRONMENT_CONFLICT",
  });
  expect(
    (
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      })
    ).agentRevisionId,
  ).toBe(newRevisionId);
  expect(
    (await db.conversation.findUniqueOrThrow({ where: { id: other.id } }))
      .agentRevisionId,
  ).toBe(oldRevisionId);
  expect(
    (await db.sandbox.findUniqueOrThrow({ where: { id: sandbox.id } })).config,
  ).toEqual(sharedConfig);
  expect(changedEnvironment.id).not.toBe(oldRevisionId);
});

it("shows exact historical prompt changes only to an authorized workspace member", async () => {
  auth.userId = userId;
  const response = await getContentDiff(
    new Request(
      `http://localhost/api/v1/agents/${agentId}/revisions/diff?fromVersion=1&toVersion=2`,
    ),
    { params: Promise.resolve({ agentId }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const prompt = body.files.find(
    (file: { path: string }) => file.path === "systemPrompt.md",
  );
  expect(prompt.lines).toEqual([
    { id: "0", type: "removed", content: "Original prompt", oldLine: 1 },
    { id: "1", type: "added", content: "Updated prompt", newLine: 1 },
  ]);
  auth.userId = outsiderId;
  const denied = await getContentDiff(
    new Request(
      `http://localhost/api/v1/agents/${agentId}/revisions/diff?toVersion=2`,
    ),
    { params: Promise.resolve({ agentId }) },
  );
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Original prompt");
});

it("compares a candidate with its recorded parent rather than a newer unrelated publication", async () => {
  auth.userId = userId;
  const maximum = await db.agentRevision.aggregate({
    where: { agentId },
    _max: { version: true },
  });
  const candidate = await db.agentRevision.create({
    data: {
      agentId,
      version: (maximum._max.version ?? 0) + 1,
      purpose: "candidate",
      parentRevisionId: oldRevisionId,
      config: { ...config, systemPrompt: "Candidate prompt" },
    },
  });
  const response = await getContentDiff(
    new Request(
      `http://localhost/api/v1/agents/${agentId}/revisions/diff?toVersion=${candidate.version}`,
    ),
    { params: Promise.resolve({ agentId }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.fromVersion).toBe(1);
  const prompt = body.files.find(
    (file: { path: string }) => file.path === "systemPrompt.md",
  );
  expect(prompt.lines.map((line: { content: string }) => line.content)).toEqual(
    ["Original prompt", "Candidate prompt"],
  );
});
