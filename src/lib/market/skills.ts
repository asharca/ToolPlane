import "server-only";
import { writeAudit } from "@/lib/observability/audit";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  visibleListings,
  type MarketViewer,
} from "@/lib/market/listing-access";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { removeAgentRevisionPackageInTransaction } from "@/lib/agents/revisions";
import {
  parseAssistantReleaseManifest,
  type AssistantReleaseManifestV1,
} from "@/lib/market/assistant-manifest";
import { parseSkillReleaseManifest } from "@/lib/market/skill-manifest";
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
  type MarketSecretScan,
} from "@/lib/market/secret-scan";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
  projectPiPackageSummary,
} from "@/lib/market/pi-package-manifest";
import type { PiPackageSummary } from "@/lib/market/pi-package-manifest";
import { killProcess } from "@/lib/process/supervisor";
import { removeDeploymentContainer } from "@/lib/process/deployment-runtime-container";
import { removeDeploymentConfigVolume } from "@/lib/process/deployment-config-volume";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";

export type MarketErrorCode =
  | "not_authorized"
  | "source_not_found"
  | "listing_conflict"
  | "release_not_found"
  | "listing_unavailable"
  | "invalid_manifest"
  | "unsupported_resource_kind"
  | "invalid_categories"
  | "idempotency_conflict"
  | "already_installed"
  | "install_not_found"
  | "in_use"
  | "local_changes"
  | "capture_busy"
  | "capture_image_missing"
  | "package_capture_failed"
  | "package_platform_mismatch"
  | "pi_package_invalid_selection"
  | "pi_package_executable_confirmation_required"
  | "pi_package_source_unavailable"
  | "pi_package_tools_unavailable"
  | "pi_package_invalid_bindings"
  | "pi_package_mcp_binding_required"
  | "pi_package_agent_busy"
  | "source_unavailable"
  | "official_package_unavailable"
  | "source_invalid"
  | "source_credentials_invalid"
  | "source_network_blocked"
  | "source_auth_failed"
  | "source_redirect_blocked"
  | "source_response_too_large"
  | "source_response_invalid"
  | "source_credentials_required"
  | "source_kind_mismatch"
  | "source_scope_mismatch"
  | "source_changed"
  | "source_preview_required"
  | "source_ref_missing"
  | "source_not_trackable"
  | "tracking_not_found"
  | "tracking_conflict"
  | "registry_confirmation_required"
  | "registry_tag_invalid"
  | "registry_artifact_invalid"
  | "registry_version_conflict"
  | "pi_extensions_missing";

