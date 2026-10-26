"use server";

import type {
  ModelCost,
  ModelCostRates,
  ModelCostTier,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentConfig } from "@/lib/agents/mutations";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getProvider } from "@/lib/agents/queries";
import { generateConsoleConversationTitle } from "@/lib/agents/conversation-naming";
import { buildModel } from "@/lib/agents/model";
import { providerPreset } from "@/lib/agents/provider-catalog";
import {
  AgentExecutionBusyError,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";
import {
  refreshProviderModels,
  revalidateProviderViews,
} from "@/lib/agents/provider-model-refresh";
import {
  cloneAgent,
  createConfiguredAgent,
  AgentConfigurationError,
  updateAgent,
  setAgentTools,
  createProvider,
  updateProvider,
  updateAgentModelSelection,
  deleteProvider,
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  ProviderModelError,
  createConversation,
  renameConsoleConversation,
  deleteConsoleConversation,
} from "@/lib/agents/mutations";
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_PRIMARY_TYPES,
  defaultProviderModel,
  inferModelGroup,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import {
  createAgentChannelConnection,
  deleteAgentChannelConnection,
  updateAgentChannelConnectionCredentials,
} from "@/lib/agents/channel-connections";
import {
  checkAgentChannelPairing,
  requestAgentChannelPairing,
} from "@/lib/agents/channel-pairing";
import {
  getMessagingPlatform,
  hasBuiltInPairingProvider,
} from "@/lib/agents/platforms";
import { stopSandboxAction } from "@/lib/sandboxes/actions";
import {
  AgentMarketError,
  materializeAgentRelease,
  publishAgentRelease,
  unpublishAgentListing,
  withdrawPendingAgentRelease,
} from "@/lib/agents/market";
import { safeRelativePath } from "@/lib/auth/safe-redirect";
import { db } from "@/lib/db";
import { deleteManagedAgent } from "@/lib/agents/deletion";
import { AgentEnvironmentSnapshotSchema } from "./revision-types";
import {
  captureAgentRevisionConfig,
  publishAgentRevision,
  AgentRevisionError,
} from "./revisions";
import {
  prepareAgentResourceReview,
  applyAgentResourceReview,
} from "./resource-apply";
import type { AgentResourceReview } from "./resource-apply";

const resourceReviewPublicErrors: Record<string, true> = {
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
  MCP_CREDENTIAL_INVALID: true,
  MCP_CREDENTIAL_SCOPE_INVALID: true,
  MCP_CREDENTIAL_MIGRATION_REQUIRED: true,
};

function resourceReviewError(error: unknown) {
  if (error instanceof AgentExecutionBusyError) return "resource_binding_busy";
  if (
    error instanceof AgentRevisionError &&
    error.code === "AGENT_REVISION_UNRESOLVED"
  )
    return "revisionPreparationRequired";
  if (
    error instanceof AgentRevisionError ||
    error instanceof AgentConfigurationError
  )
    return error.message;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    (/^(?:AGENT_|PI_|MCP_)[A-Z0-9_]+$/.test(error.code) ||
      error.code === "resourceChanged" ||
      error.code === "reviewRequired" ||
      error.code === "reviewExpired" ||
      error.code === "revisionPreparationRequired")
  )
    return error.code;
  if (
    error instanceof Error &&
    resourceReviewPublicErrors[error.message] === true
  )
    return error.message;
  return "resource_binding_unavailable";
}

async function authorizedWorkspace(slug: string, ownerOnly = false) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws || (ownerOnly && ws.ownerId !== user.id)) return null;
  return { user, ws };
}

async function isManageableAgent(
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      publicRuntimeAllocation: { select: { id: true } },
    },
  });
  return Boolean(agent && !agent.publicRuntimeAllocation);
}

export type ActionState = {
  error?: string;
  warning?: string;
  savedAt?: number;
  conversationId?: string;
  created?: boolean;
  providerId?: string;
};

