import type { Prisma } from '@prisma/client';

// This query is the intersection of user membership AND credential scope. Do
// not replace it with a user-only lookup after authenticating a scoped token.
export function toolkitAccessWhere(
  principal: { user: { id: string }; token: { toolkitId: string | null } | null },
  workspaceSlug: string,
  toolkitSlug: string,
): Prisma.ToolkitWhereInput {
  return {
    ...(principal.token?.toolkitId ? { id: principal.token.toolkitId } : {}),
    slug: toolkitSlug,
    enabled: true,
    workspace: {
      slug: workspaceSlug,
      status: 'active',
      OR: [
        { ownerId: principal.user.id },
        { members: { some: { userId: principal.user.id } } },
      ],
    },
  };
}
