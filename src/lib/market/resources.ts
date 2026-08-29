import 'server-only';

import { Prisma, type Deployment, type MarketInstall, type Toolkit } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { validateServerRecipe } from '@/lib/admin/recipe-validate';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
  type MarketSecretScan,
} from '@/lib/market/secret-scan';
import { stopProcess } from '@/lib/process/supervisor';
import { removeDeploymentContainer } from '@/lib/process/deployment-runtime-container';
import { removeDeploymentConfigVolume } from '@/lib/process/deployment-config-volume';
import { runMcpDeploymentOperation } from '@/lib/workspace/mcp-operation';
import {
  buildSkillReleaseManifest,
  parseSkillReleaseManifest,
  SKILL_MARKET_MANIFEST_VERSION,
  type SkillReleaseManifestV1,
  type SkillReleaseSource,
} from '@/lib/market/skill-manifest';
import {
  approveMarketRelease,
  installSkillRelease,
  MarketError,
  updateSkillMarketInstall,
} from '@/lib/market/skills';
import { isValidMcpRef, type McpSource } from '@/lib/workspace/custom-mcp';
import {
  missingRequiredEnvironment,
  parseServerRecipe,
  recipeToDeploymentData,
  storedRequiredEnvironment,
  type ServerRecipe,
} from '@/lib/workspace/server-recipe';
import {
  parseMcpToolCatalog,
  parseMcpToolCatalogResult,
  hasMcpToolCatalog,
  hasVerifiedMcpToolCatalog,
  readMcpToolCatalog,
  withMcpToolCatalog,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';

export const RESOURCE_MARKET_MANIFEST_VERSION = 1 as const;

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/);
const sourceUrlSchema = z.string().max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
});
const listingSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  summary: z.string().max(4_000).nullable(),
  iconUrl: z.string().max(2_000).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  author: z.string().min(1).max(240),
}).strict();
const recipeSchema = z.object({
  source: z.enum(['npm', 'pypi', 'github', 'docker', 'remote']),
  ref: z.string().min(1).max(2_000),
  sourceUrl: sourceUrlSchema.optional(),
  env: z.array(environmentName).max(256),
  startCommand: z.string().min(1).max(4_000).optional(),
  network: z.literal('none').optional(),
  transport: z.enum(['streamable-http', 'sse']).optional(),
  authType: z.enum(['none', 'bearer', 'headers']).optional(),
  bearerEnv: environmentName.optional(),
  headerEnv: z.record(headerName, environmentName)
    .refine((value) => Object.keys(value).length <= 20)
    .optional(),
}).strict().transform((value, ctx) => {
  const parsed = parseServerRecipe(value);
  if (!parsed) {
    ctx.addIssue({ code: 'custom', message: 'Invalid MCP recipe.' });
    return z.NEVER;
  }
  return {
    source: parsed.source,
    ref: parsed.ref,
    ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
    env: parsed.env,
    ...(parsed.startCommand ? { startCommand: parsed.startCommand } : {}),
    ...(parsed.network === 'none' ? { network: 'none' as const } : {}),
    ...(parsed.transport ? { transport: parsed.transport } : {}),
    ...(parsed.authType ? { authType: parsed.authType } : {}),
    ...(parsed.bearerEnv ? { bearerEnv: parsed.bearerEnv } : {}),
    ...(parsed.headerEnv ? { headerEnv: parsed.headerEnv } : {}),
  };
});
const mcpDefinitionSchema = z.object({
  name: z.string().min(1).max(240),
  slug: z.string().min(1).max(120),
  description: z.string().max(20_000).nullable(),
  author: z.string().max(240).nullable(),
  iconUrl: z.string().max(2_000).nullable(),
  readme: z.string().max(500_000).nullable(),
  catalogSlug: z.string().min(1).max(120).optional(),
  recipe: recipeSchema,
  toolExposure: z.enum(['all', 'allowlist']),
  allowedTools: z.array(z.string().min(1).max(240)).max(1_000),
  toolCatalog: z.array(z.unknown()).max(1_000).transform(parseMcpToolCatalog).optional(),
}).strict();

const mcpManifestSchema = z.object({
  schemaVersion: z.literal(RESOURCE_MARKET_MANIFEST_VERSION),
  kind: z.literal('mcp'),
  listing: listingSchema,
  mcp: mcpDefinitionSchema,
}).strict();

const toolkitManifestSchema = z.object({
  schemaVersion: z.literal(RESOURCE_MARKET_MANIFEST_VERSION),
  kind: z.literal('toolkit'),
  listing: listingSchema,
  toolkit: z.object({
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
  }).strict(),
  mcps: z.array(mcpDefinitionSchema.extend({
    catalogSlug: z.string().min(1).max(120),
  }).strict()).max(256),
  skills: z.array(z.object({
    catalogSlug: z.string().min(1).max(120).optional(),
    snapshot: z.custom<SkillReleaseManifestV1['skill']>(),
  }).strict()).max(256),
}).strict();

export type McpMarketManifestV1 = z.infer<typeof mcpManifestSchema>;
export type ToolkitMarketManifestV1 = z.infer<typeof toolkitManifestSchema>;
export type ResourceMarketManifestV1 = McpMarketManifestV1 | ToolkitMarketManifestV1;

function scanToolkitMarketManifest(
  manifest: ToolkitMarketManifestV1,
  releaseNotes?: string | null,
): MarketSecretScan {
  const artifactScan = scanMarketArtifact(manifest, releaseNotes);
  const decodedFindings = manifest.skills.flatMap(({ snapshot }, index) => (
    scanSkillReleaseManifest({
      schemaVersion: SKILL_MARKET_MANIFEST_VERSION,
      kind: 'skill',
      skill: snapshot,
    }).findings.map((finding) => ({
      ...finding,
      path: `manifest.skills[${index}].snapshot.${finding.path.replace(/^manifest\.skill\.?/, '')}`,
    }))
  ));
  const findings = [...artifactScan.findings, ...decodedFindings];
  return { ...artifactScan, status: findings.length ? 'blocked' : 'passed', findings };
}

type ListingInput = {
  slug?: string;
  name?: string;
  summary?: string | null;
  iconUrl?: string | null;
  tags?: string[];
};

type DeploymentSource = {
  id: string;
  workspaceId: string;
  serverId: string | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
  mcpToolExposure: 'all' | 'allowlist';
  mcpAllowedTools: string[];
  server: null | {
    slug: string;
    name: string;
    author: string | null;
    description: string | null;
    iconUrl: string | null;
    installCfg: unknown;
    verifiedAt: Date | null;
    verifiedTools: number | null;
    readme: string | null;
  };
};

const DEPLOYMENT_SELECT = {
  id: true,
  workspaceId: true,
  serverId: true,
  name: true,
  source: true,
  sourceRef: true,
  installCfg: true,
  mcpToolExposure: true,
  mcpAllowedTools: true,
  server: {
    select: {
      slug: true,
      name: true,
      author: true,
      description: true,
      iconUrl: true,
      installCfg: true,
      verifiedAt: true,
      verifiedTools: true,
      readme: true,
    },
  },
} satisfies Prisma.DeploymentSelect;

