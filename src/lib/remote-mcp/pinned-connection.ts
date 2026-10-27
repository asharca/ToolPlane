import "server-only";
import type { Deployment } from "@prisma/client";
import { db } from "@/lib/db";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import { liveMcpRuntimeSnapshot, startProcess } from "@/lib/process/supervisor";
import { mcpRpc } from "@/lib/process/mcp-client";
import type { McpRpcOptions } from "@/lib/process/mcp-client";
import { redactMcpToolCatalogResult } from "@/lib/process/mcp-tool-catalog";
import type { McpToolDefinition } from "@/lib/process/mcp-tool-catalog";
import {
  mcpHeaderSecrets,
  redactMcpResult,
} from "@/lib/process/mcp-result-redaction";
import {
  assertAssistantRemoteDeployment,
  remoteMcpConnectionIdentity,
} from "./classification";
import { resolveMcpConnectionSpawnSpec } from "@/lib/process/mcp-credentials";

export type PinnedRemoteMcpContext = {
  workspaceId: string;
  deploymentId: string;
  definitionChecksum: string;
};

/** The tools/call dispatch boundary was never reached; no remote effect is possible. */
export class McpToolNotDispatchedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Remote MCP call refused before dispatch",
      { cause },
    );
    this.name = "McpToolNotDispatchedError";
  }
}

async function withPinnedRemoteConnection<T>(
  context: PinnedRemoteMcpContext,
  operation: (connection: {
    deployment: Deployment;
    secrets: string[];
  }) => Promise<T>,
): Promise<T> {
  const result = await runMcpDeploymentOperation(
    context.workspaceId,
    context.deploymentId,
    async () => {
      const deployment = await db.deployment.findFirst({
        where: { id: context.deploymentId, workspaceId: context.workspaceId },
      });
      if (
        !deployment ||
        mcpDefinitionChecksum(deployment) !== context.definitionChecksum
      )
        throw new Error("MCP_DEFINITION_CHANGED");
      assertAssistantRemoteDeployment(deployment);
      const { spec } = await resolveMcpConnectionSpawnSpec({
        ...context,
        expectedDefinitionChecksum: context.definitionChecksum,
      });
      if (spec.kind !== "remote")
        throw new Error("ASSISTANT_REMOTE_MCP_REQUIRED");
      const identity = remoteMcpConnectionIdentity(spec);
      const before = liveMcpRuntimeSnapshot(deployment.id);
      if (before && before.remoteConnectionIdentity !== identity)
        throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
      await startProcess(deployment.id, spec, {
        workspaceId: context.workspaceId,
      });
      if (
        liveMcpRuntimeSnapshot(deployment.id)?.remoteConnectionIdentity !==
        identity
      )
        throw new Error("MCP_CONNECTION_UNAVAILABLE");
      return operation({ deployment, secrets: mcpHeaderSecrets(spec.headers) });
    },
  );
  if (!result.accepted) throw new Error("MCP_CONNECTION_UNAVAILABLE");
  return result.value;
}

