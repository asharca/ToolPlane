import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { z } from "zod";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import {
  AgentRevisionError,
  pinCurrentAgentRevision,
  captureInstalledSkillSnapshot,
  publishAgentRevisionInTransaction,
} from "./revisions";
import type { AgentSkillSnapshot } from "./revision-types";

export type AgentResourceReviewScope = {
  workspaceId: string;
  userId: string;
  agentId: string;
  resourceKind: "skill";
  resourceId: string;
};

export type AgentResourceReview = {
  agentId: string;
  resourceKind: "skill";
  resourceId: string;
  expectedRevisionId: string;
  reviewReceipt: string;
  expiresAt: string;
  sourceChecksum: string;
  skill?: AgentSkillSnapshot;
};

const reviewSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  resourceKind: z.literal("skill"),
  resourceId: z.string().min(1),
  expectedRevisionId: z.string().min(1),
  sourceChecksum: z.string().min(1),
});
const reviewAudience = "toolplane:agent-resource-review";
const reviewLifetimeSeconds = 15 * 60;

function reviewKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new AgentRevisionError("reviewRequired");
  return new TextEncoder().encode(secret);
}

async function verifyReview(
  input: AgentResourceReviewScope & {
    expectedRevisionId: string;
    reviewReceipt: string;
  },
) {
  try {
    const verified = await jwtVerify(input.reviewReceipt, reviewKey(), {
      algorithms: ["HS256"],
      audience: reviewAudience,
      issuer: "toolplane",
    });
    const receipt = reviewSchema.parse(verified.payload);
    if (
      receipt.workspaceId !== input.workspaceId ||
      receipt.userId !== input.userId ||
      receipt.agentId !== input.agentId ||
      receipt.resourceKind !== input.resourceKind ||
      receipt.resourceId !== input.resourceId ||
      receipt.expectedRevisionId !== input.expectedRevisionId
    )
      throw new AgentRevisionError("reviewRequired");
    return receipt;
  } catch (error) {
    throw new AgentRevisionError(
      error instanceof joseErrors.JWTExpired
        ? "reviewExpired"
        : "reviewRequired",
    );
  }
}

async function currentTarget(
  tx: Prisma.TransactionClient,
  scope: AgentResourceReviewScope,
) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
  const user = await tx.user.findFirst({
    where: { id: scope.userId, status: "active" },
    select: { role: true },
  });
  const workspace =
    user &&
    (await tx.workspace.findFirst({
      where: {
        id: scope.workspaceId,
        status: "active",
        OR: [
          { ownerId: scope.userId },
          {
            members: {
              some: { userId: scope.userId, role: { in: ["owner", "admin"] } },
            },
          },
          ...(user.role === "admin" ? [{}] : []),
        ],
      },
      select: { id: true },
    }));
  if (!workspace) throw new AgentRevisionError("MCP_CONNECTION_NOT_AUTHORIZED");
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${scope.agentId} AND "workspaceId"=${scope.workspaceId} FOR UPDATE`;
  const target = await tx.agent.findFirst({
    where: {
      id: scope.agentId,
      workspaceId: scope.workspaceId,
      runtimeKind: { in: ["pi-sdk"] },
      retiredAt: null,
      publicRuntimeAllocation: { is: null },
    },
    select: { currentRevisionVersion: true },
  });
  if (!target) throw new AgentRevisionError("resource_binding_unavailable");
  if (!target.currentRevisionVersion)
    throw new AgentRevisionError("revisionPreparationRequired");
  const revision = await tx.agentRevision.findUnique({
    where: {
      agentId_version: {
        agentId: scope.agentId,
        version: target.currentRevisionVersion,
      },
    },
    select: { id: true },
  });
  if (!revision) throw new AgentRevisionError("revisionPreparationRequired");
  return { current: await pinCurrentAgentRevision(tx, scope.agentId) };
}

export async function prepareAgentResourceReview(
  scope: AgentResourceReviewScope,
): Promise<AgentResourceReview> {
  // Reject an unpublished or unauthorized target before probing, capturing, or granting anything.
  const initial = await db.$transaction(async (tx) => {
    const { current } = await currentTarget(tx, scope);
    const skill = await captureInstalledSkillSnapshot(
      tx,
      scope.workspaceId,
      scope.resourceId,
    );
    return { current, skill };
  });
  const source = {
    sourceChecksum: marketReleaseChecksum(initial.skill),
    skill: initial.skill,
  };
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expires = issuedAt + reviewLifetimeSeconds;
  const reviewReceipt = await new SignJWT({
    ...scope,
    expectedRevisionId: initial.current.id,
    sourceChecksum: source.sourceChecksum,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("toolplane")
    .setAudience(reviewAudience)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(reviewKey());
  return {
    agentId: scope.agentId,
    resourceKind: scope.resourceKind,
    resourceId: scope.resourceId,
    expectedRevisionId: initial.current.id,
    reviewReceipt,
    expiresAt: new Date(expires * 1_000).toISOString(),
    ...source,
  };
}

export async function applyAgentResourceReview(
  input: AgentResourceReviewScope & {
    expectedRevisionId: string;
    reviewReceipt: string;
  },
) {
  const receipt = await verifyReview(input);
  return db.$transaction(
    async (tx) => {
      const { current } = await currentTarget(tx, input);
      if (current.id !== input.expectedRevisionId)
        throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
      let config = current.config;
      await tx.$queryRaw`SELECT id FROM "InstalledSkill" WHERE id=${input.resourceId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
      const skill = await captureInstalledSkillSnapshot(
        tx,
        input.workspaceId,
        input.resourceId,
      );
      if (marketReleaseChecksum(skill) !== receipt.sourceChecksum)
        throw new AgentRevisionError("resourceChanged");
      await tx.agentSkill.upsert({
        where: {
          agentId_installedSkillId: {
            agentId: input.agentId,
            installedSkillId: input.resourceId,
          },
        },
        create: {
          agentId: input.agentId,
          installedSkillId: input.resourceId,
        },
        update: {},
      });
      config = {
        ...current.config,
        skills: [
          ...current.config.skills.filter(
            (entry) => entry.installedSkillId !== input.resourceId,
          ),
          skill,
        ],
      };
      const revision = await publishAgentRevisionInTransaction(
        tx,
        input.workspaceId,
        input.agentId,
        {
          expectedRevisionId: current.id,
          config,
        },
      );
      await verifyReview(input);
      const final = await currentTarget(tx, input);
      if (final.current.id !== revision.id)
        throw new AgentRevisionError("AGENT_REVISION_CONFLICT");
      return revision;
    },
    { timeout: 120_000 },
  );
}