const TOOLKIT_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  slug: true,
  servers: {
    orderBy: { deploymentId: 'asc' },
    select: { deployment: { select: DEPLOYMENT_SELECT } },
  },
  skills: {
    orderBy: { installedSkillId: 'asc' },
    select: {
      installedSkill: {
        select: {
          skillId: true,
          name: true,
          slug: true,
          description: true,
          content: true,
          files: true,
          source: true,
          sourceRef: true,
          userInvocable: true,
          agentInvocable: true,
          effort: true,
          skill: {
            select: {
              name: true,
              slug: true,
              description: true,
              author: true,
              content: true,
              files: true,
              githubSource: true,
              sourceSha: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ToolkitSelect;

function slugify(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || fallback;
}

function cleanTags(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim().toLocaleLowerCase().slice(0, 40))
    .filter(Boolean))]
    .slice(0, 20);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function portableRecipe(recipe: ServerRecipe) {
  return {
    source: recipe.source,
    ref: recipe.ref,
    ...(recipe.sourceUrl ? { sourceUrl: recipe.sourceUrl } : {}),
    env: sortedUnique([...recipe.env, ...Object.keys(recipe.envValues ?? {})]),
    ...(recipe.startCommand ? { startCommand: recipe.startCommand } : {}),
    ...(recipe.network === 'none' ? { network: 'none' as const } : {}),
    ...(recipe.transport ? { transport: recipe.transport } : {}),
    ...(recipe.authType ? { authType: recipe.authType } : {}),
    ...(recipe.bearerEnv ? { bearerEnv: recipe.bearerEnv } : {}),
    ...(recipe.headerEnv ? { headerEnv: recipe.headerEnv } : {}),
  };
}

function isPrismaError(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && codes.includes(error.code),
  );
}

function installConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function portableMcp(source: DeploymentSource, fallbackAuthor: string) {
  const catalogRecipe = parseServerRecipe(source.server?.installCfg);
  let recipe: ServerRecipe | null = catalogRecipe;
  if (!recipe) {
    if (
      !source.source
      || !['npm', 'pypi', 'github', 'docker', 'remote'].includes(source.source)
      || !source.sourceRef
      || !isValidMcpRef(source.source as McpSource, source.sourceRef)
    ) {
      throw new MarketError('invalid_manifest', 'This MCP does not have a portable package recipe.');
    }
    const config = installConfig(source.installCfg);
    const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? Object.keys(config.env as Record<string, unknown>)
      : [];
    recipe = {
      source: source.source as McpSource,
      ref: source.sourceRef,
      env: sortedUnique([...env, ...storedRequiredEnvironment(source.installCfg)]),
      ...(typeof config.startCommand === 'string' && config.startCommand.trim()
        ? { startCommand: config.startCommand.trim() }
        : {}),
      ...(config.network === 'none' ? { network: 'none' as const } : {}),
      ...(source.source === 'remote' && config.transport === 'sse'
        ? { transport: 'sse' as const }
        : source.source === 'remote'
          ? { transport: 'streamable-http' as const }
          : {}),
      ...(source.source === 'remote'
        && (config.authType === 'bearer' || config.authType === 'headers')
        ? { authType: config.authType }
        : source.source === 'remote'
          ? { authType: 'none' as const }
          : {}),
      ...(source.source === 'remote' && typeof config.bearerEnv === 'string'
        ? { bearerEnv: config.bearerEnv }
        : {}),
      ...(source.source === 'remote' && config.headerEnv && typeof config.headerEnv === 'object'
        ? { headerEnv: config.headerEnv as Record<string, string> }
        : {}),
    };
  }

  // Environment values are deliberately converted to names. Even values marked
  // public by a catalog recipe must be re-entered by the installer.
  const requiredEnvironment = sortedUnique([
    ...recipe.env,
    ...Object.keys(recipe.envValues ?? {}),
  ]);
  const name = (source.server?.name || source.name || source.sourceRef || 'MCP server').slice(0, 240);
  // Runtime tools are untrusted output and may encode configured credentials.
  // Only the catalog validation snapshot, collected with throwaway values, is publishable.
  const catalogHasTools = hasVerifiedMcpToolCatalog(source.server);
  const catalogTools = readMcpToolCatalog(source.server?.installCfg);
  const catalogToolNames = new Set(catalogTools.map(({ name: toolName }) => toolName));
  return mcpDefinitionSchema.parse({
    name,
    slug: slugify(source.server?.slug || name, 'mcp-server'),
    description: source.server?.description ?? null,
    author: source.server?.author ?? fallbackAuthor,
    iconUrl: source.server?.iconUrl ?? null,
    readme: source.server?.readme ?? null,
    ...(source.server ? { catalogSlug: source.server.slug } : {}),
    recipe: { ...portableRecipe(recipe), env: requiredEnvironment },
    toolExposure: source.mcpToolExposure,
    allowedTools: sortedUnique(source.mcpAllowedTools.filter((toolName) => catalogToolNames.has(toolName))),
    ...(catalogHasTools ? { toolCatalog: catalogTools } : {}),
  });
}

function parseManifest<T>(schema: z.ZodType<T>, raw: unknown, checksum?: string): T {
  let rawSize = 0;
  try {
    rawSize = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    throw new MarketError('invalid_manifest', 'The market release manifest is invalid.');
  }
  if (rawSize > 4_000_000) {
    throw new MarketError('invalid_manifest', 'The market release manifest is too large.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new MarketError('invalid_manifest', 'The market release manifest is invalid.');
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 4_000_000) {
    throw new MarketError('invalid_manifest', 'The market release manifest is too large.');
  }
  if (checksum && marketReleaseChecksum(parsed.data) !== checksum) {
    throw new MarketError('invalid_manifest', 'The market release checksum does not match.');
  }
  return parsed.data;
}

export function parseMcpMarketManifest(raw: unknown, checksum?: string): McpMarketManifestV1 {
  return parseManifest(mcpManifestSchema, raw, checksum);
}

export function parseToolkitMarketManifest(raw: unknown, checksum?: string): ToolkitMarketManifestV1 {
  const manifest = parseManifest(toolkitManifestSchema, raw, checksum);
  return {
    ...manifest,
    skills: manifest.skills.map((skill) => ({
      ...skill,
      snapshot: parseSkillReleaseManifest({
        schemaVersion: SKILL_MARKET_MANIFEST_VERSION,
        kind: 'skill',
        skill: skill.snapshot,
      }).skill,
    })),
  };
}

export function parseResourceMarketManifest(raw: unknown, checksum?: string): ResourceMarketManifestV1 {
  const kind = raw && typeof raw === 'object' && !Array.isArray(raw) && 'kind' in raw
    ? (raw as { kind?: unknown }).kind
    : null;
  if (kind === 'mcp') return parseMcpMarketManifest(raw, checksum);
  if (kind === 'toolkit') return parseToolkitMarketManifest(raw, checksum);
  throw new MarketError('invalid_manifest', 'This market release kind is not supported.');
}

function trustedMcpAllowedTools(allowedTools: readonly string[], installCfg: unknown): string[] {
  const catalogNames = new Set(readMcpToolCatalog(installCfg).map(({ name }) => name));
  return sortedUnique(allowedTools.filter((name) => catalogNames.has(name)));
}

function trustedMcpToolCatalog(
  installCfg: unknown,
): McpMarketManifestV1['mcp']['toolCatalog'] {
  return hasMcpToolCatalog(installCfg) ? readMcpToolCatalog(installCfg) : undefined;
}

function withoutPublicMcpTools<
  T extends {
    allowedTools: string[];
    toolCatalog?: McpMarketManifestV1['mcp']['toolCatalog'];
  },
>(definition: T): T {
  const projected = { ...definition, allowedTools: [] };
  delete projected.toolCatalog;
  return projected;
}

/** Public discovery never exposes tools before a Connector is linked through a running sandbox. */
export function projectPublicResourceMarketManifest(
  manifest: ResourceMarketManifestV1,
): ResourceMarketManifestV1 {
  if (manifest.kind === 'mcp') {
    return {
      ...manifest,
      mcp: withoutPublicMcpTools(manifest.mcp),
    };
  }

  return {
    ...manifest,
    mcps: manifest.mcps.map(withoutPublicMcpTools),
  };
}

async function assertPublisherAccess(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [
        { ownerId: userId },
        { members: { some: { userId, role: { in: ['owner', 'admin'] } } } },
      ],
    },
    select: { id: true, slug: true, name: true },
  });
  if (!workspace) throw new MarketError('not_authorized', 'Only a workspace owner or admin can publish.');
  return workspace;
}

async function assertInstallerAccess(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const workspace = await tx.workspace.findFirst({
    where: { id: workspaceId, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    select: { id: true },
  });
  if (!workspace) throw new MarketError('not_authorized', 'Workspace access was denied.');
}

async function validatedCategoryIds(tx: Prisma.TransactionClient, values: readonly string[]) {
  const ids = values.map((value) => value.trim()).filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new MarketError('invalid_categories', 'Select at least one unique market category.');
  }
  const count = await tx.category.count({ where: { id: { in: ids } } });
  if (count !== ids.length) throw new MarketError('invalid_categories', 'A market category was not found.');
  return ids;
}

async function uniqueListingSlug(
  tx: Prisma.TransactionClient,
  namespace: string,
  desired: string,
  existingId?: string,
) {
  const base = slugify(desired, 'resource');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const slug = suffix ? `${base}-${suffix + 1}` : base;
    const conflict = await tx.marketListing.findFirst({
      where: { namespace, slug, ...(existingId ? { id: { not: existingId } } : {}) },
      select: { id: true },
    });
    if (!conflict) return slug;
  }
  throw new MarketError('listing_conflict', 'Could not allocate a unique market slug.');
}

