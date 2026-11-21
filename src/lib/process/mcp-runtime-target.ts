import "server-only";
import { frozenSandboxes } from "@/lib/sandboxes/activity";
import { db } from "@/lib/db";
import { connectorStatus } from "@/lib/sandboxes/connector-broker";
import { liveRegistry } from "./supervisor/registry";
import { isExternalSandboxCandidate } from "@/lib/sandboxes/external";
import type { McpRuntimeTarget } from "@/lib/workspace/mcp-config-types";

export { MCP_RUNTIME_IMAGE, isPackagedStdioCommand } from "./sandbox";

type TargetInput = {
  workspaceId: string;
  target: McpRuntimeTarget;
  sandboxId: string | null;
  source?: string | null;
  command?: string;
};

export async function resolveMcpRuntimeSandbox(input: TargetInput) {
  if (
    input.target !== "workspace_sandbox" ||
    !input.workspaceId ||
    !input.sandboxId ||
    frozenSandboxes.has(input.sandboxId) ||
    input.source === "docker" ||
    input.command === "docker" ||
    (input.source !== undefined &&
      !["config", "npm", "github", "pypi"].includes(input.source ?? ""))
  )
    return null;
  const sandbox = await db.sandbox.findFirst({
    where: {
      id: input.sandboxId,
      workspaceId: input.workspaceId,
      deployment: {
        workspaceId: input.workspaceId,
        source: "sandbox",
        status: { in: ["running", "provisioning"] },
      },
      agentLinks: { none: {} },
    },
    select: { id: true, kind: true, config: true, deploymentId: true },
  });
  if (
    !sandbox ||
    !isExternalSandboxCandidate({ ...sandbox, isAgentTemplate: false }) ||
    liveRegistry(sandbox.deploymentId)?.status !== "running"
  )
    return null;
  if (sandbox.kind === "connector") {
    if (!connectorStatus(sandbox.id).capabilities.includes("mcp_stdio"))
      return null;
  }
  return sandbox;
}

export async function validateMcpRuntimeTarget(
  input: TargetInput,
): Promise<{ ok: true } | { ok: false; error: "sandboxUnavailable" }> {
  const valid =
    input.target === "managed"
      ? input.sandboxId === null
      : await resolveMcpRuntimeSandbox(input);
  return valid ? { ok: true } : { ok: false, error: "sandboxUnavailable" };
}
