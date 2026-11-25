"use server";
import { workspaceScopeWhere } from "@/lib/workspace/scope";
import { actionScope } from "@/lib/workspace/action-scope";
import { ToolApprovalPolicySchema } from "./tool-approval-policy";
import { z } from "zod";
import type {
  AgentConfig,
  ExternalSandboxSelection,
} from "@/lib/agents/agent-draft-mutations";
import {
  EXTERNAL_SANDBOX_ACCESS,
  MAX_EXTERNAL_SANDBOXES,
} from "@/lib/sandboxes/external";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getProvider } from "@/lib/agents/queries";
import {
  AgentExecutionBusyError,
  withAgentDraftLease,
} from "@/lib/agents/agent-execution-gate";
import { cloneAgent, createConfiguredAgent } from "@/lib/agents/mutations";
import { AgentConfigurationError } from "@/lib/agents/agent-mutation-guards";
import {
  updateAgent,
  setAgentTools,
  updateAgentModelSelection,
} from "@/lib/agents/agent-draft-mutations";
import {
  AGENT_MCP_TOOL_TIMEOUT_BOUNDS,
  AGENT_STEP_BOUNDS,
  AGENT_TASK_TIMEOUT_BOUNDS,
  REASONING_LEVELS,
} from "@/lib/agents/constants";
import { desktopSandboxImage } from "@/lib/sandboxes/desktop";
import { approveAgentPluginSync } from "@/lib/plugins/agent-sync";
import { safeRelativePath } from "@/lib/auth/safe-redirect";
import { db } from "@/lib/db";
import { McpPinningError } from "@/lib/process/mcp-pinning";
import { McpRecipePinError } from "@/lib/process/mcp-definition";
import { deleteManagedAgent } from "@/lib/agents/deletion";
import {
  AgentAdvisorSchema,
  AgentEnvironmentSnapshotSchema,
  OptionalBuiltinToolsSchema,
} from "./revision-types";
import {
  captureAgentRevisionConfig,
  prepareAgentRevisionMcpDeployments,
  publishAgentRevision,
  AgentRevisionError,
} from "./revisions";
import {
  prepareAgentResourceReview,
  applyAgentResourceReview,
} from "./resource-apply";
import type { AgentResourceReview } from "./resource-apply";
import type { ActionState } from "./action-state";
import { isManageableAgent } from "./action-access";

const resourceReviewPublicErrors: Record<string, true> = {
  resourceChanged: true,
  reviewRequired: true,
  reviewExpired: true,
  revisionPreparationRequired: true,
  mcpVersionResolutionFailed: true,
  pi_packages_invalid: true,
  PI_CAPABILITY_CONFLICT: true,
  PI_EXTENSION_LOAD_FAILED: true,
  PI_CAPABILITY_PREFLIGHT_FAILED: true,
  PI_CAPABILITY_PREFLIGHT_TIMEOUT: true,
  MCP_CONNECTION_NOT_AUTHORIZED: true,
  AGENT_EXECUTION_RETIRED: true,
  AGENT_REVISION_CONFLICT: true,
  MCP_INSPECTION_SANDBOX_REQUIRED: true,
  MCP_CONNECTION_NOT_FOUND: true,
  MCP_DEFINITION_CHANGED: true,
  MCP_RUNTIME_FILES_CHANGED: true,
  MCP_CONNECTION_RESTART_REQUIRED: true,
  MCP_CATALOG_INVALID: true,
  MCP_INSPECTION_CLEANUP_FAILED: true,
  MCP_CREDENTIAL_REQUIRED: true,
  MCP_REAUTH_REQUIRED: true,
  MCP_CREDENTIAL_INVALID: true,
  MCP_CREDENTIAL_SCOPE_INVALID: true,
  MCP_CREDENTIAL_MIGRATION_REQUIRED: true,
  PI_PACKAGE_ENV_INCOMPLETE: true,
  PI_PACKAGE_ENV_CONFLICT: true,
};

