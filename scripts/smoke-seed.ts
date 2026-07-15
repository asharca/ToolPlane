import 'dotenv/config';
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

  const deployments = await Promise.all(
    [
      ...mcpSeeds.map((seed) => db.deployment.create({
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
      db.deployment.create({
        data: {
          workspaceId: ws.id,
          serverId: catalogServer.id,
          source: 'npm',
          sourceRef: '@modelcontextprotocol/server-memory',
          installCfg: { env: {} },
          status: 'stopped',
        },
        select: { id: true },
      }),
    ],
  );

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

  console.log(`TOKEN=${token}`);
  console.log(`Seeded ${deployments.length} MCPs, ${installedSkills.length} skills, and Debug Starter Kit.`);
  await db.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
