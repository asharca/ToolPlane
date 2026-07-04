import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { fetchGithubSkillBundle, type SkillBundleFile } from '@/lib/skills/bundle';

type CategorySeed = { slug: string; name: string };
type ServerSeed = {
  slug: string;
  name: string;
  author: string;
  description: string;
  stars: number;
  categorySlugs: string[];
  source: 'npm' | 'pypi';
  ref: string;
  verifiedTools: number | null;
  readmeUrl: string;
};
type SkillSeed = {
  slug: string;
  score: number;
  categorySlugs: string[];
  sourceUrl: string;
};
type LoadedSkill = {
  seed: SkillSeed;
  content: string;
  files: SkillBundleFile[];
  name: string;
  description: string;
  author: string;
  githubSource: string;
};

const MCP_REPO = 'https://github.com/modelcontextprotocol/servers';
const SKILLS_REPO = 'https://github.com/openai/skills';
const ANTHROPIC_PDF_SKILL = 'https://github.com/anthropics/skills/tree/main/skills/pdf';
const RAW_MCP = 'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src';
const RAW_SKILLS = 'https://raw.githubusercontent.com/openai/skills/main/skills/.curated';

const categories: CategorySeed[] = [
  { slug: 'files', name: 'Files' },
  { slug: 'web', name: 'Web' },
  { slug: 'developer-tools', name: 'Developer Tools' },
  { slug: 'memory', name: 'Memory' },
  { slug: 'reasoning', name: 'Reasoning' },
  { slug: 'productivity', name: 'Productivity' },
  { slug: 'security', name: 'Security' },
  { slug: 'observability', name: 'Observability' },
  { slug: 'design', name: 'Design' },
  { slug: 'deployment', name: 'Deployment' },
  { slug: 'documents', name: 'Documents' },
];

const servers: ServerSeed[] = [
  {
    slug: 'modelcontextprotocol-filesystem',
    name: 'Filesystem',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server for reading, writing, listing, moving, and searching files within allowed directories.',
    stars: 9800,
    categorySlugs: ['files', 'developer-tools'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-filesystem',
    verifiedTools: null,
    readmeUrl: `${RAW_MCP}/filesystem/README.md`,
  },
  {
    slug: 'modelcontextprotocol-fetch',
    name: 'Fetch',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server that fetches URLs and converts web content into markdown for agents.',
    stars: 9400,
    categorySlugs: ['web', 'developer-tools'],
    source: 'pypi',
    ref: 'mcp-server-fetch',
    verifiedTools: 1,
    readmeUrl: `${RAW_MCP}/fetch/README.md`,
  },
  {
    slug: 'modelcontextprotocol-git',
    name: 'Git',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server for reading, searching, and manipulating Git repositories programmatically.',
    stars: 9100,
    categorySlugs: ['developer-tools'],
    source: 'pypi',
    ref: 'mcp-server-git',
    verifiedTools: 10,
    readmeUrl: `${RAW_MCP}/git/README.md`,
  },
  {
    slug: 'modelcontextprotocol-memory',
    name: 'Memory',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server that provides persistent memory through a local knowledge graph.',
    stars: 8900,
    categorySlugs: ['memory', 'productivity'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-memory',
    verifiedTools: 9,
    readmeUrl: `${RAW_MCP}/memory/README.md`,
  },
  {
    slug: 'modelcontextprotocol-sequential-thinking',
    name: 'Sequential Thinking',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server for structured step-by-step reasoning and problem solving.',
    stars: 8700,
    categorySlugs: ['reasoning', 'productivity'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-sequential-thinking',
    verifiedTools: 1,
    readmeUrl: `${RAW_MCP}/sequentialthinking/README.md`,
  },
  {
    slug: 'modelcontextprotocol-time',
    name: 'Time',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server for current time queries and timezone conversions.',
    stars: 8300,
    categorySlugs: ['productivity'],
    source: 'pypi',
    ref: 'mcp-server-time',
    verifiedTools: 2,
    readmeUrl: `${RAW_MCP}/time/README.md`,
  },
  {
    slug: 'modelcontextprotocol-everything',
    name: 'Everything',
    author: 'Model Context Protocol',
    description: 'Official reference MCP server that exercises many MCP protocol features for client testing.',
    stars: 7800,
    categorySlugs: ['developer-tools'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-everything',
    verifiedTools: 8,
    readmeUrl: `${RAW_MCP}/everything/README.md`,
  },
];

const skills: SkillSeed[] = [
  { slug: 'openai-docs', score: 9800, categorySlugs: ['developer-tools', 'documents'], sourceUrl: `${RAW_SKILLS}/openai-docs/SKILL.md` },
  { slug: 'playwright', score: 9300, categorySlugs: ['developer-tools', 'web'], sourceUrl: `${RAW_SKILLS}/playwright/SKILL.md` },
  { slug: 'pdf', score: 9000, categorySlugs: ['documents'], sourceUrl: `${RAW_SKILLS}/pdf/SKILL.md` },
  { slug: 'figma-use', score: 8700, categorySlugs: ['design', 'developer-tools'], sourceUrl: `${RAW_SKILLS}/figma-use/SKILL.md` },
  { slug: 'gh-fix-ci', score: 8400, categorySlugs: ['developer-tools'], sourceUrl: `${RAW_SKILLS}/gh-fix-ci/SKILL.md` },
  { slug: 'security-threat-model', score: 8200, categorySlugs: ['security'], sourceUrl: `${RAW_SKILLS}/security-threat-model/SKILL.md` },
  { slug: 'sentry', score: 7900, categorySlugs: ['observability'], sourceUrl: `${RAW_SKILLS}/sentry/SKILL.md` },
  { slug: 'vercel-deploy', score: 7600, categorySlugs: ['deployment'], sourceUrl: `${RAW_SKILLS}/vercel-deploy/SKILL.md` },
];

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function yamlValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSkillMarkdown(slug: string, content: string) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  const meta: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      meta[line.slice(0, sep).trim()] = yamlValue(line.slice(sep + 1));
    }
  }
  return {
    name: meta.name || titleFromSlug(slug),
    description: meta.description || `${titleFromSlug(slug)} agent skill from ${SKILLS_REPO}.`,
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'toolplane-real-seed' },
  });
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function loadSkills(): Promise<Map<string, LoadedSkill>> {
  const out = new Map<string, LoadedSkill>();
  for (const seed of skills) {
    const content = await fetchText(seed.sourceUrl);
    const meta = parseSkillMarkdown(seed.slug, content);
    out.set(seed.slug, {
      seed,
      content,
      files: [],
      ...meta,
      author: 'OpenAI',
      githubSource: seed.sourceUrl.replace(
        'https://raw.githubusercontent.com/openai/skills/main/',
        `${SKILLS_REPO}/blob/main/`,
      ),
    });
  }

  const anthropicPdf = await fetchGithubSkillBundle(ANTHROPIC_PDF_SKILL);
  out.set('anthropic-pdf', {
    seed: {
      slug: 'anthropic-pdf',
      score: 9100,
      categorySlugs: ['documents'],
      sourceUrl: anthropicPdf.source.normalized,
    },
    content: anthropicPdf.content,
    files: anthropicPdf.files,
    name: 'Anthropic PDF',
    description:
      anthropicPdf.description ||
      'PDF skill bundle from anthropics/skills, including its helper scripts and references.',
    author: anthropicPdf.author || 'Anthropic',
    githubSource: anthropicPdf.source.normalized,
  });
  return out;
}

