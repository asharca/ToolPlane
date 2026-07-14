import 'server-only';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export type ProviderConfig = {
  name: string;
  format: string;
  baseUrl: string;
  apiKey: string;
};

export function buildModel(provider: ProviderConfig, modelId: string): LanguageModel {
  if (provider.format === 'anthropic') {
    return createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
  }
  if (provider.format === 'openai-responses') {
    return createOpenAI({
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey,
    }).responses(modelId);
  }
  return createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
  })(modelId);
}