function resourceReviewError(error: unknown) {
  if (error instanceof AgentExecutionBusyError) return "resource_binding_busy";
  if (
    error instanceof AgentRevisionError &&
    error.code === "AGENT_REVISION_UNRESOLVED"
  )
    return "revisionPreparationRequired";
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    resourceReviewPublicErrors[error.code] === true
  )
    return error.code;
  if (
    error instanceof Error &&
    resourceReviewPublicErrors[error.message] === true
  )
    return error.message;
  return "resource_binding_unavailable";
}

function agentMaxSteps(formData: FormData): number {
  const value = Number(formData.get("maxSteps") ?? AGENT_STEP_BOUNDS.default);
  return Number.isFinite(value)
    ? Math.min(
        AGENT_STEP_BOUNDS.max,
        Math.max(AGENT_STEP_BOUNDS.min, Math.trunc(value)),
      )
    : AGENT_STEP_BOUNDS.default;
}

function agentAdvisor(formData: FormData) {
  const value = formData.get("advisor");
  if (value === null) return undefined;
  if (value === "" || value === "null") return null;
  try {
    return AgentAdvisorSchema.parse(JSON.parse(String(value)));
  } catch {
    throw new AgentConfigurationError("AGENT_ADVISOR_INVALID");
  }
}

function agentReasoningEffort(formData: FormData) {
  const value = formData.get("reasoningEffort") ?? "";
  if (value === "" || value === "default") return null;
  const parsed = z.enum(REASONING_LEVELS).safeParse(value);
  if (!parsed.success)
    throw new AgentConfigurationError("Invalid reasoning effort.");
  return parsed.data;
}

function agentContextFiles(formData: FormData): boolean | undefined {
  const value = formData.get("contextFiles");
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AgentConfigurationError("Invalid context files setting.");
}

function agentSecretObfuscation(formData: FormData): boolean | undefined {
  if (!formData.has("secretObfuscation")) return undefined;
  const value = z
    .enum(["true", "false"])
    .safeParse(formData.get("secretObfuscation"));
  if (!value.success)
    throw new AgentConfigurationError("Invalid secret obfuscation setting.");
  return value.data === "true";
}

/** Absent: unchanged; "": system default; otherwise whole seconds within bounds. */
function agentTaskTimeoutSeconds(
  formData: FormData,
): number | null | undefined {
  if (!formData.has("taskTimeoutSeconds")) return undefined;
  const value = String(formData.get("taskTimeoutSeconds")).trim();
  if (!value) return null;
  const parsed = z.coerce
    .number()
    .int()
    .min(AGENT_TASK_TIMEOUT_BOUNDS.min)
    .max(AGENT_TASK_TIMEOUT_BOUNDS.max)
    .safeParse(value);
  if (!parsed.success)
    throw new AgentConfigurationError("Invalid task time limit.");
  return parsed.data;
}

function parseMcpToolTimeoutSeconds(value: FormDataEntryValue | null) {
  if (value === null || (typeof value === "string" && !value.trim()))
    return null;
  const parsed = z.coerce
    .number()
    .int()
    .min(AGENT_MCP_TOOL_TIMEOUT_BOUNDS.min)
    .max(AGENT_MCP_TOOL_TIMEOUT_BOUNDS.max)
    .safeParse(value);
  if (!parsed.success)
    throw new AgentConfigurationError("Invalid MCP tool time limit.");
  return parsed.data;
}

const piPackagesFormSchema = z
  .array(
    z
      .object({
        marketInstallId: z.string().min(1).max(200),
        releaseId: z.string().min(1).max(200),
      })
      .strict(),
  )
  .max(16)
  .refine(
    (packages) =>
      new Set(packages.map((pkg) => pkg.marketInstallId)).size ===
      packages.length,
  );

