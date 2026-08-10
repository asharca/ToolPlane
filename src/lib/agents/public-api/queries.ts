import 'server-only';
import { db } from '@/lib/db';

/**
 * Control-plane view for the Agent settings page. The workspace and source
 * Agent are part of the predicate so a guessed endpoint id can never cross a
 * workspace boundary.
 */
export async function getAgentEndpointForManagement(workspaceId: string, agentId: string) {
  return db.agentEndpoint.findFirst({
    where: { workspaceId, sourceAgentId: agentId },
    select: {
      publicId: true,
      status: true,
      name: true,
      isolationMode: true,
      rpmLimit: true,
      dailyRequestLimit: true,
      dailyOutputCharacterLimit: true,
      maxConcurrent: true,
      maxRuntimes: true,
      maxStoredCharacters: true,
      timeoutSeconds: true,
      retentionDays: true,
      allowedOrigins: true,
      currentRevision: {
        select: {
          version: true,
          systemPrompt: true,
          deploymentIds: true,
          installedSkillIds: true,
        },
      },
      clients: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          keys: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              name: true,
              prefix: true,
              createdAt: true,
              lastUsedAt: true,
              expiresAt: true,
              revokedAt: true,
            },
          },
        },
      },
    },
  });
}

export async function getPublicEndpointCorsOrigins(publicId: string): Promise<string[]> {
  const endpoint = await db.agentEndpoint.findUnique({
    where: { publicId },
    select: { allowedOrigins: true },
  });
  return endpoint?.allowedOrigins ?? [];
}
