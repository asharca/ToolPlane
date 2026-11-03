import "server-only";
import { db } from "@/lib/db";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import type { NamedEntity, Party } from "./types";

export type NameReference = {
  workspaceId: string | null;
  deploymentId?: string | null;
  agentId?: string | null;
  actorId?: string | null;
  tokenId?: string | null;
  endpointId?: string | null;
  clientId?: string | null;
  remoteAgentId?: string | null;
};
type EntityKind =
  | "workspace"
  | "deployment"
  | "server"
  | Exclude<Party["kind"], "unknown">;
export type ResolvedNames = {
  entity(
    kind: EntityKind,
    id: string | null | undefined,
    workspaceId: string | null,
  ): NamedEntity | null;
  party(
    kind: Party["kind"],
    id: string | null | undefined,
    workspaceId: string | null,
  ): Party;
  server(
    deploymentId: string | null,
    workspaceId: string | null,
  ): NamedEntity | null;
};
const key = (workspaceId: string | null, kind: string, id: string) =>
  JSON.stringify([workspaceId, kind, id]);

/** Resolve only entities belonging to each reference's workspace, in bounded batches. */
export async function resolveNames(
  refs: readonly NameReference[],
): Promise<ResolvedNames> {
  const workspaceIds = [
    ...new Set(
      refs.flatMap((ref) => (ref.workspaceId ? [ref.workspaceId] : [])),
    ),
  ];
  const ids = (field: keyof NameReference) => [
    ...new Set(
      refs.flatMap((ref) => {
        const id = ref[field];
        return id ? [id] : [];
      }),
    ),
  ];
  const deploymentIds = ids("deploymentId");
  const agentIds = ids("agentId");
  const actorIds = ids("actorId");
  const tokenIds = ids("tokenId");
  const endpointIds = ids("endpointId");
  const clientIds = ids("clientId");
  const remoteIds = ids("remoteAgentId");
  const userScope = {
    OR: [
      { ownedWorkspaces: { some: { id: { in: workspaceIds } } } },
      { memberships: { some: { workspaceId: { in: workspaceIds } } } },
    ],
  };
  const [
    workspaces,
    deployments,
    agents,
    users,
    tokens,
    endpoints,
    clients,
    remotes,
  ] = await Promise.all([
    workspaceIds.length
      ? db.workspace.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, name: true },
        })
      : [],
    deploymentIds.length && workspaceIds.length
      ? db.deployment.findMany({
          where: {
            id: { in: deploymentIds },
            workspaceId: { in: workspaceIds },
          },
          select: {
            id: true,
            workspaceId: true,
            name: true,
            source: true,
            sourceRef: true,
            serverId: true,
            server: { select: { id: true, name: true } },
          },
        })
      : [],
    agentIds.length && workspaceIds.length
      ? db.agent.findMany({
          where: { id: { in: agentIds }, workspaceId: { in: workspaceIds } },
          select: { id: true, workspaceId: true, name: true },
        })
      : [],
    actorIds.length && workspaceIds.length
      ? db.user.findMany({
          where: { id: { in: actorIds }, ...userScope },
          select: {
            id: true,
            name: true,
            email: true,
            ownedWorkspaces: {
              where: { id: { in: workspaceIds } },
              select: { id: true },
            },
            memberships: {
              where: { workspaceId: { in: workspaceIds } },
              select: { workspaceId: true },
            },
          },
        })
      : [],
    tokenIds.length && workspaceIds.length
      ? db.apiToken.findMany({
          where: {
            id: { in: tokenIds },
            OR: [
              { toolkit: { workspaceId: { in: workspaceIds } } },
              { toolkitId: null, user: userScope },
            ],
          },
          select: {
            id: true,
            name: true,
            toolkit: { select: { workspaceId: true } },
            user: {
              select: {
                ownedWorkspaces: {
                  where: { id: { in: workspaceIds } },
                  select: { id: true },
                },
                memberships: {
                  where: { workspaceId: { in: workspaceIds } },
                  select: { workspaceId: true },
                },
              },
            },
          },
        })
      : [],
    endpointIds.length && workspaceIds.length
      ? db.agentEndpoint.findMany({
          where: { id: { in: endpointIds }, workspaceId: { in: workspaceIds } },
          select: { id: true, workspaceId: true, name: true },
        })
      : [],
    clientIds.length && workspaceIds.length
      ? db.agentApiClient.findMany({
          where: {
            id: { in: clientIds },
            endpoint: { workspaceId: { in: workspaceIds } },
          },
          select: {
            id: true,
            name: true,
            endpoint: { select: { workspaceId: true } },
          },
        })
      : [],
    remoteIds.length && workspaceIds.length
      ? db.remoteA2AAgent.findMany({
          where: { id: { in: remoteIds }, workspaceId: { in: workspaceIds } },
          select: { id: true, workspaceId: true, name: true },
        })
      : [],
  ]);
  const names = new Map<string, NamedEntity>();
  const servers = new Map<string, NamedEntity>();
  const put = (
    workspaceId: string,
    kind: EntityKind,
    id: string,
    name: string,
  ) => names.set(key(workspaceId, kind, id), { id, name });
  for (const row of workspaces) put(row.id, "workspace", row.id, row.name);
  for (const row of deployments) {
    put(row.workspaceId, "deployment", row.id, deploymentLabel(row).name);
    if (row.server) {
      put(row.workspaceId, "server", row.server.id, row.server.name);
      servers.set(key(row.workspaceId, "deployment", row.id), row.server);
    }
  }
  for (const [kind, rows] of [
    ["agent", agents],
    ["endpoint", endpoints],
    ["remote-agent", remotes],
  ] as const)
    for (const row of rows) put(row.workspaceId, kind, row.id, row.name);
  for (const row of users) {
    for (const workspace of row.ownedWorkspaces)
      put(workspace.id, "user", row.id, row.name || row.email);
    for (const membership of row.memberships)
      put(membership.workspaceId, "user", row.id, row.name || row.email);
  }
  for (const row of tokens) {
    if (row.toolkit) put(row.toolkit.workspaceId, "token", row.id, row.name);
    else {
      for (const workspace of row.user.ownedWorkspaces)
        put(workspace.id, "token", row.id, row.name);
      for (const membership of row.user.memberships)
        put(membership.workspaceId, "token", row.id, row.name);
    }
  }
  for (const row of clients)
    put(row.endpoint.workspaceId, "client", row.id, row.name);
  const entity = (
    kind: EntityKind,
    id: string | null | undefined,
    workspaceId: string | null,
  ): NamedEntity | null =>
    id
      ? (names.get(key(workspaceId, kind, id)) ?? { id, name: id.slice(0, 8) })
      : null;
  return {
    entity,
    party(
      kind: Party["kind"],
      id: string | null | undefined,
      workspaceId: string | null,
    ): Party {
      return {
        kind,
        id: id ?? null,
        name:
          kind === "unknown"
            ? (id?.slice(0, 8) ?? "Unknown")
            : (entity(kind, id, workspaceId)?.name ?? "Unknown"),
      };
    },
    server(
      deploymentId: string | null,
      workspaceId: string | null,
    ): NamedEntity | null {
      return deploymentId
        ? (servers.get(key(workspaceId, "deployment", deploymentId)) ?? null)
        : null;
    },
  };
}
