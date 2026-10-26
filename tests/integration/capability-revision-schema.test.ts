// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentA2APolicySchema,
  AgentEnvironmentSnapshotSchema,
  AgentRevisionConfigSchema,
} from "@/lib/agents/revision-types";
import { ChatAssistantRevisionConfigSchema } from "@/lib/chat/revision-types";
import { db } from "@/lib/db";

const stamp = `${process.pid}-${Date.now()}`;
const assistantConfig = ChatAssistantRevisionConfigSchema.parse({
  schemaVersion: 1,
  systemPrompt: null,
  modelProviderId: null,
  model: null,
  modelParameters: null,
  maxSteps: 100,
  mcpGrants: [],
});
let userId = "";
let workspaceId = "";
let assistantId = "";
let otherAssistantId = "";
let revisionId = "";
let threadId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: `capability-revisions-${stamp}@test.dev`,
      passwordHash: "x",
    },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `capability-revisions-${stamp}`,
      name: "Revisions",
      ownerId: userId,
    },
  });
  workspaceId = workspace.id;
  const assistant = await db.chatAssistant.create({
    data: { workspaceId, name: "Owner" },
  });
  assistantId = assistant.id;
  const other = await db.chatAssistant.create({
    data: { workspaceId, name: "Other owner" },
  });
  otherAssistantId = other.id;
  const revision = await db.chatAssistantRevision.create({
    data: { assistantId, version: 1, config: assistantConfig },
  });
  revisionId = revision.id;
  const thread = await db.chatThread.create({
    data: {
      workspaceId,
      assistantId,
      assistantRevisionId: revisionId,
      legacyRevisionUnresolved: false,
    },
  });
  threadId = thread.id;
});

