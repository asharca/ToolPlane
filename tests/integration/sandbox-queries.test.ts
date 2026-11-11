// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getSandbox, listSandboxes } from "@/lib/sandboxes/queries";

const stamp = randomUUID();
const userIds: string[] = [];
const workspaceIds: string[] = [];
let workspaceId: string, foreignWorkspaceId: string;
let owner: { id: string; name: string };
let foreignOwner: { id: string; name: string };
let runtimeId: string, templateId: string, archivedId: string;
let externalId: string, foreignSandboxId: string, forgedOwnerId: string;
let anomalousLinksId: string, sshSandboxId: string;
const roleCases: {
  id: string;
  role: "runtime" | "template" | "history" | "external";
  ownerAgent: { id: string; name: string } | null;
}[] = [];

async function createSandbox(
  name: string,
  config?: Prisma.InputJsonValue,
  ws = workspaceId,
  status = "stopped",
) {
  return db.sandbox.create({
    data: {
      workspace: { connect: { id: ws } },
      name,
      slug: `query-${randomUUID()}`,
      config,
      deployment: {
        create: {
          workspaceId: ws,
          name,
          source: "sandbox",
          sourceRef: "docker",
          status,
        },
      },
    },
  });
}

beforeAll(async () => {
  for (const suffix of ["own", "foreign"]) {
    const user = await db.user.create({
      data: {
        email: `sandbox-queries-${stamp}-${suffix}@example.invalid`,
        passwordHash: "fixture",
      },
    });
    userIds.push(user.id);
    const workspace = await db.workspace.create({
      data: {
        ownerId: user.id,
        name: `Sandbox queries ${suffix}`,
        slug: `sandbox-queries-${stamp}-${suffix}`,
      },
    });
    workspaceIds.push(workspace.id);
  }
  [workspaceId, foreignWorkspaceId] = workspaceIds;
  owner = await db.agent.create({
    data: {
      workspaceId,
      name: "Actual runtime owner",
      slug: "runtime-owner",
      runtimeKind: "pi-sdk",
    },
    select: { id: true, name: true },
  });
  foreignOwner = await db.agent.create({
    data: {
      workspaceId: foreignWorkspaceId,
      name: "Private foreign Agent",
      slug: "foreign-owner",
      runtimeKind: "pi-sdk",
    },
    select: { id: true, name: true },
  });
  const currentConfig = {
    managedBy: "agent-conversation",
    scope: "agent",
    agentId: owner.id,
    sourceSandboxId: "revision",
  };
  runtimeId = (
    await createSandbox(
      "Opaque runtime name",
      currentConfig,
      workspaceId,
      "running",
    )
  ).id;
  templateId = (await createSandbox("Stopped template")).id;
  await db.agentSandbox.create({
    data: { agentId: owner.id, sandboxId: templateId, isDefault: true },
  });
  archivedId = (
    await createSandbox("Migrated runtime", {
      ...currentConfig,
      scope: "conversation",
      readOnly: true,
      migrationArchive: true,
    })
  ).id;
  externalId = (await createSandbox("Attached external sandbox")).id;
  await db.agentExternalSandbox.create({
    data: { agentId: owner.id, sandboxId: externalId, access: "write" },
  });
  roleCases.push(
    { id: runtimeId, role: "runtime", ownerAgent: owner },
    { id: templateId, role: "template", ownerAgent: owner },
    { id: archivedId, role: "history", ownerAgent: owner },
    { id: externalId, role: "external", ownerAgent: null },
  );
  for (const config of [
    { ...currentConfig, scope: "conversation", readOnly: true },
    { ...currentConfig, scope: "conversation", migrationArchive: true },
    { managedBy: "agent-conversation", agentId: owner.id },
    { managedBy: "agent-endpoint", agentId: owner.id },
  ]) {
    const sandbox = await createSandbox("Retained history", config);
    roleCases.push({ id: sandbox.id, role: "history", ownerAgent: owner });
  }
  for (const config of [
    "legacy config",
    [],
    { scope: "agent", agentId: owner.id },
  ]) {
    const sandbox = await createSandbox("Unmanaged sandbox", config);
    roleCases.push({ id: sandbox.id, role: "external", ownerAgent: null });
  }
  const missingOwner = await createSandbox("Deleted owner", {
    ...currentConfig,
    agentId: randomUUID(),
  });
  const invalidOwner = await createSandbox("Invalid owner", {
    ...currentConfig,
    agentId: 42,
  });
  roleCases.push(
    { id: missingOwner.id, role: "runtime", ownerAgent: null },
    { id: invalidOwner.id, role: "runtime", ownerAgent: null },
  );
  forgedOwnerId = (
    await createSandbox("Forged foreign owner", {
      ...currentConfig,
      agentId: foreignOwner.id,
    })
  ).id;
  foreignSandboxId = (
    await createSandbox(
      "Foreign runtime",
      { ...currentConfig, agentId: foreignOwner.id },
      foreignWorkspaceId,
    )
  ).id;
  anomalousLinksId = (await createSandbox("Anomalous foreign links")).id;
  await db.agentSandbox.create({
    data: { agentId: foreignOwner.id, sandboxId: anomalousLinksId },
  });
  await db.agentExternalSandbox.create({
    data: { agentId: foreignOwner.id, sandboxId: anomalousLinksId },
  });
  // A stale template relation must not override a managed runtime's config owner.
  await db.agentSandbox.create({
    data: { agentId: owner.id, sandboxId: forgedOwnerId },
  });
  await db.conversation.createMany({
    data: [
      { agentId: owner.id, sandboxId: runtimeId },
      { agentId: owner.id, sandboxId: runtimeId },
      { agentId: owner.id, sandboxId: archivedId },
      { agentId: foreignOwner.id, sandboxId: runtimeId },
    ],
  });
  await db.a2AContext.createMany({
    data: [
      { workspaceId, agentId: owner.id, sandboxId: runtimeId },
      { workspaceId, agentId: owner.id, sandboxId: archivedId },
      {
        workspaceId: foreignWorkspaceId,
        agentId: foreignOwner.id,
        sandboxId: runtimeId,
      },
    ].map((identity) => ({
      ...identity,
      targetKind: "local",
      targetBinding: `agent:${identity.agentId}`,
      ownerKey: `sandbox-query:${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })),
  });
  await db.sandboxSnapshot.create({
    data: {
      sandboxId: templateId,
      name: "Retained snapshot",
      volumeName: `sandbox-query-${stamp}`,
      status: "ready",
    },
  });
  sshSandboxId = (await createSandbox("SSH sandbox")).id;
  await db.sandbox.update({
    where: { id: sshSandboxId },
    data: {
      kind: "ssh",
      sshServer: {
        create: {
          host: "sandbox.example.invalid",
          port: 2222,
          username: "sandbox-user",
          root: "/srv/sandbox",
          authType: "key",
          hostKeys: [{ type: "ssh-ed25519", key: "fixture-host-key" }],
          encryptedSecret: { ciphertext: "private-secret-envelope" },
          encryptedPassphrase: { ciphertext: "private-passphrase-envelope" },
        },
      },
    },
  });
});

afterAll(async () => {
  if (workspaceIds.length) {
    await db.conversation.deleteMany({
      where: { agent: { workspaceId: { in: workspaceIds } } },
    });
    await db.a2AContext.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  if (userIds.length)
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

it("distinguishes current runtimes, templates, retained history and external attachments with real Agent owners", async () => {
  const rows = await listSandboxes(workspaceId);
  for (const expected of roleCases) {
    expect(rows.find((row) => row.id === expected.id)).toMatchObject(expected);
    expect(await getSandbox(workspaceId, expected.id)).toMatchObject(expected);
  }
  expect(rows.find((row) => row.id === runtimeId)?.deployment.status).toBe(
    "running",
  );
  expect(rows.find((row) => row.id === templateId)?.deployment.status).toBe(
    "stopped",
  );
  expect(rows.find((row) => row.id === externalId)?.externalAgentLinks).toEqual(
    [{ access: "write", agent: owner }],
  );
});

it("never resolves a foreign Agent from config or anomalous links and preserves missing detail behavior", async () => {
  const rows = await listSandboxes(workspaceId);
  expect(rows.some((row) => row.id === foreignSandboxId)).toBe(false);
  for (const [id, role] of [
    [forgedOwnerId, "runtime"],
    [anomalousLinksId, "external"],
  ]) {
    const expected = {
      id,
      role,
      ownerAgent: null,
      agentLinks: id === forgedOwnerId ? [{ agent: owner }] : [],
      externalAgentLinks: [],
    };
    expect(rows.find((row) => row.id === id)).toMatchObject(expected);
    expect(await getSandbox(workspaceId, id)).toMatchObject(expected);
  }
  expect(rows.find((row) => row.id === anomalousLinksId)?._count).toMatchObject(
    {
      agentLinks: 0,
      externalAgentLinks: 0,
    },
  );
  expect(JSON.stringify(rows)).not.toContain(foreignOwner.name);
  expect(await getSandbox(workspaceId, foreignSandboxId)).toBeNull();
  expect(await getSandbox(foreignWorkspaceId, runtimeId)).toBeNull();
  expect(await getSandbox(workspaceId, randomUUID())).toBeNull();
  expect(await getSandbox(foreignWorkspaceId, foreignSandboxId)).toMatchObject({
    role: "runtime",
    ownerAgent: foreignOwner,
  });
});

it("counts workspace-owned conversations and native contexts without dropping existing counts or history", async () => {
  const rows = await listSandboxes(workspaceId);
  expect(rows.find((row) => row.id === runtimeId)?._count).toEqual({
    agentLinks: 0,
    externalAgentLinks: 0,
    snapshots: 0,
    conversations: 2,
    a2aContexts: 1,
  });
  expect(rows.find((row) => row.id === archivedId)).toMatchObject({
    role: "history",
    _count: { conversations: 1, a2aContexts: 1 },
  });
  expect(rows.find((row) => row.id === templateId)?._count).toMatchObject({
    agentLinks: 1,
    externalAgentLinks: 0,
    snapshots: 1,
    conversations: 0,
    a2aContexts: 0,
  });
  expect((await getSandbox(workspaceId, templateId))?.snapshots).toEqual([
    expect.objectContaining({ name: "Retained snapshot", status: "ready" }),
  ]);
});

it("keeps SSH credentials and host key material out of both enriched query results", async () => {
  const publicSshFields = {
    host: "sandbox.example.invalid",
    port: 2222,
    username: "sandbox-user",
    root: "/srv/sandbox",
    authType: "key",
  };
  const rows = await listSandboxes(workspaceId);
  expect(rows.find((row) => row.id === sshSandboxId)?.sshServer).toEqual(
    publicSshFields,
  );
  expect((await getSandbox(workspaceId, sshSandboxId))?.sshServer).toEqual(
    publicSshFields,
  );
});
