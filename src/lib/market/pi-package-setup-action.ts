"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  setDeploymentEnvAction,
  startDeploymentAction,
  updateMcpJsonConfigAction,
} from "@/lib/workspace/actions";
import { connectMcpInspectorAction } from "@/lib/workspace/inspector-actions";
import { missingDeploymentRequiredEnvironment } from "@/lib/workspace/server-recipe";
import { effectiveStatus } from "@/lib/process/supervisor";
import { resolveMcpEnvironment } from "@/lib/process/mcp-credentials";
import {
  installMarketRelease,
  installPiPackageRelease,
  updateMarketInstall,
} from "./resources";
import { MarketError } from "./skills";
import {
  parsePiPackageReleaseManifest,
  scanPiPackageReleaseManifest,
} from "./pi-package-manifest";
import type { PiPackageMcpBindings } from "./pi-package-assembly";
import { AgentConfigurationError } from "@/lib/agents/mutations";
import type { ReviewedAgentMcpConnection } from "@/lib/agents/mutations";
import {
  AgentRevisionError,
  pinCurrentAgentRevision,
} from "@/lib/agents/revisions";
import { prepareSessionMcpDefinition } from "@/lib/process/mcp-definition";
import { applyPiPackageToAgent } from "./pi-package-agent-apply";
import {
  withAgentMaintenanceLease,
  AgentExecutionBusyError,
} from "@/lib/agents/agent-execution-gate";

export type PiPackageSetupState = {
  status?: "partial" | "complete";
  step?: "input" | "mcp" | "package" | "agent" | "complete";
  error?: string;
  deployments?: Array<{
    key: string;
    deploymentId: string;
    status: "installed" | "configured" | "running" | "tested";
  }>;
  marketInstallId?: string;
  agentId?: string;
  enabled?: boolean;
  agentRevisionId?: string;
};

const environmentKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const choicesSchema = z
  .array(
    z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
        deploymentId: z.string().min(1).max(128).optional(),
        releaseId: z.string().min(1).max(128).optional(),
        config: z.string().min(1).max(128_000).optional(),
        changes: z
          .object({
            set: z
              .record(
                environmentKey,
                z
                  .string()
                  .max(16_000)
                  .refine((value) => !value.includes("\0")),
              )
              .default({}),
            remove: z.array(environmentKey).max(100).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (choice) => Boolean(choice.deploymentId) !== Boolean(choice.releaseId),
      ),
  )
  .max(64);

function deploymentForm(workspace: string, deploymentId: string) {
  const form = new FormData();
  form.set("workspace", workspace);
  form.set("deploymentId", deploymentId);
  return form;
}
class PiPackageSetupError extends Error {}

function setupError(code: string): never {
  throw new PiPackageSetupError(code);
}

/** External MCP changes are deliberately not rolled back; report each completed step. */
export async function configurePiPackageAction(
  _previous: PiPackageSetupState,
  formData: FormData,
): Promise<PiPackageSetupState> {
  const workspaceSlug = String(formData.get("workspace") ?? "");
  const releaseId = String(formData.get("releaseId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const key = String(formData.get("idempotencyKey") ?? "");
  const expectedRevisionId = String(formData.get("expectedRevisionId") ?? "");
  const state: PiPackageSetupState = {
    step: "input",
    deployments: [],
    enabled: false,
  };
  const user = await getCurrentUser();
  const workspace = user
    ? await getWorkspaceForUser(workspaceSlug, user.id)
    : null;
  if (!user || !workspace) return { ...state, error: "not_authorized" };
  if (formData.get("confirmExecutableCode") !== "yes")
    return { ...state, error: "pi_package_executable_confirmation_required" };
  if (!releaseId || !key || key.length > 100)
    return { ...state, error: "invalid_request" };
  try {
    const rawChoices = String(formData.get("mcps") ?? "[]");
    if (rawChoices.length > 1_000_000) setupError("invalid_request");
    const parsedChoices = choicesSchema.safeParse(JSON.parse(rawChoices));
    if (!parsedChoices.success) setupError("pi_package_invalid_bindings");
    const choices = parsedChoices.data;
    const release = await db.marketRelease.findFirst({
      where: {
        id: releaseId,
        reviewStatus: "approved",
        listing: {
          kind: "pi-package",
          status: "published",
          OR: [
            { visibility: "public" },
            { publisherWorkspaceId: workspace.id },
          ],
        },
      },
    });
    if (!release) setupError("listing_unavailable");
    const manifest = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    if (
      scanPiPackageReleaseManifest(manifest, release.releaseNotes).status ===
      "blocked"
    )
      setupError("invalid_manifest");
    const requirements = manifest.package.toolplane?.mcp ?? [];
    if (
      requirements.length &&
      formData.get("confirmExpandedPrivileges") !== "yes"
    )
      setupError("pi_package_privileges_confirmation_required");
    if (
      choices.length !== requirements.length ||
      new Set(choices.map((choice) => choice.key)).size !== choices.length ||
      choices.some(
        (choice) =>
          !requirements.some((requirement) => requirement.key === choice.key),
      )
    )
      setupError("pi_package_invalid_bindings");
    const selectedAgent = agentId
      ? await db.agent.findFirst({
          where: {
            id: agentId,
            workspaceId: workspace.id,
            runtimeKind: "pi-sdk",
            retiredAt: null,
            publicRuntimeAllocation: null,
          },
          select: {
            id: true,
            currentRevisionVersion: true,
            sandboxes: { select: { sandboxId: true } },
          },
        })
      : null;
    if (agentId && !selectedAgent) setupError("agent_not_found");
    if (selectedAgent && !selectedAgent.currentRevisionVersion)
      setupError("agent_revision_preparation_required");
    const applied = selectedAgent
      ? await pinCurrentAgentRevision(db, selectedAgent.id)
      : null;
    if (applied && applied.id !== expectedRevisionId)
      setupError("agent_revision_conflict");
    if (selectedAgent && formData.get("confirmApplyToAgent") !== "yes")
      setupError("agent_revision_apply_confirmation_required");
    const sandboxId =
      String(formData.get("sandboxId") ?? "") ||
      (selectedAgent?.sandboxes.length === 1
        ? selectedAgent.sandboxes[0].sandboxId
        : "");
    if (requirements.length) {
      if (applied && sandboxId !== applied.config.sandboxTemplateId)
        setupError("sandboxRequired");
      if (
        !sandboxId ||
        (selectedAgent &&
          !selectedAgent.sandboxes.some(
            (entry) => entry.sandboxId === sandboxId,
          ))
      )
        setupError("sandboxRequired");
      if (
        !(await db.sandbox.findFirst({
          where: {
            id: sandboxId,
            workspaceId: workspace.id,
            kind: { in: ["docker", "connector"] },
          },
          select: { id: true },
        }))
      )
        setupError("sandboxNotFound");
    }
    const bindings: PiPackageMcpBindings = {};
    state.step = "mcp";
    for (const requirement of requirements) {
      const choice = choices.find((entry) => entry.key === requirement.key);
      if (!choice) setupError("pi_package_invalid_bindings");
      let deploymentId = choice.deploymentId;
      if (deploymentId && (choice.config || choice.changes))
        setupError("shared_connection_configuration_required");
      if (choice.releaseId) {
        const candidate = await db.marketRelease.findFirst({
          where: { id: choice.releaseId, listing: { kind: "mcp" } },
          select: { id: true },
        });
        if (!candidate) setupError("deploymentNotFound");
        const installed = await installMarketRelease({
          releaseId: candidate.id,
          targetWorkspaceId: workspace.id,
          installedById: user.id,
          idempotencyKey: `${key}:mcp:${requirement.key}`,
        });
        if (installed.kind !== "mcp") setupError("deploymentNotFound");
        deploymentId = installed.resource.id;
        state.deployments?.push({
          key: requirement.key,
          deploymentId,
          status: "installed",
        });
        if (choice.config || choice.changes) {
          const ownOperation =
            installed.install.installedById === user.id &&
            installed.install.targetWorkspaceId === workspace.id &&
            installed.install.idempotencyKey ===
              `${key}:mcp:${requirement.key}` &&
            installed.install.requestedReleaseId === choice.releaseId &&
            installed.install.currentReleaseId === choice.releaseId;
          if (!ownOperation)
            setupError("shared_connection_configuration_required");
          const [sharing] = await db.$queryRaw<Array<{ shared: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM "AgentServer" WHERE "deploymentId"=${installed.resource.id}
              UNION ALL SELECT 1 FROM "ChatAssistantMcpGrant" WHERE "deploymentId"=${installed.resource.id}
              UNION ALL SELECT 1 FROM "ToolkitServer" WHERE "deploymentId"=${installed.resource.id}
              UNION ALL SELECT 1 FROM "PiPackageClientInstallation" client,
                jsonb_each(CASE WHEN jsonb_typeof(client.bindings)='object' THEN client.bindings ELSE '{}'::jsonb END) binding
                WHERE client."workspaceId"=${workspace.id} AND client.status='active'
                  AND binding.value->>'deploymentId'=${installed.resource.id}
              UNION ALL SELECT 1 FROM "MarketInstall" package,
                jsonb_each(CASE WHEN jsonb_typeof(package."resourceMap"->'mcpBindings')='object'
                  THEN package."resourceMap"->'mcpBindings' ELSE '{}'::jsonb END) binding
                WHERE package."targetWorkspaceId"=${workspace.id} AND package."idempotencyKey"<>${key}
                  AND package.status IN ('ready','setup_required')
                  AND binding.value->>'deploymentId'=${installed.resource.id}
            ) AS shared`;
          if (!sharing || sharing.shared)
            setupError("shared_connection_configuration_required");
        }
      }
      if (!deploymentId) setupError("deploymentNotFound");
      let deployment = await db.deployment.findFirst({
        where: {
          id: deploymentId,
          workspaceId: workspace.id,
          OR: [{ source: null }, { source: { not: "sandbox" } }],
        },
        include: { server: { select: { installCfg: true } } },
      });
      if (!deployment) setupError("deploymentNotFound");
      let currentProgress = state.deployments?.find(
        (entry) => entry.key === requirement.key,
      );
      if (!currentProgress) {
        currentProgress = {
          key: requirement.key,
          deploymentId,
          status: "installed",
        };
        state.deployments?.push(currentProgress);
      }
      const form = deploymentForm(workspaceSlug, deploymentId);
      if (choice.config) {
        form.set("config", choice.config);
        const result = await updateMcpJsonConfigAction({}, form);
        if (result.error) setupError(result.error);
      }
      if (choice.changes) {
        form.set("changes", JSON.stringify(choice.changes));
        const result = await setDeploymentEnvAction(form);
        if (result?.error) setupError(result.error);
      }
      deployment = await db.deployment.findFirst({
        where: { id: deploymentId, workspaceId: workspace.id },
        include: { server: { select: { installCfg: true } } },
      });
      if (!deployment) setupError("deploymentNotFound");
      if (choice.changes) {
        const stored = resolveMcpEnvironment(
          deployment.installCfg,
          workspace.id,
        );
        if (
          Object.entries(choice.changes.set).some(
            ([name, value]) => stored[name] !== value,
          ) ||
          choice.changes.remove.some((name) => name in stored)
        )
          setupError("configuration_not_saved");
      }
      if (currentProgress) currentProgress.status = "configured";
      if (
        missingDeploymentRequiredEnvironment(
          deployment.installCfg,
          deployment.server?.installCfg,
        ).length
      )
        setupError("credentialsRequired");
      if (effectiveStatus(deployment.id, deployment.status) !== "running")
        await startDeploymentAction(form);
      const started = await db.deployment.findFirst({
        where: { id: deploymentId, workspaceId: workspace.id },
        select: { status: true },
      });
      if (
        !started ||
        effectiveStatus(deploymentId, started.status) !== "running"
      )
        setupError("connectorFailed");
      if (currentProgress) currentProgress.status = "running";
      const tested = await connectMcpInspectorAction({
        workspace: workspaceSlug,
        deploymentId,
        sandboxId,
      });
      if (tested.error || !tested.tools)
        setupError(tested.error ?? "connectorFailed");
      if (
        requirement.tools.some(
          (name) => !tested.tools?.some((tool) => tool.name === name),
        )
      )
        setupError("pi_package_invalid_bindings");
      if (currentProgress) currentProgress.status = "tested";
      bindings[requirement.key] = { deploymentId, tools: requirement.tools };
    }
    state.step = "package";
    const existing = await db.marketInstall.findUnique({
      where: {
        targetWorkspaceId_listingId: {
          targetWorkspaceId: workspace.id,
          listingId: release.listingId,
        },
      },
    });
    if (existing?.status === "ready") {
      state.marketInstallId = existing.id;
      await updateMarketInstall({
        installId: existing.id,
        targetWorkspaceId: workspace.id,
        actorId: user.id,
        targetReleaseId: release.id,
        currentReleaseId: existing.currentReleaseId,
        ...(requirements.length ? { mcpBindings: bindings } : {}),
      });
    } else {
      const installed = await installPiPackageRelease({
        releaseId: release.id,
        targetWorkspaceId: workspace.id,
        installedById: user.id,
        idempotencyKey: key,
        mcpBindings: bindings,
      });
      state.marketInstallId = installed.install.id;
    }
    if (agentId) {
      state.step = "agent";
      const toolsByDeployment = new Map<string, Set<string>>();
      for (const binding of Object.values(bindings)) {
        const tools =
          toolsByDeployment.get(binding.deploymentId) ?? new Set<string>();
        for (const tool of binding.tools) tools.add(tool);
        toolsByDeployment.set(binding.deploymentId, tools);
      }
      const connections: ReviewedAgentMcpConnection[] = [];
      for (const [deploymentId, tools] of toolsByDeployment) {
        const deployment = await db.deployment.findFirst({
          where: { id: deploymentId, workspaceId: workspace.id },
        });
        if (!deployment) setupError("deploymentNotFound");
        connections.push({
          deploymentId,
          allowedToolNames: [...tools],
          prepared: await prepareSessionMcpDefinition(deployment),
        });
      }
      const revision = await withAgentMaintenanceLease(agentId, async () => {
        if (!(await getWorkspaceForUser(workspaceSlug, user.id)))
          setupError("not_authorized");
        const marketInstallId = state.marketInstallId;
        if (!marketInstallId) setupError("install_not_found");
        return applyPiPackageToAgent({
          workspaceId: workspace.id,
          userId: user.id,
          agentId,
          expectedRevisionId,
          package: {
            marketInstallId,
            releaseId: release.id,
            integrity: release.checksum,
          },
          connections,
        });
      });
      state.agentId = agentId;
      state.agentRevisionId = revision.id;
      state.enabled = true;
    }
    return { ...state, status: "complete", step: "complete" };
  } catch (error) {
    const code =
      error instanceof PiPackageSetupError
        ? error.message
        : error instanceof MarketError
          ? error.code
          : error instanceof AgentRevisionError
            ? error.code === "AGENT_REVISION_CONFLICT"
              ? "agent_revision_conflict"
              : error.code === "PI_PACKAGE_UNAVAILABLE"
                ? "listing_unavailable"
                : error.code
            : error instanceof AgentExecutionBusyError
              ? "pi_package_agent_busy"
              : error instanceof AgentConfigurationError
                ? error.message === "pi_package_agent_busy"
                  ? "pi_package_agent_busy"
                  : "pi_package_unavailable"
                : "setup_failed";
    return {
      ...state,
      ...(state.marketInstallId || state.deployments?.length
        ? { status: "partial" as const }
        : {}),
      error: code,
    };
  } finally {
    revalidatePath(`/app/${workspaceSlug}/market/installed`);
    if (agentId) revalidatePath(`/app/${workspaceSlug}/agents/${agentId}`);
  }
}