async function submitRelease<T extends ResourceMarketManifestV1>(
  tx: Prisma.TransactionClient,
  listing: { id: string; latestVersion: number; latestReleaseId: string | null; pendingReleaseId: string | null; status: string },
  manifest: T,
  summary: Prisma.InputJsonObject,
  scanResult: MarketSecretScan,
  categoryIds: string[],
  releaseNotes?: string | null,
) {
  if (listing.pendingReleaseId) {
    await tx.marketRelease.updateMany({
      where: { id: listing.pendingReleaseId, reviewStatus: 'pending' },
      data: {
        reviewStatus: 'rejected',
        reviewedAt: new Date(),
        reviewNote: 'Superseded by a newer publisher submission.',
      },
    });
  }
  const version = listing.latestVersion + 1;
  const release = await tx.marketRelease.create({
    data: {
      listingId: listing.id,
      version,
      manifestVersion: RESOURCE_MARKET_MANIFEST_VERSION,
      manifest: manifest as Prisma.InputJsonValue,
      releaseSummary: summary,
      checksum: marketReleaseChecksum(manifest),
      releaseNotes: releaseNotes?.trim().slice(0, 10_000) || null,
      categoryIds,
      scanResult: scanResult as Prisma.InputJsonValue,
      reviewStatus: 'pending',
    },
  });
  const submitted = await tx.marketListing.update({
    where: { id: listing.id },
    data: {
      latestVersion: version,
      pendingReleaseId: release.id,
      status: listing.latestReleaseId ? listing.status : 'draft',
    },
  });
  return { listing: submitted, release, manifest };
}

export async function publishMcpRelease(input: {
  workspaceId: string;
  deploymentId: string;
  publishedById: string;
  categoryIds: string[];
  listing?: ListingInput;
  releaseNotes?: string | null;
}) {
  try {
    return await db.$transaction(async (tx) => {
      const workspace = await assertPublisherAccess(tx, input.workspaceId, input.publishedById);
      const categoryIds = await validatedCategoryIds(tx, input.categoryIds);
      const source = await tx.deployment.findFirst({
        where: {
          id: input.deploymentId,
          workspaceId: input.workspaceId,
          OR: [{ source: null }, { source: { not: 'sandbox' } }],
        },
        select: DEPLOYMENT_SELECT,
      });
      if (!source) throw new MarketError('source_not_found', 'The source MCP was not found.');
      const existing = await tx.marketListing.findUnique({ where: { sourceDeploymentId: source.id } });
      if (existing && existing.publisherWorkspaceId !== input.workspaceId) {
        throw new MarketError('listing_conflict', 'This MCP is already listed by another workspace.');
      }
      if (source.serverId && !existing) {
        throw new MarketError('listing_conflict', 'Catalog MCPs are already represented in the market.');
      }

      const mcp = portableMcp(source, workspace.name);
      const listingSlug = existing?.latestReleaseId
        ? existing.slug
        : await uniqueListingSlug(tx, workspace.slug, input.listing?.slug || mcp.slug, existing?.id);
      const candidate = listingSchema.parse({
        slug: listingSlug,
        name: input.listing?.name?.trim().slice(0, 240) || mcp.name,
        summary: input.listing?.summary?.trim().slice(0, 4_000) || mcp.description,
        iconUrl: input.listing?.iconUrl?.trim().slice(0, 2_000) || mcp.iconUrl,
        tags: cleanTags(input.listing?.tags),
        author: mcp.author || workspace.name,
      });
      const manifest = parseMcpMarketManifest({
        schemaVersion: RESOURCE_MARKET_MANIFEST_VERSION,
        kind: 'mcp',
        listing: candidate,
        mcp,
      });
      const scanResult = scanMarketArtifact(manifest, input.releaseNotes);
      if (scanResult.status === 'blocked') {
        throw new MarketError('invalid_manifest', 'Remove credentials from the MCP before publishing it.');
      }
      const metadata = {
        author: candidate.author,
        source: mcp.recipe.source,
        requiredEnvironmentCount: mcp.recipe.env.length,
        toolCount: mcp.toolCatalog?.length ?? mcp.allowedTools.length,
      } satisfies Prisma.InputJsonObject;
      const listing = existing
        ? await tx.marketListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              sourceDeploymentId: source.id,
              ...(!existing.latestReleaseId ? {
                slug: listingSlug,
                name: candidate.name,
                summary: candidate.summary,
                iconUrl: candidate.iconUrl,
                tags: candidate.tags,
                metadata,
                categories: { set: categoryIds.map((id) => ({ id })) },
              } : {}),
            },
          })
        : await tx.marketListing.create({
            data: {
              kind: 'mcp',
              namespace: workspace.slug,
              slug: listingSlug,
              publisherKind: 'workspace',
              publisherWorkspaceId: workspace.id,
              publishedById: input.publishedById,
              sourceDeploymentId: source.id,
              name: candidate.name,
              summary: candidate.summary,
              iconUrl: candidate.iconUrl,
              tags: candidate.tags,
              metadata,
              categories: { connect: categoryIds.map((id) => ({ id })) },
            },
          });
      return submitRelease(tx, listing, manifest, {
        source: mcp.recipe.source,
        requiredEnvironmentCount: mcp.recipe.env.length,
        allowedToolCount: mcp.allowedTools.length,
      }, scanResult, categoryIds, input.releaseNotes);
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof MarketError) throw error;
    if (isPrismaError(error, ['P2002', 'P2034'])) {
      throw new MarketError('listing_conflict', 'The listing changed while it was being published.');
    }
    throw error;
  }
}