export class MarketError extends Error {
  constructor(
    readonly code: MarketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketError";
  }
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

async function validatedCategoryIds(
  tx: Prisma.TransactionClient,
  categoryIds: string[],
) {
  const uniqueIds = [...new Set(categoryIds)];
  if (
    uniqueIds.length === 0 ||
    uniqueIds.length !== categoryIds.length ||
    (await tx.category.count({ where: { id: { in: uniqueIds } } })) !==
      uniqueIds.length
  ) {
    throw new MarketError(
      "invalid_categories",
      "Select one or more valid marketplace categories.",
    );
  }
  return uniqueIds;
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

function assistantReleaseSummary(manifest: AssistantReleaseManifestV1) {
  return {
    providerFormat: manifest.assistant.modelRequirement?.providerFormat ?? null,
    model: manifest.assistant.modelRequirement?.model ?? null,
    mcpCount: manifest.assistant.mcpRequirements.length,
    maxSteps: manifest.assistant.maxSteps,
  };
}

export async function approveMarketRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
  categoryIds?: string[];
}) {
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
              pendingReleaseId: true,
              publishedAt: true,
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
      const categoryIds = await validatedCategoryIds(
        tx,
        input.categoryIds ?? release.categoryIds,
      );
      let candidate:
        | {
            slug: string;
            name: string;
            summary: string | null;
            iconUrl: string | null;
            tags: string[];
            author: string;
          }
        | undefined;
      let metadata: Prisma.InputJsonObject;
      let scanResult: MarketSecretScan;
      if (release.listing.kind === "skill") {
        const manifest = parseSkillReleaseManifest(
          release.manifest,
          release.checksum,
        );
        candidate = manifest.listing;
        metadata = {
          author: candidate?.author ?? "",
          source: manifest.skill.source.type,
        };
        scanResult = scanSkillReleaseManifest(manifest, release.releaseNotes);
      } else if (release.listing.kind === "assistant") {
        const manifest = parseAssistantReleaseManifest(
          release.manifest,
          release.checksum,
        );
        candidate = manifest.listing;
        metadata = {
          author: candidate?.author ?? "",
          type: "chat",
          ...assistantReleaseSummary(manifest),
        };
        scanResult = scanMarketArtifact(manifest, release.releaseNotes);
      } else {
        throw new MarketError(
          "invalid_manifest",
          "This release kind is not supported yet.",
        );
      }
      if (scanResult.status === "blocked") {
        throw new MarketError(
          "invalid_manifest",
          "The release contains possible credentials.",
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
          categoryIds,
          reviewNote: input.reviewNote ?? null,
        },
      });
      return tx.marketListing.update({
        where: { id: release.listing.id },
        data: {
          ...(candidate
            ? {
                slug: candidate.slug,
                name: candidate.name,
                summary: candidate.summary,
                iconUrl: candidate.iconUrl,
                tags: candidate.tags,
                metadata,
              }
            : {}),
          status: "published",
          latestReleaseId: release.id,
          pendingReleaseId: null,
          publishedAt: release.listing.publishedAt ?? publishedAt,
          categories: { set: categoryIds.map((id) => ({ id })) },
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export async function rejectMarketRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
}) {
  return db.$transaction(async (tx) => {
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
          select: { id: true, pendingReleaseId: true, latestReleaseId: true },
        },
      },
    });
    if (!release || release.listing.pendingReleaseId !== release.id) {
      throw new MarketError(
        "release_not_found",
        "The pending release was not found.",
      );
    }
    await tx.marketRelease.update({
      where: { id: release.id },
      data: {
        reviewStatus: "rejected",
        reviewedById: admin.id,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote?.trim().slice(0, 4_000) || null,
      },
    });
    await writeAudit(tx, {
      actorId: admin.id,
      action: "market.release.rejected",
      targetType: "marketListing",
      targetId: release.listing.id,
      changes: { releaseId: release.id, reviewNote: input.reviewNote ?? null },
    });
    return tx.marketListing.update({
      where: { id: release.listing.id },
      data: {
        pendingReleaseId: null,
        status: release.listing.latestReleaseId ? "published" : "draft",
      },
    });
  });
}

async function installSkillReleaseTransaction(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    installedById: string;
    idempotencyKey: string;
  },
) {
  await assertInstallerAccess(tx, input.targetWorkspaceId, input.installedById);
  const reused = await tx.marketInstall.findUnique({
    where: {
      targetWorkspaceId_idempotencyKey: {
        targetWorkspaceId: input.targetWorkspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { installedSkill: true },
  });
  if (reused) {
    if (
      reused.requestedReleaseId !== input.releaseId ||
      !reused.installedSkill
    ) {
      throw new MarketError(
        "idempotency_conflict",
        "This idempotency key has already been used.",
      );
    }
    return {
      install: reused,
      installedSkill: reused.installedSkill,
      reused: true,
    };
  }

  const release = await tx.marketRelease.findUnique({
    where: { id: input.releaseId },
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
        },
      },
    },
  });
  if (!release)
    throw new MarketError(
      "release_not_found",
      "The market release was not found.",
    );
  if (
    release.listing.kind !== "skill" ||
    release.listing.status !== "published" ||
    release.reviewStatus !== "approved" ||
    release.listing.latestReleaseId !== release.id ||
    (release.listing.visibility !== "public" &&
      release.listing.publisherWorkspaceId !== input.targetWorkspaceId)
  ) {
    throw new MarketError(
      "listing_unavailable",
      "This skill release is not available for installation.",
    );
  }
  const existing = await tx.marketInstall.findUnique({
    where: {
      targetWorkspaceId_listingId: {
        targetWorkspaceId: input.targetWorkspaceId,
        listingId: release.listing.id,
      },
    },
    select: { id: true },
  });
  if (existing)
    throw new MarketError(
      "already_installed",
      "This market skill is already installed.",
    );

  const manifest = parseSkillReleaseManifest(
    release.manifest,
    release.checksum,
  );
  const installedSkill = await tx.installedSkill.create({
    data: {
      workspaceId: input.targetWorkspaceId,
      skillId: null,
      name: manifest.skill.name,
      slug: manifest.skill.slug,
      description: manifest.skill.description,
      content: manifest.skill.content,
      files: manifest.skill.files as Prisma.InputJsonValue,
      source: "market",
      sourceRef: `${release.listing.namespace}/${release.listing.slug}@${release.version}`,
      status: "published",
      userInvocable: manifest.skill.userInvocable,
      agentInvocable: manifest.skill.agentInvocable,
      effort: manifest.skill.effort,
    },
  });
  const install = await tx.marketInstall.create({
    data: {
      listingId: release.listing.id,
      currentReleaseId: release.id,
      requestedReleaseId: release.id,
      targetWorkspaceId: input.targetWorkspaceId,
      installedById: input.installedById,
      installedSkillId: installedSkill.id,
      idempotencyKey: input.idempotencyKey,
      status: "ready",
      requirements: {},
      resourceMap: { installedSkillId: installedSkill.id },
      lastCheckedAt: new Date(),
    },
  });
  await tx.marketListing.update({
    where: { id: release.listing.id },
    data: { installCount: { increment: 1 } },
  });
  return { install, installedSkill, reused: false };
}

