import 'server-only';

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  ASSISTANT_MARKET_MANIFEST_VERSION,
  assistantReleaseChecksum,
  buildAssistantReleaseManifest,
  parseAssistantReleaseManifest,
  type AssistantReleaseManifestV1,
} from '@/lib/market/assistant-manifest';
import {
  buildSkillReleaseManifest,
  parseSkillReleaseManifest,
  SKILL_MARKET_MANIFEST_VERSION,
  skillReleaseChecksum,
  type SkillReleaseManifestV1,
} from '@/lib/market/skill-manifest';
import {
  scanMarketArtifact,
  scanSkillReleaseManifest,
  type MarketSecretScan,
} from '@/lib/market/secret-scan';
import { killProcess } from '@/lib/process/supervisor';
import { removeDeploymentContainer } from '@/lib/process/deployment-runtime-container';
import { removeDeploymentConfigVolume } from '@/lib/process/deployment-config-volume';
import { runMcpDeploymentOperation } from '@/lib/workspace/mcp-operation';

export type MarketErrorCode =
  | 'not_authorized'
  | 'source_not_found'
  | 'listing_conflict'
  | 'release_not_found'
  | 'listing_unavailable'
  | 'invalid_manifest'
  | 'invalid_categories'
  | 'idempotency_conflict'
  | 'already_installed'
  | 'install_not_found'
  | 'in_use'
  | 'local_changes';

export class MarketError extends Error {
  constructor(readonly code: MarketErrorCode, message: string) {
    super(message);
    this.name = 'MarketError';
  }
}

type PublishSkillInput = {
  workspaceId: string;
  installedSkillId: string;
  publishedById: string;
  categoryIds: string[];
  listing?: {
    slug?: string;
    name?: string;
    summary?: string | null;
    iconUrl?: string | null;
    tags?: string[];
  };
  releaseNotes?: string | null;
};

type PublishAssistantInput = {
  workspaceId: string;
  assistantId: string;
  publishedById: string;
  categoryIds: string[];
  listing?: {
    slug?: string;
    name?: string;
    summary?: string | null;
    iconUrl?: string | null;
    tags?: string[];
  };
  releaseNotes?: string | null;
};

const SKILL_RELEASE_SELECT = {
  id: true,
  workspaceId: true,
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
      iconUrl: true,
    },
  },
} satisfies Prisma.InstalledSkillSelect;

const ASSISTANT_RELEASE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  systemPrompt: true,
  model: true,
  maxSteps: true,
  modelProvider: { select: { format: true } },
  mcpGrants: {
    orderBy: { createdAt: 'asc' },
    select: {
      deployment: {
        select: {
          name: true,
          sourceRef: true,
          server: { select: { slug: true, name: true, verifiedAt: true } },
        },
      },
    },
  },
} satisfies Prisma.ChatAssistantSelect;

function slugify(value: string, fallback = 'skill'): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || fallback;
}

function cleanTags(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim().toLocaleLowerCase().slice(0, 40))
    .filter(Boolean))]
    .slice(0, 20);
}

function isPrismaError(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code),
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

async function validatedCategoryIds(tx: Prisma.TransactionClient, categoryIds: string[]) {
  const uniqueIds = [...new Set(categoryIds)];
  if (
    uniqueIds.length === 0
    || uniqueIds.length !== categoryIds.length
    || await tx.category.count({ where: { id: { in: uniqueIds } } }) !== uniqueIds.length
  ) {
    throw new MarketError('invalid_categories', 'Select one or more valid marketplace categories.');
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
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) throw new MarketError('not_authorized', 'Workspace access was denied.');
}

async function uniqueListingSlug(
  tx: Prisma.TransactionClient,
  namespace: string,
  desired: string,
  existingId?: string,
): Promise<string> {
  const base = slugify(desired);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const slug = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const conflict = await tx.marketListing.findFirst({
      where: { namespace, slug, ...(existingId ? { id: { not: existingId } } : {}) },
      select: { id: true },
    });
    if (!conflict) return slug;
  }
  throw new MarketError('listing_conflict', 'Could not allocate a unique market slug.');
}

