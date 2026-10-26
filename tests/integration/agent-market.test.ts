// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  sealMcpEnvironment,
  resolveMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import type { Prisma } from "@prisma/client";
import { POST as installMarketRelease } from "@/app/api/v1/workspaces/[slug]/market/installs/route";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { approvePendingAgentRelease } from "@/lib/admin/agent-market";
import {
  agentReleaseChecksum,
  assessAgentPortability,
  getAgentMarketListing,
  listAgentMarketListings,
  materializeAgentRelease,
  publishAgentRelease,
  summarizeAgentReleaseManifest,
  withdrawPendingAgentRelease,
  type AgentReleaseManifestV1,
} from "@/lib/agents/market";
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";

const identity = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveAccountRequestUser: async () => identity.user,
}));

const stamp = `${process.pid}-${Date.now()}`;

const SOURCE_PROVIDER_KEY = `source-provider-key-${stamp}`;
const SOURCE_PROVIDER_BASE_URL = `https://source-provider-${stamp}.example.test/v1`;
const TARGET_PROVIDER_KEY = `target-provider-key-${stamp}`;
const DEPLOYMENT_ENV_CANARY = `source-deployment-env-${stamp}`;
const ENCODED_DEPLOYMENT_ENV_CANARY = Buffer.from(
  DEPLOYMENT_ENV_CANARY,
).toString("base64url");
const CHANNEL_CREDENTIAL_CANARY = `source-channel-credential-${stamp}`;
const CHANNEL_TOKEN_CANARY = `source-channel-token-${stamp}`;
const MESSAGE_CANARY = `source-message-${stamp}`;
const ORIGINAL_PROMPT = `Original market prompt ${stamp}`;
const UPDATED_PROMPT = `Updated market prompt ${stamp}`;
const MODEL_ID = `market-model-${stamp}`;
const REQUIRED_ENV = "MARKET_TEST_API_KEY";
const SOURCE_SANDBOX_ENV_CANARY = `source-sandbox-env-${stamp}`;
const SOURCE_SANDBOX_VOLUME_CANARY = `source-sandbox-volume-${stamp}`;

let sourceUserId = "";
let targetUserId = "";
let foreignUserId = "";
let sourceWorkspaceId = "";
let targetWorkspaceId = "";
let foreignWorkspaceId = "";
let sourceAgentId = "";
let sourceProviderId = "";
let catalogServerId = "";
let catalogServerSlug = "";
let sourceDeploymentId = "";
let targetDeploymentId = "";
let sourceCustomSkillId = "";
let sourceToolkitId = "";
let sourceSandboxId = "";
let sourceSandboxDeploymentId = "";
let categoryId = "";
let updateCategoryId = "";
let firstListingId = "";
let firstReleaseId = "";
let firstReleaseManifest: AgentReleaseManifestV1;
let firstReleaseChecksum = "";
let legacyAgentListingId = "";
let invalidRuntimeListingId = "";

function manifestOf(value: unknown): AgentReleaseManifestV1 {
  return value as AgentReleaseManifestV1;
}

async function createAgent(name: string, slug: string) {
  return db.agent.create({
    data: { workspaceId: sourceWorkspaceId, name, slug, runtimeKind: "pi-sdk" },
  });
}

