import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  AGENT_MARKET_MANIFEST_VERSION,
  agentReleaseChecksum,
  parseAgentReleaseManifest,
  summarizeAgentReleaseManifest,
  validateAgentReleaseManifestReferences,
  type AgentReleaseManifestV1,
  type AgentReleaseSummary,
} from "@/lib/agents/market";
import {
  resourceListingSchema,
  type ResourceListingInput,
} from "@/lib/market/listing-schema";
import { assertPortableMcpRecipe } from "@/lib/market/mcp-portable-recipe";
import {
  scanAgentReleaseManifest,
  scanMarketArtifact,
  type MarketSecretScan,
} from "@/lib/market/secret-scan";
import { normalizeSkillFiles } from "@/lib/skills/bundle";
import { parseServerRecipe } from "@/lib/workspace/server-recipe";
import { GithubRegistryError } from "./github-registry-source";

export type GithubRegistryAgentArtifact = {
  manifest: AgentReleaseManifestV1;
  listing: ResourceListingInput;
  checksum: string;
  scan: MarketSecretScan;
  summary: AgentReleaseSummary;
};

/** The registry header is not part of the existing immutable portable graph. */
export function buildGithubRegistryAgentRelease(
  raw: unknown,
): GithubRegistryAgentArtifact {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GithubRegistryError("resource_descriptor_invalid");
  }
  const {
    kind,
    listing: rawListing,
    ...graph
  } = raw as Record<string, unknown>;
  if (kind !== "agent")
    throw new GithubRegistryError("resource_descriptor_invalid");
  const listing = resourceListingSchema.safeParse(rawListing);
  if (!listing.success)
    throw new GithubRegistryError("resource_listing_invalid");
  const manifest = parseAgentReleaseManifest(graph);
  validateAgentReleaseManifestReferences(manifest);
  // Historical Toolkit composites remain readable, but cannot be newly authored
  // as capabilities: installations require explicit native package authorization.
  if (
    manifest.toolkits.length ||
    manifest.agents.some((agent) => agent.toolkitKeys.length)
  ) {
    throw new GithubRegistryError("resource_descriptor_invalid");
  }
  for (const deployment of manifest.deployments) {
    // GitHub descriptors declare required names; workspace values are rebound
    // privately at install/setup and cannot be classified safely by token shape.
    if (Object.keys(deployment.publicEnv).length) {
      throw new GithubRegistryError("resource_secrets_detected");
    }
    const recipe = parseServerRecipe({
      ...deployment,
      ref: deployment.sourceRef,
      env: deployment.requiredEnv,
    });
    if (!recipe) throw new GithubRegistryError("resource_descriptor_invalid");
    assertPortableMcpRecipe(recipe);
  }
  for (const skill of manifest.skills) {
    const normalized = normalizeSkillFiles(skill.files);
    if (
      normalized.length !== skill.files.length ||
      normalized.some(
        (file, index) =>
          file.path !== skill.files[index].path ||
          file.content !== skill.files[index].content,
      )
    ) {
      throw new GithubRegistryError("resource_descriptor_invalid");
    }
  }
  const scan = scanAgentReleaseManifest(manifest, listing.data.summary);
  if (
    scan.status === "blocked" ||
    scanMarketArtifact(listing.data).status === "blocked"
  ) {
    throw new GithubRegistryError("resource_secrets_detected");
  }
  return {
    manifest,
    listing: listing.data,
    checksum: agentReleaseChecksum(manifest),
    scan,
    summary: summarizeAgentReleaseManifest(manifest),
  };
}

/** Called only inside the registry's authorized, generation-CAS transaction. */
export async function publishGithubRegistryAgentRelease(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string | null;
    namespace: string;
    resourceId: string;
    visibility: string;
    artifact?: GithubRegistryAgentArtifact;
    agentListingId?: string;
    agentReleaseId?: string;
  },
): Promise<{ agentListingId: string; agentReleaseId: string }> {
  if (input.visibility !== "public" && input.visibility !== "private") {
    throw new GithubRegistryError("registry_configuration_invalid");
  }
  let listing = input.agentListingId
    ? await tx.agentListing.findUnique({ where: { id: input.agentListingId } })
    : null;
  if (
    input.agentListingId &&
    (!listing || listing.publisherWorkspaceId !== input.workspaceId)
  ) {
    throw new GithubRegistryError("resource_kind_conflict");
  }
  if (!listing) {
    if (!input.artifact || input.agentReleaseId)
      throw new GithubRegistryError("resource_artifact_missing");
    const identity = `${input.namespace}/${input.resourceId}`;
    const suffix = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 24);
    const stem = identity
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 74);
    const slug = `${stem || "agent"}-${suffix}`;
    listing = await tx.agentListing.create({
      data: {
        ...input.artifact.listing,
        publisherKind: "workspace",
        publisherWorkspaceId: input.workspaceId,
        publishedById: input.userId,
        sourceAgentId: null,
        slug,
        directorySlug: slug,
        visibility: input.visibility,
      },
    });
  }
  let release = input.agentReleaseId
    ? await tx.agentRelease.findUnique({ where: { id: input.agentReleaseId } })
    : null;
  if (
    input.agentReleaseId &&
    (!release ||
      release.listingId !== listing.id ||
      release.reviewStatus !== "approved")
  ) {
    throw new GithubRegistryError("resource_kind_conflict");
  }
  if (!release) {
    if (!input.artifact)
      throw new GithubRegistryError("resource_artifact_missing");
    const artifact = input.artifact;
    const latest = await tx.agentRelease.aggregate({
      where: { listingId: listing.id },
      _max: { version: true },
    });
    release = await tx.agentRelease.create({
      data: {
        listingId: listing.id,
        version: (latest._max.version ?? 0) + 1,
        manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
        manifest: artifact.manifest as Prisma.InputJsonValue,
        releaseSummary: artifact.summary as Prisma.InputJsonValue,
        checksum: artifact.checksum,
        name: artifact.listing.name,
        author: artifact.listing.author,
        summary: artifact.listing.summary,
        iconUrl: artifact.listing.iconUrl,
        tags: artifact.listing.tags,
        reviewStatus: "approved",
        reviewedById: input.userId,
        reviewedAt: new Date(),
        reviewNote: "GitHub registry administrator trust",
      },
    });
  }
  await tx.agentListing.update({
    where: { id: listing.id },
    data: {
      name: release.name,
      author: release.author,
      summary: release.summary,
      iconUrl: release.iconUrl,
      tags: release.tags,
      latestReleaseId: release.id,
      latestVersion: Math.max(listing.latestVersion, release.version),
      pendingReleaseId: null,
      visibility: input.visibility,
      publishedAt: release.publishedAt,
    },
  });
  // Moderation can race with a sync: never revive an explicit takedown,
  // including when a new immutable version or a withdrawn entry returns.
  await tx.agentListing.updateMany({
    where: { id: listing.id, status: { not: "disabled" } },
    data: { status: "published" },
  });
  return { agentListingId: listing.id, agentReleaseId: release.id };
}