export async function installSkillRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
}) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new MarketError(
      "idempotency_conflict",
      "A valid idempotency key is required.",
    );
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) =>
          installSkillReleaseTransaction(tx, { ...input, idempotencyKey }),
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof MarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ["P2002", "P2034"])) throw error;
    }
  }
  throw new MarketError(
    "listing_conflict",
    lastError instanceof Error
      ? lastError.message
      : "The market install changed. Try again.",
  );
}

export async function updateSkillMarketInstall(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
  force?: boolean;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
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
              installedSkill: { select: { id: true } },
              listing: {
                select: {
                  id: true,
                  kind: true,
                  namespace: true,
                  slug: true,
                  status: true,
                  latestReleaseId: true,
                },
              },
            },
          });
          if (!install?.installedSkill || install.listing.kind !== "skill") {
            throw new MarketError(
              "install_not_found",
              "The installed market skill was not found.",
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
              "The installed skill has local content changes.",
            );
          }
          const releaseId =
            input.targetReleaseId || install.listing.latestReleaseId;
          if (!releaseId || install.listing.status !== "published") {
            throw new MarketError(
              "listing_unavailable",
              "No published update is available.",
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
          const manifest = parseSkillReleaseManifest(
            release.manifest,
            release.checksum,
          );
          await tx.installedSkill.update({
            where: { id: install.installedSkill.id },
            data: {
              name: manifest.skill.name,
              slug: manifest.skill.slug,
              description: manifest.skill.description,
              content: manifest.skill.content,
              files: manifest.skill.files as Prisma.InputJsonValue,
              sourceRef: `${install.listing.namespace}/${install.listing.slug}@${release.version}`,
            },
          });
          return tx.marketInstall.update({
            where: { id: install.id },
            data: {
              currentReleaseId: release.id,
              ignoredReleaseId: null,
              status: "ready",
              lastCheckedAt: new Date(),
              lastError: null,
            },
          });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof MarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ["P2034"])) throw error;
    }
  }
  throw new MarketError(
    "listing_conflict",
    lastError instanceof Error
      ? lastError.message
      : "The market update changed. Try again.",
  );
}

