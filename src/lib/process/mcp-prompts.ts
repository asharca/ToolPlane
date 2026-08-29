import 'server-only';
import { db } from '@/lib/db';
import { liveStatus } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import {
  getMcpPrompt,
  listMcpPrompts,
  type McpPrompt,
  type McpRpcOptions,
} from './mcp-client';

const MAX_PROMPT_RESPONSE_BYTES = 512 * 1024;
const MAX_PROMPT_ARGUMENT_VALUE_LENGTH = 20_000;

export type McpPromptSource = {
  deploymentId: string;
  serverName: string;
};

export type ListedMcpPrompt = McpPrompt & McpPromptSource;

export class McpPromptRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'McpPromptRequestError';
  }
}

function requestOptions(signal?: AbortSignal): McpRpcOptions {
  return { signal, maxResponseBytes: MAX_PROMPT_RESPONSE_BYTES };
}

export async function getMcpPromptSources(
  workspaceId: string,
  deploymentIds: readonly string[],
): Promise<McpPromptSource[]> {
  const ids = [...new Set(deploymentIds)];
  if (!ids.length) return [];
  const deployments = await db.deployment.findMany({
    where: { workspaceId, id: { in: ids } },
    select: {
      id: true,
      name: true,
      source: true,
      sourceRef: true,
      serverId: true,
      server: { select: { name: true } },
    },
  });
  const sourceById = new Map(deployments.map((deployment) => [
    deployment.id,
    { deploymentId: deployment.id, serverName: deploymentLabel(deployment).name },
  ]));
  return ids.flatMap((id) => sourceById.get(id) ?? []);
}

export async function listAttachedMcpPrompts(input: {
  workspaceId: string;
  deploymentIds: readonly string[];
  signal?: AbortSignal;
}): Promise<ListedMcpPrompt[]> {
  const sources = await getMcpPromptSources(input.workspaceId, input.deploymentIds);
  const prompts = await Promise.all(sources.map(async (source) => {
    if (liveStatus(source.deploymentId) !== 'running') return [];
    try {
      return (await listMcpPrompts(source.deploymentId, requestOptions(input.signal)))
        .map((prompt) => ({ ...source, ...prompt }));
    } catch {
      return [];
    }
  }));
  return prompts.flat();
}

export async function resolveAttachedMcpPromptText(input: {
  workspaceId: string;
  deploymentIds: readonly string[];
  deploymentId: string;
  name: string;
  argumentsValue: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ source: McpPromptSource; prompt: McpPrompt; text: string }> {
  const sources = await getMcpPromptSources(input.workspaceId, input.deploymentIds);
  const source = sources.find((candidate) => candidate.deploymentId === input.deploymentId);
  if (!source) throw new McpPromptRequestError(404, 'MCP deployment is not attached to this conversation.');
  if (liveStatus(source.deploymentId) !== 'running') {
    throw new McpPromptRequestError(409, 'MCP deployment is not running.');
  }

  const prompt = (await listMcpPrompts(source.deploymentId, requestOptions(input.signal)))
    .find((candidate) => candidate.name === input.name);
  if (!prompt) throw new McpPromptRequestError(404, 'MCP prompt not found.');

  const allowedArguments = new Map(prompt.arguments.map((argument) => [argument.name, argument]));
  const argumentsValue: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.argumentsValue)) {
    if (!allowedArguments.has(name) || typeof value !== 'string' || value.length > MAX_PROMPT_ARGUMENT_VALUE_LENGTH) {
      throw new McpPromptRequestError(400, 'Invalid MCP prompt arguments.');
    }
    argumentsValue[name] = value;
  }
  for (const argument of prompt.arguments) {
    if (argument.required && !argumentsValue[argument.name]?.trim()) {
      throw new McpPromptRequestError(400, `MCP prompt argument "${argument.name}" is required.`);
    }
  }

  const result = await getMcpPrompt(source.deploymentId, prompt.name, argumentsValue, requestOptions(input.signal));
  const message = result?.messages.length === 1 ? result.messages[0] : null;
  const text = message?.role === 'user' && message.content.type === 'text'
    ? message.content.text
    : undefined;
  if (!text?.trim()) {
    throw new McpPromptRequestError(422, 'This MCP prompt does not return a supported user text message.');
  }
  return { source, prompt, text };
}
