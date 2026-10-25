import "server-only";
import { createHash } from "node:crypto";
import type { MarketRelease } from "@prisma/client";
import {
  hasMcpToolCatalog,
  readMcpToolCatalog,
} from "@/lib/process/mcp-tool-catalog";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "./artifact";
import type { MarketRuntimeCompatibility } from "./listings";
import { parsePiPackageReleaseManifest } from "./pi-package-manifest";
import { parseSkillReleaseManifest } from "./skill-manifest";
import { parseMcpMarketManifest } from "./resources";
import { MarketError } from "./skills";

export type MarketInstallReleaseDiff = {
  from: { releaseId: string; version: number };
  to: { releaseId: string; version: number };
  files: {
    items: Array<{ path: string; status: "added" | "removed" | "changed" }>;
    page: number;
    pageSize: number;
    total: number;
    counts: { added: number; removed: number; changed: number };
  };
  permissions: { before: ReleasePermissions; after: ReleasePermissions };
  compatibility: {
    before: MarketRuntimeCompatibility | null;
    after: MarketRuntimeCompatibility | null;
  };
  configurationChanged: boolean;
};
type ReleasePermissions = {
  requirements: Array<{ key: string; name: string; tools: string[] }>;
  requiredEnvironment: string[];
  transport: "stdio" | "streamable-http" | "sse" | null;
};
type ReleaseProjection = {
  files: Map<string, string>;
  permissions: ReleasePermissions;
  compatibility: MarketRuntimeCompatibility | null;
  configurationChecksum: string;
};

