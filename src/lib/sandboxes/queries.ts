import "server-only";
import { db } from "@/lib/db";
import { isSessionSandbox } from "./external";

type SandboxOwner = { id: string; name: string };
type SandboxRole = "runtime" | "template" | "history" | "external";

async function withSandboxMetadata<
  T extends { config: unknown; agentLinks: { agent: SandboxOwner }[] },
>(workspaceId: string, sandboxes: T[]) {
  const metadata = sandboxes.map((sandbox) => {
    const config =
      sandbox.config &&
      typeof sandbox.config === "object" &&
      !Array.isArray(sandbox.config)
        ? (sandbox.config as Record<string, unknown>)
        : null;
    const managed = isSessionSandbox(sandbox.config);
    const role: SandboxRole = managed
      ? config?.managedBy === "agent-conversation" &&
        config.scope === "agent" &&
        config.readOnly !== true &&
        config.migrationArchive !== true
        ? "runtime"
        : "history"
      : sandbox.agentLinks.length
        ? "template"
        : "external";
    return {
      role,
      managed,
      agentId:
        managed && typeof config?.agentId === "string" ? config.agentId : null,
    };
  });
  const agentIds = [
    ...new Set(metadata.flatMap(({ agentId }) => (agentId ? [agentId] : []))),
  ];
  const owners = agentIds.length
    ? await db.agent.findMany({
        where: { workspaceId, id: { in: agentIds } },
        select: { id: true, name: true },
      })
    : [];
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]));
  return sandboxes.map((sandbox, index) => {
    const { role, managed, agentId } = metadata[index];
    return {
      ...sandbox,
      ownerAgent: managed
        ? (agentId && ownersById.get(agentId)) || null
        : (sandbox.agentLinks[0]?.agent ?? null),
      role,
    };
  });
}

// Never select credential envelopes for pages.
const SSH_SERVER_PUBLIC_FIELDS = {
  host: true,
  port: true,
  username: true,
  root: true,
  authType: true,
} as const;

export async function listSandboxes(workspaceId: string) {
  const sandboxes = await db.sandbox.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      deployment: true,
      agentLinks: {
        where: { agent: { workspaceId } },
        select: { agent: { select: { id: true, name: true } } },
      },
      sshServer: { select: SSH_SERVER_PUBLIC_FIELDS },
      externalAgentLinks: {
        where: { agent: { workspaceId } },
        select: { access: true, agent: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
      _count: {
        select: {
          agentLinks: { where: { agent: { workspaceId } } },
          externalAgentLinks: { where: { agent: { workspaceId } } },
          snapshots: true,
          conversations: { where: { agent: { workspaceId } } },
          a2aContexts: { where: { workspaceId } },
        },
      },
    },
  });
  return withSandboxMetadata(workspaceId, sandboxes);
}

export async function getSandbox(workspaceId: string, sandboxId: string) {
  const sandbox = await db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId },
    include: {
      deployment: true,
      agentLinks: {
        where: { agent: { workspaceId } },
        include: { agent: { select: { id: true, name: true } } },
      },
      sshServer: { select: SSH_SERVER_PUBLIC_FIELDS },
      externalAgentLinks: {
        where: { agent: { workspaceId } },
        select: { access: true, agent: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
      snapshots: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!sandbox) return null;
  return (await withSandboxMetadata(workspaceId, [sandbox]))[0];
}
