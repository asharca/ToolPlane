"use server";

import type {
  ModelCost,
  ModelCostRates,
  ModelCostTier,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentConfig } from "@/lib/agents/mutations";
import { systemLog } from "@/lib/observability/system";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { getProvider, ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
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
import { parseSandboxEnvText, sandboxEnvToText } from "@/lib/sandboxes/env";
import { updateSandboxEnvAction } from "@/lib/sandboxes/actions";
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
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { startProcess } from "@/lib/process/supervisor";
import {
  getPiRuntimeVersion,
  updatePiRuntimeVersion,
  validatePiVersion,
} from "./sandbox-runtime";
import type { PiRuntimeVersion } from "./sandbox-runtime";
import { SandboxExecutionBusyError } from "./sandbox-execution-gate";

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

async function startCreatedAgentRuntime(workspaceId: string, agentId: string) {
  let deploymentId: string | null = null;
  try {
    const agent = await db.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: {
        runtimeKind: true,
        sandboxes: {
          where: {
            isDefault: true,
            sandbox: { workspaceId, deployment: { workspaceId } },
          },
          take: 1,
          select: {
            sandbox: {
              select: {
                deployment: {
                  select: {
                    id: true,
                    serverId: true,
                    name: true,
                    source: true,
                    sourceRef: true,
                    installCfg: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!agent) throw new Error("The created Agent could not be loaded.");
    const deployment = agent.sandboxes[0]?.sandbox.deployment;
    if (!deployment)
      throw new Error("The Agent runtime sandbox was not created.");
    deploymentId = deployment.id;
    await startProcess(deployment.id, resolveSpawnSpec(deployment), {
      awaitReady: false,
      workspaceId,
    });
  } catch (error) {
    systemLog(
      "error",
      `Failed to start runtime sandbox for Agent ${agentId}.`,
      error,
    );
    if (deploymentId) {
      await db.deployment
        .updateMany({
          where: { id: deploymentId, workspaceId },
          data: { status: "error" },
        })
        .catch((statusError) => {
          systemLog(
            "error",
            `Failed to record runtime startup error for Agent ${agentId}.`,
            statusError,
          );
        });
    }
  }
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
  if (rawRuntime !== "pi" && rawRuntime !== "pi-sdk")
    throw new Error("Only Pi runtimes are available for new agents.");
  const runtime = rawRuntime as "pi" | "pi-sdk";
  const providerIds = formData.getAll("providerId").map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
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
      sandboxIds: formData.getAll("sandboxId").map(String),
    },
    {
      runtime,
    },
  );
  await startCreatedAgentRuntime(ctx.ws.id, agent.id);
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
    await startCreatedAgentRuntime(ctx.ws.id, clonedAgentId);
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

  const providerIds = formData.getAll("providerId").map(String).filter(Boolean);
  const providerId = providerIds[0] ?? null;
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
      formData.getAll("providerId").map(String),
      String(formData.get("model") ?? "").trim() || null,
    );
  } catch (error) {
    if (error instanceof AgentConfigurationError)
      return { error: error.message };
    throw error;
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  revalidatePath(`/app/${slug}/work`);
  revalidatePath(`/app/${slug}/work`);
  return { savedAt: Date.now() };
}

export type PiRuntimeAgentState = {
  agentId: string;
  name: string;
  version?: string;
  installed?: boolean;
  status: "ready" | "updated" | "unchanged" | "error";
  error?: string;
};

export type PiRuntimeManagementState = {
  agents?: PiRuntimeAgentState[];
  latestVersion?: string;
  targetVersion?: string;
  error?: string;
  warning?: string;
  finishedAt?: number;
};

async function latestPiVersion(): Promise<string> {
  const response = await fetch(
    "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest",
    {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("Could not check the latest Pi release.");
  const data = await response.json();
  if (typeof data.version !== "string")
    throw new Error("Invalid Pi release metadata.");
  return validatePiVersion(data.version);
}

async function managePiRuntimes(
  slug: string,
  target?: string,
  agentIds?: string[],
): Promise<PiRuntimeManagementState> {
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: "Not authorized." };
  if (
    target !== undefined &&
    (!Array.isArray(agentIds) ||
      !agentIds.length ||
      agentIds.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    return { error: "Select at least one Pi agent." };
  }
  if (target !== undefined && target !== "latest") {
    try {
      validatePiVersion(target);
    } catch {
      return { error: "Enter an exact Pi version, for example 0.80.3." };
    }
  }
  // Authorize the collection on the server before applying the requested selection.
  const agents = await db.agent.findMany({
    where: {
      workspaceId: ctx.ws.id,
      runtimeKind: "pi",
      ...ORDINARY_AGENT_FILTER,
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const selectedIds = new Set(agentIds);
  const targets =
    target === undefined
      ? agents
      : agents.filter((agent) => selectedIds.has(agent.id));
  if (target !== undefined && targets.length !== selectedIds.size) {
    return {
      error:
        "One or more selected Pi agents are unavailable in this workspace. Refresh and select again.",
    };
  }
  let latestVersion: string | undefined;
  let warning: string | undefined;
  if (target === undefined || target === "latest") {
    try {
      latestVersion = await latestPiVersion();
    } catch {
      const error =
        "Could not check the latest Pi release. Retry or specify an exact version.";
      if (target) return { error };
      warning = error;
    }
  }
  const version = target === "latest" ? latestVersion : target;
  const results: PiRuntimeAgentState[] = [];
  for (const agent of targets) {
    let current: PiRuntimeVersion | undefined;
    try {
      if (!(await isManageableAgent(ctx.ws.id, agent.id)))
        throw new Error("Agent unavailable.");
      current = await getPiRuntimeVersion(ctx.ws.id, agent.id);
      if (version && (!current.installed || current.version !== version)) {
        const updated = await updatePiRuntimeVersion(
          ctx.ws.id,
          agent.id,
          version,
        );
        results.push({
          agentId: agent.id,
          name: agent.name,
          ...updated,
          status: "updated",
        });
      } else {
        results.push({
          agentId: agent.id,
          name: agent.name,
          ...current,
          status: version ? "unchanged" : "ready",
        });
      }
    } catch (error) {
      results.push({
        agentId: agent.id,
        name: agent.name,
        ...current,
        status: "error",
        error:
          error instanceof SandboxExecutionBusyError
            ? error.message
            : "Could not manage this Pi runtime. Check its sandbox, network and requested version, then check again before retrying.",
      });
    }
  }
  if (version) revalidatePath(`/app/${slug}/agents`);
  return {
    agents: results,
    ...(latestVersion ? { latestVersion } : {}),
    ...(warning ? { warning } : {}),
    ...(version ? { targetVersion: version, finishedAt: Date.now() } : {}),
  };
}

export async function checkPiRuntimesAction(
  slug: string,
): Promise<PiRuntimeManagementState> {
  return managePiRuntimes(slug);
}

export async function updatePiRuntimesAction(
  slug: string,
  target: string,
  agentIds: string[],
): Promise<PiRuntimeManagementState> {
  if (typeof target !== "string" || !target.trim())
    return { error: "Enter an exact Pi version or choose latest." };
  return managePiRuntimes(slug, target, agentIds);
}

export async function updateAgentRuntimeEnvAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return { error: "Not authorized." };
  if (!(await isManageableAgent(ctx.ws.id, agentId)))
    return { error: "Agent not found." };

  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId: ctx.ws.id },
    select: {
      sandboxes: {
        where: { isDefault: true },
        take: 1,
        select: { sandboxId: true },
      },
    },
  });
  if (!agent) return { error: "Agent not found." };

  let env: ReturnType<typeof parseSandboxEnvText>;
  try {
    env = parseSandboxEnvText(formData.get("runtimeEnv"));
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Invalid environment variables.",
    };
  }

  const sandboxId = agent.sandboxes[0]?.sandboxId;
  if (!sandboxId) return { error: "Agent runtime sandbox not found." };
  const sandboxForm = new FormData();
  sandboxForm.set("workspace", slug);
  sandboxForm.set("sandboxId", sandboxId);
  sandboxForm.set("env", sandboxEnvToText(env));
  try {
    await updateSandboxEnvAction(sandboxForm);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not save environment variables.",
    };
  }
  revalidatePath(`/app/${slug}/agents/${agentId}`);
  return { savedAt: Date.now() };
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