function providerFormValue(format: string, baseUrl: string) {
  const selectedFormat = providerPreset(format) ? format : "openai";
  return { format: selectedFormat, baseUrl };
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

function cloneOptionsFromFormData(formData: FormData) {
  // Copies never inherit authority. Historical conversations are opt-in only.
  if (formData.get("cloneOptions") !== "1") return undefined;
  const checked = (name: string) => formData.get(name) === "on";
  return {
    copyMcp: checked("copyMcp"),
    copySkills: checked("copySkills"),
    copyToolkits: checked("copyToolkits"),
    copySandboxes: checked("copySandboxes"),
    copySubAgents: checked("copySubAgents"),
    copyConversations: checked("copyConversations"),
  };
}

export async function createProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const requestedFormat = String(formData.get("format") ?? "");
  const { format, baseUrl } = providerFormValue(
    requestedFormat,
    String(formData.get("baseUrl") ?? "").trim(),
  );
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (
    !name ||
    (!providerPreset(format)?.format.startsWith("pi:") && (!baseUrl || !apiKey))
  ) {
    return {
      error: "Name, base URL and API key are required for custom providers.",
    };
  }
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  let provider: { id: string };
  try {
    provider = await createProvider(
      ctx.ws.id,
      { name, format, baseUrl, apiKey },
      ctx.user.id,
    );
  } catch {
    return { error: "A provider with that name already exists." };
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now(), providerId: provider.id };
}

export async function updateProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const requestedFormat = String(formData.get("format") ?? "");
  const { format, baseUrl } = providerFormValue(
    requestedFormat,
    String(formData.get("baseUrl") ?? "").trim(),
  );
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (
    !providerId ||
    !name ||
    (!providerPreset(format)?.format.startsWith("pi:") && !baseUrl)
  ) {
    return {
      error: "Provider, name and base URL are required for custom providers.",
    };
  }
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  const existing = await getProvider(ctx.ws.id, providerId);
  if (!existing) return { error: "Provider not found." };

  try {
    await updateProvider(
      ctx.ws.id,
      providerId,
      {
        name,
        format,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      },
      ctx.user.id,
    );
  } catch {
    return { error: "A provider with that name already exists." };
  }

  const shouldRefreshModels =
    existing.format !== format ||
    existing.baseUrl !== baseUrl ||
    Boolean(apiKey);
  let warning: string | undefined;
  if (shouldRefreshModels) {
    const refreshError = await refreshProviderModels(ctx.ws.id, providerId, {
      name,
      format,
      baseUrl,
      apiKey: apiKey || existing.apiKey,
    });
    if (refreshError)
      warning = `Provider updated, but models were not refreshed: ${refreshError}`;
  }
  revalidateProviderViews(slug);
  return { ...(warning ? { warning } : {}), savedAt: Date.now() };
}

export async function deleteProviderAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  await deleteProvider(ctx.ws.id, providerId, ctx.user.id);
  revalidateProviderViews(slug);
}

function optionalPositiveInteger(
  formData: FormData,
  name: string,
): number | null | undefined {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000_000
    ? value
    : undefined;
}

function selectedValues<T extends string>(
  formData: FormData,
  name: string,
  allowed: readonly T[],
): T[] {
  return [
    ...new Set(
      formData
        .getAll(name)
        .map(String)
        .filter((value): value is T => allowed.includes(value as T)),
    ),
  ];
}

