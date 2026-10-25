import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { assertMarketReleasesExecutable } from "@/lib/market/revocation";
import { assertRuntimeOwner } from "@/lib/runtime/ownership-state";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import { withMcpInspectorConnection } from "@/lib/workspace/inspector-connection";
import { remoteMcpConnectionIdentity } from "@/lib/remote-mcp/classification";
import {
  mcpDefinitionChecksum,
  mcpRuntimeFilesChecksum,
  prepareSessionMcpDefinition,
} from "./mcp-definition";
import { resolveMcpConnectionSpawnSpec } from "./mcp-credentials";
import { sessionMcpPackageLaunch } from "./mcp-runtime-image";
import { listMcpTools } from "./mcp-client";
import type { McpToolDefinition } from "./mcp-tool-catalog";
import {
  startProcess,
  stopProcess,
  liveMcpRuntimeSnapshot,
  mcpRuntimeCredentialIdentity,
} from "./supervisor";

export type AgentMcpInspectionInput = {
  workspaceId: string;
  agentId: string;
  agentRevisionId: string;
  deploymentId: string;
  userId: string;
};

export type AgentMcpInspectionResult = {
  tools: McpToolDefinition[];
  definitionChecksum: string;
  runtimeFilesChecksum: string;
  sandboxId: string;
  connectedAt: string;
};

type InspectionPin = Pick<
  AgentMcpInspectionResult,
  "definitionChecksum" | "runtimeFilesChecksum" | "sandboxId"
> & {
  credentialEnvelope: string;
};

async function inspectionAuthority(
  tx: Prisma.TransactionClient,
  input: AgentMcpInspectionInput,
) {
  assertRuntimeOwner();
  const user = await tx.user.findFirst({
    where: { id: input.userId, status: "active" },
    select: { role: true },
  });
  const workspace =
    user &&
    (await tx.workspace.findFirst({
      where: {
        id: input.workspaceId,
        status: "active",
        OR: [
          { ownerId: input.userId },
          {
            members: {
              some: { userId: input.userId, role: { in: ["owner", "admin"] } },
            },
          },
          ...(user.role === "admin" ? [{}] : []),
        ],
      },
      select: { id: true },
    }));
  if (!workspace) throw new Error("MCP_CONNECTION_NOT_AUTHORIZED");
  const agent = await tx.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      runtimeKind: "pi-sdk",
      retiredAt: null,
      publicRuntimeAllocation: { is: null },
    },
    select: { currentRevisionVersion: true },
  });
  if (!agent) throw new Error("AGENT_EXECUTION_RETIRED");
  const revision = await tx.agentRevision.findFirst({
    where: {
      id: input.agentRevisionId,
      agentId: input.agentId,
      version: agent.currentRevisionVersion,
    },
    select: { config: true },
  });
  if (!revision) throw new Error("AGENT_REVISION_CONFLICT");
  const config = AgentRevisionConfigSchema.parse(revision.config);
  if (!config.sandboxTemplateId)
    throw new Error("MCP_INSPECTION_SANDBOX_REQUIRED");
  const sandbox = await tx.agentSandbox.findFirst({
    where: {
      agentId: input.agentId,
      sandboxId: config.sandboxTemplateId,
      isDefault: true,
      sandbox: {
        workspaceId: input.workspaceId,
        kind: "docker",
        deployment: {
          status: {
            notIn: [
              "copying",
              "copy_failed",
              "restoring",
              "restore_failed",
              "restore_cleanup_required",
              "upgrading",
              "deleting",
            ],
          },
        },
      },
    },
    select: { sandboxId: true },
  });
  if (!sandbox) throw new Error("MCP_INSPECTION_SANDBOX_REQUIRED");
  const deployment = await tx.deployment.findFirst({
    where: {
      id: input.deploymentId,
      workspaceId: input.workspaceId,
      OR: [{ source: null }, { source: { not: "sandbox" } }],
    },
    include: { marketInstall: { select: { currentReleaseId: true } } },
  });
  if (!deployment) throw new Error("MCP_CONNECTION_NOT_FOUND");
  await assertMarketReleasesExecutable(tx, [
    ...config.packages.map((entry) => entry.releaseId),
    ...(deployment.marketInstall?.currentReleaseId
      ? [deployment.marketInstall.currentReleaseId]
      : []),
  ]);
  const cfg =
    deployment.installCfg &&
    typeof deployment.installCfg === "object" &&
    !Array.isArray(deployment.installCfg)
      ? (deployment.installCfg as Record<string, unknown>)
      : {};
  return {
    deployment,
    sandboxId: sandbox.sandboxId,
    definitionChecksum: mcpDefinitionChecksum(deployment),
    runtimeFilesChecksum: await mcpRuntimeFilesChecksum(tx, input.deploymentId),
    // Compare opaque encrypted identities privately; neither these nor plaintext
    // credential identities are returned in the discovery receipt.
    credentialEnvelope: JSON.stringify(cfg.credentialEnvelope ?? null),
  };
}

