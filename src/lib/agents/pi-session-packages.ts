import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import { resolveAgentPiPackages } from "./resolve";
import type { LoadedAgentPiPackages } from "./resolve";
import {
  resolvePiPackageMcpPolicy,
  assertPiSessionMcpAccess,
} from "./pi-package-mcp";
import { requireAgentRevision } from "./revisions";

export async function resolvePiSessionPackages(input: {
  workspaceId: string;
  agentId: string;
  sandboxId?: string;
  conversationId?: string;
  contextId?: string;
  runtimeSessionId?: string;
}) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
      if (!input.conversationId && !input.contextId)
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      const conversation = input.conversationId
        ? await tx.conversation.findFirst({
            where: {
              id: input.conversationId,
              agentId: input.agentId,
              agent: { workspaceId: input.workspaceId },
            },
          })
        : null;
      const context = input.contextId
        ? await tx.a2AContext.findFirst({
            where: {
              id: input.contextId,
              agentId: input.agentId,
              workspaceId: input.workspaceId,
              targetKind: "local",
            },
          })
        : null;
      if (
        (input.conversationId && !conversation) ||
        (input.contextId && !context)
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      if (
        conversation?.legacyRevisionUnresolved ||
        context?.legacyRevisionUnresolved
      )
        throw new Error("AGENT_REVISION_UNRESOLVED");
      const revisionId =
        conversation?.agentRevisionId ?? context?.agentRevisionId;
      if (
        !revisionId ||
        (conversation &&
          context &&
          conversation.agentRevisionId !== context.agentRevisionId)
      )
        throw new Error("AGENT_REVISION_UNRESOLVED");
      if (
        input.runtimeSessionId &&
        input.runtimeSessionId !== conversation?.id &&
        input.runtimeSessionId !== context?.id
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      const sandboxId =
        input.sandboxId ??
        conversation?.sandboxId ??
        context?.sandboxId ??
        undefined;
      if (
        sandboxId &&
        ((conversation && conversation.sandboxId !== sandboxId) ||
          (context && context.sandboxId !== sandboxId))
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      if (
        sandboxId &&
        !(await tx.sandbox.findFirst({
          where: { id: sandboxId, workspaceId: input.workspaceId },
          select: { id: true },
        }))
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      const revision = await requireAgentRevision(
        tx,
        input.agentId,
        revisionId,
      );
      const agent = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          runtimeKind: "pi-sdk",
          workspace: { status: "active" },
        },
        select: {
          servers: {
            select: { deploymentId: true, allowedToolNames: true },
          },
        },
      });
      if (!agent) throw new Error("PI_PACKAGE_UNAVAILABLE");
      const pinnedPackages: NonNullable<LoadedAgentPiPackages["piPackages"]> =
        [];
      for (const pin of revision.config.packages) {
        const marketInstall = await tx.marketInstall.findFirst({
          where: {
            id: pin.marketInstallId,
            targetWorkspaceId: input.workspaceId,
          },
          include: { listing: true },
        });
        const release = await tx.marketRelease.findUnique({
          where: { id: pin.releaseId },
        });
        if (
          !marketInstall ||
          (marketInstall.status !== "ready" &&
            marketInstall.status !== "uninstalled") ||
          !release ||
          release.checksum !== pin.integrity ||
          release.listingId !== marketInstall.listingId
        )
          throw new Error("PI_PACKAGE_UNAVAILABLE");
        pinnedPackages.push({
          marketInstallId: pin.marketInstallId,
          marketInstall,
          releaseId: pin.releaseId,
          release,
        });
      }
      const snapshots = await tx.piSessionPackageSet.findMany({
        where: {
          OR: [
            ...(sandboxId ? [{ sandboxId }] : []),
            ...(conversation ? [{ conversationId: conversation.id }] : []),
            ...(context ? [{ contextId: context.id }] : []),
          ],
        },
        orderBy: { id: "asc" },
        include: {
          packages: {
            include: {
              marketInstall: { include: { listing: true } },
              release: true,
            },
          },
        },
      });
      if (snapshots.length > 1) throw new Error("PI_PACKAGE_UNAVAILABLE");
      let snapshot = snapshots[0];
      if (
        snapshot &&
        ((snapshot.sandboxId && snapshot.sandboxId !== sandboxId) ||
          (snapshot.conversationId &&
            snapshot.conversationId !== conversation?.id) ||
          (snapshot.contextId &&
            snapshot.contextId !== context?.id &&
            !conversation))
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      if (snapshot?.legacy) throw new Error("AGENT_REVISION_UNRESOLVED");
      if (
        snapshot &&
        (snapshot.packages.length !== revision.config.packages.length ||
          snapshot.packages.some(
            (pkg) =>
              !revision.config.packages.some(
                (pin) =>
                  pin.marketInstallId === pkg.marketInstallId &&
                  pin.releaseId === pkg.releaseId &&
                  pin.integrity === pkg.checksum,
              ),
          ))
      )
        throw new Error("PI_PACKAGE_UNAVAILABLE");
      if (!snapshot) {
        const packages = resolveAgentPiPackages({
          runtimeKind: "pi-sdk",
          agentRevisionId: revision.id,
          workspaceId: input.workspaceId,
          piPackages: pinnedPackages,
        });
        snapshot = await tx.piSessionPackageSet.create({
          data: {
            sandboxId,
            conversationId: conversation?.id,
            contextId: conversation ? undefined : context?.id,
            packages: {
              create: packages.map((pkg) => ({
                marketInstallId: pkg.marketInstallId,
                releaseId: pkg.releaseId,
                checksum: pkg.checksum,
                resourceMap: (pinnedPackages.find(
                  (binding) => binding.marketInstallId === pkg.marketInstallId,
                )?.marketInstall.resourceMap ?? {}) as Prisma.InputJsonValue,
              })),
            },
          },
          include: {
            packages: {
              include: {
                marketInstall: { include: { listing: true } },
                release: true,
              },
            },
          },
        });
      }
      if (sandboxId && !snapshot.sandboxId)
        await tx.piSessionPackageSet.update({
          where: { id: snapshot.id },
          data: { sandboxId },
        });
      const packages = resolveAgentPiPackages({
        runtimeKind: "pi-sdk",
        agentRevisionId: revision.id,
        workspaceId: input.workspaceId,
        piPackages: snapshot.packages.map((pkg) => {
          if (pkg.checksum !== pkg.release.checksum)
            throw new Error("PI_PACKAGE_UNAVAILABLE");
          const requirements = parsePiPackageReleaseManifest(
            pkg.release.manifest,
            pkg.checksum,
          ).package.toolplane?.mcp;
          assertPiSessionMcpAccess(
            requirements,
            pkg.resourceMap,
            pkg.marketInstall.resourceMap,
          );
          return {
            ...pkg,
            marketInstall: {
              ...pkg.marketInstall,
              resourceMap: pkg.resourceMap,
            },
          };
        }),
      });
      const liveDeploymentIds = new Set(
        agent.servers.map((server) => server.deploymentId),
      );
      const deploymentIds = new Set(
        revision.config.mcpGrants
          .filter((grant) => liveDeploymentIds.has(grant.deploymentId))
          .map((grant) => grant.deploymentId),
      );
      const packageDeploymentIds = new Set<string>();
      for (const pkg of snapshot.packages) {
        const manifest = parsePiPackageReleaseManifest(
          pkg.release.manifest,
          pkg.checksum,
        );
        const policy = resolvePiPackageMcpPolicy(
          manifest.package.toolplane?.mcp,
          pkg.resourceMap,
        );
        for (const [id, tools] of Object.entries(policy)) {
          const pinned = revision.config.mcpGrants.find(
            (grant) => grant.deploymentId === id,
          );
          const live = agent.servers.find(
            (server) => server.deploymentId === id,
          );
          if (
            !pinned ||
            !live ||
            tools.some(
              (tool) =>
                !pinned.allowedToolNames.includes(tool) ||
                !live.allowedToolNames.includes(tool),
            )
          )
            throw new Error("AGENT_GRANT_REVOKED");
          packageDeploymentIds.add(id);
        }
      }
      return {
        packages,
        deploymentIds: [...deploymentIds],
        packageDeploymentIds: [...packageDeploymentIds],
      };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
