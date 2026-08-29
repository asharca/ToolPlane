'use server';

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { resolveSpawnSpec, type SpawnSpec } from '@/lib/process/spawn-spec';
import {
  listMcpToolsViaSandbox,
  mcpRpcViaSandbox,
  SandboxMcpAuthenticationError,
} from '@/lib/process/sandbox-mcp-client';
import { listMcpTools, mcpRpc } from '@/lib/process/mcp-client';
import { logRequest } from '@/lib/observability/log';
import {
  redactMcpToolCatalogResult,
  type McpToolDefinition,
} from '@/lib/process/mcp-tool-catalog';
import {
  readMcpInspectorConnection,
  withMcpInspectorConnection,
} from '@/lib/workspace/inspector-connection';
import { missingDeploymentRequiredEnvironment } from '@/lib/workspace/server-recipe';

type RemoteSpec = Extract<SpawnSpec, { kind: 'remote' }>;

export type McpInspectorError =
  | 'notAuthorized'
  | 'deploymentNotFound'
  | 'deploymentNotRunning'
  | 'sandboxRequired'
  | 'sandboxNotFound'
  | 'sandboxNetworkDisabled'
  | 'sandboxNotRunning'
  | 'unsupportedTransport'
  | 'credentialsRequired'
  | 'authenticationFailed'
  | 'connectorFailed'
  | 'invalidToolCall'
  | 'toolCallFailed';

type InspectorContext = {
  workspaceId: string;
  deploymentId: string;
  deploymentStatus: string;
  connectedSandboxId?: string;
  sandboxId: string;
  sandboxDeploymentId: string;
  remote?: RemoteSpec;
};

async function inspectorContext(input: {
  workspace: string;
  deploymentId: string;
  sandboxId: string;
}): Promise<{ context?: InspectorContext; error?: McpInspectorError }> {
  if (!input.sandboxId) return { error: 'sandboxRequired' };
  if (!input.workspace || !input.deploymentId) return { error: 'deploymentNotFound' };
  const user = await getCurrentUser();
  if (!user) return { error: 'notAuthorized' };
  const workspace = await getWorkspaceForUser(input.workspace, user.id);
  if (!workspace) return { error: 'notAuthorized' };
  const [deployment, sandbox] = await Promise.all([
    db.deployment.findFirst({
      where: {
        id: input.deploymentId,
        workspaceId: workspace.id,
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
      },
      select: {
        id: true,
        serverId: true,
        name: true,
        source: true,
        sourceRef: true,
        status: true,
        installCfg: true,
        server: { select: { name: true, installCfg: true } },
      },
    }),
    db.sandbox.findFirst({
      where: {
        id: input.sandboxId,
        workspaceId: workspace.id,
        kind: { in: ['docker', 'connector'] },
      },
      select: {
        deploymentId: true,
        network: true,
        deployment: { select: { status: true } },
      },
    }),
  ]);
  if (!deployment) return { error: 'deploymentNotFound' };
  if (deployment.source === 'remote' && missingDeploymentRequiredEnvironment(
    deployment.installCfg,
    deployment.server?.installCfg,
  ).length) return { error: 'credentialsRequired' };
  if (!sandbox) return { error: 'sandboxNotFound' };
  if (sandbox.network === 'none') return { error: 'sandboxNetworkDisabled' };
  if (effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !== 'running') {
    return { error: 'sandboxNotRunning' };
  }
  let remote: RemoteSpec | undefined;
  if (deployment.source === 'remote') {
    const config = deployment.installCfg && typeof deployment.installCfg === 'object'
      && !Array.isArray(deployment.installCfg)
      ? deployment.installCfg as Record<string, unknown>
      : {};
    if (config.transport !== undefined
      && config.transport !== 'streamable-http'
      && config.transport !== 'sse') return { error: 'unsupportedTransport' };
    try {
      const spec = resolveSpawnSpec(deployment);
      if (spec.kind !== 'remote') return { error: 'unsupportedTransport' };
      remote = spec;
    } catch {
      return { error: 'connectorFailed' };
    }
  }
  const connection = readMcpInspectorConnection(deployment.installCfg);
  return {
    context: {
      workspaceId: workspace.id,
      deploymentId: deployment.id,
      deploymentStatus: deployment.status,
      ...(connection ? { connectedSandboxId: connection.sandboxId } : {}),
      sandboxId: input.sandboxId,
      sandboxDeploymentId: sandbox.deploymentId,
      ...(remote ? { remote } : {}),
    },
  };
}

function headerSecrets(remote?: RemoteSpec): string[] {
  return remote ? Object.values(remote.headers).flatMap((value) => {
    const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    return auth ? [value, auth] : [value];
  }) : [];
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret));
  return value !== null && typeof value === 'object'
    ? Object.entries(value).some(([key, entry]) => key.includes(secret) || containsSecret(entry, secret))
    : String(value) === secret;
}

function redactInspectorResult(
  value: Record<string, unknown>,
  secretValues: readonly string[],
): Record<string, unknown> | null {
  const shortSecrets = [...new Set(secretValues.filter((secret) => secret.length > 0 && secret.length < 4))];
  if (shortSecrets.some((secret) => containsSecret(value, secret))) return null;
  const secrets = [...new Set(secretValues.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') {
      return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), candidate);
    }
    if (Array.isArray(candidate)) return candidate.map(redact);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [
        secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), key),
        redact(entry),
      ]));
    }
    return secrets.includes(String(candidate)) ? '[REDACTED]' : candidate;
  };
  return redact(value) as Record<string, unknown>;
}

