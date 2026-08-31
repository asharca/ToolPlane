export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpToolCatalogResult =
  | { ok: true; tools: McpToolDefinition[] }
  | { ok: false; tools: [] };

const MAX_TOOLS = 1_000;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_SCHEMA_BYTES = 256_000;
const MAX_CATALOG_BYTES = 4_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result && result.length <= maxLength ? result : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCHEMA_BYTES) return undefined;
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function annotations(value: unknown): McpToolAnnotations | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: McpToolAnnotations = {};
  const title = text(source.title, MAX_NAME_LENGTH);
  if (title) result.title = title;
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function validLiveAnnotations(value: unknown): boolean {
  if (value === undefined) return true;
  const source = record(value);
  if (!source) return false;
  if (source.title !== undefined && text(source.title, MAX_NAME_LENGTH) !== source.title) return false;
  return ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
    .every((key) => source[key] === undefined || typeof source[key] === 'boolean');
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value) === secret;
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret));
  const source = record(value);
  return source
    ? Object.entries(source).some(([key, entry]) => key.includes(secret) || containsSecret(entry, secret))
    : false;
}

/** Parse untrusted tools/list or stored JSON into the fields safe for display and publication. */
export function parseMcpToolCatalog(value: unknown): McpToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const tools: McpToolDefinition[] = [];
  const seen = new Set<string>();
  let catalogBytes = 0;
  for (const candidate of value.slice(0, MAX_TOOLS)) {
    const source = record(candidate);
    const name = text(source?.name, MAX_NAME_LENGTH);
    if (!source || !name || seen.has(name)) continue;
    seen.add(name);
    const title = text(source.title, MAX_NAME_LENGTH);
    const description = text(source.description, MAX_DESCRIPTION_LENGTH);
    const inputSchema = jsonObject(source.inputSchema);
    const outputSchema = jsonObject(source.outputSchema);
    const toolAnnotations = annotations(source.annotations);
    const tool: McpToolDefinition = {
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(toolAnnotations ? { annotations: toolAnnotations } : {}),
    };
    const toolBytes = new TextEncoder().encode(JSON.stringify(tool)).byteLength;
    if (catalogBytes + toolBytes > MAX_CATALOG_BYTES) break;
    catalogBytes += toolBytes;
    tools.push(tool);
  }
  return tools;
}

/** Strict result for live discovery: incomplete or malformed catalogs must never replace a snapshot. */
export function parseMcpToolCatalogResult(value: unknown): McpToolCatalogResult {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return { ok: false, tools: [] };
  for (const candidate of value) {
    const source = record(candidate);
    if (!source) return { ok: false, tools: [] };
    const name = text(source.name, MAX_NAME_LENGTH);
    if (!name || name !== source.name) return { ok: false, tools: [] };
    if (source.title !== undefined && text(source.title, MAX_NAME_LENGTH) !== source.title) {
      return { ok: false, tools: [] };
    }
    if (source.description !== undefined && text(source.description, MAX_DESCRIPTION_LENGTH) === undefined) {
      return { ok: false, tools: [] };
    }
    if (!validLiveAnnotations(source.annotations)) return { ok: false, tools: [] };
    if (jsonObject(source.inputSchema) === undefined) return { ok: false, tools: [] };
    if (source.outputSchema !== undefined && jsonObject(source.outputSchema) === undefined) {
      return { ok: false, tools: [] };
    }
  }
  const tools = parseMcpToolCatalog(value);
  return tools.length === value.length ? { ok: true, tools } : { ok: false, tools: [] };
}

export function redactMcpToolCatalogResult(
  value: unknown,
  secretValues: readonly string[],
): McpToolCatalogResult {
  const parsed = parseMcpToolCatalogResult(value);
  if (!parsed.ok) return parsed;
  const shortSecrets = [...new Set(secretValues.filter((secret) => secret.length > 0 && secret.length < 4))];
  if (shortSecrets.some((secret) => containsSecret(parsed.tools, secret))) return { ok: false, tools: [] };
  const secrets = [...new Set(secretValues.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length);
  if (!secrets.length) return parsed;
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') {
      return secrets.reduce((textValue, secret) => textValue.split(secret).join('[REDACTED]'), candidate);
    }
    if (
      (candidate === null || typeof candidate === 'number' || typeof candidate === 'boolean')
      && secrets.includes(String(candidate))
    ) return '[REDACTED]';
    if (Array.isArray(candidate)) return candidate.map(redact);
    const source = record(candidate);
    return source
      ? Object.fromEntries(Object.entries(source).map(([key, entry]) => [
          redact(key) as string,
          redact(entry),
        ]))
      : candidate;
  };
  const redacted = parseMcpToolCatalogResult(redact(parsed.tools));
  if (
    !redacted.ok
    || redacted.tools.some((tool, index) => tool.name !== parsed.tools[index]?.name)
    || secretValues.some((secret) => secret && containsSecret(redacted.tools, secret))
  ) return { ok: false, tools: [] };
  return redacted;
}

export function redactMcpToolCatalog(value: unknown, secretValues: readonly string[]): McpToolDefinition[] {
  return redactMcpToolCatalogResult(value, secretValues).tools;
}

/** Read only the non-sensitive tool snapshot; never expose the surrounding install config. */
export function readMcpToolCatalog(installCfg: unknown): McpToolDefinition[] {
  return parseMcpToolCatalog(record(installCfg)?.toolCatalog);
}

export function hasMcpToolCatalog(installCfg: unknown): boolean {
  const toolCatalog = record(installCfg)?.toolCatalog;
  return Array.isArray(toolCatalog) && parseMcpToolCatalogResult(toolCatalog).ok;
}

export function hasVerifiedMcpToolCatalog(server: {
  installCfg: unknown;
  verifiedAt: unknown;
  verifiedTools: unknown;
} | null | undefined): boolean {
  return Boolean(
    server?.verifiedAt
    && Number.isInteger(server.verifiedTools)
    && (server.verifiedTools as number) >= 0
    && hasMcpToolCatalog(server.installCfg)
    && readMcpToolCatalog(server.installCfg).length === server.verifiedTools,
  );
}

export function withMcpToolCatalog(
  installCfg: unknown,
  value: unknown,
): Record<string, unknown> {
  return {
    ...(record(installCfg) ?? {}),
    toolCatalog: parseMcpToolCatalog(value),
  };
}
