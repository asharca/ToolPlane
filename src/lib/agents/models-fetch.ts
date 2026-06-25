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