function assertInspectionUnchanged(
  expected: InspectionPin,
  actual: InspectionPin,
): void {
  if (actual.definitionChecksum !== expected.definitionChecksum)
    throw new Error("MCP_DEFINITION_CHANGED");
  if (actual.runtimeFilesChecksum !== expected.runtimeFilesChecksum)
    throw new Error("MCP_RUNTIME_FILES_CHANGED");
  if (actual.sandboxId !== expected.sandboxId)
    throw new Error("AGENT_REVISION_CONFLICT");
  if (actual.credentialEnvelope !== expected.credentialEnvelope)
    throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
}

/** Protocol-only evidence for explicit review, never a tool grant or business call. */
export async function inspectAgentMcpConnection(
  input: AgentMcpInspectionInput,
): Promise<AgentMcpInspectionResult> {
  const operation = await runMcpDeploymentOperation(
    input.workspaceId,
    input.deploymentId,
    async () => {
      // No build, secret resolution, or process start may precede these checks.
      const initial = await inspectionAuthority(db, input);
      const prepared = await prepareSessionMcpDefinition(initial.deployment);
      const current = await inspectionAuthority(db, input);
      assertInspectionUnchanged(initial, current);
      if (prepared.definitionChecksum !== current.definitionChecksum)
        throw new Error("MCP_DEFINITION_CHANGED");
      const { spec } = await resolveMcpConnectionSpawnSpec({
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
        expectedDefinitionChecksum: current.definitionChecksum,
      });
      if (spec.kind === "bridge") {
        if (
          spec.command !== "docker" ||
          spec.args[0] !== "run" ||
          !spec.image ||
          !prepared.runtimeImageDigest
        )
          throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
        const index = spec.args.indexOf(spec.image);
        if (index < 0) throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
        spec.args[index] = prepared.runtimeImageDigest;
        spec.image = prepared.runtimeImageDigest;
        const launch = sessionMcpPackageLaunch(current.deployment);
        if (launch)
          spec.args.splice(
            index + 1,
            spec.args.length - index - 1,
            ...launch.args,
          );
      } else if (spec.kind !== "remote")
        throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");

      const processId = `session-mcp-inspection-${randomUUID()}`;
      let tools: McpToolDefinition[] | undefined;
      let failed = false;
      let failure: unknown;
      try {
        await startProcess(processId, spec, {
          workspaceId: input.workspaceId,
          configSourceDeploymentId: input.deploymentId,
          expectedConfigChecksum: current.runtimeFilesChecksum,
        });
        const snapshot = liveMcpRuntimeSnapshot(processId);
        if (
          !snapshot ||
          snapshot.credentialIdentity !== mcpRuntimeCredentialIdentity(spec) ||
          (spec.kind === "remote" &&
            snapshot.remoteConnectionIdentity !==
              remoteMcpConnectionIdentity(spec))
        )
          throw new Error("MCP_CONNECTION_RESTART_REQUIRED");
        tools = await listMcpTools(processId, {
          persistCatalog: false,
          requireValidCatalog: true,
        });
        assertInspectionUnchanged(
          current,
          await inspectionAuthority(db, input),
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await stopProcess(processId);
      } catch (cleanupError) {
        if (failed)
          throw new AggregateError(
            [failure, cleanupError],
            "MCP_INSPECTION_CLEANUP_FAILED",
          );
        throw cleanupError;
      }
      if (failed) throw failure;
      if (!tools) throw new Error("MCP_CATALOG_INVALID");
      const discovered = tools;
      // The server is already stopped. Persist only evidence, under the same
      // Workspace -> Agent -> Deployment lock order used by explicit CAS Apply.
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${input.agentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Deployment" WHERE id=${input.deploymentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
        const live = await inspectionAuthority(tx, input);
        assertInspectionUnchanged(current, live);
        const result: AgentMcpInspectionResult = {
          tools: discovered,
          definitionChecksum: live.definitionChecksum,
          runtimeFilesChecksum: live.runtimeFilesChecksum,
          sandboxId: live.sandboxId,
          connectedAt: new Date().toISOString(),
        };
        await tx.deployment.update({
          where: { id: input.deploymentId },
          data: {
            installCfg: withMcpInspectorConnection(
              live.deployment.installCfg,
              result.tools,
              result.sandboxId,
              {
                definitionChecksum: result.definitionChecksum,
                runtimeFilesChecksum: result.runtimeFilesChecksum,
              },
              result.connectedAt,
            ) as Prisma.InputJsonValue,
          },
        });
        return result;
      });
    },
  );
  if (!operation.accepted) throw new Error("MCP_CONNECTION_NOT_AUTHORIZED");
  return operation.value;
}