function piPackagesFromForm(formData: FormData): AgentConfig["piPackages"] {
  if (!formData.has("piPackages")) return undefined;
  const raw = formData.get("piPackages");
  if (typeof raw !== "string" || raw.length > 16_000)
    throw new AgentConfigurationError("pi_packages_invalid");
  try {
    return piPackagesFormSchema.parse(JSON.parse(raw));
  } catch {
    throw new AgentConfigurationError("pi_packages_invalid");
  }
}

function optionalBuiltinToolsFromForm(
  formData: FormData,
): AgentConfig["optionalBuiltinTools"] {
  if (!formData.has("optionalBuiltinTools")) return undefined;
  const raw = formData.get("optionalBuiltinTools");
  try {
    if (typeof raw !== "string" || raw.length > 16_000) throw new Error();
    return OptionalBuiltinToolsSchema.parse(JSON.parse(raw));
  } catch {
    throw new AgentConfigurationError("OPTIONAL_BUILTIN_TOOLS_INVALID");
  }
}

const externalSandboxesFormSchema = z
  .array(
    z
      .object({
        sandboxId: z.string().min(1).max(240),
        access: z.enum(EXTERNAL_SANDBOX_ACCESS),
      })
      .strict(),
  )
  .max(MAX_EXTERNAL_SANDBOXES);

function externalSandboxesFromForm(
  formData: FormData,
): ExternalSandboxSelection[] | undefined {
  const raw = formData.get("externalSandboxes");
  if (raw === null) return undefined;
  try {
    if (typeof raw !== "string" || raw.length > 16_000) throw new Error();
    return externalSandboxesFormSchema.parse(JSON.parse(raw));
  } catch {
    throw new AgentConfigurationError("Invalid external sandbox selection.");
  }
}

function cloneOptionsFromFormData(formData: FormData) {
  const checked = (name: string) => formData.get(name) === "on";
  return {
    copyMcp: checked("copyMcp"),
    copySkills: checked("copySkills"),
    copyPiPackages: checked("copyPiPackages"),
    copyConversations: checked("copyConversations"),
  };
}

export async function createAgentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "").trim() || "New agent";
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "resource_binding_unavailable" };
  let agentId: string;
  try {
    const rawRuntime = formData.get("runtime");
    if (rawRuntime && rawRuntime !== "pi-sdk")
      throw new Error("Only native Pi Agents are available for creation.");
    const runtime = "pi-sdk";
    const providerId = String(formData.get("providerId") ?? "").trim() || null;
    const model = String(formData.get("model") ?? "") || null;
    const provider = providerId
      ? await getProvider(ctx.ws.id, providerId)
      : null;
    if (!provider || !model || !provider.models.includes(model)) {
      throw new Error("Choose an available model.");
    }
    const agent = await createConfiguredAgent(
      ctx.ws.id,
      {
        name,
        description:
          String(formData.get("description") ?? "")
            .trim()
            .slice(0, 500) || null,
        systemPrompt:
          String(formData.get("systemPrompt") ?? "")
            .trim()
            .slice(0, 100_000) || null,
        providerId,
        model,
        disabledBuiltinTools: formData
          .getAll("disabledBuiltinTool")
          .map(String),
        optionalBuiltinTools: optionalBuiltinToolsFromForm(formData) ?? [],
        maxSteps: agentMaxSteps(formData),
        reasoningEffort: agentReasoningEffort(formData),
        contextFiles: agentContextFiles(formData) ?? true,
        toolApproval: formData.has("toolApproval")
          ? ToolApprovalPolicySchema.parse(
              JSON.parse(String(formData.get("toolApproval"))),
            )
          : undefined,
        secretObfuscation: agentSecretObfuscation(formData),
        taskTimeoutSeconds: agentTaskTimeoutSeconds(formData),
        advisor: agentAdvisor(formData),
        piPackages: piPackagesFromForm(formData),
      },
      {
        deploymentIds: formData.getAll("deploymentId").map(String),
        installedSkillIds: formData.getAll("installedSkillId").map(String),
        toolkitIds: formData.getAll("toolkitId").map(String),
      },
      {
        runtime,
        enable: true,
        ...(formData.get("desktop") === "on"
          ? { sandboxImage: desktopSandboxImage() }
          : {}),
      },
    );
    agentId = agent.id;
  } catch (error) {
    return { error: resourceReviewError(error) };
  }
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  redirect(
    `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(agentId)}`,
  );
}

