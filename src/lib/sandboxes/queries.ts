import "server-only";
import { db } from "@/lib/db";

// Never select credential envelopes for pages.
const SSH_SERVER_PUBLIC_FIELDS = {
  host: true,
  port: true,
  username: true,
  root: true,
  authType: true,
} as const;

export async function listSandboxes(workspaceId: string) {
  return db.sandbox.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      deployment: true,
      agentLinks: { select: { agent: { select: { id: true, name: true } } } },
      sshServer: { select: SSH_SERVER_PUBLIC_FIELDS },
      externalAgentLinks: {
        select: { access: true, agent: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
      _count: {
        select: { agentLinks: true, externalAgentLinks: true, snapshots: true },
      },
    },
  });
}

export async function getSandbox(workspaceId: string, sandboxId: string) {
  return db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId },
    include: {
      deployment: true,
      agentLinks: { include: { agent: { select: { id: true, name: true } } } },
      sshServer: { select: SSH_SERVER_PUBLIC_FIELDS },
      externalAgentLinks: {
        select: { access: true, agent: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
      snapshots: { orderBy: { createdAt: "desc" } },
    },
  });
}