function inspectorFailure(error: unknown, fallback: McpInspectorError): McpInspectorError {
  return error instanceof SandboxMcpAuthenticationError ? 'authenticationFailed' : fallback;
}

async function persistConnection(context: InspectorContext, value: unknown): Promise<McpToolDefinition[] | null> {
  const catalog = redactMcpToolCatalogResult(value, headerSecrets(context.remote));
  if (!catalog.ok) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await db.deployment.findFirst({
      where: { id: context.deploymentId, workspaceId: context.workspaceId },
      select: { installCfg: true, updatedAt: true },
    });
    if (!current) return null;
    const updated = await db.deployment.updateMany({
      where: { id: context.deploymentId, workspaceId: context.workspaceId, updatedAt: current.updatedAt },
      data: {
        installCfg: withMcpInspectorConnection(
          current.installCfg,
          catalog.tools,
          context.sandboxId,
        ) as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 1) return catalog.tools;
  }
  return null;
}

async function inspectorTools(context: InspectorContext): Promise<McpToolDefinition[] | null> {
  if (context.remote) {
    return listMcpToolsViaSandbox(context.sandboxDeploymentId, context.remote);
  }
  if (effectiveStatus(context.deploymentId, context.deploymentStatus) !== 'running') return null;
  return listMcpTools(context.deploymentId);
}

export async function connectMcpInspectorAction(input: {
  workspace: string;
  deploymentId: string;
  sandboxId: string;
}): Promise<{ tools?: McpToolDefinition[]; error?: McpInspectorError }> {
  const resolved = await inspectorContext(input);
  if (!resolved.context) return { error: resolved.error ?? 'connectorFailed' };
  if (!resolved.context.remote
    && effectiveStatus(resolved.context.deploymentId, resolved.context.deploymentStatus) !== 'running') {
    return { error: 'deploymentNotRunning' };
  }
  let discovered: McpToolDefinition[] | null;
  try {
    discovered = await inspectorTools(resolved.context);
  } catch (error) {
    return { error: inspectorFailure(error, 'connectorFailed') };
  }
  if (!discovered) return { error: 'connectorFailed' };
  const tools = await persistConnection(resolved.context, discovered);
  return tools ? { tools } : { error: 'connectorFailed' };
}

export async function runMcpInspectorToolAction(input: {
  workspace: string;
  deploymentId: string;
  sandboxId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<{ result?: Record<string, unknown>; error?: McpInspectorError }> {
  if (!input.toolName || input.toolName.length > 256 || !input.arguments
    || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    return { error: 'invalidToolCall' };
  }
  let requestBody: string;
  try {
    requestBody = JSON.stringify({ name: input.toolName, arguments: input.arguments });
  } catch {
    return { error: 'invalidToolCall' };
  }
  if (new TextEncoder().encode(requestBody).byteLength > 16_000) return { error: 'invalidToolCall' };

  const resolved = await inspectorContext(input);
  if (!resolved.context) return { error: resolved.error ?? 'connectorFailed' };
  if (resolved.context.connectedSandboxId !== input.sandboxId) return { error: 'sandboxRequired' };
  if (!resolved.context.remote
    && effectiveStatus(resolved.context.deploymentId, resolved.context.deploymentStatus) !== 'running') {
    return { error: 'deploymentNotRunning' };
  }
  let tools: McpToolDefinition[] | null;
  try {
    tools = await inspectorTools(resolved.context);
  } catch (error) {
    return { error: inspectorFailure(error, 'connectorFailed') };
  }
  if (!tools) return { error: 'connectorFailed' };
  if (!tools.some((tool) => tool.name === input.toolName)) return { error: 'invalidToolCall' };

  const startedAt = Date.now();
  let result: Record<string, unknown> | null;
  try {
    result = await (resolved.context.remote
      ? mcpRpcViaSandbox(
          resolved.context.sandboxDeploymentId,
          resolved.context.remote,
          'tools/call',
          { name: input.toolName, arguments: input.arguments },
        )
      : mcpRpc(
          resolved.context.deploymentId,
          'tools/call',
          { name: input.toolName, arguments: input.arguments },
          30_000,
          { maxRequestBytes: 16_000, maxResponseBytes: 1_000_000 },
        ));
  } catch (error) {
    return { error: inspectorFailure(error, 'toolCallFailed') };
  }
  const safeResult = result && redactInspectorResult(result, headerSecrets(resolved.context.remote));
  await logRequest({
    workspaceId: resolved.context.workspaceId,
    deploymentId: resolved.context.deploymentId,
    method: 'POST',
    path: `/mcp/${resolved.context.deploymentId}/inspector/${input.sandboxId}#tools/call:${input.toolName}`,
    statusCode: safeResult ? 200 : 502,
    durationMs: Date.now() - startedAt,
    requestBody,
    responseBody: JSON.stringify(safeResult ?? { error: 'unreachable' }).slice(0, 16_000),
  });
  return safeResult ? { result: safeResult } : { error: 'toolCallFailed' };
}