function providerModelCost(formData: FormData): ModelCost | null | undefined {
  const raw = String(formData.get("cost") ?? "").trim();
  if (!raw) return null;
  if (raw.length > 16_000) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value === null) return null;
    const validRates = (rates: unknown): boolean =>
      !!rates &&
      typeof rates === "object" &&
      ["input", "output", "cacheRead", "cacheWrite"].every((key) => {
        const rate = (rates as Record<string, unknown>)[key];
        return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
      });
    if (!validRates(value)) return undefined;
    if (
      value.tiers !== undefined &&
      (!Array.isArray(value.tiers) ||
        value.tiers.length > 100 ||
        !value.tiers.every(
          (tier: Record<string, unknown>) =>
            validRates(tier) &&
            Number.isSafeInteger(tier.inputTokensAbove) &&
            Number(tier.inputTokensAbove) >= 0,
        ))
    )
      return undefined;
    const rates = ({
      input,
      output,
      cacheRead,
      cacheWrite,
    }: ModelCostRates) => ({ input, output, cacheRead, cacheWrite });
    return {
      ...rates(value),
      ...(value.tiers
        ? {
            tiers: value.tiers.map((tier: ModelCostTier) => ({
              ...rates(tier),
              inputTokensAbove: tier.inputTokensAbove,
            })),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function providerModelValues(
  formData: FormData,
  modelId: string,
): ProviderModelValues | null {
  const primaryTypeValue = String(formData.get("primaryType") ?? "text");
  if (!MODEL_PRIMARY_TYPES.includes(primaryTypeValue as ModelPrimaryType))
    return null;
  const contextWindow = optionalPositiveInteger(formData, "contextWindow");
  const maxInputTokens = optionalPositiveInteger(formData, "maxInputTokens");
  const maxOutputTokens = optionalPositiveInteger(formData, "maxOutputTokens");
  const cost = providerModelCost(formData);
  if (
    [contextWindow, maxInputTokens, maxOutputTokens, cost].includes(undefined)
  )
    return null;
  const defaults = defaultProviderModel(modelId);
  const name = String(formData.get("name") ?? "").trim();
  const group = String(formData.get("group") ?? "").trim();
  if (name.length > 200 || group.length > 120) return null;
  return {
    ...defaults,
    name: name || modelId,
    group: group || inferModelGroup(modelId),
    primaryType: primaryTypeValue as ModelPrimaryType,
    capabilities: selectedValues<ModelCapability>(
      formData,
      "capabilities",
      MODEL_CAPABILITIES,
    ),
    inputModalities: selectedValues<ModelInputModality>(
      formData,
      "inputModalities",
      MODEL_INPUT_MODALITIES,
    ),
    contextWindow: contextWindow ?? null,
    maxInputTokens: maxInputTokens ?? null,
    maxOutputTokens: maxOutputTokens ?? null,
    cost,
  };
}

function providerModelError(error: unknown): ActionState {
  return {
    error:
      error instanceof ProviderModelError
        ? error.message
        : "Could not save the model.",
  };
}

export async function addProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const rawModelIds = String(formData.get("modelId") ?? "")
    .trim()
    .replaceAll("，", ",");
  const modelIds = rawModelIds
    .split(",")
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  const firstModelId = modelIds[0];
  if (
    !providerId ||
    !firstModelId ||
    modelIds.length > 50 ||
    modelIds.some((modelId) => modelId.length > 200)
  ) {
    return { error: "Enter between 1 and 50 valid model IDs." };
  }
  const base = providerModelValues(formData, firstModelId);
  if (!base)
    return {
      error: "Check the model classification, token limits, and prices.",
    };
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  const models =
    modelIds.length === 1
      ? [base]
      : modelIds.map((modelId) => ({
          ...base,
          ...defaultProviderModel(modelId),
          primaryType: base.primaryType,
          capabilities: base.capabilities,
          inputModalities: base.inputModalities,
        }));
  try {
    await addProviderModels(ctx.ws.id, providerId, models);
  } catch (error) {
    return providerModelError(error);
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

export async function updateProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const modelId = String(formData.get("modelId") ?? "").trim();
  const model = providerModelValues(formData, modelId);
  if (!providerId || !modelId || modelId.length > 200 || !model) {
    return { error: "Check the model fields, token limits, and prices." };
  }
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  try {
    await updateProviderModel(ctx.ws.id, providerId, model);
  } catch (error) {
    return providerModelError(error);
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

export async function deleteProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const modelId = String(formData.get("modelId") ?? "").trim();
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  try {
    await deleteProviderModel(ctx.ws.id, providerId, modelId);
  } catch (error) {
    return providerModelError(error);
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

function sanitizeProviderError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : "Model test failed.";
  const trimmed = raw.replaceAll(apiKey, "[redacted]").slice(0, 240);
  return trimmed || "Model test failed.";
}

export async function testProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const modelId = String(formData.get("model") ?? "").trim();
  if (!modelId) return { error: "Model is required." };
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };
  const provider = await getProvider(ctx.ws.id, providerId);
  if (!provider) return { error: "Provider not found." };

  try {
    const { models, model } = buildModel(provider, modelId);
    const result = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly: ok",
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 8,
        maxRetries: 0,
        timeoutMs: 10000,
      },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "Model test failed.");
    }
  } catch (error) {
    return { error: sanitizeProviderError(error, provider.apiKey) };
  }
  return { savedAt: Date.now() };
}

export async function updateWorkspaceModelPreferenceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const preference = String(formData.get("preference") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const model = String(formData.get("model") ?? "").trim();
  if (preference !== "default" && preference !== "title")
    return { error: "Invalid model preference." };
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return { error: "Not authorized." };

  if (providerId || model) {
    const provider = providerId
      ? await getProvider(ctx.ws.id, providerId)
      : null;
    if (!provider || !model || !provider.models.includes(model)) {
      return { error: "Choose an available model." };
    }
  }

  await db.workspace.update({
    where: { id: ctx.ws.id },
    data:
      preference === "default"
        ? {
            defaultModelProviderId: providerId || null,
            defaultModel: model || null,
          }
        : {
            titleModelProviderId: providerId || null,
            titleModel: model || null,
          },
  });
  revalidatePath(`/app/${slug}/settings`);
  revalidatePath(`/app/${slug}/agents`);
  return { savedAt: Date.now() };
}

export async function createAgentAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "").trim() || "New agent";
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const rawRuntime = formData.get("runtime");
  if (rawRuntime && rawRuntime !== "pi-sdk")
    throw new Error("Only native Pi Agents are available for creation.");
  const runtime = "pi-sdk";
  const providerId = String(formData.get("providerId") ?? "").trim() || null;
  const model = String(formData.get("model") ?? "") || null;
  const provider = providerId ? await getProvider(ctx.ws.id, providerId) : null;
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
      disabledBuiltinTools: formData.getAll("disabledBuiltinTool").map(String),
      maxSteps: agentMaxSteps(formData),
      piPackages: piPackagesFromForm(formData),
    },
    {
      deploymentIds: formData.getAll("deploymentId").map(String),
      installedSkillIds: formData.getAll("installedSkillId").map(String),
      toolkitIds: formData.getAll("toolkitId").map(String),
    },
    {
      runtime,
    },
  );
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  redirect(
    `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(agent.id)}`,
  );
}

export async function deleteAgentAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
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
  const ctx = await authorizedWorkspace(slug);
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

export async function uninstallAgentMarketCopyAction(formData: FormData) {
  return deleteAgentAction(formData);
}

export async function cloneAgentAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const sourceAgentId = String(formData.get("agentId") ?? "");
  const requestedName =
    String(formData.get("cloneName") ?? "")
      .trim()
      .slice(0, 60) || undefined;
  const cloneOptions = cloneOptionsFromFormData(formData);
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !sourceAgentId) return;
  if (!(await isManageableAgent(ctx.ws.id, sourceAgentId))) return;

  const cloned = await cloneAgent(
    ctx.ws.id,
    sourceAgentId,
    requestedName,
    cloneOptions,
  );
  if (!cloned) return;
  const targetPath = `/app/${slug}/agents/${cloned.id}`;
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(targetPath);
  redirect(
    `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(cloned.id)}`,
  );
}

function marketTags(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().slice(0, 32))
        .filter(Boolean),
    ),
  ].slice(0, 6);
}

function marketErrorCode(error: unknown) {
  return error instanceof AgentMarketError ? error.code : "install_failed";
}

