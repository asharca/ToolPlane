import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import { db } from "@/lib/db";
import {
  isPlatformAgentListingOrigin,
  visibleAgentListingOrigin,
} from "@/lib/agents/market-visibility";
import { agentReleaseChecksum as calculateAgentReleaseChecksum } from "@/lib/agents/market-artifact";
import { createAgentRecords } from "@/lib/agents/mutations";
import { MAX_AGENT_MARKET_ENV_REQUIREMENTS } from "@/lib/agents/market-limits";
import { parseServerRecipe } from "@/lib/workspace/server-recipe";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { assertPortableMcpRecipe } from "@/lib/market/mcp-portable-recipe";
import { sealMcpEnvironment } from "@/lib/process/mcp-credentials";

export const AGENT_MARKET_MANIFEST_VERSION = 1 as const;

const MAX_GRAPH_AGENTS = 64;
const MAX_GRAPH_RESOURCES = 512;
const MAX_MANIFEST_BYTES = 4_000_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const modelRequirementSchema = z
  .object({
    format: z.string().min(1).max(64),
    model: z.string().min(1).max(240),
  })
  .strict();

const piRuntimeSchema = z
  .object({
    kind: z.literal("pi"),
  })
  .strict();

const portableAgentSchema = z
  .object({
    key: z.string().min(1).max(80),
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
    systemPrompt: z.string().max(200_000).nullable(),
    // Zero is accepted only long enough to verify legacy v1 checksums; parsed
    // manifests normalize it to the current default below.
    maxSteps: z.union([
      z.number().int().min(AGENT_STEP_BOUNDS.min).max(AGENT_STEP_BOUNDS.max),
      z.literal(0),
    ]),
    modelRequirement: modelRequirementSchema.nullable(),
    // Optional only for checksum-compatible parsing of legacy v1 releases.
    // Every newly published release writes an explicit Pi runtime.
    runtime: piRuntimeSchema.optional(),
    deploymentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
    skillKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
    toolkitKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
    subAgentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_AGENTS),
  })
  .strict();

const portableDeploymentSchema = z
  .object({
    key: z.string().min(1).max(80),
    name: z.string().min(1).max(240),
    catalogSlug: z.string().min(1).max(240),
    source: z.enum(["npm", "pypi", "github", "docker", "remote", "config"]),
    sourceRef: z.string().min(1).max(2000),
    requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(256),
    publicEnv: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.string().max(50_000),
    ),
    startCommand: z.string().min(1).max(4000).optional(),
    command: z.enum(["npx", "uvx", "uv", "docker"]).optional(),
    args: z.array(z.string().max(4000)).max(100).optional(),
    network: z.literal("none").optional(),
    transport: z.enum(["streamable-http", "sse"]).optional(),
    authType: z.enum(["none", "bearer", "headers"]).optional(),
    bearerEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    headerEnv: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/),
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .optional(),
    mcpToolExposure: z.enum(["all", "allowlist"]),
    mcpAllowedTools: z.array(z.string().min(1).max(240)).max(1000),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (definition.source !== "config") return;
    const recipe = parseServerRecipe({
      ...definition,
      ref: definition.sourceRef,
      env: definition.requiredEnv,
    });
    try {
      if (!recipe) throw new Error("Invalid portable MCP command recipe.");
      assertPortableMcpRecipe(recipe);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "Invalid portable MCP recipe.",
      });
    }
  });

const skillFileSchema = z
  .object({
    path: z.string().min(1).max(240),
    content: z.string().max(1_000_000),
    encoding: z.literal("base64").optional(),
  })
  .strict();

const portableSkillSchema = z
  .object({
    key: z.string().min(1).max(80),
    origin: z.enum(["catalog", "custom"]),
    catalogSlug: z.string().min(1).max(240).optional(),
    sourceSha: z.string().min(1).max(240).optional(),
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
    description: z.string().nullable(),
    content: z.string().max(1_000_000),
    files: z.array(skillFileSchema),
    userInvocable: z.boolean(),
    agentInvocable: z.boolean(),
    effort: z.string().min(1).max(64),
  })
  .strict();

const portableToolkitSchema = z
  .object({
    key: z.string().min(1).max(80),
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
    enabled: z.boolean(),
    deploymentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
    skillKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  })
  .strict();

const agentReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MARKET_MANIFEST_VERSION),
    rootAgentKey: z.string().min(1).max(80),
    agents: z.array(portableAgentSchema).min(1).max(MAX_GRAPH_AGENTS),
    deployments: z.array(portableDeploymentSchema).max(MAX_GRAPH_RESOURCES),
    skills: z.array(portableSkillSchema).max(MAX_GRAPH_RESOURCES),
    toolkits: z.array(portableToolkitSchema).max(MAX_GRAPH_RESOURCES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const environmentRequirementCount = manifest.deployments.reduce(
      (total, deployment) => total + deployment.requiredEnv.length,
      0,
    );
    if (environmentRequirementCount > MAX_AGENT_MARKET_ENV_REQUIREMENTS) {
      context.addIssue({
        code: "custom",
        path: ["deployments"],
        message: `Agent releases may require at most ${MAX_AGENT_MARKET_ENV_REQUIREMENTS} environment variables.`,
      });
    }
  });

