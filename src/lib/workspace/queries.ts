import "server-only";
import {
  resolveWorkspaceScope,
  workspaceAccessWhere,
} from "@/lib/workspace/scope";
import { db } from "@/lib/db";
import { storedRequiredEnvironment } from "@/lib/workspace/server-recipe";
import { mcpEnvironmentState } from "@/lib/workspace/mcp-environment";
import {
  hasMcpToolCatalog,
  readMcpToolCatalog,
} from "@/lib/process/mcp-tool-catalog";
import { deploymentPinnedPackage } from "@/lib/workspace/deployment-label";

export async function getDefaultWorkspace(userId: string, lastSlug?: string) {
  if (lastSlug) {
    const last = await resolveWorkspaceScope({ slug: lastSlug }, userId);
    if (last) return last;
  }
  return db.workspace.findFirst({
    where: workspaceAccessWhere(userId),
    orderBy: { createdAt: "asc" },
  });
}

export async function listWorkspacesForUser(userId: string) {
  const workspaces = await db.workspace.findMany({
    where: workspaceAccessWhere(userId, "read", true),
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      ownerId: true,
      status: true,
      members: { where: { userId }, select: { role: true } },
      _count: { select: { members: true } },
    },
  });
  return workspaces.map(({ ownerId, members, _count, ...workspace }) => ({
    ...workspace,
    role:
      ownerId === userId
        ? ("owner" as const)
        : members[0]?.role === "admin"
          ? ("admin" as const)
          : ("member" as const),
    memberCount: _count.members,
  }));
}

export async function getDeployments(workspaceId: string) {
  const deployments = await db.deployment.findMany({
    where: {
      workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      server: { select: { slug: true, name: true, iconUrl: true } },
    },
  });
  return deployments.map((deployment) => ({
    ...deployment,
    // The package selector is a public registry identity, never launch arguments.
    pinnedPackage: deploymentPinnedPackage(deployment),
    // Lists expose readiness and catalog metadata, never stored credentials or
    // arbitrary launch configuration (including inline argument secrets).
    installCfg: {
      env: mcpEnvironmentState(deployment.installCfg),
      requiredEnv: storedRequiredEnvironment(deployment.installCfg),
      ...(hasMcpToolCatalog(deployment.installCfg)
        ? { toolCatalog: readMcpToolCatalog(deployment.installCfg) }
        : {}),
    },
  }));
}

export async function getWorkspaceMembers(workspaceId: string) {
  return db.membership.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { email: true, name: true } } },
  });
}

export async function getInstalledSkills(workspaceId: string) {
  return db.installedSkill.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      skill: {
        select: {
          slug: true,
          name: true,
          iconUrl: true,
          description: true,
          content: true,
          files: true,
        },
      },
    },
  });
}