describe.sequential("agent marketplace releases and installs", () => {
  beforeAll(async () => {
    const [sourceUser, targetUser, foreignUser] = await Promise.all([
      db.user.create({
        data: {
          email: `agent-market-source-${stamp}@test.dev`,
          passwordHash: "x",
        },
      }),
      db.user.create({
        data: {
          email: `agent-market-target-${stamp}@test.dev`,
          passwordHash: "x",
        },
      }),
      db.user.create({
        data: {
          email: `agent-market-foreign-${stamp}@test.dev`,
          passwordHash: "x",
        },
      }),
    ]);
    sourceUserId = sourceUser.id;
    targetUserId = targetUser.id;
    foreignUserId = foreignUser.id;
    identity.user = targetUser;

    const [sourceWorkspace, targetWorkspace, foreignWorkspace] =
      await Promise.all([
        db.workspace.create({
          data: {
            slug: `agent-market-source-${stamp}`,
            name: "Agent Market Source",
            ownerId: sourceUser.id,
            members: { create: { userId: sourceUser.id, role: "owner" } },
          },
        }),
        db.workspace.create({
          data: {
            slug: `agent-market-target-${stamp}`,
            name: "Agent Market Target",
            ownerId: targetUser.id,
            members: { create: { userId: targetUser.id, role: "owner" } },
          },
        }),
        db.workspace.create({
          data: {
            slug: `agent-market-foreign-${stamp}`,
            name: "Agent Market Foreign",
            ownerId: foreignUser.id,
            members: { create: { userId: foreignUser.id, role: "owner" } },
          },
        }),
      ]);
    sourceWorkspaceId = sourceWorkspace.id;
    targetWorkspaceId = targetWorkspace.id;
    foreignWorkspaceId = foreignWorkspace.id;
    const [category, updateCategory] = await Promise.all([
      db.category.create({
        data: { slug: `agent-market-${stamp}`, name: `Agent Market ${stamp}` },
      }),
      db.category.create({
        data: {
          slug: `agent-market-update-${stamp}`,
          name: `Agent Market Update ${stamp}`,
        },
      }),
    ]);
    categoryId = category.id;
    updateCategoryId = updateCategory.id;

    const [sourceProvider] = await Promise.all([
      db.modelProvider.create({
        data: {
          workspaceId: sourceWorkspace.id,
          name: "Source OpenAI",
          format: "openai",
          baseUrl: SOURCE_PROVIDER_BASE_URL,
          apiKey: SOURCE_PROVIDER_KEY,
          models: [MODEL_ID],
        },
      }),
      db.modelProvider.create({
        data: {
          workspaceId: targetWorkspace.id,
          name: "Target OpenAI",
          format: "openai",
          baseUrl: "https://target-provider.example.test/v1",
          apiKey: TARGET_PROVIDER_KEY,
          models: [MODEL_ID],
        },
      }),
    ]);
    sourceProviderId = sourceProvider.id;

    catalogServerSlug = `agent-market-catalog-${stamp}`;
    const catalogServer = await db.server.create({
      data: {
        slug: catalogServerSlug,
        name: "Portable Catalog MCP",
        verifiedAt: new Date(),
        installCfg: {
          source: "npm",
          ref: "@modelcontextprotocol/server-memory",
          env: [REQUIRED_ENV],
          envValues: { MARKET_PUBLIC_MODE: "1" },
          toolCatalog: [{ name: "read_graph" }],
        },
      },
    });
    catalogServerId = catalogServer.id;

    const sourceDeployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspace.id,
        serverId: catalogServer.id,
        status: "running",
        source: "npm",
        sourceRef: "@modelcontextprotocol/server-memory",
        installCfg: sealMcpEnvironment({}, sourceWorkspace.id, {
          [REQUIRED_ENV]: DEPLOYMENT_ENV_CANARY,
          MARKET_PUBLIC_MODE: "source-overridden",
        }) as Prisma.InputJsonObject,
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["read_graph", ENCODED_DEPLOYMENT_ENV_CANARY],
      },
    });
    sourceDeploymentId = sourceDeployment.id;
    const targetDeployment = await db.deployment.create({
      data: {
        workspaceId: targetWorkspace.id,
        serverId: catalogServer.id,
        status: "stopped",
        source: "npm",
        sourceRef: "outdated-market-fixture",
        installCfg: sealMcpEnvironment({}, targetWorkspace.id, {
          [REQUIRED_ENV]: "",
          STALE_PUBLIC_VALUE: "remove-me",
        }) as Prisma.InputJsonObject,
        mcpToolExposure: "all",
        mcpAllowedTools: [],
      },
    });
    targetDeploymentId = targetDeployment.id;

    const customSkill = await db.installedSkill.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: "Private Research Skill",
        slug: `private-research-${stamp}`,
        description:
          "A custom skill that should be copied from its release snapshot.",
        content: "# Private Research\n\nUse the bundled reference.",
        files: [
          { path: "references/guide.md", content: `release-one-${stamp}` },
        ],
        source: "custom",
        userInvocable: false,
        agentInvocable: true,
        effort: "high",
      },
    });
    sourceCustomSkillId = customSkill.id;

    const sourceToolkit = await db.toolkit.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: "Research Toolkit",
        slug: `research-toolkit-${stamp}`,
        visibility: "public",
        enabled: true,
        servers: { create: { deploymentId: sourceDeployment.id } },
        skills: { create: { installedSkillId: customSkill.id } },
      },
    });
    sourceToolkitId = sourceToolkit.id;

    const sourceAgent = await db.agent.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: "Portable Research Agent",
        slug: `portable-research-${stamp}`,
        runtimeKind: "pi-sdk",
        systemPrompt: ORIGINAL_PROMPT,
        providerId: sourceProvider.id,
        model: MODEL_ID,
        maxSteps: 17,
        servers: { create: { deploymentId: sourceDeployment.id } },
        skills: { create: { installedSkillId: customSkill.id } },
        toolkits: { create: { toolkitId: sourceToolkit.id } },
      },
    });
    sourceAgentId = sourceAgent.id;

    const sourceSandboxDeployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspace.id,
        name: "Portable Research Agent sandbox",
        source: "sandbox",
        sourceRef: "alpine:3.20",
        status: "stopped",
      },
    });
    sourceSandboxDeploymentId = sourceSandboxDeployment.id;
    const sourceSandbox = await db.sandbox.create({
      data: {
        workspaceId: sourceWorkspace.id,
        deploymentId: sourceSandboxDeployment.id,
        name: "Portable Research Agent Workspace",
        slug: `portable-research-workspace-${stamp}`,
        kind: "docker",
        image: "alpine:3.20",
        network: "isolated",
        config: {
          env: { SOURCE_SANDBOX_SECRET: SOURCE_SANDBOX_ENV_CANARY },
          allowSudo: true,
        },
      },
    });
    sourceSandboxId = sourceSandbox.id;
    await Promise.all([
      db.deployment.update({
        where: { id: sourceSandboxDeployment.id },
        data: {
          installCfg: {
            sandboxId: sourceSandbox.id,
            kind: "docker",
            image: sourceSandbox.image,
            network: sourceSandbox.network,
            volumeName: SOURCE_SANDBOX_VOLUME_CANARY,
            env: { SOURCE_SANDBOX_SECRET: SOURCE_SANDBOX_ENV_CANARY },
            allowSudo: true,
          },
        },
      }),
      db.agentSandbox.create({
        data: {
          agentId: sourceAgent.id,
          sandboxId: sourceSandbox.id,
          isDefault: true,
        },
      }),
    ]);

    const conversation = await db.conversation.create({
      data: { agentId: sourceAgent.id, title: "Private market conversation" },
    });
    await Promise.all([
      db.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          parts: [{ type: "text", text: MESSAGE_CANARY }],
        },
      }),
      db.agentChannelConnection.create({
        data: {
          workspaceId: sourceWorkspace.id,
          agentId: sourceAgent.id,
          platform: "telegram",
          name: "Private Telegram",
          credentials: { encrypted: CHANNEL_CREDENTIAL_CANARY },
          inboundTokenHash: `agent-market-hash-${stamp}`,
          inboundTokenSecret: { encrypted: CHANNEL_TOKEN_CANARY },
          inboundTokenPrefix: `tpchan_${stamp}`,
        },
      }),
    ]);

    const published = await publishAgentRelease({
      workspaceId: sourceWorkspace.id,
      agentId: sourceAgent.id,
      publishedById: sourceUser.id,
      listing: {
        name: "Portable Research Agent",
        summary: "A safe immutable marketplace release.",
        tags: ["research", "portable"],
        categoryIds: [categoryId],
      },
    });
    firstListingId = published.listing.id;
    firstReleaseId = published.release.id;
    firstReleaseManifest = manifestOf(published.release.manifest);
    firstReleaseChecksum = published.release.checksum;
  });

  afterAll(async () => {
    if (sourceWorkspaceId || targetWorkspaceId || foreignWorkspaceId) {
      await db.workspace.deleteMany({
        where: {
          id: {
            in: [
              sourceWorkspaceId,
              targetWorkspaceId,
              foreignWorkspaceId,
            ].filter(Boolean),
          },
        },
      });
    }
    await db.agentListing.deleteMany({
      where: {
        id: {
          in: [
            firstListingId,
            legacyAgentListingId,
            invalidRuntimeListingId,
          ].filter(Boolean),
        },
      },
    });
    if (sourceUserId || targetUserId || foreignUserId) {
      await db.user.deleteMany({
        where: {
          id: {
            in: [sourceUserId, targetUserId, foreignUserId].filter(Boolean),
          },
        },
      });
    }
    if (catalogServerId)
      await db.server.deleteMany({ where: { id: catalogServerId } });
    if (categoryId || updateCategoryId) {
      await db.category.deleteMany({
        where: { id: { in: [categoryId, updateCategoryId].filter(Boolean) } },
      });
    }
    await db.$disconnect();
  });

  it("submits a secret-free release and keeps it unavailable until an administrator approves it", async () => {
    const serialized = JSON.stringify(firstReleaseManifest);

    const pendingListing = await db.agentListing.findFirstOrThrow({
      where: { sourceAgentId },
      select: {
        id: true,
        status: true,
        latestReleaseId: true,
        pendingReleaseId: true,
        categories: { select: { id: true } },
      },
    });
    expect(pendingListing).toMatchObject({
      status: "draft",
      latestReleaseId: null,
      pendingReleaseId: firstReleaseId,
      categories: [],
    });
    await expect(
      materializeAgentRelease({
        releaseId: firstReleaseId,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `unapproved-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: "listing_unavailable" });

    for (const secret of [
      SOURCE_PROVIDER_KEY,
      SOURCE_PROVIDER_BASE_URL,
      DEPLOYMENT_ENV_CANARY,
      CHANNEL_CREDENTIAL_CANARY,
      CHANNEL_TOKEN_CANARY,
      MESSAGE_CANARY,
      SOURCE_SANDBOX_ENV_CANARY,
      SOURCE_SANDBOX_VOLUME_CANARY,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(firstReleaseManifest).toMatchObject({
      schemaVersion: 1,
      rootAgentKey: "agent_1",
      agents: [
        expect.objectContaining({
          name: "Portable Research Agent",
          systemPrompt: ORIGINAL_PROMPT,
          maxSteps: 17,
          modelRequirement: { format: "openai", model: MODEL_ID },
          runtime: { kind: "pi" },
        }),
      ],
      deployments: [
        expect.objectContaining({
          catalogSlug: catalogServerSlug,
          requiredEnv: [REQUIRED_ENV],
          publicEnv: { MARKET_PUBLIC_MODE: "1" },
          mcpToolExposure: "allowlist",
          mcpAllowedTools: ["read_graph"],
        }),
      ],
      skills: [
        expect.objectContaining({
          origin: "custom",
          name: "Private Research Skill",
          userInvocable: false,
          agentInvocable: true,
          effort: "high",
        }),
      ],
      toolkits: [],
    });
    expect(firstReleaseManifest.agents[0].runtime).toEqual({ kind: "pi" });
    expect(firstReleaseManifest.agents[0].toolkitKeys).toEqual([]);
    expect(firstReleaseManifest.agents[0].deploymentKeys).toEqual(
      firstReleaseManifest.deployments.map(({ key }) => key),
    );
    expect(firstReleaseManifest.agents[0].skillKeys).toEqual(
      firstReleaseManifest.skills.map(({ key }) => key),
    );
    expect(serialized).not.toContain(sourceProviderId);
    expect(serialized).not.toContain(sourceDeploymentId);
    expect(serialized).not.toContain(ENCODED_DEPLOYMENT_ENV_CANARY);
    expect(serialized).not.toContain(sourceCustomSkillId);
    expect(serialized).not.toContain(sourceToolkitId);
    expect(serialized).not.toContain(sourceSandboxId);
    expect(serialized).not.toContain(sourceSandboxDeploymentId);

    await approvePendingAgentRelease({
      listingId: pendingListing.id,
      releaseId: firstReleaseId,
      reviewedById: sourceUserId,
      reviewNote: "Approved by the integration test administrator.",
    });
    await expect(
      db.agentRelease.findUniqueOrThrow({ where: { id: firstReleaseId } }),
    ).resolves.toMatchObject({
      reviewStatus: "approved",
      reviewedById: sourceUserId,
      categoryIds: [categoryId],
    });
    await expect(
      db.agentListing.findUniqueOrThrow({
        where: { id: pendingListing.id },
        select: { categories: { select: { id: true } } },
      }),
    ).resolves.toEqual({ categories: [{ id: categoryId }] });
  });

  it("rejects a publisher release whose system prompt contains a credential", async () => {
    await expect(
      publishAgentRelease({
        workspaceId: sourceWorkspaceId,
        agentId: sourceAgentId,
        publishedById: sourceUserId,
        listing: { name: "Uncategorized release", summary: "Must be blocked." },
      }),
    ).rejects.toMatchObject({ code: "invalid_categories" });

    const secret = `sk-proj-${"z".repeat(24)}`;
    await db.agent.update({
      where: { id: sourceAgentId },
      data: { systemPrompt: `Never publish ${secret}` },
    });
    await expect(
      publishAgentRelease({
        workspaceId: sourceWorkspaceId,
        agentId: sourceAgentId,
        publishedById: sourceUserId,
        listing: {
          name: "Unsafe release",
          summary: "Must be blocked.",
          categoryIds: [categoryId],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    await db.agent.update({
      where: { id: sourceAgentId },
      data: { systemPrompt: ORIGINAL_PROMPT },
    });
    await expect(
      db.agentListing.findUniqueOrThrow({ where: { id: firstListingId } }),
    ).resolves.toMatchObject({
      pendingReleaseId: null,
      latestReleaseId: firstReleaseId,
    });
  });

  it("keeps an old release immutable after the source agent and dependencies change", async () => {
    const originalManifest = JSON.stringify(firstReleaseManifest);

    await Promise.all([
      db.agent.update({
        where: { id: sourceAgentId },
        data: { systemPrompt: UPDATED_PROMPT, maxSteps: 29 },
      }),
      db.deployment.update({
        where: { id: sourceDeploymentId },
        data: {
          installCfg: sealMcpEnvironment({}, sourceWorkspaceId, {
            [REQUIRED_ENV]: `updated-${DEPLOYMENT_ENV_CANARY}`,
          }) as Prisma.InputJsonObject,
        },
      }),
      db.installedSkill.update({
        where: { id: sourceCustomSkillId },
        data: {
          content: "# Updated after release",
          files: [
            { path: "references/guide.md", content: `release-two-${stamp}` },
          ],
        },
      }),
    ]);

    const second = await publishAgentRelease({
      workspaceId: sourceWorkspaceId,
      agentId: sourceAgentId,
      publishedById: sourceUserId,
      listing: {
        slug: `pending-rename-${stamp}`,
        name: "Pending Rename",
        summary: "Pending summary",
        iconUrl: "https://example.test/pending.png",
        tags: ["pending"],
        categoryIds: [updateCategoryId],
      },
    });
    const rereadFirst = await db.agentRelease.findUniqueOrThrow({
      where: { id: firstReleaseId },
    });

    expect(rereadFirst.version).toBe(1);
    expect(rereadFirst.checksum).toBe(firstReleaseChecksum);
    expect(JSON.stringify(rereadFirst.manifest)).toBe(originalManifest);
    expect(second.release.version).toBe(2);
    expect(second.release.reviewStatus).toBe("pending");
    expect(manifestOf(second.release.manifest).agents[0]).toMatchObject({
      systemPrompt: UPDATED_PROMPT,
      maxSteps: 29,
    });
    await expect(
      db.agentListing.findFirstOrThrow({
        where: { sourceAgentId },
        select: {
          publisherKind: true,
          slug: true,
          name: true,
          author: true,
          summary: true,
          iconUrl: true,
          tags: true,
          status: true,
          latestReleaseId: true,
          pendingReleaseId: true,
          categories: { select: { id: true } },
        },
      }),
    ).resolves.toEqual({
      publisherKind: "workspace",
      slug: `portable-research-${stamp}`,
      name: "Portable Research Agent",
      author: "Agent Market Source",
      summary: "A safe immutable marketplace release.",
      iconUrl: null,
      tags: ["research", "portable"],
      status: "published",
      latestReleaseId: firstReleaseId,
      pendingReleaseId: second.release.id,
      categories: [{ id: categoryId }],
    });
    expect(second.release.categoryIds).toEqual([updateCategoryId]);
  });

  it("withdraws a pending update without taking the approved version offline", async () => {
    const before = await db.agentListing.findFirstOrThrow({
      where: { sourceAgentId },
      select: { id: true, latestReleaseId: true, pendingReleaseId: true },
    });
    expect(before.pendingReleaseId).toBeTruthy();

    await withdrawPendingAgentRelease({
      workspaceId: sourceWorkspaceId,
      agentId: sourceAgentId,
      actorId: sourceUserId,
    });

    await expect(
      db.agentListing.findUniqueOrThrow({ where: { id: before.id } }),
    ).resolves.toMatchObject({
      status: "published",
      latestReleaseId: firstReleaseId,
      pendingReleaseId: null,
    });
    await expect(
      db.agentRelease.findUniqueOrThrow({
        where: { id: assertDefined(before.pendingReleaseId) },
      }),
    ).resolves.toMatchObject({ reviewStatus: "rejected" });
  });

  it("materializes an isolated target graph and reuses the install for the same idempotency key", async () => {
    const idempotencyKey = `agent-market-install-${stamp}`;
    const first = await materializeAgentRelease({
      releaseId: firstReleaseId,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey,
      name: "Installed Research Agent",
    });
    const countsAfterFirst = await Promise.all([
      db.agent.count({ where: { workspaceId: targetWorkspaceId } }),
      db.deployment.count({ where: { workspaceId: targetWorkspaceId } }),
      db.installedSkill.count({ where: { workspaceId: targetWorkspaceId } }),
      db.toolkit.count({ where: { workspaceId: targetWorkspaceId } }),
    ]);

    const second = await materializeAgentRelease({
      releaseId: firstReleaseId,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey,
      name: "A retry must not rename the installed agent",
    });
    const countsAfterSecond = await Promise.all([
      db.agent.count({ where: { workspaceId: targetWorkspaceId } }),
      db.deployment.count({ where: { workspaceId: targetWorkspaceId } }),
      db.installedSkill.count({ where: { workspaceId: targetWorkspaceId } }),
      db.toolkit.count({ where: { workspaceId: targetWorkspaceId } }),
    ]);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.install.id).toBe(first.install.id);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.resourceMap).toEqual(first.resourceMap);
    expect(countsAfterSecond).toEqual(countsAfterFirst);
    await expect(
      db.agentInstall.count({
        where: { targetWorkspaceId, idempotencyKey },
      }),
    ).resolves.toBe(1);

    expect(first.install.status).toBe("needs_setup");
    expect(first.requirements.providers).toEqual([
      expect.objectContaining({
        format: "openai",
        model: MODEL_ID,
        satisfied: false,
      }),
    ]);
    expect(first.requirements.environment).toEqual([
      expect.objectContaining({ variable: REQUIRED_ENV, required: true }),
    ]);

    const installedAgent = await db.agent.findUniqueOrThrow({
      where: { id: first.agent.id },
      include: {
        provider: true,
        subAgents: true,
        servers: { include: { deployment: true } },
        skills: { include: { installedSkill: true } },
        toolkits: {
          include: {
            toolkit: {
              include: {
                servers: { include: { deployment: true } },
                skills: { include: { installedSkill: true } },
              },
            },
          },
        },
        conversations: true,
        channels: true,
        sandboxes: { include: { sandbox: { include: { deployment: true } } } },
      },
    });

    expect(installedAgent).toMatchObject({
      workspaceId: targetWorkspaceId,
      name: "Installed Research Agent",
      runtimeKind: "pi-sdk",
      currentRevisionVersion: 0,
      systemPrompt: ORIGINAL_PROMPT,
      providerId: null,
      model: null,
      maxSteps: 17,
    });
    expect(installedAgent.provider).toBeNull();
    expect(installedAgent.subAgents).toEqual([]);
    expect(installedAgent.a2aInboundEnabled).toBe(false);
    expect(installedAgent.a2aOutboundEnabled).toBe(false);
    expect(installedAgent.conversations).toHaveLength(0);
    expect(installedAgent.channels).toHaveLength(0);

    expect(installedAgent.sandboxes).toHaveLength(1);
    const installedSandboxLink = installedAgent.sandboxes[0];
    expect(installedSandboxLink.isDefault).toBe(true);
    expect(installedSandboxLink.sandbox).toMatchObject({
      workspaceId: targetWorkspaceId,
      kind: "docker",
      image: DEFAULT_SANDBOX_IMAGE,
      network: "isolated",
      config: {},
    });
    expect(installedSandboxLink.sandbox.id).not.toBe(sourceSandboxId);
    expect(installedSandboxLink.sandbox.deploymentId).not.toBe(
      sourceSandboxDeploymentId,
    );
    expect(installedSandboxLink.sandbox.deployment).toMatchObject({
      workspaceId: targetWorkspaceId,
      serverId: null,
      source: "sandbox",
      sourceRef: DEFAULT_SANDBOX_IMAGE,
      status: "stopped",
    });
    expect(installedSandboxLink.sandbox.deployment.installCfg).toEqual({
      sandboxId: installedSandboxLink.sandbox.id,
      kind: "docker",
      image: DEFAULT_SANDBOX_IMAGE,
      network: "isolated",
      volumeName: sandboxVolumeName(installedSandboxLink.sandbox.id),
      env: {},
      allowSudo: false,
    });

    expect(installedAgent.servers).toEqual([]);
    const installedDeployment = await db.deployment.findUniqueOrThrow({
      where: {
        id: assertDefined(Object.values(first.resourceMap.deployments)[0]),
      },
    });
    expect(installedDeployment).toMatchObject({
      workspaceId: targetWorkspaceId,
      serverId: null,
      status: "stopped",
      source: "npm",
      sourceRef: "@modelcontextprotocol/server-memory",
      mcpToolExposure: "allowlist",
      mcpAllowedTools: [],
    });
    expect(installedDeployment.id).not.toBe(sourceDeploymentId);
    expect(installedDeployment.id).not.toBe(targetDeploymentId);
    expect(installedDeployment.installCfg).toMatchObject({
      env: { MARKET_PUBLIC_MODE: "", [REQUIRED_ENV]: "" },
      credentialEnvelope: expect.any(Object),
    });
    expect(
      resolveMcpEnvironment(installedDeployment.installCfg, targetWorkspaceId),
    ).toEqual({ MARKET_PUBLIC_MODE: "1", [REQUIRED_ENV]: "" });
    expect(JSON.stringify(installedDeployment.installCfg)).not.toContain(
      DEPLOYMENT_ENV_CANARY,
    );
    await expect(
      db.deployment.findUniqueOrThrow({ where: { id: targetDeploymentId } }),
    ).resolves.toMatchObject({
      sourceRef: "outdated-market-fixture",
      mcpToolExposure: "all",
      installCfg: expect.objectContaining({
        env: { [REQUIRED_ENV]: "", STALE_PUBLIC_VALUE: "" },
        credentialEnvelope: expect.any(Object),
      }),
    });
    const untouchedTarget = await db.deployment.findUniqueOrThrow({
      where: { id: targetDeploymentId },
    });
    expect(
      resolveMcpEnvironment(untouchedTarget.installCfg, targetWorkspaceId),
    ).toEqual({ [REQUIRED_ENV]: "", STALE_PUBLIC_VALUE: "remove-me" });

    expect(installedAgent.skills).toEqual([]);
    const installedSkill = await db.installedSkill.findUniqueOrThrow({
      where: { id: assertDefined(Object.values(first.resourceMap.skills)[0]) },
    });
    const releasedSkill = firstReleaseManifest.skills[0];
    expect(installedSkill.workspaceId).toBe(targetWorkspaceId);
    expect(installedSkill.id).not.toBe(sourceCustomSkillId);
    expect(installedSkill.skillId).toBeNull();
    expect(installedSkill.source).toBe("agent-market");
    expect(installedSkill.content).toBe(releasedSkill.content);
    expect(installedSkill.files).toEqual(releasedSkill.files);

    expect(installedAgent.toolkits).toEqual([]);
    expect(first.requirements.legacyToolkitConversions).toEqual([]);

    expect(first.resourceMap.agents[firstReleaseManifest.rootAgentKey]).toBe(
      installedAgent.id,
    );
    expect(Object.values(first.resourceMap.deployments)).toEqual([
      installedDeployment.id,
    ]);
    expect(Object.values(first.resourceMap.skills)).toEqual([
      installedSkill.id,
    ]);
    expect(first.resourceMap.toolkits).toEqual({});

    const serializedTargetGraph = JSON.stringify(installedAgent);
    for (const sourceId of [
      sourceAgentId,
      sourceProviderId,
      sourceDeploymentId,
      sourceCustomSkillId,
      sourceToolkitId,
      sourceSandboxId,
      sourceSandboxDeploymentId,
      SOURCE_SANDBOX_ENV_CANARY,
      SOURCE_SANDBOX_VOLUME_CANARY,
    ]) {
      expect(serializedTargetGraph).not.toContain(sourceId);
    }

    const listing = await db.agentListing.findFirstOrThrow({
      where: { sourceAgentId },
      select: { installCount: true },
    });
    expect(listing.installCount).toBe(1);
  });

  it("rejects unsafe resources and invalid runtime sandbox assignments", async () => {
    const [
      customAgent,
      unsupportedRuntimeAgent,
      sandboxAgent,
      missingSandboxAgent,
      foreignAgent,
    ] = await Promise.all([
      createAgent("Custom MCP Agent", `custom-mcp-${stamp}`),
      db.agent.create({
        data: {
          workspaceId: sourceWorkspaceId,
          name: "Non-portable Runtime Agent",
          slug: `non-portable-runtime-${stamp}`,
          runtimeKind: "claude-code",
        },
      }),
      createAgent("Sandbox Agent", `sandbox-${stamp}`),
      createAgent("Missing Sandbox Agent", `missing-sandbox-${stamp}`),
      createAgent("Foreign Link Agent", `foreign-link-${stamp}`),
    ]);

    const [customDeployment, sandboxDeployment, foreignDeployment] =
      await Promise.all([
        db.deployment.create({
          data: {
            workspaceId: sourceWorkspaceId,
            name: "Custom private MCP",
            source: "npm",
            sourceRef: "private-mcp",
            status: "stopped",
            installCfg: { env: { SECRET: `custom-mcp-secret-${stamp}` } },
          },
        }),
        db.deployment.create({
          data: {
            workspaceId: sourceWorkspaceId,
            name: "Attached sandbox deployment",
            source: "sandbox",
            status: "stopped",
          },
        }),
        db.deployment.create({
          data: {
            workspaceId: foreignWorkspaceId,
            name: "Foreign deployment",
            source: "npm",
            sourceRef: "foreign-mcp",
            status: "stopped",
          },
        }),
      ]);

    const attachedSandbox = await db.sandbox.create({
      data: {
        workspaceId: sourceWorkspaceId,
        deploymentId: sandboxDeployment.id,
        name: "Attached sandbox",
        slug: `attached-sandbox-${stamp}`,
        kind: "docker",
        image: "alpine:3.20",
        network: "none",
      },
    });

    await Promise.all([
      db.agentServer.create({
        data: { agentId: customAgent.id, deploymentId: customDeployment.id },
      }),
      db.agentSandbox.create({
        data: {
          agentId: sandboxAgent.id,
          sandboxId: attachedSandbox.id,
          isDefault: true,
        },
      }),
      db.agentServer.create({
        data: { agentId: foreignAgent.id, deploymentId: foreignDeployment.id },
      }),
    ]);

    const [custom, unsupportedRuntime, sandbox, missingSandbox, foreign] =
      await Promise.all([
        assessAgentPortability({
          workspaceId: sourceWorkspaceId,
          agentId: customAgent.id,
        }),
        assessAgentPortability({
          workspaceId: sourceWorkspaceId,
          agentId: unsupportedRuntimeAgent.id,
        }),
        assessAgentPortability({
          workspaceId: sourceWorkspaceId,
          agentId: sandboxAgent.id,
        }),
        assessAgentPortability({
          workspaceId: sourceWorkspaceId,
          agentId: missingSandboxAgent.id,
        }),
        assessAgentPortability({
          workspaceId: sourceWorkspaceId,
          agentId: foreignAgent.id,
        }),
      ]);

    expect(custom).toMatchObject({ portable: false });
    expect(unsupportedRuntime).toMatchObject({ portable: false });
    expect(sandbox).toMatchObject({ portable: false });
    expect(missingSandbox).toMatchObject({ portable: false });
    expect(foreign).toMatchObject({ portable: false });
    if (
      custom.portable ||
      unsupportedRuntime.portable ||
      sandbox.portable ||
      missingSandbox.portable ||
      foreign.portable
    ) {
      throw new Error(
        "Expected every unsafe agent fixture to be non-portable.",
      );
    }
    expect(custom.issues.map(({ code }) => code)).toContain("custom_mcp");
    expect(unsupportedRuntime.issues.map(({ code }) => code)).toContain(
      "unsupported_runtime",
    );
    expect(sandbox.issues.map(({ code }) => code)).toContain(
      "invalid_definition",
    );
    expect(missingSandbox.issues.map(({ code }) => code)).toContain(
      "invalid_definition",
    );
    expect(foreign.issues.map(({ code }) => code)).toContain(
      "cross_workspace_deployment",
    );
  });

  it("rejects removed and unknown runtimes through the marketplace install API", async () => {
    const listing = await db.agentListing.create({
      data: {
        publisherKind: "platform",
        slug: `invalid-runtime-${stamp}`.slice(0, 120),
        directorySlug: `invalid-runtime-directory-${stamp}`.slice(0, 120),
        name: "Invalid runtime admission",
        status: "draft",
        curated: true,
      },
    });
    invalidRuntimeListingId = listing.id;
    const slug = `agent-market-target-${stamp}`;
    for (const [index, kind] of ["hermes", "unknown"].entries()) {
      const manifest = {
        ...firstReleaseManifest,
        agents: firstReleaseManifest.agents.map((agent) => ({
          ...agent,
          runtime: { kind },
        })),
      };
      const release = await db.agentRelease.create({
        data: {
          listingId: listing.id,
          version: index + 1,
          manifestVersion: 1,
          manifest,
          releaseSummary: summarizeAgentReleaseManifest(firstReleaseManifest),
          checksum: marketReleaseChecksum(manifest),
          name: listing.name,
          tags: [],
          reviewStatus: "approved",
        },
      });
      await db.agentListing.update({
        where: { id: listing.id },
        data: {
          status: "published",
          latestVersion: index + 1,
          latestReleaseId: release.id,
          publishedAt: new Date(),
        },
      });
      const idempotencyKey = `invalid-runtime-${kind}-${stamp}`;
      const response = await installMarketRelease(
        new Request(
          `http://localhost/api/v1/workspaces/${slug}/market/installs`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ releaseId: release.id, idempotencyKey }),
          },
        ),
        { params: Promise.resolve({ slug }) },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "invalid_manifest" });
      expect(
        await db.agentInstall.findUnique({
          where: {
            targetWorkspaceId_idempotencyKey: {
              targetWorkspaceId,
              idempotencyKey,
            },
          },
        }),
      ).toBeNull();
    }
  });

  it("projects legacy agent MCP allowlists through current verified catalogs", async () => {
    const canary = `credential-${stamp}`;
    const suffix = `legacy-${stamp}`.slice(-40);
    const legacyManifest: AgentReleaseManifestV1 = {
      ...firstReleaseManifest,
      agents: firstReleaseManifest.agents.map((agent) => ({
        ...agent,
        name: `${agent.name} legacy`,
        slug: `${agent.slug}-${suffix}`.slice(0, 120),
      })),
      deployments: firstReleaseManifest.deployments.map((deployment) => ({
        ...deployment,
        mcpAllowedTools: ["read_graph", canary],
      })),
      skills: firstReleaseManifest.skills.map((skill) => ({
        ...skill,
        slug: `${skill.slug}-${suffix}`.slice(0, 120),
      })),
      toolkits: firstReleaseManifest.toolkits.map((toolkit) => ({
        ...toolkit,
        slug: `${toolkit.slug}-${suffix}`.slice(0, 120),
      })),
    };
    const listing = await db.agentListing.create({
      data: {
        publisherKind: "platform",
        slug: `legacy-agent-${stamp}`.slice(0, 120),
        directorySlug: `legacy-agent-directory-${stamp}`.slice(0, 120),
        name: "Legacy agent allowlist",
        status: "draft",
        curated: true,
      },
    });
    legacyAgentListingId = listing.id;
    const release = await db.agentRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifestVersion: 1,
        manifest: legacyManifest,
        releaseSummary: summarizeAgentReleaseManifest(legacyManifest),
        checksum: agentReleaseChecksum(legacyManifest),
        name: listing.name,
        tags: [],
        reviewStatus: "approved",
      },
    });
    await db.agentListing.update({
      where: { id: listing.id },
      data: {
        status: "published",
        latestVersion: 1,
        latestReleaseId: release.id,
        publishedAt: new Date(),
      },
    });

    const detail = await getAgentMarketListing(listing.id);
    expect(detail?.manifest.deployments[0].mcpAllowedTools).toEqual([
      "read_graph",
    ]);
    expect(detail?.release.checksum).toBe(
      agentReleaseChecksum(assertDefined(detail).manifest),
    );
    expect(JSON.stringify(detail)).not.toContain(canary);

    const installed = await materializeAgentRelease({
      releaseId: release.id,
      targetWorkspaceId,
      installedById: targetUserId,
      idempotencyKey: `legacy-agent-${stamp}`,
      name: "Installed legacy-safe agent",
    });
    const deploymentId = Object.values(installed.resourceMap.deployments)[0];
    const deployment = await db.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
    });
    expect(deployment.mcpAllowedTools).toEqual([]);
    await expect(
      db.agentServer.count({ where: { agentId: installed.agent.id } }),
    ).resolves.toBe(0);
    expect(JSON.stringify(deployment)).not.toContain(canary);
  });

  it("keeps a workspace listing private after deleting its publisher clears every origin relation", async () => {
    await expect(getAgentMarketListing(firstListingId)).resolves.not.toBeNull();

    await db.user.delete({ where: { id: sourceUserId } });

    await expect(
      db.agentListing.findUniqueOrThrow({
        where: { id: firstListingId },
        select: {
          publisherKind: true,
          publisherWorkspaceId: true,
          sourceAgentId: true,
          publishedById: true,
        },
      }),
    ).resolves.toEqual({
      publisherKind: "workspace",
      publisherWorkspaceId: null,
      sourceAgentId: null,
      publishedById: null,
    });

    const [detail, listings] = await Promise.all([
      getAgentMarketListing(firstListingId),
      listAgentMarketListings({ q: `portable-research-${stamp}` }),
    ]);
    expect(detail).toBeNull();
    expect(listings.items.map(({ id }) => id)).not.toContain(firstListingId);
    await expect(
      materializeAgentRelease({
        releaseId: firstReleaseId,
        targetWorkspaceId,
        installedById: targetUserId,
        idempotencyKey: `orphan-release-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: "listing_unavailable" });
  });
});
