// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { ChatAssistantRevisionConfigSchema } from "@/lib/chat/revision-types";
import { db } from "@/lib/db";

const stamp = `${process.pid}-${Date.now()}`;
let userId = "";
let workspaceId = "";
const checksum = "a".repeat(64);
const nextChecksum = "b".repeat(64);

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
});

afterAll(async () => {
  if (workspaceId) {
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
        targetWorkspaceId: workspaceId,
        idempotencyKey: randomUUID(),
        status: "ready",
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
        piVersion: "1.5.2",
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
      {
        marketInstallId: packageInstall.id,
        releaseId: randomUUID(),
        integrity: checksum,
      },
      {
        marketInstallId: randomUUID(),
        releaseId: source.id,
        integrity: checksum,
      },
      {
        marketInstallId: packageInstall.id,
        releaseId: source.id,
        integrity: nextChecksum,
      },
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
    await db.marketRelease.update({
      where: { id: source.id },
      data: { reviewStatus: "revoked" },
    });
    await expect(
      db.agentRevision.create({
        data: { agentId: agent.id, version: 1, config: agentConfig },
      }),
    ).rejects.toThrow();
    await db.marketRelease.update({
      where: { id: source.id },
      data: { reviewStatus: "approved" },
    });
    await db.marketListing.update({
      where: { id: listing.id },
      data: { status: "withdrawn" },
    });
    await expect(
      db.agentRevision.create({
        data: { agentId: agent.id, version: 1, config: agentConfig },
      }),
    ).rejects.toThrow();
    await db.marketListing.update({
      where: { id: listing.id },
      data: { status: "published" },
    });
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
    // Assistant revisions carry no market-release source, so deleting the agent
    // removes the only retained reference and releases the artifact.
    await db.agent.delete({ where: { id: agent.id } });
    await db.chatAssistant.delete({ where: { id: assistant.id } });
    await db.marketRelease.delete({ where: { id: source.id } });
  });
});
