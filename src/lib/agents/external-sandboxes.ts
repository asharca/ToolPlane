import "server-only";
import { db } from "@/lib/db";
import type { AgentRevisionConfig } from "./revision-types";
import { runtimeExternalSandboxProxyUrl } from "./runtime-access";
import type { SandboxRuntimeMcpServer } from "./sandbox-runtime";

// The proxy waits up to 180 seconds for a sandbox reply.
const EXTERNAL_SANDBOX_TIMEOUT_MS = 190_000;

/**
 * Session MCP servers for the revision's attached sandboxes that are still
 * attached, in pinned order. Access is enforced per call by the runtime proxy.
 */
export async function resolveSessionExternalSandboxes(input: {
  workspaceId: string;
  agentId: string;
  pinned: AgentRevisionConfig["externalSandboxes"];
}): Promise<Array<SandboxRuntimeMcpServer & { sandboxId: string }>> {
  if (!input.pinned.length) return [];
  const live = await db.agentExternalSandbox.findMany({
    where: {
      agentId: input.agentId,
      sandboxId: { in: input.pinned.map((entry) => entry.sandboxId) },
      sandbox: { workspaceId: input.workspaceId },
    },
    select: {
      sandboxId: true,
      sandbox: { select: { name: true, kind: true, deploymentId: true } },
    },
  });
  return input.pinned.flatMap((entry) => {
    const row = live.find((item) => item.sandboxId === entry.sandboxId);
    return row
      ? [
          {
            sandboxId: entry.sandboxId,
            deploymentId: row.sandbox.deploymentId,
            url: runtimeExternalSandboxProxyUrl(entry.sandboxId),
            label: `external sandbox "${row.sandbox.name}" (${row.sandbox.kind}, ${entry.access})`,
            timeoutMs: EXTERNAL_SANDBOX_TIMEOUT_MS,
          },
        ]
      : [];
  });
}
