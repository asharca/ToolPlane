import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  authenticatePiPackageInstallation,
  PiInstallationError,
} from "./installations";
import { listMcpTools, mcpRpc } from "@/lib/process/mcp-client";
import { liveStatus } from "@/lib/process/supervisor";
import {
  isMcpToolExposedToAi,
  loadMcpToolPolicies,
} from "@/lib/workspace/mcp-tool-exposure";
import { readSandboxJson, privateJson } from "@/lib/sandboxes/http-body";
import { logRequest } from "@/lib/observability/log";
import { mcpResponseOutcome } from "@/lib/observability/mcp-log-entry";

export function piPackageToolName(
  installationId: string,
  key: string,
  tool: string,
): string {
  return `tp_${createHash("sha256")
    .update(JSON.stringify([installationId, key, tool]))
    .digest("hex")
    .slice(0, 40)}`;
}
const rpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z
      .union([z.string().max(200), z.number().finite(), z.null()])
      .optional(),
    method: z.string().max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function handlePiPackageMcp(
  req: Request,
  installationId: string,
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const context = await authenticatePiPackageInstallation(
    installationId,
    authorization,
  );
  const rpc = rpcSchema.parse(await readSandboxJson(req, 256 * 1024));
  const id = rpc.id ?? null;
  if (rpc.method === "notifications/initialized")
    return new Response(null, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  if (rpc.method === "initialize")
    return privateJson({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "toolplane-pi-package", version: "1.0.0" },
      },
    });
  if (rpc.method === "ping")
    return privateJson({ jsonrpc: "2.0", id, result: {} });
  if (rpc.method !== "tools/list" && rpc.method !== "tools/call")
    return privateJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  const policies = await loadMcpToolPolicies(
    Object.values(context.bindings).map((binding) => binding.deploymentId),
    context.installation.workspaceId,
  );
  const tools = [];
  const start = Date.now();
  for (const [key, binding] of Object.entries(context.bindings)) {
    if (liveStatus(binding.deploymentId) !== "running") continue;
    const allowed = new Set(binding.tools);
    const catalog = await listMcpTools(binding.deploymentId, {
      signal: req.signal,
      maxResponseBytes: 2_000_000,
    });
    for (const tool of catalog) {
      if (
        !allowed.has(tool.name) ||
        !isMcpToolExposedToAi(policies.get(binding.deploymentId), tool.name)
      )
        continue;
      tools.push({
        ...tool,
        name: piPackageToolName(installationId, key, tool.name),
        _meta: {
          toolplaneOrigin: {
            deploymentId: binding.deploymentId,
            originalToolName: tool.name,
            key,
          },
        },
      });
    }
    if (
      tools.length > 1000 ||
      Buffer.byteLength(JSON.stringify(tools)) > 3_000_000
    )
      throw new PiInstallationError("pi_package_catalog_too_large", 502);
  }
  if (rpc.method === "tools/list")
    return privateJson({ jsonrpc: "2.0", id, result: { tools } });
  const args = z
    .object({
      name: z.string().max(100),
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .parse(rpc.params);
  const selected = tools.find((tool) => tool.name === args.name);
  if (!selected)
    return privateJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Unknown or forbidden tool" },
    });
  // Recheck immediately before execution, including updates/revocation during discovery.
  const current = await authenticatePiPackageInstallation(
    installationId,
    authorization,
  );
  const origin = selected._meta.toolplaneOrigin;
  const binding = current.bindings[origin.key];
  const latestPolicies = await loadMcpToolPolicies(
    [origin.deploymentId],
    current.installation.workspaceId,
  );
  if (
    current.installation.releaseId !== context.installation.releaseId ||
    binding?.deploymentId !== origin.deploymentId ||
    !binding.tools.includes(origin.originalToolName) ||
    !isMcpToolExposedToAi(
      latestPolicies.get(origin.deploymentId),
      origin.originalToolName,
    )
  )
    throw new PiInstallationError("pi_package_tool_forbidden", 403);
  const result = await mcpRpc(
    origin.deploymentId,
    "tools/call",
    { name: origin.originalToolName, arguments: args.arguments ?? {} },
    60_000,
    {
      signal: req.signal,
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 3_000_000,
    },
  );
  const response = result
    ? privateJson({
        jsonrpc: "2.0",
        id,
        result: { ...result, _meta: { toolplaneOrigin: origin } },
      })
    : privateJson(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Tool deployment unavailable" },
        },
        502,
      );
  await logRequest({
    workspaceId: current.installation.workspaceId,
    deploymentId: origin.deploymentId,
    method: "POST",
    path: `/pi-packages/installations/${installationId}/mcp#tools/call:${origin.originalToolName}`,
    statusCode: response.status,
    durationMs: Date.now() - start,
    response,
    outcome: mcpResponseOutcome(result, response.status),
  });
  return response;
}