function skillReleaseSummary(manifest: SkillReleaseManifestV1) {
  return {
    fileCount: manifest.skill.files.length,
    source: manifest.skill.source.type,
    contentBytes: Buffer.byteLength(manifest.skill.content, 'utf8'),
  };
}

function assistantReleaseSummary(manifest: AssistantReleaseManifestV1) {
  return {
    providerFormat: manifest.assistant.modelRequirement?.providerFormat ?? null,
    model: manifest.assistant.modelRequirement?.model ?? null,
    mcpCount: manifest.assistant.mcpRequirements.length,
    maxSteps: manifest.assistant.maxSteps,
  };
}

export async function publishSkillRelease(input: PublishSkillInput) {
  try {
    return await db.$transaction(async (tx) => {
      const workspace = await assertPublisherAccess(tx, input.workspaceId, input.publishedById);
      const categoryIds = await validatedCategoryIds(tx, input.categoryIds);
      const source = await tx.installedSkill.findFirst({
        where: { id: input.installedSkillId, workspaceId: input.workspaceId },
        select: SKILL_RELEASE_SELECT,
      });
      if (!source) throw new MarketError('source_not_found', 'The source skill was not found.');

      const baseManifest = buildSkillReleaseManifest(source);
      const existing = await tx.marketListing.findUnique({
        where: { sourceInstalledSkillId: source.id },
      });
      if (existing && existing.publisherWorkspaceId !== input.workspaceId) {
        throw new MarketError('listing_conflict', 'This skill is already listed elsewhere.');
      }

      const listingSlug = existing?.latestReleaseId
        ? existing.slug
        : await uniqueListingSlug(
            tx,
            workspace.slug,
            input.listing?.slug || baseManifest.skill.slug,
            existing?.id,
          );
      const name = input.listing?.name?.trim().slice(0, 240) || baseManifest.skill.name;
      const summary = input.listing?.summary?.trim().slice(0, 4_000)
        || baseManifest.skill.description
        || null;
      const iconUrl = input.listing?.iconUrl?.trim().slice(0, 2_000)
        || source.skill?.iconUrl
        || null;
      const tags = cleanTags(input.listing?.tags);
      const author = source.skill?.author || workspace.name;
      const manifest = parseSkillReleaseManifest({
        ...baseManifest,
        listing: { slug: listingSlug, name, summary, iconUrl, tags, author },
      });
      const scanResult = scanSkillReleaseManifest(manifest, input.releaseNotes);
      if (scanResult.status === 'blocked') {
        throw new MarketError('invalid_manifest', 'Remove credentials from the Skill before publishing it.');
      }
      const metadata = {
        author,
        source: manifest.skill.source.type,
      } satisfies Prisma.InputJsonObject;

      const listing = existing
        ? await tx.marketListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              ...(!existing.latestReleaseId ? {
                slug: listingSlug,
                name,
                summary,
                iconUrl,
                tags,
                metadata,
                categories: { set: categoryIds.map((id) => ({ id })) },
              } : {}),
            },
          })
        : await tx.marketListing.create({
            data: {
              kind: 'skill',
              namespace: workspace.slug,
              slug: listingSlug,
              publisherKind: 'workspace',
              publisherWorkspaceId: workspace.id,
              publishedById: input.publishedById,
              sourceInstalledSkillId: source.id,
              categories: { connect: categoryIds.map((id) => ({ id })) },
              name,
              summary,
              iconUrl,
              tags,
              metadata,
            },
          });

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
          manifestVersion: SKILL_MARKET_MANIFEST_VERSION,
          manifest: manifest as Prisma.InputJsonValue,
          releaseSummary: skillReleaseSummary(manifest),
          checksum: skillReleaseChecksum(manifest),
          releaseNotes: input.releaseNotes?.trim().slice(0, 10_000) || null,
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
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof MarketError) throw error;
    if (isPrismaError(error, ['P2002', 'P2034'])) {
      throw new MarketError('listing_conflict', 'The listing changed while it was being published.');
    }
    throw error;
  }
}

