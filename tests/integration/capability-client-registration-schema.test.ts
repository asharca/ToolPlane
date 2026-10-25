// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { ChatAssistantRevisionConfigSchema } from "@/lib/chat/revision-types";
import { db } from "@/lib/db";

const stamp = `${process.pid}-${Date.now()}`;
let userId = "";
let workspaceId = "";
let listingId = "";
let releaseId = "";
let nextReleaseId = "";
let otherReleaseId = "";
let marketInstallId = "";
const checksum = "a".repeat(64);
const nextChecksum = "b".repeat(64);
const selection = () => [{ releaseId, checksum, kind: "skill" }];
const registration = () => ({
  workspaceId,
  userId,
  client: "claude-code",
  label: "Schema fixture",
  tokenHash: randomUUID(),
  bindings: {},
});

beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { email: `client-schema-${stamp}@test.dev`, passwordHash: "x" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        ownerId: userId,
        slug: `client-schema-${stamp}`,
        name: "Client schema",
      },
    })
  ).id;
  const listing = await db.marketListing.create({
    data: {
      kind: "skill",
      namespace: `client-schema-${stamp}`,
      slug: "fixture",
      name: "Fixture",
      publisherWorkspaceId: workspaceId,
      metadata: {},
    },
  });
  listingId = listing.id;
  releaseId = (
    await db.marketRelease.create({
      data: {
        listingId,
        version: 1,
        manifest: {},
        releaseSummary: {},
        checksum,
      },
    })
  ).id;
  nextReleaseId = (
    await db.marketRelease.create({
      data: {
        listingId,
        version: 2,
        manifest: {},
        releaseSummary: {},
        checksum: nextChecksum,
      },
    })
  ).id;
  const otherListing = await db.marketListing.create({
    data: {
      kind: "mcp",
      namespace: `client-schema-${stamp}`,
      slug: "other",
      name: "Other",
      publisherWorkspaceId: workspaceId,
      metadata: {},
    },
  });
  otherReleaseId = (
    await db.marketRelease.create({
      data: {
        listingId: otherListing.id,
        version: 1,
        manifest: {},
        releaseSummary: {},
        checksum,
      },
    })
  ).id;
  marketInstallId = (
    await db.marketInstall.create({
      data: {
        listingId,
        currentReleaseId: releaseId,
        requestedReleaseId: releaseId,
        targetWorkspaceId: workspaceId,
        idempotencyKey: randomUUID(),
      },
    })
  ).id;
});

afterAll(async () => {
  if (workspaceId) {
    await db.piPackageClientInstallation.deleteMany({ where: { workspaceId } });
    await db.marketInstall.deleteMany({
      where: { targetWorkspaceId: workspaceId },
    });
    await db.agent.deleteMany({ where: { workspaceId } });
    await db.chatAssistant.deleteMany({ where: { workspaceId } });
    await db.deployment.deleteMany({ where: { workspaceId } });
    await db.marketListing.deleteMany({
      where: { publisherWorkspaceId: workspaceId },
    });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
  }
  if (userId) await db.user.deleteMany({ where: { id: userId } });
});

