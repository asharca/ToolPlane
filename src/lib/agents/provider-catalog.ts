import 'server-only';

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { PiModelReference } from './model-catalog';

export type ProviderPreset = {
  format: string;
  name: string;
  baseUrl: string;
};

export const CUSTOM_PROVIDER_PRESETS: ProviderPreset[] = [
  { format: 'openai', name: 'OpenAI-compatible', baseUrl: '' },
  { format: 'openai-responses', name: 'OpenAI Responses-compatible', baseUrl: '' },
  { format: 'anthropic', name: 'Anthropic-compatible', baseUrl: '' },
];

export function piProviderPresets(): ProviderPreset[] {
  return builtinProviders().map((provider) => ({
    format: `pi:${provider.id}`,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
  }));
}

export function piProviderId(format: string): string | null {
  return format.startsWith('pi:') ? format.slice(3) : null;
}

export function providerPreset(format: string): ProviderPreset | undefined {
  return [...piProviderPresets(), ...CUSTOM_PROVIDER_PRESETS]
    .find((preset) => preset.format === format);
}

function hostname(baseUrl: string | undefined): string | null {
  try {
    return new URL(baseUrl ?? '').hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function matchingPiModelReferences(
  format: string,
  queries: string[],
  baseUrl?: string,
  providerName?: string,
): PiModelReference[] {
  const names = [...new Set(queries.map((query) => query.trim().toLowerCase()).filter(Boolean))];
  if (!names.length) return [];
  const providers = builtinProviders().map((provider) => ({ provider, models: provider.getModels() }));
  const selectedProvider = piProviderId(format);
  const namedProvider = providerName
    ? providers.find(({ provider }) => provider.id.toLowerCase() === providerName.trim().toLowerCase())
    : undefined;
  const host = hostname(baseUrl);
  const hostProviders = host ? providers.filter(({ provider, models }) => (
    hostname(provider.baseUrl) === host || models.some((model) => hostname(model.baseUrl) === host)
  )) : [];
  const scoped = selectedProvider !== null
    ? providers.filter(({ provider }) => provider.id === selectedProvider)
    : namedProvider ? [namedProvider] : hostProviders.length ? hostProviders : providers;
  // A compatible proxy uses the protocol's native catalog as its reference,
  // not whichever reseller happens to appear first in Pi's provider list.
  const fallbackProvider = selectedProvider === null && !namedProvider && !hostProviders.length
    ? format === 'openai-responses' ? 'openai' : format
    : null;

  for (const name of names) {
    const byId = scoped.flatMap(({ provider, models }) => models
      .filter((model) => model.id.toLowerCase() === name)
      .map((model) => ({ provider, model })));
    const matches = byId.length ? byId : scoped.flatMap(({ provider, models }) => models
      .filter((model) => model.name.toLowerCase() === name)
      .map((model) => ({ provider, model })));
    const first = matches[0]?.model;
    const sameMetadata = first && matches.every(({ model }) => (
      model.contextWindow === first.contextWindow
      && model.maxTokens === first.maxTokens
      && model.reasoning === first.reasoning
      && JSON.stringify(model.input) === JSON.stringify(first.input)
      && JSON.stringify(model.cost) === JSON.stringify(first.cost)
    ));
    const match = matches.find(({ provider }) => provider.id === fallbackProvider)
      ?? (matches.length === 1 || sameMetadata ? matches[0] : undefined);
    if (matches.length && !match) return [];
    if (!match) continue;
    const { provider, model } = match;
    // Pi 0.87.1 lists the 272K pricing threshold as these models' context window.
    // OpenAI documents 1.05M: https://developers.openai.com/api/docs/models/gpt-6-astra
    // The same maximum is documented on the gpt-6-sol and gpt-6-luna model pages.
    const contextWindow = provider.id === 'openai' && model.contextWindow === 272_000
      && ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].includes(model.id)
      ? 1_050_000 : model.contextWindow;
    return [{
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow,
      maxOutputTokens: model.maxTokens,
      cost: model.cost,
    }];
  }
  return [];
}
