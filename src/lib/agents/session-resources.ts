import "server-only";
import {
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  sessionMcpRequest,
  type SessionMcpContext,
} from "@/lib/process/session-mcp";
import {
  getMcpPromptSources,
  McpPromptRequestError,
} from "@/lib/process/mcp-prompts";

export async function listAgentSessionPrompts(
  context: SessionMcpContext,
  deploymentIds: readonly string[],
) {
  const sources = await getMcpPromptSources(context.workspaceId, deploymentIds);
  const prompts = await Promise.all(
    sources.map(async (source) => {
      const result = ListPromptsResultSchema.parse(
        await sessionMcpRequest(context, source.deploymentId, "prompts/list"),
      );
      return result.prompts.map((prompt) => ({
        ...source,
        ...prompt,
        arguments: prompt.arguments ?? [],
      }));
    }),
  );
  return prompts.flat();
}

export async function resolveAgentSessionPrompt(
  context: SessionMcpContext,
  deploymentIds: readonly string[],
  input: {
    deploymentId: string;
    name: string;
    arguments: Record<string, string>;
  },
) {
  const prompt = (await listAgentSessionPrompts(context, deploymentIds)).find(
    (item) =>
      item.deploymentId === input.deploymentId && item.name === input.name,
  );
  if (!prompt)
    throw new McpPromptRequestError(
      404,
      "MCP prompt is not attached to this session.",
    );
  const allowed = new Map(
    prompt.arguments.map((argument) => [argument.name, argument]),
  );
  for (const [name, value] of Object.entries(input.arguments)) {
    if (!allowed.has(name) || value.length > 20_000)
      throw new McpPromptRequestError(400, "Invalid MCP prompt arguments.");
  }
  for (const argument of prompt.arguments) {
    if (argument.required && !input.arguments[argument.name]?.trim())
      throw new McpPromptRequestError(
        400,
        `MCP prompt argument "${argument.name}" is required.`,
      );
  }
  const result = GetPromptResultSchema.parse(
    await sessionMcpRequest(context, input.deploymentId, "prompts/get", {
      name: input.name,
      arguments: input.arguments,
    }),
  );
  const message = result.messages.length === 1 ? result.messages[0] : null;
  if (
    message?.role !== "user" ||
    message.content.type !== "text" ||
    !message.content.text.trim()
  )
    throw new McpPromptRequestError(
      422,
      "This MCP prompt does not return a supported user text message.",
    );
  return {
    source: {
      deploymentId: prompt.deploymentId,
      serverName: prompt.serverName,
    },
    prompt,
    text: message.content.text,
  };
}

export async function listAgentSessionResources(
  context: SessionMcpContext,
  deploymentIds: readonly string[],
) {
  const sources = await getMcpPromptSources(context.workspaceId, deploymentIds);
  return (
    await Promise.all(
      sources.map(async (source) => {
        const result = ListResourcesResultSchema.parse(
          await sessionMcpRequest(
            context,
            source.deploymentId,
            "resources/list",
          ),
        );
        return result.resources.map((resource) => ({
          ...source,
          uri: resource.uri,
          name: resource.title ?? resource.name,
          description: resource.description,
        }));
      }),
    )
  ).flat();
}

export async function readAgentSessionResource(
  context: SessionMcpContext,
  deploymentIds: readonly string[],
  deploymentId: string,
  uri: string,
) {
  const resource = (
    await listAgentSessionResources(context, deploymentIds)
  ).find((item) => item.deploymentId === deploymentId && item.uri === uri);
  if (!resource)
    throw new McpPromptRequestError(
      404,
      "MCP resource is not attached to this session.",
    );
  const result = ReadResourceResultSchema.parse(
    await sessionMcpRequest(context, deploymentId, "resources/read", { uri }),
  );
  return {
    resource,
    text: result.contents
      .flatMap((content) => ("text" in content ? [content.text] : []))
      .join("\n")
      .slice(0, 32_000),
  };
}