export async function publishToolkitRelease(input: {
  workspaceId: string;
  toolkitId: string;
  publishedById: string;
  categoryIds: string[];
  listing?: ListingInput;
  releaseNotes?: string | null;
}) {
  try {
    return await db.$transaction(async (tx) => {
      const workspace = await assertPublisherAccess(tx, input.workspaceId, input.publishedById);
      const categoryIds = await validatedCategoryIds(tx, input.categoryIds);
      const source = await tx.toolkit.findFirst({
        where: { id: input.toolkitId, workspaceId: input.workspaceId },
        select: TOOLKIT_SELECT,
      });
      if (!source) throw new MarketError('source_not_found', 'The source toolkit was not found.');
      const existing = await tx.marketListing.findUnique({ where: { sourceToolkitId: source.id } });
      if (existing && existing.publisherWorkspaceId !== input.workspaceId) {
        throw new MarketError('listing_conflict', 'This toolkit is already listed elsewhere.');
      }
      const mcps = source.servers.map(({ deployment }) => {
        if (!hasVerifiedMcpToolCatalog(deployment.server)) {
          throw new MarketError('invalid_manifest', 'Toolkits may publish only verified catalog MCPs.');
        }
        const mcp = portableMcp(deployment, workspace.name);
        if (!mcp.catalogSlug || mcp.toolCatalog === undefined) {
          throw new MarketError('invalid_manifest', 'Toolkits may publish only catalog MCPs.');
        }
        return { ...mcp, catalogSlug: mcp.catalogSlug };
      });
      const skills = source.skills.map(({ installedSkill }) => ({
        ...(installedSkill.skill?.slug ? { catalogSlug: installedSkill.skill.slug } : {}),
        snapshot: buildSkillReleaseManifest(installedSkill as SkillReleaseSource).skill,
      }));
      const listingSlug = existing?.latestReleaseId
        ? existing.slug
        : await uniqueListingSlug(tx, workspace.slug, input.listing?.slug || source.slug, existing?.id);
      const candidate = listingSchema.parse({
        slug: listingSlug,
        name: input.listing?.name?.trim().slice(0, 240) || source.name,
        summary: input.listing?.summary?.trim().slice(0, 4_000) || null,
        iconUrl: input.listing?.iconUrl?.trim().slice(0, 2_000) || null,
        tags: cleanTags(input.listing?.tags),
        author: workspace.name,
      });
      const manifest = parseToolkitMarketManifest({
        schemaVersion: RESOURCE_MARKET_MANIFEST_VERSION,
        kind: 'toolkit',
        listing: candidate,
        toolkit: { name: source.name, slug: source.slug },
        mcps,
        skills,
      });
      const scanResult = scanToolkitMarketManifest(manifest, input.releaseNotes);
      if (scanResult.status === 'blocked') {
        throw new MarketError('invalid_manifest', 'Remove credentials from the toolkit before publishing it.');
      }
      const metadata = {
        author: workspace.name,
        mcpCount: mcps.length,
        skillCount: skills.length,
      } satisfies Prisma.InputJsonObject;
      const listing = existing
        ? await tx.marketListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              ...(!existing.latestReleaseId ? {
                slug: listingSlug,
                name: candidate.name,
                summary: candidate.summary,
                iconUrl: candidate.iconUrl,
                tags: candidate.tags,
                metadata,
                categories: { set: categoryIds.map((id) => ({ id })) },
              } : {}),
            },
          })
        : await tx.marketListing.create({
            data: {
              kind: 'toolkit',
              namespace: workspace.slug,
              slug: listingSlug,
              publisherKind: 'workspace',
              publisherWorkspaceId: workspace.id,
              publishedById: input.publishedById,
              sourceToolkitId: source.id,
              name: candidate.name,
              summary: candidate.summary,
              iconUrl: candidate.iconUrl,
              tags: candidate.tags,
              metadata,
              categories: { connect: categoryIds.map((id) => ({ id })) },
            },
          });
      return submitRelease(tx, listing, manifest, {
        mcpCount: mcps.length,
        skillCount: skills.length,
        toolCount: mcps.length + skills.length,
      }, scanResult, categoryIds, input.releaseNotes);
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof MarketError) throw error;
    if (isPrismaError(error, ['P2002', 'P2034'])) {
      throw new MarketError('listing_conflict', 'The listing changed while it was being published.');
    }
    throw error;
  }
}

