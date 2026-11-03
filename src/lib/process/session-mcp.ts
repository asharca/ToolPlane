import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { assertMarketReleasesExecutable } from "@/lib/pi-packages/revocation";
import { assertAgentEnvironmentCredentialReferences } from "@/lib/agents/environment-credentials";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import { resolveMcpConnectionSpawnSpec } from "./mcp-credentials";
import {
  mcpDefinitionChecksum,
  assertSessionMcpRecipePinned,
  mcpRuntimeFilesChecksum,
  mcpRunsInAgentSandbox,
} from "./mcp-definition";
import {
  startProcess,
  stopProcess,
  liveRedactionValues,
  liveMcpRuntimeSnapshot,
  mcpRuntimeCredentialIdentity,
} from "./supervisor";
import { listMcpTools, mcpRpc } from "./mcp-client";
import { mcpHeaderSecrets, redactMcpResult } from "./mcp-result-redaction";
import {
  sessionMcpPackageLaunch,
  validateSessionMcpRuntimeImage,
} from "./mcp-runtime-image";
import { agentSandboxCompanionArgs } from "./sandbox";
import {
  dockerSandboxRuntimeUser,
  sandboxContainerName,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import { ensureAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";
import { remoteMcpConnectionIdentity } from "@/lib/remote-mcp/classification";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";

export type SessionMcpContext = {
  workspaceId: string;
  agentId: string;
  agentRevisionId: string;
  conversationId?: string;
  a2aContextId?: string;
};

/** Stable across executor recovery, but never shared across execution sessions. */
export function sessionMcpProcessId(
  context: SessionMcpContext,
  deploymentId: string,
  inAgentSandbox = false,
): string {
  if (Boolean(context.conversationId) === Boolean(context.a2aContextId))
    throw new Error("MCP_SESSION_REQUIRED");
  return `session-mcp-${createHash("sha256")
    .update(
      JSON.stringify([
        context.workspaceId,
        context.agentId,
        context.agentRevisionId,
        context.conversationId ?? null,
        context.a2aContextId ?? null,
        deploymentId,
        ...(inAgentSandbox ? ["agent-sandbox"] : []),
      ]),
    )
    .digest("hex")}`;
}

async function authorizeSession(context: SessionMcpContext, stopping = false) {
  assertRuntimeOwner(stopping);
  if (Boolean(context.conversationId) === Boolean(context.a2aContextId))
    throw new Error("MCP_SESSION_REQUIRED");
  const agent = await db.agent.findFirst({
    where: {
      id: context.agentId,
      workspaceId: context.workspaceId,
      ...(stopping
        ? {}
        : {
            retiredAt: null,
            runtimeKind: { in: ["pi-sdk", "omp"] },
            workspace: { status: "active" },
          }),
    },
    select: { id: true, runtimeKind: true },
  });
  if (!agent) throw new Error("MCP_SESSION_FORBIDDEN");
  const where = {
    agentId: context.agentId,
    agentRevisionId: context.agentRevisionId,
    legacyRevisionUnresolved: false,
  };
  const session = context.conversationId
    ? await db.conversation.findFirst({
        where: { ...where, id: context.conversationId },
        select: { id: true },
      })
    : await db.a2AContext.findFirst({
        where: {
          ...where,
          id: context.a2aContextId,
          workspaceId: context.workspaceId,
          ...(stopping ? {} : { expiresAt: { gt: new Date() } }),
        },
        select: { id: true },
      });
  if (!session) throw new Error("MCP_SESSION_FORBIDDEN");
  const revision = await db.agentRevision.findFirst({
    where: { id: context.agentRevisionId, agentId: context.agentId },
    select: { config: true },
  });
  if (!revision) throw new Error("MCP_REVISION_FORBIDDEN");
  const config = AgentRevisionConfigSchema.parse(revision.config);
  if (!stopping && config.runtimeKind !== agent.runtimeKind)
    throw new Error("MCP_REVISION_FORBIDDEN");
  if (!stopping) {
    await assertMarketReleasesExecutable(
      db,
      config.packages.map((entry) => entry.releaseId),
    );
    await assertAgentEnvironmentCredentialReferences(
      db,
      context.workspaceId,
      context.agentId,
      config.environment.credentialReferences,
    );
  }
  return config;
}

async function resolveSessionMcp(
  context: SessionMcpContext,
  deploymentId: string,
  requireToolGrant = true,
  requestedToolName?: string,
) {
  const revision = await authorizeSession(context);
  const grant = revision.mcpGrants.find(
    (entry) => entry.deploymentId === deploymentId,
  );
  if (!grant) throw new Error("MCP_GRANT_REVOKED");
  const binding = await db.agentServer.findUnique({
    where: { agentId_deploymentId: { agentId: context.agentId, deploymentId } },
  });
  const deployment = await db.deployment.findFirst({
    where: { id: deploymentId, workspaceId: context.workspaceId },
  });
  if (!binding || !deployment) throw new Error("MCP_GRANT_REVOKED");
  if (grant.definitionChecksum !== mcpDefinitionChecksum(deployment))
    throw new Error("MCP_DEFINITION_CHANGED");
  if (
    grant.runtimeFilesChecksum !==
    (await mcpRuntimeFilesChecksum(db, deploymentId))
  )
    throw new Error("MCP_RUNTIME_FILES_CHANGED");
  const allowed = new Set(
    grant.allowedToolNames.filter(
      (name) =>
        binding.allowedToolNames.includes(name) &&
        (deployment.mcpToolExposure !== "allowlist" ||
          deployment.mcpAllowedTools.includes(name)),
    ),
  );
  if (
    (requireToolGrant && allowed.size === 0) ||
    (requestedToolName !== undefined && !allowed.has(requestedToolName))
  )
    throw new Error("MCP_TOOL_FORBIDDEN");
  const { spec, redactionValues } = await resolveMcpConnectionSpawnSpec({
    workspaceId: context.workspaceId,
    deploymentId,
    expectedDefinitionChecksum: grant.definitionChecksum,
  });
  if (
    spec.kind !== "remote" &&
    (spec.kind !== "bridge" ||
      spec.command !== "docker" ||
      spec.args[0] !== "run")
  )
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  const inAgentSandbox =
    spec.kind === "bridge" && mcpRunsInAgentSandbox(deployment);
  if (spec.kind === "bridge") {
    assertSessionMcpRecipePinned(deployment);
    if (!grant.runtimeImageDigest)
      throw new Error("MCP_IMMUTABLE_IMAGE_REQUIRED");
    await validateSessionMcpRuntimeImage(
      grant.runtimeImageDigest,
      grant.definitionChecksum,
    );
    const imageIndex = spec.image ? spec.args.indexOf(spec.image) : -1;
    if (imageIndex < 0) throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
    spec.args[imageIndex] = grant.runtimeImageDigest;
    spec.image = grant.runtimeImageDigest;
    const launch = sessionMcpPackageLaunch(deployment);
    if (launch)
      spec.args.splice(
        imageIndex + 1,
        spec.args.length - imageIndex - 1,
        ...launch.args,
      );
    if (inAgentSandbox) {
      // Explicit user opt-in: the Agent sandbox shares this process, its files
      // and its environment (including credentials).
      const sandbox = await ensureAgentConversationSandbox({
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        conversationId: context.conversationId,
        contextId: context.a2aContextId,
      });
      spec.args = agentSandboxCompanionArgs(
        spec.args,
        imageIndex,
        {
          container: sandboxContainerName(sandbox.sandboxId),
          volume: sandboxVolumeName(sandbox.sandboxId),
          user: await dockerSandboxRuntimeUser(sandbox.sandboxId),
        },
        spec.configWorkingDirectory === true,
      );
    }
  }
  const processId =
    spec.kind === "remote"
      ? deploymentId
      : sessionMcpProcessId(context, deploymentId, inAgentSandbox);
  // Placement is a live deployment setting: retire the sidecar from the other
  // placement so a toggle takes effect on the next request.
  const otherPlacement = sessionMcpProcessId(
    context,
    deploymentId,
    !inAgentSandbox,
  );
  if (spec.kind === "bridge" && liveMcpRuntimeSnapshot(otherPlacement))
    await stopProcess(otherPlacement);
  // Only the recipe's explicit environment is delivered. Unless the user opted
  // into Agent-sandbox placement, the spawn builder never adds a work mount.
  await startProcess(processId, spec, {
    workspaceId: context.workspaceId,
    configSourceDeploymentId: deploymentId,
    expectedConfigChecksum: grant.runtimeFilesChecksum,
  });
  // startProcess is idempotent: a surviving process must not keep using rotated
  // or removed secrets under a freshly authorized session request.
  const snapshot = liveMcpRuntimeSnapshot(processId);
  if (snapshot?.credentialIdentity !== mcpRuntimeCredentialIdentity(spec))
    throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
  if (
    spec.kind === "remote" &&
    snapshot?.remoteConnectionIdentity !== remoteMcpConnectionIdentity(spec)
  )
    throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
  return { allowed, processId, spec, redactionValues };
}

async function runSessionMcpOperation<T>(
  context: SessionMcpContext,
  deploymentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await runMcpDeploymentOperation(
    context.workspaceId,
    deploymentId,
    operation,
  );
  if (!result.accepted) throw new Error("MCP_SESSION_FORBIDDEN");
  return result.value;
}

/** Discovery is protocol evidence only; it never invokes any business tool. */
export async function listSessionMcpTools(
  context: SessionMcpContext,
  deploymentId: string,
) {
  return runSessionMcpOperation(context, deploymentId, async () => {
    const runtime = await resolveSessionMcp(context, deploymentId);
    const tools = await listMcpTools(runtime.processId, {
      // A shared remote connection is the deployment itself: keep its catalog
      // current so grant sync can publish the next revision.
      persistCatalog: runtime.processId === deploymentId,
    });
    return tools.filter((tool) => runtime.allowed.has(tool.name));
  });
}

export async function callSessionMcpTool(
  context: SessionMcpContext,
  deploymentId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return runSessionMcpOperation(context, deploymentId, async () => {
    const runtime = await resolveSessionMcp(context, deploymentId, true, name);
    const tools = await listMcpTools(runtime.processId, {
      persistCatalog: false,
    });
    if (!tools.some((tool) => tool.name === name))
      throw new Error("MCP_TOOL_UNAVAILABLE");
    // Recheck the live grant after discovery, immediately before the side effect.
    const fresh = await resolveSessionMcp(context, deploymentId, true, name);
    const result = await mcpRpc(fresh.processId, "tools/call", {
      name,
      arguments: args,
    });
    if (!result) throw new Error("MCP_TOOL_EXECUTION_UNKNOWN");
    const redacted = redactMcpResult(result, [
      ...fresh.redactionValues,
      ...(liveRedactionValues(fresh.processId) ?? []),
      ...(fresh.spec.kind === "remote"
        ? mcpHeaderSecrets(fresh.spec.headers)
        : Object.values(fresh.spec.env)),
    ]);
    if (!redacted) throw new Error("MCP_RESULT_REDACTION_REQUIRED");
    return redacted;
  });
}

/** Explicit composer reads only; this is not an arbitrary JSON-RPC gateway. */
export async function sessionMcpRequest(
  context: SessionMcpContext,
  deploymentId: string,
  method: string,
  params?: Record<string, unknown>,
) {
  if (
    ![
      "prompts/list",
      "prompts/get",
      "resources/list",
      "resources/templates/list",
      "resources/read",
    ].includes(method)
  )
    throw new Error("MCP_METHOD_FORBIDDEN");
  return runSessionMcpOperation(context, deploymentId, async () => {
    const runtime = await resolveSessionMcp(context, deploymentId, false);
    const result = await mcpRpc(runtime.processId, method, params);
    if (!result) throw new Error("MCP_RESOURCE_UNAVAILABLE");
    const redacted = redactMcpResult(result, [
      ...runtime.redactionValues,
      ...(liveRedactionValues(runtime.processId) ?? []),
      ...(runtime.spec.kind === "remote"
        ? mcpHeaderSecrets(runtime.spec.headers)
        : Object.values(runtime.spec.env)),
    ]);
    if (!redacted) throw new Error("MCP_RESULT_REDACTION_REQUIRED");
    return redacted;
  });
}

/** Stop sidecars only. Session work volumes and user files remain untouched. */
export async function stopSessionMcp(
  context: SessionMcpContext,
): Promise<void> {
  const revision = await authorizeSession(context, true);
  await Promise.all(
    revision.mcpGrants.flatMap((grant) =>
      [false, true].map((inAgentSandbox) =>
        stopProcess(
          sessionMcpProcessId(context, grant.deploymentId, inAgentSandbox),
        ),
      ),
    ),
  );
}
