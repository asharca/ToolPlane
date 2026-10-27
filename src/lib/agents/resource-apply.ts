import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { z } from "zod";
import { db } from "@/lib/db";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { inspectAgentMcpConnection } from "@/lib/process/agent-mcp-inspection";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesChecksum,
  prepareSessionMcpDefinition,
} from "@/lib/process/mcp-definition";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import type { McpToolDefinition } from "@/lib/process/mcp-tool-catalog";
import { readMcpInspectorConnection } from "@/lib/workspace/inspector-connection";
import { applyReviewedAgentMcpGrantsInTransaction } from "./mutations";
import {
  AgentRevisionError,
  captureInstalledSkillSnapshot,
  publishAgentRevisionInTransaction,
} from "./revisions";
import type { AgentSkillSnapshot } from "./revision-types";

export type AgentResourceReviewScope = {
  workspaceId: string;
  userId: string;
  agentId: string;
  resourceKind: "skill" | "mcp";
  resourceId: string;
};

export type AgentResourceReview = {
  agentId: string;
  resourceKind: "skill" | "mcp";
  resourceId: string;
  expectedRevisionId: string;
  reviewReceipt: string;
  expiresAt: string;
  sourceChecksum: string;
  skill?: AgentSkillSnapshot;
  tools?: McpToolDefinition[];
  tested?: boolean;
};

const reviewSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  resourceKind: z.enum(["skill", "mcp"]),
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
  const target = await tx.agent.findFirst({
    where: {
      id: scope.agentId,
      workspaceId: scope.workspaceId,
      runtimeKind: "pi-sdk",
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
  return applyReviewedAgentMcpGrantsInTransaction(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    agentId: scope.agentId,
    expectedRevisionId: revision.id,
    connections: [],
  });
}

async function selectedMcpDeployment(
  tx: Prisma.TransactionClient,
  scope: AgentResourceReviewScope,
) {
  const deployment = await tx.deployment.findFirst({
    where: {
      id: scope.resourceId,
      workspaceId: scope.workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    include: {
      marketInstall: { include: { listing: true, currentRelease: true } },
    },
  });
  if (!deployment) throw new AgentRevisionError("resource_binding_unavailable");
  const install = deployment.marketInstall;
  if (
    install &&
    (!["ready", "modified", "setup_required"].includes(install.status) ||
      install.currentRelease.reviewStatus !== "approved" ||
      install.currentRelease.listingId !== install.listingId ||
      install.listing.status !== "published" ||
      (install.listing.visibility !== "public" &&
        install.listing.publisherWorkspaceId !== scope.workspaceId))
  )
    throw new AgentRevisionError("resource_binding_unavailable");
  return deployment;
}

async function reviewedMcpSource(
  tx: Prisma.TransactionClient,
  scope: AgentResourceReviewScope,
  sandboxId: string | null,
) {
  const deployment = await selectedMcpDeployment(tx, scope);
  const receipt = readMcpInspectorConnection(deployment.installCfg);
  const definitionChecksum = mcpDefinitionChecksum(deployment);
  const runtimeFilesChecksum = await mcpRuntimeFilesChecksum(tx, deployment.id);
  if (
    !receipt ||
    receipt.sandboxId !== sandboxId ||
    receipt.definitionChecksum !== definitionChecksum ||
    receipt.runtimeFilesChecksum !== runtimeFilesChecksum
  )
    throw new AgentRevisionError("MCP_DISCOVERY_REQUIRED");
  const tools = readMcpToolCatalog(deployment.installCfg);
  const sourceChecksum = marketReleaseChecksum({ receipt, tools });
  return { deployment, tools, sourceChecksum };
}

export async function prepareAgentResourceReview(
  scope: AgentResourceReviewScope,
): Promise<AgentResourceReview> {
  // Reject an unpublished or unauthorized target before probing, capturing, or granting anything.
  const initial = await db.$transaction(async (tx) => {
    const { current } = await currentTarget(tx, scope);
    if (scope.resourceKind === "mcp") await selectedMcpDeployment(tx, scope);
    const skill =
      scope.resourceKind === "skill"
        ? await captureInstalledSkillSnapshot(
            tx,
            scope.workspaceId,
            scope.resourceId,
          )
        : undefined;
    return { current, skill };
  });
  if (scope.resourceKind === "mcp")
    await inspectAgentMcpConnection({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      agentId: scope.agentId,
      agentRevisionId: initial.current.id,
      deploymentId: scope.resourceId,
    });
  const source = await db.$transaction(async (tx) => {
    const { current } = await applyReviewedAgentMcpGrantsInTransaction(tx, {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      agentId: scope.agentId,
      expectedRevisionId: initial.current.id,
      connections: [],
    });
    if (scope.resourceKind === "mcp") {
      const inspected = await reviewedMcpSource(
        tx,
        scope,
        current.config.sandboxTemplateId,
      );
      return {
        sourceChecksum: inspected.sourceChecksum,
        tools: inspected.tools,
      };
    }
    const skill = await captureInstalledSkillSnapshot(
      tx,
      scope.workspaceId,
      scope.resourceId,
    );
    if (marketReleaseChecksum(skill) !== marketReleaseChecksum(initial.skill))
      throw new AgentRevisionError("resourceChanged");
    return { sourceChecksum: marketReleaseChecksum(skill), skill };
  });
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
    ...(scope.resourceKind === "mcp" ? { tested: true } : {}),
  };
}

export async function applyAgentResourceReview(
  input: AgentResourceReviewScope & {
    expectedRevisionId: string;
    reviewReceipt: string;
    allowedToolNames?: string[];
  },
) {
  const receipt = await verifyReview(input);
  if (input.resourceKind === "mcp" && input.allowedToolNames === undefined)
    throw new AgentRevisionError("MCP_TOOL_SELECTION_CHANGED");
  // Preparation can capture images, so admission must happen first and again in the publishing transaction.
  const admitted = await db.$transaction(async (tx) => {
    const { current } = await applyReviewedAgentMcpGrantsInTransaction(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      expectedRevisionId: input.expectedRevisionId,
      connections: [],
    });
    if (input.resourceKind === "skill") return { current };
    const source = await reviewedMcpSource(
      tx,
      input,
      current.config.sandboxTemplateId,
    );
    if (source.sourceChecksum !== receipt.sourceChecksum)
      throw new AgentRevisionError("resourceChanged");
    return { current, source };
  });
  const prepared = admitted.source
    ? await prepareSessionMcpDefinition(admitted.source.deployment)
    : undefined;
  return db.$transaction(
    async (tx) => {
      const { current, grants } =
        await applyReviewedAgentMcpGrantsInTransaction(tx, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId: input.agentId,
          expectedRevisionId: input.expectedRevisionId,
          connections: prepared
            ? [
                {
                  deploymentId: input.resourceId,
                  allowedToolNames: input.allowedToolNames ?? [],
                  prepared,
                },
              ]
            : [],
        });
      let config = current.config;
      if (input.resourceKind === "mcp") {
        const source = await reviewedMcpSource(
          tx,
          input,
          current.config.sandboxTemplateId,
        );
        if (source.sourceChecksum !== receipt.sourceChecksum)
          throw new AgentRevisionError("resourceChanged");
        config = {
          ...current.config,
          mcpGrants: [
            ...current.config.mcpGrants.filter(
              (grant) => grant.deploymentId !== input.resourceId,
            ),
            ...grants,
          ],
        };
      } else {
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
      }
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
      await applyReviewedAgentMcpGrantsInTransaction(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        agentId: input.agentId,
        expectedRevisionId: revision.id,
        connections: [],
      });
      return revision;
    },
    { timeout: 120_000 },
  );
}
