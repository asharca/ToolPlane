import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { agentReleaseChecksum } from '@/lib/agents/market-artifact';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { hashPassword } from '@/lib/auth/password';
import {
  generateToken,
  hashToken,
  tokenPrefix,
} from '@/lib/auth/token-format';

const MCP_SOURCE_TYPES = ['npm', 'pypi', 'github', 'docker', 'config'] as const;
const CATALOG_SERVER_SLUG = 'smoke-catalog-memory';
const SMOKE_AGENT_LISTINGS = [
  'smoke-research-copilot',
  'smoke-hermes-operator',
] as const;

type SmokeMcpSeed = {
  name: string;
  source: (typeof MCP_SOURCE_TYPES)[number];
  sourceRef: string;
  installCfg: Prisma.InputJsonValue;
};

type SmokeSkillSeed = {
  name: string;
  slug: string;
  description: string;
  content: string;
};

type SmokeAgentManifest = {
  schemaVersion: 1;
  rootAgentKey: string;
  agents: Array<{
    key: string;
    name: string;
    slug: string;
    systemPrompt: string | null;
    maxSteps: number;
    modelRequirement: { format: string; model: string } | null;
    runtime?: { kind: 'hermes'; image: string };
    modelProviderRequirements?: Array<{ format: string }>;
    deploymentKeys: string[];
    skillKeys: string[];
    toolkitKeys: string[];
    subAgentKeys: string[];
  }>;
  deployments: Array<{
    key: string;
    name: string;
    catalogSlug: string;
    source: 'npm' | 'pypi' | 'github' | 'docker';
    sourceRef: string;
    requiredEnv: string[];
    publicEnv: Record<string, string>;
    startCommand?: string;
    network?: 'none';
    mcpToolExposure: 'all' | 'allowlist';
    mcpAllowedTools: string[];
  }>;
  skills: Array<{
    key: string;
    origin: 'catalog' | 'custom';
    catalogSlug?: string;
    sourceSha?: string;
    name: string;
    slug: string;
    description: string | null;
    content: string;
    files: Array<{ path: string; content: string; encoding?: 'base64' }>;
    userInvocable: boolean;
    agentInvocable: boolean;
    effort: string;
  }>;
  toolkits: Array<{
    key: string;
    name: string;
    slug: string;
    enabled: boolean;
    deploymentKeys: string[];
    skillKeys: string[];
  }>;
};

type SmokeAgentReleaseSummary = {
  agentCount: number;
  subAgentCount: number;
  deploymentCount: number;
  skillCount: number;
  toolkitCount: number;
  resourceCount: number;
  toolCount: number;
  models: Array<{ format: string; model: string }>;
  runtimes: Array<'native' | 'hermes'>;
};

const mcpSeeds: SmokeMcpSeed[] = [
  {
    name: 'Everything (editable JSON)',
    source: 'config',
    sourceRef: 'npx',
    installCfg: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      env: {},
    },
  },
  {
    name: 'Memory',
    source: 'npm',
    sourceRef: '@modelcontextprotocol/server-memory',
    installCfg: { env: {} },
  },
  {
    name: 'Sequential Thinking',
    source: 'npm',
    sourceRef: '@modelcontextprotocol/server-sequential-thinking',
    installCfg: { env: {} },
  },
  {
    name: 'Fetch',
    source: 'pypi',
    sourceRef: 'mcp-server-fetch',
    installCfg: { env: {} },
  },
  {
    name: 'Time',
    source: 'pypi',
    sourceRef: 'mcp-server-time',
    installCfg: { env: {} },
  },
  {
    name: 'WHOIS (GitHub)',
    source: 'github',
    sourceRef: 'https://github.com/modelcontextprotocol-servers/whois-mcp',
    installCfg: { env: {} },
  },
  {
    name: 'Filesystem (Docker)',
    source: 'docker',
    sourceRef: 'mcp/filesystem',
    installCfg: {
      startCommand: '/tmp',
      env: {},
      network: 'none',
    },
  },
];

