import "server-only";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "@earendil-works/pi-ai";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  CreateMessageRequest,
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/lib/db";
import { buildModel } from "@/lib/agents/model";
import { assertLocalRuntimeToken } from "@/lib/a2a/local-runtime";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import {
  agentSessionWorkingDirectory,
  type AgentSessionIdentity,
} from "@/lib/agents/session-paths";
import { updateTaskUi } from "@/lib/agents/execution/task-ui";
import { recordEvent } from "@/lib/observability/events";

export type McpCallbackContext = {
  deploymentId: string;
  workspaceId: string;
  token?: AgentRuntimeTokenPayload;
  session?: AgentSessionIdentity;
};

export async function sessionRoots({ token, session }: McpCallbackContext) {
  const identity = token ?? session;
  if (!identity) return { roots: [] }; // Assistants have no sandbox.
  const task = token?.a2aTaskId ? await assertLocalRuntimeToken(token) : null;
  const workDir =
    task?.grant.entryPolicy?.kind === "work" &&
    !task.grant.ancestorTaskIds.length
      ? task.grant.entryPolicy.workingDirectory
      : undefined;
  return {
    roots: [
      {
        uri: pathToFileURL(agentSessionWorkingDirectory(identity, workDir))
          .href,
      },
    ],
  };
}

export async function elicit(
  context: McpCallbackContext,
  params: ElicitRequest["params"],
  signal: AbortSignal,
): Promise<ElicitResult> {
  const token = context.token;
  // Chat's durable confirmation is bound to the original tool invocation, not
  // approval to disclose arbitrary fields to that tool. Do not replay it.
  if (!token?.a2aTaskId || params.mode === "url") return { action: "decline" };
  const id = randomUUID();
  const schema = params.requestedSchema;
  if (JSON.stringify(schema).length > 16_384 || params.message.length > 4096)
    return { action: "decline" };
  const validate = new AjvJsonSchemaValidator().getValidator<
    ElicitResult["content"]
  >(schema);
  try {
    const hasFields = Object.keys(schema.properties).length > 0;
    let reply = await updateTaskUi(token, {
      action: "request",
      request: hasFields
        ? {
            type: "extension_ui_request",
            id,
            method: "input",
            title: `MCP ${context.deploymentId}: ${params.message}\n${JSON.stringify(schema)}\nEnter a JSON object to share with this server, or cancel.`,
            timeout: 120_000,
          }
        : {
            type: "extension_ui_request",
            id,
            method: "confirm",
            title: `MCP ${context.deploymentId}`,
            message: params.message,
            timeout: 120_000,
          },
    });
    while (!reply.response) {
      await delay(750, undefined, { signal });
      reply = await updateTaskUi(token, { action: "poll", id });
    }
    if (reply.response.cancelled) return { action: "cancel" };
    if (!hasFields)
      return reply.response.confirmed
        ? { action: "accept", content: {} }
        : { action: "decline" };
    if (!reply.response.value) return { action: "decline" };
    const data = JSON.parse(reply.response.value);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => !Object.hasOwn(schema.properties, key))
    )
      return { action: "decline" };
    const checked = validate(data);
    return checked.valid
      ? { action: "accept", content: checked.data }
      : { action: "decline" };
  } catch {
    return { action: "decline" };
  } finally {
    await updateTaskUi(token, { action: "resolve", id }).catch(() => undefined);
  }
}

export async function sample(
  context: McpCallbackContext,
  params: CreateMessageRequest["params"],
  signal: AbortSignal,
) {
  const { deploymentId, workspaceId, token } = context;
  // Check at dispatch, not just when advertising capabilities. Never honor a
  // server-provided model URL, credential, or request for another chat's context.
  const deployment = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId },
    select: {
      samplingEnabled: true,
      workspace: {
        select: { defaultModel: true, defaultModelProviderId: true },
      },
    },
  });
  if (!deployment?.samplingEnabled) {
    await recordEvent({
      domain: "mcp",
      eventName: "mcp.callback",
      workspaceId,
      deploymentId,
      rpcMethod: "sampling/createMessage",
      outcome: "denied",
      errorCode: "MCP_SAMPLING_DISABLED",
    });
    throw new McpError(-32601, "MCP_SAMPLING_DISABLED");
  }
  const grant = token ? await resolveAgentRuntimeGrant(token) : null;
  const modelId = token ? grant?.model : deployment.workspace.defaultModel;
  const providerId = token
    ? token.providerId
    : deployment.workspace.defaultModelProviderId;
  if (!modelId || !providerId)
    throw new McpError(-32000, "MCP_SAMPLING_MODEL_UNAVAILABLE");
  const provider = await db.modelProvider.findFirst({
    where: { id: providerId, workspaceId },
  });
  if (!provider?.apiKey.trim() || !provider.models.includes(modelId))
    throw new McpError(-32000, "MCP_SAMPLING_MODEL_UNAVAILABLE");
  if (
    params.tools?.length ||
    params.messages.length > 100 ||
    JSON.stringify(params).length > 262_144 ||
    !Number.isSafeInteger(params.maxTokens) ||
    params.maxTokens < 1
  )
    throw new McpError(-32602, "MCP_SAMPLING_INPUT_UNSUPPORTED");
  const { model, models } = buildModel(provider, modelId);
  const messages: Message[] = [];
  if (params.systemPrompt)
    messages.push({
      role: "system",
      content: params.systemPrompt,
      timestamp: Date.now(),
    });
  for (const m of params.messages) {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    const content = parts.map((part) => {
      if (part.type !== "text")
        throw new McpError(-32602, "MCP_SAMPLING_INPUT_UNSUPPORTED");
      return { type: "text" as const, text: part.text };
    });
    if (m.role === "user")
      messages.push({ role: "user", content, timestamp: Date.now() });
    else
      messages.push({
        role: "assistant",
        model: model.id,
        api: model.api,
        provider: model.provider,
        timestamp: Date.now(),
        content,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          totalTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
  }
  const answer = await models.completeSimple(
    model,
    { messages },
    {
      signal,
      maxTokens: Math.min(4096, params.maxTokens),
      temperature: params.temperature,
      maxRetries: 0,
    },
  );
  if (answer.stopReason === "error" || answer.stopReason === "aborted")
    throw new McpError(-32000, "MCP_SAMPLING_FAILED");
  return {
    role: "assistant" as const,
    model: modelId,
    content: {
      type: "text" as const,
      text: answer.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(""),
    },
    stopReason: answer.stopReason === "length" ? "maxTokens" : "endTurn",
  };
}