async function uniqueServerSlug(tx: Prisma.TransactionClient, namespace: string, desired: string) {
  const base = slugify(`${namespace}-${desired}`, 'community-mcp');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const slug = suffix ? `${base}-${suffix + 1}` : base;
    if (!(await tx.server.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  throw new MarketError('listing_conflict', 'Could not allocate a catalog MCP slug.');
}

type ReviewInput = {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
  categoryIds?: string[];
};

export async function approveResourceMarketRelease(input: ReviewInput) {
  const reviewCandidate = await db.marketRelease.findUnique({
    where: { id: input.releaseId },
    select: {
      id: true,
      listingId: true,
      reviewStatus: true,
      manifest: true,
      checksum: true,
      releaseNotes: true,
      listing: {
        select: {
          kind: true,
          pendingReleaseId: true,
          sourceServer: {
            select: {
              id: true,
              installCfg: true,
              verifiedAt: true,
              verifiedTools: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });
  if (reviewCandidate?.listing.kind !== 'mcp' && reviewCandidate?.listing.kind !== 'toolkit') {
    return approveMarketRelease(input);
  }

  let validatedMcp: {
    checksum: string;
    sourceServerId: string | null;
    sourceServerUpdatedAt: Date | null;
    tools: McpToolDefinition[];
  } | null = null;
  if (reviewCandidate.listing.kind === 'mcp') {
    const admin = await db.user.findFirst({
      where: { id: input.reviewedById, role: 'admin', status: 'active' },
      select: { id: true },
    });
    if (!admin) throw new MarketError('not_authorized', 'Administrator access is required.');
    if (
      reviewCandidate.listingId !== input.listingId
      || reviewCandidate.reviewStatus !== 'pending'
      || reviewCandidate.listing.pendingReleaseId !== reviewCandidate.id
    ) {
      throw new MarketError('release_not_found', 'The pending release was not found.');
    }
    const manifest = parseResourceMarketManifest(reviewCandidate.manifest, reviewCandidate.checksum);
    if (manifest.kind !== 'mcp') {
      throw new MarketError('invalid_manifest', 'The release kind does not match its listing.');
    }
    if (scanMarketArtifact(manifest, reviewCandidate.releaseNotes).status === 'blocked') {
      throw new MarketError('invalid_manifest', 'The release contains possible credentials.');
    }
    const sourceServer = reviewCandidate.listing.sourceServer;
    const sourceRecipe = sourceServer ? parseServerRecipe(sourceServer.installCfg) : null;
    if (sourceServer && !sourceRecipe) {
      throw new MarketError('invalid_manifest', 'The source catalog MCP has no valid recipe.');
    }
    if (sourceRecipe) {
      const currentRecipe = portableRecipe(sourceRecipe);
      const submittedRecipe = portableRecipe(manifest.mcp.recipe);
      if (JSON.stringify(currentRecipe) !== JSON.stringify(submittedRecipe)) {
        throw new MarketError('invalid_manifest', 'The source MCP recipe changed after submission.');
      }
    }
    let tools = sourceServer && hasVerifiedMcpToolCatalog(sourceServer)
      ? readMcpToolCatalog(sourceServer.installCfg)
      : null;
    if (!tools) {
      const recipe = sourceRecipe ?? manifest.mcp.recipe;
      const result = await validateServerRecipe(recipe);
      const catalog = result.ok ? parseMcpToolCatalogResult(result.toolCatalog) : null;
      if (!result.ok || !catalog?.ok || catalog.tools.length !== result.toolCount) {
        throw new MarketError(
          'invalid_manifest',
          `Could not capture a complete MCP tool catalog: ${result.ok ? 'invalid tools/list response' : result.error}`,
        );
      }
      tools = catalog.tools;
    }
    if (scanMarketArtifact({
      ...manifest,
      mcp: { ...manifest.mcp, toolCatalog: tools },
    }, reviewCandidate.releaseNotes).status === 'blocked') {
      throw new MarketError('invalid_manifest', 'The MCP tool catalog contains possible credentials.');
    }
    validatedMcp = {
      checksum: reviewCandidate.checksum,
      sourceServerId: sourceServer?.id ?? null,
      sourceServerUpdatedAt: sourceServer?.updatedAt ?? null,
      tools,
    };
  }

  return db.$transaction(async (tx) => {
    const admin = await tx.user.findFirst({
      where: { id: input.reviewedById, role: 'admin', status: 'active' },
      select: { id: true },
    });
    if (!admin) throw new MarketError('not_authorized', 'Administrator access is required.');
    const release = await tx.marketRelease.findFirst({
      where: { id: input.releaseId, listingId: input.listingId, reviewStatus: 'pending' },
      include: {
        listing: {
          select: {
            id: true,
            kind: true,
            namespace: true,
            pendingReleaseId: true,
            publishedAt: true,
            publisherWorkspaceId: true,
            sourceServerId: true,
            sourceDeploymentId: true,
            sourceToolkitId: true,
          },
        },
      },
    });
    if (!release || release.listing.pendingReleaseId !== release.id) {
      throw new MarketError('release_not_found', 'The pending release was not found.');
    }
    const manifest = parseResourceMarketManifest(release.manifest, release.checksum);
    if (manifest.kind !== release.listing.kind) {
      throw new MarketError('invalid_manifest', 'The release kind does not match its listing.');
    }
    const scanResult = manifest.kind === 'toolkit'
      ? scanToolkitMarketManifest(manifest, release.releaseNotes)
      : scanMarketArtifact(manifest, release.releaseNotes);
    if (scanResult.status === 'blocked') {
      throw new MarketError('invalid_manifest', 'The release contains possible credentials.');
    }
    const categoryIds = await validatedCategoryIds(tx, input.categoryIds ?? release.categoryIds);
    const categorySet = { set: categoryIds.map((id) => ({ id })) };
    let sourceServerId = release.listing.sourceServerId;
    let metadata: Prisma.InputJsonObject;
    if (manifest.kind === 'mcp') {
      if (
        !validatedMcp
        || validatedMcp.checksum !== release.checksum
        || validatedMcp.sourceServerId !== sourceServerId
      ) {
        throw new MarketError('release_not_found', 'The pending release changed during validation.');
      }
      let server = sourceServerId
        ? await tx.server.findUnique({ where: { id: sourceServerId } })
        : null;
      if (
        server
        && validatedMcp.sourceServerUpdatedAt?.getTime() !== server.updatedAt.getTime()
      ) {
        throw new MarketError('release_not_found', 'The source MCP changed during validation.');
      }
      if (!server) {
        const slug = await uniqueServerSlug(tx, release.listing.namespace, manifest.mcp.slug);
        server = await tx.server.create({
          data: {
            slug,
            name: manifest.mcp.name,
            author: manifest.mcp.author,
            description: manifest.mcp.description,
            iconUrl: manifest.mcp.iconUrl,
            readme: manifest.mcp.readme,
            installCfg: withMcpToolCatalog(manifest.mcp.recipe, validatedMcp.tools) as Prisma.InputJsonValue,
            verifiedAt: new Date(),
            verifiedTools: validatedMcp.tools.length,
            categories: { connect: categoryIds.map((id) => ({ id })) },
          },
        });
        sourceServerId = server.id;
        if (release.listing.sourceDeploymentId) {
          await tx.deployment.updateMany({
            where: {
              id: release.listing.sourceDeploymentId,
              workspaceId: release.listing.publisherWorkspaceId ?? undefined,
              serverId: null,
            },
            data: { serverId: server.id },
          });
        }
      } else {
        const recipe = parseServerRecipe(server.installCfg);
        if (!recipe) throw new MarketError('invalid_manifest', 'The source catalog MCP has no valid recipe.');
        await tx.server.update({
          where: { id: server.id },
          data: {
            installCfg: withMcpToolCatalog(server.installCfg, validatedMcp.tools) as Prisma.InputJsonValue,
            verifiedAt: server.verifiedAt ?? new Date(),
            verifiedTools: validatedMcp.tools.length,
            categories: categorySet,
          },
        });
      }
      metadata = {
        author: manifest.listing.author,
        source: manifest.mcp.recipe.source,
        requiredEnvironmentCount: manifest.mcp.recipe.env.length,
        toolCount: validatedMcp.tools.length,
      };
    } else {
      if (!release.listing.sourceToolkitId) {
        throw new MarketError('source_not_found', 'The source toolkit was not found.');
      }
      const catalogServers = await tx.server.findMany({
        where: { slug: { in: manifest.mcps.map(({ catalogSlug }) => catalogSlug) } },
        select: { slug: true, installCfg: true, verifiedAt: true, verifiedTools: true },
      });
      const catalogServerBySlug = new Map(catalogServers.map((server) => [server.slug, server]));
      if (manifest.mcps.some(({ catalogSlug }) => (
        !hasVerifiedMcpToolCatalog(catalogServerBySlug.get(catalogSlug))
      ))) {
        throw new MarketError('invalid_manifest', 'The toolkit contains an MCP without a verified tool catalog.');
      }
      const updated = await tx.toolkit.updateMany({
        where: {
          id: release.listing.sourceToolkitId,
          workspaceId: release.listing.publisherWorkspaceId ?? undefined,
        },
        data: { visibility: 'public', enabled: true },
      });
      if (updated.count !== 1) throw new MarketError('source_not_found', 'The source toolkit was not found.');
      await tx.toolkit.update({
        where: { id: release.listing.sourceToolkitId },
        data: { categories: categorySet },
      });
      metadata = {
        author: manifest.listing.author,
        mcpCount: manifest.mcps.length,
        skillCount: manifest.skills.length,
      };
    }
    const publishedAt = new Date();
    await tx.marketRelease.update({
      where: { id: release.id },
      data: {
        reviewStatus: 'approved',
        reviewedById: admin.id,
        reviewedAt: publishedAt,
        reviewNote: input.reviewNote?.trim().slice(0, 4_000) || null,
        scanResult: scanResult as Prisma.InputJsonValue,
        publishedAt,
      },
    });
    return tx.marketListing.update({
      where: { id: release.listing.id },
      data: {
        slug: manifest.listing.slug,
        name: manifest.listing.name,
        summary: manifest.listing.summary,
        iconUrl: manifest.listing.iconUrl,
        tags: manifest.listing.tags,
        metadata,
        ...(sourceServerId ? { sourceServerId } : {}),
        categories: categorySet,
        status: 'published',
        latestReleaseId: release.id,
        pendingReleaseId: null,
        publishedAt: release.listing.publishedAt ?? publishedAt,
      },
    });
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
}

async function approvedRelease(tx: Prisma.TransactionClient, releaseId: string, kind: 'mcp' | 'toolkit') {
  const release = await tx.marketRelease.findUnique({
    where: { id: releaseId },
    include: {
      listing: {
        select: {
          id: true,
          kind: true,
          namespace: true,
          slug: true,
          status: true,
          latestReleaseId: true,
          sourceServerId: true,
          categories: { select: { id: true } },
        },
      },
    },
  });
  if (
    !release || release.listing.kind !== kind || release.listing.status !== 'published'
    || release.reviewStatus !== 'approved' || release.listing.latestReleaseId !== release.id
  ) {
    throw new MarketError('listing_unavailable', `This ${kind} release is not available for installation.`);
  }
  return release;
}

async function reusedInstall(
  tx: Prisma.TransactionClient,
  input: { releaseId: string; targetWorkspaceId: string; idempotencyKey: string },
  resource: 'deployment' | 'toolkit',
) {
  const existing = await tx.marketInstall.findUnique({
    where: {
      targetWorkspaceId_idempotencyKey: {
        targetWorkspaceId: input.targetWorkspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { deployment: true, toolkit: true },
  });
  if (!existing) return null;
  const attached = resource === 'deployment' ? existing.deployment : existing.toolkit;
  if (existing.requestedReleaseId !== input.releaseId || !attached) {
    throw new MarketError('idempotency_conflict', 'This idempotency key has already been used.');
  }
  return { install: existing, resource: attached, reused: true as const };
}

function validIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) throw new MarketError('idempotency_conflict', 'A valid idempotency key is required.');
  return key;
}

function assertRemoteMcpRecipe(recipe: Pick<ServerRecipe, 'source'>) {
  if (recipe.source !== 'remote') {
    throw new MarketError('listing_unavailable', 'Market Server entries are informational; only Connectors can be installed.');
  }
}

export async function installMcpRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
}): Promise<{ install: MarketInstall; resource: Deployment; reused: boolean }> {
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await assertInstallerAccess(tx, input.targetWorkspaceId, input.installedById);
        const release = await approvedRelease(tx, input.releaseId, 'mcp');
        const manifest = parseMcpMarketManifest(release.manifest, release.checksum);
        assertRemoteMcpRecipe(manifest.mcp.recipe);
        const reused = await reusedInstall(tx, { ...input, idempotencyKey }, 'deployment');
        if (reused) {
          if (!('installCfg' in reused.resource)) {
            throw new MarketError('idempotency_conflict', 'This idempotency key belongs to another resource.');
          }
          return { ...reused, resource: reused.resource as Deployment };
        }
        const existing = await tx.marketInstall.findUnique({
          where: {
            targetWorkspaceId_listingId: {
              targetWorkspaceId: input.targetWorkspaceId,
              listingId: release.listing.id,
            },
          },
        });
        if (existing) throw new MarketError('already_installed', 'This market MCP is already installed.');
        if (!release.listing.sourceServerId) {
          throw new MarketError('listing_unavailable', 'The reviewed MCP has no catalog identity.');
        }
        const server = await tx.server.findFirst({
          where: { id: release.listing.sourceServerId, verifiedAt: { not: null } },
          select: { id: true, installCfg: true, verifiedAt: true, verifiedTools: true },
        });
        if (!server || !hasVerifiedMcpToolCatalog(server)) {
          throw new MarketError('listing_unavailable', 'The reviewed catalog MCP is unavailable.');
        }
        const trustedCatalog = trustedMcpToolCatalog(server.installCfg);
        const data = recipeToDeploymentData({
          ...manifest.mcp.recipe,
          ...(trustedCatalog !== undefined ? { toolCatalog: trustedCatalog } : {}),
        });
        const requiresSetup = missingRequiredEnvironment(manifest.mcp.recipe, data.installCfg).length > 0;
        if (await tx.deployment.findUnique({
          where: { workspaceId_serverId: { workspaceId: input.targetWorkspaceId, serverId: server.id } },
          select: { id: true },
        })) {
          throw new MarketError('already_installed', 'This MCP already exists in the target workspace.');
        }
        const deployment = await tx.deployment.create({
          data: {
            workspaceId: input.targetWorkspaceId,
            serverId: server.id,
            source: data.source,
            sourceRef: data.sourceRef,
            installCfg: data.installCfg as Prisma.InputJsonValue,
            status: requiresSetup ? 'setup_required' : 'stopped',
            mcpToolExposure: manifest.mcp.toolExposure,
            mcpAllowedTools: trustedMcpAllowedTools(manifest.mcp.allowedTools, server.installCfg),
          },
        });
        const install = await tx.marketInstall.create({
          data: {
            listingId: release.listing.id,
            currentReleaseId: release.id,
            requestedReleaseId: release.id,
            targetWorkspaceId: input.targetWorkspaceId,
            installedById: input.installedById,
            deploymentId: deployment.id,
            idempotencyKey,
            status: requiresSetup ? 'setup_required' : 'ready',
            requirements: { environment: manifest.mcp.recipe.env },
            resourceMap: { deploymentId: deployment.id },
            lastCheckedAt: new Date(),
          },
        });
        await tx.marketListing.update({
          where: { id: release.listing.id },
          data: { installCount: { increment: 1 } },
        });
        return { install, resource: deployment, reused: false as const };
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (!isPrismaError(error, ['P2002', 'P2034']) || attempt === 2) throw error;
    }
  }
  throw new MarketError('listing_conflict', 'The market install changed. Try again.');
}

async function uniqueToolkitSlug(tx: Prisma.TransactionClient, workspaceId: string, desired: string) {
  const base = slugify(desired, 'toolkit');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const slug = suffix ? `${base}-${suffix + 1}` : base;
    if (!(await tx.toolkit.findUnique({ where: { workspaceId_slug: { workspaceId, slug } }, select: { id: true } }))) {
      return slug;
    }
  }
  throw new MarketError('listing_conflict', 'Could not allocate a toolkit slug.');
}

export async function installToolkitRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
}): Promise<{ install: MarketInstall; resource: Toolkit; reused: boolean }> {
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await assertInstallerAccess(tx, input.targetWorkspaceId, input.installedById);
        const reused = await reusedInstall(tx, { ...input, idempotencyKey }, 'toolkit');
        if (reused) {
          if (!('slug' in reused.resource)) {
            throw new MarketError('idempotency_conflict', 'This idempotency key belongs to another resource.');
          }
          return { ...reused, resource: reused.resource as Toolkit };
        }
        const release = await approvedRelease(tx, input.releaseId, 'toolkit');
        const existing = await tx.marketInstall.findUnique({
          where: {
            targetWorkspaceId_listingId: {
              targetWorkspaceId: input.targetWorkspaceId,
              listingId: release.listing.id,
            },
          },
        });
        if (existing) throw new MarketError('already_installed', 'This market toolkit is already installed.');
        const manifest = parseToolkitMarketManifest(release.manifest, release.checksum);
        const servers = await tx.server.findMany({
          where: { slug: { in: manifest.mcps.map((mcp) => mcp.catalogSlug) }, verifiedAt: { not: null } },
          select: { id: true, slug: true, installCfg: true, verifiedAt: true, verifiedTools: true },
        });
        if (
          servers.length !== new Set(manifest.mcps.map((mcp) => mcp.catalogSlug)).size
          || servers.some((server) => !hasVerifiedMcpToolCatalog(server))
        ) {
          throw new MarketError('listing_unavailable', 'A reviewed toolkit MCP is unavailable.');
        }
        const serverBySlug = new Map(servers.map((server) => [server.slug, server]));
        const deploymentIds: string[] = [];
        const ownedDeploymentIds: string[] = [];
        let requiresSetup = false;
        for (const mcp of manifest.mcps) {
          const server = serverBySlug.get(mcp.catalogSlug)!;
          const existingDeployment = await tx.deployment.findUnique({
            where: { workspaceId_serverId: { workspaceId: input.targetWorkspaceId, serverId: server.id } },
          });
          const trustedCatalog = trustedMcpToolCatalog(server.installCfg);
          const data = existingDeployment
            ? preservedRecipeConfig(mcp.recipe, existingDeployment.installCfg, trustedCatalog)
            : recipeToDeploymentData({
                ...mcp.recipe,
                ...(trustedCatalog !== undefined ? { toolCatalog: trustedCatalog } : {}),
              });
          const mcpRequiresSetup = missingRequiredEnvironment(mcp.recipe, data.installCfg).length > 0;
          requiresSetup ||= mcpRequiresSetup;
          const deployment = existingDeployment ?? await tx.deployment.create({
            data: {
              workspaceId: input.targetWorkspaceId,
              serverId: server.id,
              source: data.source,
              sourceRef: data.sourceRef,
              installCfg: data.installCfg as Prisma.InputJsonValue,
              status: mcpRequiresSetup ? 'setup_required' : 'stopped',
              mcpToolExposure: mcp.toolExposure,
              mcpAllowedTools: trustedMcpAllowedTools(mcp.allowedTools, server.installCfg),
            },
          });
          if (!existingDeployment) ownedDeploymentIds.push(deployment.id);
          deploymentIds.push(deployment.id);
        }
        const installedSkillIds: string[] = [];
        for (const skill of manifest.skills) {
          const installed = await tx.installedSkill.create({
            data: {
              workspaceId: input.targetWorkspaceId,
              skillId: null,
              name: skill.snapshot.name,
              slug: skill.snapshot.slug,
              description: skill.snapshot.description,
              content: skill.snapshot.content,
              files: skill.snapshot.files as Prisma.InputJsonValue,
              source: 'market',
              sourceRef: `${release.listing.namespace}/${release.listing.slug}@${release.version}`,
              status: 'published',
              userInvocable: skill.snapshot.userInvocable,
              agentInvocable: skill.snapshot.agentInvocable,
              effort: skill.snapshot.effort,
            },
          });
          installedSkillIds.push(installed.id);
        }
        const slug = await uniqueToolkitSlug(tx, input.targetWorkspaceId, manifest.toolkit.slug);
        const toolkit = await tx.toolkit.create({
          data: {
            workspaceId: input.targetWorkspaceId,
            name: manifest.toolkit.name,
            slug,
            visibility: 'private',
            enabled: true,
            categories: { connect: release.listing.categories },
            servers: { create: deploymentIds.map((deploymentId) => ({ deploymentId })) },
            skills: { create: installedSkillIds.map((installedSkillId) => ({ installedSkillId })) },
          },
        });
        const install = await tx.marketInstall.create({
          data: {
            listingId: release.listing.id,
            currentReleaseId: release.id,
            requestedReleaseId: release.id,
            targetWorkspaceId: input.targetWorkspaceId,
            installedById: input.installedById,
            toolkitId: toolkit.id,
            idempotencyKey,
            status: requiresSetup ? 'setup_required' : 'ready',
            requirements: {
              environment: manifest.mcps.flatMap((mcp) => (
                mcp.recipe.env.map((name) => ({ catalogSlug: mcp.catalogSlug, name }))
              )),
            },
            resourceMap: {
              deploymentIds,
              ownedDeploymentIds,
              installedSkillIds,
              ownedInstalledSkillIds: installedSkillIds,
              toolkitId: toolkit.id,
            },
            lastCheckedAt: new Date(),
          },
        });
        await tx.marketListing.update({
          where: { id: release.listing.id },
          data: { installCount: { increment: 1 } },
        });
        return { install, resource: toolkit, reused: false as const };
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (!isPrismaError(error, ['P2002', 'P2034']) || attempt === 2) throw error;
    }
  }
  throw new MarketError('listing_conflict', 'The market install changed. Try again.');
}