export async function publishAgentReleaseAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;

  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  if (ctx.ws.ownerId !== ctx.user.id) {
    redirect(`${publishPath}?error=owner_only`);
  }
  if (formData.get("confirmPublicContents") !== "yes") {
    redirect(`${publishPath}?error=confirm_required`);
  }

  const name = String(formData.get("name") ?? "")
    .trim()
    .slice(0, 80);
  const summary = String(formData.get("summary") ?? "")
    .trim()
    .slice(0, 360);
  if (!name || !summary) {
    redirect(`${publishPath}?error=missing_fields`);
  }

  let errorCode: string | null = null;
  try {
    await publishAgentRelease({
      workspaceId: ctx.ws.id,
      agentId,
      publishedById: ctx.user.id,
      listing: {
        slug: String(formData.get("listingSlug") ?? "").trim() || undefined,
        name,
        summary,
        iconUrl:
          String(formData.get("iconUrl") ?? "")
            .trim()
            .slice(0, 2000) || null,
        tags: marketTags(formData.get("tags")),
        categoryIds: formData.getAll("categoryIds").map(String).filter(Boolean),
      },
    });
  } catch (error) {
    errorCode = marketErrorCode(error);
  }
  if (errorCode)
    redirect(`${publishPath}?error=${encodeURIComponent(errorCode)}`);

  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?submitted=1`);
}

export async function unpublishAgentListingAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId || ctx.ws.ownerId !== ctx.user.id) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;

  await unpublishAgentListing({
    workspaceId: ctx.ws.id,
    agentId,
    actorId: ctx.user.id,
  });
  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?unpublished=1`);
}

export async function withdrawPendingAgentReleaseAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !agentId || ctx.ws.ownerId !== ctx.user.id) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;

  await withdrawPendingAgentRelease({
    workspaceId: ctx.ws.id,
    agentId,
    actorId: ctx.user.id,
  });
  const publishPath = `/app/${slug}/agents/${agentId}/publish`;
  revalidatePath(`/app/${slug}/market/agents`);
  revalidatePath(publishPath);
  redirect(`${publishPath}?withdrawn=1`);
}

