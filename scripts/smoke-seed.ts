import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { agentReleaseChecksum } from '@/lib/agents/market-artifact';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { hashPassword } from '@/lib/auth/password';
import { DEFAULT_SANDBOX_IMAGE } from '@/lib/sandboxes/images';
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
  'smoke-code-quality-guardian',
  'smoke-incident-response-lead',
] as const;

type SmokeMcpSeed = {
  name: string;
  source: (typeof MCP_SOURCE_TYPES)[number];
  sourceRef: string;
  installCfg: Prisma.InputJsonValue;
  catalog?: {
    slug: string;
    author: string;
    description: string;
    stars: number;
    verifiedTools: number;
  };
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
    runtime: { kind: 'pi' } | { kind: 'hermes'; image: string };
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
  runtimes: Array<'pi' | 'hermes'>;
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
    catalog: {
      slug: CATALOG_SERVER_SLUG,
      author: 'Model Context Protocol',
      description: 'Store and recall durable knowledge as a graph of entities, relations, and observations.',
      stars: 14_800,
      verifiedTools: 9,
    },
  },
  {
    name: 'Sequential Thinking',
    source: 'npm',
    sourceRef: '@modelcontextprotocol/server-sequential-thinking',
    installCfg: { env: {} },
    catalog: {
      slug: 'smoke-catalog-sequential-thinking',
      author: 'Model Context Protocol',
      description: 'Break complex work into explicit, revisable reasoning steps before taking action.',
      stars: 12_400,
      verifiedTools: 1,
    },
  },
  {
    name: 'Fetch',
    source: 'pypi',
    sourceRef: 'mcp-server-fetch',
    installCfg: { env: {} },
    catalog: {
      slug: 'smoke-catalog-fetch',
      author: 'Model Context Protocol',
      description: 'Retrieve web pages and convert their content into a model-friendly representation.',
      stars: 9_600,
      verifiedTools: 1,
    },
  },
  {
    name: 'Time',
    source: 'pypi',
    sourceRef: 'mcp-server-time',
    installCfg: { env: {} },
    catalog: {
      slug: 'smoke-catalog-time',
      author: 'Model Context Protocol',
      description: 'Read current time and convert times accurately across IANA time zones.',
      stars: 7_900,
      verifiedTools: 2,
    },
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
    catalog: {
      slug: 'smoke-catalog-filesystem',
      author: 'Model Context Protocol',
      description: 'Read, write, search, and organize files within explicitly allowed directories.',
      stars: 13_100,
      verifiedTools: 14,
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
  {
    name: 'Data Analysis',
    slug: 'data-analysis',
    description: 'Turn structured data into reproducible findings, checks, and decision-ready summaries.',
    content: `---
name: data-analysis
description: Turn structured data into reproducible findings, checks, and decision-ready summaries.
user-invocable: true
agent-invocable: true
---

# Data Analysis

1. Inspect the schema, units, missing values, and time range before calculating.
2. Keep source data unchanged and make transformations reproducible.
3. Validate totals and outliers with an independent check.
4. Separate observations from interpretations and recommendations.
5. Report assumptions, limitations, and the smallest useful next step.
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
    manifest.agents.map((agent) => agent.runtime.kind),
  )].sort((a, b) => a.localeCompare(b)) as Array<'pi' | 'hermes'>;
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
      curated: true,
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
  const leakedSkills = await db.skill.findMany({
    where: {
      author: null,
      description: null,
      OR: [
        { slug: { startsWith: 'mk-' } },
        { slug: { startsWith: 'pi-skill-' } },
        { slug: { startsWith: 'curs-' }, name: 'Admin Skill' },
      ],
    },
    select: { id: true, slug: true },
  });
  const leakedSkillIds = leakedSkills
    .filter(({ slug }) => /^(?:mk|pi-skill|curs)-\d+$/.test(slug))
    .map(({ id }) => id);
  if (leakedSkillIds.length > 0) {
    await db.skill.deleteMany({ where: { id: { in: leakedSkillIds } } });
  }
  await db.user.deleteMany({ where: { email } });

  const user = await db.user.create({
    data: {
      email,
      name: 'Smoke Test',
      passwordHash: await hashPassword('password123'),
      role: 'admin',
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

  const libraryWs = await db.workspace.create({
    data: {
      slug: 'smoke-library',
      name: 'ToolPlane Starter Library',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'owner' } },
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

  const catalogMcps: Array<{ seed: SmokeMcpSeed; server: { id: string; slug: string; name: string } }> = [];
  for (const seed of mcpSeeds) {
    if (!seed.catalog || seed.source === 'config') continue;
    const recipe = {
      source: seed.source,
      ref: seed.sourceRef,
      env: [],
      ...(seed.source === 'docker' ? { startCommand: '/tmp', network: 'none' } : {}),
    };
    const data = {
      name: seed.name.replace(/ \((?:Docker|GitHub)\)$/, ''),
      author: seed.catalog.author,
      description: seed.catalog.description,
      stars: seed.catalog.stars,
      isOfficial: true,
      isFeatured: true,
      curated: true,
      installCfg: recipe,
      verifiedAt: new Date(),
      verifiedTools: seed.catalog.verifiedTools,
      readme: `# ${seed.name}\n\n${seed.catalog.description}`,
    };
    const server = await db.server.upsert({
      where: { slug: seed.catalog.slug },
      update: data,
      create: { slug: seed.catalog.slug, ...data },
      select: { id: true, slug: true, name: true },
    });
    catalogMcps.push({ seed, server });
  }
  const catalogServer = catalogMcps.find(({ server }) => server.slug === CATALOG_SERVER_SLUG)?.server;
  if (!catalogServer) throw new Error('Smoke catalog memory MCP was not seeded.');

  const catalogSkills = await Promise.all(skillSeeds.map((seed, index) => {
    const data = {
      name: seed.name,
      author: 'ToolPlane',
      description: seed.description,
      content: seed.content,
      score: 100 - index * 8,
      curated: true,
    };
    return db.skill.upsert({
      where: { slug: `smoke-catalog-${seed.slug}` },
      update: data,
      create: { slug: `smoke-catalog-${seed.slug}`, ...data },
      select: { id: true, slug: true },
    });
  }));

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
    skillSeeds.map((seed, index) => db.installedSkill.create({
      data: {
        workspaceId: ws.id,
        skillId: catalogSkills[index].id,
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

  const libraryDeployments = await Promise.all(catalogMcps.map(({ seed, server }) => (
    db.deployment.create({
      data: {
        workspaceId: libraryWs.id,
        serverId: server.id,
        source: seed.source,
        sourceRef: seed.sourceRef,
        installCfg: seed.installCfg,
        status: 'stopped',
      },
      select: { id: true },
    })
  )));
  const librarySkills = await Promise.all(catalogSkills.map(({ id }) => (
    db.installedSkill.create({
      data: { workspaceId: libraryWs.id, skillId: id },
      select: { id: true },
    })
  )));
  await Promise.all([
    db.toolkit.create({
      data: {
        workspaceId: libraryWs.id,
        slug: 'developer-essentials',
        name: 'Developer Essentials',
        visibility: 'public',
        enabled: true,
        servers: {
          create: [0, 1, 4].map((index) => ({ deploymentId: libraryDeployments[index].id })),
        },
        skills: {
          create: [0, 2, 4].map((index) => ({ installedSkillId: librarySkills[index].id })),
        },
      },
    }),
    db.toolkit.create({
      data: {
        workspaceId: libraryWs.id,
        slug: 'research-desk',
        name: 'Research Desk',
        visibility: 'public',
        enabled: true,
        servers: {
          create: [0, 2, 3].map((index) => ({ deploymentId: libraryDeployments[index].id })),
        },
        skills: {
          create: [1, 3, 4].map((index) => ({ installedSkillId: librarySkills[index].id })),
        },
      },
    }),
  ]);

  await Promise.all([
    db.chatAssistant.create({
      data: {
        workspaceId: ws.id,
        name: 'Research Assistant',
        systemPrompt: 'Research questions carefully, verify uncertain claims, and return concise source-backed answers.',
        maxSteps: 10,
        mcpGrants: {
          create: [catalogDeployment.id, customDeployments[3].id].map((deploymentId) => ({ deploymentId })),
        },
      },
    }),
    db.chatAssistant.create({
      data: {
        workspaceId: ws.id,
        name: 'Engineering Assistant',
        systemPrompt: 'Help implement and review software changes with small diffs, explicit checks, and clear tradeoffs.',
        maxSteps: 12,
        mcpGrants: {
          create: [customDeployments[2].id, customDeployments[6].id].map((deploymentId) => ({ deploymentId })),
        },
      },
    }),
    db.chatAssistant.create({
      data: {
        workspaceId: ws.id,
        name: 'Operations Assistant',
        systemPrompt: 'Triage operational issues from evidence, protect production data, and prioritize reversible mitigation.',
        maxSteps: 10,
        mcpGrants: {
          create: [catalogDeployment.id, customDeployments[4].id].map((deploymentId) => ({ deploymentId })),
        },
      },
    }),
  ]);

  // Keep the smoke workspace useful for visually checking the Logs page. The
  // rows are intentionally spread across the last 24 hours so the hourly
  // chart, per-server rollup, status colors, and expandable payloads all have
  // something to show immediately after seeding.
  const seededNow = Date.now();
  await db.requestLog.createMany({
    data: [
      ...Array.from({ length: 48 }, (_, index) => {
        const deployment = deployments[index % deployments.length];
        const toolName = ['echo', 'add', 'get_current_time', 'search'][index % 4];
        const statusCode = index % 13 === 0
          ? 503
          : index % 9 === 0
            ? 500
            : index % 7 === 0
              ? 400
              : 200;
        const request = {
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name: toolName, arguments: { query: `seed-${index}` } },
        };
        const response = statusCode >= 400
          ? { error: statusCode === 503 ? 'deployment not running' : 'seeded request error' }
          : { result: { content: [{ type: 'text', text: `seed response ${index}` }] } };
        return {
          workspaceId: ws.id,
          deploymentId: deployment.id,
          method: 'POST',
          path: `/mcp/${deployment.id}/rpc#tools/call:${toolName}`,
          statusCode,
          durationMs: 28 + ((index * 37) % 520),
          requestBody: JSON.stringify(request),
          responseBody: JSON.stringify(response),
          createdAt: new Date(seededNow - index * 28 * 60 * 1000),
        };
      }),
      ...Array.from({ length: 4 }, (_, index) => ({
        workspaceId: ws.id,
        method: 'GET',
        path: index % 2 === 0 ? `/workspaces/${ws.slug}/manifest` : '/skills/code-review/skill.md',
        statusCode: index === 3 ? 404 : 200,
        durationMs: 18 + index * 11,
        requestBody: null,
        responseBody: JSON.stringify(index === 3 ? { error: 'seeded not found' } : { ok: true }),
        createdAt: new Date(seededNow - (index * 5 + 2) * 60 * 60 * 1000),
      })),
    ],
  });
  await db.skillInvocation.createMany({
    data: Array.from({ length: 12 }, (_, index) => ({
      workspaceId: ws.id,
      toolkitId: toolkit.id,
      skillSlug: skillSeeds[index % skillSeeds.length].slug,
      source: index % 3 === 0 ? 'agent' : 'user',
      outcome: index % 5 === 0 ? 'error' : 'success',
      errorClass: index % 5 === 0 ? (index % 2 === 0 ? 'timeout' : 'runtime_error') : null,
      client: index % 2 === 0 ? 'toolplane-smoke' : 'claude-code',
      createdAt: new Date(seededNow - index * 95 * 60 * 1000),
    })),
  });
  await db.syncEvent.createMany({
    data: [
      {
        workspaceId: ws.id,
        toolkitId: toolkit.id,
        outcome: 'applied',
        added: 4,
        removed: 0,
        updated: 1,
        total: skillSeeds.length,
        client: 'toolplane-smoke',
        createdAt: new Date(seededNow - 45 * 60 * 1000),
      },
      {
        workspaceId: ws.id,
        toolkitId: toolkit.id,
        outcome: 'failure',
        added: 0,
        removed: 0,
        updated: 0,
        total: skillSeeds.length,
        reason: 'timeout',
        client: 'claude-code',
        createdAt: new Date(seededNow - 7 * 60 * 60 * 1000),
      },
      {
        workspaceId: ws.id,
        toolkitId: toolkit.id,
        outcome: 'applied',
        added: 1,
        removed: 1,
        updated: 2,
        total: skillSeeds.length,
        client: 'toolplane-smoke',
        createdAt: new Date(seededNow - 18 * 60 * 60 * 1000),
      },
    ],
  });

  const piAgent = await db.agent.create({
    data: {
      workspaceId: ws.id,
      name: 'Research Copilot',
      slug: 'research-copilot',
      runtimeKind: 'pi',
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
      runtimeKind: HERMES_RUNTIME_KIND,
      maxSteps: 12,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[0].id } },
      toolkits: { create: { toolkitId: marketToolkit.id } },
    },
    select: { id: true, name: true, slug: true, maxSteps: true },
  });
  const qualityAgent = await db.agent.create({
    data: {
      workspaceId: ws.id,
      name: 'Code Quality Guardian',
      slug: 'code-quality-guardian',
      runtimeKind: 'pi',
      systemPrompt: 'Review code changes for correctness, security, maintainability, and missing verification.',
      maxSteps: 10,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[0].id } },
    },
    select: { id: true, name: true, slug: true, systemPrompt: true, maxSteps: true },
  });
  const incidentAgent = await db.agent.create({
    data: {
      workspaceId: ws.id,
      name: 'Incident Response Lead',
      slug: 'incident-response-lead',
      runtimeKind: 'pi',
      systemPrompt: 'Coordinate incident triage from evidence, reduce impact safely, and preserve a clear decision log.',
      maxSteps: 12,
      servers: { create: { deploymentId: catalogDeployment.id } },
      skills: { create: { installedSkillId: installedSkills[2].id } },
    },
    select: { id: true, name: true, slug: true, systemPrompt: true, maxSteps: true },
  });
  for (const agent of [piAgent, qualityAgent, incidentAgent]) {
    const deployment = await db.deployment.create({
      data: {
        workspaceId: ws.id,
        name: `Sandbox: ${agent.name} Workspace`,
        source: 'sandbox',
        sourceRef: DEFAULT_SANDBOX_IMAGE,
        status: 'stopped',
      },
      select: { id: true },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: ws.id,
        deploymentId: deployment.id,
        name: `${agent.name} Workspace`,
        slug: `${agent.slug}-workspace`,
        kind: 'docker',
        image: DEFAULT_SANDBOX_IMAGE,
        network: 'isolated',
        agentLinks: { create: { agentId: agent.id, isDefault: true } },
      },
      select: { id: true },
    });
    await db.deployment.update({
      where: { id: deployment.id },
      data: {
        installCfg: {
          sandboxId: sandbox.id,
          kind: 'docker',
          image: DEFAULT_SANDBOX_IMAGE,
          network: 'isolated',
          volumeName: smokeSandboxVolumeName(sandbox.id),
          env: {},
          allowSudo: false,
        },
      },
    });
  }
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
  const piManifest: SmokeAgentManifest = {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: piAgent.name,
      slug: piAgent.slug,
      systemPrompt: piAgent.systemPrompt,
      maxSteps: piAgent.maxSteps,
      modelRequirement: null,
      runtime: { kind: 'pi' },
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
  const qualityManifest: SmokeAgentManifest = {
    ...piManifest,
    agents: [{
      ...piManifest.agents[0],
      name: qualityAgent.name,
      slug: qualityAgent.slug,
      systemPrompt: qualityAgent.systemPrompt,
      maxSteps: qualityAgent.maxSteps,
      toolkitKeys: [],
    }],
    skills: [portableSkill('skill_1', skillSeeds[0])],
    toolkits: [],
  };
  const incidentManifest: SmokeAgentManifest = {
    ...piManifest,
    agents: [{
      ...piManifest.agents[0],
      name: incidentAgent.name,
      slug: incidentAgent.slug,
      systemPrompt: incidentAgent.systemPrompt,
      maxSteps: incidentAgent.maxSteps,
      toolkitKeys: [],
    }],
    skills: [portableSkill('skill_1', skillSeeds[2])],
    toolkits: [],
  };
  await Promise.all([
    createPublishedAgentListing({
      workspaceId: ws.id,
      publishedById: user.id,
      sourceAgentId: piAgent.id,
      directorySlug: SMOKE_AGENT_LISTINGS[0],
      slug: piAgent.slug,
      name: piAgent.name,
      summary: 'A portable research workflow with a verified catalog MCP and reusable review guidance.',
      tags: ['seed', 'research', 'pi'],
      manifest: piManifest,
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
    createPublishedAgentListing({
      workspaceId: ws.id,
      publishedById: user.id,
      sourceAgentId: qualityAgent.id,
      directorySlug: SMOKE_AGENT_LISTINGS[2],
      slug: qualityAgent.slug,
      name: qualityAgent.name,
      summary: 'A focused code review agent for regressions, security boundaries, and missing verification.',
      tags: ['seed', 'engineering', 'review'],
      manifest: qualityManifest,
    }),
    createPublishedAgentListing({
      workspaceId: ws.id,
      publishedById: user.id,
      sourceAgentId: incidentAgent.id,
      directorySlug: SMOKE_AGENT_LISTINGS[3],
      slug: incidentAgent.slug,
      name: incidentAgent.name,
      summary: 'An incident lead that prioritizes evidence, reversible mitigation, and clear operational handoffs.',
      tags: ['seed', 'operations', 'incident'],
      manifest: incidentManifest,
    }),
  ]);

  console.log(`TOKEN=${token}`);
  console.log(
    `Seeded ${catalogMcps.length} market MCPs, ${catalogSkills.length} market skills, `
      + '2 public toolkits, 4 agents/listings, 3 chat assistants, '
      + '3 Docker workspaces, the Hermes runtime, and observability test data.',
  );
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
