import "server-only";
import {
  createModels,
  createProvider,
  type Api,
  type AuthContext,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  builtinProviders,
  radiusProvider,
} from "@earendil-works/pi-ai/providers/all";
import { db } from "@/lib/db";
import { piProviderId } from "./provider-catalog";
import {
  parseProviderCredential,
  serializeProviderCredential,
} from "./provider-credentials";

export type ProviderConfig = {
  id?: string;
  name: string;
  format: string;
  baseUrl: string;
  apiKey: string;
};

export type ModelParameters = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  customParameters?: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "json";
    value: string | number | boolean;
  }>;
};

export type PiModel = Model<Api>;
export type PiModelRuntime = { models: MutableModels; model: PiModel };
export type ModelContext = {
  maxTokens: number;
  modelName: string;
  estimated: boolean;
};

function providerId(provider: ProviderConfig): string {
  return (
    provider.id ??
    `toolplane-${provider.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "provider"}`
  );
}

function configuredBaseUrl(
  provider: ProviderConfig,
  fallback?: string,
): string | undefined {
  return provider.baseUrl.trim().replace(/\/+$/, "") || fallback;
}

function modelApi(
  format: string,
): "anthropic-messages" | "openai-completions" | "openai-responses" {
  if (format === "anthropic") return "anthropic-messages";
  if (format === "openai-responses") return "openai-responses";
  return "openai-completions";
}

function providerApi(format: string): ProviderStreams {
  if (format === "anthropic") return anthropicMessagesApi();
  if (format === "openai-responses") return openAIResponsesApi();
  return openAICompletionsApi();
}

const ISOLATED_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

function workspaceApiKeyAuth(provider: ProviderConfig, resolvedKey?: string) {
  const key = resolvedKey ?? provider.apiKey;
  return {
    apiKey: {
      name: provider.name,
      resolve: async () => (key ? { auth: { apiKey: key } } : undefined),
    },
  };
}

function createProviderCredentialStore(
  provider: ProviderConfig,
): CredentialStore {
  const id = providerId(provider);
  let current = parseProviderCredential(provider.apiKey);
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async read(requestedId, options) {
      options?.signal?.throwIfAborted();
      if (requestedId !== id) return undefined;
      return current;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return current ? [{ providerId: id, type: current.type }] : [];
    },
    async modify(requestedId, fn, options) {
      options?.signal?.throwIfAborted();
      if (requestedId !== id) return undefined;
      const run = async () => {
        options?.signal?.throwIfAborted();
        if (provider.id) {
          const providerRowId = provider.id;
          return db.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<Array<{ apiKey: string }>>`
              SELECT "apiKey"
              FROM "ModelProvider"
              WHERE "id" = ${providerRowId}
              FOR UPDATE
            `;
            if (!rows[0]) throw new Error("Model provider was removed");
            const latest = parseProviderCredential(rows[0].apiKey);
            const next = await fn(latest);
            if (next === undefined) {
              current = latest;
              return latest;
            }
            const serialized = serializeProviderCredential(next);
            await tx.modelProvider.update({
              where: { id: providerRowId },
              data: { apiKey: serialized },
            });
            provider.apiKey = serialized;
            current = next;
            return next;
          });
        }
        const next = await fn(current);
        if (next !== undefined) {
          current = next;
          provider.apiKey = serializeProviderCredential(next);
        }
        return next ?? current;
      };
      const nextChain = chain.catch(() => undefined).then(run);
      chain = nextChain;
      return nextChain;
    },
    async delete(requestedId, options) {
      options?.signal?.throwIfAborted();
      if (requestedId === id) current = undefined;
    },
  };
}

