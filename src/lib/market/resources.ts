import "server-only";
import { writeAudit } from "@/lib/observability/audit";

import type { Prisma, Deployment, MarketInstall } from "@prisma/client";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validatePiPackageMcpBindings } from "@/lib/market/pi-package-assembly";
import type { PiPackageMcpBindings } from "@/lib/market/pi-package-assembly";
import { sandboxExecutionBusy } from "@/lib/agents/sandbox-execution-gate";
import { TERMINAL } from "@/lib/a2a/model";
import { resolvePiPackageMcpPolicy } from "@/lib/agents/pi-package-mcp";
import { piPackageBindingsSchema } from "@/lib/pi-packages/installations";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
  type PiPackageManifestV1,
} from "@/lib/market/pi-package-manifest";
import { db } from "@/lib/db";
import { validateServerRecipe } from "@/lib/admin/recipe-validate";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { resourceListingSchema as listingSchema } from "@/lib/market/listing-schema";
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
  type MarketSecretScan,
} from "@/lib/market/secret-scan";
import { stopProcess } from "@/lib/process/supervisor";
import { removeDeploymentContainer } from "@/lib/process/deployment-runtime-container";
import { removeDeploymentConfigVolume } from "@/lib/process/deployment-config-volume";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import { sealMcpEnvironment } from "@/lib/process/mcp-credentials";
import {
  parseSkillReleaseManifest,
  SKILL_MARKET_MANIFEST_VERSION,
  type SkillReleaseManifestV1,
} from "@/lib/market/skill-manifest";
import {
  approveMarketRelease,
  installSkillRelease,
  MarketError,
  updateSkillMarketInstall,
} from "@/lib/market/skills";
import { assertPortableMcpRecipe } from "@/lib/market/mcp-portable-recipe";
import {
  missingRequiredEnvironment,
  parseServerRecipe,
  recipeToDeploymentData,
  type ServerRecipe,
} from "@/lib/workspace/server-recipe";
import {
  parseMcpToolCatalog,
  parseMcpToolCatalogResult,
  hasMcpToolCatalog,
  hasVerifiedMcpToolCatalog,
  readMcpToolCatalog,
  withMcpToolCatalog,
  type McpToolDefinition,
} from "@/lib/process/mcp-tool-catalog";

export const RESOURCE_MARKET_MANIFEST_VERSION = 1 as const;

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/);
const sourceUrlSchema = z
  .string()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
const recipeSchema = z
  .object({
    source: z.enum(["npm", "pypi", "github", "docker", "remote", "config"]),
    ref: z.string().min(1).max(2_000),
    sourceUrl: sourceUrlSchema.optional(),
    env: z.array(environmentName).max(256),
    startCommand: z.string().min(1).max(4_000).optional(),
    command: z.enum(["npx", "uvx", "uv", "docker"]).optional(),
    args: z.array(z.string().max(4_000)).max(100).optional(),
    network: z.literal("none").optional(),
    transport: z.enum(["streamable-http", "sse"]).optional(),
    authType: z.enum(["none", "bearer", "headers"]).optional(),
    bearerEnv: environmentName.optional(),
    headerEnv: z
      .record(headerName, environmentName)
      .refine((value) => Object.keys(value).length <= 20)
      .optional(),
  })
  .strict()
  .transform((value, ctx) => {
    const parsed = parseServerRecipe(value);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "Invalid MCP recipe." });
      return z.NEVER;
    }
    return {
      source: parsed.source,
      ref: parsed.ref,
      ...(parsed.command ? { command: parsed.command, args: parsed.args } : {}),
      ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
      env: parsed.env,
      ...(parsed.startCommand ? { startCommand: parsed.startCommand } : {}),
      ...(parsed.network === "none" ? { network: "none" as const } : {}),
      ...(parsed.transport ? { transport: parsed.transport } : {}),
      ...(parsed.authType ? { authType: parsed.authType } : {}),
      ...(parsed.bearerEnv ? { bearerEnv: parsed.bearerEnv } : {}),
      ...(parsed.headerEnv ? { headerEnv: parsed.headerEnv } : {}),
    };
  });
const mcpDefinitionSchema = z
  .object({
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
    description: z.string().max(20_000).nullable(),
    author: z.string().max(240).nullable(),
    iconUrl: z.string().max(2_000).nullable(),
    readme: z.string().max(500_000).nullable(),
    catalogSlug: z.string().min(1).max(120).optional(),
    recipe: recipeSchema,
    toolExposure: z.enum(["all", "allowlist"]),
    allowedTools: z.array(z.string().min(1).max(240)).max(1_000),
    toolCatalog: z
      .array(z.unknown())
      .max(1_000)
      .transform(parseMcpToolCatalog)
      .optional(),
  })
  .strict();

const mcpManifestSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_MARKET_MANIFEST_VERSION),
    kind: z.literal("mcp"),
    listing: listingSchema,
    mcp: mcpDefinitionSchema,
  })
  .strict();

const toolkitManifestSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_MARKET_MANIFEST_VERSION),
    kind: z.literal("toolkit"),
    listing: listingSchema,
    toolkit: z
      .object({
        name: z.string().min(1).max(240),
        slug: z.string().min(1).max(120),
      })
      .strict(),
    mcps: z
      .array(
        mcpDefinitionSchema
          .extend({
            catalogSlug: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(256),
    skills: z
      .array(
        z
          .object({
            catalogSlug: z.string().min(1).max(120).optional(),
            snapshot: z.custom<SkillReleaseManifestV1["skill"]>(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export type McpMarketManifestV1 = z.infer<typeof mcpManifestSchema>;
export type ToolkitMarketManifestV1 = z.infer<typeof toolkitManifestSchema>;
export type PublicResourceMarketManifest =
  | McpMarketManifestV1
  | ToolkitMarketManifestV1;
export type ResourceMarketManifestV1 =
  | PublicResourceMarketManifest
  | PiPackageManifestV1;

function scanToolkitMarketManifest(
  manifest: ToolkitMarketManifestV1,
  releaseNotes?: string | null,
): MarketSecretScan {
  const artifactScan = scanMarketArtifact(manifest, releaseNotes);
  const decodedFindings = manifest.skills.flatMap(({ snapshot }, index) =>
    scanSkillReleaseManifest({
      schemaVersion: SKILL_MARKET_MANIFEST_VERSION,
      kind: "skill",
      skill: snapshot,
    }).findings.map((finding) => ({
      ...finding,
      path: `manifest.skills[${index}].snapshot.${finding.path.replace(/^manifest\.skill\.?/, "")}`,
    })),
  );
  const findings = [...artifactScan.findings, ...decodedFindings];
  return {
    ...artifactScan,
    status: findings.length ? "blocked" : "passed",
    findings,
  };
}

function slugify(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || fallback
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function portableRecipe(recipe: ServerRecipe) {
  return {
    source: recipe.source,
    ref: recipe.ref,
    ...(recipe.command ? { command: recipe.command, args: recipe.args } : {}),
    ...(recipe.sourceUrl ? { sourceUrl: recipe.sourceUrl } : {}),
    env: sortedUnique([...recipe.env, ...Object.keys(recipe.envValues ?? {})]),
    ...(recipe.startCommand ? { startCommand: recipe.startCommand } : {}),
    ...(recipe.network === "none" ? { network: "none" as const } : {}),
    ...(recipe.transport ? { transport: recipe.transport } : {}),
    ...(recipe.authType ? { authType: recipe.authType } : {}),
    ...(recipe.bearerEnv ? { bearerEnv: recipe.bearerEnv } : {}),
    ...(recipe.headerEnv ? { headerEnv: recipe.headerEnv } : {}),
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

function installConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseManifest<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  checksum?: string,
): T {
  let rawSize = 0;
  try {
    rawSize = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    throw new MarketError(
      "invalid_manifest",
      "The market release manifest is invalid.",
    );
  }
  if (rawSize > 4_000_000) {
    throw new MarketError(
      "invalid_manifest",
      "The market release manifest is too large.",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new MarketError(
      "invalid_manifest",
      "The market release manifest is invalid.",
    );
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 4_000_000) {
    throw new MarketError(
      "invalid_manifest",
      "The market release manifest is too large.",
    );
  }
  if (checksum && marketReleaseChecksum(parsed.data) !== checksum) {
    throw new MarketError(
      "invalid_manifest",
      "The market release checksum does not match.",
    );
  }
  return parsed.data;
}

export function parseMcpMarketManifest(
  raw: unknown,
  checksum?: string,
): McpMarketManifestV1 {
  return parseManifest(mcpManifestSchema, raw, checksum);
}

export function parseToolkitMarketManifest(
  raw: unknown,
  checksum?: string,
): ToolkitMarketManifestV1 {
  const manifest = parseManifest(toolkitManifestSchema, raw, checksum);
  return {
    ...manifest,
    skills: manifest.skills.map((skill) => ({
      ...skill,
      snapshot: parseSkillReleaseManifest({
        schemaVersion: SKILL_MARKET_MANIFEST_VERSION,
        kind: "skill",
        skill: skill.snapshot,
      }).skill,
    })),
  };
}

export function parseResourceMarketManifest(
  raw: unknown,
  checksum?: string,
): ResourceMarketManifestV1 {
  const kind =
    raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw
      ? (raw as { kind?: unknown }).kind
      : null;
  if (kind === "mcp") return parseMcpMarketManifest(raw, checksum);
  if (kind === "toolkit") return parseToolkitMarketManifest(raw, checksum);
  if (kind === "pi-package") {
    try {
      return parsePiPackageReleaseManifest(raw, checksum);
    } catch {
      throw new MarketError(
        "invalid_manifest",
        "The Pi package snapshot is invalid.",
      );
    }
  }
  throw new MarketError(
    "invalid_manifest",
    "This market release kind is not supported.",
  );
}

function trustedMcpAllowedTools(
  allowedTools: readonly string[],
  installCfg: unknown,
): string[] {
  const catalogNames = new Set(
    readMcpToolCatalog(installCfg).map(({ name }) => name),
  );
  return sortedUnique(allowedTools.filter((name) => catalogNames.has(name)));
}

function trustedMcpToolCatalog(
  installCfg: unknown,
): McpMarketManifestV1["mcp"]["toolCatalog"] {
  return hasMcpToolCatalog(installCfg)
    ? readMcpToolCatalog(installCfg)
    : undefined;
}

function withoutPublicMcpTools<
  T extends {
    allowedTools: string[];
    toolCatalog?: McpMarketManifestV1["mcp"]["toolCatalog"];
  },
>(definition: T): T {
  const projected = { ...definition, allowedTools: [] };
  delete projected.toolCatalog;
  return projected;
}

/** Public discovery never exposes tools before a Connector is linked through a running sandbox. */
export function projectPublicResourceMarketManifest(
  manifest: ResourceMarketManifestV1,
): PublicResourceMarketManifest | null {
  if (manifest.kind === "pi-package") return null;
  if (manifest.kind === "mcp") {
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
  if (!workspace)
    throw new MarketError("not_authorized", "Workspace access was denied.");
}

async function validatedCategoryIds(
  tx: Prisma.TransactionClient,
  values: readonly string[],
) {
  const ids = values.map((value) => value.trim()).filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new MarketError(
      "invalid_categories",
      "Select at least one unique market category.",
    );
  }
  const count = await tx.category.count({ where: { id: { in: ids } } });
  if (count !== ids.length)
    throw new MarketError(
      "invalid_categories",
      "A market category was not found.",
    );
  return ids;
}

async function assertPiPackagePlatform(manifest: PiPackageManifestV1) {
  if (manifest.package.runtime.platform === "any") return;
  let domain: string;
  try {
    const result = await promisify(execFile)(
      "docker",
      ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
      { timeout: 15_000, maxBuffer: 4096 },
    );
    domain = result.stdout.trim();
  } catch {
    throw new MarketError(
      "package_platform_mismatch",
      "The Docker runtime platform could not be verified.",
    );
  }
  const [platform, architecture] = domain.split("/");
  const arch =
    architecture === "aarch64"
      ? "arm64"
      : architecture === "x86_64"
        ? "x64"
        : architecture;
  if (
    platform !== manifest.package.runtime.platform ||
    arch !== manifest.package.runtime.arch
  ) {
    throw new MarketError(
      "package_platform_mismatch",
      "The package does not match the Docker runtime platform.",
    );
  }
}

export async function installPiPackageRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
  mcpBindings?: PiPackageMcpBindings;
}): Promise<{ install: MarketInstall; reused: boolean }> {
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
  await db.$transaction(async (tx) => {
    await assertInstallerAccess(
      tx,
      input.targetWorkspaceId,
      input.installedById,
    );
    await approvedRelease(
      tx,
      input.releaseId,
      "pi-package",
      input.targetWorkspaceId,
    );
  });
  const candidate = await db.marketRelease.findUnique({
    where: { id: input.releaseId },
  });
  if (!candidate)
    throw new MarketError(
      "listing_unavailable",
      "The package release is unavailable.",
    );
  const manifest = parseResourceMarketManifest(
    candidate.manifest,
    candidate.checksum,
  );
  if (manifest.kind !== "pi-package")
    throw new MarketError(
      "invalid_manifest",
      "The release is not a Pi package.",
    );
  await assertPiPackagePlatform(manifest);
  return db.$transaction(
    async (tx) => {
      await assertInstallerAccess(
        tx,
        input.targetWorkspaceId,
        input.installedById,
      );
      const release = await approvedRelease(
        tx,
        input.releaseId,
        "pi-package",
        input.targetWorkspaceId,
      );
      if (release.checksum !== candidate.checksum)
        throw new MarketError(
          "listing_conflict",
          "The package release changed.",
        );
      const checked = parseResourceMarketManifest(
        release.manifest,
        release.checksum,
      );
      if (
        checked.kind !== "pi-package" ||
        scanPiPackageReleaseManifest(checked, release.releaseNotes).status ===
          "blocked"
      ) {
        throw new MarketError(
          "invalid_manifest",
          "The package snapshot is unsafe.",
        );
      }
      const existing = await tx.marketInstall.findUnique({
        where: {
          targetWorkspaceId_idempotencyKey: {
            targetWorkspaceId: input.targetWorkspaceId,
            idempotencyKey,
          },
        },
      });
      if (existing) {
        if (
          existing.requestedReleaseId !== release.id ||
          existing.listingId !== release.listingId ||
          !["ready", "uninstalled"].includes(existing.status)
        ) {
          throw new MarketError(
            "idempotency_conflict",
            "This idempotency key has already been used.",
          );
        }
        if (existing.status === "ready")
          return { install: existing, reused: true };
      }
      const defaults = installConfig(
        installConfig(release.listing.metadata).piPackageBindingsByRelease,
      );
      const bindings =
        input.mcpBindings ??
        (release.listing.publisherWorkspaceId === input.targetWorkspaceId
          ? (defaults[release.id] as PiPackageMcpBindings | undefined)
          : undefined) ??
        {};
      await validatePiPackageMcpBindings(
        tx,
        input.targetWorkspaceId,
        checked.package,
        bindings,
      );
      const retained = await tx.marketInstall.findUnique({
        where: {
          targetWorkspaceId_listingId: {
            targetWorkspaceId: input.targetWorkspaceId,
            listingId: release.listingId,
          },
        },
      });
      if (retained?.status === "uninstalled") {
        const install = await tx.marketInstall.update({
          where: { id: retained.id },
          data: {
            currentReleaseId: release.id,
            requestedReleaseId: release.id,
            ignoredReleaseId: null,
            status: "ready",
            installedById: input.installedById,
            idempotencyKey,
            resourceMap: { kind: "pi-package", mcpBindings: bindings },
            lastError: null,
          },
        });
        return { install, reused: false };
      }
      const install = await tx.marketInstall.create({
        data: {
          listingId: release.listingId,
          currentReleaseId: release.id,
          requestedReleaseId: release.id,
          targetWorkspaceId: input.targetWorkspaceId,
          installedById: input.installedById,
          idempotencyKey,
          status: "ready",
          resourceMap: { kind: "pi-package", mcpBindings: bindings },
          requirements: {},
        },
      });
      return { install, reused: false };
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

async function updatePiPackageInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
  mcpBindings?: PiPackageMcpBindings;
}) {
  await db.$transaction(async (tx) => {
    await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
  });
  const candidate = await db.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
    include: { listing: true },
  });
  if (!candidate)
    throw new MarketError(
      "install_not_found",
      "The package installation was not found.",
    );
  const releaseId = input.targetReleaseId || candidate.listing.latestReleaseId;
  const target = releaseId
    ? await db.marketRelease.findUnique({ where: { id: releaseId } })
    : null;
  if (!target)
    throw new MarketError(
      "listing_unavailable",
      "The package release is unavailable.",
    );
  const manifest = parseResourceMarketManifest(
    target.manifest,
    target.checksum,
  );
  if (manifest.kind !== "pi-package")
    throw new MarketError(
      "invalid_manifest",
      "The release is not a Pi package.",
    );
  await assertPiPackagePlatform(manifest);
  return db.$transaction(
    async (tx) => {
      await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.targetWorkspaceId} FOR UPDATE`;
      const install = await tx.marketInstall.findFirst({
        where: {
          id: input.installId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
      });
      if (install?.status !== "ready")
        throw new MarketError(
          "install_not_found",
          "The package installation is unavailable.",
        );
      const release = await approvedRelease(
        tx,
        target.id,
        "pi-package",
        input.targetWorkspaceId,
      );
      if (release.checksum !== target.checksum)
        throw new MarketError(
          "listing_conflict",
          "The package release changed.",
        );
      if (release.listingId !== install.listingId)
        throw new MarketError(
          "listing_unavailable",
          "The release belongs to another listing.",
        );
      const checked = parseResourceMarketManifest(
        release.manifest,
        release.checksum,
      );
      if (
        checked.kind !== "pi-package" ||
        scanPiPackageReleaseManifest(checked, release.releaseNotes).status ===
          "blocked"
      ) {
        throw new MarketError(
          "invalid_manifest",
          "The package snapshot is unsafe.",
        );
      }
      if (
        install.currentReleaseId === release.id &&
        input.mcpBindings === undefined
      )
        return install;
      if (
        install.currentReleaseId !==
        (input.currentReleaseId ?? candidate.currentReleaseId)
      ) {
        throw new MarketError(
          "listing_conflict",
          "The installed version changed. Refresh and try again.",
        );
      }
      let bindings = input.mcpBindings;
      try {
        // A workspace version change never grants new tools or changes Agent pins.
        // Retained supersets keep old sessions authorized; the new manifest filters its own tools.
        resolvePiPackageMcpPolicy(
          checked.package.toolplane?.mcp,
          bindings ? { mcpBindings: bindings } : install.resourceMap,
        );
        if (!bindings) {
          // The policy resolver above validated every required persisted binding.
          const current = installConfig(install.resourceMap)
            .mcpBindings as PiPackageMcpBindings;
          bindings = Object.fromEntries(
            (checked.package.toolplane?.mcp ?? []).map((requirement) => [
              requirement.key,
              {
                deploymentId: current[requirement.key].deploymentId,
                tools: requirement.tools,
              },
            ]),
          );
        }
      } catch {
        throw new MarketError(
          "pi_package_mcp_binding_required",
          "Explicit MCP rebinding is required for this release.",
        );
      }
      await validatePiPackageMcpBindings(
        tx,
        input.targetWorkspaceId,
        checked.package,
        bindings,
      );
      const retainedBindings = piPackageBindingsSchema.parse(
        installConfig(install.resourceMap).mcpBindings ?? {},
      );
      const nextBindings = { ...retainedBindings, ...input.mcpBindings };
      for (const [key, binding] of Object.entries(input.mcpBindings ?? {})) {
        const prior = retainedBindings[key];
        if (prior?.deploymentId === binding.deploymentId)
          nextBindings[key] = {
            ...binding,
            tools: [...new Set([...prior.tools, ...binding.tools])],
          };
      }
      return tx.marketInstall.update({
        where: { id: install.id },
        data: {
          currentReleaseId: release.id,
          requestedReleaseId: release.id,
          ignoredReleaseId: null,
          lastError: null,
          lastCheckedAt: new Date(),
          ...(input.mcpBindings !== undefined
            ? {
                resourceMap: {
                  ...installConfig(install.resourceMap),
                  mcpBindings: nextBindings,
                } as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

export async function updatePiPackageMcpBindings(input: {
  workspaceId: string;
  userId: string;
  marketInstallId: string;
  mcpBindings: PiPackageMcpBindings;
}) {
  if (
    !input.mcpBindings ||
    typeof input.mcpBindings !== "object" ||
    Array.isArray(input.mcpBindings)
  )
    throw new MarketError(
      "pi_package_invalid_bindings",
      "Invalid package MCP bindings.",
    );
  return db.$transaction(
    async (tx) => {
      await assertInstallerAccess(tx, input.workspaceId, input.userId);
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      const install = await tx.marketInstall.findFirst({
        where: {
          id: input.marketInstallId,
          targetWorkspaceId: input.workspaceId,
          status: "ready",
        },
        include: {
          listing: true,
          currentRelease: true,
          agentPiPackages: {
            include: {
              release: true,
              agent: { select: { workspaceId: true } },
            },
          },
        },
      });
      if (
        install?.listing.kind !== "pi-package" ||
        install.listing.status !== "published" ||
        (install.listing.visibility !== "public" &&
          install.listing.publisherWorkspaceId !== input.workspaceId)
      )
        throw new MarketError(
          "install_not_found",
          "The package installation is unavailable.",
        );
      const releases = [
        install.currentRelease,
        ...install.agentPiPackages.map((binding) => binding.release),
      ];
      const checked = new Set<string>();
      for (const release of releases) {
        if (checked.has(release.id)) continue;
        checked.add(release.id);
        if (
          release.listingId !== install.listingId ||
          release.reviewStatus !== "approved"
        )
          throw new MarketError(
            "listing_unavailable",
            "A pinned release is unavailable.",
          );
        const manifest = parsePiPackageReleaseManifest(
          release.manifest,
          release.checksum,
        );
        if (
          scanPiPackageReleaseManifest(manifest, release.releaseNotes)
            .status === "blocked"
        )
          throw new MarketError(
            "invalid_manifest",
            "The package snapshot is unsafe.",
          );
        if (
          (manifest.package.toolplane?.mcp ?? []).some(
            (requirement) => !Object.hasOwn(input.mcpBindings, requirement.key),
          )
        )
          throw new MarketError(
            "pi_package_invalid_bindings",
            "Bind every package MCP requirement.",
          );
        await validatePiPackageMcpBindings(
          tx,
          input.workspaceId,
          manifest.package,
          input.mcpBindings,
        );
      }
      if (
        install.agentPiPackages.some(
          (binding) => binding.agent.workspaceId !== input.workspaceId,
        )
      )
        throw new MarketError(
          "not_authorized",
          "Package binding workspace mismatch.",
        );
      const agentIds = install.agentPiPackages.map(
        (binding) => binding.agentId,
      );
      if (agentIds.length) {
        const sandboxes = await tx.agentSandbox.findMany({
          where: { agentId: { in: agentIds } },
          select: { sandboxId: true },
        });
        const busyTask = await tx.a2ATask.findFirst({
          where: {
            context: {
              agentId: { in: agentIds },
              workspaceId: input.workspaceId,
            },
            state: { notIn: TERMINAL },
          },
          select: { id: true },
        });
        const busyWork = await tx.workSession.findFirst({
          where: {
            agentId: { in: agentIds },
            status: {
              in: ["queued", "running", "waiting_approval", "cancelling"],
            },
          },
          select: { id: true },
        });
        if (
          busyTask ||
          busyWork ||
          sandboxes.some(({ sandboxId }) => sandboxExecutionBusy(sandboxId))
        )
          throw new MarketError(
            "pi_package_agent_busy",
            "A package-bound Agent is running.",
          );
      }
      return tx.marketInstall.update({
        where: { id: install.id },
        data: {
          resourceMap: { kind: "pi-package", mcpBindings: input.mcpBindings },
        },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

async function uniqueServerSlug(
  tx: Prisma.TransactionClient,
  namespace: string,
  desired: string,
) {
  const base = slugify(`${namespace}-${desired}`, "community-mcp");
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const slug = suffix ? `${base}-${suffix + 1}` : base;
    if (
      !(await tx.server.findUnique({ where: { slug }, select: { id: true } }))
    )
      return slug;
  }
  throw new MarketError(
    "listing_conflict",
    "Could not allocate a catalog MCP slug.",
  );
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
          sourceDeploymentId: true,
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
  if (reviewCandidate?.listing.kind === "toolkit")
    throw new MarketError(
      "invalid_manifest",
      "Legacy Toolkit releases are retained read-only and cannot be republished.",
    );
  if (
    !reviewCandidate ||
    !["mcp", "toolkit", "pi-package"].includes(reviewCandidate.listing.kind)
  ) {
    return approveMarketRelease(input);
  }

  let validatedMcp: {
    checksum: string;
    sourceServerId: string | null;
    sourceServerUpdatedAt: Date | null;
    tools: McpToolDefinition[];
  } | null = null;
  if (reviewCandidate.listing.kind === "mcp") {
    const admin = await db.user.findFirst({
      where: { id: input.reviewedById, role: "admin", status: "active" },
      select: { id: true },
    });
    if (!admin)
      throw new MarketError(
        "not_authorized",
        "Administrator access is required.",
      );
    if (
      reviewCandidate.listingId !== input.listingId ||
      reviewCandidate.reviewStatus !== "pending" ||
      reviewCandidate.listing.pendingReleaseId !== reviewCandidate.id
    ) {
      throw new MarketError(
        "release_not_found",
        "The pending release was not found.",
      );
    }
    const manifest = parseResourceMarketManifest(
      reviewCandidate.manifest,
      reviewCandidate.checksum,
    );
    if (manifest.kind !== "mcp") {
      throw new MarketError(
        "invalid_manifest",
        "The release kind does not match its listing.",
      );
    }
    if (
      scanMarketArtifact(manifest, reviewCandidate.releaseNotes).status ===
      "blocked"
    ) {
      throw new MarketError(
        "invalid_manifest",
        "The release contains possible credentials.",
      );
    }
    const sourceServer = reviewCandidate.listing.sourceServer;
    const sourceRecipe = sourceServer
      ? parseServerRecipe(sourceServer.installCfg)
      : null;
    if (sourceServer && !sourceRecipe) {
      throw new MarketError(
        "invalid_manifest",
        "The source catalog MCP has no valid recipe.",
      );
    }
    if (sourceRecipe && !reviewCandidate.listing.sourceDeploymentId) {
      const currentRecipe = portableRecipe(sourceRecipe);
      const submittedRecipe = portableRecipe(manifest.mcp.recipe);
      if (JSON.stringify(currentRecipe) !== JSON.stringify(submittedRecipe)) {
        throw new MarketError(
          "invalid_manifest",
          "The source MCP recipe changed after submission.",
        );
      }
    }
    assertInstallableMcpRecipe(manifest.mcp.recipe);
    let tools =
      sourceServer &&
      !reviewCandidate.listing.sourceDeploymentId &&
      hasVerifiedMcpToolCatalog(sourceServer)
        ? readMcpToolCatalog(sourceServer.installCfg)
        : null;
    if (!tools) {
      const recipe = reviewCandidate.listing.sourceDeploymentId
        ? manifest.mcp.recipe
        : (sourceRecipe ?? manifest.mcp.recipe);
      const result = await validateServerRecipe(recipe);
      const catalog = result.ok
        ? parseMcpToolCatalogResult(result.toolCatalog)
        : null;
      if (
        !result.ok ||
        !catalog?.ok ||
        catalog.tools.length !== result.toolCount
      ) {
        throw new MarketError(
          "invalid_manifest",
          `Could not capture a complete MCP tool catalog: ${result.ok ? "invalid tools/list response" : result.error}`,
        );
      }
      tools = catalog.tools;
    }
    if (
      scanMarketArtifact(
        {
          ...manifest,
          mcp: { ...manifest.mcp, toolCatalog: tools },
        },
        reviewCandidate.releaseNotes,
      ).status === "blocked"
    ) {
      throw new MarketError(
        "invalid_manifest",
        "The MCP tool catalog contains possible credentials.",
      );
    }
    validatedMcp = {
      checksum: reviewCandidate.checksum,
      sourceServerId: sourceServer?.id ?? null,
      sourceServerUpdatedAt: sourceServer?.updatedAt ?? null,
      tools,
    };
  }

  return db.$transaction(
    async (tx) => {
      const admin = await tx.user.findFirst({
        where: { id: input.reviewedById, role: "admin", status: "active" },
        select: { id: true },
      });
      if (!admin)
        throw new MarketError(
          "not_authorized",
          "Administrator access is required.",
        );
      const release = await tx.marketRelease.findFirst({
        where: {
          id: input.releaseId,
          listingId: input.listingId,
          reviewStatus: "pending",
        },
        include: {
          listing: {
            select: {
              id: true,
              kind: true,
              namespace: true,
              pendingReleaseId: true,
              publishedAt: true,
              publisherWorkspaceId: true,
              metadata: true,
              sourceServerId: true,
              sourceDeploymentId: true,
              sourceToolkitId: true,
            },
          },
        },
      });
      if (!release || release.listing.pendingReleaseId !== release.id) {
        throw new MarketError(
          "release_not_found",
          "The pending release was not found.",
        );
      }
      const manifest = parseResourceMarketManifest(
        release.manifest,
        release.checksum,
      );
      if (manifest.kind !== release.listing.kind) {
        throw new MarketError(
          "invalid_manifest",
          "The release kind does not match its listing.",
        );
      }
      const scanResult =
        manifest.kind === "toolkit"
          ? scanToolkitMarketManifest(manifest, release.releaseNotes)
          : manifest.kind === "pi-package"
            ? scanPiPackageReleaseManifest(manifest, release.releaseNotes)
            : scanMarketArtifact(manifest, release.releaseNotes);
      if (scanResult.status === "blocked") {
        throw new MarketError(
          "invalid_manifest",
          "The release contains possible credentials.",
        );
      }
      const categoryIds = await validatedCategoryIds(
        tx,
        input.categoryIds ?? release.categoryIds,
      );
      const categorySet = { set: categoryIds.map((id) => ({ id })) };
      let sourceServerId = release.listing.sourceServerId;
      let metadata: Prisma.InputJsonObject;
      if (manifest.kind === "mcp") {
        if (
          !validatedMcp ||
          validatedMcp.checksum !== release.checksum ||
          validatedMcp.sourceServerId !== sourceServerId
        ) {
          throw new MarketError(
            "release_not_found",
            "The pending release changed during validation.",
          );
        }
        let server = sourceServerId
          ? await tx.server.findUnique({ where: { id: sourceServerId } })
          : null;
        if (
          server &&
          validatedMcp.sourceServerUpdatedAt?.getTime() !==
            server.updatedAt.getTime()
        ) {
          throw new MarketError(
            "release_not_found",
            "The source MCP changed during validation.",
          );
        }
        if (!server) {
          const slug = await uniqueServerSlug(
            tx,
            release.listing.namespace,
            manifest.mcp.slug,
          );
          server = await tx.server.create({
            data: {
              slug,
              name: manifest.mcp.name,
              author: manifest.mcp.author,
              description: manifest.mcp.description,
              iconUrl: manifest.mcp.iconUrl,
              readme: manifest.mcp.readme,
              installCfg: withMcpToolCatalog(
                manifest.mcp.recipe,
                validatedMcp.tools,
              ) as Prisma.InputJsonValue,
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
          if (!recipe)
            throw new MarketError(
              "invalid_manifest",
              "The source catalog MCP has no valid recipe.",
            );
          await tx.server.update({
            where: { id: server.id },
            data: {
              installCfg: withMcpToolCatalog(
                release.listing.sourceDeploymentId
                  ? manifest.mcp.recipe
                  : server.installCfg,
                validatedMcp.tools,
              ) as Prisma.InputJsonValue,
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
      } else if (manifest.kind === "pi-package") {
        metadata = {
          ...installConfig(release.listing.metadata),
          author: manifest.listing.author,
          name: manifest.package.name,
          version: manifest.package.version,
        } as Prisma.InputJsonObject;
      } else {
        throw new MarketError(
          "unsupported_resource_kind",
          "Toolkit releases are retired; explicitly freeze convertible content as a private Pi package.",
        );
      }
      const publishedAt = new Date();
      await tx.marketRelease.update({
        where: { id: release.id },
        data: {
          reviewStatus: "approved",
          reviewedById: admin.id,
          reviewedAt: publishedAt,
          reviewNote: input.reviewNote?.trim().slice(0, 4_000) || null,
          scanResult: scanResult as Prisma.InputJsonValue,
          ...(validatedMcp
            ? {
                releaseSummary: {
                  ...installConfig(release.releaseSummary),
                  toolCatalog: validatedMcp.tools,
                } as Prisma.InputJsonValue,
              }
            : {}),
          publishedAt,
        },
      });
      await writeAudit(tx, {
        actorId: admin.id,
        action: "market.release.approved",
        targetType: "marketListing",
        targetId: release.listing.id,
        changes: {
          releaseId: release.id,
          reviewNote: input.reviewNote ?? null,
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
          status: "published",
          latestReleaseId: release.id,
          pendingReleaseId: null,
          publishedAt: release.listing.publishedAt ?? publishedAt,
        },
      });
    },
    { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
  );
}

async function approvedRelease(
  tx: Prisma.TransactionClient,
  releaseId: string,
  kind: "mcp" | "toolkit" | "pi-package",
  workspaceId?: string,
) {
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
          visibility: true,
          publisherWorkspaceId: true,
          metadata: true,
          sourceServerId: true,
          categories: { select: { id: true } },
        },
      },
    },
  });
  if (
    !release ||
    release.listing.kind !== kind ||
    release.listing.status !== "published" ||
    !release.listing.latestReleaseId ||
    release.reviewStatus !== "approved" ||
    (kind !== "pi-package" && release.listing.latestReleaseId !== release.id) ||
    (release.listing.visibility !== "public" &&
      release.listing.publisherWorkspaceId !== workspaceId)
  ) {
    throw new MarketError(
      "listing_unavailable",
      `This ${kind} release is not available for installation.`,
    );
  }
  return release;
}

async function reusedInstall(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    idempotencyKey: string;
  },
) {
  const existing = await tx.marketInstall.findUnique({
    where: {
      targetWorkspaceId_idempotencyKey: {
        targetWorkspaceId: input.targetWorkspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { deployment: true },
  });
  if (!existing) return null;
  const attached = existing.deployment;
  if (existing.requestedReleaseId !== input.releaseId || !attached) {
    throw new MarketError(
      "idempotency_conflict",
      "This idempotency key has already been used.",
    );
  }
  return { install: existing, resource: attached, reused: true as const };
}

function validIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200)
    throw new MarketError(
      "idempotency_conflict",
      "A valid idempotency key is required.",
    );
  return key;
}

function assertInstallableMcpRecipe(recipe: ServerRecipe) {
  try {
    assertPortableMcpRecipe(recipe);
  } catch (error) {
    throw new MarketError(
      "invalid_manifest",
      error instanceof Error ? error.message : "Invalid portable MCP recipe.",
    );
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
      return await db.$transaction(
        async (tx) => {
          await assertInstallerAccess(
            tx,
            input.targetWorkspaceId,
            input.installedById,
          );
          const release = await approvedRelease(
            tx,
            input.releaseId,
            "mcp",
            input.targetWorkspaceId,
          );
          const manifest = parseMcpMarketManifest(
            release.manifest,
            release.checksum,
          );
          assertInstallableMcpRecipe(manifest.mcp.recipe);
          const reused = await reusedInstall(tx, { ...input, idempotencyKey });
          if (reused) {
            if (!("installCfg" in reused.resource)) {
              throw new MarketError(
                "idempotency_conflict",
                "This idempotency key belongs to another resource.",
              );
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
          if (existing)
            throw new MarketError(
              "already_installed",
              "This market MCP is already installed.",
            );
          const server = release.listing.sourceServerId
            ? await tx.server.findFirst({
                where: {
                  id: release.listing.sourceServerId,
                  verifiedAt: { not: null },
                },
                select: {
                  id: true,
                  installCfg: true,
                  verifiedAt: true,
                  verifiedTools: true,
                },
              })
            : null;
          if (
            release.listing.sourceServerId &&
            (!server || !hasVerifiedMcpToolCatalog(server))
          ) {
            throw new MarketError(
              "listing_unavailable",
              "The reviewed catalog MCP is unavailable.",
            );
          }
          const trustedCatalog =
            trustedMcpToolCatalog(release.releaseSummary) ??
            (server
              ? trustedMcpToolCatalog(server.installCfg)
              : manifest.mcp.toolCatalog);
          if (trustedCatalog === undefined)
            throw new MarketError(
              "listing_unavailable",
              "The reviewed MCP has no tools/list snapshot.",
            );
          const data = recipeToDeploymentData({
            ...manifest.mcp.recipe,
            ...(trustedCatalog !== undefined
              ? { toolCatalog: trustedCatalog }
              : {}),
          });
          const requiresHttpApproval =
            data.source === "remote" &&
            data.sourceRef.startsWith("http:") &&
            data.installCfg.allowUnsafeHttp !== true;
          const requiresSetup =
            requiresHttpApproval ||
            missingRequiredEnvironment(manifest.mcp.recipe, data.installCfg)
              .length > 0;
          if (
            server &&
            (await tx.deployment.findUnique({
              where: {
                workspaceId_serverId: {
                  workspaceId: input.targetWorkspaceId,
                  serverId: server.id,
                },
              },
              select: { id: true },
            }))
          ) {
            throw new MarketError(
              "already_installed",
              "This MCP already exists in the target workspace.",
            );
          }
          const deployment = await tx.deployment.create({
            data: {
              workspaceId: input.targetWorkspaceId,
              serverId: server?.id ?? null,
              name: manifest.mcp.name,
              source: data.source,
              sourceRef: data.sourceRef,
              installCfg: sealMcpEnvironment(
                data.installCfg,
                input.targetWorkspaceId,
                data.installCfg.env,
              ) as Prisma.InputJsonValue,
              status: requiresSetup ? "setup_required" : "stopped",
              mcpToolExposure: manifest.mcp.toolExposure,
              mcpAllowedTools: trustedMcpAllowedTools(
                manifest.mcp.allowedTools,
                { toolCatalog: trustedCatalog },
              ),
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
              status: requiresSetup ? "setup_required" : "ready",
              requirements: {
                environment: manifest.mcp.recipe.env,
                ...(requiresHttpApproval
                  ? { unsafeHttpConfirmationRequired: true }
                  : {}),
              },
              resourceMap: { deploymentId: deployment.id },
              lastCheckedAt: new Date(),
            },
          });
          await tx.marketListing.update({
            where: { id: release.listing.id },
            data: { installCount: { increment: 1 } },
          });
          return { install, resource: deployment, reused: false as const };
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (!isPrismaError(error, ["P2002", "P2034"]) || attempt === 2)
        throw error;
    }
  }
  throw new MarketError(
    "listing_conflict",
    "The market install changed. Try again.",
  );
}

export async function installMarketRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
  mcpBindings?: PiPackageMcpBindings;
}) {
  const release = await db.marketRelease.findUnique({
    where: { id: input.releaseId },
    select: { listing: { select: { kind: true } } },
  });
  if (release?.listing.kind === "skill") {
    const result = await installSkillRelease(input);
    return {
      install: result.install,
      kind: "skill" as const,
      resource: result.installedSkill,
      reused: result.reused,
    };
  }
  if (release?.listing.kind === "mcp") {
    const result = await installMcpRelease(input);
    return {
      install: result.install,
      kind: "mcp" as const,
      resource: result.resource,
      reused: result.reused,
    };
  }
  if (release?.listing.kind === "pi-package") {
    const result = await installPiPackageRelease(input);
    return { ...result, kind: "pi-package" as const, resource: null };
  }
  throw new MarketError(
    "listing_unavailable",
    "This market release cannot be installed.",
  );
}

function preservedRecipeConfig(
  recipe: McpMarketManifestV1["mcp"]["recipe"],
  current: unknown,
  workspaceId: string,
  toolCatalog?: McpMarketManifestV1["mcp"]["toolCatalog"],
) {
  const currentConfig = sealMcpEnvironment(installConfig(current), workspaceId);
  const data = recipeToDeploymentData(recipe);
  if (toolCatalog !== undefined) data.installCfg.toolCatalog = toolCatalog;
  const installCfg = sealMcpEnvironment(
    {
      ...data.installCfg,
      // Preserve the envelope's exact key set. New recipe requirements remain in
      // requiredEnv until explicitly configured; old keys survive version restores.
      env: currentConfig.env,
      ...(currentConfig.credentialEnvelope !== undefined
        ? { credentialEnvelope: currentConfig.credentialEnvelope }
        : {}),
    },
    workspaceId,
  );
  return { ...data, installCfg };
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
      where: {
        id: input.installId,
        targetWorkspaceId: input.targetWorkspaceId,
      },
      select: {
        deploymentId: true,
        status: true,
        currentReleaseId: true,
        listing: {
          select: { id: true, kind: true, status: true, latestReleaseId: true },
        },
      },
    });
    if (!install?.deploymentId || install.listing.kind !== "mcp") {
      throw new MarketError(
        "install_not_found",
        "The installed market MCP was not found.",
      );
    }
    if (install.status === "modified" && !input.force) {
      throw new MarketError(
        "local_changes",
        "The installed MCP has local changes.",
      );
    }
    if (
      input.currentReleaseId &&
      install.currentReleaseId !== input.currentReleaseId
    ) {
      if (install.currentReleaseId === input.targetReleaseId)
        return install.deploymentId;
      throw new MarketError(
        "listing_conflict",
        "The installed version changed. Refresh and try again.",
      );
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (
      !releaseId ||
      !install.listing.latestReleaseId ||
      install.listing.status !== "published"
    ) {
      throw new MarketError(
        "listing_conflict",
        "The available release changed. Refresh and try again.",
      );
    }
    const release = await tx.marketRelease.findFirst({
      where: {
        id: releaseId,
        listingId: install.listing.id,
        reviewStatus: "approved",
      },
      select: { manifest: true, checksum: true },
    });
    if (!release)
      throw new MarketError(
        "release_not_found",
        "The requested update was not found.",
      );
    assertInstallableMcpRecipe(
      parseMcpMarketManifest(release.manifest, release.checksum).mcp.recipe,
    );
    return install.deploymentId;
  });
  const operation = await runMcpDeploymentOperation(
    input.targetWorkspaceId,
    deploymentId,
    async () => {
      await stopProcess(deploymentId);
      await removeDeploymentContainer(deploymentId);
      await removeDeploymentConfigVolume(deploymentId);
      return db.$transaction(
        async (tx) => {
          await assertInstallerAccess(
            tx,
            input.targetWorkspaceId,
            input.actorId,
          );
          const install = await tx.marketInstall.findFirst({
            where: {
              id: input.installId,
              targetWorkspaceId: input.targetWorkspaceId,
            },
            include: {
              deployment: true,
              listing: {
                select: {
                  id: true,
                  kind: true,
                  status: true,
                  latestReleaseId: true,
                  sourceServerId: true,
                },
              },
            },
          });
          if (!install?.deployment || install.listing.kind !== "mcp") {
            throw new MarketError(
              "install_not_found",
              "The installed market MCP was not found.",
            );
          }
          if (
            input.currentReleaseId &&
            install.currentReleaseId !== input.currentReleaseId
          ) {
            if (install.currentReleaseId === input.targetReleaseId)
              return install;
            throw new MarketError(
              "listing_conflict",
              "The installed version changed. Refresh and try again.",
            );
          }
          if (install.status === "modified" && !input.force) {
            throw new MarketError(
              "local_changes",
              "The installed MCP has local changes.",
            );
          }
          const releaseId =
            input.targetReleaseId || install.listing.latestReleaseId;
          if (
            !releaseId ||
            !install.listing.latestReleaseId ||
            install.listing.status !== "published"
          ) {
            throw new MarketError(
              "listing_conflict",
              "The available release changed. Refresh and try again.",
            );
          }
          const release = await tx.marketRelease.findFirst({
            where: {
              id: releaseId,
              listingId: install.listing.id,
              reviewStatus: "approved",
            },
          });
          if (!release)
            throw new MarketError(
              "release_not_found",
              "The requested update was not found.",
            );
          const manifest = parseMcpMarketManifest(
            release.manifest,
            release.checksum,
          );
          assertInstallableMcpRecipe(manifest.mcp.recipe);
          const server = install.listing.sourceServerId
            ? await tx.server.findFirst({
                where: {
                  id: install.listing.sourceServerId,
                  verifiedAt: { not: null },
                },
                select: {
                  installCfg: true,
                  verifiedAt: true,
                  verifiedTools: true,
                },
              })
            : null;
          if (
            install.listing.sourceServerId &&
            (!server || !hasVerifiedMcpToolCatalog(server))
          ) {
            throw new MarketError(
              "listing_unavailable",
              "The reviewed catalog MCP is unavailable.",
            );
          }
          const trustedCatalog =
            trustedMcpToolCatalog(release.releaseSummary) ??
            (server
              ? trustedMcpToolCatalog(server.installCfg)
              : manifest.mcp.toolCatalog);
          if (trustedCatalog === undefined)
            throw new MarketError(
              "listing_unavailable",
              "The reviewed MCP has no tools/list snapshot.",
            );
          const data = preservedRecipeConfig(
            manifest.mcp.recipe,
            install.deployment.installCfg,
            input.targetWorkspaceId,
            trustedCatalog,
          );
          const requiresHttpApproval =
            data.source === "remote" &&
            data.sourceRef.startsWith("http:") &&
            data.installCfg.allowUnsafeHttp !== true;
          const requiresSetup =
            requiresHttpApproval ||
            missingRequiredEnvironment(manifest.mcp.recipe, data.installCfg)
              .length > 0;
          await tx.deployment.update({
            where: { id: install.deployment.id },
            data: {
              source: data.source,
              sourceRef: data.sourceRef,
              installCfg: data.installCfg as Prisma.InputJsonValue,
              mcpToolExposure: manifest.mcp.toolExposure,
              mcpAllowedTools: trustedMcpAllowedTools(
                manifest.mcp.allowedTools,
                { toolCatalog: trustedCatalog },
              ),
              ...(requiresSetup
                ? { status: "setup_required" }
                : install.deployment.status === "setup_required"
                  ? { status: "stopped" }
                  : {}),
            },
          });
          return tx.marketInstall.update({
            where: { id: install.id },
            data: {
              currentReleaseId: release.id,
              requestedReleaseId: release.id,
              ignoredReleaseId: null,
              status: requiresSetup ? "setup_required" : "ready",
              requirements: {
                environment: manifest.mcp.recipe.env,
                ...(requiresHttpApproval
                  ? { unsafeHttpConfirmationRequired: true }
                  : {}),
              },
              lastCheckedAt: new Date(),
              lastError: null,
            },
          });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    },
  );
  if (!operation.accepted)
    throw new MarketError(
      "listing_conflict",
      "The workspace is being deleted.",
    );
  return operation.value;
}

export async function updateMarketInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
  mcpBindings?: PiPackageMcpBindings;
}) {
  const install = await db.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
    select: { listing: { select: { kind: true } } },
  });
  if (install?.listing.kind === "skill") return updateSkillMarketInstall(input);
  if (install?.listing.kind === "mcp") return updateMcpInstall(input);
  if (install?.listing.kind === "pi-package")
    return updatePiPackageInstall(input);
  throw new MarketError(
    "install_not_found",
    "The market installation was not found.",
  );
}
