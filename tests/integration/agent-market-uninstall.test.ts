// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  AGENT_MARKET_MANIFEST_VERSION,
  agentReleaseChecksum,
  materializeAgentRelease,
  summarizeAgentReleaseManifest,
  type AgentReleaseManifestV1,
} from '@/lib/agents/market';
import { deleteManagedAgent } from '@/lib/agents/deletion';

const stamp = `${process.pid}-${Date.now()}`;
let userId = '';
let workspaceId = '';
let listingId = '';
let releaseId = '';
let categoryId = '';

function agent(key: string, resources: string) {
  return {
    key,
    name: key,
    slug: key,
    systemPrompt: null,
    maxSteps: 8,
    modelRequirement: null,
    runtime: { kind: 'pi' as const },
    deploymentKeys: [`deployment_${resources}`],
    skillKeys: [`skill_${resources}`],
    toolkitKeys: [`toolkit_${resources}`],
    subAgentKeys: key === 'root' ? ['child'] : [],
  };
}

function deployment(key: string) {
  return {
    key: `deployment_${key}`,
    name: `Deployment ${key}`,
    catalogSlug: `deployment-${key}`,
    source: 'npm' as const,
    sourceRef: `package-${key}`,
    requiredEnv: [],
    publicEnv: {},
    mcpToolExposure: 'all' as const,
    mcpAllowedTools: [],
  };
}

function skill(key: string) {
  return {
    key: `skill_${key}`,
    origin: 'custom' as const,
    name: `Skill ${key}`,
    slug: `skill-${key}`,
    description: null,
    content: `# Skill ${key}`,
    files: [],
    userInvocable: true,
    agentInvocable: true,
    effort: 'default',
  };
}

function toolkit(key: string) {
  return {
    key: `toolkit_${key}`,
    name: `Toolkit ${key}`,
    slug: `toolkit-${key}`,
    enabled: true,
    deploymentKeys: [`deployment_${key}`],
    skillKeys: [`skill_${key}`],
  };
}

describe.sequential('agent market uninstall', () => {
  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `agent-uninstall-${stamp}@test.dev`, passwordHash: 'x' },
    });
    userId = user.id;
    const [workspace, category] = await Promise.all([
      db.workspace.create({
        data: { slug: `agent-uninstall-${stamp}`, name: 'Agent uninstall', ownerId: user.id },
      }),
      db.category.create({
        data: { slug: `agent-uninstall-${stamp}`, name: `Agent uninstall ${stamp}` },
      }),
    ]);
    workspaceId = workspace.id;
    categoryId = category.id;

    const manifest: AgentReleaseManifestV1 = {
      schemaVersion: AGENT_MARKET_MANIFEST_VERSION,
      rootAgentKey: 'root',
      agents: [agent('root', 'private'), agent('child', 'shared')],
      deployments: [deployment('private'), deployment('shared')],
      skills: [skill('private'), skill('shared')],
      toolkits: [toolkit('private'), toolkit('shared')],
    };
    const listing = await db.agentListing.create({
      data: {
        publisherKind: 'platform',
        slug: `agent-uninstall-${stamp}`,
        directorySlug: `agent-uninstall-${stamp}`,
        name: 'Agent uninstall fixture',
        status: 'published',
        curated: true,
        installCount: 0,
        publishedAt: new Date(),
        categories: { connect: { id: category.id } },
      },
    });
    listingId = listing.id;
    const release = await db.agentRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
        manifest: manifest as Prisma.InputJsonValue,
        releaseSummary: summarizeAgentReleaseManifest(manifest) as Prisma.InputJsonValue,
        checksum: agentReleaseChecksum(manifest),
        name: listing.name,
        categoryIds: [category.id],
        reviewStatus: 'approved',
        reviewedAt: new Date(),
      },
    });
    releaseId = release.id;
    await db.agentListing.update({
      where: { id: listing.id },
      data: { latestVersion: 1, latestReleaseId: release.id },
    });
  });

  afterAll(async () => {
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    if (listingId) await db.agentListing.deleteMany({ where: { id: listingId } });
    if (categoryId) await db.category.deleteMany({ where: { id: categoryId } });
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('removes only install-owned resources and keeps resources reused outside the install graph', async () => {
    const installed = await materializeAgentRelease({
      releaseId,
      targetWorkspaceId: workspaceId,
      installedById: userId,
      idempotencyKey: `agent-uninstall-${stamp}`,
    });
    const rootId = installed.resourceMap.agents.root;
    const childId = installed.resourceMap.agents.child;
    const external = await db.agent.create({
      data: {
        workspaceId,
        name: 'External consumer',
        slug: `external-${stamp}`,
        runtimeKind: 'pi',
        subAgents: { create: { childId } },
      },
    });
    const outsider = await db.user.create({
      data: { email: `agent-uninstall-outsider-${stamp}@test.dev`, passwordHash: 'x' },
    });

    await expect(deleteManagedAgent({ workspaceId, agentId: rootId, actorId: outsider.id }))
      .resolves.toBe(false);
    await expect(db.agentInstall.findUnique({ where: { id: installed.install.id } }))
      .resolves.toMatchObject({ id: installed.install.id });
    await db.user.delete({ where: { id: outsider.id } });

    await expect(deleteManagedAgent({ workspaceId, agentId: rootId, actorId: userId }))
      .resolves.toBe(true);

    await expect(db.agentInstall.findUnique({ where: { id: installed.install.id } })).resolves.toBeNull();
    await expect(db.agent.findUnique({ where: { id: rootId } })).resolves.toBeNull();
    await expect(db.agent.findUnique({ where: { id: childId } })).resolves.toMatchObject({ id: childId });
    await expect(db.agent.findUnique({ where: { id: external.id } })).resolves.toMatchObject({ id: external.id });

    for (const id of [
      installed.resourceMap.deployments.deployment_private,
      installed.resourceMap.skills.skill_private,
      installed.resourceMap.toolkits.toolkit_private,
      installed.resourceMap.sandboxes.root,
      installed.resourceMap.sandboxDeployments.root,
    ]) {
      const [deployment, skillRow, toolkitRow, sandbox] = await Promise.all([
        db.deployment.findUnique({ where: { id } }),
        db.installedSkill.findUnique({ where: { id } }),
        db.toolkit.findUnique({ where: { id } }),
        db.sandbox.findUnique({ where: { id } }),
      ]);
      expect(deployment ?? skillRow ?? toolkitRow ?? sandbox).toBeNull();
    }
    await expect(db.deployment.findUnique({
      where: { id: installed.resourceMap.deployments.deployment_shared },
    })).resolves.toMatchObject({ id: installed.resourceMap.deployments.deployment_shared });
    await expect(db.installedSkill.findUnique({
      where: { id: installed.resourceMap.skills.skill_shared },
    })).resolves.toMatchObject({ id: installed.resourceMap.skills.skill_shared });
    await expect(db.toolkit.findUnique({
      where: { id: installed.resourceMap.toolkits.toolkit_shared },
    })).resolves.toMatchObject({ id: installed.resourceMap.toolkits.toolkit_shared });
    await expect(db.sandbox.findUnique({
      where: { id: installed.resourceMap.sandboxes.child },
    })).resolves.toMatchObject({ id: installed.resourceMap.sandboxes.child });
    await expect(db.agentListing.findUniqueOrThrow({ where: { id: listingId } }))
      .resolves.toMatchObject({ installCount: 0 });
  });
});
