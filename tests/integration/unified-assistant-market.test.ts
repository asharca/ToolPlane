// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChatAssistant,
  deleteChatAssistant,
  installAssistantMarketRelease,
  updateChatAssistant,
} from "@/lib/chat/service";
import { db } from "@/lib/db";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { getMarketListing } from "@/lib/market/listings";
import {
  approveMarketRelease,
  getAssistantMarketTemplate,
  listAssistantMarketTemplates,
  type MarketError,
  publishAssistantRelease,
} from "@/lib/market/skills";

const stamp = `${process.pid}-${Date.now()}`;
const namespace = `assistant-market-source-${stamp}`;
let sourceUserId = "";
let targetUserId = "";
let adminUserId = "";
let sourceWorkspaceId = "";
let targetWorkspaceId = "";
let sourceAssistantId = "";
let serverId = "";
let targetDeploymentId = "";
let targetDefinitionChecksum = "";
let categoryId = "";
let listingId = "";
let releaseId = "";

describe.sequential("unified assistant market", () => {
  beforeAll(async () => {
    const [sourceUser, targetUser, admin] = await Promise.all([
      db.user.create({
        data: {
          email: `assistant-market-source-${stamp}@test.dev`,
          passwordHash: "x",
        },
      }),
      db.user.create({
        data: {
          email: `assistant-market-target-${stamp}@test.dev`,
          passwordHash: "x",
        },
      }),
      db.user.create({
        data: {
          email: `assistant-market-admin-${stamp}@test.dev`,
          passwordHash: "x",
          role: "admin",
        },
      }),
    ]);
    sourceUserId = sourceUser.id;
    targetUserId = targetUser.id;
    adminUserId = admin.id;
    const [sourceWorkspace, targetWorkspace] = await Promise.all([
      db.workspace.create({
        data: {
          slug: namespace,
          name: "Assistant publisher",
          ownerId: sourceUser.id,
          members: { create: { userId: sourceUser.id, role: "owner" } },
        },
      }),
      db.workspace.create({
        data: {
          slug: `assistant-market-target-${stamp}`,
          name: "Assistant user",
          ownerId: targetUser.id,
          members: { create: { userId: targetUser.id, role: "owner" } },
        },
      }),
    ]);
    sourceWorkspaceId = sourceWorkspace.id;
    targetWorkspaceId = targetWorkspace.id;
    const [provider, server, category] = await Promise.all([
      db.modelProvider.create({
        data: {
          workspaceId: sourceWorkspace.id,
          name: "Private provider",
          format: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          apiKey: `sk-proj-${"z".repeat(24)}`,
          models: ["gpt-test"],
        },
      }),
      db.server.create({
        data: {
          slug: `assistant-search-${stamp}`,
          name: "Assistant search",
          verifiedAt: new Date(),
          installCfg: {
            source: "remote",
            ref: "https://mcp.example.test/search",
            transport: "streamable-http",
            authType: "none",
          },
        },
      }),
      db.category.create({
        data: { slug: `assistant-market-${stamp}`, name: "Assistant market" },
      }),
    ]);
    await db.modelProvider.create({
      data: {
        workspaceId: targetWorkspace.id,
        name: "Target provider",
        format: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        apiKey: "target-key",
        models: ["gpt-test"],
      },
    });
    serverId = server.id;
    categoryId = category.id;
    const [deployment, targetDeployment] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: sourceWorkspace.id,
          serverId: server.id,
          name: "Search",
          source: "remote",
          sourceRef: "https://mcp.example.test/search",
          installCfg: { transport: "streamable-http", authType: "none" },
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["search"],
          status: "stopped",
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: targetWorkspace.id,
          serverId: server.id,
          name: "Search",
          source: "remote",
          sourceRef: "https://mcp.example.test/search",
          installCfg: { transport: "streamable-http", authType: "none" },
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["search"],
          status: "stopped",
        },
      }),
    ]);
    targetDeploymentId = targetDeployment.id;
    targetDefinitionChecksum = mcpDefinitionChecksum(targetDeployment);
    const assistant = await createChatAssistant(sourceUserId, {
      workspaceId: sourceWorkspace.id,
      name: "Research helper",
      systemPrompt: "Research and cite the result.",
      modelProviderId: provider.id,
      model: "gpt-test",
      maxSteps: 6,
      mcpGrants: [
        {
          deploymentId: deployment.id,
          allowedToolNames: ["search"],
          expectedDefinitionChecksum: mcpDefinitionChecksum(deployment),
        },
      ],
    });
    sourceAssistantId = assistant.id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({
      where: { id: { in: [sourceWorkspaceId, targetWorkspaceId] } },
    });
    await db.marketListing.deleteMany({ where: { namespace } });
    await db.server.deleteMany({ where: { id: serverId } });
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.user.deleteMany({
      where: { id: { in: [sourceUserId, targetUserId, adminUserId] } },
    });
    await db.$disconnect();
  });

  it("publishes, reviews, and exposes a secret-free template", async () => {
    await expect(
      publishAssistantRelease({
        workspaceId: sourceWorkspaceId,
        assistantId: sourceAssistantId,
        publishedById: targetUserId,
        categoryIds: [categoryId],
      }),
    ).rejects.toMatchObject({
      code: "not_authorized",
    } satisfies Partial<MarketError>);

    const published = await publishAssistantRelease({
      workspaceId: sourceWorkspaceId,
      assistantId: sourceAssistantId,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      listing: {
        summary: "A portable research assistant.",
        tags: ["research"],
      },
      releaseNotes: "Initial release.",
    });
    listingId = published.listing.id;
    releaseId = published.release.id;
    expect(published.release.reviewStatus).toBe("pending");
    expect(published.manifest.assistant).toMatchObject({
      modelRequirement: {
        providerFormat: "openai-compatible",
        model: "gpt-test",
      },
      mcpRequirements: [{ name: "Search" }],
    });
    const serialized = JSON.stringify(published.manifest);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain(sourceWorkspaceId);

    await approveMarketRelease({
      listingId,
      releaseId,
      reviewedById: adminUserId,
    });
    const [template, templates, listing] = await Promise.all([
      getAssistantMarketTemplate(releaseId),
      listAssistantMarketTemplates({ q: "Research helper" }),
      getMarketListing(namespace, published.listing.slug),
    ]);
    expect(template).toMatchObject({
      releaseId,
      listing: { namespace, name: "Research helper" },
      manifest: { kind: "assistant" },
    });
    expect(templates).toContainEqual(template);
    expect(listing?.kind).toBe("assistant");
  });

  it("attributes a created assistant to the approved current template", async () => {
    await expect(
      createChatAssistant(targetUserId, {
        workspaceId: targetWorkspaceId,
        name: "Invalid template",
        marketTemplateReleaseId: "missing-release",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createChatAssistant(targetUserId, {
        workspaceId: targetWorkspaceId,
        name: "Missing requirement",
        marketTemplateReleaseId: releaseId,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const assistant = await installAssistantMarketRelease(targetUserId, {
      workspaceId: targetWorkspaceId,
      releaseId,
      name: "My research helper",
      systemPrompt: "Customized instructions.",
      mcpGrants: [
        {
          deploymentId: targetDeploymentId,
          allowedToolNames: ["search"],
          expectedDefinitionChecksum: targetDefinitionChecksum,
        },
      ],
    });
    expect(assistant.marketTemplateReleaseId).toBe(releaseId);
    expect(assistant.modelProvider?.name).toBe("Target provider");
    expect(assistant.model).toBe("gpt-test");
    expect(assistant.mcpGrants.map(({ deploymentId }) => deploymentId)).toEqual(
      [targetDeploymentId],
    );
    expect(
      (await db.marketListing.findUnique({ where: { id: listingId } }))
        ?.installCount,
    ).toBe(1);
    await deleteChatAssistant(targetUserId, assistant.id);
    expect(
      (await db.marketListing.findUnique({ where: { id: listingId } }))
        ?.installCount,
    ).toBe(0);
  });

  it("allows workspace custom MCPs while rejecting foreign and sandbox deployments", async () => {
    const [custom, sandbox, foreign] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: targetWorkspaceId,
          name: "Custom MCP",
          source: "remote",
          sourceRef: "https://mcp.example.test/custom",
          installCfg: { transport: "streamable-http", authType: "none" },
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["search"],
          status: "stopped",
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: targetWorkspaceId,
          name: "Sandbox MCP",
          source: "sandbox",
          status: "stopped",
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: sourceWorkspaceId,
          name: "Foreign MCP",
          source: "remote",
          sourceRef: "https://mcp.example.test/foreign",
          installCfg: { transport: "streamable-http", authType: "none" },
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["search"],
          status: "stopped",
        },
      }),
    ]);
    const assistant = await createChatAssistant(targetUserId, {
      workspaceId: targetWorkspaceId,
      name: "Custom MCP helper",
      mcpGrants: [
        {
          deploymentId: custom.id,
          allowedToolNames: ["search"],
          expectedDefinitionChecksum: mcpDefinitionChecksum(custom),
        },
      ],
    });

    await expect(
      updateChatAssistant(targetUserId, assistant.id, {
        expectedRevision: 1,
        mcpGrants: [{ deploymentId: custom.id, allowedToolNames: ["search"] }],
      }),
    ).resolves.toMatchObject({
      mcpGrants: [expect.objectContaining({ deploymentId: custom.id })],
    });
    await expect(
      updateChatAssistant(targetUserId, assistant.id, {
        expectedRevision: 2,
        mcpGrants: [
          {
            deploymentId: foreign.id,
            allowedToolNames: ["search"],
            expectedDefinitionChecksum: mcpDefinitionChecksum(foreign),
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateChatAssistant(targetUserId, assistant.id, {
        expectedRevision: 2,
        mcpGrants: [
          {
            deploymentId: sandbox.id,
            allowedToolNames: ["search"],
            expectedDefinitionChecksum: mcpDefinitionChecksum(sandbox),
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks assistant releases that contain credentials", async () => {
    const unsafe = await createChatAssistant(sourceUserId, {
      workspaceId: sourceWorkspaceId,
      name: "Unsafe helper",
      systemPrompt: `Use sk-proj-${"a".repeat(24)}`,
    });
    await expect(
      publishAssistantRelease({
        workspaceId: sourceWorkspaceId,
        assistantId: unsafe.id,
        publishedById: sourceUserId,
        categoryIds: [categoryId],
      }),
    ).rejects.toMatchObject({
      code: "invalid_manifest",
    } satisfies Partial<MarketError>);
    expect(
      await db.marketListing.findUnique({
        where: { sourceChatAssistantId: unsafe.id },
      }),
    ).toBeNull();
  });

  it("rejects new Assistant grants to local executable MCPs", async () => {
    const customDeployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: "Private custom MCP",
        source: "npm",
        sourceRef: "@example/private-mcp",
        status: "stopped",
      },
    });
    await expect(
      createChatAssistant(sourceUserId, {
        workspaceId: sourceWorkspaceId,
        name: "Nonportable helper",
        mcpGrants: [
          {
            deploymentId: customDeployment.id,
            allowedToolNames: ["search"],
            expectedDefinitionChecksum: mcpDefinitionChecksum(customDeployment),
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