export async function installAgentFromMarketAction(formData: FormData) {
  const workspaceSlug = String(formData.get("workspace") ?? "");
  const releaseId = String(formData.get("releaseId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").slice(
    0,
    128,
  );
  const returnTo =
    safeRelativePath(formData.get("returnTo")) ??
    (workspaceSlug ? `/app/${workspaceSlug}/market/agents` : "/app");
  const ctx = await authorizedWorkspace(workspaceSlug);
  if (!ctx || !releaseId || !idempotencyKey) return;

  let clonedAgentId: string | null = null;
  let errorCode: string | null = null;
  try {
    const result = await materializeAgentRelease({
      releaseId,
      targetWorkspaceId: ctx.ws.id,
      installedById: ctx.user.id,
      idempotencyKey,
      name:
        String(formData.get("name") ?? "")
          .trim()
          .slice(0, 80) || undefined,
    });
    clonedAgentId = result.agent.id;
  } catch (error) {
    errorCode = marketErrorCode(error);
  }
  if (errorCode) {
    const separator = returnTo.includes("?") ? "&" : "?";
    redirect(
      `${returnTo}${separator}cloneError=${encodeURIComponent(errorCode)}`,
    );
  }
  if (!clonedAgentId) return;

  revalidatePath(`/app/${workspaceSlug}/agents`);
  revalidatePath(`/app/${workspaceSlug}/market/agents`);
  redirect(
    `/app/${encodeURIComponent(workspaceSlug)}/work?agent=${encodeURIComponent(clonedAgentId)}`,
  );
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
  const ctx = await authorizedWorkspace(slug);
  if (
    !ctx ||
    !agentId ||
    !resourceId ||
    (resourceKind !== "skill" && resourceKind !== "mcp") ||
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
  const ctx = await authorizedWorkspace(slug);
  if (
    !ctx ||
    !agentId ||
    !resourceId ||
    (resourceKind !== "skill" && resourceKind !== "mcp") ||
    !(await isManageableAgent(ctx.ws.id, agentId))
  )
    return { error: "resource_binding_unavailable" };
  if (formData.get("confirm") !== "yes")
    return { error: "resource_binding_consent" };
  const expectedRevisionId = String(formData.get("expectedRevisionId") ?? "");
  const reviewReceipt = String(formData.get("reviewReceipt") ?? "");
  if (!expectedRevisionId || !reviewReceipt) return { error: "reviewRequired" };
  try {
    let allowedToolNames: string[] | undefined;
    if (resourceKind === "mcp") {
      const selection = formData.get("allowedToolNames");
      if (typeof selection !== "string") return { error: "reviewRequired" };
      const parsed = z
        .array(z.string().min(1).max(240))
        .max(1_000)
        .safeParse(JSON.parse(selection));
      if (!parsed.success || new Set(parsed.data).size !== parsed.data.length)
        return { error: "reviewRequired" };
      allowedToolNames = parsed.data;
    }
    const revision = await applyAgentResourceReview({
      workspaceId: ctx.ws.id,
      userId: ctx.user.id,
      agentId,
      resourceId,
      resourceKind,
      expectedRevisionId,
      reviewReceipt,
      ...(allowedToolNames === undefined ? {} : { allowedToolNames }),
    });
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    revalidatePath(
      `/app/${slug}/${resourceKind === "skill" ? "skills" : "mcp"}/${resourceId}`,
    );
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
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };

  const providerId = String(formData.get("providerId") ?? "").trim() || null;
  const model = String(formData.get("model") ?? "") || null;
  const maxSteps = agentMaxSteps(formData);

  try {
    await withAgentMaintenanceLease(agentId, async () => {
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
        maxSteps,
        piPackages: piPackagesFromForm(formData),
      });
      await setAgentTools(ctx.ws.id, agentId, {
        deploymentIds: formData.getAll("deploymentId").map(String),
        installedSkillIds: formData.getAll("installedSkillId").map(String),
        toolkitIds: formData.getAll("toolkitId").map(String),
        sandboxIds: formData.getAll("sandboxId").map(String),
        defaultSandboxId:
          String(formData.get("defaultSandboxId") ?? "") || null,
        subAgentIds: formData.getAll("subAgentId").map(String),
      });
    });
  } catch (error) {
    if (error instanceof AgentExecutionBusyError)
      return { error: error.message };
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
      return { error: error.message };
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
  const ctx = await authorizedWorkspace(slug);
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
      return { error: error.message };
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
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    throw new Error("Agent not found.");
  const rawEnvironment = formData.get("environment");
  const environment =
    typeof rawEnvironment === "string" && rawEnvironment
      ? AgentEnvironmentSnapshotSchema.parse(JSON.parse(rawEnvironment))
      : undefined;
  return db.$transaction(
    async (tx) => {
      const agent = await tx.agent.findFirstOrThrow({
        where: { id: agentId, workspaceId: ctx.ws.id },
        select: { currentRevisionVersion: true },
      });
      const current = await tx.agentRevision.findUnique({
        where: {
          agentId_version: { agentId, version: agent.currentRevisionVersion },
        },
        select: { id: true },
      });
      const config = await captureAgentRevisionConfig(tx, agentId, environment);
      return { expectedRevisionId: current?.id ?? null, config };
    },
    { timeout: 120_000 },
  );
}

/** Apply exactly the reviewed configuration using a compare-and-swap default. */
export async function publishAgentRevisionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    throw new Error("Agent not found.");
  if (!formData.has("expectedRevisionId"))
    throw new Error("Prepare the Agent configuration before applying it.");
  const revision = await publishAgentRevision(ctx.ws.id, agentId, {
    expectedRevisionId:
      String(formData.get("expectedRevisionId") ?? "") || null,
    config: JSON.parse(String(formData.get("config") ?? "")),
  });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/agents`);
  revalidatePath(`/app/${slug}/work`);
  return { revisionId: revision.id };
}

export async function stopAgentRuntimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };
  try {
    const sandboxes = await db.sandbox.findMany({
      where: {
        workspaceId: ctx.ws.id,
        OR: [
          { agentLinks: { some: { agentId } } },
          { conversations: { some: { agentId } } },
          { a2aContexts: { some: { agentId, targetKind: "local" } } },
        ],
      },
      select: { id: true },
    });
    // Shared stop tears down persisted MCP bindings without deleting volumes.
    for (const sandbox of sandboxes) {
      const stop = new FormData();
      stop.set("workspace", slug);
      stop.set("sandboxId", sandbox.id);
      await stopSandboxAction(stop);
    }
    revalidatePath(`/app/${slug}/agents/${agentId}`);
    return { savedAt: Date.now() };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not stop the Agent runtime.",
    };
  }
}

export async function createConversationAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;
  const conv = await createConversation(ctx.ws.id, agentId);
  if (!conv) return;
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  redirect(`/app/${slug}/work?agent=${agentId}&c=${conv.id}`);
}

export async function renameConversationAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  const title = String(formData.get("title") ?? "")
    .trim()
    .slice(0, 120);
  if (!conversationId || !title) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId))) return;
  if (
    await renameConsoleConversation(ctx.ws.id, agentId, conversationId, title)
  ) {
    revalidatePath(`/app/${slug}/work`);
  }
}

export async function generateConversationTitleAction(
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  const force = formData.get("force") === "1";
  if (!conversationId) return { error: "Conversation not found." };
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Conversation not found." };
  try {
    const title = await generateConsoleConversationTitle(
      ctx.ws.id,
      agentId,
      conversationId,
      force,
    );
    if (force && !title)
      return { error: "Could not generate a title for this conversation." };
    revalidatePath(`/app/${slug}/work`);
    return { savedAt: Date.now() };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not generate a conversation title.",
    };
  }
}

export async function deleteConversationAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const conversationId = String(formData.get("conversationId") ?? "");
  if (!conversationId) return;
  const ctx = await authorizedWorkspace(slug);
  if (!ctx || !(await isManageableAgent(ctx.ws.id, agentId))) return;
  if (!(await deleteConsoleConversation(ctx.ws.id, agentId, conversationId)))
    return;
  revalidatePath(`/app/${slug}/work`);
  redirect(`/app/${slug}/work?agent=${agentId}`);
}

export async function createAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const platformSlug = String(formData.get("platform") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  if (!(await isManageableAgent(ctx.ws.id, agentId))) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(
      formData.get(`credential:${credential.name}`) ?? "",
    ).trim();
    if (value) credentials[credential.name] = value;
  }

  const result = await createAgentChannelConnection({
    workspaceId: ctx.ws.id,
    agentId,
    platform: platform.slug,
    name: String(formData.get("name") ?? "").trim() || platform.label,
    credentials,
  });
  if (
    result.connection &&
    hasBuiltInPairingProvider(platform) &&
    result.connection.missingStartCredentialNames.length > 0
  ) {
    await requestAgentChannelPairing(ctx.ws.id, result.connection.id);
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function updateAgentChannelConnectionCredentialsAction(
  formData: FormData,
) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const platformSlug = String(formData.get("platform") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  const platform = getMessagingPlatform(platformSlug);
  if (!platform) return;

  const credentials: Record<string, string> = {};
  for (const credential of platform.credentials) {
    const value = String(
      formData.get(`credential:${credential.name}`) ?? "",
    ).trim();
    if (value) credentials[credential.name] = value;
  }

  await updateAgentChannelConnectionCredentials({
    workspaceId: ctx.ws.id,
    connectionId,
    credentials,
  });
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function requestAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  await requestAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function checkAgentChannelPairingAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  await checkAgentChannelPairing(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function deleteAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  await deleteAgentChannelConnection(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function startAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  const { startAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await startAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}

export async function stopAgentChannelConnectionAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const ctx = await authorizedWorkspace(slug, true);
  if (!ctx) return;
  const { stopAgentChannelRunner } = await import(
    "@/lib/agents/channel-runtime"
  );
  await stopAgentChannelRunner(ctx.ws.id, connectionId);
  revalidatePath(`/app/${slug}/agents/${agentId}`);
}
