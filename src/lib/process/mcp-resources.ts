import 'server-only';
import { ListResourcesResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMcpPromptSources, McpPromptRequestError } from './mcp-prompts';
import { mcpRpc } from './mcp-client';
import { liveStatus } from './supervisor';

type SourceInput = { workspaceId: string; deploymentIds: readonly string[]; signal?: AbortSignal };

export async function listAttachedMcpResources(input: SourceInput) {
  const sources = await getMcpPromptSources(input.workspaceId, input.deploymentIds);
  return (await Promise.all(sources.map(async (source) => {
    const resources: Array<{ deploymentId: string; serverName: string; uri: string; name: string; description?: string }> = [];
    if (liveStatus(source.deploymentId) !== 'running') return resources;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let remaining = 512 * 1024;
    try {
      for (let page = 0; page < 10 && resources.length < 200 && remaining > 0; page++) {
        const result = ListResourcesResultSchema.parse(await mcpRpc(source.deploymentId, 'resources/list', cursor ? { cursor } : undefined, 5000, {
          signal: input.signal, maxResponseBytes: remaining, onResponseBytes: (size) => { remaining -= size; },
        }));
        for (const resource of result.resources) {
          if (resources.length >= 200) break;
          if (resource.uri.length <= 4000 && !resources.some((item) => item.uri === resource.uri)) {
            resources.push({ ...source, uri: resource.uri, name: resource.title ?? resource.name, description: resource.description?.slice(0, 2000) });
          }
        }
        if (!result.nextCursor || cursors.has(result.nextCursor) || result.nextCursor.length > 4000) break;
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
    } catch { /* A server without resources must not hide other servers' resources. */ }
    return resources;
  }))).flat();
}

export async function readAttachedMcpResource(input: SourceInput & { deploymentId: string; uri: string }) {
  const resource = (await listAttachedMcpResources(input))
    .find((item) => item.deploymentId === input.deploymentId && item.uri === input.uri);
  if (!resource) throw new McpPromptRequestError(404, 'MCP resource is not attached to this Agent.');
  const result = ReadResourceResultSchema.parse(await mcpRpc(input.deploymentId, 'resources/read', { uri: input.uri }, 15_000, {
    signal: input.signal, maxResponseBytes: 512 * 1024,
  }));
  const text = result.contents.flatMap((content) => 'text' in content && typeof content.text === 'string' ? [content.text] : []).join('\n\n');
  if (!text.trim()) throw new McpPromptRequestError(422, 'This resource has no readable text content.');
  return { resource, text };
}