const agentReleaseSummarySchema = z
  .object({
    agentCount: z.number().int().nonnegative(),
    subAgentCount: z.number().int().nonnegative(),
    deploymentCount: z.number().int().nonnegative(),
    skillCount: z.number().int().nonnegative(),
    toolkitCount: z.number().int().nonnegative(),
    resourceCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
    models: z.array(modelRequirementSchema),
    runtimes: z.array(z.enum(["native", "pi"])).min(1),
  })
  .strict();

const agentInstallRequirementsSchema = z
  .object({
    providers: z.array(
      z
        .object({
          agentKey: z.string(),
          format: z.string(),
          model: z.string(),
          satisfied: z.boolean(),
          providerId: z.string().optional(),
        })
        .strict(),
    ),
    environment: z
      .array(
        z
          .object({
            deploymentKey: z.string(),
            variable: z.string(),
            required: z.literal(true),
          })
          .strict(),
      )
      .max(MAX_AGENT_MARKET_ENV_REQUIREMENTS),
    legacyToolkitConversions: z
      .array(
        z
          .object({
            toolkitKey: z.string().min(1).max(80),
            name: z.string().min(1).max(240),
            agentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_AGENTS),
            requiresPrivatePackageConversion: z.literal(true),
            requiresReauthorization: z.literal(true),
          })
          .strict(),
      )
      .max(MAX_GRAPH_RESOURCES)
      .default([]),
  })
  .strict();