export async function installMarketRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
}) {
  const release = await db.marketRelease.findUnique({
    where: { id: input.releaseId },
    select: { listing: { select: { kind: true } } },
  });
  if (release?.listing.kind === 'skill') {
    const result = await installSkillRelease(input);
    return { install: result.install, kind: 'skill' as const, resource: result.installedSkill, reused: result.reused };
  }
  if (release?.listing.kind === 'mcp') {
    const result = await installMcpRelease(input);
    return {
      install: result.install,
      kind: 'mcp' as const,
      resource: result.resource,
      reused: result.reused,
    };
  }
  if (release?.listing.kind === 'toolkit') {
    const result = await installToolkitRelease(input);
    return {
      install: result.install,
      kind: 'toolkit' as const,
      resource: result.resource,
      reused: result.reused,
    };
  }
  throw new MarketError('listing_unavailable', 'This market release cannot be installed.');
}

function preservedRecipeConfig(
  recipe: McpMarketManifestV1['mcp']['recipe'],
  current: unknown,
  toolCatalog?: McpMarketManifestV1['mcp']['toolCatalog'],
) {
  const currentConfig = installConfig(current);
  const currentEnvironment = currentConfig.env && typeof currentConfig.env === 'object' && !Array.isArray(currentConfig.env)
    ? currentConfig.env as Record<string, unknown>
    : {};
  const data = recipeToDeploymentData(recipe);
  data.installCfg.env = Object.fromEntries(recipe.env.map((name) => [
    name,
    typeof currentEnvironment[name] === 'string' ? currentEnvironment[name] : '',
  ]));
  if (toolCatalog !== undefined) data.installCfg.toolCatalog = toolCatalog;
  return data;
}