for (const source of MCP_SOURCE_TYPES) {
  if (!mcpSeeds.some((seed) => seed.source === source)) {
    throw new Error(`Smoke seed is missing the ${source} MCP source type.`);
  }
}

const skillSeeds: SmokeSkillSeed[] = [
  {
    name: 'Code Review',
    slug: 'code-review',
    description: 'Review changes for correctness, regressions, security risks, and missing tests.',
    content: `---
name: code-review
description: Review changes for correctness, regressions, security risks, and missing tests.
user-invocable: true
agent-invocable: true
---

# Code Review

Inspect the relevant diff and surrounding code before making claims.

1. Prioritize concrete bugs, regressions, security risks, and data-loss paths.
2. Cite the affected file and line for each finding.
3. Check authorization boundaries and error handling for mutations.
4. Identify missing tests that would catch the reported issue.
5. If no actionable issue exists, say so and state the remaining test risk.
`,
  },
  {
    name: 'Web Research',
    slug: 'web-research',
    description: 'Research current technical topics using primary sources and concise citations.',
    content: `---
name: web-research
description: Research current technical topics using primary sources and concise citations.
user-invocable: true
agent-invocable: true
---

# Web Research

1. Clarify the decision or question the research must support.
2. Prefer official documentation, specifications, and original publications.
3. Verify time-sensitive claims against current sources.
4. Separate sourced facts from inference.
5. Return a concise synthesis with links next to the claims they support.
`,
  },
  {
    name: 'Incident Triage',
    slug: 'incident-triage',
    description: 'Triage production failures using evidence, impact, hypotheses, and next actions.',
    content: `---
name: incident-triage
description: Triage production failures using evidence, impact, hypotheses, and next actions.
user-invocable: true
agent-invocable: true
---

# Incident Triage

1. Establish the affected users, systems, and time window.
2. Collect logs, recent changes, health signals, and a minimal reproduction.
3. Rank hypotheses by evidence and blast radius.
4. Recommend the safest immediate mitigation before deeper remediation.
5. Record verified cause, unresolved questions, and follow-up work.
`,
  },
  {
    name: 'Release Notes',
    slug: 'release-notes',
    description: 'Turn commits and pull requests into user-focused release notes.',
    content: `---
name: release-notes
description: Turn commits and pull requests into user-focused release notes.
user-invocable: true
agent-invocable: true
---

# Release Notes

1. Read the actual commits, pull requests, and changed behavior.
2. Group changes into features, fixes, and operational notes.
3. Describe user impact rather than internal implementation detail.
4. Call out migrations, compatibility changes, and required actions.
5. Do not claim behavior that is not supported by the diff or tests.
`,
  },
];