const agentInstallResourceMapSchema = z
  .object({
    agents: z.record(z.string(), z.string()),
    deployments: z.record(z.string(), z.string()),
    skills: z.record(z.string(), z.string()),
    toolkits: z.record(z.string(), z.string()),
    sandboxes: z.record(z.string(), z.string()).default({}),
    sandboxDeployments: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type AgentModelRequirement = z.infer<typeof modelRequirementSchema>;
export type PortableAgentDefinition = z.infer<typeof portableAgentSchema>;
export type PortableDeploymentDefinition = z.infer<
  typeof portableDeploymentSchema
>;
export type PortableSkillDefinition = z.infer<typeof portableSkillSchema>;
export type PortableToolkitDefinition = z.infer<typeof portableToolkitSchema>;
export type AgentReleaseManifestV1 = z.infer<typeof agentReleaseManifestSchema>;
export type AgentReleaseSummary = z.infer<typeof agentReleaseSummarySchema>;
export type AgentInstallRequirements = z.infer<
  typeof agentInstallRequirementsSchema
>;
export type AgentInstallResourceMap = z.infer<
  typeof agentInstallResourceMapSchema
>;

export type AgentMarketErrorCode =
  | "not_authorized"
  | "agent_not_found"
  | "not_portable"
  | "listing_not_found"
  | "listing_conflict"
  | "release_not_found"
  | "listing_unavailable"
  | "invalid_manifest"
  | "invalid_categories"
  | "idempotency_conflict"
  | "target_workspace_not_found"
  | "install_failed";

export class AgentMarketError extends Error {
  readonly code: AgentMarketErrorCode;
  readonly details?: unknown;

  constructor(code: AgentMarketErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentMarketError";
    this.code = code;
    this.details = details;
  }
}

export type AgentMarketListingSummary = {
  id: string;
  slug: string;
  directorySlug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  categories: { slug: string; name: string }[];
  curated: boolean;
  isFeatured: boolean;
  publishedAt: Date;
  updatedAt: Date;
  installCount: number;
  workspaceSlug: string | null;
  workspaceName: string | null;
  latestReleaseId: string;
  latestVersion: number;
  releaseSummary: AgentReleaseSummary;
};

export type AgentMarketListingDetail = {
  listing: {
    id: string;
    slug: string;
    directorySlug: string;
    name: string;
    author: string | null;
    summary: string | null;
    iconUrl: string | null;
    tags: string[];
    categories: { slug: string; name: string }[];
    curated: boolean;
    isFeatured: boolean;
    status: "published";
    publishedAt: Date;
    updatedAt: Date;
    installCount: number;
  };
  workspace: { slug: string; name: string } | null;
  release: {
    id: string;
    version: number;
    manifestVersion: 1;
    checksum: string;
    publishedAt: Date;
    summary: AgentReleaseSummary;
    releaseSummary: {
      github: {
        repository: string;
        commit: string;
        path: string;
        version: string;
      };
    } | null;
  };
  manifest: AgentReleaseManifestV1;
};

export type PublisherAgentListing = {
  id: string;
  slug: string;
  directorySlug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  categoryIds: string[];
  status: string;
  latestVersion: number;
  publishedAt: Date | null;
  installCount: number;
  latestRelease: null | {
    id: string;
    version: number;
    manifestVersion: number;
    checksum: string;
    publishedAt: Date;
    summary: AgentReleaseSummary;
  };
  pendingRelease: null | {
    id: string;
    version: number;
    manifestVersion: number;
    checksum: string;
    publishedAt: Date;
    name: string;
    summary: string | null;
    iconUrl: string | null;
    tags: string[];
    categoryIds: string[];
    reviewStatus: string;
    summaryData: AgentReleaseSummary;
  };
};

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || fallback;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function agentReleaseChecksum(manifest: AgentReleaseManifestV1): string {
  return calculateAgentReleaseChecksum(manifest);
}

export function parseAgentReleaseManifest(
  raw: unknown,
  expectedChecksum?: string,
): AgentReleaseManifestV1 {
  const parsed = agentReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError(
      "invalid_manifest",
      "The agent release manifest is invalid.",
      {
        issues: parsed.error.issues,
      },
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > MAX_MANIFEST_BYTES
  ) {
    throw new AgentMarketError(
      "invalid_manifest",
      "The agent release manifest is too large.",
    );
  }
  if (
    expectedChecksum &&
    agentReleaseChecksum(parsed.data) !== expectedChecksum
  ) {
    throw new AgentMarketError(
      "invalid_manifest",
      "The agent release checksum does not match.",
    );
  }
  return {
    ...parsed.data,
    agents: parsed.data.agents.map((agent) => ({
      ...agent,
      maxSteps:
        agent.maxSteps === 0 ? AGENT_STEP_BOUNDS.default : agent.maxSteps,
    })),
  };
}

function withTrustedAgentMcpAllowedTools(
  manifest: AgentReleaseManifestV1,
  servers: readonly { slug: string; installCfg: unknown }[],
): AgentReleaseManifestV1 {
  const catalogNamesBySlug = new Map(
    servers.map((server) => [
      server.slug,
      new Set(readMcpToolCatalog(server.installCfg).map(({ name }) => name)),
    ]),
  );
  return {
    ...manifest,
    deployments: manifest.deployments.map((deployment) => {
      const catalogNames = catalogNamesBySlug.get(deployment.catalogSlug);
      return {
        ...deployment,
        mcpAllowedTools: sortedUnique(
          deployment.mcpAllowedTools.filter((name) => catalogNames?.has(name)),
        ),
      };
    }),
  };
}

export function summarizeAgentReleaseManifest(
  manifest: AgentReleaseManifestV1,
): AgentReleaseSummary {
  const models = new Map<string, AgentModelRequirement>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    models.set(
      `${agent.modelRequirement.format}\0${agent.modelRequirement.model}`,
      agent.modelRequirement,
    );
  }
  const deploymentCount = manifest.deployments.length;
  const skillCount = manifest.skills.length;
  const toolkitCount = manifest.toolkits.length;
  const subAgentCount = Math.max(0, manifest.agents.length - 1);
  const runtimes = [
    ...new Set(manifest.agents.map((agent) => agent.runtime?.kind ?? "pi")),
  ].sort((a, b) => a.localeCompare(b));
  return {
    agentCount: manifest.agents.length,
    subAgentCount,
    deploymentCount,
    skillCount,
    toolkitCount,
    resourceCount: deploymentCount + skillCount + toolkitCount,
    toolCount: deploymentCount + skillCount + subAgentCount,
    models: [...models.values()].sort(
      (a, b) =>
        a.format.localeCompare(b.format) || a.model.localeCompare(b.model),
    ),
    runtimes,
  };
}

function isPrismaError(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      codes.includes(error.code),
  );
}

async function assertPublisherAccess(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [
        { ownerId: userId },
        { members: { some: { userId, role: { in: ["owner", "admin"] } } } },
      ],
    },
    select: { id: true },
  });
  if (!workspace) {
    throw new AgentMarketError(
      "not_authorized",
      "Only a workspace owner or admin can publish agents.",
    );
  }
}

export async function unpublishAgentListing(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}): Promise<{ id: string; status: string } | null> {
  return db.$transaction(async (tx) => {
    await assertPublisherAccess(tx, input.workspaceId, input.actorId);
    const listing = await tx.agentListing.findFirst({
      where: {
        publisherWorkspaceId: input.workspaceId,
        sourceAgentId: input.agentId,
      },
      select: { id: true, pendingReleaseId: true },
    });
    if (!listing) return null;
    if (listing.pendingReleaseId) {
      await tx.agentRelease.updateMany({
        where: { id: listing.pendingReleaseId, reviewStatus: "pending" },
        data: {
          reviewStatus: "rejected",
          reviewedAt: new Date(),
          reviewNote: "Withdrawn by the publisher.",
        },
      });
    }
    return tx.agentListing.update({
      where: { id: listing.id },
      data: { status: "disabled", pendingReleaseId: null },
      select: { id: true, status: true },
    });
  });
}

