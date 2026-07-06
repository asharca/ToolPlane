import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

type CategorySeed = { slug: string; name: string };
type ServerSeed = {
  slug: string;
  name: string;
  author: string;
  description: string;
  stars: number;
  categorySlugs: string[];
  source?: 'npm' | 'pypi' | 'docker';
  ref?: string;
  env?: string[];
  envValues?: Record<string, string>;
  startCommand?: string;
  network?: 'none';
  verifiedTools: number | null;
  sourceUrl: string;
  notes?: string;
};

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const categories: CategorySeed[] = [
  { slug: 'files', name: 'Files' },
  { slug: 'web', name: 'Web' },
  { slug: 'search', name: 'Search' },
  { slug: 'developer-tools', name: 'Developer Tools' },
  { slug: 'memory', name: 'Memory' },
  { slug: 'reasoning', name: 'Reasoning' },
  { slug: 'productivity', name: 'Productivity' },
  { slug: 'databases', name: 'Databases' },
  { slug: 'communication', name: 'Communication' },
  { slug: 'browser-automation', name: 'Browser Automation' },
  { slug: 'testing', name: 'Testing' },
];

const servers: ServerSeed[] = [
  {
    slug: 'modelcontextprotocol-fetch',
    name: 'Fetch',
    author: 'Model Context Protocol',
    description: 'Fetch URLs and convert web content into clean markdown for agents.',
    stars: 9800,
    categorySlugs: ['web', 'developer-tools'],
    source: 'pypi',
    ref: 'mcp-server-fetch',
    verifiedTools: 1,
    sourceUrl: 'https://pypi.org/project/mcp-server-fetch/',
  },
  {
    slug: 'firecrawl',
    name: 'Firecrawl',
    author: 'Firecrawl',
    description: 'Search, scrape, crawl, map, and extract structured data from websites. Supports Firecrawl Cloud or self-hosted Firecrawl.',
    stars: 9700,
    categorySlugs: ['web', 'search', 'developer-tools'],
    source: 'npm',
    ref: 'firecrawl-mcp',
    env: ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL'],
    verifiedTools: 12,
    sourceUrl: 'https://github.com/firecrawl/firecrawl-mcp-server',
    notes: 'FIRECRAWL_API_KEY unlocks the full tool set. FIRECRAWL_API_URL is optional for self-hosted Firecrawl.',
  },
  {
    slug: 'modelcontextprotocol-brave-search',
    name: 'Brave Search',
    author: 'Model Context Protocol',
    description: 'Search the web and local business listings through the Brave Search API.',
    stars: 9600,
    categorySlugs: ['web', 'search'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-brave-search',
    env: ['BRAVE_API_KEY'],
    verifiedTools: 2,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search',
  },
  {
    slug: 'github-mcp-server',
    name: 'GitHub',
    author: 'GitHub',
    description: 'Official GitHub MCP server for repositories, issues, pull requests, code search, and GitHub automation.',
    stars: 9500,
    categorySlugs: ['developer-tools'],
    source: 'docker',
    ref: 'ghcr.io/github/github-mcp-server',
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    verifiedTools: 40,
    sourceUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    slug: 'modelcontextprotocol-git',
    name: 'Git',
    author: 'Model Context Protocol',
    description: 'Read, search, and manipulate Git repositories from an MCP client.',
    stars: 9300,
    categorySlugs: ['developer-tools'],
    source: 'pypi',
    ref: 'mcp-server-git',
    verifiedTools: 10,
    sourceUrl: 'https://pypi.org/project/mcp-server-git/',
  },
  {
    slug: 'modelcontextprotocol-memory',
    name: 'Memory',
    author: 'Model Context Protocol',
    description: 'Persistent agent memory through a local knowledge graph of entities, relations, and observations.',
    stars: 9200,
    categorySlugs: ['memory', 'productivity'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-memory',
    verifiedTools: 9,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-memory',
  },
  {
    slug: 'modelcontextprotocol-sequential-thinking',
    name: 'Sequential Thinking',
    author: 'Model Context Protocol',
    description: 'Structured step-by-step reasoning support for planning, debugging, and complex problem solving.',
    stars: 9100,
    categorySlugs: ['reasoning', 'productivity'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-sequential-thinking',
    verifiedTools: 1,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking',
  },
  {
    slug: 'modelcontextprotocol-time',
    name: 'Time',
    author: 'Model Context Protocol',
    description: 'Current time queries and timezone conversion tools for agents.',
    stars: 9000,
    categorySlugs: ['productivity'],
    source: 'pypi',
    ref: 'mcp-server-time',
    verifiedTools: 2,
    sourceUrl: 'https://pypi.org/project/mcp-server-time/',
  },
  {
    slug: 'modelcontextprotocol-slack',
    name: 'Slack',
    author: 'Model Context Protocol',
    description: 'Read channels, post messages, reply in threads, and interact with Slack workspaces through a bot token.',
    stars: 8800,
    categorySlugs: ['communication', 'productivity'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-slack',
    env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS'],
    verifiedTools: 8,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-slack',
    notes: 'SLACK_CHANNEL_IDS is optional. Leave it empty to allow the server default behavior.',
  },
  {
    slug: 'modelcontextprotocol-puppeteer',
    name: 'Puppeteer',
    author: 'Model Context Protocol',
    description: 'Browser automation MCP for navigating pages, screenshots, clicking, forms, and JavaScript evaluation.',
    stars: 8600,
    categorySlugs: ['browser-automation', 'web', 'testing'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-puppeteer',
    verifiedTools: 7,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-puppeteer',
  },
  {
    slug: 'modelcontextprotocol-everything',
    name: 'Everything',
    author: 'Model Context Protocol',
    description: 'Reference MCP server that exercises many protocol capabilities for client testing.',
    stars: 8300,
    categorySlugs: ['developer-tools', 'testing'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-everything',
    verifiedTools: 8,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-everything',
  },
  {
    slug: 'modelcontextprotocol-filesystem',
    name: 'Filesystem',
    author: 'Model Context Protocol',
    description: 'Read, write, list, move, and search files within allowed directories.',
    stars: 8200,
    categorySlugs: ['files', 'developer-tools'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-filesystem',
    network: 'none',
    verifiedTools: null,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
    notes: 'Requires allowed directory arguments or MCP Roots support; ToolPlane recipe args support is not enabled yet.',
  },
  {
    slug: 'modelcontextprotocol-postgres',
    name: 'Postgres',
    author: 'Model Context Protocol',
    description: 'Inspect PostgreSQL database schemas and expose table schema resources to agents.',
    stars: 8100,
    categorySlugs: ['databases', 'developer-tools'],
    source: 'npm',
    ref: '@modelcontextprotocol/server-postgres',
    verifiedTools: null,
    sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-postgres',
    notes: 'Requires a PostgreSQL connection string argument; ToolPlane recipe args support is not enabled yet.',
  },
];

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL environment variable is not set.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function recipeFor(server: ServerSeed): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!server.source || !server.ref) return Prisma.JsonNull;
  return {
    source: server.source,
    ref: server.ref,
    env: server.env ?? [],
    ...(server.envValues ? { envValues: server.envValues } : {}),
    ...(server.startCommand ? { startCommand: server.startCommand } : {}),
    ...(server.network ? { network: server.network } : {}),
  } as Prisma.InputJsonValue;
}

function readmeFor(server: ServerSeed): string {
  return [
    `Imported from ${server.sourceUrl}`,
    '',
    server.notes ? `Notes: ${server.notes}` : null,
    server.source && server.ref ? `Recipe: ${server.source} ${server.ref}` : null,
    server.env?.length ? `Environment: ${server.env.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

async function ensureCategories(db: PrismaClient | null) {
  const out = new Map<string, string>();
  if (!db) {
    for (const category of categories) out.set(category.slug, category.slug);
    return out;
  }

  for (const category of categories) {
    const row = await db.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: category,
      select: { id: true, slug: true },
    });
    out.set(row.slug, row.id);
  }
  return out;
}

function categoryConnections(categoryIds: Map<string, string>, slugs: string[]) {
  return slugs.map((slug) => {
    const id = categoryIds.get(slug);
    if (!id) throw new Error(`Missing category: ${slug}`);
    return { id };
  });
}

async function upsertServers(db: PrismaClient | null, categoryIds: Map<string, string>) {
  const now = new Date();
  const out: { slug: string; deployable: boolean; env: string[] }[] = [];

  for (const server of servers) {
    const deployable = server.verifiedTools !== null;
    const data = {
      name: server.name,
      author: server.author,
      description: server.description,
      stars: server.stars,
      isOfficial: ['Model Context Protocol', 'GitHub'].includes(server.author),
      isFeatured: deployable,
      curated: true,
      installCfg: recipeFor(server),
      verifiedAt: deployable ? now : null,
      verifiedTools: server.verifiedTools,
      readme: readmeFor(server),
      categories: { set: categoryConnections(categoryIds, server.categorySlugs) },
    };

    if (db) {
      await db.server.upsert({
        where: { slug: server.slug },
        update: data,
        create: {
          slug: server.slug,
          ...data,
          categories: { connect: categoryConnections(categoryIds, server.categorySlugs) },
        },
      });
    }

    out.push({ slug: server.slug, deployable, env: server.env ?? [] });
    console.log(`${DRY_RUN ? 'would upsert' : 'upserted'} ${server.slug}${deployable ? ' deployable' : ' catalog-only'}`);
  }

  return out;
}

async function main() {
  const db = DRY_RUN ? null : createClient();
  try {
    const categoryIds = await ensureCategories(db);
    const imported = await upsertServers(db, categoryIds);
    const deployable = imported.filter((row) => row.deployable).length;
    console.log(`${DRY_RUN ? 'Prepared' : 'Imported'} ${imported.length} MCP servers (${deployable} deployable).`);
  } finally {
    await db?.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
