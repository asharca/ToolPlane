// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { AgentChannelConnection, Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import {
  decryptSecretRecord,
  encryptSecretRecord,
  encryptSecretText,
} from "@/lib/security/secrets";
import {
  admitChannelSender,
  backfillChannelSenderPolicies,
  listChannelSenderAccess,
} from "@/lib/agents/channel-sender-access";
import { updateAgentChannelConnectionCredentials } from "@/lib/agents/channel-connections";
import { GET, POST } from "@/app/api/v1/workspaces/[slug]/agent-channels/route";
import { sendChannelNotice } from "@/lib/agents/channel-runtime";

import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
vi.mock("@/lib/agents/pi-runtime", () => ({
  preparePiRuntime: vi.fn(async () => ({
    path: "/fixture/pi-sdk.archive",
    sha256: "a".repeat(64),
  })),
}));
vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));
const identity = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: async () => identity.user,
}));
// Transport, identity and native preparation are substituted; admission, routes, audits and persistence use Postgres.
vi.mock("@/lib/agents/channel-runtime", () => ({
  liveAgentChannelStatus: vi.fn(() => "stopped"),
  startAgentChannelRunner: vi.fn(async () => ({
    error: "Runner is not configured",
  })),
  stopAgentChannelRunner: vi.fn(async () => {}),
  sendChannelNotice: vi.fn(async () => false),
}));

let ownerId: string;
let memberId: string;
let workspace: { id: string; slug: string };
let foreign: { id: string; slug: string };
beforeAll(async () => {
  const suffix = randomUUID();
  const owner = await db.user.create({
    data: {
      email: `channel-access-owner-${suffix}@test.dev`,
      passwordHash: "unused",
    },
  });
  const member = await db.user.create({
    data: {
      email: `channel-access-member-${suffix}@test.dev`,
      passwordHash: "unused",
    },
  });
  ownerId = owner.id;
  memberId = member.id;
  identity.user = owner;
  workspace = await db.workspace.create({
    data: { name: "Channel access", slug: `access-${suffix}`, ownerId },
  });
  foreign = await db.workspace.create({
    data: { name: "Foreign channels", slug: `access-other-${suffix}`, ownerId },
  });
  await db.membership.create({
    data: { workspaceId: workspace.id, userId: memberId, role: "member" },
  });
});
afterEach(() => {
  identity.user = { id: ownerId };
  vi.clearAllMocks();
});
afterAll(async () => {
  await db.logEvent.deleteMany({
    where: { workspaceId: { in: [workspace.id, foreign.id] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [workspace.id, foreign.id] } },
  });
  await db.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
  await db.$disconnect();
});

async function connection(
  overrides: Partial<Prisma.AgentChannelConnectionUncheckedCreateInput> = {},
) {
  return db.agentChannelConnection.create({
    data: {
      workspaceId: workspace.id,
      name: `Access ${randomUUID()}`,
      platform: "telegram",
      credentials: encryptSecretRecord({}),
      inboundTokenHash: randomUUID(),
      inboundTokenSecret: encryptSecretText("access-fixture-token"),
      inboundTokenPrefix: "access-fixture",
      ...overrides,
    },
  });
}
function admit(
  row: AgentChannelConnection,
  userId = "sender",
  credentials: Record<string, string> = {},
  chatType: "dm" | "group" | "channel" | "thread" = "dm",
  roleIds?: unknown,
) {
  return admitChannelSender({
    connection: row,
    credentials,
    source: { userId, userName: `Name ${userId}`, chatId: "chat", chatType },
    roleIds,
  });
}
function post(body: Record<string, unknown>, slug = workspace.slug) {
  return POST(
    new Request(
      `http://localhost:3000/api/v1/workspaces/${slug}/agent-channels`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ slug }) },
  );
}
function getAccess(id: string) {
  return GET(
    new Request(
      `http://localhost:3000/api/v1/workspaces/${workspace.slug}/agent-channels?access=${id}`,
    ),
    {
      params: Promise.resolve({ slug: workspace.slug }),
    },
  );
}