export async function withdrawPendingAgentRelease(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}): Promise<{ id: string; status: string } | null> {
  return db.$transaction(async (tx) => {
    await assertPublisherAccess(tx, input.workspaceId, input.actorId);
    const listing = await tx.agentListing.findFirst({
      where: {
        publisherWorkspaceId: input.workspaceId,
        sourceAgentId: input.agentId,
      },
      select: {
        id: true,
        status: true,
        latestReleaseId: true,
        pendingReleaseId: true,
      },
    });
    if (!listing?.pendingReleaseId) return null;
    await tx.agentRelease.updateMany({
      where: { id: listing.pendingReleaseId, reviewStatus: "pending" },
      data: {
        reviewStatus: "rejected",
        reviewedAt: new Date(),
        reviewNote: "Withdrawn by the publisher.",
      },
    });
    return tx.agentListing.update({
      where: { id: listing.id },
      data: {
        pendingReleaseId: null,
        status: listing.latestReleaseId ? listing.status : "draft",
      },
      select: { id: true, status: true },
    });
  });
}

function parseReleaseSummary(raw: unknown): AgentReleaseSummary {
  const parsed = agentReleaseSummarySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError(
      "invalid_manifest",
      "The agent release summary is invalid.",
      {
        issues: parsed.error.issues,
      },
    );
  }
  return parsed.data;
}

export async function getAgentListingForPublisher(
  workspaceId: string,
  agentId: string,
): Promise<PublisherAgentListing | null> {
  const listing = await db.agentListing.findFirst({
    where: { publisherWorkspaceId: workspaceId, sourceAgentId: agentId },
    select: {
      id: true,
      slug: true,
      directorySlug: true,
      name: true,
      author: true,
      summary: true,
      iconUrl: true,
      tags: true,
      categories: { select: { id: true } },
      status: true,
      latestVersion: true,
      publishedAt: true,
      installCount: true,
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          checksum: true,
          publishedAt: true,
          releaseSummary: true,
        },
      },
      pendingRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          checksum: true,
          publishedAt: true,
          name: true,
          summary: true,
          iconUrl: true,
          tags: true,
          categoryIds: true,
          reviewStatus: true,
          releaseSummary: true,
        },
      },
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    slug: listing.slug,
    directorySlug: listing.directorySlug,
    name: listing.name,
    author: listing.author,
    summary: listing.summary,
    iconUrl: listing.iconUrl,
    tags: listing.tags,
    categoryIds: listing.categories.map(({ id }) => id),
    status: listing.status,
    latestVersion: listing.latestVersion,
    publishedAt: listing.publishedAt,
    installCount: listing.installCount,
    latestRelease: listing.latestRelease
      ? {
          id: listing.latestRelease.id,
          version: listing.latestRelease.version,
          manifestVersion: listing.latestRelease.manifestVersion,
          checksum: listing.latestRelease.checksum,
          publishedAt: listing.latestRelease.publishedAt,
          summary: parseReleaseSummary(listing.latestRelease.releaseSummary),
        }
      : null,
    pendingRelease: listing.pendingRelease
      ? {
          id: listing.pendingRelease.id,
          version: listing.pendingRelease.version,
          manifestVersion: listing.pendingRelease.manifestVersion,
          checksum: listing.pendingRelease.checksum,
          publishedAt: listing.pendingRelease.publishedAt,
          name: listing.pendingRelease.name,
          summary: listing.pendingRelease.summary,
          iconUrl: listing.pendingRelease.iconUrl,
          tags: listing.pendingRelease.tags,
          categoryIds: listing.pendingRelease.categoryIds,
          reviewStatus: listing.pendingRelease.reviewStatus,
          summaryData: parseReleaseSummary(
            listing.pendingRelease.releaseSummary,
          ),
        }
      : null,
  };
}

export type AgentMarketListInput = {
  workspaceId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: "newest" | "popular" | "name";
  category?: string;
};