export async function publishAssistantRelease(input: PublishAssistantInput) {
  try {
    return await db.$transaction(async (tx) => {
      const workspace = await assertPublisherAccess(tx, input.workspaceId, input.publishedById);
      const categoryIds = await validatedCategoryIds(tx, input.categoryIds);
      const source = await tx.chatAssistant.findFirst({
        where: { id: input.assistantId, workspaceId: input.workspaceId },
        select: ASSISTANT_RELEASE_SELECT,
      });
      if (!source) throw new MarketError('source_not_found', 'The source assistant was not found.');
      if (source.mcpGrants.some(({ deployment }) => !deployment.server?.verifiedAt)) {
        throw new MarketError(
          'invalid_manifest',
          'Assistants may publish only verified catalog MCP requirements.',
        );
      }

      const baseManifest = buildAssistantReleaseManifest(source);
      const existing = await tx.marketListing.findUnique({
        where: { sourceChatAssistantId: source.id },
      });
      if (existing && existing.publisherWorkspaceId !== input.workspaceId) {
        throw new MarketError('listing_conflict', 'This assistant is already listed elsewhere.');
      }

      const listingSlug = existing?.latestReleaseId
        ? existing.slug
        : await uniqueListingSlug(tx, workspace.slug, input.listing?.slug || source.name, existing?.id);
      const name = input.listing?.name?.trim().slice(0, 240) || source.name;
      const summary = input.listing?.summary?.trim().slice(0, 4_000) || null;
      const iconUrl = input.listing?.iconUrl?.trim().slice(0, 2_000) || null;
      const tags = cleanTags(input.listing?.tags);
      const author = workspace.name;
      const manifest = parseAssistantReleaseManifest({
        ...baseManifest,
        listing: { slug: listingSlug, name, summary, iconUrl, tags, author },
      });
      const scanResult = scanMarketArtifact(manifest, input.releaseNotes);
      if (scanResult.status === 'blocked') {
        throw new MarketError('invalid_manifest', 'Remove credentials from the assistant before publishing it.');
      }
      const metadata = {
        author,
        type: 'chat',
        ...assistantReleaseSummary(manifest),
      } satisfies Prisma.InputJsonObject;

      const listing = existing
        ? await tx.marketListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              ...(!existing.latestReleaseId ? {
                slug: listingSlug,
                name,
                summary,
                iconUrl,
                tags,
                metadata,
                categories: { set: categoryIds.map((id) => ({ id })) },
              } : {}),
            },
          })
        : await tx.marketListing.create({
            data: {
              kind: 'assistant',
              namespace: workspace.slug,
              slug: listingSlug,
              publisherKind: 'workspace',
              publisherWorkspaceId: workspace.id,
              publishedById: input.publishedById,
              sourceChatAssistantId: source.id,
              categories: { connect: categoryIds.map((id) => ({ id })) },
              name,
              summary,
              iconUrl,
              tags,
              metadata,
            },
          });

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
          manifestVersion: ASSISTANT_MARKET_MANIFEST_VERSION,
          manifest: manifest as Prisma.InputJsonValue,
          releaseSummary: assistantReleaseSummary(manifest),
          checksum: assistantReleaseChecksum(manifest),
          releaseNotes: input.releaseNotes?.trim().slice(0, 10_000) || null,
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
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof MarketError) throw error;
    if (isPrismaError(error, ['P2002', 'P2034'])) {
      throw new MarketError('listing_conflict', 'The listing changed while it was being published.');
    }
    throw error;
  }
}