export async function deleteAgentAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;
  if (
    !(await deleteManagedAgent({
      workspaceId: ctx.ws.id,
      agentId,
      actorId: ctx.user.id,
    }))
  )
    return;
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(`/app/${slug}/sandboxes`);
  redirect(safeRelativePath(formData.get("returnTo")) ?? `/app/${slug}/agents`);
}

export async function pinAgentAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const value = formData.get("pinned");
  if (!agentId || (value !== "true" && value !== "false")) return;
  const ctx = await actionScope({ slug });
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId))) return;
  const updated = await db.agent.updateMany({
    where: { id: agentId, workspaceId: ctx.ws.id },
    data: { pinned: value === "true" },
  });
  if (updated.count !== 1) return;
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(`/app/${slug}/work`);
}

export async function cloneAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const sourceAgentId = String(formData.get("agentId") ?? "");
  const requestedName =
    String(formData.get("cloneName") ?? "")
      .trim()
      .slice(0, 60) || undefined;
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  if (!sourceAgentId || !(await isManageableAgent(ctx.ws.id, sourceAgentId)))
    return { error: "Agent not found." };

  let cloned: Awaited<ReturnType<typeof cloneAgent>>;
  try {
    cloned = await cloneAgent(
      ctx.ws.id,
      sourceAgentId,
      requestedName,
      cloneOptionsFromFormData(formData),
    );
  } catch (error) {
    if (error instanceof McpPinningError) return { error: error.code };
    if (error instanceof AgentConfigurationError)
      return { error: resourceReviewError(error) };
    throw error;
  }
  if (!cloned) return { error: "Agent not found." };
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(`/app/${slug}/agents/${cloned.id}`);
  redirect(
    `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(cloned.id)}`,
  );
}