async function readPinnedRemoteToolCatalog(
  deploymentId: string,
  secrets: string[],
  options: McpRpcOptions,
): Promise<McpToolDefinition[]> {
  const tools: unknown[] = [];
  const seenCursors = new Set<string>();
  const runtime = liveMcpRuntimeSnapshot(deploymentId);
  if (!runtime) throw new Error("MCP_CONNECTION_UNAVAILABLE");
  const deadline = Date.now() + 15_000;
  let remainingBytes = 4_000_000;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    options.signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("MCP_CATALOG_LIMIT_EXCEEDED");
    let responseBytes = 0;
    const result = await mcpRpc(
      deploymentId,
      "tools/list",
      cursor === undefined ? {} : { cursor },
      Math.min(5_000, remainingMs),
      {
        ...options,
        maxResponseBytes: Math.min(
          options.maxResponseBytes ?? remainingBytes,
          remainingBytes,
        ),
        onResponseBytes: (bytes) => {
          responseBytes = bytes;
          options.onResponseBytes?.(bytes);
        },
      },
    );
    const after = liveMcpRuntimeSnapshot(deploymentId);
    if (
      !after ||
      after.generation !== runtime.generation ||
      after.port !== runtime.port ||
      after.remoteConnectionIdentity !== runtime.remoteConnectionIdentity
    )
      throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
    if (!result || !Array.isArray(result.tools))
      throw new Error("MCP_CATALOG_INVALID");
    remainingBytes -=
      responseBytes || Buffer.byteLength(JSON.stringify(result), "utf8");
    if (remainingBytes < 0 || result.tools.length > 1_000 - tools.length) {
      throw new Error("MCP_CATALOG_LIMIT_EXCEEDED");
    }
    tools.push(...result.tools);
    if (result.nextCursor === undefined) {
      const catalog = redactMcpToolCatalogResult(tools, secrets);
      if (!catalog.ok) throw new Error("MCP_CATALOG_INVALID");
      return catalog.tools;
    }
    const nextCursor = result.nextCursor;
    if (
      typeof nextCursor !== "string" ||
      !nextCursor ||
      nextCursor.length > 4_000 ||
      seenCursors.has(nextCursor)
    )
      throw new Error("MCP_CATALOG_PAGINATION_INVALID");
    if (page === 9 || tools.length >= 1_000 || remainingBytes === 0) {
      throw new Error("MCP_CATALOG_LIMIT_EXCEEDED");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("MCP_CATALOG_LIMIT_EXCEEDED");
}

/** Protocol discovery only: no tool invocation and no grant widening. */
export async function listPinnedRemoteMcpTools(
  context: PinnedRemoteMcpContext,
  options: McpRpcOptions = {},
) {
  return withPinnedRemoteConnection(context, ({ secrets }) =>
    readPinnedRemoteToolCatalog(context.deploymentId, secrets, options),
  );
}

/** Explicit approved tool invocation against the checked live remote launch, never a stdio gateway. */
export async function callPinnedRemoteMcpTool(
  context: PinnedRemoteMcpContext,
  name: string,
  args: Record<string, unknown>,
  approvedToolNames: readonly string[],
  options: McpRpcOptions = {},
  beforeCall?: () => Promise<void>,
): Promise<Record<string, unknown> | null> {
  let dispatched = false;
  try {
    return await withPinnedRemoteConnection(
      context,
      async ({ deployment, secrets }) => {
        if (
          !approvedToolNames.includes(name) ||
          (deployment.mcpToolExposure === "allowlist" &&
            !deployment.mcpAllowedTools.includes(name))
        )
          throw new Error("MCP_TOOL_FORBIDDEN");
        const tools = await readPinnedRemoteToolCatalog(
          context.deploymentId,
          secrets,
          options,
        );
        if (!tools.some((tool) => tool.name === name))
          throw new Error("MCP_TOOL_UNAVAILABLE");
        const live = await db.deployment.findFirst({
          where: { id: deployment.id, workspaceId: context.workspaceId },
        });
        if (
          !live ||
          mcpDefinitionChecksum(live) !== context.definitionChecksum ||
          (live.mcpToolExposure === "allowlist" &&
            !live.mcpAllowedTools.includes(name))
        )
          throw new Error("MCP_GRANT_REVOKED");
        const { spec } = await resolveMcpConnectionSpawnSpec({
          ...context,
          expectedDefinitionChecksum: context.definitionChecksum,
        });
        if (spec.kind !== "remote")
          throw new Error("ASSISTANT_REMOTE_MCP_REQUIRED");
        if (
          liveMcpRuntimeSnapshot(live.id)?.remoteConnectionIdentity !==
          remoteMcpConnectionIdentity(spec)
        )
          throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
        await beforeCall?.();
        options.signal?.throwIfAborted();
        dispatched = true;
        const value = await mcpRpc(
          live.id,
          "tools/call",
          { name, arguments: args },
          30_000,
          options,
        );
        return value ? redactMcpResult(value, secrets) : null;
      },
    );
  } catch (error) {
    if (!dispatched) throw new McpToolNotDispatchedError(error);
    throw error;
  }
}