function smokeSandboxVolumeName(sandboxId: string): string {
  return `toolplane_sandbox_${sandboxId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function portableSkill(
  key: string,
  seed: SmokeSkillSeed,
): SmokeAgentManifest['skills'][number] {
  return {
    key,
    origin: 'custom',
    name: seed.name,
    slug: seed.slug,
    description: seed.description,
    content: seed.content,
    files: [],
    userInvocable: true,
    agentInvocable: true,
    effort: 'default',
  };
}

function summarizeManifest(manifest: SmokeAgentManifest): SmokeAgentReleaseSummary {
  const models = new Map<string, { format: string; model: string }>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    const requirement = agent.modelRequirement;
    models.set(`${requirement.format}\0${requirement.model}`, requirement);
  }
  const runtimes = [...new Set(
    manifest.agents.map((agent) => agent.runtime?.kind ?? 'native'),
  )].sort((a, b) => a.localeCompare(b)) as Array<'native' | 'hermes'>;
  const deploymentCount = manifest.deployments.length;
  const skillCount = manifest.skills.length;
  const toolkitCount = manifest.toolkits.length;
  const subAgentCount = Math.max(0, manifest.agents.length - 1);
  return {
    agentCount: manifest.agents.length,
    subAgentCount,
    deploymentCount,
    skillCount,
    toolkitCount,
    resourceCount: deploymentCount + skillCount + toolkitCount,
    toolCount: deploymentCount + skillCount + subAgentCount,
    models: [...models.values()].sort((a, b) => (
      a.format.localeCompare(b.format) || a.model.localeCompare(b.model)
    )),
    runtimes,
  };
}

async function createPublishedAgentListing(input: {
  workspaceId: string;
  publishedById: string;
  sourceAgentId: string;
  directorySlug: string;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  manifest: SmokeAgentManifest;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const publishedAt = new Date();
    const listingData = {
      publisherWorkspaceId: input.workspaceId,
      sourceAgentId: input.sourceAgentId,
      publishedById: input.publishedById,
      slug: input.slug,
      name: input.name,
      author: 'Smoke Test',
      summary: input.summary,
      tags: input.tags,
      status: 'published',
    };
    const existing = await tx.agentListing.findUnique({
      where: { directorySlug: input.directorySlug },
      select: { id: true, latestVersion: true },
    });
    const listing = existing
      ? await tx.agentListing.update({
          where: { id: existing.id },
          data: listingData,
          select: { id: true, latestVersion: true },
        })
      : await tx.agentListing.create({
          data: {
            ...listingData,
            directorySlug: input.directorySlug,
          },
          select: { id: true, latestVersion: true },
        });
    const checksum = agentReleaseChecksum(input.manifest);
    const matchingRelease = await tx.agentRelease.findFirst({
      where: { listingId: listing.id, checksum },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, publishedAt: true },
    });
    if (matchingRelease) {
      await tx.agentListing.update({
        where: { id: listing.id },
        data: {
          latestVersion: matchingRelease.version,
          latestReleaseId: matchingRelease.id,
          publishedAt: matchingRelease.publishedAt,
        },
      });
      return;
    }
    const version = listing.latestVersion + 1;
    const release = await tx.agentRelease.create({
      data: {
        listingId: listing.id,
        version,
        manifestVersion: 1,
        manifest: input.manifest as Prisma.InputJsonValue,
        releaseSummary: summarizeManifest(input.manifest) as Prisma.InputJsonValue,
        checksum,
        name: input.name,
        summary: input.summary,
        tags: input.tags,
        reviewStatus: 'approved',
        reviewedById: input.publishedById,
        reviewedAt: publishedAt,
        publishedAt,
      },
      select: { id: true },
    });
    await tx.agentListing.update({
      where: { id: listing.id },
      data: { latestVersion: version, latestReleaseId: release.id, publishedAt },
    });
  });
}

async function main(): Promise<void> {
  const email = 'smoke@example.com';
  const hermesImage = resolveHermesImage(undefined);
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: 'Smoke Test',
      passwordHash: await hashPassword('password123'),
    },
  });

  const ws = await db.workspace.create({
    data: {
      slug: 'smoke',
      name: 'Smoke Workspace',
      ownerId: user.id,
    },
  });

  await db.membership.create({
    data: {
      userId: user.id,
      workspaceId: ws.id,
      role: 'owner',
    },
  });

  const token = generateToken();
  await db.apiToken.create({
    data: {
      userId: user.id,
      name: 'smoke',
      prefix: tokenPrefix(token),
      tokenHash: hashToken(token),
    },
  });

  const catalogServer = await db.server.upsert({
    where: { slug: CATALOG_SERVER_SLUG },
    update: {
      name: 'Catalog Memory (seed)',
      author: 'ToolPlane',
      description: 'Catalog-linked MCP deployment for smoke-testing directory installs.',
      curated: true,
      installCfg: {
        source: 'npm',
        ref: '@modelcontextprotocol/server-memory',
        env: [],
      },
      verifiedAt: new Date(),
      verifiedTools: 9,
    },
    create: {
      slug: CATALOG_SERVER_SLUG,
      name: 'Catalog Memory (seed)',
      author: 'ToolPlane',
      description: 'Catalog-linked MCP deployment for smoke-testing directory installs.',
      curated: true,
      installCfg: {
        source: 'npm',
        ref: '@modelcontextprotocol/server-memory',
        env: [],
      },
      verifiedAt: new Date(),
      verifiedTools: 9,
    },
  });

  const customDeployments = await Promise.all(
    mcpSeeds.map((seed) => db.deployment.create({
      data: {
        workspaceId: ws.id,
        name: seed.name,
        source: seed.source,
        sourceRef: seed.sourceRef,
        installCfg: seed.installCfg,
        status: 'stopped',
      },
      select: { id: true },
    })),
  );
  const catalogDeployment = await db.deployment.create({
    data: {
      workspaceId: ws.id,
      serverId: catalogServer.id,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      installCfg: { env: {} },
      status: 'stopped',
    },
    select: { id: true },
  });
  const deployments = [...customDeployments, catalogDeployment];

  const installedSkills = await Promise.all(
    skillSeeds.map((seed) => db.installedSkill.create({
      data: {
        workspaceId: ws.id,
        name: seed.name,
        slug: seed.slug,
        description: seed.description,
        content: seed.content,
        source: 'seed',
        sourceRef: `smoke-seed:${seed.slug}`,
        status: 'published',
        userInvocable: true,
        agentInvocable: true,
        effort: 'default',
      },
      select: { id: true },
    })),
  );

  const toolkit = await db.toolkit.create({
    data: {
      workspaceId: ws.id,
      slug: 'debug-starter',
      name: 'Debug Starter Kit',
      visibility: 'private',
      enabled: true,
    },
    select: { id: true },
  });
  await Promise.all([
    db.toolkitServer.createMany({
      data: deployments.map(({ id }) => ({ toolkitId: toolkit.id, deploymentId: id })),
    }),
    db.toolkitSkill.createMany({
      data: installedSkills.map(({ id }) => ({ toolkitId: toolkit.id, installedSkillId: id })),
    }),
  ]);

  const marketToolkit = await db.toolkit.create({
    data: {
      workspaceId: ws.id,
      slug: 'market-starter',
      name: 'Market Starter Kit',
      visibility: 'private',
      enabled: true,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[0].id } },
    },
    select: { id: true },
  });

  const nativeAgent = await db.agent.create({
    data: {
      workspaceId: ws.id,
      name: 'Research Copilot',
      slug: 'research-copilot',
      systemPrompt: 'Research technical questions from primary sources and return concise citations.',
      maxSteps: 10,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[0].id } },
      toolkits: { create: { toolkitId: marketToolkit.id } },
    },
    select: { id: true, name: true, slug: true, systemPrompt: true, maxSteps: true },
  });

  const hermesAgent = await db.agent.create({
    data: {
      workspaceId: ws.id,
      name: 'Hermes Operations Copilot',
      slug: 'hermes-operations-copilot',
      maxSteps: 12,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[0].id } },
      toolkits: { create: { toolkitId: marketToolkit.id } },
    },
    select: { id: true, name: true, slug: true, maxSteps: true },
  });
  const hermesDeployment = await db.deployment.create({
    data: {
      workspaceId: ws.id,
      name: `Hermes runtime: ${hermesAgent.name}`,
      source: 'sandbox',
      sourceRef: hermesImage,
      status: 'stopped',
    },
    select: { id: true },
  });
  const hermesSandbox = await db.sandbox.create({
    data: {
      workspaceId: ws.id,
      deploymentId: hermesDeployment.id,
      name: `${hermesAgent.name} Hermes`,
      slug: `${hermesAgent.slug}-runtime`,
      kind: HERMES_RUNTIME_KIND,
      image: hermesImage,
      network: 'isolated',
      config: { managedBy: 'agent-runtime' },
    },
    select: { id: true },
  });
  const hermesRuntime = await db.agentRuntime.create({
    data: {
      workspaceId: ws.id,
      agentId: hermesAgent.id,
      sandboxId: hermesSandbox.id,
      kind: HERMES_RUNTIME_KIND,
      image: hermesImage,
      status: 'setup_required',
    },
    select: { id: true },
  });
  await db.deployment.update({
    where: { id: hermesDeployment.id },
    data: {
      installCfg: {
        sandboxId: hermesSandbox.id,
        kind: HERMES_RUNTIME_KIND,
        image: hermesImage,
        network: 'isolated',
        volumeName: smokeSandboxVolumeName(hermesSandbox.id),
        runtimeId: hermesRuntime.id,
        runtimeModelName: hermesAgent.slug,
        env: {},
      },
    },
  });

  const catalogManifestDeployment: SmokeAgentManifest['deployments'][number] = {
    key: 'deployment_1',
    name: catalogServer.name,
    catalogSlug: catalogServer.slug,
    source: 'npm',
    sourceRef: '@modelcontextprotocol/server-memory',
    requiredEnv: [],
    publicEnv: {},
    mcpToolExposure: 'all',
    mcpAllowedTools: [],
  };
  const marketManifestToolkit: SmokeAgentManifest['toolkits'][number] = {
    key: 'toolkit_1',
    name: 'Market Starter Kit',
    slug: 'market-starter',
    enabled: true,
    deploymentKeys: ['deployment_1'],
    skillKeys: ['skill_1'],
  };
  const nativeManifest: SmokeAgentManifest = {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: nativeAgent.name,
      slug: nativeAgent.slug,
      systemPrompt: nativeAgent.systemPrompt,
      maxSteps: nativeAgent.maxSteps,
      modelRequirement: null,
      deploymentKeys: ['deployment_1'],
      skillKeys: ['skill_1'],
      toolkitKeys: ['toolkit_1'],
      subAgentKeys: [],
    }],
    deployments: [catalogManifestDeployment],
    skills: [portableSkill('skill_1', skillSeeds[0])],
    toolkits: [marketManifestToolkit],
  };
  const hermesManifest: SmokeAgentManifest = {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: hermesAgent.name,
      slug: hermesAgent.slug,
      systemPrompt: null,
      maxSteps: hermesAgent.maxSteps,
      modelRequirement: null,
      runtime: { kind: 'hermes', image: hermesImage },
      modelProviderRequirements: [],
      deploymentKeys: ['deployment_1'],
      skillKeys: ['skill_1'],
      toolkitKeys: ['toolkit_1'],
      subAgentKeys: [],
    }],
    deployments: [catalogManifestDeployment],
    skills: [portableSkill('skill_1', skillSeeds[0])],
    toolkits: [marketManifestToolkit],
  };
  await Promise.all([
    createPublishedAgentListing({
      workspaceId: ws.id,
      publishedById: user.id,
      sourceAgentId: nativeAgent.id,
      directorySlug: SMOKE_AGENT_LISTINGS[0],
      slug: nativeAgent.slug,
      name: nativeAgent.name,
      summary: 'A portable research workflow with a verified catalog MCP and reusable review guidance.',
      tags: ['seed', 'research', 'native'],
      manifest: nativeManifest,
    }),
    createPublishedAgentListing({
      workspaceId: ws.id,
      publishedById: user.id,
      sourceAgentId: hermesAgent.id,
      directorySlug: SMOKE_AGENT_LISTINGS[1],
      slug: hermesAgent.slug,
      name: hermesAgent.name,
      summary: 'A Hermes runtime template that starts from an isolated, credential-free setup state.',
      tags: ['seed', 'hermes', 'operations'],
      manifest: hermesManifest,
    }),
  ]);

  console.log(`TOKEN=${token}`);
  console.log(
    `Seeded ${deployments.length} MCPs, ${installedSkills.length} skills, 2 agents, `
      + '2 published agent listings, Debug Starter Kit, and Market Starter Kit.',
  );
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