export async function approveMarketRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
  categoryIds?: string[];
}) {
  return db.$transaction(async (tx) => {
    const admin = await tx.user.findFirst({
      where: { id: input.reviewedById, role: 'admin', status: 'active' },
      select: { id: true },
    });
    if (!admin) throw new MarketError('not_authorized', 'Administrator access is required.');
    const release = await tx.marketRelease.findFirst({
      where: { id: input.releaseId, listingId: input.listingId, reviewStatus: 'pending' },
      include: { listing: { select: { id: true, kind: true, pendingReleaseId: true, publishedAt: true } } },
    });
    if (!release || release.listing.pendingReleaseId !== release.id) {
      throw new MarketError('release_not_found', 'The pending release was not found.');
    }
    const categoryIds = await validatedCategoryIds(tx, input.categoryIds ?? release.categoryIds);
    let candidate: {
      slug: string;
      name: string;
      summary: string | null;
      iconUrl: string | null;
      tags: string[];
      author: string;
    } | undefined;
    let metadata: Prisma.InputJsonObject;
    let scanResult: MarketSecretScan;
    if (release.listing.kind === 'skill') {
      const manifest = parseSkillReleaseManifest(release.manifest, release.checksum);
      candidate = manifest.listing;
      metadata = {
        author: candidate?.author ?? '',
        source: manifest.skill.source.type,
      };
      scanResult = scanSkillReleaseManifest(manifest, release.releaseNotes);
    } else if (release.listing.kind === 'assistant') {
      const manifest = parseAssistantReleaseManifest(release.manifest, release.checksum);
      candidate = manifest.listing;
      metadata = {
        author: candidate?.author ?? '',
        type: 'chat',
        ...assistantReleaseSummary(manifest),
      };
      scanResult = scanMarketArtifact(manifest, release.releaseNotes);
    } else {
      throw new MarketError('invalid_manifest', 'This release kind is not supported yet.');
    }
    if (scanResult.status === 'blocked') {
      throw new MarketError('invalid_manifest', 'The release contains possible credentials.');
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
        ...(candidate ? {
          slug: candidate.slug,
          name: candidate.name,
          summary: candidate.summary,
          iconUrl: candidate.iconUrl,
          tags: candidate.tags,
          metadata,
        } : {}),
        status: 'published',
        latestReleaseId: release.id,
        pendingReleaseId: null,
        publishedAt: release.listing.publishedAt ?? publishedAt,
        categories: { set: categoryIds.map((id) => ({ id })) },
      },
    });
  }, { isolationLevel: 'Serializable' });
}

