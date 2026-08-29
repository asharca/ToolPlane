import type { Prisma } from '@prisma/client';

export const VISIBLE_AGENT_LISTING_ORIGIN = {
  OR: [
    { publisherKind: 'platform' },
    { publisherKind: 'workspace', publisherWorkspace: { is: {} } },
  ],
} satisfies Prisma.AgentListingWhereInput;

export function isPlatformAgentListingOrigin(row: {
  publisherKind: string;
}) {
  return row.publisherKind === 'platform';
}
