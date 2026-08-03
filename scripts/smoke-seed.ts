import 'dotenv/config';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import {
  generateToken,
  hashToken,
  tokenPrefix,
} from '@/lib/auth/token-format';

const MCP_SOURCE_TYPES = ['npm', 'pypi', 'github', 'docker', 'config'] as const;
const CATALOG_SERVER_SLUG = 'smoke-catalog-memory';
const SMOKE_MODEL = 'smoke-test-model';
const SMOKE_AGENT_LISTING_SLUGS = ['research-copilot', 'release-guardian'] as const;

const categorySeeds = [
  { slug: 'developer-tools', name: 'Developer Tools' },
  { slug: 'productivity', name: 'Productivity' },
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function manifestChecksum(manifest: SmokeAgentManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function manifestSummary(manifest: SmokeAgentManifest) {
  const models = new Map<string, { format: string; model: string }>();
  for (const agent of manifest.agents) {
    if (agent.modelRequirement) {
      models.set(
        `${agent.modelRequirement.format}\0${agent.modelRequirement.model}`,
        agent.modelRequirement,
      );
    }
  }
  const subAgentCount = Math.max(0, manifest.agents.length - 1);
  const resourceCount = manifest.deployments.length + manifest.skills.length + manifest.toolkits.length;
  return {
    agentCount: manifest.agents.length,
    subAgentCount,
    deploymentCount: manifest.deployments.length,
    skillCount: manifest.skills.length,
    toolkitCount: manifest.toolkits.length,
    resourceCount,
    toolCount: manifest.deployments.length + manifest.skills.length + subAgentCount,
    models: [...models.values()].sort((a, b) => (
      a.format.localeCompare(b.format) || a.model.localeCompare(b.model)
    )),
    runtimes: ['native'],
  };
}

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

async function main(): Promise<void> {
  const email = 'smoke@example.com';
  await db.user.deleteMany({ where: { email } });
  await db.agentListing.deleteMany({
    where: { directorySlug: { in: [...SMOKE_AGENT_LISTING_SLUGS] } },
  });

  const user = await db.user.create({
    data: {
      email,
      name: 'Smoke Test',
      passwordHash: await hashPassword('password123'),
      role: 'admin',
      locale: 'zh',
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

  const [developerCategory, productivityCategory] = await Promise.all(
    categorySeeds.map((category) => db.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: category,
      select: { id: true, slug: true },
    })),
  );

  const catalogSkills = await Promise.all(skillSeeds.map((seed) => {
    const categoryId = seed.slug === 'code-review' || seed.slug === 'incident-triage'
      ? developerCategory.id
      : productivityCategory.id;
    const sourceSha = createHash('sha256').update(seed.content).digest('hex');
    return db.skill.upsert({
      where: { slug: seed.slug },
      update: {
        name: seed.name,
        author: 'ToolPlane',
        description: seed.description,
        content: seed.content,
        sourceRegistry: 'smoke-seed',
        sourcePath: `skills/${seed.slug}/SKILL.md`,
        sourceSha,
        score: 100,
        curated: true,
        categories: { set: [{ id: categoryId }] },
      },
      create: {
        slug: seed.slug,
        name: seed.name,
        author: 'ToolPlane',
        description: seed.description,
        content: seed.content,
        sourceRegistry: 'smoke-seed',
        sourcePath: `skills/${seed.slug}/SKILL.md`,
        sourceSha,
        score: 100,
        curated: true,
        categories: { connect: [{ id: categoryId }] },
      },
      select: { id: true, slug: true },
    });
  }));

  const catalogServer = await db.server.upsert({
    where: { slug: CATALOG_SERVER_SLUG },
    update: {
      name: 'Catalog Memory (seed)',
      author: 'ToolPlane',
      description: 'Catalog-linked MCP deployment for smoke-testing workspace marketplace installs.',
      curated: true,
      installCfg: {
        source: 'npm',
        ref: '@modelcontextprotocol/server-memory',
        env: [],
      },
      verifiedAt: new Date(),
      verifiedTools: 9,
      categories: { set: [{ id: developerCategory.id }] },
    },
    create: {
      slug: CATALOG_SERVER_SLUG,
      name: 'Catalog Memory (seed)',
      author: 'ToolPlane',
      description: 'Catalog-linked MCP deployment for smoke-testing workspace marketplace installs.',
      curated: true,
      installCfg: {
        source: 'npm',
        ref: '@modelcontextprotocol/server-memory',
        env: [],
      },
      verifiedAt: new Date(),
      verifiedTools: 9,
      categories: { connect: [{ id: developerCategory.id }] },
    },
  });

  const customDeployments = await Promise.all(mcpSeeds.map((seed) => db.deployment.create({
    data: {
      workspaceId: ws.id,
      name: seed.name,
      source: seed.source,
      sourceRef: seed.sourceRef,
      installCfg: seed.installCfg,
      status: 'stopped',
    },
    select: { id: true },
  })));
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
    skillSeeds.map((seed, index) => db.installedSkill.create({
      data: {
        workspaceId: ws.id,
        skillId: catalogSkills[index].id,
        name: seed.name,
        slug: seed.slug,
        description: seed.description,
        content: seed.content,
        source: 'catalog',
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

  const provider = await db.modelProvider.create({
    data: {
      workspaceId: ws.id,
      name: 'Smoke OpenAI Compatible',
      format: 'openai',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'test-only-not-a-real-key',
      models: [SMOKE_MODEL],
    },
  });

  const [researchAgent, releaseGuardian] = await Promise.all([
    db.agent.create({
      data: {
        workspaceId: ws.id,
        name: 'Research Copilot',
        slug: 'research-copilot',
        systemPrompt: 'Research carefully, use the available evidence, and cite concrete sources.',
        providerId: provider.id,
        model: SMOKE_MODEL,
        maxSteps: 12,
        servers: { create: { deploymentId: catalogDeployment.id } },
        skills: { create: { installedSkillId: installedSkills[0].id } },
      },
    }),
    db.agent.create({
      data: {
        workspaceId: ws.id,
        name: 'Release Guardian',
        slug: 'release-guardian',
        systemPrompt: 'Review release changes, identify risk, and produce concise release notes.',
        providerId: provider.id,
        model: SMOKE_MODEL,
        maxSteps: 8,
        skills: { create: { installedSkillId: installedSkills[3].id } },
      },
    }),
  ]);
  await db.agentSubAgent.create({
    data: { parentId: researchAgent.id, childId: releaseGuardian.id },
  });

  const portableSkill = (
    key: string,
    seed: SmokeSkillSeed,
  ): SmokeAgentManifest['skills'][number] => ({
    key,
    origin: 'catalog',
    catalogSlug: seed.slug,
    name: seed.name,
    slug: seed.slug,
    description: seed.description,
    content: seed.content,
    files: [],
    userInvocable: true,
    agentInvocable: true,
    effort: 'default',
  });

  const publishedManifest: SmokeAgentManifest = {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [
      {
        key: 'agent_1',
        name: researchAgent.name,
        slug: researchAgent.slug,
        systemPrompt: researchAgent.systemPrompt,
        maxSteps: researchAgent.maxSteps,
        modelRequirement: { format: provider.format, model: SMOKE_MODEL },
        deploymentKeys: ['deployment_1'],
        skillKeys: ['skill_1'],
        toolkitKeys: [],
        subAgentKeys: ['agent_2'],
      },
      {
        key: 'agent_2',
        name: releaseGuardian.name,
        slug: releaseGuardian.slug,
        systemPrompt: releaseGuardian.systemPrompt,
        maxSteps: releaseGuardian.maxSteps,
        modelRequirement: { format: provider.format, model: SMOKE_MODEL },
        deploymentKeys: [],
        skillKeys: ['skill_2'],
        toolkitKeys: [],
        subAgentKeys: [],
      },
    ],
    deployments: [{
      key: 'deployment_1',
      name: 'Catalog Memory (seed)',
      catalogSlug: catalogServer.slug,
      source: 'npm',
      sourceRef: '@modelcontextprotocol/server-memory',
      requiredEnv: [],
      publicEnv: {},
      mcpToolExposure: 'all',
      mcpAllowedTools: [],
    }],
    skills: [
      portableSkill('skill_1', skillSeeds[0]),
      portableSkill('skill_2', skillSeeds[3]),
    ],
    toolkits: [],
  };

  const pendingManifest: SmokeAgentManifest = {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: releaseGuardian.name,
      slug: releaseGuardian.slug,
      systemPrompt: releaseGuardian.systemPrompt,
      maxSteps: releaseGuardian.maxSteps,
      modelRequirement: { format: provider.format, model: SMOKE_MODEL },
      deploymentKeys: [],
      skillKeys: ['skill_1'],
      toolkitKeys: [],
      subAgentKeys: [],
    }],
    deployments: [],
    skills: [portableSkill('skill_1', skillSeeds[3])],
    toolkits: [],
  };

  await db.$transaction(async (tx) => {
    const publishedAt = new Date();
    const listing = await tx.agentListing.create({
      data: {
        publisherWorkspaceId: ws.id,
        sourceAgentId: researchAgent.id,
        publishedById: user.id,
        slug: 'research-copilot',
        directorySlug: 'research-copilot',
        name: 'Research Copilot',
        author: 'Smoke Test',
        summary: 'A seeded multi-agent research assistant with MCP memory and reusable skills.',
        tags: ['research', 'productivity', 'multi-agent'],
        status: 'published',
        curated: true,
        isFeatured: true,
        latestVersion: 1,
        publishedAt,
        categories: {
          connect: [{ id: developerCategory.id }, { id: productivityCategory.id }],
        },
      },
      select: { id: true },
    });
    const release = await tx.agentRelease.create({
      data: {
        listingId: listing.id,
        version: 1,
        manifestVersion: 1,
        manifest: publishedManifest as Prisma.InputJsonValue,
        releaseSummary: manifestSummary(publishedManifest) as Prisma.InputJsonValue,
        checksum: manifestChecksum(publishedManifest),
        name: 'Research Copilot',
        summary: 'A seeded multi-agent research assistant with MCP memory and reusable skills.',
        tags: ['research', 'productivity', 'multi-agent'],
        reviewStatus: 'approved',
        reviewedById: user.id,
        reviewedAt: publishedAt,
        reviewNote: 'Approved smoke seed fixture.',
        publishedAt,
      },
      select: { id: true },
    });
    await tx.agentListing.update({
      where: { id: listing.id },
      data: { latestReleaseId: release.id },
    });

    const pendingListing = await tx.agentListing.create({
      data: {
        publisherWorkspaceId: ws.id,
        sourceAgentId: releaseGuardian.id,
        publishedById: user.id,
        slug: 'release-guardian',
        directorySlug: 'release-guardian',
        name: 'Release Guardian',
        author: 'Smoke Test',
        summary: 'A pending community release for exercising the administrator review queue.',
        tags: ['release', 'review', 'pending'],
        status: 'draft',
        latestVersion: 1,
        categories: { connect: [{ id: developerCategory.id }] },
      },
      select: { id: true },
    });
    const pendingRelease = await tx.agentRelease.create({
      data: {
        listingId: pendingListing.id,
        version: 1,
        manifestVersion: 1,
        manifest: pendingManifest as Prisma.InputJsonValue,
        releaseSummary: manifestSummary(pendingManifest) as Prisma.InputJsonValue,
        checksum: manifestChecksum(pendingManifest),
        name: 'Release Guardian',
        summary: 'A pending community release for exercising the administrator review queue.',
        tags: ['release', 'review', 'pending'],
        reviewStatus: 'pending',
      },
      select: { id: true },
    });
    await tx.agentListing.update({
      where: { id: pendingListing.id },
      data: { pendingReleaseId: pendingRelease.id },
    });
  });

  console.log(`TOKEN=${token}`);
  console.log(
    `Seeded ${deployments.length} MCPs, ${installedSkills.length} skills, 2 agents, `
      + '1 published agent listing, 1 pending review, and Debug Starter Kit.',
  );
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