export async function ignoreMarketUpdate(input: {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
  targetReleaseId?: string;
  currentReleaseId?: string;
}) {
  return db.$transaction(async (tx) => {
    await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
    const install = await tx.marketInstall.findFirst({
      where: {
        id: input.installId,
        targetWorkspaceId: input.targetWorkspaceId,
      },
      include: { listing: { select: { status: true, latestReleaseId: true } } },
    });
    if (!install)
      throw new MarketError(
        "install_not_found",
        "The market installation was not found.",
      );
    if (
      input.currentReleaseId &&
      install.currentReleaseId !== input.currentReleaseId
    ) {
      if (install.ignoredReleaseId === input.targetReleaseId) return install;
      throw new MarketError(
        "listing_conflict",
        "The installed version changed. Refresh and try again.",
      );
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (
      !releaseId ||
      install.listing.status !== "published" ||
      releaseId !== install.listing.latestReleaseId
    ) {
      throw new MarketError(
        "listing_conflict",
        "The available release changed. Refresh and try again.",
      );
    }
    return tx.marketInstall.update({
      where: { id: install.id },
      data: { ignoredReleaseId: releaseId, lastCheckedAt: new Date() },
    });
  });
}

type RemoveMarketInstallInput = {
  installId: string;
  targetWorkspaceId: string;
  actorId: string;
};

async function removableMarketInstall(
  tx: Prisma.TransactionClient,
  input: RemoveMarketInstallInput,
) {
  await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.targetWorkspaceId} FOR UPDATE`;
  const install = await tx.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
    include: {
      listing: { select: { kind: true } },
      piPackageClientInstallations: {
        where: { status: "active" },
        select: { id: true, label: true },
      },
      deployment: {
        select: {
          id: true,
          source: true,
          sandbox: { select: { id: true } },
          _count: {
            select: {
              agentLinks: true,
              toolkitLinks: true,
              chatAssistantGrants: true,
            },
          },
        },
      },
      installedSkill: {
        select: {
          id: true,
          _count: { select: { agentLinks: true, toolkitLinks: true } },
        },
      },
      toolkit: {
        select: {
          id: true,
          _count: {
            select: { agentLinks: true, apiTokens: true, installLinks: true },
          },
        },
      },
    },
  });
  if (!install)
    throw new MarketError(
      "install_not_found",
      "The market installation was not found.",
    );
  if (install.piPackageClientInstallations.length)
    throw new MarketError(
      "in_use",
      `Revoke these Pi package client installations before uninstalling: ${install.piPackageClientInstallations.map((client) => client.label).join(", ")}`,
    );
  if (
    install.installedSkill &&
    (install.installedSkill._count.agentLinks > 0 ||
      install.installedSkill._count.toolkitLinks > 0)
  ) {
    throw new MarketError(
      "in_use",
      "Remove this skill from agents and toolkits before uninstalling it.",
    );
  }
  if (
    install.deployment &&
    (install.deployment.sandbox ||
      install.deployment._count.agentLinks > 0 ||
      install.deployment._count.toolkitLinks > 0 ||
      install.deployment._count.chatAssistantGrants > 0)
  ) {
    throw new MarketError(
      "in_use",
      "Remove this MCP from assistants, agents, and toolkits before uninstalling it.",
    );
  }
  if (
    install.toolkit &&
    (install.toolkit._count.agentLinks > 0 ||
      install.toolkit._count.apiTokens > 0 ||
      install.toolkit._count.installLinks > 0)
  ) {
    throw new MarketError(
      "in_use",
      "Remove this toolkit from agents and revoke its access links before uninstalling it.",
    );
  }
  const resource =
    install.listing.kind === "skill"
      ? install.installedSkill
      : install.listing.kind === "mcp"
        ? install.deployment
        : install.listing.kind === "toolkit"
          ? install.toolkit
          : install.listing.kind === "pi-package"
            ? install
            : null;
  if (!resource)
    throw new MarketError(
      "install_not_found",
      "The installed market resource was not found.",
    );
  return install;
}

function marketResourceIds(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>)[key];
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

async function removeMarketInstallDatabase(input: RemoveMarketInstallInput) {
  return db.$transaction(
    async (tx) => {
      const install = await removableMarketInstall(tx, input);
      if (install.listing.kind === "pi-package") {
        const affectedAgents = await tx.agent.findMany({
          where: {
            workspaceId: input.targetWorkspaceId,
            runtimeKind: "pi-sdk",
            retiredAt: null,
            currentRevisionVersion: { gt: 0 },
            revisions: {
              some: {
                config: {
                  path: ["packages"],
                  array_contains: [{ marketInstallId: install.id }],
                },
              },
            },
          },
          select: { id: true, currentRevisionVersion: true },
          orderBy: { id: "asc" },
        });
        for (const agent of affectedAgents) {
          const current = await tx.agentRevision.findUniqueOrThrow({
            where: {
              agentId_version: {
                agentId: agent.id,
                version: agent.currentRevisionVersion,
              },
            },
          });
          const config = AgentRevisionConfigSchema.parse(current.config);
          if (
            !config.packages.some((pin) => pin.marketInstallId === install.id)
          )
            continue;
          // Narrow the applied revision only: unrelated unreviewed drafts stay unapplied.
          await removeAgentRevisionPackageInTransaction(
            tx,
            input.targetWorkspaceId,
            agent.id,
            current.id,
            install.id,
          );
        }
        await tx.agentPiPackage.deleteMany({
          where: { marketInstallId: install.id },
        });
        // Uninstall changes defaults only; session references retain code and live MCP grants.
        // Package bindings point at shared deployments, never package-owned MCP resources.
        await tx.marketInstall.update({
          where: { id: install.id },
          data: { status: "uninstalled" },
        });
        if (install.status !== "uninstalled")
          await tx.marketListing.updateMany({
            where: { id: install.listingId, installCount: { gt: 0 } },
            data: { installCount: { decrement: 1 } },
          });
        return { id: install.id };
      }
      const ownedSkillIds = marketResourceIds(
        install.resourceMap,
        "ownedInstalledSkillIds",
      );
      const toolkitSkillIds = ownedSkillIds.length
        ? ownedSkillIds
        : marketResourceIds(install.resourceMap, "installedSkillIds");
      await tx.piPackageClientInstallation.deleteMany({
        where: {
          marketInstallId: install.id,
          workspaceId: input.targetWorkspaceId,
          status: { not: "active" },
        },
      });
      await tx.marketInstall.delete({ where: { id: install.id } });
      if (install.listing.kind === "skill" && install.installedSkill) {
        await tx.installedSkill.delete({
          where: { id: install.installedSkill.id },
        });
      } else if (install.listing.kind === "mcp" && install.deployment) {
        await tx.deployment.delete({ where: { id: install.deployment.id } });
      } else if (install.listing.kind === "toolkit" && install.toolkit) {
        await tx.toolkit.delete({ where: { id: install.toolkit.id } });
        if (toolkitSkillIds.length) {
          await tx.installedSkill.deleteMany({
            where: {
              id: { in: toolkitSkillIds },
              workspaceId: input.targetWorkspaceId,
              agentLinks: { none: {} },
              toolkitLinks: { none: {} },
              marketInstall: { is: null },
            },
          });
        }
      }
      await tx.marketListing.updateMany({
        where: { id: install.listingId, installCount: { gt: 0 } },
        data: { installCount: { decrement: 1 } },
      });
      return { id: install.id };
    },
    { timeout: 120_000 },
  );
}

export async function removeMarketInstall(input: RemoveMarketInstallInput) {
  const install = await db.$transaction((tx) =>
    removableMarketInstall(tx, input),
  );
  if (install.listing.kind !== "mcp" || !install.deployment) {
    return removeMarketInstallDatabase(input);
  }
  const operation = await runMcpDeploymentOperation(
    input.targetWorkspaceId,
    install.deployment.id,
    async () => {
      const current = await db.$transaction((tx) =>
        removableMarketInstall(tx, input),
      );
      if (!current.deployment)
        throw new MarketError(
          "install_not_found",
          "The installed market MCP was not found.",
        );
      await killProcess(current.deployment.id, { preventRestart: true });
      if (current.deployment.source) {
        await removeDeploymentContainer(current.deployment.id);
        await removeDeploymentConfigVolume(current.deployment.id);
      }
      return removeMarketInstallDatabase(input);
    },
  );
  if (!operation.accepted)
    throw new MarketError(
      "listing_conflict",
      "The workspace is being deleted.",
    );
  return operation.value;
}

type InstalledPiPackageRelease = {
  id: string;
  version: number;
  manifest: Prisma.JsonValue;
  checksum: string;
  releaseNotes: string | null;
};

function installedPiPackageSummary(
  release: InstalledPiPackageRelease,
): PiPackageSummary {
  try {
    const manifest = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    if (
      scanPiPackageReleaseManifest(manifest, release.releaseNotes).status ===
      "blocked"
    ) {
      throw new MarketError(
        "invalid_manifest",
        "The Pi package release failed its security scan.",
      );
    }
    return projectPiPackageSummary(manifest.package);
  } catch {
    throw new MarketError(
      "invalid_manifest",
      "The Pi package release is invalid or unavailable.",
    );
  }
}

export async function listWorkspaceMarketInstalls(workspaceId: string) {
  const installs = await db.marketInstall.findMany({
    where: { targetWorkspaceId: workspaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      currentRelease: {
        select: {
          id: true,
          version: true,
          manifest: true,
          checksum: true,
          releaseNotes: true,
          reviewStatus: true,
          releaseSummary: true,
        },
      },
      agentPiPackages: {
        where: {
          agent: { workspaceId },
          marketInstall: { targetWorkspaceId: workspaceId },
        },
        orderBy: { agentId: "asc" },
        select: {
          agentId: true,
          releaseId: true,
          agent: { select: { id: true, name: true, runtimeKind: true } },
          release: {
            select: {
              id: true,
              version: true,
              manifest: true,
              checksum: true,
              releaseNotes: true,
              reviewStatus: true,
              listingId: true,
            },
          },
        },
      },
      ignoredRelease: { select: { id: true } },
      listing: {
        select: {
          id: true,
          kind: true,
          namespace: true,
          slug: true,
          name: true,
          iconUrl: true,
          status: true,
          visibility: true,
          publisherWorkspaceId: true,
          releases: {
            where: { reviewStatus: "approved" },
            orderBy: { version: "desc" },
            select: {
              id: true,
              version: true,
              checksum: true,
              releaseNotes: true,
            },
          },
          latestRelease: {
            select: { id: true, version: true, releaseNotes: true },
          },
        },
      },
      deployment: { select: { id: true, status: true } },
      installedSkill: { select: { id: true, status: true } },
      toolkit: { select: { id: true, enabled: true } },
      agent: { select: { id: true, runtimeKind: true } },
    },
  });
  const summaries = new Map<string, PiPackageSummary>();
  const summarize = (release: InstalledPiPackageRelease): PiPackageSummary => {
    const cached = summaries.get(release.id);
    if (cached) return cached;
    const summary = installedPiPackageSummary(release);
    summaries.set(release.id, summary);
    return summary;
  };
  return installs.map((install) => {
    const piPackage =
      install.listing.kind === "pi-package"
        ? summarize(install.currentRelease)
        : null;
    return {
      ...install,
      piPackage,
      approvedReleases: install.listing.releases,
      currentRelease:
        install.listing.kind === "pi-package"
          ? {
              id: install.currentRelease.id,
              version: install.currentRelease.version,
              checksum: install.currentRelease.checksum,
              reviewStatus: install.currentRelease.reviewStatus,
              reviewPolicy:
                install.currentRelease.releaseSummary &&
                typeof install.currentRelease.releaseSummary === "object" &&
                !Array.isArray(install.currentRelease.releaseSummary) &&
                install.currentRelease.releaseSummary.reviewPolicy ===
                  "workspace-owner-trust"
                  ? "workspace-owner-trust"
                  : install.currentRelease.releaseSummary &&
                      typeof install.currentRelease.releaseSummary ===
                        "object" &&
                      !Array.isArray(install.currentRelease.releaseSummary) &&
                      install.currentRelease.releaseSummary.reviewPolicy ===
                        "official-directory"
                    ? "official-directory"
                    : "manual",
              piPackage,
            }
          : {
              id: install.currentRelease.id,
              version: install.currentRelease.version,
            },
      agentPiPackages: install.agentPiPackages.map((binding) => {
        if (
          install.listing.kind !== "pi-package" ||
          binding.release.listingId !== install.listingId
        ) {
          throw new MarketError(
            "invalid_manifest",
            "The Pi package binding is invalid.",
          );
        }
        return {
          agentId: binding.agentId,
          releaseId: binding.releaseId,
          agent: binding.agent,
          release: {
            id: binding.release.id,
            version: binding.release.version,
            reviewStatus: binding.release.reviewStatus,
            checksum: binding.release.checksum,
            piPackage: summarize(binding.release),
          },
        };
      }),
      updateAvailable: Boolean(
        install.listing.status === "published" &&
          install.listing.latestRelease &&
          install.listing.latestRelease.id !== install.currentReleaseId &&
          install.listing.latestRelease.id !== install.ignoredReleaseId,
      ),
    };
  });
}

export async function countWorkspaceMarketUpdates(workspaceId: string) {
  const installs = await db.marketInstall.findMany({
    where: { targetWorkspaceId: workspaceId },
    select: {
      currentReleaseId: true,
      ignoredReleaseId: true,
      listing: { select: { status: true, latestReleaseId: true } },
    },
  });
  return installs.filter(
    (install) =>
      install.listing.status === "published" &&
      install.listing.latestReleaseId &&
      install.listing.latestReleaseId !== install.currentReleaseId &&
      install.listing.latestReleaseId !== install.ignoredReleaseId,
  ).length;
}

export function listPublishedMarketSkills(q = "") {
  const term = q.trim().slice(0, 200);
  return db.marketListing.findMany({
    where: {
      kind: "skill",
      status: "published",
      visibility: "public",
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: "approved" } },
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { summary: { contains: term, mode: "insensitive" } },
              { namespace: { contains: term, mode: "insensitive" } },
              { slug: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [
      { isFeatured: "desc" },
      { installCount: "desc" },
      { publishedAt: "desc" },
    ],
    include: {
      latestRelease: {
        select: { id: true, version: true, releaseSummary: true },
      },
    },
  });
}

export function listWorkspacePublishedResources(workspaceId: string) {
  return db.marketListing.findMany({
    where: { publisherWorkspaceId: workspaceId, kind: { not: "toolkit" } },
    orderBy: { updatedAt: "desc" },
    include: {
      categories: { select: { id: true } },
      latestRelease: {
        select: {
          id: true,
          version: true,
          publishedAt: true,
          releaseSummary: true,
        },
      },
      pendingRelease: {
        select: {
          id: true,
          version: true,
          reviewStatus: true,
          reviewNote: true,
        },
      },
      releases: {
        where: { listing: { kind: "pi-package" } },
        orderBy: { version: "desc" },
        take: 1,
        select: { version: true, reviewStatus: true, reviewNote: true },
      },
    },
  });
}

type AssistantTemplateRow = {
  namespace: string;
  slug: string;
  name: string;
  summary: string | null;
  tags: string[];
  latestRelease: {
    id: string;
    manifest: Prisma.JsonValue;
    checksum: string;
    releaseNotes: string | null;
  } | null;
};

function assistantTemplate(row: AssistantTemplateRow) {
  if (!row.latestRelease) return null;
  try {
    const manifest = parseAssistantReleaseManifest(
      row.latestRelease.manifest,
      row.latestRelease.checksum,
    );
    if (
      scanMarketArtifact(manifest, row.latestRelease.releaseNotes).status ===
      "blocked"
    )
      return null;
    return {
      releaseId: row.latestRelease.id,
      listing: {
        namespace: row.namespace,
        slug: row.slug,
        name: row.name,
        summary: row.summary,
        tags: row.tags,
      },
      manifest,
    };
  } catch {
    return null;
  }
}

export async function getAssistantMarketTemplate(
  releaseId: string,
  viewer?: MarketViewer,
) {
  const listing = await db.marketListing.findFirst({
    where: {
      kind: "assistant",
      status: "published",
      AND: [await visibleListings(viewer)],
      latestReleaseId: releaseId,
      latestRelease: { is: { reviewStatus: "approved" } },
    },
    select: {
      namespace: true,
      slug: true,
      name: true,
      summary: true,
      tags: true,
      latestRelease: {
        select: {
          id: true,
          manifest: true,
          checksum: true,
          releaseNotes: true,
        },
      },
    },
  });
  return listing ? assistantTemplate(listing) : null;
}

export async function listAssistantMarketTemplates(
  input: { q?: string; limit?: number; viewer?: MarketViewer } = {},
) {
  const term = input.q?.trim().slice(0, 200) ?? "";
  const limit =
    Number.isSafeInteger(input.limit) &&
    input.limit !== undefined &&
    input.limit > 0
      ? Math.min(input.limit, 50)
      : 12;
  const listings = await db.marketListing.findMany({
    where: {
      kind: "assistant",
      status: "published",
      AND: [await visibleListings(input.viewer)],
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: "approved" } },
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { summary: { contains: term, mode: "insensitive" } },
              { tags: { has: term.toLocaleLowerCase() } },
            ],
          }
        : {}),
    },
    take: limit,
    orderBy: [
      { isFeatured: "desc" },
      { installCount: "desc" },
      { publishedAt: "desc" },
    ],
    select: {
      namespace: true,
      slug: true,
      name: true,
      summary: true,
      tags: true,
      latestRelease: {
        select: {
          id: true,
          manifest: true,
          checksum: true,
          releaseNotes: true,
        },
      },
    },
  });
  return listings.flatMap((listing) => {
    const template = assistantTemplate(listing);
    return template ? [template] : [];
  });
}
