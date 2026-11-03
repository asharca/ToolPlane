import "server-only";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { listMcpTools, mcpRpc } from "@/lib/process/mcp-client";
import { effectiveStatus } from "@/lib/process/supervisor";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";
import {
  isMcpToolExposedToAi,
  mcpToolPolicyFromStored,
  type StoredMcpToolPolicy,
} from "@/lib/workspace/mcp-tool-exposure";
import { isSandboxMcpTool } from "./mcp-policy";

/** Sandbox row shape needed to list or invoke its runtime tools. */
export type DispatchableSandbox = {
  id: string;
  workspaceId: string;
  deploymentId: string;
  deployment: StoredMcpToolPolicy & { status: string };
};

export const sandboxToolError = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const unconfirmedReply = () =>
  sandboxToolError(
    "Sandbox reply unavailable. The operation may have executed; inspect state before retrying. Do not retry mutations blindly.",
  );

function running(sandbox: DispatchableSandbox): boolean {
  return (
    effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) ===
    "running"
  );
}

function permitted(
  sandbox: DispatchableSandbox,
  allowed: readonly string[],
  name: string,
): boolean {
  return (
    isSandboxMcpTool(name) &&
    allowed.includes(name) &&
    isMcpToolExposedToAi(mcpToolPolicyFromStored(sandbox.deployment), name)
  );
}

/** Live catalog narrowed to `allowed` and the deployment exposure policy; empty while stopped. */
export async function listSandboxTools(
  sandbox: DispatchableSandbox,
  allowed: readonly string[],
  signal?: AbortSignal,
) {
  if (!running(sandbox)) return [];
  // Sandbox runtime catalogs are fixed code, never persisted per deployment.
  const tools = await listMcpTools(sandbox.deploymentId, {
    signal,
    persistCatalog: false,
  });
  return tools.filter((tool) => permitted(sandbox, allowed, tool.name));
}

/** Invoke one authorized sandbox tool once; never retried after dispatch. */
export async function callSandboxTool(
  sandbox: DispatchableSandbox,
  allowed: readonly string[],
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (!permitted(sandbox, allowed, name))
    return sandboxToolError("Tool not authorized.");
  if (!running(sandbox))
    return sandboxToolError(
      "Sandbox is stopped, unavailable or under maintenance. No command was submitted.",
    );
  const release = beginWorkspaceOperation(sandbox.workspaceId);
  if (!release)
    return sandboxToolError(
      "Workspace is unavailable. No command was submitted.",
    );
  let dispatchAttempted = false;
  try {
    return await withSandboxExecutionLease(sandbox.id, async () => {
      // The underlying runtime bounds commands to 120 seconds; leave room for
      // its cleanup. A rejected RPC does not prove the operation never started.
      dispatchAttempted = true;
      const result = await mcpRpc(
        sandbox.deploymentId,
        "tools/call",
        { name, arguments: args },
        180_000,
        { maxRequestBytes: 4_000_000, maxResponseBytes: 8_000_000 },
      );
      const parsed = CallToolResultSchema.safeParse(result);
      return parsed.success ? parsed.data : unconfirmedReply();
    });
  } catch {
    // Only pre-dispatch rejection can safely promise no command was sent.
    // Never expose raw transport errors, credentials or remote paths.
    return dispatchAttempted
      ? unconfirmedReply()
      : sandboxToolError(
          "Sandbox is busy or unavailable. No command was submitted.",
        );
  } finally {
    release();
  }
}