describe("capability client registration persistence", () => {
  it("preserves baseline package pins and accepts generic fixed selections", async () => {
    const baseline = await db.piPackageClientInstallation.create({
      data: { ...registration(), marketInstallId, releaseId },
    });
    expect(baseline.selections).toEqual([]);
    const generic = await db.piPackageClientInstallation.create({
      data: { ...registration(), selections: selection() },
      include: { selectionReferences: true },
    });
    expect(generic.marketInstallId).toBeNull();
    expect(generic.configVersion).toBe(0);
    expect(generic.releaseId).toBeNull();
    expect(generic.selectionReferences).toEqual([
      { installationId: generic.id, releaseId, checksum, kind: "skill" },
    ]);
    await db.piPackageClientInstallation.update({
      where: { id: generic.id },
      data: { label: "Renamed", lastUsedAt: new Date() },
    });
    const authenticated = await db.piPackageClientInstallation.update({
      where: { id: generic.id },
      data: { lastUsedAt: new Date() },
    });
    expect(authenticated.configVersion).toBe(0);
  });

  it("rejects empty generic and partial or wrong-identity baseline pins", async () => {
    for (const pins of [
      {},
      { marketInstallId },
      { releaseId },
      { marketInstallId, releaseId: otherReleaseId },
    ]) {
      await expect(
        db.piPackageClientInstallation.create({
          data: { ...registration(), ...pins },
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects orphan, mismatched, duplicated and credential-bearing selection metadata", async () => {
    for (const selections of [
      [{ releaseId: randomUUID(), checksum, kind: "skill" }],
      [{ releaseId, checksum: nextChecksum, kind: "skill" }],
      [{ releaseId, checksum, kind: "mcp" }],
      [{ releaseId, checksum, kind: "prompt" }],
      [...selection(), ...selection()],
      [{ releaseId, checksum, kind: "skill", apiKey: "not-a-credential" }],
      [{ releaseId, checksum, kind: "skill", credentialId: "extra-field" }],
    ]) {
      await expect(
        db.piPackageClientInstallation.create({
          data: { ...registration(), selections },
        }),
      ).rejects.toThrow();
    }
  });

  it("requires reviewed transactions for selection version changes and keeps identity immutable", async () => {
    const row = await db.piPackageClientInstallation.create({
      data: { ...registration(), selections: selection() },
    });
    const replacement = [
      { releaseId: nextReleaseId, checksum: nextChecksum, kind: "skill" },
    ];
    await expect(
      db.piPackageClientInstallation.update({
        where: { id: row.id },
        data: { selections: replacement },
      }),
    ).rejects.toThrow();
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('toolplane.client_registration_reviewed_update', 'on', true)`;
        await tx.piPackageClientInstallation.update({
          where: { id: row.id },
          data: { selections: replacement },
        });
      }),
    ).rejects.toThrow();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('toolplane.client_registration_reviewed_update', 'on', true)`;
      await tx.piPackageClientInstallation.update({
        where: { id: row.id },
        data: { selections: replacement, configVersion: { increment: 1 } },
      });
    });
    const current = await db.piPackageClientInstallation.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(current.configVersion).toBe(1);
    const staleWrite = await db.piPackageClientInstallation.updateMany({
      where: { id: row.id, configVersion: 0 },
      data: { label: "Stale configuration", configVersion: { increment: 1 } },
    });
    expect(staleWrite.count).toBe(0);
    for (const configVersion of [-1, 0, 3]) {
      await expect(
        db.piPackageClientInstallation.update({
          where: { id: row.id },
          data: { configVersion },
        }),
      ).rejects.toThrow();
    }
    await expect(
      db.piPackageClientInstallation.create({
        data: { ...registration(), selections: selection(), configVersion: -1 },
      }),
    ).rejects.toThrow();
    expect(
      await db.piPackageClientSelection.findMany({
        where: { installationId: row.id },
      }),
    ).toEqual([
      {
        installationId: row.id,
        releaseId: nextReleaseId,
        checksum: nextChecksum,
        kind: "skill",
      },
    ]);
    await expect(
      db.piPackageClientInstallation.update({
        where: { id: row.id },
        data: { selections: selection() },
      }),
    ).rejects.toThrow();
    await expect(
      db.piPackageClientInstallation.update({
        where: { id: row.id },
        data: { client: "pi" },
      }),
    ).rejects.toThrow();
  });

  it("retains release references after revocation and prevents direct reference tampering", async () => {
    const row = await db.piPackageClientInstallation.create({
      data: { ...registration(), selections: selection() },
    });
    await db.piPackageClientInstallation.update({
      where: { id: row.id },
      data: { status: "revoked" },
    });
    await expect(
      db.piPackageClientSelection.deleteMany({
        where: { installationId: row.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.marketRelease.delete({ where: { id: releaseId } }),
    ).rejects.toThrow();
    await expect(
      db.marketListing.delete({ where: { id: listingId } }),
    ).rejects.toThrow();
    await expect(
      db.marketRelease.update({
        where: { id: releaseId },
        data: { checksum: nextChecksum },
      }),
    ).rejects.toThrow();
    await expect(
      db.marketRelease.update({
        where: { id: releaseId },
        data: { version: 3 },
      }),
    ).rejects.toThrow();
    await expect(
      db.marketListing.update({
        where: { id: listingId },
        data: { kind: "mcp" },
      }),
    ).rejects.toThrow();
  });

  it("releases generic retention only when the registration itself is deleted", async () => {
    const row = await db.piPackageClientInstallation.create({
      data: {
        ...registration(),
        selections: [{ releaseId: otherReleaseId, checksum, kind: "mcp" }],
      },
    });
    await expect(
      db.marketRelease.delete({ where: { id: otherReleaseId } }),
    ).rejects.toThrow();
    await db.piPackageClientInstallation.delete({ where: { id: row.id } });
    expect(
      await db.piPackageClientSelection.count({
        where: { installationId: row.id },
      }),
    ).toBe(0);
    await db.marketRelease.delete({ where: { id: otherReleaseId } });
  });
});

describe("revision source release retention", () => {
  it("retains shared revision sources and narrows live grants without rewriting artifact history", async () => {
    const listing = await db.marketListing.create({
      data: {
        kind: "pi-package",
        namespace: `client-schema-${stamp}`,
        slug: "revision-source",
        name: "Revision source",
        publisherWorkspaceId: workspaceId,
        metadata: {},
      },
    });
    const source = await db.marketRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifest: {},
        releaseSummary: {},
        checksum,
      },
    });
    const packageInstall = await db.marketInstall.create({
      data: {
        listingId: listing.id,
        currentReleaseId: source.id,
        requestedReleaseId: source.id,
        targetWorkspaceId: workspaceId,
        idempotencyKey: randomUUID(),
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId,
        name: "Revision owner",
        slug: `revision-${stamp}`,
        runtimeKind: "pi-sdk",
      },
    });
    const deployment = await db.deployment.create({
      data: { workspaceId, name: "Scoped schema MCP", source: "config" },
    });
    const grant = await db.agentServer.create({
      data: { agentId: agent.id, deploymentId: deployment.id },
    });
    expect(grant.allowedToolNames).toEqual([]);
    await db.agentServer.update({
      where: {
        agentId_deploymentId: {
          agentId: agent.id,
          deploymentId: deployment.id,
        },
      },
      data: { allowedToolNames: ["read", "write"] },
    });
    const capturedGrants = [
      {
        deploymentId: deployment.id,
        definitionChecksum: checksum,
        runtimeImageDigest: `sha256:${checksum}`,
        runtimeFilesChecksum: checksum,
        allowedToolNames: ["read", "write"],
      },
    ];
    const assistant = await db.chatAssistant.create({
      data: { workspaceId, name: "Prompt owner" },
    });
    const agentConfig = AgentRevisionConfigSchema.parse({
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
      knowledgeBaseIds: [],
      mcpGrants: capturedGrants,
      environment: {
        kind: "docker",
        image: `example.invalid/test@sha256:${checksum}`,
        network: "none",
        piVersion: "0.87.1",
        initialSnapshot: null,
        resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
        credentialReferences: [],
      },
      packages: [
        {
          marketInstallId: packageInstall.id,
          releaseId: source.id,
          integrity: checksum,
        },
      ],
      a2a: {
        inboundEnabled: false,
        outboundEnabled: false,
        policy: { schemaVersion: 1, targets: [] },
      },
    });
    const assistantConfig = ChatAssistantRevisionConfigSchema.parse({
      schemaVersion: 1,
      systemPrompt: null,
      modelProviderId: null,
      model: null,
      modelParameters: null,
      maxSteps: 100,
      mcpGrants: [],
    });
    // Failed insert transactions do not consume the owner's next revision number.
    for (const packagePin of [
      { marketInstallId, releaseId: randomUUID(), integrity: checksum },
      { marketInstallId, releaseId, integrity: checksum },
      { marketInstallId, releaseId: source.id, integrity: nextChecksum },
    ]) {
      await expect(
        db.agentRevision.create({
          data: {
            agentId: agent.id,
            version: 1,
            config: { ...agentConfig, packages: [packagePin] },
          },
        }),
      ).rejects.toThrow();
    }
    const agentRevision = await db.agentRevision.create({
      data: { agentId: agent.id, version: 1, config: agentConfig },
      include: { releaseReferences: true },
    });
    const assistantRevision = await db.chatAssistantRevision.create({
      data: { assistantId: assistant.id, version: 1, config: assistantConfig },
      include: { releaseReferences: true },
    });
    expect(agentRevision.releaseReferences).toEqual([
      { revisionId: agentRevision.id, releaseId: source.id },
    ]);
    // Assistant revisions no longer carry any market-release-sourced field
    // (prompt templates were removed), so they never retain a reference.
    expect(assistantRevision.releaseReferences).toEqual([]);
    const narrowed = await db.agentServer.update({
      where: {
        agentId_deploymentId: {
          agentId: agent.id,
          deploymentId: deployment.id,
        },
      },
      data: { allowedToolNames: ["read"] },
    });
    expect(narrowed.allowedToolNames).toEqual(["read"]);
    expect(
      AgentRevisionConfigSchema.parse(
        (
          await db.agentRevision.findUniqueOrThrow({
            where: { id: agentRevision.id },
          })
        ).config,
      ).mcpGrants,
    ).toEqual(capturedGrants);
    await db.agentServer.delete({
      where: {
        agentId_deploymentId: {
          agentId: agent.id,
          deploymentId: deployment.id,
        },
      },
    });
    expect(
      await db.agentServer.count({
        where: { agentId: agent.id, deploymentId: deployment.id },
      }),
    ).toBe(0);
    expect(
      AgentRevisionConfigSchema.parse(
        (
          await db.agentRevision.findUniqueOrThrow({
            where: { id: agentRevision.id },
          })
        ).config,
      ).mcpGrants,
    ).toEqual(capturedGrants);
    await db.marketInstall.delete({ where: { id: packageInstall.id } });
    await expect(
      db.marketRelease.delete({ where: { id: source.id } }),
    ).rejects.toThrow();
    await expect(
      db.marketRelease.update({
        where: { id: source.id },
        data: { checksum: nextChecksum },
      }),
    ).rejects.toThrow();
    await expect(
      db.marketRelease.update({
        where: { id: source.id },
        data: { version: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      db.marketListing.update({
        where: { id: listing.id },
        data: { kind: "skill" },
      }),
    ).rejects.toThrow();
    await expect(
      db.agentRevisionReleaseReference.deleteMany({
        where: { revisionId: agentRevision.id },
      }),
    ).rejects.toThrow();
    // Removing either object must not remove the other object's retained source.
    await db.agent.delete({ where: { id: agent.id } });
    await expect(
      db.marketRelease.delete({ where: { id: source.id } }),
    ).rejects.toThrow();
    await db.chatAssistant.delete({ where: { id: assistant.id } });
    await db.marketRelease.delete({ where: { id: source.id } });
  });
});
