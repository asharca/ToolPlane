import type { Prisma } from "@prisma/client";

export const VISIBLE_AGENT_LISTING_ORIGIN = {
  visibility: "public",
  OR: [
    { publisherKind: "platform" },
    { publisherKind: "workspace", publisherWorkspace: { is: {} } },
  ],
} satisfies Prisma.AgentListingWhereInput;

/** The caller must authorize membership before supplying a workspace scope. */
export function visibleAgentListingOrigin(
  workspaceId?: string,
): Prisma.AgentListingWhereInput {
  if (!workspaceId) return VISIBLE_AGENT_LISTING_ORIGIN;
  return {
    OR: [
      VISIBLE_AGENT_LISTING_ORIGIN,
      {
        publisherKind: "workspace",
        publisherWorkspaceId: workspaceId,
        visibility: "private",
      },
    ],
  };
}

export function isPlatformAgentListingOrigin(row: { publisherKind: string }) {
  return row.publisherKind === "platform";
}