describe("channel sender access with durable Postgres policies", () => {
  it("denies v2 empty allowlists and logs a safe, throttled rejection", async () => {
    // Agent-bound like real channels: agent-scoped events must still keep sender IDs.
    const agentSuffix = randomUUID();
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `Access agent ${agentSuffix}`,
        slug: `access-agent-${agentSuffix}`,
        runtimeKind: "pi-sdk",
      },
    });
    const row = await connection({
      unauthorizedDm: "ignore",
      agentId: agent.id,
    });
    expect(await admit(row)).toEqual({
      allowed: false,
      rule: "user_not_allowed",
    });
    expect(await admit(row)).toEqual({
      allowed: false,
      rule: "user_not_allowed",
    });
    const logs = await db.logEvent.findMany({
      where: {
        workspaceId: workspace.id,
        channelId: row.id,
        eventName: "channel.sender_rejected",
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].domain).toBe("channel");
    expect(logs[0].attributes).toMatchObject({
      data: {
        platform: "telegram",
        userId: "sender",
        chatId: "chat",
        chatType: "dm",
        rule: "user_not_allowed",
      },
    });
    expect(JSON.stringify(logs)).not.toContain("Pairing code");
    expect(
      (await listChannelSenderAccess(workspace.id, row.id))?.rejected,
    ).toMatchObject([{ platformUserId: "sender", count: 1 }]);
  });

  it("admits open, allowlisted and approved senders and identifies admins without bypassing chat policy", async () => {
    const row = await connection({
      platform: "discord",
      adminUserIds: ["admin"],
    });
    expect(await admit({ ...row, openToAll: true })).toEqual({
      allowed: true,
      role: "user",
    });
    expect(
      await admit(row, "sender", { DISCORD_ALLOWED_USERS: "sender" }),
    ).toEqual({ allowed: true, role: "user" });
    expect(
      await admit(row, "admin", { DISCORD_ALLOWED_ROLES: "required" }),
    ).toEqual({ allowed: true, role: "admin" });
    expect(
      await admit(row, "admin", { DISCORD_ALLOWED_CHANNELS: "elsewhere" }),
    ).toEqual({ allowed: false, rule: "chat_not_allowed" });
    expect(
      await admit(row, "admin", { DISCORD_DM_POLICY: "disabled" }),
    ).toEqual({ allowed: false, rule: "disabled" });
    expect(
      await admit(
        row,
        "sender",
        { DISCORD_ALLOWED_ROLES: "required" },
        "dm",
        [],
      ),
    ).toEqual({ allowed: false, rule: "role_not_allowed" });
    expect(
      await admit(
        { ...row, openToAll: true },
        "sender",
        { DISCORD_ALLOWED_CHANNELS: "chat", DISCORD_ALLOWED_ROLES: "required" },
        "dm",
        ["required"],
      ),
    ).toEqual({ allowed: true, role: "user" });
    expect(
      (
        await post({
          action: "allowSender",
          connectionId: row.id,
          platformUserId: "approved",
          userName: "Approved",
        })
      ).status,
    ).toBe(200);
    expect(await admit(row, "approved")).toEqual({
      allowed: true,
      role: "user",
    });
    expect(
      (
        await post({
          action: "revokeSender",
          connectionId: row.id,
          platformUserId: "approved",
        })
      ).status,
    ).toBe(200);
    expect(
      await admit({ ...row, unauthorizedDm: "ignore" }, "approved"),
    ).toEqual({ allowed: false, rule: "user_not_allowed" });
  });

  it("backfills legacy openness, strips encrypted legacy keys, preserves routing and is idempotent", async () => {
    const row = await connection({
      senderPolicyVersion: 1,
      credentials: encryptSecretRecord({
        TELEGRAM_ALLOW_ALL_USERS: "true",
        TELEGRAM_BOT_TOKEN: "preserved-token",
      }),
    });
    const callback = await connection({
      platform: "google_chat",
      senderPolicyVersion: 1,
    });
    const closed = await connection({
      senderPolicyVersion: 1,
      credentials: encryptSecretRecord({ TELEGRAM_ALLOW_ALL_USERS: "false" }),
    });
    expect(
      await admit(row, "legacy", { TELEGRAM_ALLOW_ALL_USERS: "true" }),
    ).toEqual({ allowed: true, role: "user" });
    await backfillChannelSenderPolicies();
    const migrated = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(migrated).toMatchObject({
      senderPolicyVersion: 2,
      openToAll: true,
      groupSessionsPerUser: false,
    });
    expect(decryptSecretRecord(migrated.credentials)).toEqual({
      TELEGRAM_BOT_TOKEN: "preserved-token",
    });
    expect(await admit(migrated)).toEqual({ allowed: true, role: "user" });
    expect(
      await db.agentChannelConnection.findUniqueOrThrow({
        where: { id: callback.id },
      }),
    ).toMatchObject({ openToAll: true, groupSessionsPerUser: true });
    expect(
      await db.agentChannelConnection.findUniqueOrThrow({
        where: { id: closed.id },
      }),
    ).toMatchObject({ openToAll: false });
    await backfillChannelSenderPolicies();
    const again = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(again.updatedAt).toEqual(migrated.updatedAt);
    expect(again.credentials).toEqual(migrated.credentials);
  });

  it("creates one pairing code, stays silent on reuse, approves durably and notifies best effort", async () => {
    const row = await connection();
    const first = await admit(row);
    expect(first).toMatchObject({
      allowed: false,
      rule: "user_not_allowed",
      reply: expect.stringMatching(
        /Pairing code: [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\./,
      ),
    });
    expect(await admit(row)).toEqual({
      allowed: false,
      rule: "user_not_allowed",
    });
    const listed = await getAccess(row.id);
    expect(listed.status).toBe(200);
    const access = await listed.json();
    expect(access.pending).toHaveLength(1);
    const pending = access.pending[0];
    expect(
      new Date(pending.expiresAt).getTime() -
        new Date(pending.createdAt).getTime(),
    ).toBeGreaterThan(3_590_000);
    expect(
      (
        await post({
          action: "approvePairing",
          connectionId: row.id,
          requestId: pending.id,
        })
      ).status,
    ).toBe(200);
    expect(await admit(row)).toEqual({ allowed: true, role: "user" });
    expect(sendChannelNotice).toHaveBeenCalledWith(
      row.id,
      "chat",
      "Access approved. You can message this bot now.",
    );
    const approved = await listChannelSenderAccess(workspace.id, row.id);
    expect(approved?.pending).toEqual([]);
    expect(approved?.rejected).toEqual([]);
    expect(approved?.approved[0]).toMatchObject({
      platformUserId: "sender",
      approvedBy: { email: expect.any(String) },
    });
    const logs = await db.logEvent.findMany({ where: { channelId: row.id } });
    expect(JSON.stringify(logs)).not.toContain(pending.code);
  });

  it("enforces max three live pending pairings under concurrent inbound delivery", async () => {
    const row = await connection();
    const decisions = await Promise.all(
      Array.from({ length: 5 }, (_, n) => admit(row, `sender-${n}`)),
    );
    expect(
      decisions.filter((decision) => !decision.allowed && decision.reply),
    ).toHaveLength(3);
    expect(
      await db.agentChannelPairingRequest.count({
        where: {
          connectionId: row.id,
          status: "pending",
          expiresAt: { gt: new Date() },
        },
      }),
    ).toBe(3);
  });

  it("declines only once per 24 hours and stays silent in groups, channels and threads", async () => {
    const row = await connection({ unauthorizedDm: "decline" });
    expect(await admit(row)).toMatchObject({
      reply: "I can only reply to approved users.",
    });
    expect(await admit(row)).toEqual({
      allowed: false,
      rule: "user_not_allowed",
    });
    expect(
      await db.agentChannelPairingRequest.count({
        where: { connectionId: row.id, status: "declined" },
      }),
    ).toBe(1);
    for (const chatType of ["group", "channel", "thread"] as const) {
      expect(await admit(row, `in-${chatType}`, {}, chatType)).toEqual({
        allowed: false,
        rule: "user_not_allowed",
      });
    }
    expect(
      await db.agentChannelPairingRequest.count({
        where: { connectionId: row.id },
      }),
    ).toBe(1);
  });

  it("honors explicit ignore/pairing policy and expired requests", async () => {
    const row = await connection({ unauthorizedDm: "ignore" });
    expect(await admit(row, "ignored")).toEqual({
      allowed: false,
      rule: "user_not_allowed",
    });
    expect(
      await admit(row, "allowlist", { TELEGRAM_DM_POLICY: "allowlist" }),
    ).toEqual({ allowed: false, rule: "user_not_allowed" });
    expect(
      await admit(row, "paired", { TELEGRAM_DM_POLICY: "pairing" }),
    ).toMatchObject({ reply: expect.stringContaining("Pairing code:") });
    await db.agentChannelPairingRequest.updateMany({
      where: { connectionId: row.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      await admit(row, "paired", { TELEGRAM_DM_POLICY: "pairing" }),
    ).toMatchObject({ reply: expect.stringContaining("Pairing code:") });
  });

  it("dismisses pairing, updates policy/session fields and rejects removed credential flags", async () => {
    const row = await connection();
    await admit(row);
    const pending = await db.agentChannelPairingRequest.findFirstOrThrow({
      where: { connectionId: row.id },
    });
    expect(
      (
        await post({
          action: "dismissPairing",
          connectionId: row.id,
          requestId: pending.id,
        })
      ).status,
    ).toBe(200);
    expect(
      await db.agentChannelPairingRequest.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    ).toMatchObject({ status: "dismissed", decidedById: ownerId });
    const updated = await post({
      action: "update",
      connectionId: row.id,
      access: {
        openToAll: true,
        unauthorizedDm: "decline",
        adminUserIds: ["admin"],
      },
      sessions: { groupSessionsPerUser: false, threadSessionsPerUser: true },
    });
    expect(updated.status).toBe(200);
    const view = (await updated.json()).connections.find(
      (item: { id: string }) => item.id === row.id,
    );
    expect(view.access).toMatchObject({
      openToAll: true,
      unauthorizedDm: "decline",
      adminUserIds: ["admin"],
      pendingCount: 0,
    });
    expect(view.sessions).toEqual({
      groupSessionsPerUser: false,
      threadSessionsPerUser: true,
    });
    expect(view.revisions).toEqual({
      currentVersion: null,
      outdatedConversations: 0,
    });
    expect(
      (
        await post({
          action: "update",
          connectionId: row.id,
          credentials: { TELEGRAM_ALLOW_ALL_USERS: "false" },
        })
      ).status,
    ).toBe(400);
    const legacy = await connection({
      credentials: encryptSecretRecord({ TELEGRAM_ALLOW_ALL_USERS: "true" }),
    });
    await updateAgentChannelConnectionCredentials({
      workspaceId: workspace.id,
      connectionId: legacy.id,
      credentials: {},
    });
    const saved = await db.agentChannelConnection.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(saved.openToAll).toBe(true);
    expect(decryptSecretRecord(saved.credentials)).not.toHaveProperty(
      "TELEGRAM_ALLOW_ALL_USERS",
    );
  });

  it("counts only lower-pinned conversations within the exact connection prefix", async () => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: workspace.id,
        name: "Access revision fixture",
        format: "openai",
        baseUrl: "https://example.invalid",
        apiKey: "unused",
        models: ["test"],
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: "Revision access fixture",
        slug: `access-revision-${randomUUID()}`,
        runtimeKind: "pi-sdk",
        providerId: provider.id,
        model: "test",
      },
    });
    const first = await publishFixtureAgentRevision(workspace.id, agent.id);
    const row = await connection({ agentId: agent.id });
    await db.agent.update({
      where: { id: agent.id },
      data: { systemPrompt: "Updated channel instructions" },
    });
    const current = await publishFixtureAgentRevision(workspace.id, agent.id);
    await db.conversation.createMany({
      data: [
        {
          agentId: agent.id,
          title: "Outdated",
          agentRevisionId: first.id,
          legacyRevisionUnresolved: false,
          runtimeSessionKey: `channel:${row.id}:old`,
        },
        {
          agentId: agent.id,
          title: "Current",
          agentRevisionId: current.id,
          legacyRevisionUnresolved: false,
          runtimeSessionKey: `channel:${row.id}:current`,
        },
        {
          agentId: agent.id,
          title: "Prefix collision",
          agentRevisionId: first.id,
          legacyRevisionUnresolved: false,
          runtimeSessionKey: `channel:${row.id}-other:old`,
        },
        {
          agentId: agent.id,
          title: "Unresolved",
          runtimeSessionKey: `channel:${row.id}:unresolved`,
        },
      ],
    });
    const response = await GET(
      new Request(
        `http://localhost:3000/api/v1/workspaces/${workspace.slug}/agent-channels`,
      ),
      {
        params: Promise.resolve({ slug: workspace.slug }),
      },
    );
    expect(response.status).toBe(200);
    const view = (await response.json()).connections.find(
      (item: { id: string }) => item.id === row.id,
    );
    expect(view.revisions).toEqual({
      currentVersion: current.version,
      outdatedConversations: 1,
    });
  });

  it("blocks non-admin approvals and access lists, and rejects cross-workspace connections and requests", async () => {
    const row = await connection();
    const other = await connection({ workspaceId: foreign.id });
    await admit(row);
    await admit(other);
    const request = await db.agentChannelPairingRequest.findFirstOrThrow({
      where: { connectionId: row.id },
    });
    const otherRequest = await db.agentChannelPairingRequest.findFirstOrThrow({
      where: { connectionId: other.id },
    });
    identity.user = { id: memberId };
    expect(
      (
        await post({
          action: "approvePairing",
          connectionId: row.id,
          requestId: request.id,
        })
      ).status,
    ).toBe(403);
    expect((await getAccess(row.id)).status).toBe(403);
    identity.user = { id: ownerId };
    expect(
      (
        await post({
          action: "approvePairing",
          connectionId: other.id,
          requestId: otherRequest.id,
        })
      ).status,
    ).toBe(404);
    expect((await getAccess(other.id)).status).toBe(404);
    expect(
      (
        await post({
          action: "approvePairing",
          connectionId: row.id,
          requestId: otherRequest.id,
        })
      ).status,
    ).toBe(400);
    expect(
      await db.agentChannelSenderApproval.count({
        where: { connectionId: { in: [row.id, other.id] } },
      }),
    ).toBe(0);
    identity.user = null;
    expect((await getAccess(row.id)).status).toBe(401);
  });
});