async function ensureSmokeWorkspace(): Promise<{ id: string; ownerId: string }> {
  const email = 'smoke@example.com';
  const passwordHash = await hashPassword('password123');
  const user = await db.user.upsert({
    where: { email },
    update: { name: 'Smoke Test', passwordHash },
    create: {
      email,
      name: 'Smoke Test',
      passwordHash,
    },
  });

  const workspace = await db.workspace.upsert({
    where: { slug: 'smoke' },
    update: { name: 'Smoke Test', ownerId: user.id },
    create: {
      slug: 'smoke',
      name: 'Smoke Test',
      ownerId: user.id,
    },
  });

  await db.membership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    update: { role: 'owner' },
    create: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });

  return { id: workspace.id, ownerId: user.id };
}

async function clearMcpAndSkillData() {
  await db.$transaction([
    db.skillInvocation.deleteMany(),
    db.syncEvent.deleteMany(),
    db.requestLog.deleteMany(),
    db.toolkitInstallLink.deleteMany(),
    db.apiToken.deleteMany({ where: { name: { startsWith: 'ToolPlane plugin - ' } } }),
    db.agentServer.deleteMany(),
    db.agentSkill.deleteMany(),
    db.agentToolkit.deleteMany(),
    db.toolkitServer.deleteMany(),
    db.toolkitSkill.deleteMany(),
    db.toolkit.deleteMany(),
    db.deployment.deleteMany(),
    db.installedSkill.deleteMany(),
    db.dailySnapshot.deleteMany({ where: { entityType: { in: ['server', 'skill'] } } }),
    db.scrapeCheckpoint.deleteMany({
      where: { job: { in: ['servers', 'server-details', 'home-flags', 'skills'] } },
    }),
    db.server.deleteMany(),
    db.skill.deleteMany(),
  ]);
}

async function seedCategories() {
  const out = new Map<string, string>();
  for (const c of categories) {
    const row = await db.category.upsert({
      where: { slug: c.slug },
      update: { name: c.name },
      create: c,
      select: { id: true, slug: true },
    });
    out.set(row.slug, row.id);
  }
  return out;
}

function categoryConnect(categoryIds: Map<string, string>, slugs: string[]) {
  return slugs.map((slug) => {
    const id = categoryIds.get(slug);
    if (!id) throw new Error(`missing category ${slug}`);
    return { id };
  });
}