function builtinProvider(provider: ProviderConfig): Provider<Api> | null {
  const builtinId = piProviderId(provider.format);
  if (!builtinId) return null;
  const explicitBaseUrl = configuredBaseUrl(provider);
  const source =
    builtinId === "radius"
      ? (radiusProvider({
          id: "radius",
          name: provider.name,
          ...(explicitBaseUrl ? { gateway: explicitBaseUrl } : {}),
        }) as Provider<Api>)
      : builtinProviders().find((candidate) => candidate.id === builtinId);
  if (!source) return null;

  const id = providerId(provider);
  const baseUrl = explicitBaseUrl ?? source.baseUrl;
  const rebase = (model: PiModel): PiModel => ({
    ...model,
    provider: source.id,
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
  });
  const models = source.getModels().map((model) => ({
    ...model,
    provider: id,
    ...(explicitBaseUrl
      ? { baseUrl: explicitBaseUrl }
      : baseUrl && !model.baseUrl
        ? { baseUrl }
        : {}),
  })) as PiModel[];
  const fetchDeferred = source.fetchDeferred;
  const cancelDeferred = source.cancelDeferred;
  const credential = parseProviderCredential(provider.apiKey);
  const auth =
    credential?.type === "oauth" && source.auth.oauth
      ? source.auth
      : credential?.type === "api_key" && source.auth.apiKey
        ? {
            ...source.auth,
            apiKey: credential.env
              ? source.auth.apiKey
              : workspaceApiKeyAuth(provider, credential.key).apiKey,
          }
        : provider.apiKey
          ? workspaceApiKeyAuth(
              provider,
              credential?.type === "api_key"
                ? credential.key
                : credential?.access,
            )
          : source.auth;

  return {
    ...source,
    id,
    name: provider.name,
    ...(baseUrl ? { baseUrl } : {}),
    auth,
    getModels: () => models,
    stream: (model, context, options) =>
      source.stream(rebase(model), context, options),
    streamSimple: (model, context, options) =>
      source.streamSimple(rebase(model), context, options),
    ...(fetchDeferred
      ? {
          fetchDeferred: (model, handle, options) =>
            fetchDeferred.call(source, rebase(model), handle, options),
        }
      : {}),
    ...(cancelDeferred
      ? {
          cancelDeferred: (model, handle, options) =>
            cancelDeferred.call(source, rebase(model), handle, options),
        }
      : {}),
  } as Provider<Api>;
}

export function providerModelIds(provider: ProviderConfig): string[] | null {
  const builtin = builtinProvider(provider);
  if (!builtin) return null;
  const models = builtin.getModels();
  const credential = parseProviderCredential(provider.apiKey);
  const filtered = builtin.filterModels?.(models, credential) ?? models;
  return filtered.map((model) => model.id);
}
export function createPiModel(
  provider: ProviderConfig,
  modelId: string,
): PiModel {
  const builtin = builtinProvider(provider);
  if (builtin) {
    const template =
      builtin.getModels().find((model) => model.id === modelId) ??
      builtin.getModels()[0];
    if (template) return { ...template, id: modelId, name: modelId };
  }
  return {
    id: modelId,
    name: modelId,
    api: modelApi(provider.format),
    provider: providerId(provider),
    baseUrl: configuredBaseUrl(provider) ?? "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as PiModel;
}

export const modelSupportsReasoning = (
  provider: ProviderConfig,
  modelId: string,
) =>
  createPiModel(provider, modelId).reasoning ||
  builtinProviders().some((candidate) =>
    candidate
      .getModels()
      .some((model) => model.id === modelId && model.reasoning),
  );

/** A workspace model record is authoritative; unrecorded models use the built-in catalog. */
export function modelReasoningSupported(
  provider: ProviderConfig,
  modelId: string,
  record?: { capabilities: readonly string[] } | null,
): boolean {
  return record
    ? record.capabilities.includes("reasoning")
    : modelSupportsReasoning(provider, modelId);
}

/** Model IDs offered to composer/settings reasoning controls for one provider. */
export function reasoningModelIds(
  provider: ProviderConfig & {
    models: readonly string[];
    modelRecords?: ReadonlyArray<{
      modelId: string;
      capabilities: readonly string[];
    }>;
  },
): string[] {
  return provider.models.filter((modelId) =>
    modelReasoningSupported(
      provider,
      modelId,
      provider.modelRecords?.find((record) => record.modelId === modelId),
    ),
  );
}

export function resolveModelContext(
  provider: ProviderConfig,
  modelId: string,
): ModelContext {
  const model = createPiModel(provider, modelId);
  return {
    maxTokens: model.contextWindow,
    modelName: model.name,
    estimated: providerModelIds(provider)?.includes(modelId) !== true,
  };
}

export function buildModel(
  provider: ProviderConfig,
  modelId: string,
): PiModelRuntime {
  const model = createPiModel(provider, modelId);
  const models = createModels({
    credentials: createProviderCredentialStore(provider),
    authContext: ISOLATED_AUTH_CONTEXT,
  });
  const builtin = builtinProvider(provider);
  const credential = parseProviderCredential(provider.apiKey);
  models.setProvider(
    builtin ??
      createProvider({
        id: model.provider,
        name: provider.name,
        baseUrl: model.baseUrl,
        auth: workspaceApiKeyAuth(
          provider,
          credential?.type === "api_key" ? credential.key : credential?.access,
        ),
        models: [model],
        api: providerApi(provider.format),
      }),
  );
  return { models, model };
}