export async function approveAgentPluginSyncAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const installId = String(formData.get("installId") ?? "");
  const targetReleaseId = String(formData.get("targetReleaseId") ?? "");
  const ctx = await actionScope({ slug, capability: "plugins" });
  if (
    !ctx ||
    !agentId ||
    !installId ||
    !targetReleaseId ||
    !(await isManageableAgent(ctx.ws.id, agentId))
  )
    throw new Error("Not authorized.");
  const binding = await approveAgentPluginSync(
    ctx.ws,
    agentId,
    installId,
    targetReleaseId,
  );
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/plugins`);
  revalidatePath(`/app/${slug}/work`);
  return { syncStatus: binding.syncStatus, syncError: binding.syncError };
}

export type ResourceEnableState = Partial<AgentResourceReview> & {
  error?: string;
  enabled?: boolean;
  bound?: boolean;
  revisionId?: string;
};

export async function previewAgentResourceAction(
  _previous: ResourceEnableState,
  formData: FormData,
): Promise<ResourceEnableState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  const resourceKind = formData.get("resourceKind");
  const ctx = await actionScope({ slug });
  if (
    !ctx ||
    !agentId ||
    !resourceId ||
    resourceKind !== "skill" ||
    !(await isManageableAgent(ctx.ws.id, agentId))
  )
    return { error: "resource_binding_unavailable" };
  try {
    return await prepareAgentResourceReview({
      workspaceId: ctx.ws.id,
      userId: ctx.user.id,
      agentId,
      resourceId,
      resourceKind,
    });
  } catch (error) {
    return { error: resourceReviewError(error) };
  }
}

export async function enableAgentResourceAction(
  _previous: ResourceEnableState,
  formData: FormData,
): Promise<ResourceEnableState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  const resourceKind = formData.get("resourceKind");
  const ctx = await actionScope({ slug });
  if (
    !ctx ||
    !agentId ||
    !resourceId ||
    resourceKind !== "skill" ||
    !(await isManageableAgent(ctx.ws.id, agentId))
  )
    return { error: "resource_binding_unavailable" };
  if (formData.get("confirm") !== "yes")
    return { error: "resource_binding_consent" };
  const expectedRevisionId = String(formData.get("expectedRevisionId") ?? "");
  const reviewReceipt = String(formData.get("reviewReceipt") ?? "");
  if (!expectedRevisionId || !reviewReceipt) return { error: "reviewRequired" };
  try {
    const revision = await applyAgentResourceReview({
      workspaceId: ctx.ws.id,
      userId: ctx.user.id,
      agentId,
      resourceId,
      resourceKind,
      expectedRevisionId,
      reviewReceipt,
    });
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    revalidatePath(`/app/${slug}/skills/${resourceId}`);
    revalidatePath(`/app/${slug}/work`);
    return { bound: true, enabled: true, agentId, revisionId: revision.id };
  } catch (error) {
    return {
      error:
        error instanceof SyntaxError
          ? "reviewRequired"
          : resourceReviewError(error),
    };
  }
}

export async function updateAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };

  const providerId = String(formData.get("providerId") ?? "").trim() || null;
  const model = String(formData.get("model") ?? "") || null;
  const maxSteps = agentMaxSteps(formData);

  try {
    const mcpToolTimeoutSeconds = formData.has("mcpToolTimeoutSeconds")
      ? parseMcpToolTimeoutSeconds(formData.get("mcpToolTimeoutSeconds"))
      : undefined;
    const deploymentIds = formData.getAll("deploymentId").map(String);
    const mcpToolTimeouts = new Map<string, number | null>();
    for (const deploymentId of deploymentIds) {
      mcpToolTimeouts.set(
        deploymentId,
        parseMcpToolTimeoutSeconds(
          formData.get(`mcpToolTimeoutSeconds:${deploymentId}`),
        ),
      );
    }
    await withAgentDraftLease(agentId, async () => {
      await updateAgent(ctx.ws.id, agentId, {
        name: String(formData.get("name") ?? "").trim() || "New agent",
        description:
          String(formData.get("description") ?? "")
            .trim()
            .slice(0, 500) || null,
        systemPrompt:
          String(formData.get("systemPrompt") ?? "")
            .trim()
            .slice(0, 100_000) || null,
        providerId,
        model,
        disabledBuiltinTools: formData
          .getAll("disabledBuiltinTool")
          .map(String),
        optionalBuiltinTools: optionalBuiltinToolsFromForm(formData),
        maxSteps,
        reasoningEffort: agentReasoningEffort(formData),
        contextFiles: agentContextFiles(formData),
        toolApproval: formData.has("toolApproval")
          ? ToolApprovalPolicySchema.parse(
              JSON.parse(String(formData.get("toolApproval"))),
            )
          : undefined,
        secretObfuscation: agentSecretObfuscation(formData),
        taskTimeoutSeconds: agentTaskTimeoutSeconds(formData),
        mcpToolTimeoutSeconds,
        advisor: agentAdvisor(formData),
        piPackages: piPackagesFromForm(formData),
      });
      await setAgentTools(ctx.ws.id, agentId, {
        deploymentIds,
        mcpToolTimeouts,
        installedSkillIds: formData.getAll("installedSkillId").map(String),
        toolkitIds: formData.getAll("toolkitId").map(String),
        externalSandboxes: externalSandboxesFromForm(formData),
      });
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return { error: "MCP_TOOL_SELECTION_CHANGED" };
    if (error instanceof McpPinningError) return { error: error.code };
    if (error instanceof AgentExecutionBusyError)
      return { error: resourceReviewError(error) };
    if (error instanceof AgentConfigurationError) {
      if (
        /^(Unknown or inaccessible market install:|Market install is not a pi-package:|Listing is not published:|Market install is not ready:|Release not approved:)/.test(
          error.message,
        )
      ) {
        return { error: "pi_package_unavailable" };
      }
      if (
        /^(Too many Pi packages|Duplicate marketInstallId:)/.test(error.message)
      )
        return { error: "pi_packages_invalid" };
      return { error: resourceReviewError(error) };
    }
    throw error;
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  return { savedAt: Date.now() };
}

export async function updateAgentModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };

  try {
    await updateAgentModelSelection(
      ctx.ws.id,
      agentId,
      String(formData.get("providerId") ?? "").trim() || null,
      String(formData.get("model") ?? "").trim() || null,
    );
  } catch (error) {
    if (error instanceof AgentConfigurationError)
      return { error: resourceReviewError(error) };
    throw error;
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  return { savedAt: Date.now() };
}

/** Preview the complete immutable configuration; never changes the default. */
export async function prepareAgentRevisionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    throw new Error("Agent not found.");
  const rawEnvironment = formData.get("environment");
  const environment =
    typeof rawEnvironment === "string" && rawEnvironment
      ? AgentEnvironmentSnapshotSchema.parse(JSON.parse(rawEnvironment))
      : undefined;
  try {
    await prepareAgentRevisionMcpDeployments(ctx.ws.id, agentId);
    return await db.$transaction(
      async (tx) => {
        const agent = await tx.agent.findFirstOrThrow({
          where: { id: agentId, workspaceId: ctx.ws.id },
          select: {
            currentRevisionVersion: true,
          },
        });
        const current = await tx.agentRevision.findFirst({
          where: {
            agentId,
            version: agent.currentRevisionVersion,
            agent: { workspace: workspaceScopeWhere(ctx.ws) },
          },
          select: { id: true },
        });
        const config = await captureAgentRevisionConfig(
          tx,
          agentId,
          environment,
        );
        // Flight text chunks decode a leading BOM; JSON keeps it inside the payload.
        return {
          expectedRevisionId: current?.id ?? null,
          configJson: JSON.stringify(config),
        };
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    if (error instanceof McpRecipePinError || error instanceof McpPinningError)
      return { error: error.code };
    throw error;
  }
}

/** Apply exactly the reviewed configuration using a compare-and-swap default. */
export async function publishAgentRevisionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    throw new Error("Agent not found.");
  if (!formData.has("expectedRevisionId"))
    throw new Error("Prepare the Agent configuration before applying it.");
  let revision: { id: string };
  try {
    revision = await publishAgentRevision(ctx.ws.id, agentId, {
      expectedRevisionId:
        String(formData.get("expectedRevisionId") ?? "") || null,
      config: JSON.parse(String(formData.get("config") ?? "")),
    });
  } catch (error) {
    if (error instanceof McpRecipePinError || error instanceof McpPinningError)
      return { error: error.code, conflict: null };
    if (error instanceof AgentRevisionError) {
      switch (error.code) {
        case "AGENT_FALLBACK_MODELS_INVALID":
        case "AGENT_ROLE_MODELS_INVALID":
        case "AGENT_MODEL_UNAVAILABLE":
        case "AGENT_PROVIDER_REVOKED":
        case "AGENT_REVISION_CONFIG_INVALID":
        case "AGENT_REVISION_CONFLICT":
          return { error: error.code, conflict: null };
      }
    }
    if (error instanceof Error && error.message === "PI_CAPABILITY_CONFLICT") {
      const detail = error.cause instanceof Error ? error.cause.message : "";
      const conflict = /^(skill|tool|command):(.{1,200})$/.exec(detail);
      return {
        error: "PI_CAPABILITY_CONFLICT" as const,
        conflict: conflict
          ? {
              kind: conflict[1] as "skill" | "tool" | "command",
              name: conflict[2],
            }
          : null,
      };
    }
    throw error;
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  return { revisionId: revision.id };
}