export async function rejectMarketRelease(input: {
  listingId: string;
  releaseId: string;
  reviewedById: string;
  reviewNote?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const admin = await tx.user.findFirst({
      where: { id: input.reviewedById, role: 'admin', status: 'active' },
      select: { id: true },
    });
    if (!admin) throw new MarketError('not_authorized', 'Administrator access is required.');
    const release = await tx.marketRelease.findFirst({
      where: { id: input.releaseId, listingId: input.listingId, reviewStatus: 'pending' },
      include: { listing: { select: { id: true, pendingReleaseId: true, latestReleaseId: true } } },
    });
    if (!release || release.listing.pendingReleaseId !== release.id) {
      throw new MarketError('release_not_found', 'The pending release was not found.');
    }
    await tx.marketRelease.update({
      where: { id: release.id },
      data: {
        reviewStatus: 'rejected',
        reviewedById: admin.id,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote?.trim().slice(0, 4_000) || null,
      },
    });
    return tx.marketListing.update({
      where: { id: release.listing.id },
      data: {
        pendingReleaseId: null,
        status: release.listing.latestReleaseId ? 'published' : 'draft',
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
    if (reused.requestedReleaseId !== input.releaseId || !reused.installedSkill) {
      throw new MarketError('idempotency_conflict', 'This idempotency key has already been used.');
    }
    return { install: reused, installedSkill: reused.installedSkill, reused: true };
  }

  const release = await tx.marketRelease.findUnique({
    where: { id: input.releaseId },
    include: {
      listing: { select: { id: true, kind: true, namespace: true, slug: true, status: true, latestReleaseId: true } },
    },
  });
  if (!release) throw new MarketError('release_not_found', 'The market release was not found.');
  if (
    release.listing.kind !== 'skill'
    || release.listing.status !== 'published'
    || release.reviewStatus !== 'approved'
    || release.listing.latestReleaseId !== release.id
  ) {
    throw new MarketError('listing_unavailable', 'This skill release is not available for installation.');
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
  if (existing) throw new MarketError('already_installed', 'This market skill is already installed.');

  const manifest = parseSkillReleaseManifest(release.manifest, release.checksum);
  const installedSkill = await tx.installedSkill.create({
    data: {
      workspaceId: input.targetWorkspaceId,
      skillId: null,
      name: manifest.skill.name,
      slug: manifest.skill.slug,
      description: manifest.skill.description,
      content: manifest.skill.content,
      files: manifest.skill.files as Prisma.InputJsonValue,
      source: 'market',
      sourceRef: `${release.listing.namespace}/${release.listing.slug}@${release.version}`,
      status: 'published',
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
      status: 'ready',
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
    throw new MarketError('idempotency_conflict', 'A valid idempotency key is required.');
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => installSkillReleaseTransaction(tx, { ...input, idempotencyKey }),
        { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof MarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ['P2002', 'P2034'])) throw error;
    }
  }
  throw new MarketError(
    'listing_conflict',
    lastError instanceof Error ? lastError.message : 'The market install changed. Try again.',
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
      return await db.$transaction(async (tx) => {
        await assertInstallerAccess(tx, input.targetWorkspaceId, input.actorId);
        const install = await tx.marketInstall.findFirst({
          where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
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
        if (!install?.installedSkill || install.listing.kind !== 'skill') {
          throw new MarketError('install_not_found', 'The installed market skill was not found.');
        }
        if (input.currentReleaseId && install.currentReleaseId !== input.currentReleaseId) {
          if (install.currentReleaseId === input.targetReleaseId) return install;
          throw new MarketError('listing_conflict', 'The installed version changed. Refresh and try again.');
        }
        if (install.status === 'modified' && !input.force) {
          throw new MarketError('local_changes', 'The installed skill has local content changes.');
        }
        const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
        if (!releaseId || install.listing.status !== 'published') {
          throw new MarketError('listing_unavailable', 'No published update is available.');
        }
        if (input.targetReleaseId && input.targetReleaseId !== install.listing.latestReleaseId) {
          throw new MarketError('listing_conflict', 'A newer release is available. Refresh before updating.');
        }
        const release = await tx.marketRelease.findFirst({
          where: { id: releaseId, listingId: install.listing.id, reviewStatus: 'approved' },
        });
        if (!release) throw new MarketError('release_not_found', 'The requested update was not found.');
        const manifest = parseSkillReleaseManifest(release.manifest, release.checksum);
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
            status: 'ready',
            lastCheckedAt: new Date(),
            lastError: null,
          },
        });
      }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof MarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ['P2034'])) throw error;
    }
  }
  throw new MarketError(
    'listing_conflict',
    lastError instanceof Error ? lastError.message : 'The market update changed. Try again.',
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
      where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
      include: { listing: { select: { status: true, latestReleaseId: true } } },
    });
    if (!install) throw new MarketError('install_not_found', 'The market installation was not found.');
    if (input.currentReleaseId && install.currentReleaseId !== input.currentReleaseId) {
      if (install.ignoredReleaseId === input.targetReleaseId) return install;
      throw new MarketError('listing_conflict', 'The installed version changed. Refresh and try again.');
    }
    const releaseId = input.targetReleaseId || install.listing.latestReleaseId;
    if (
      !releaseId
      || install.listing.status !== 'published'
      || releaseId !== install.listing.latestReleaseId
    ) {
      throw new MarketError('listing_conflict', 'The available release changed. Refresh and try again.');
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
  const install = await tx.marketInstall.findFirst({
    where: { id: input.installId, targetWorkspaceId: input.targetWorkspaceId },
    include: {
      listing: { select: { kind: true } },
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
          _count: { select: { agentLinks: true, apiTokens: true, installLinks: true } },
        },
      },
    },
  });
  if (!install) throw new MarketError('install_not_found', 'The market installation was not found.');
  if (
    install.installedSkill
    && (install.installedSkill._count.agentLinks > 0 || install.installedSkill._count.toolkitLinks > 0)
  ) {
    throw new MarketError('in_use', 'Remove this skill from agents and toolkits before uninstalling it.');
  }
  if (
    install.deployment
    && (
      install.deployment.sandbox
      || install.deployment._count.agentLinks > 0
      || install.deployment._count.toolkitLinks > 0
      || install.deployment._count.chatAssistantGrants > 0
    )
  ) {
    throw new MarketError('in_use', 'Remove this MCP from assistants, agents, and toolkits before uninstalling it.');
  }
  if (
    install.toolkit
    && (
      install.toolkit._count.agentLinks > 0
      || install.toolkit._count.apiTokens > 0
      || install.toolkit._count.installLinks > 0
    )
  ) {
    throw new MarketError('in_use', 'Remove this toolkit from agents and revoke its access links before uninstalling it.');
  }
  const resource = install.listing.kind === 'skill'
    ? install.installedSkill
    : install.listing.kind === 'mcp'
      ? install.deployment
      : install.listing.kind === 'toolkit'
        ? install.toolkit
        : null;
  if (!resource) throw new MarketError('install_not_found', 'The installed market resource was not found.');
  return install;
}