export async function listAgentMarketListings(
  input: AgentMarketListInput = {},
): Promise<{
  items: AgentMarketListingSummary[];
  total: number;
  availableTotal: number;
  page: number;
  pageSize: number;
}> {
  const requestedPage = input.page ?? 1;
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const pageSize = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const term = input.q?.trim().slice(0, 200) ?? "";
  const normalizedTag = term.toLocaleLowerCase();
  const category = input.category?.trim().slice(0, 120) ?? "";
  const baseWhere: Prisma.AgentListingWhereInput = {
    status: "published",
    latestReleaseId: { not: null },
    AND: [visibleAgentListingOrigin(input.workspaceId)],
    latestRelease: { is: { reviewStatus: "approved" } },
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { author: { contains: term, mode: "insensitive" } },
            { summary: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } },
            { directorySlug: { contains: term, mode: "insensitive" } },
            {
              publisherWorkspace: {
                is: { name: { contains: term, mode: "insensitive" } },
              },
            },
            {
              publisherWorkspace: {
                is: { slug: { contains: term, mode: "insensitive" } },
              },
            },
            {
              categories: {
                some: { name: { contains: term, mode: "insensitive" } },
              },
            },
            { tags: { has: normalizedTag } },
          ],
        }
      : {}),
  };
  const where: Prisma.AgentListingWhereInput = {
    ...baseWhere,
    ...(category ? { categories: { some: { slug: category } } } : {}),
  };
  const orderBy: Prisma.AgentListingOrderByWithRelationInput[] = [
    { isFeatured: "desc" },
    ...(input.sort === "newest"
      ? [{ publishedAt: "desc" as const }, { updatedAt: "desc" as const }]
      : input.sort === "name"
        ? [{ name: "asc" as const }, { publishedAt: "desc" as const }]
        : [
            { installCount: "desc" as const },
            { publishedAt: "desc" as const },
          ]),
  ];
  const [total, availableTotal, rows] = await Promise.all([
    db.agentListing.count({ where }),
    db.agentListing.count({ where: baseWhere }),
    db.agentListing.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        publisherKind: true,
        slug: true,
        directorySlug: true,
        name: true,
        author: true,
        summary: true,
        iconUrl: true,
        tags: true,
        curated: true,
        isFeatured: true,
        publishedAt: true,
        updatedAt: true,
        installCount: true,
        categories: {
          select: { slug: true, name: true },
          orderBy: { name: "asc" },
        },
        publisherWorkspace: { select: { slug: true, name: true } },
        latestRelease: {
          select: { id: true, version: true, releaseSummary: true },
        },
      },
    }),
  ]);

  const items: AgentMarketListingSummary[] = [];
  for (const row of rows) {
    // Keep this guard even though the query filters the relation: it protects
    // the directory from an inconsistent row returned by the database.
    if (
      (!row.publisherWorkspace && !isPlatformAgentListingOrigin(row)) ||
      !row.latestRelease ||
      !row.publishedAt
    )
      continue;
    items.push({
      id: row.id,
      slug: row.slug,
      directorySlug: row.directorySlug,
      name: row.name,
      author: row.author,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
      categories: row.categories,
      curated: row.curated,
      isFeatured: row.isFeatured,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      installCount: row.installCount,
      workspaceSlug: row.publisherWorkspace?.slug ?? null,
      workspaceName: row.publisherWorkspace?.name ?? null,
      latestReleaseId: row.latestRelease.id,
      latestVersion: row.latestRelease.version,
      releaseSummary: parseReleaseSummary(row.latestRelease.releaseSummary),
    });
  }
  return { items, total, availableTotal, page, pageSize };
}

export async function listAgentMarketCategories(workspaceId?: string) {
  return db.category.findMany({
    where: {
      agentListings: {
        some: {
          status: "published",
          latestReleaseId: { not: null },
          AND: [visibleAgentListingOrigin(workspaceId)],
          latestRelease: { is: { reviewStatus: "approved" } },
        },
      },
    },
    orderBy: { name: "asc" },
    select: {
      slug: true,
      name: true,
      _count: {
        select: {
          agentListings: {
            where: {
              status: "published",
              latestReleaseId: { not: null },
              AND: [visibleAgentListingOrigin(workspaceId)],
              latestRelease: { is: { reviewStatus: "approved" } },
            },
          },
        },
      },
    },
  });
}

async function findAgentMarketListing(
  identity: Prisma.AgentListingWhereInput,
  workspaceId?: string,
): Promise<AgentMarketListingDetail | null> {
  const row = await db.agentListing.findFirst({
    where: {
      ...identity,
      status: "published",
      AND: [visibleAgentListingOrigin(workspaceId)],
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: "approved" } },
    },
    select: {
      id: true,
      publisherKind: true,
      slug: true,
      directorySlug: true,
      name: true,
      author: true,
      summary: true,
      iconUrl: true,
      tags: true,
      curated: true,
      isFeatured: true,
      status: true,
      publishedAt: true,
      updatedAt: true,
      installCount: true,
      categories: {
        select: { slug: true, name: true },
        orderBy: { name: "asc" },
      },
      publisherWorkspace: { select: { slug: true, name: true } },
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          manifest: true,
          releaseSummary: true,
          checksum: true,
          publishedAt: true,
          githubRegistryVersion: {
            select: {
              sourceRepository: true,
              sourceCommit: true,
              sourcePath: true,
              version: true,
            },
          },
        },
      },
    },
  });
  if (
    !row ||
    (!row.publisherWorkspace && !isPlatformAgentListingOrigin(row)) ||
    !row.latestRelease ||
    !row.publishedAt ||
    row.latestRelease.manifestVersion !== 1
  ) {
    return null;
  }
  const parsedManifest = parseAgentReleaseManifest(
    row.latestRelease.manifest,
    row.latestRelease.checksum,
  );
  const servers = await db.server.findMany({
    where: {
      slug: {
        in: sortedUnique(
          parsedManifest.deployments.map(({ catalogSlug }) => catalogSlug),
        ),
      },
      verifiedAt: { not: null },
    },
    select: { slug: true, installCfg: true },
  });
  const manifest = withTrustedAgentMcpAllowedTools(parsedManifest, servers);
  return {
    listing: {
      id: row.id,
      slug: row.slug,
      directorySlug: row.directorySlug,
      name: row.name,
      author: row.author,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
      categories: row.categories,
      curated: row.curated,
      isFeatured: row.isFeatured,
      status: "published",
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      installCount: row.installCount,
    },
    workspace: row.publisherWorkspace,
    release: {
      id: row.latestRelease.id,
      version: row.latestRelease.version,
      manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
      checksum: agentReleaseChecksum(manifest),
      publishedAt: row.latestRelease.publishedAt,
      summary: parseReleaseSummary(row.latestRelease.releaseSummary),
      releaseSummary: row.latestRelease.githubRegistryVersion
        ? {
            github: {
              repository:
                row.latestRelease.githubRegistryVersion.sourceRepository,
              commit: row.latestRelease.githubRegistryVersion.sourceCommit,
              path: row.latestRelease.githubRegistryVersion.sourcePath,
              version: row.latestRelease.githubRegistryVersion.version,
            },
          }
        : null,
    },
    manifest,
  };
}

