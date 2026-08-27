import 'server-only';
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { piProviderId } from './provider-catalog';

export type ProviderConfig = {
  id?: string;
  name: string;
  format: string;
  baseUrl: string;
  apiKey: string;
};

export type PiModel = Model<Api>;
export type PiModelRuntime = { models: MutableModels; model: PiModel };
export type ModelContext = { maxTokens: number; modelName: string; estimated: boolean };

function providerId(provider: ProviderConfig): string {
  return provider.id ?? `toolplane-${provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'provider'}`;
}

function configuredBaseUrl(provider: ProviderConfig, fallback?: string): string | undefined {
  return provider.baseUrl.trim().replace(/\/+$/, '') || fallback;
}

function modelApi(format: string): 'anthropic-messages' | 'openai-completions' | 'openai-responses' {
  if (format === 'anthropic') return 'anthropic-messages';
  if (format === 'openai-responses') return 'openai-responses';
  return 'openai-completions';
}

function providerApi(format: string): ProviderStreams {
  if (format === 'anthropic') return anthropicMessagesApi();
  if (format === 'openai-responses') return openAIResponsesApi();
  return openAICompletionsApi();
}

function workspaceApiKeyAuth(provider: ProviderConfig) {
  return {
    apiKey: {
      name: provider.name,
      resolve: async () => provider.apiKey ? { auth: { apiKey: provider.apiKey } } : undefined,
    },
  };
}

function builtinProvider(provider: ProviderConfig): Provider<Api> | null {
  const builtinId = piProviderId(provider.format);
  if (!builtinId) return null;
  const source = builtinProviders().find((candidate) => candidate.id === builtinId);
  if (!source) return null;

  const id = providerId(provider);
  const baseUrl = configuredBaseUrl(provider, source.baseUrl);
  const rebase = (model: PiModel): PiModel => ({
    ...model,
    provider: source.id,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const models = source.getModels().map((model) => ({
    ...model,
    provider: id,
    ...(baseUrl ? { baseUrl } : {}),
  })) as PiModel[];

  return {
    ...source,
    id,
    name: provider.name,
    ...(baseUrl ? { baseUrl } : {}),
    auth: provider.apiKey ? workspaceApiKeyAuth(provider) : source.auth,
    getModels: () => models,
    stream: (model, context, options) => source.stream(rebase(model), context, options),
    streamSimple: (model, context, options) => source.streamSimple(rebase(model), context, options),
    ...(source.fetchDeferred ? {
      fetchDeferred: (model, handle, options) => source.fetchDeferred!(rebase(model), handle, options),
    } : {}),
    ...(source.cancelDeferred ? {
      cancelDeferred: (model, handle, options) => source.cancelDeferred!(rebase(model), handle, options),
    } : {}),
  } as Provider<Api>;
}

export function providerModelIds(provider: ProviderConfig): string[] | null {
  return builtinProvider(provider)?.getModels().map((model) => model.id) ?? null;
}

export function createPiModel(provider: ProviderConfig, modelId: string): PiModel {
  const builtin = builtinProvider(provider);
  if (builtin) {
    const template = builtin.getModels().find((model) => model.id === modelId) ?? builtin.getModels()[0];
    if (template) return { ...template, id: modelId, name: modelId };
  }
  return {
    id: modelId,
    name: modelId,
    api: modelApi(provider.format),
    provider: providerId(provider),
    baseUrl: configuredBaseUrl(provider) ?? '',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as PiModel;
}

export function resolveModelContext(provider: ProviderConfig, modelId: string): ModelContext {
  const model = createPiModel(provider, modelId);
  return {
    maxTokens: model.contextWindow,
    modelName: model.name,
    estimated: providerModelIds(provider)?.includes(modelId) !== true,
  };
}

export function buildModel(provider: ProviderConfig, modelId: string): PiModelRuntime {
  const model = createPiModel(provider, modelId);
  const models = createModels();
  const builtin = builtinProvider(provider);
  models.setProvider(builtin ?? createProvider({
    id: model.provider,
    name: provider.name,
    baseUrl: model.baseUrl,
    auth: workspaceApiKeyAuth(provider),
    models: [model],
    api: providerApi(provider.format),
  }));
  return { models, model };
}
