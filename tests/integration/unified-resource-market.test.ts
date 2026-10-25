// @vitest-environment node
import { assertDefined } from "../assert-defined";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Prisma } from "@prisma/client";
import {
  sealMcpEnvironment,
  resolveMcpEnvironment,
} from "@/lib/process/mcp-credentials";

const runtimeMocks = vi.hoisted(() => ({
  stopProcess: vi.fn(),
  killProcess: vi.fn(),
  removeDeploymentContainer: vi.fn(),
  removeDeploymentConfigVolume: vi.fn(),
  validateServerRecipe: vi.fn(),
}));

vi.mock("@/lib/process/supervisor", () => ({
  stopProcess: runtimeMocks.stopProcess,
  killProcess: runtimeMocks.killProcess,
}));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  removeDeploymentContainer: runtimeMocks.removeDeploymentContainer,
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  removeDeploymentConfigVolume: runtimeMocks.removeDeploymentConfigVolume,
}));
vi.mock("@/lib/admin/recipe-validate", () => ({
  validateServerRecipe: runtimeMocks.validateServerRecipe,
}));
// Runtime lifecycle is mocked in this database suite; owner-lease coordination
// belongs to the dedicated operation-gate/supervisor tests.
vi.mock("@/lib/workspace/mcp-operation", () => ({
  runMcpDeploymentOperation: async (
    _workspaceId: string,
    _deploymentId: string,
    operation: () => Promise<unknown>,
  ) => ({ accepted: true, value: await operation() }),
}));
import { db } from "@/lib/db";
import {
  approveResourceMarketRelease,
  installMcpRelease,
  parseMcpMarketManifest,
  publishMcpRelease,
  updateMarketInstall,
} from "@/lib/market/resources";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { getMarketListing } from "@/lib/market/listings";
import { type MarketError, removeMarketInstall } from "@/lib/market/skills";
import { getBrowseServers } from "@/lib/workspace/queries";
import { GET as getPublicMarketListing } from "@/app/api/v1/market/listings/[namespace]/[slug]/route";
import { cutoverToolkitToPrivatePackage } from "@/lib/toolkits/cutover";

const stamp = `${process.pid}-${Date.now()}`;
const namespace = `resource-market-source-${stamp}`;
const targetSlug = `resource-market-target-${stamp}`;
const sourceMcpSecret = `sk-proj-${"m".repeat(24)}`;
const encodedSourceMcpSecret = Buffer.from(sourceMcpSecret).toString("base64");
const sourceToolkitSecret = `sk-proj-${"t".repeat(24)}`;

let sourceUserId = "";
let targetUserId = "";
let adminUserId = "";
let sourceWorkspaceId = "";
let targetWorkspaceId = "";
let categoryId = "";
let secondCategoryId = "";
let sourceMcpId = "";
let toolkitServerId = "";
let approvedMcpServerId = "";
let legacyServerId = "";
let historicalMcpServerId = "";

