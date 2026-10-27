// @vitest-environment node
import { randomUUID } from "node:crypto";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const faults = vi.hoisted(() => ({ audit: false }));
vi.mock("@/lib/observability/audit", async (original) => {
  const actual = await original<typeof import("@/lib/observability/audit")>();
  return {
    ...actual,
    writeAudit: (...args: Parameters<typeof actual.writeAudit>) => {
      if (faults.audit) throw new Error("Isolated injected audit failure");
      return actual.writeAudit(...args);
    },
  };
});
vi.mock("@/lib/db", async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== "1") return original();
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    db: new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      }),
    }),
  };
});
import { db } from "@/lib/db";
import {
  getA2AConsoleView,
  mutateA2AConsole,
  type ConsoleActor,
} from "@/lib/a2a/console-service";
import {
  createAgentApiKey,
  verifyAgentApiKey,
} from "@/lib/agents/public-api/auth";
import { requireAgentRevision } from "@/lib/agents/revisions";

let owner: string,
  member: string,
  other: string,
  workspaceId: string,
  endpointId: string,
  publicId: string;
let local: ConsoleActor, published: ConsoleActor;
beforeAll(async () => {
  process.env.AUTH_SECRET = "isolated-console-integration-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://toolplane.test";
  const stamp = randomUUID();
  const user = async (name: string) =>
    (
      await db.user.create({
        data: {
          email: `${name}-${stamp}@test.invalid`,
          passwordHash: "test-only",
        },
      })
    ).id;
  owner = await user("owner");
  member = await user("member");
  other = await user("other");
  const ws = await db.workspace.create({
    data: {
      slug: `console-${stamp}`,
      name: "Console fixture",
      ownerId: owner,
      members: { create: { userId: member, role: "member" } },
    },
  });
  workspaceId = ws.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Fixture",
      format: "openai",
      baseUrl: "https://never-called.test",
      apiKey: "do-not-expose-fixture-provider-key",
    },
  });
  const dep = await db.deployment.create({
    data: { workspaceId, name: "Fixture sandbox", source: "config" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: dep.id,
      name: "Fixture sandbox",
      slug: "fixture",
      kind: "docker",
      network: "isolated",
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: "Local agent",
      slug: "local",
      runtimeKind: "pi-sdk",
      providerId: provider.id,
      model: "fixture",
      systemPrompt: "PRIVATE PROMPT",
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  local = { workspaceId, actorId: owner, agentId: agent.id, slug: ws.slug };
  const source = await db.agent.create({
    data: {
      workspaceId,
      name: "Retained Claude Code Agent",
      slug: "public",
      runtimeKind: "claude-code",
    },
  });
  published = { ...local, agentId: source.id };
  const endpoint = await db.agentEndpoint.create({
    data: {
      workspaceId,
      sourceAgentId: source.id,
      publicId: `agep_${stamp.replaceAll("-", "")}`,
      name: "Service",
      status: "active",
    },
  });
  endpointId = endpoint.id;
  publicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId,
      version: 1,
      systemPrompt: "PRIVATE PUBLIC CONFIG",
      runtimeImage: "fixture-not-executed",
      toolPolicy: {},
    },
  });
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { currentRevisionId: revision.id },
  });
});
beforeEach(async () => {
  faults.audit = false;
  await db.user.update({ where: { id: owner }, data: { status: "active" } });
  await db.workspace.update({
    where: { id: workspaceId },
    data: { status: "active" },
  });
  await db.agent.update({
    where: { id: local.agentId },
    data: {
      a2aInternalEnabled: false,
      a2aInboundEnabled: false,
      a2aOutboundEnabled: false,
    },
  });
  await publishFixtureAgentRevision(workspaceId, local.agentId);
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { status: "active", a2aEnabled: true },
  });
  await db.agentApiClient.deleteMany({ where: { endpointId } });
});
afterAll(async () => {
  faults.audit = false;
  if (workspaceId) {
    await db.auditEvent.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({
    where: { id: { in: [owner, member, other].filter(Boolean) } },
  });
  await db.$disconnect();
});

/** Recorded credentials are fixture imports, never issued by the retired console contract. */
async function retainedCredential(scopes = ["a2a:read", "a2a:cancel"]) {
  const client = await db.agentApiClient.create({
    data: { endpointId, name: "Retained integration", scopes },
  });
  const issued = await createAgentApiKey({
    clientId: client.id,
    endpointPublicId: publicId,
    workspaceId,
    sourceAgentId: published.agentId,
    name: "Retained credential",
  });
  const key = await db.agentApiKey.findFirstOrThrow({
    where: { clientId: client.id },
  });
  return { client, key, token: issued.token };
}

describe("A2A console directional policy and retained credentials", () => {
  it("publishes independent inbound and outbound flags without mutating prior pins or retained endpoint state", async () => {
    const before = await db.$transaction((tx) =>
      requireAgentRevision(tx, local.agentId),
    );
    await mutateA2AConsole(local, { action: "set-inbound", enabled: true });
    expect((await getA2AConsoleView(local)).collaboration).toEqual({
      inboundEnabled: true,
      outboundEnabled: false,
    });
    expect((await getA2AConsoleView(local)).local).toEqual({
      supported: true,
      ready: true,
    });
    await mutateA2AConsole(local, { action: "set-outbound", enabled: true });
    await mutateA2AConsole(local, { action: "set-inbound", enabled: false });
    expect((await getA2AConsoleView(local)).collaboration).toEqual({
      inboundEnabled: false,
      outboundEnabled: true,
    });
    expect((await getA2AConsoleView(published)).endpoint?.enabled).toBe(true);
    expect((await getA2AConsoleView(published)).endpoint?.ready).toBe(false);
    expect(
      (
        await db.$transaction((tx) =>
          requireAgentRevision(tx, local.agentId, before.id),
        )
      ).config,
    ).toEqual(before.config);
    const current = await db.$transaction((tx) =>
      requireAgentRevision(tx, local.agentId),
    );
    expect(current.id).not.toBe(before.id);
    expect(current.config.a2a).toMatchObject({
      inboundEnabled: false,
      outboundEnabled: true,
    });
  });

  it.each(["set-inbound", "set-outbound"] as const)(
    "never enables retired runtime execution through %s",
    async (action) => {
      await expect(
        mutateA2AConsole(published, { action, enabled: true }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.agent.findUniqueOrThrow({ where: { id: published.agentId } }),
      ).toMatchObject({ a2aInboundEnabled: false, a2aOutboundEnabled: false });
    },
  );

  it.each(["set-inbound", "set-outbound"] as const)(
    "rejects member and outsider %s mutations",
    async (action) => {
      for (const actorId of [member, other])
        await expect(
          mutateA2AConsole({ ...local, actorId }, { action, enabled: true }),
        ).rejects.toMatchObject({ status: 403 });
    },
  );

  it("rejects disabled users, closing workspaces and foreign targets", async () => {
    await db.user.update({
      where: { id: owner },
      data: { status: "suspended" },
    });
    await expect(
      mutateA2AConsole(local, { action: "set-inbound", enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: owner }, data: { status: "active" } });
    await expect(
      mutateA2AConsole(
        { ...local, agentId: "foreign-target" },
        { action: "set-inbound", enabled: true },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await db.workspace.update({
      where: { id: workspaceId },
      data: { status: "deleting" },
    });
    await expect(
      mutateA2AConsole(local, { action: "set-outbound", enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back directional flags and revision publication when auditing fails", async () => {
    const before = await db.$transaction((tx) =>
      requireAgentRevision(tx, local.agentId),
    );
    faults.audit = true;
    await expect(
      mutateA2AConsole(local, { action: "set-outbound", enabled: true }),
    ).rejects.toThrow();
    expect((await getA2AConsoleView(local)).collaboration).toEqual({
      inboundEnabled: false,
      outboundEnabled: false,
    });
    expect(
      (await db.$transaction((tx) => requireAgentRevision(tx, local.agentId)))
        .id,
    ).toBe(before.id);
  });

  it("exposes retained credential metadata without secrets", async () => {
    const retained = await retainedCredential();
    const view = await getA2AConsoleView(published);
    const serialized = JSON.stringify(view);
    for (const secret of [
      retained.token,
      retained.key.tokenHash,
      "PRIVATE PUBLIC CONFIG",
      "do-not-expose-fixture-provider-key",
    ])
      expect(serialized).not.toContain(secret);
    expect(view.endpoint?.clients).toHaveLength(1);
    expect(view.endpoint?.clients[0].keys[0].prefix).toBe(retained.key.prefix);
    expect(
      JSON.stringify(await db.auditEvent.findMany({ where: { workspaceId } })),
    ).not.toContain(retained.token);
  });

  it("revokes retained keys idempotently without affecting a different retained client", async () => {
    const first = await retainedCredential(),
      second = await retainedCredential();
    await mutateA2AConsole(published, {
      action: "revoke-key",
      keyId: first.key.id,
    });
    await mutateA2AConsole(published, {
      action: "revoke-key",
      keyId: first.key.id,
    });
    expect(
      await verifyAgentApiKey(`Bearer ${first.token}`, publicId, "a2a:read"),
    ).toBeNull();
    expect(
      await verifyAgentApiKey(`Bearer ${second.token}`, publicId, "a2a:read"),
    ).not.toBeNull();
  });

  it("rolls back retained credential revocation when auditing fails", async () => {
    const retained = await retainedCredential();
    faults.audit = true;
    await expect(
      mutateA2AConsole(published, {
        action: "revoke-key",
        keyId: retained.key.id,
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.agentApiKey.findUniqueOrThrow({
          where: { id: retained.key.id },
        })
      ).revokedAt,
    ).toBeNull();
  });

  it("never manages legacy Responses credentials", async () => {
    const retained = await retainedCredential([
      "responses:create",
      "responses:read",
    ]);
    await expect(
      mutateA2AConsole(published, {
        action: "revoke-key",
        keyId: retained.key.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await getA2AConsoleView(published)).endpoint?.clients).toEqual([]);
  });

  it("does not expose credential metadata to members or accept foreign key IDs", async () => {
    const retained = await retainedCredential();
    const memberView = await getA2AConsoleView({
      ...published,
      actorId: member,
    });
    expect(memberView.canManage).toBe(false);
    expect(memberView.endpoint?.clients).toEqual([]);
    await expect(
      mutateA2AConsole(
        { ...published, actorId: member },
        { action: "revoke-key", keyId: retained.key.id },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      mutateA2AConsole(published, {
        action: "revoke-key",
        keyId: "foreign-key",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("allows retained key revocation when the historical endpoint is disabled", async () => {
    const retained = await retainedCredential();
    await db.agentEndpoint.update({
      where: { id: endpointId },
      data: { status: "disabled", a2aEnabled: false },
    });
    await mutateA2AConsole(published, {
      action: "revoke-key",
      keyId: retained.key.id,
    });
    expect(
      (
        await db.agentApiKey.findUniqueOrThrow({
          where: { id: retained.key.id },
        })
      ).revokedAt,
    ).not.toBeNull();
  });
});

it("requires an administrator to bind the current human as channel operator, never an arbitrary actor", async () => {
  await mutateA2AConsole(local, { action: "set-inbound", enabled: true });
  const channel = await db.agentChannelConnection.create({
    data: {
      workspaceId,
      agentId: local.agentId,
      platform: "telegram",
      name: "Operator fixture",
      status: "running",
      inboundTokenHash: randomUUID(),
      inboundTokenSecret: {},
      inboundTokenPrefix: "fixture",
    },
  });
  await expect(
    mutateA2AConsole(
      { ...local, actorId: member },
      {
        action: "set-channel-operator",
        connectionId: channel.id,
        enabled: true,
      },
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await db.agentChannelConnection.findUniqueOrThrow({
        where: { id: channel.id },
      })
    ).a2aActorId,
  ).toBeNull();
  await mutateA2AConsole(local, {
    action: "set-channel-operator",
    connectionId: channel.id,
    enabled: true,
  });
  expect(
    (
      await db.agentChannelConnection.findUniqueOrThrow({
        where: { id: channel.id },
      })
    ).a2aActorId,
  ).toBe(owner);
  expect(
    (await getA2AConsoleView({ ...local, actorId: member })).channels,
  ).toEqual([]);
  await mutateA2AConsole(local, {
    action: "set-channel-operator",
    connectionId: channel.id,
    enabled: false,
  });
  expect(
    (
      await db.agentChannelConnection.findUniqueOrThrow({
        where: { id: channel.id },
      })
    ).a2aActorId,
  ).toBeNull();
});