function marketResourceIds(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>)[key];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

async function removeMarketInstallDatabase(input: RemoveMarketInstallInput) {
  return db.$transaction(async (tx) => {
    const install = await removableMarketInstall(tx, input);
    const ownedSkillIds = marketResourceIds(install.resourceMap, 'ownedInstalledSkillIds');
    const toolkitSkillIds = ownedSkillIds.length
      ? ownedSkillIds
      : marketResourceIds(install.resourceMap, 'installedSkillIds');
    await tx.marketInstall.delete({ where: { id: install.id } });
    if (install.listing.kind === 'skill' && install.installedSkill) {
      await tx.installedSkill.delete({ where: { id: install.installedSkill.id } });
    } else if (install.listing.kind === 'mcp' && install.deployment) {
      await tx.deployment.delete({ where: { id: install.deployment.id } });
    } else if (install.listing.kind === 'toolkit' && install.toolkit) {
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
  });
}

export async function removeMarketInstall(input: RemoveMarketInstallInput) {
  const install = await db.$transaction((tx) => removableMarketInstall(tx, input));
  if (install.listing.kind !== 'mcp' || !install.deployment) {
    return removeMarketInstallDatabase(input);
  }
  const operation = await runMcpDeploymentOperation(
    input.targetWorkspaceId,
    install.deployment.id,
    async () => {
      const current = await db.$transaction((tx) => removableMarketInstall(tx, input));
      if (!current.deployment) throw new MarketError('install_not_found', 'The installed market MCP was not found.');
      await killProcess(current.deployment.id, { preventRestart: true });
      if (current.deployment.source) {
        await removeDeploymentContainer(current.deployment.id);
        await removeDeploymentConfigVolume(current.deployment.id);
      }
      return removeMarketInstallDatabase(input);
    },
  );
  if (!operation.accepted) throw new MarketError('listing_conflict', 'The workspace is being deleted.');
  return operation.value;
}

export async function listWorkspaceMarketInstalls(workspaceId: string) {
  const installs = await db.marketInstall.findMany({
    where: { targetWorkspaceId: workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      currentRelease: { select: { id: true, version: true } },
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
          latestRelease: { select: { id: true, version: true, releaseNotes: true } },
        },
      },
      deployment: { select: { id: true, status: true } },
      installedSkill: { select: { id: true, status: true } },
      toolkit: { select: { id: true, enabled: true } },
      agent: { select: { id: true, runtimeKind: true } },
    },
  });
  return installs.map((install) => ({
    ...install,
    updateAvailable: Boolean(
      install.listing.status === 'published'
      &&
      install.listing.latestRelease
      && install.listing.latestRelease.id !== install.currentReleaseId
      && install.listing.latestRelease.id !== install.ignoredReleaseId,
    ),
  }));
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
  return installs.filter((install) => (
    install.listing.status === 'published'
    && install.listing.latestReleaseId
    && install.listing.latestReleaseId !== install.currentReleaseId
    && install.listing.latestReleaseId !== install.ignoredReleaseId
  )).length;
}