describe.sequential("unified MCP and toolkit market", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.stopProcess.mockResolvedValue(undefined);
    runtimeMocks.killProcess.mockResolvedValue(undefined);
    runtimeMocks.removeDeploymentContainer.mockResolvedValue(undefined);
    runtimeMocks.removeDeploymentConfigVolume.mockResolvedValue(undefined);
    runtimeMocks.validateServerRecipe.mockResolvedValue({
      ok: true,
      toolCount: 1,
      tools: ["search_v1"],
      toolCatalog: [
        {
          name: "search_v1",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    });
  });

  beforeAll(async () => {
    const [sourceUser, targetUser, admin] = await Promise.all([
      db.user.create({
        data: { email: `resource-source-${stamp}@test.dev`, passwordHash: "x" },
      }),
      db.user.create({
        data: { email: `resource-target-${stamp}@test.dev`, passwordHash: "x" },
      }),
      db.user.create({
        data: {
          email: `resource-admin-${stamp}@test.dev`,
          passwordHash: "x",
          role: "admin",
        },
      }),
    ]);
    sourceUserId = sourceUser.id;
    targetUserId = targetUser.id;
    adminUserId = admin.id;

    const [
      sourceWorkspace,
      targetWorkspace,
      category,
      secondCategory,
      toolkitServer,
    ] = await Promise.all([
      db.workspace.create({
        data: {
          slug: namespace,
          name: "Resource publisher",
          ownerId: sourceUser.id,
          members: { create: { userId: sourceUser.id, role: "owner" } },
        },
      }),
      db.workspace.create({
        data: {
          slug: targetSlug,
          name: "Resource installer",
          ownerId: targetUser.id,
          members: { create: { userId: targetUser.id, role: "owner" } },
        },
      }),
      db.category.create({
        data: { slug: `resource-market-${stamp}`, name: "Resource market" },
      }),
      db.category.create({
        data: {
          slug: `resource-market-next-${stamp}`,
          name: "Resource market next",
        },
      }),
      db.server.create({
        data: {
          slug: `resource-toolkit-mcp-${stamp}`,
          name: "Toolkit catalog MCP",
          verifiedAt: new Date(),
          verifiedTools: 0,
          installCfg: {
            source: "npm",
            ref: "@modelcontextprotocol/server-filesystem@1.0.0",
            env: ["TOOLKIT_TOKEN"],
            toolCatalog: [],
          },
        },
      }),
    ]);
    sourceWorkspaceId = sourceWorkspace.id;
    targetWorkspaceId = targetWorkspace.id;
    categoryId = category.id;
    secondCategoryId = secondCategory.id;
    toolkitServerId = toolkitServer.id;

    const [sourceMcp, toolkitMcp, toolkitSkill] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: sourceWorkspace.id,
          name: "Portable Connector",
          source: "remote",
          sourceRef: "https://connector.example.test/mcp",
          installCfg: sealMcpEnvironment(
            {
              requiredEnv: ["MCP_TOKEN"],
              transport: "streamable-http",
              authType: "bearer",
              bearerEnv: "MCP_TOKEN",
              toolCatalog: [
                {
                  name: "search_v1",
                  description: `Search the portable index. ${encodedSourceMcpSecret}`,
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
            sourceWorkspace.id,
            { MCP_TOKEN: sourceMcpSecret },
          ) as Prisma.InputJsonObject,
          status: "stopped",
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["search_v1", encodedSourceMcpSecret],
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: sourceWorkspace.id,
          serverId: toolkitServer.id,
          source: "npm",
          sourceRef: "@modelcontextprotocol/server-filesystem@1.0.0",
          installCfg: sealMcpEnvironment({}, sourceWorkspace.id, {
            TOOLKIT_TOKEN: sourceToolkitSecret,
          }) as Prisma.InputJsonObject,
          status: "stopped",
        },
      }),
      db.installedSkill.create({
        data: {
          workspaceId: sourceWorkspace.id,
          name: "Toolkit notes",
          slug: `toolkit-notes-${stamp}`,
          description: "Portable toolkit instructions.",
          content: "# Toolkit notes\n\nVersion one.",
          files: [],
          source: "custom",
        },
      }),
    ]);
    sourceMcpId = sourceMcp.id;
    await db.toolkit.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: "Portable toolkit",
        slug: `portable-toolkit-${stamp}`,
        servers: { create: { deploymentId: toolkitMcp.id } },
        skills: { create: { installedSkillId: toolkitSkill.id } },
      },
    });
  });

  afterAll(async () => {
    await db.workspace.deleteMany({
      where: {
        id: { in: [sourceWorkspaceId, targetWorkspaceId].filter(Boolean) },
      },
    });
    await db.marketListing.deleteMany({ where: { namespace } });
    await db.server.deleteMany({
      where: {
        id: {
          in: [
            toolkitServerId,
            approvedMcpServerId,
            legacyServerId,
            historicalMcpServerId,
          ].filter(Boolean),
        },
      },
    });
    await db.category.deleteMany({
      where: { id: { in: [categoryId, secondCategoryId].filter(Boolean) } },
    });
    await db.user.deleteMany({
      where: {
        id: { in: [sourceUserId, targetUserId, adminUserId].filter(Boolean) },
      },
    });
    await db.$disconnect();
  });

  it("keeps a user submission pending when admin catalog discovery fails", async () => {
    const deployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: "Missing catalog MCP",
        source: "npm",
        sourceRef: "@modelcontextprotocol/server-memory@1.0.0",
        installCfg: { env: {} },
        status: "stopped",
      },
    });
    const submitted = await publishMcpRelease({
      workspaceId: sourceWorkspaceId,
      deploymentId: deployment.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
    });
    expect(submitted.manifest.mcp.toolCatalog).toBeUndefined();
    runtimeMocks.validateServerRecipe.mockResolvedValueOnce({
      ok: false,
      error: "tools/list failed",
    });

    await expect(
      approveResourceMarketRelease({
        listingId: submitted.listing.id,
        releaseId: submitted.release.id,
        reviewedById: adminUserId,
        categoryIds: [categoryId],
      }),
    ).rejects.toMatchObject({
      code: "invalid_manifest",
    } satisfies Partial<MarketError>);
    await expect(
      db.marketListing.findUniqueOrThrow({
        where: { id: submitted.listing.id },
      }),
    ).resolves.toMatchObject({
      status: "draft",
      sourceServerId: null,
      latestReleaseId: null,
      pendingReleaseId: submitted.release.id,
    });
    expect(runtimeMocks.validateServerRecipe).toHaveBeenCalledWith(
      submitted.manifest.mcp.recipe,
    );
  });

  it("publishes, reviews, installs, updates, and removes a secret-free Connector", async () => {
    await expect(
      publishMcpRelease({
        workspaceId: sourceWorkspaceId,
        deploymentId: sourceMcpId,
        publishedById: targetUserId,
        categoryIds: [categoryId],
      }),
    ).rejects.toMatchObject({
      code: "not_authorized",
    } satisfies Partial<MarketError>);

    const first = await publishMcpRelease({
      workspaceId: sourceWorkspaceId,
      deploymentId: sourceMcpId,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
      releaseNotes: "Initial MCP release.",
    });
    expect(first.manifest.mcp.recipe.env).toEqual(["MCP_TOKEN"]);
    expect(first.manifest.mcp.toolCatalog).toBeUndefined();
    expect(first.manifest.mcp.allowedTools).toEqual([]);
    expect(JSON.stringify(first.manifest)).not.toContain(sourceMcpSecret);
    expect(JSON.stringify(first.manifest)).not.toContain("credentialEnvelope");
    expect(JSON.stringify(first.manifest)).not.toContain(
      encodedSourceMcpSecret,
    );
    await approveResourceMarketRelease({
      listingId: first.listing.id,
      releaseId: first.release.id,
      reviewedById: adminUserId,
      categoryIds: [categoryId],
    });
    const approvedListing = await db.marketListing.findUniqueOrThrow({
      where: { id: first.listing.id },
    });
    approvedMcpServerId = assertDefined(approvedListing.sourceServerId);
    await expect(
      db.server.findUniqueOrThrow({ where: { id: approvedMcpServerId } }),
    ).resolves.toMatchObject({
      verifiedTools: 1,
      installCfg: {
        toolCatalog: [{ name: "search_v1", inputSchema: expect.any(Object) }],
      },
    });

    const mutableMcpSource = await db.server.update({
      where: { id: approvedMcpServerId },
      data: { name: "Mutable MCP source name" },
    });
    const approvedMcpBrowse = await getBrowseServers(1, first.listing.slug);
    expect(approvedMcpBrowse.all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: first.manifest.listing.name,
          description: first.manifest.listing.summary,
          marketListing: expect.objectContaining({
            releaseId: first.release.id,
          }),
        }),
      ]),
    );
    const sourceSlugMcpBrowse = await getBrowseServers(
      1,
      mutableMcpSource.slug,
    );
    expect(
      sourceSlugMcpBrowse.all.some(
        ({ marketListing }) => marketListing?.releaseId === first.release.id,
      ),
    ).toBe(true);

    const preexisting = await db.deployment.create({
      data: {
        workspaceId: targetWorkspaceId,
        serverId: approvedMcpServerId,
        status: "stopped",
      },
    });
    await expect(
      installMcpRelease({
        releaseId: first.release.id,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `preexisting-mcp-${stamp}`,
      }),
    ).rejects.toMatchObject({
      code: "already_installed",
    } satisfies Partial<MarketError>);
    expect(
      await db.marketInstall.findFirst({
        where: { targetWorkspaceId, listingId: first.listing.id },
      }),
    ).toBeNull();
    expect(
      (
        await db.marketListing.findUniqueOrThrow({
          where: { id: first.listing.id },
        })
      ).installCount,
    ).toBe(0);
    await db.deployment.delete({ where: { id: preexisting.id } });

    await expect(
      installMcpRelease({
        releaseId: first.release.id,
        targetWorkspaceId,
        installedById: sourceUserId,
        idempotencyKey: `unauthorized-mcp-${stamp}`,
      }),
    ).rejects.toMatchObject({
      code: "not_authorized",
    } satisfies Partial<MarketError>);

    const installed = await installMcpRelease({
      releaseId: first.release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `mcp-${stamp}`,
    });
    expect(installed.install.status).toBe("setup_required");
    expect(installed.resource.installCfg).toMatchObject({
      env: { MCP_TOKEN: "" },
    });
    expect(installed.resource.installCfg).toMatchObject({
      toolCatalog: [{ name: "search_v1", inputSchema: expect.any(Object) }],
    });
    expect(
      (
        await db.marketListing.findUniqueOrThrow({
          where: { id: first.listing.id },
        })
      ).installCount,
    ).toBe(1);

    await db.deployment.update({
      where: { id: installed.resource.id },
      data: {
        installCfg: sealMcpEnvironment(
          installed.resource.installCfg,
          targetWorkspaceId,
          { MCP_TOKEN: "target-only-value" },
        ) as Prisma.InputJsonObject,
      },
    });
    await db.deployment.update({
      where: { id: sourceMcpId },
      data: { mcpAllowedTools: ["search_v2"] },
    });
    const second = await publishMcpRelease({
      workspaceId: sourceWorkspaceId,
      deploymentId: sourceMcpId,
      publishedById: sourceUserId,
      categoryIds: [secondCategoryId],
      releaseNotes: "Updated tool allowlist.",
    });
    expect(second.release.version).toBe(2);
    expect(second.manifest.mcp.allowedTools).toEqual([]);
    expect(JSON.stringify(second.manifest)).not.toContain(sourceMcpSecret);
    expect(JSON.stringify(second.manifest)).not.toContain("credentialEnvelope");
    expect(
      (
        await db.marketListing.findUniqueOrThrow({
          where: { id: first.listing.id },
          include: { categories: { select: { id: true } } },
        })
      ).categories.map(({ id }) => id),
    ).toEqual([categoryId]);
    await approveResourceMarketRelease({
      listingId: first.listing.id,
      releaseId: second.release.id,
      reviewedById: adminUserId,
    });
    expect(
      (
        await db.marketListing.findUniqueOrThrow({
          where: { id: first.listing.id },
          include: { categories: { select: { id: true } } },
        })
      ).categories.map(({ id }) => id),
    ).toEqual([secondCategoryId]);
    await db.marketInstall.update({
      where: { id: installed.install.id },
      data: { status: "modified" },
    });
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId,
        actorId: targetUserId,
        currentReleaseId: first.release.id,
        targetReleaseId: second.release.id,
      }),
    ).rejects.toMatchObject({
      code: "local_changes",
    } satisfies Partial<MarketError>);
    expect(runtimeMocks.stopProcess).not.toHaveBeenCalled();
    await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId,
      actorId: targetUserId,
      currentReleaseId: first.release.id,
      targetReleaseId: second.release.id,
      force: true,
    });
    const updatedDeployment = await db.deployment.findUniqueOrThrow({
      where: { id: installed.resource.id },
    });
    expect(updatedDeployment.installCfg).toMatchObject({
      env: { MCP_TOKEN: "" },
      credentialEnvelope: expect.any(Object),
    });
    expect(
      resolveMcpEnvironment(updatedDeployment.installCfg, targetWorkspaceId),
    ).toEqual({ MCP_TOKEN: "target-only-value" });
    expect(JSON.stringify(updatedDeployment.installCfg)).not.toContain(
      "target-only-value",
    );
    expect(updatedDeployment.mcpAllowedTools).toEqual([]);
    expect(updatedDeployment.status).toBe("stopped");
    expect(runtimeMocks.stopProcess).toHaveBeenCalledWith(
      installed.resource.id,
    );
    expect(runtimeMocks.removeDeploymentContainer).toHaveBeenCalledWith(
      installed.resource.id,
    );
    expect(runtimeMocks.removeDeploymentConfigVolume).toHaveBeenCalledWith(
      installed.resource.id,
    );

    await removeMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId,
      actorId: targetUserId,
    });
    expect(
      await db.deployment.findUnique({ where: { id: installed.resource.id } }),
    ).toBeNull();
    expect(
      (
        await db.marketListing.findUniqueOrThrow({
          where: { id: first.listing.id },
        })
      ).installCount,
    ).toBe(0);
    expect(runtimeMocks.killProcess).toHaveBeenCalledWith(
      installed.resource.id,
      { preventRestart: true },
    );
    expect(runtimeMocks.removeDeploymentContainer).toHaveBeenCalledWith(
      installed.resource.id,
    );
    expect(runtimeMocks.removeDeploymentConfigVolume).toHaveBeenCalledWith(
      installed.resource.id,
    );
  });

  it("installs reviewed legacy stdio recipes and filters allowlists through trusted tool snapshots", async () => {
    const canary = `credential-${stamp}`;
    const slug = `legacy-allowlist-${stamp}`;
    const sourceDeployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: "Legacy allowlist MCP",
        source: "npm",
        sourceRef: "@modelcontextprotocol/server-memory@1.0.0",
        installCfg: { env: {} },
        status: "stopped",
      },
    });
    const manifest = {
      schemaVersion: 1 as const,
      kind: "mcp" as const,
      listing: {
        slug,
        name: "Legacy allowlist MCP",
        summary: null,
        iconUrl: null,
        tags: [],
        author: "Legacy publisher",
      },
      mcp: {
        name: "Legacy allowlist MCP",
        slug,
        description: null,
        author: null,
        iconUrl: null,
        readme: null,
        recipe: {
          source: "npm" as const,
          ref: "@modelcontextprotocol/server-memory@1.0.0",
          env: [],
        },
        toolExposure: "allowlist" as const,
        allowedTools: ["safe_tool", "runtime_tool", canary],
        toolCatalog: [
          {
            name: "runtime_tool",
            description: `Runtime description ${canary}`,
            inputSchema: {
              type: "object",
              properties: {
                payload: {
                  type: "string",
                  description: `Runtime schema ${canary}`,
                },
              },
            },
          },
        ],
      },
    };
    const listing = await db.marketListing.create({
      data: {
        kind: "mcp",
        namespace,
        slug,
        publisherWorkspaceId: sourceWorkspaceId,
        publishedById: sourceUserId,
        sourceDeploymentId: sourceDeployment.id,
        name: manifest.listing.name,
        summary: null,
        tags: [],
        metadata: {},
        status: "draft",
      },
    });
    const release = await db.marketRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifest,
        releaseSummary: {},
        checksum: marketReleaseChecksum(manifest),
        categoryIds: [categoryId],
      },
    });
    await db.marketListing.update({
      where: { id: listing.id },
      data: { pendingReleaseId: release.id, latestVersion: 1 },
    });
    runtimeMocks.validateServerRecipe.mockResolvedValueOnce({
      ok: true,
      toolCount: 0,
      tools: [],
      toolCatalog: [],
    });
    await approveResourceMarketRelease({
      listingId: listing.id,
      releaseId: release.id,
      reviewedById: adminUserId,
      categoryIds: [categoryId],
    });
    const approved = await db.marketListing.findUniqueOrThrow({
      where: { id: listing.id },
      include: { sourceServer: { select: { id: true, installCfg: true } } },
    });
    expect(approved.sourceServer).toBeTruthy();
    legacyServerId = assertDefined(approved.sourceServer).id;
    expect(assertDefined(approved.sourceServer).installCfg).toMatchObject({
      toolCatalog: [],
    });
    expect(JSON.stringify(approved.sourceServer)).not.toContain(canary);
    expect(
      JSON.stringify(
        (
          await db.marketRelease.findUniqueOrThrow({
            where: { id: release.id },
          })
        ).manifest,
      ),
    ).toContain(canary);

    const unknownDetail = await getMarketListing(namespace, slug);
    const unknownManifest = parseMcpMarketManifest(
      assertDefined(assertDefined(unknownDetail).latestRelease).manifest,
      assertDefined(assertDefined(unknownDetail).latestRelease).checksum,
    );
    expect(unknownManifest.mcp.allowedTools).toEqual([]);
    expect(unknownManifest.mcp.toolCatalog).toBeUndefined();
    expect(JSON.stringify(unknownDetail)).not.toContain(canary);

    await db.server.update({
      where: { id: legacyServerId },
      data: {
        installCfg: {
          source: "npm",
          ref: "@modelcontextprotocol/server-memory@1.0.0",
          env: [],
          toolCatalog: [
            {
              name: "safe_tool",
              description: "Verified safe tool.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
        verifiedTools: 1,
      },
    });

    const detail = await getMarketListing(namespace, slug);
    expect(detail?.latestRelease).toBeTruthy();
    const publicManifest = parseMcpMarketManifest(
      assertDefined(assertDefined(detail).latestRelease).manifest,
      assertDefined(assertDefined(detail).latestRelease).checksum,
    );
    expect(publicManifest.mcp.allowedTools).toEqual([]);
    expect(publicManifest.mcp.toolCatalog).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(canary);
    const publicResponse = await getPublicMarketListing(
      new Request(
        `http://toolplane.test/api/v1/market/listings/${namespace}/${slug}`,
      ),
      { params: Promise.resolve({ namespace, slug }) },
    );
    const publicPayload = await publicResponse.json();
    expect(publicResponse.status).toBe(200);
    expect(publicPayload.latestRelease.manifest.mcp.allowedTools).toEqual([]);
    expect(publicPayload.latestRelease.manifest.mcp).not.toHaveProperty(
      "toolCatalog",
    );

    const firstInstall = await installMcpRelease({
      releaseId: release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `legacy-allowlist-${stamp}`,
    });
    expect(firstInstall.resource).toMatchObject({
      source: "npm",
      sourceRef: "@modelcontextprotocol/server-memory@1.0.0",
      status: "stopped",
      mcpAllowedTools: [],
    });
    expect(firstInstall.resource.installCfg).toMatchObject({ toolCatalog: [] });
    expect(JSON.stringify(firstInstall.resource)).not.toContain(canary);
    const legacyInstall = firstInstall.install;
    const legacyDeployment = await db.deployment.update({
      where: { id: firstInstall.resource.id },
      data: {
        name: "Previously installed Connector",
        source: "remote",
        sourceRef: "https://connector.example.test/mcp",
        installCfg: { env: {}, transport: "streamable-http" },
        status: "stopped",
      },
    });
    const reused = await installMcpRelease({
      releaseId: release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: legacyInstall.idempotencyKey,
    });
    expect(reused).toMatchObject({
      reused: true,
      install: { id: legacyInstall.id },
      resource: { id: legacyDeployment.id },
    });
    const serverRelease = await db.marketRelease.create({
      data: {
        listingId: listing.id,
        version: 2,
        manifest,
        releaseSummary: {},
        checksum: marketReleaseChecksum(manifest),
        categoryIds: [categoryId],
        reviewStatus: "approved",
        reviewedById: adminUserId,
        reviewedAt: new Date(),
        publishedAt: new Date(),
      },
    });
    await db.marketListing.update({
      where: { id: listing.id },
      data: { latestVersion: 2, latestReleaseId: serverRelease.id },
    });

    await updateMarketInstall({
      installId: legacyInstall.id,
      targetWorkspaceId,
      actorId: targetUserId,
      currentReleaseId: release.id,
      targetReleaseId: serverRelease.id,
    });
    expect(runtimeMocks.stopProcess).toHaveBeenCalledWith(legacyDeployment.id);
    expect(runtimeMocks.removeDeploymentContainer).toHaveBeenCalledWith(
      legacyDeployment.id,
    );
    const updatedDeployment = await db.deployment.findUniqueOrThrow({
      where: { id: legacyDeployment.id },
    });
    expect(updatedDeployment).toMatchObject({
      source: "npm",
      sourceRef: "@modelcontextprotocol/server-memory@1.0.0",
      status: "stopped",
      mcpAllowedTools: ["safe_tool"],
    });
    expect(JSON.stringify(updatedDeployment)).not.toContain(canary);
    expect(
      await db.marketInstall.findUniqueOrThrow({
        where: { id: legacyInstall.id },
      }),
    ).toMatchObject({
      currentReleaseId: serverRelease.id,
      deploymentId: legacyDeployment.id,
    });
  });

  it("restores an explicitly selected approved MCP recipe and tools while preserving target secrets", async () => {
    const source = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: `Historical MCP ${stamp}`,
        source: "config",
        sourceRef: "npx",
        installCfg: sealMcpEnvironment(
          { command: "npx", args: ["-y", "@team/mcp@1.0.0"] },
          sourceWorkspaceId,
          { TOKEN: "source-only-secret" },
        ) as Prisma.InputJsonObject,
        status: "stopped",
        mcpToolExposure: "all",
      },
    });
    const first = await publishMcpRelease({
      workspaceId: sourceWorkspaceId,
      deploymentId: source.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
    });
    await approveResourceMarketRelease({
      listingId: first.listing.id,
      releaseId: first.release.id,
      reviewedById: adminUserId,
    });
    const listing = await db.marketListing.findUniqueOrThrow({
      where: { id: first.listing.id },
    });
    historicalMcpServerId = assertDefined(listing.sourceServerId);
    const installed = await installMcpRelease({
      releaseId: first.release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `historical-mcp-${stamp}`,
    });
    await db.deployment.update({
      where: { id: installed.resource.id },
      data: {
        installCfg: sealMcpEnvironment(
          {
            command: "npx",
            args: ["-y", "@team/mcp@1.0.0"],
            requiredEnv: ["TOKEN"],
          },
          targetWorkspaceId,
          { TOKEN: "target-only-secret", EXTRA: "target-extra" },
        ) as Prisma.InputJsonObject,
        status: "stopped",
      },
    });
    await db.deployment.update({
      where: { id: source.id },
      data: {
        installCfg: sealMcpEnvironment(
          { command: "npx", args: ["-y", "@team/mcp@2.0.0"] },
          sourceWorkspaceId,
          { TOKEN: "source-only-secret" },
        ) as Prisma.InputJsonObject,
      },
    });
    const second = await publishMcpRelease({
      workspaceId: sourceWorkspaceId,
      deploymentId: source.id,
      publishedById: sourceUserId,
      categoryIds: [categoryId],
    });
    runtimeMocks.validateServerRecipe.mockResolvedValueOnce({
      ok: true,
      toolCount: 1,
      tools: ["search_v2"],
      toolCatalog: [{ name: "search_v2", inputSchema: { type: "object" } }],
    });
    await approveResourceMarketRelease({
      listingId: first.listing.id,
      releaseId: second.release.id,
      reviewedById: adminUserId,
    });
    await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId,
      actorId: targetUserId,
      currentReleaseId: first.release.id,
    });
    const updated = await db.deployment.findUniqueOrThrow({
      where: { id: installed.resource.id },
    });
    expect(updated.installCfg).toMatchObject({
      args: ["-y", "@team/mcp@2.0.0"],
      env: { TOKEN: "", EXTRA: "" },
      credentialEnvelope: expect.any(Object),
      toolCatalog: [{ name: "search_v2" }],
    });
    expect(
      resolveMcpEnvironment(updated.installCfg, targetWorkspaceId),
    ).toEqual({ TOKEN: "target-only-secret", EXTRA: "target-extra" });
    expect(JSON.stringify(updated.installCfg)).not.toContain(
      "target-only-secret",
    );
    await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId,
      actorId: targetUserId,
      currentReleaseId: second.release.id,
      targetReleaseId: first.release.id,
    });
    const restored = await db.deployment.findUniqueOrThrow({
      where: { id: installed.resource.id },
    });
    expect(restored).toMatchObject({
      source: "config",
      sourceRef: "npx",
      status: "stopped",
    });
    expect(restored.installCfg).toMatchObject({
      command: "npx",
      args: ["-y", "@team/mcp@1.0.0"],
      env: { TOKEN: "", EXTRA: "" },
      credentialEnvelope: expect.any(Object),
      toolCatalog: [{ name: "search_v1" }],
    });
    expect(
      resolveMcpEnvironment(restored.installCfg, targetWorkspaceId),
    ).toEqual({ TOKEN: "target-only-secret", EXTRA: "target-extra" });
    expect(JSON.stringify(restored.installCfg)).not.toContain(
      "target-only-secret",
    );
    expect(JSON.stringify(restored.installCfg)).not.toContain("search_v2");
    expect(JSON.stringify(restored.installCfg)).not.toContain(
      "source-only-secret",
    );
    expect(
      await db.marketInstall.findUniqueOrThrow({
        where: { id: installed.install.id },
      }),
    ).toMatchObject({
      currentReleaseId: first.release.id,
      requestedReleaseId: first.release.id,
      status: "ready",
    });
    expect(
      await db.marketListing.findUniqueOrThrow({
        where: { id: first.listing.id },
      }),
    ).toMatchObject({ latestReleaseId: second.release.id });
    await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId,
      actorId: targetUserId,
      currentReleaseId: first.release.id,
    });
    expect(
      await db.marketInstall.findUniqueOrThrow({
        where: { id: installed.install.id },
      }),
    ).toMatchObject({ currentReleaseId: second.release.id });
  });

  it("scans decoded base64 files embedded in toolkit skills", async () => {
    const unsafeSkill = await db.installedSkill.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: "Unsafe toolkit skill",
        slug: `unsafe-toolkit-skill-${stamp}`,
        content: "# Safe visible content",
        source: "custom",
        files: [
          {
            path: "secret.bin",
            content: Buffer.from(`sk-proj-${"u".repeat(24)}`).toString(
              "base64",
            ),
            encoding: "base64",
          },
        ],
      },
    });
    const unsafeToolkit = await db.toolkit.create({
      data: {
        workspaceId: sourceWorkspaceId,
        name: "Unsafe toolkit",
        slug: `unsafe-toolkit-${stamp}`,
        skills: { create: { installedSkillId: unsafeSkill.id } },
      },
    });
    await expect(
      cutoverToolkitToPrivatePackage({
        workspaceId: sourceWorkspaceId,
        toolkitId: unsafeToolkit.id,
        userId: sourceUserId,
        mode: "dry-run",
      }),
    ).rejects.toMatchObject({
      code: "invalid_manifest",
    } satisfies Partial<MarketError>);
    expect(
      await db.marketListing.findUnique({
        where: { sourceToolkitId: unsafeToolkit.id },
      }),
    ).toBeNull();
  });
});
