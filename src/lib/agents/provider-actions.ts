"use server";
import { workspaceScopeWhere } from "@/lib/workspace/scope";
import { actionScope } from "@/lib/workspace/action-scope";
import type {
  ModelCost,
  ModelCostRates,
  ModelCostTier,
} from "@earendil-works/pi-ai";
import { revalidatePath } from "next/cache";
import { getProvider } from "@/lib/agents/queries";
import { buildModel } from "@/lib/agents/model";
import { providerPreset } from "@/lib/agents/provider-catalog";
import {
  refreshProviderModels,
  revalidateProviderViews,
} from "@/lib/agents/provider-model-refresh";
import {
  createProvider,
  updateProvider,
  deleteProvider,
  addProviderModels,
  updateProviderModel,
  deleteProviderModel,
  ProviderModelError,
} from "@/lib/agents/provider-mutations";
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
import { db } from "@/lib/db";
import type { ActionState } from "./action-state";

function providerFormValue(format: string, baseUrl: string) {
  const selectedFormat = providerPreset(format) ? format : "openai";
  return { format: selectedFormat, baseUrl };
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
  const initialModelIds = [
    ...new Set(
      String(formData.get("initialModels") ?? "")
        .split(/[\n,，]+/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 200),
    ),
  ];
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  let provider: { id: string };
  try {
    provider = await createProvider(ctx.ws, { name, format, baseUrl, apiKey });
    if (initialModelIds.length > 0) {
      await addProviderModels(
        ctx.ws.id,
        provider.id,
        initialModelIds.map((modelId) => defaultProviderModel(modelId)),
      );
    }
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
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  const existing = await getProvider(ctx.ws.id, providerId);
  if (!existing) return { error: "Provider not found." };

  try {
    await updateProvider(ctx.ws, providerId, {
      name,
      format,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    });
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
      warning = "Provider updated, but models were not refreshed.";
  }
  revalidateProviderViews(slug);
  return { ...(warning ? { warning } : {}), savedAt: Date.now() };
}

export async function deleteProviderAction(formData: FormData) {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const ctx = await actionScope({ slug });
  if (!ctx) return;
  await deleteProvider(ctx.ws, providerId);
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
  const ctx = await actionScope({ slug });
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
  const ctx = await actionScope({ slug });
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
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  try {
    await deleteProviderModel(ctx.ws.id, providerId, modelId);
  } catch (error) {
    return providerModelError(error);
  }
  revalidateProviderViews(slug);
  return { savedAt: Date.now() };
}

export async function testProviderModelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerId = String(formData.get("providerId") ?? "");
  const modelId = String(formData.get("model") ?? "").trim();
  if (!modelId) return { error: "Model is required." };
  const ctx = await actionScope({ slug });
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
  } catch {
    return { error: "Model test failed." };
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
  const ctx = await actionScope({ slug, ownerOnly: true });
  if (!ctx) return { error: "Not authorized." };

  if (providerId || model) {
    const provider = providerId
      ? await getProvider(ctx.ws.id, providerId)
      : null;
    if (!provider || !model || !provider.models.includes(model)) {
      return { error: "Choose an available model." };
    }
  }

  const changed = await db.workspace.updateMany({
    where: {
      id: ctx.ws.id,
      ...workspaceScopeWhere(ctx.ws),
      ownerId: ctx.user.id,
    },
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
  if (!changed.count) return { error: "Not authorized." };
  revalidatePath(`/app/${slug}/settings`);
  revalidatePath(`/app/${slug}/agents`);
  return { savedAt: Date.now() };
}

export async function updateWorkspaceModelRetryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const attempts = Number(formData.get("attempts"));
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 10)
    return { error: "Choose between 0 and 10 retries." };
  // Members manage providers, so they also tune how provider failures retry.
  const ctx = await actionScope({ slug });
  if (!ctx) return { error: "Not authorized." };
  const changed = await db.workspace.updateMany({
    where: { id: ctx.ws.id, ...workspaceScopeWhere(ctx.ws) },
    data: { modelRetryAttempts: attempts },
  });
  if (!changed.count) return { error: "Not authorized." };
  revalidatePath(`/app/${slug}/settings`);
  return { savedAt: Date.now() };
}
