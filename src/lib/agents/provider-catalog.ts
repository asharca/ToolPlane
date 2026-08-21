import 'server-only';

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

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