export function listPublishedMarketSkills(q = '') {
  const term = q.trim().slice(0, 200);
  return db.marketListing.findMany({
    where: {
      kind: 'skill',
      status: 'published',
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: 'approved' } },
      ...(term ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { summary: { contains: term, mode: 'insensitive' } },
          { namespace: { contains: term, mode: 'insensitive' } },
          { slug: { contains: term, mode: 'insensitive' } },
        ],
      } : {}),
    },
    orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
    include: { latestRelease: { select: { id: true, version: true, releaseSummary: true } } },
  });
}

export function listWorkspacePublishedResources(workspaceId: string) {
  return db.marketListing.findMany({
    where: { publisherWorkspaceId: workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      categories: { select: { id: true } },
      latestRelease: { select: { id: true, version: true, publishedAt: true } },
      pendingRelease: { select: { id: true, version: true, reviewStatus: true, reviewNote: true } },
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
    const manifest = parseAssistantReleaseManifest(row.latestRelease.manifest, row.latestRelease.checksum);
    if (scanMarketArtifact(manifest, row.latestRelease.releaseNotes).status === 'blocked') return null;
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

export async function getAssistantMarketTemplate(releaseId: string) {
  const listing = await db.marketListing.findFirst({
    where: {
      kind: 'assistant',
      status: 'published',
      latestReleaseId: releaseId,
      latestRelease: { is: { reviewStatus: 'approved' } },
    },
    select: {
      namespace: true,
      slug: true,
      name: true,
      summary: true,
      tags: true,
      latestRelease: {
        select: { id: true, manifest: true, checksum: true, releaseNotes: true },
      },
    },
  });
  return listing ? assistantTemplate(listing) : null;
}

export async function listAssistantMarketTemplates(input: { q?: string; limit?: number } = {}) {
  const term = input.q?.trim().slice(0, 200) ?? '';
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0
    ? Math.min(input.limit!, 50)
    : 12;
  const listings = await db.marketListing.findMany({
    where: {
      kind: 'assistant',
      status: 'published',
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: 'approved' } },
      ...(term ? {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { summary: { contains: term, mode: 'insensitive' } },
          { tags: { has: term.toLocaleLowerCase() } },
        ],
      } : {}),
    },
    take: limit,
    orderBy: [{ isFeatured: 'desc' }, { installCount: 'desc' }, { publishedAt: 'desc' }],
    select: {
      namespace: true,
      slug: true,
      name: true,
      summary: true,
      tags: true,
      latestRelease: {
        select: { id: true, manifest: true, checksum: true, releaseNotes: true },
      },
    },
  });
  return listings.flatMap((listing) => {
    const template = assistantTemplate(listing);
    return template ? [template] : [];
  });
}