export function getAgentMarketListing(
  listingId: string,
  workspaceId?: string,
): Promise<AgentMarketListingDetail | null> {
  return findAgentMarketListing({ id: listingId }, workspaceId);
}

export function getAgentMarketListingByDirectorySlug(
  directorySlug: string,
  workspaceId?: string,
): Promise<AgentMarketListingDetail | null> {
  return findAgentMarketListing({ directorySlug }, workspaceId);
}

export type MaterializeAgentReleaseResult = {
  install: {
    id: string;
    releaseId: string;
    targetWorkspaceId: string;
    agentId: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
  agent: { id: string; name: string; slug: string };
  reused: boolean;
  requirements: AgentInstallRequirements;
  resourceMap: AgentInstallResourceMap;
};

export function validateAgentReleaseManifestReferences(
  manifest: AgentReleaseManifestV1,
) {
  function uniqueKeys(label: string, keys: string[]) {
    if (new Set(keys).size !== keys.length) {
      throw new AgentMarketError(
        "invalid_manifest",
        `The release contains duplicate ${label} keys.`,
      );
    }
  }
  uniqueKeys(
    "agent",
    manifest.agents.map(({ key }) => key),
  );
  uniqueKeys(
    "deployment",
    manifest.deployments.map(({ key }) => key),
  );
  uniqueKeys(
    "skill",
    manifest.skills.map(({ key }) => key),
  );
  uniqueKeys(
    "toolkit",
    manifest.toolkits.map(({ key }) => key),
  );

  const agents = new Set(manifest.agents.map(({ key }) => key));
  const deployments = new Set(manifest.deployments.map(({ key }) => key));
  const skills = new Set(manifest.skills.map(({ key }) => key));
  const toolkits = new Set(manifest.toolkits.map(({ key }) => key));
  if (!agents.has(manifest.rootAgentKey)) {
    throw new AgentMarketError(
      "invalid_manifest",
      "The release root agent is missing.",
    );
  }
  const requireKeys = (
    label: string,
    values: string[],
    available: Set<string>,
  ) => {
    const missing = values.filter((value) => !available.has(value));
    if (missing.length) {
      throw new AgentMarketError(
        "invalid_manifest",
        `The release references missing ${label} resources.`,
        {
          missing,
        },
      );
    }
  };
  for (const agent of manifest.agents) {
    requireKeys("deployment", agent.deploymentKeys, deployments);
    requireKeys("skill", agent.skillKeys, skills);
    requireKeys("toolkit", agent.toolkitKeys, toolkits);
    requireKeys("sub-agent", agent.subAgentKeys, agents);
  }
  for (const toolkit of manifest.toolkits) {
    requireKeys("deployment", toolkit.deploymentKeys, deployments);
    requireKeys("skill", toolkit.skillKeys, skills);
  }
}

async function assertInstallerAccess(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      status: "active",
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) {
    throw new AgentMarketError(
      "target_workspace_not_found",
      "The target workspace was not found or access was denied.",
    );
  }
}

async function uniqueAgentSlugForInstall(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  desired: string,
  reserved: Set<string>,
): Promise<string> {
  const base = slugify(desired, "agent");
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (reserved.has(candidate)) continue;
    const exists = await tx.agent.findFirst({
      where: { workspaceId, slug: candidate },
      select: { id: true },
    });
    if (!exists) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new AgentMarketError(
    "install_failed",
    "Could not allocate a unique agent slug.",
  );
}

async function uniqueSandboxSlugForInstall(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  desired: string,
  reserved: Set<string>,
): Promise<string> {
  const base = `${slugify(desired, "agent")}-runtime`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (reserved.has(candidate)) continue;
    const exists = await tx.sandbox.findFirst({
      where: { workspaceId, slug: candidate },
      select: { id: true },
    });
    if (!exists) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new AgentMarketError(
    "install_failed",
    "Could not allocate a unique runtime sandbox slug.",
  );
}

function parseInstallRequirements(raw: unknown): AgentInstallRequirements {
  const parsed = agentInstallRequirementsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError(
      "invalid_manifest",
      "Stored install requirements are invalid.",
    );
  }
  return parsed.data;
}

function parseInstallResourceMap(raw: unknown): AgentInstallResourceMap {
  const parsed = agentInstallResourceMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError(
      "invalid_manifest",
      "Stored install resource mapping is invalid.",
    );
  }
  return parsed.data;
}