async function seedServers(categoryIds: Map<string, string>) {
  const out = new Map<string, string>();
  for (const s of servers) {
    const recipe = {
      source: s.source,
      ref: s.ref,
      env: [],
      ...(s.slug === 'modelcontextprotocol-filesystem'
        ? { network: 'none' as const }
        : {}),
    };
    const row = await db.server.create({
      data: {
        slug: s.slug,
        name: s.name,
        author: s.author,
        description: s.description,
        stars: s.stars,
        isOfficial: true,
        isFeatured: s.verifiedTools !== null,
        curated: true,
        installCfg: recipe as Prisma.InputJsonValue,
        verifiedAt: s.verifiedTools === null ? null : new Date(),
        verifiedTools: s.verifiedTools,
        readme: `Imported from ${s.readmeUrl}\n\nRepository: ${MCP_REPO}`,
        categories: { connect: categoryConnect(categoryIds, s.categorySlugs) },
      },
      select: { id: true, slug: true },
    });
    out.set(row.slug, row.id);
  }
  return out;
}

async function seedSkills(categoryIds: Map<string, string>, loadedSkills: Map<string, LoadedSkill>) {
  const out = new Map<
    string,
    {
      id: string;
      content: string;
      files: SkillBundleFile[];
      name: string;
      description: string;
      sourceUrl: string;
    }
  >();
  for (const [slug, loaded] of loadedSkills) {
    const s = loaded.seed;
    const row = await db.skill.create({
      data: {
        slug,
        name: loaded.name,
        author: loaded.author,
        description: loaded.description,
        content: loaded.content,
        ...(loaded.files.length ? { files: loaded.files as Prisma.InputJsonValue } : {}),
        githubSource: loaded.githubSource,
        score: s.score,
        curated: true,
        categories: { connect: categoryConnect(categoryIds, s.categorySlugs) },
      },
      select: { id: true, slug: true },
    });
    out.set(row.slug, {
      id: row.id,
      content: loaded.content,
      files: loaded.files,
      name: loaded.name,
      description: loaded.description,
      sourceUrl: s.sourceUrl,
    });
  }
  return out;
}

async function seedSmokeToolkit(
  workspaceId: string,
  serverIds: Map<string, string>,
  skillData: Map<
    string,
    {
      id: string;
      content: string;
      files: SkillBundleFile[];
      name: string;
      description: string;
      sourceUrl: string;
    }
  >,
) {
  const toolkit = await db.toolkit.create({
    data: {
      workspaceId,
      slug: 'me',
      name: 'Real MCP + Skills',
      visibility: 'private',
      enabled: true,
    },
    select: { id: true },
  });

  for (const slug of [
    'modelcontextprotocol-fetch',
    'modelcontextprotocol-memory',
    'modelcontextprotocol-sequential-thinking',
    'modelcontextprotocol-time',
  ]) {
    const serverId = serverIds.get(slug);
    if (!serverId) continue;
    const s = servers.find((server) => server.slug === slug);
    if (!s) continue;
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        serverId,
        status: 'stopped',
        source: s.source,
        sourceRef: s.ref,
        installCfg: { env: {} } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await db.toolkitServer.create({
      data: { toolkitId: toolkit.id, deploymentId: deployment.id },
    });
  }

  for (const slug of ['openai-docs', 'playwright', 'anthropic-pdf', 'security-threat-model']) {
    const s = skillData.get(slug);
    if (!s) continue;
    const installed = await db.installedSkill.create({
      data: {
        workspaceId,
        skillId: null,
        name: s.name,
        slug,
        description: s.description,
        content: s.content,
        ...(s.files.length ? { files: s.files as Prisma.InputJsonValue } : {}),
        source: 'github',
        sourceRef: s.sourceUrl,
        status: 'published',
        userInvocable: true,
        agentInvocable: true,
        effort: 'default',
      },
      select: { id: true },
    });
    await db.toolkitSkill.create({
      data: { toolkitId: toolkit.id, installedSkillId: installed.id },
    });
  }
}

async function main() {
  console.log('Fetching real OpenAI curated skills...');
  const loadedSkills = await loadSkills();

  console.log('Clearing MCP/Skill-related data...');
  await clearMcpAndSkillData();

  console.log('Seeding categories...');
  const categoryIds = await seedCategories();

  console.log('Importing real MCP servers from modelcontextprotocol/servers...');
  const serverIds = await seedServers(categoryIds);

  console.log('Importing real OpenAI curated skills...');
  const skillData = await seedSkills(categoryIds, loadedSkills);

  console.log('Ensuring smoke workspace and real toolkit...');
  const smoke = await ensureSmokeWorkspace();
  await seedSmokeToolkit(smoke.id, serverIds, skillData);

  const counts = {
    servers: await db.server.count(),
    skills: await db.skill.count(),
    deployments: await db.deployment.count(),
    installedSkills: await db.installedSkill.count(),
    toolkits: await db.toolkit.count(),
    toolkitServers: await db.toolkitServer.count(),
    toolkitSkills: await db.toolkitSkill.count(),
  };
  console.table(counts);
  console.log('Smoke login: smoke@example.com / password123');
  console.log('Smoke toolkit: /app/smoke/toolkits/me');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
