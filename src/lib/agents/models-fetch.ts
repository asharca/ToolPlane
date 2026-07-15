export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

export function modelsHeaders(format: string, apiKey: string): Record<string, string> {
  if (format === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${apiKey}` };
}

export function parseModelList(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string');
}

export type ProviderModelFetchConfig = {
  format: string;
  baseUrl: string;
  apiKey: string;
};

export type ProviderModelFetchResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'status'; status: number }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'unreachable' };

export async function fetchProviderModels(
  provider: ProviderModelFetchConfig,
  timeoutMs = 10000,
): Promise<ProviderModelFetchResult> {
  try {
    const res = await fetch(modelsEndpoint(provider.baseUrl), {
      headers: modelsHeaders(provider.format, provider.apiKey),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: 'status', status: res.status };
    const models = parseModelList(await res.json());
    if (models.length === 0) return { ok: false, reason: 'empty' };
    return { ok: true, models };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