function projectRelease(
  kind: string,
  release: Pick<MarketRelease, "manifest" | "checksum" | "releaseSummary">,
): ReleaseProjection {
  const files = new Map<string, string>();
  const permissions: ReleasePermissions = {
    requirements: [],
    requiredEnvironment: [],
    transport: null,
  };
  if (kind === "pi-package") {
    const { package: pkg } = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    for (const entry of pkg.entries)
      files.set(
        entry.path,
        entry.type === "file"
          ? `file:${entry.sha256}:${entry.executable}`
          : entry.type === "symlink"
            ? `symlink:${entry.target}`
            : "directory",
      );
    permissions.requirements = (pkg.toolplane?.mcp ?? [])
      .map((requirement) => ({
        key: requirement.key,
        name: requirement.name,
        tools: [...new Set(requirement.tools)].sort(),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      files,
      permissions,
      compatibility: {
        runtime: "pi-sdk",
        piVersion: pkg.runtime.piVersion,
        nodeMajor: pkg.runtime.nodeMajor,
        platform: pkg.runtime.platform,
        arch: pkg.runtime.arch,
      },
      configurationChecksum: marketReleaseChecksum({
        resources: pkg.resources,
        runtime: pkg.runtime,
        toolplane: pkg.toolplane ?? null,
      }),
    };
  }
  if (kind === "skill") {
    const { skill } = parseSkillReleaseManifest(
      release.manifest,
      release.checksum,
    );
    files.set(
      "SKILL.md",
      createHash("sha256").update(skill.content, "utf8").digest("hex"),
    );
    for (const file of skill.files)
      files.set(
        file.path,
        createHash("sha256")
          .update(file.content, file.encoding === "base64" ? "base64" : "utf8")
          .digest("hex"),
      );
    return {
      files,
      permissions,
      compatibility: null,
      configurationChecksum: marketReleaseChecksum({
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        userInvocable: skill.userInvocable,
        agentInvocable: skill.agentInvocable,
        effort: skill.effort,
        source: skill.source,
      }),
    };
  }
  if (kind === "mcp") {
    const { mcp } = parseMcpMarketManifest(release.manifest, release.checksum);
    const catalog = hasMcpToolCatalog(release.releaseSummary)
      ? readMcpToolCatalog(release.releaseSummary)
      : mcp.toolCatalog;
    const discovered = catalog?.map((tool) => tool.name);
    permissions.transport =
      mcp.recipe.source === "remote"
        ? (mcp.recipe.transport ?? "streamable-http")
        : "stdio";
    permissions.requiredEnvironment = [
      ...new Set([
        ...mcp.recipe.env,
        ...(mcp.recipe.bearerEnv ? [mcp.recipe.bearerEnv] : []),
        ...Object.values(mcp.recipe.headerEnv ?? {}),
      ]),
    ].sort();
    permissions.requirements = [
      {
        key: "mcp",
        name: mcp.name,
        tools: [
          ...new Set(
            mcp.toolExposure === "allowlist"
              ? mcp.allowedTools.filter(
                  (name) => !discovered || discovered.includes(name),
                )
              : (discovered ?? []),
          ),
        ].sort(),
      },
    ];
    return {
      files,
      permissions,
      compatibility: { runtime: "mcp", transport: permissions.transport },
      configurationChecksum: marketReleaseChecksum({
        recipe: mcp.recipe,
        toolExposure: mcp.toolExposure,
        allowedTools: mcp.allowedTools,
      }),
    };
  }
  throw new MarketError(
    "unsupported_resource_kind",
    "Release comparison supports Pi packages, Skills and MCP only.",
  );
}

export async function getMarketInstallReleaseDiff(input: {
  workspaceId: string;
  userId: string;
  installId: string;
  targetReleaseId: string;
  page?: number;
  pageSize?: number;
}): Promise<MarketInstallReleaseDiff> {
  const workspace = await db.workspace.findFirst({
    where: {
      id: input.workspaceId,
      status: "active",
      OR: [
        { ownerId: input.userId },
        { members: { some: { userId: input.userId } } },
      ],
    },
    select: { id: true },
  });
  if (!workspace)
    throw new MarketError("not_authorized", "Workspace access was denied.");
  const install = await db.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: workspace.id },
    include: { listing: true, currentRelease: true },
  });
  if (!install)
    throw new MarketError(
      "install_not_found",
      "The market installation was not found.",
    );
  if (
    install.listing.status !== "published" ||
    !(
      install.listing.visibility === "public" ||
      (install.listing.visibility === "private" &&
        install.listing.publisherWorkspaceId === workspace.id)
    )
  )
    throw new MarketError(
      "listing_unavailable",
      "The market listing is unavailable.",
    );
  if (
    install.currentRelease.listingId !== install.listingId ||
    install.currentRelease.reviewStatus !== "approved"
  )
    throw new MarketError(
      "release_not_found",
      "The installed release is unavailable.",
    );
  const target = await db.marketRelease.findFirst({
    where: {
      id: input.targetReleaseId,
      listingId: install.listingId,
      reviewStatus: "approved",
    },
  });
  if (!target)
    throw new MarketError(
      "release_not_found",
      "The target release is unavailable.",
    );
  let before: ReleaseProjection;
  let after: ReleaseProjection;
  try {
    before = projectRelease(install.listing.kind, install.currentRelease);
    after = projectRelease(install.listing.kind, target);
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw new MarketError(
      "invalid_manifest",
      "The release comparison could not validate its artifacts.",
    );
  }
  const page =
    Number.isSafeInteger(input.page) &&
    input.page !== undefined &&
    input.page > 0
      ? input.page
      : 1;
  const pageSize =
    Number.isSafeInteger(input.pageSize) &&
    input.pageSize !== undefined &&
    input.pageSize > 0
      ? Math.min(100, input.pageSize)
      : 50;
  const items: MarketInstallReleaseDiff["files"]["items"] = [];
  const counts = { added: 0, removed: 0, changed: 0 };
  const start = (page - 1) * pageSize;
  let total = 0;
  for (const path of [
    ...new Set([...before.files.keys(), ...after.files.keys()]),
  ].sort()) {
    const previous = before.files.get(path);
    const next = after.files.get(path);
    if (previous === next) continue;
    const status =
      previous === undefined
        ? "added"
        : next === undefined
          ? "removed"
          : "changed";
    counts[status]++;
    if (total >= start && total < start + pageSize)
      items.push({ path, status });
    total++;
  }
  return {
    from: {
      releaseId: install.currentRelease.id,
      version: install.currentRelease.version,
    },
    to: { releaseId: target.id, version: target.version },
    files: { items, page, pageSize, total, counts },
    permissions: { before: before.permissions, after: after.permissions },
    compatibility: { before: before.compatibility, after: after.compatibility },
    configurationChanged:
      before.configurationChecksum !== after.configurationChecksum,
  };
}