function resourceIds(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((id): id is string => typeof id === 'string')
    : [];
}

function toolkitSkillIdentity(skill: ToolkitMarketManifestV1['skills'][number]): string {
  return skill.catalogSlug ? `catalog:${skill.catalogSlug}` : `snapshot:${skill.snapshot.slug}`;
}

async function updateMcpInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
}) {
  const deploymentId = await db.$transaction(async (tx) => {
    await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
    const install = await tx.marketInstall.findFirst({
      where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
      select: {
        deploymentId: true,
        status: true,
        currentReleaseId: true,
        listing: { select: { id: true, kind: true, status: true, latestReleaseId: true } },
      },
    });
    if (!install?.deploymentId || install.listing.kind !== 'mcp') {
      throw new MarketError('install_not_found', 'The installed market MCP was not found.');
    }
    if (install.status === 'modified' && !input.force) {
      throw new MarketError('local_changes', 'The installed MCP has local changes.');
    }
    if (input.currentReleaseId && install.currentReleaseId !== input.currentReleaseId) {
      if (install.currentReleaseId === input.targetReleaseId) return install.deploymentId;
      throw new MarketError('listing_conflict', 'The installed version changed. Refresh and try again.');
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (!releaseId || install.listing.status !== 'published' || releaseId !== install.listing.latestReleaseId) {
      throw new MarketError('listing_conflict', 'The available release changed. Refresh and try again.');
    }
    const release = await tx.marketRelease.findFirst({
      where: { id: releaseId, listingId: install.listing.id, reviewStatus: 'approved' },
      select: { manifest: true, checksum: true },
    });
    if (!release) throw new MarketError('release_not_found', 'The requested update was not found.');
    assertRemoteMcpRecipe(parseMcpMarketManifest(release.manifest, release.checksum).mcp.recipe);
    return install.deploymentId;
  });
  const operation = await runMcpDeploymentOperation(
    input.targetWorkspaceId,
    deploymentId,
    async () => {
      await stopProcess(deploymentId);
      await removeDeploymentContainer(deploymentId);
      await removeDeploymentConfigVolume(deploymentId);
      return db.$transaction(async (tx) => {
        await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
        const install = await tx.marketInstall.findFirst({
      where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
      include: {
        deployment: true,
        listing: {
          select: { id: true, kind: true, status: true, latestReleaseId: true, sourceServerId: true },
        },
      },
    });
    if (!install?.deployment || install.listing.kind !== 'mcp') {
      throw new MarketError('install_not_found', 'The installed market MCP was not found.');
    }
    if (input.currentReleaseId && install.currentReleaseId !== input.currentReleaseId) {
      if (install.currentReleaseId === input.targetReleaseId) return install;
      throw new MarketError('listing_conflict', 'The installed version changed. Refresh and try again.');
    }
    if (install.status === 'modified' && !input.force) {
      throw new MarketError('local_changes', 'The installed MCP has local changes.');
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (!releaseId || install.listing.status !== 'published' || releaseId !== install.listing.latestReleaseId) {
      throw new MarketError('listing_conflict', 'The available release changed. Refresh and try again.');
    }
    const release = await tx.marketRelease.findFirst({
      where: { id: releaseId, listingId: install.listing.id, reviewStatus: 'approved' },
    });
    if (!release) throw new MarketError('release_not_found', 'The requested update was not found.');
    const manifest = parseMcpMarketManifest(release.manifest, release.checksum);
    assertRemoteMcpRecipe(manifest.mcp.recipe);
    const server = install.listing.sourceServerId
      ? await tx.server.findFirst({
          where: { id: install.listing.sourceServerId, verifiedAt: { not: null } },
          select: { installCfg: true, verifiedAt: true, verifiedTools: true },
        })
      : null;
    if (!server || !hasVerifiedMcpToolCatalog(server)) {
      throw new MarketError('listing_unavailable', 'The reviewed catalog MCP is unavailable.');
    }
    const data = preservedRecipeConfig(
      manifest.mcp.recipe,
      install.deployment.installCfg,
      trustedMcpToolCatalog(server?.installCfg),
    );
    const requiresSetup = missingRequiredEnvironment(manifest.mcp.recipe, data.installCfg).length > 0;
    await tx.deployment.update({
      where: { id: install.deployment.id },
      data: {
        source: data.source,
        sourceRef: data.sourceRef,
        installCfg: data.installCfg as Prisma.InputJsonValue,
        mcpToolExposure: manifest.mcp.toolExposure,
        mcpAllowedTools: trustedMcpAllowedTools(manifest.mcp.allowedTools, server?.installCfg),
        ...(requiresSetup
          ? { status: 'setup_required' }
          : install.deployment.status === 'setup_required' ? { status: 'stopped' } : {}),
      },
    });
        return tx.marketInstall.update({
      where: { id: install.id },
      data: {
        currentReleaseId: release.id,
        requestedReleaseId: release.id,
        ignoredReleaseId: null,
        status: requiresSetup ? 'setup_required' : 'ready',
        requirements: { environment: manifest.mcp.recipe.env },
        lastCheckedAt: new Date(),
        lastError: null,
      },
        });
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
    },
  );
  if (!operation.accepted) throw new MarketError('listing_conflict', 'The workspace is being deleted.');
  return operation.value;
}

async function updateToolkitInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
}) {
  return db.$transaction(async (tx) => {
    await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
    const install = await tx.marketInstall.findFirst({
      where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
      include: {
        toolkit: true,
        currentRelease: { select: { manifest: true, checksum: true } },
        listing: {
          select: {
            id: true,
            kind: true,
            namespace: true,
            slug: true,
            status: true,
            latestReleaseId: true,
            categories: { select: { id: true } },
          },
        },
      },
    });
    if (!install?.toolkit || install.listing.kind !== 'toolkit') {
      throw new MarketError('install_not_found', 'The installed market toolkit was not found.');
    }
    if (input.currentReleaseId && install.currentReleaseId !== input.currentReleaseId) {
      if (install.currentReleaseId === input.targetReleaseId) return install;
      throw new MarketError('listing_conflict', 'The installed version changed. Refresh and try again.');
    }
    if (install.status === 'modified' && !input.force) {
      throw new MarketError('local_changes', 'The installed toolkit has local changes.');
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (!releaseId || install.listing.status !== 'published' || releaseId !== install.listing.latestReleaseId) {
      throw new MarketError('listing_conflict', 'The available release changed. Refresh and try again.');
    }
    const release = await tx.marketRelease.findFirst({
      where: { id: releaseId, listingId: install.listing.id, reviewStatus: 'approved' },
    });
    if (!release) throw new MarketError('release_not_found', 'The requested update was not found.');
    const manifest = parseToolkitMarketManifest(release.manifest, release.checksum);
    const servers = await tx.server.findMany({
      where: { slug: { in: manifest.mcps.map((mcp) => mcp.catalogSlug) }, verifiedAt: { not: null } },
      select: { id: true, slug: true, installCfg: true, verifiedAt: true, verifiedTools: true },
    });
    if (
      servers.length !== new Set(manifest.mcps.map((mcp) => mcp.catalogSlug)).size
      || servers.some((server) => !hasVerifiedMcpToolCatalog(server))
    ) {
      throw new MarketError('listing_unavailable', 'A reviewed toolkit MCP is unavailable.');
    }
    const previousManifest = parseToolkitMarketManifest(
      install.currentRelease.manifest,
      install.currentRelease.checksum,
    );
    const previousOwnedDeploymentIds = new Set(resourceIds(install.resourceMap, 'ownedDeploymentIds'));
    const previousSkillIds = resourceIds(install.resourceMap, 'ownedInstalledSkillIds');
    const ownedSkillIds = previousSkillIds.length
      ? previousSkillIds
      : resourceIds(install.resourceMap, 'installedSkillIds');
    const existingOwnedSkills = new Set((await tx.installedSkill.findMany({
      where: { id: { in: ownedSkillIds }, workspaceId: input.targetWorkspaceId },
      select: { id: true },
    })).map(({ id }) => id));
    const previousSkills = new Map<string, string[]>();
    previousManifest.skills.forEach((skill, index) => {
      const installedSkillId = ownedSkillIds[index];
      if (!installedSkillId || !existingOwnedSkills.has(installedSkillId)) return;
      const identity = toolkitSkillIdentity(skill);
      previousSkills.set(identity, [...(previousSkills.get(identity) ?? []), installedSkillId]);
    });
    const serverBySlug = new Map(servers.map((server) => [server.slug, server]));
    const deploymentIds: string[] = [];
    const ownedDeploymentIds: string[] = [];
    let requiresSetup = false;
    for (const mcp of manifest.mcps) {
      const server = serverBySlug.get(mcp.catalogSlug)!;
      const current = await tx.deployment.findUnique({
        where: { workspaceId_serverId: { workspaceId: input.targetWorkspaceId, serverId: server.id } },
      });
      const data = preservedRecipeConfig(
        mcp.recipe,
        current?.installCfg,
        trustedMcpToolCatalog(server.installCfg),
      );
      const mcpRequiresSetup = missingRequiredEnvironment(mcp.recipe, data.installCfg).length > 0;
      requiresSetup ||= mcpRequiresSetup;
      const deployment = current && previousOwnedDeploymentIds.has(current.id)
        ? await tx.deployment.update({
            where: { id: current.id },
            data: {
              source: data.source,
              sourceRef: data.sourceRef,
              installCfg: data.installCfg as Prisma.InputJsonValue,
              mcpToolExposure: mcp.toolExposure,
              mcpAllowedTools: trustedMcpAllowedTools(mcp.allowedTools, server.installCfg),
              ...(mcpRequiresSetup
                ? { status: 'setup_required' }
                : current.status === 'setup_required' ? { status: 'stopped' } : {}),
            },
          })
        : current ?? await tx.deployment.create({
            data: {
              workspaceId: input.targetWorkspaceId,
              serverId: server.id,
              source: data.source,
              sourceRef: data.sourceRef,
              installCfg: data.installCfg as Prisma.InputJsonValue,
              status: mcpRequiresSetup ? 'setup_required' : 'stopped',
              mcpToolExposure: mcp.toolExposure,
              mcpAllowedTools: trustedMcpAllowedTools(mcp.allowedTools, server.installCfg),
            },
          });
      if (!current || previousOwnedDeploymentIds.has(deployment.id)) {
        ownedDeploymentIds.push(deployment.id);
      }
      deploymentIds.push(deployment.id);
    }
    const installedSkillIds: string[] = [];
    for (const skill of manifest.skills) {
      const reusableId = previousSkills.get(toolkitSkillIdentity(skill))?.shift();
      const data = {
          workspaceId: input.targetWorkspaceId,
          name: skill.snapshot.name,
          slug: skill.snapshot.slug,
          description: skill.snapshot.description,
          content: skill.snapshot.content,
          files: skill.snapshot.files as Prisma.InputJsonValue,
          source: 'market',
          sourceRef: `${install.listing.namespace}/${install.listing.slug}@${release.version}`,
          status: 'published',
          userInvocable: skill.snapshot.userInvocable,
          agentInvocable: skill.snapshot.agentInvocable,
          effort: skill.snapshot.effort,
      };
      const installed = reusableId
        ? await tx.installedSkill.update({
            where: { id: reusableId },
            data: {
              name: data.name,
              slug: data.slug,
              description: data.description,
              content: data.content,
              files: data.files,
              source: data.source,
              sourceRef: data.sourceRef,
              status: data.status,
              userInvocable: data.userInvocable,
              agentInvocable: data.agentInvocable,
              effort: data.effort,
            },
          })
        : await tx.installedSkill.create({ data });
      installedSkillIds.push(installed.id);
    }
    await Promise.all([
      tx.toolkitServer.deleteMany({ where: { toolkitId: install.toolkit.id } }),
      tx.toolkitSkill.deleteMany({ where: { toolkitId: install.toolkit.id } }),
    ]);
    await tx.toolkit.update({
      where: { id: install.toolkit.id },
      data: {
        name: manifest.toolkit.name,
        categories: { set: install.listing.categories },
        servers: { create: deploymentIds.map((deploymentId) => ({ deploymentId })) },
        skills: { create: installedSkillIds.map((installedSkillId) => ({ installedSkillId })) },
      },
    });
    const removedSkillIds = ownedSkillIds.filter((id) => !installedSkillIds.includes(id));
    if (removedSkillIds.length) {
      await tx.installedSkill.deleteMany({
        where: {
          id: { in: removedSkillIds },
          workspaceId: input.targetWorkspaceId,
          agentLinks: { none: {} },
          toolkitLinks: { none: {} },
          marketInstall: { is: null },
        },
      });
    }
    const retainedOwnedSkillIds = removedSkillIds.length
      ? (await tx.installedSkill.findMany({
          where: { id: { in: removedSkillIds }, workspaceId: input.targetWorkspaceId },
          select: { id: true },
        })).map(({ id }) => id)
      : [];
    return tx.marketInstall.update({
      where: { id: install.id },
      data: {
        currentReleaseId: release.id,
        requestedReleaseId: release.id,
        ignoredReleaseId: null,
        status: requiresSetup ? 'setup_required' : 'ready',
        requirements: {
          environment: manifest.mcps.flatMap((mcp) => (
            mcp.recipe.env.map((name) => ({ catalogSlug: mcp.catalogSlug, name }))
          )),
        },
        resourceMap: {
          deploymentIds,
          ownedDeploymentIds,
          installedSkillIds,
          ownedInstalledSkillIds: [...installedSkillIds, ...retainedOwnedSkillIds],
          toolkitId: install.toolkit.id,
        },
        lastCheckedAt: new Date(),
        lastError: null,
      },
    });
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
}

export async function updateMarketInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
}) {
  const install = await db.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
    select: { listing: { select: { kind: true } } },
  });
  if (install?.listing.kind === 'skill') return updateSkillMarketInstall(input);
  if (install?.listing.kind === 'mcp') return updateMcpInstall(input);
  if (install?.listing.kind === 'toolkit') return updateToolkitInstall(input);
  throw new MarketError('install_not_found', 'The market installation was not found.');
}