afterAll(async () => {
  if (workspaceId) {
    await db.chatThread.deleteMany({ where: { workspaceId } });
    await db.chatAssistant.deleteMany({ where: { workspaceId } });
    await db.conversation.deleteMany({ where: { agent: { workspaceId } } });
    await db.agent.deleteMany({ where: { workspaceId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
  }
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

describe("capability revision persistence", () => {
  it("rejects cross-owner pins and contradictory legacy markers", async () => {
    await expect(
      db.chatThread.create({
        data: {
          workspaceId,
          assistantId: otherAssistantId,
          assistantRevisionId: revisionId,
          legacyRevisionUnresolved: false,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatThread.create({
        data: { workspaceId, assistantId, assistantRevisionId: revisionId },
      }),
    ).rejects.toThrow();
  });

  it("retains unresolved history without retroactively rebinding it", async () => {
    const legacy = await db.chatThread.create({
      data: { workspaceId, assistantId },
    });
    expect(legacy.assistantRevisionId).toBeNull();
    expect(legacy.legacyRevisionUnresolved).toBe(true);
    await expect(
      db.chatThread.update({
        where: { id: legacy.id },
        data: {
          assistantRevisionId: revisionId,
          legacyRevisionUnresolved: false,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatThread.update({
        where: { id: threadId },
        data: { assistantId: otherAssistantId },
      }),
    ).rejects.toThrow();
  });

  it("enforces immutable consecutive versions and valid current pointers", async () => {
    await expect(
      db.chatAssistantRevision.create({
        data: { assistantId, version: 1, config: assistantConfig },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatAssistantRevision.create({
        data: { assistantId, version: 3, config: assistantConfig },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatAssistantRevision.update({
        where: { id: revisionId },
        data: { config: assistantConfig },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatAssistant.update({
        where: { id: assistantId },
        data: { currentRevisionVersion: 99 },
      }),
    ).rejects.toThrow();
    await db.chatAssistant.update({
      where: { id: assistantId },
      data: { currentRevisionVersion: 1 },
    });
    await expect(
      db.chatAssistant.update({
        where: { id: assistantId },
        data: { currentRevisionVersion: 0 },
      }),
    ).rejects.toThrow();
  });

  it("scopes Agent revision pins to their owner", async () => {
    const config = AgentRevisionConfigSchema.parse({
      schemaVersion: 1,
      runtimeKind: "pi-sdk",
      systemPrompt: null,
      providerId: null,
      model: null,
      modelProviderIds: [],
      maxSteps: 100,
      disabledBuiltinTools: [],
      sandboxTemplateId: null,
      skills: [],
      environment: {
        kind: "docker",
        image: `example.invalid/test@sha256:${"a".repeat(64)}`,
        network: "none",
        piVersion: "0.87.1",
        initialSnapshot: null,
        resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
        credentialReferences: [],
      },
      knowledgeBaseIds: [],
      packages: [],
      mcpGrants: [],
      a2a: {
        inboundEnabled: false,
        outboundEnabled: false,
        policy: { schemaVersion: 1, targets: [] },
      },
    });
    const first = await db.agent.create({
      data: {
        workspaceId,
        name: "First",
        slug: `first-${stamp}`,
        runtimeKind: "pi-sdk",
      },
    });
    const second = await db.agent.create({
      data: {
        workspaceId,
        name: "Second",
        slug: `second-${stamp}`,
        runtimeKind: "pi-sdk",
      },
    });
    const revision = await db.agentRevision.create({
      data: { agentId: first.id, version: 1, config },
    });
    await expect(
      db.conversation.create({
        data: {
          agentId: second.id,
          agentRevisionId: revision.id,
          legacyRevisionUnresolved: false,
        },
      }),
    ).rejects.toThrow();
    const conversation = await db.conversation.create({
      data: {
        agentId: first.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    expect(conversation.agentRevisionId).toBe(revision.id);
    await expect(
      db.workSession.create({
        data: {
          workspaceId,
          agentId: second.id,
          conversationId: conversation.id,
          runtimeKind: "pi-sdk",
          agentRevisionId: revision.id,
          legacyRevisionUnresolved: false,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.a2AContext.create({
        data: {
          workspaceId,
          agentId: second.id,
          targetKind: "local",
          ownerKey: `owner-${stamp}`,
          agentRevisionId: revision.id,
          legacyRevisionUnresolved: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    expect(first.a2aInboundEnabled).toBe(false);
    expect(first.a2aOutboundEnabled).toBe(false);
  });

  it("enforces per-thread idempotency and contiguous fenced event sequences", async () => {
    const turn = await db.chatTurn.create({
      data: {
        threadId,
        idempotencyKey: "request-1",
        requestHash: "hash-1",
        actorUserId: userId,
        generation: 1,
      },
    });
    await expect(
      db.chatTurn.create({
        data: {
          threadId,
          idempotencyKey: "request-1",
          requestHash: "hash-2",
          status: "completed",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatRunEvent.create({
        data: {
          turnId: turn.id,
          sequence: 2,
          generation: 1,
          payload: { type: "start" },
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.chatRunEvent.create({
        data: { turnId: turn.id, sequence: 1, generation: 0, payload: {} },
      }),
    ).rejects.toThrow();
    await db.chatRunEvent.create({
      data: {
        turnId: turn.id,
        sequence: 1,
        generation: 1,
        payload: { type: "start" },
      },
    });
    await expect(
      db.chatRunEvent.create({
        data: { turnId: turn.id, sequence: 1, generation: 1, payload: {} },
      }),
    ).rejects.toThrow();
    expect(
      (await db.chatTurn.findUniqueOrThrow({ where: { id: turn.id } }))
        .lastEventSequence,
    ).toBe(1);
  });

  it("retains approval identity and forbids replay of unknown effects", async () => {
    const approvalThread = await db.chatThread.create({
      data: {
        workspaceId,
        assistantId,
        assistantRevisionId: revisionId,
        legacyRevisionUnresolved: false,
      },
    });
    const turn = await db.chatTurn.create({
      data: { threadId: approvalThread.id },
    });
    const confirmation = await db.chatToolConfirmation.create({
      data: {
        turnId: turn.id,
        toolCallId: "write-1",
        toolName: "write",
        input: {},
      },
    });
    expect(confirmation.status).toBe("awaiting_user");
    await expect(
      db.chatToolConfirmation.update({
        where: { id: confirmation.id },
        data: { status: "approved" },
      }),
    ).rejects.toThrow();
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: {
        status: "approved",
        approverUserId: userId,
        resolvedAt: new Date(),
      },
    });
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: { status: "executing", executionStartedAt: new Date() },
    });
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: { status: "execution_unknown" },
    });
    await expect(
      db.chatToolConfirmation.update({
        where: { id: confirmation.id },
        data: { status: "approved" },
      }),
    ).rejects.toThrow();
    await db.chatToolConfirmation.update({
      where: { id: confirmation.id },
      data: {
        status: "succeeded",
        result: { externallyReconciled: true },
        executionCompletedAt: new Date(),
      },
    });
  });

  it("rejects credentials and unsupported policy fields in revision DTOs", () => {
    expect(
      ChatAssistantRevisionConfigSchema.safeParse({
        ...assistantConfig,
        apiKey: "secret",
      }).success,
    ).toBe(false);
    expect(
      ChatAssistantRevisionConfigSchema.safeParse({
        ...assistantConfig,
        skillIds: ["skill"],
      }).success,
    ).toBe(false);
    const environment = {
      kind: "docker",
      image: `example.invalid/test@sha256:${"a".repeat(64)}`,
      network: "none",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    };
    expect(AgentEnvironmentSnapshotSchema.safeParse(environment).success).toBe(
      true,
    );
    expect(
      AgentEnvironmentSnapshotSchema.safeParse({
        ...environment,
        image: "example.invalid/test:latest",
      }).success,
    ).toBe(false);
    expect(
      AgentEnvironmentSnapshotSchema.safeParse({
        ...environment,
        env: { API_KEY: "secret" },
      }).success,
    ).toBe(false);
    expect(
      AgentA2APolicySchema.safeParse({
        schemaVersion: 1,
        targets: [],
        measuredBillingCap: 1,
      }).success,
    ).toBe(false);
  });
});