async function existingInstallResult(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    installedById: string;
    idempotencyKey: string;
  },
): Promise<MaterializeAgentReleaseResult | null> {
  const existing = await tx.agentInstall.findUnique({
    where: {
      targetWorkspaceId_idempotencyKey: {
        targetWorkspaceId: input.targetWorkspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { agent: { select: { id: true, name: true, slug: true } } },
  });
  if (!existing) return null;
  if (
    existing.releaseId !== input.releaseId ||
    existing.installedById !== input.installedById ||
    !existing.agent ||
    !existing.resourceMap
  ) {
    throw new AgentMarketError(
      "idempotency_conflict",
      "This idempotency key has already been used for a different installation.",
    );
  }
  return {
    install: {
      id: existing.id,
      releaseId: existing.releaseId,
      targetWorkspaceId: existing.targetWorkspaceId,
      agentId: existing.agentId,
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    },
    agent: existing.agent,
    reused: true,
    requirements: parseInstallRequirements(existing.requirements),
    resourceMap: parseInstallResourceMap(existing.resourceMap),
  };
}

async function materializeAgentReleaseTransaction(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    installedById: string;
    idempotencyKey: string;
    name?: string;
  },
): Promise<MaterializeAgentReleaseResult> {
  await assertInstallerAccess(tx, input.targetWorkspaceId, input.installedById);
  const reused = await existingInstallResult(tx, input);
  if (reused) return reused;

  const release = await tx.agentRelease.findUnique({
    where: { id: input.releaseId },
    select: {
      id: true,
      manifestVersion: true,
      manifest: true,
      checksum: true,
      reviewStatus: true,
      listing: { select: { id: true } },
    },
  });
  if (!release)
    throw new AgentMarketError(
      "release_not_found",
      "The agent release was not found.",
    );
  const currentListing = await tx.agentListing.findFirst({
    where: {
      id: release.listing.id,
      AND: [visibleAgentListingOrigin(input.targetWorkspaceId)],
    },
    select: { status: true, latestReleaseId: true },
  });
  if (currentListing?.status !== "published") {
    throw new AgentMarketError(
      "listing_unavailable",
      "This agent listing is not currently available.",
    );
  }
  if (release.reviewStatus !== "approved") {
    throw new AgentMarketError(
      "listing_unavailable",
      "This agent release has not been approved.",
    );
  }
  if (currentListing.latestReleaseId !== release.id) {
    throw new AgentMarketError(
      "listing_unavailable",
      "This agent release is no longer the current public version.",
    );
  }
  if (release.manifestVersion !== AGENT_MARKET_MANIFEST_VERSION) {
    throw new AgentMarketError(
      "invalid_manifest",
      "This agent release uses an unsupported manifest version.",
    );
  }
  const parsedManifest = parseAgentReleaseManifest(
    release.manifest,
    release.checksum,
  );
  const trustedServers = await tx.server.findMany({
    where: {
      slug: {
        in: sortedUnique(
          parsedManifest.deployments.map(({ catalogSlug }) => catalogSlug),
        ),
      },
      verifiedAt: { not: null },
    },
    select: { slug: true, installCfg: true },
  });
  const manifest = withTrustedAgentMcpAllowedTools(
    parsedManifest,
    trustedServers,
  );
  validateAgentReleaseManifestReferences(manifest);

  const deploymentMap: Record<string, string> = {};
  for (const definition of manifest.deployments) {
    const env: Record<string, string> = { ...definition.publicEnv };
    for (const name of definition.requiredEnv) env[name] = "";
    const installCfg = {
      env,
      ...(definition.command
        ? { command: definition.command, args: definition.args }
        : {}),
      ...(definition.startCommand
        ? { startCommand: definition.startCommand }
        : {}),
      ...(definition.network === "none" ? { network: "none" as const } : {}),
      ...(definition.transport ? { transport: definition.transport } : {}),
      ...(definition.authType ? { authType: definition.authType } : {}),
      ...(definition.bearerEnv ? { bearerEnv: definition.bearerEnv } : {}),
      ...(definition.headerEnv ? { headerEnv: definition.headerEnv } : {}),
    };
    const deployment = await tx.deployment.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        serverId: null,
        name: definition.name,
        source: definition.source,
        sourceRef: definition.sourceRef,
        installCfg: sealMcpEnvironment(
          installCfg,
          input.targetWorkspaceId,
          env,
        ) as Prisma.InputJsonValue,
        status: "stopped",
        mcpToolExposure: "allowlist",
        mcpAllowedTools: [],
      },
      select: { id: true, installCfg: true },
    });
    deploymentMap[definition.key] = deployment.id;
  }

  const skillMap: Record<string, string> = {};
  for (const definition of manifest.skills) {
    const installed = await tx.installedSkill.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        skillId: null,
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        content: definition.content,
        source: "agent-market",
        sourceRef: `${release.id}:${definition.key}`,
        status: "published",
        userInvocable: definition.userInvocable,
        agentInvocable: definition.agentInvocable,
        effort: definition.effort,
        files: definition.files as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    skillMap[definition.key] = installed.id;
  }

  const toolkitMap: Record<string, string> = {};

  const agentMap: Record<string, string> = {};
  const sandboxMap: Record<string, string> = {};
  const sandboxDeploymentMap: Record<string, string> = {};
  const createdAgents = new Map<
    string,
    { id: string; name: string; slug: string }
  >();
  const reservedAgentSlugs = new Set<string>();
  const reservedSandboxSlugs = new Set<string>();
  for (const definition of manifest.agents) {
    const isRoot = definition.key === manifest.rootAgentKey;
    const requestedName =
      isRoot && input.name?.trim()
        ? input.name.trim().slice(0, 240)
        : definition.name;
    const desiredSlug =
      isRoot && input.name?.trim()
        ? slugify(requestedName, definition.slug)
        : definition.slug;
    const agentSlug = await uniqueAgentSlugForInstall(
      tx,
      input.targetWorkspaceId,
      desiredSlug,
      reservedAgentSlugs,
    );
    const agent = await createAgentRecords(
      tx,
      input.targetWorkspaceId,
      requestedName,
      agentSlug,
      { runtime: "pi-sdk" },
      await uniqueSandboxSlugForInstall(
        tx,
        input.targetWorkspaceId,
        agentSlug,
        reservedSandboxSlugs,
      ),
    );
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        systemPrompt: definition.systemPrompt,
        maxSteps: definition.maxSteps,
      },
    });
    const template = await tx.agentSandbox.findFirstOrThrow({
      where: { agentId: agent.id, isDefault: true },
      select: { sandboxId: true, sandbox: { select: { deploymentId: true } } },
    });
    sandboxMap[definition.key] = template.sandboxId;
    sandboxDeploymentMap[definition.key] = template.sandbox.deploymentId;
    agentMap[definition.key] = agent.id;
    createdAgents.set(definition.key, {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
    });
  }

  const requirements: AgentInstallRequirements = {
    providers: manifest.agents.flatMap((definition) => {
      if (!definition.modelRequirement) return [];
      return [
        {
          agentKey: definition.key,
          format: definition.modelRequirement.format,
          model: definition.modelRequirement.model,
          satisfied: false,
        },
      ];
    }),
    // Persist the complete requirement list, not only values missing during
    // installation. This lets the setup UI detect a required value that is
    // removed later without ever persisting or returning the secret itself.
    environment: manifest.deployments.flatMap((definition) =>
      definition.requiredEnv.map((variable) => ({
        deploymentKey: definition.key,
        variable,
        required: true as const,
      })),
    ),
    legacyToolkitConversions: manifest.toolkits.map((toolkit) => ({
      toolkitKey: toolkit.key,
      name: toolkit.name,
      agentKeys: manifest.agents
        .filter((agent) => agent.toolkitKeys.includes(toolkit.key))
        .map((agent) => agent.key),
      requiresPrivatePackageConversion: true,
      requiresReauthorization: true,
    })),
  };
  const resourceMap: AgentInstallResourceMap = {
    agents: agentMap,
    deployments: deploymentMap,
    skills: skillMap,
    toolkits: toolkitMap,
    sandboxes: sandboxMap,
    sandboxDeployments: sandboxDeploymentMap,
  };
  // Templates install as drafts. Capabilities and model access must be explicitly
  // authorized by the consuming workspace before preparing a revision.
  const needsSetup = true;
  const rootAgent = createdAgents.get(manifest.rootAgentKey);
  if (!rootAgent)
    throw new AgentMarketError(
      "invalid_manifest",
      "The root agent could not be created.",
    );
  const install = await tx.agentInstall.create({
    data: {
      releaseId: release.id,
      targetWorkspaceId: input.targetWorkspaceId,
      installedById: input.installedById,
      agentId: rootAgent.id,
      idempotencyKey: input.idempotencyKey,
      status: needsSetup ? "needs_setup" : "ready",
      requirements: requirements as Prisma.InputJsonValue,
      resourceMap: resourceMap as Prisma.InputJsonValue,
    },
    select: {
      id: true,
      releaseId: true,
      targetWorkspaceId: true,
      agentId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await tx.agentListing.update({
    where: { id: release.listing.id },
    data: { installCount: { increment: 1 } },
  });
  return {
    install,
    agent: rootAgent,
    reused: false,
    requirements,
    resourceMap,
  };
}

export async function materializeAgentRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
  name?: string;
}): Promise<MaterializeAgentReleaseResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AgentMarketError(
      "idempotency_conflict",
      "A valid idempotency key is required.",
    );
  }
  const normalized = { ...input, idempotencyKey };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => materializeAgentReleaseTransaction(tx, normalized),
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof AgentMarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ["P2002", "P2034"])) break;
    }
  }
  throw new AgentMarketError(
    "install_failed",
    "The agent release could not be installed.",
    lastError instanceof Error ? { cause: lastError.message } : undefined,
  );
}
