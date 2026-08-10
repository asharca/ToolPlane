export type AgentEndpointToolPolicy = Record<string, readonly string[]>;

export const AGENT_ENDPOINT_RUNTIME_MANAGED_BY = 'agent-endpoint-runtime';

export function isAgentEndpointRuntimeSandboxConfig(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { managedBy?: unknown }).managedBy === AGENT_ENDPOINT_RUNTIME_MANAGED_BY,
  );
}

export function parseAgentEndpointToolPolicy(value: unknown): AgentEndpointToolPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const policy: Record<string, string[]> = {};
  for (const [deploymentId, names] of Object.entries(value)) {
    if (!deploymentId || !Array.isArray(names)) continue;
    const allowed = [...new Set(names.flatMap((name) => (
      typeof name === 'string' && name.trim() ? [name.trim()] : []
    )))].slice(0, 1_000);
    if (allowed.length > 0) policy[deploymentId] = allowed;
  }
  return policy;
}

export function endpointAllowsTool(
  policy: AgentEndpointToolPolicy | null | undefined,
  deploymentId: string,
  toolName: string,
): boolean {
  if (!policy) return true;
  return policy[deploymentId]?.includes(toolName) ?? false;
}

export function intersectEndpointTools<T extends { name: string }>(
  tools: readonly T[],
  policy: AgentEndpointToolPolicy | null | undefined,
  deploymentId: string,
): T[] {
  if (!policy) return [...tools];
  const allowed = new Set(policy[deploymentId] ?? []);
  return tools.filter((tool) => allowed.has(tool.name));
}
