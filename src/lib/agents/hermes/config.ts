export type HermesProviderProjection = {
  format: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type HermesConfigProjection = {
  maxSteps: number;
  provider: HermesProviderProjection | null;
  mcpUrl: string;
  mcpToken: string;
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizedBaseUrl(provider: HermesProviderProjection): string {
  let value = provider.baseUrl.trim().replace(/\/$/, '');
  try {
    const url = new URL(value);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal';
      value = url.toString().replace(/\/$/, '');
    }
  } catch {
    // Provider validation owns malformed URLs; preserve the configured value here.
  }
  return provider.format === 'anthropic' ? value.replace(/\/v1$/, '') : value;
}

export function renderHermesConfig(input: HermesConfigProjection): string {
  const maxTurns = Math.max(1, Math.min(Math.trunc(input.maxSteps) || 1, 500));
  const model = input.provider
    ? [
        'model:',
        '  provider: custom',
        `  default: ${yamlString(input.provider.model)}`,
        `  base_url: ${yamlString(normalizedBaseUrl(input.provider))}`,
        `  api_key: ${yamlString(input.provider.apiKey)}`,
        `  api_mode: ${input.provider.format === 'anthropic' ? 'anthropic_messages' : 'chat_completions'}`,
      ]
    : [];

  return [
    ...model,
    'agent:',
    `  max_turns: ${maxTurns}`,
    'approvals:',
    '  mode: smart',
    'tool_loop_guardrails:',
    '  hard_stop_enabled: true',
    '  hard_stop_after:',
    '    exact_failure: 5',
    '    idempotent_no_progress: 5',
    'mcp_servers:',
    '  toolplane:',
    `    url: ${yamlString(input.mcpUrl)}`,
    '    headers:',
    `      Authorization: ${yamlString(`Bearer ${input.mcpToken}`)}`,
    '',
  ].join('\n');
}

export function renderHermesMcpBindingFingerprint(deploymentIds: string[]): string {
  return JSON.stringify([...new Set(deploymentIds)].sort());
}

export function renderHermesSkillBundle(skillNames: string[]): string {
  return [
    'name: toolplane-agent',
    'description: "Skills selected for this ToolPlane agent"',
    'skills:',
    ...skillNames.sort().map((name) => `  - ${yamlString(`toolplane-agent/${name}`)}`),
    'instruction: |',
    '  Use the skills selected for this ToolPlane agent when they match the task.',
    '  ToolPlane MCP tools are available through the "toolplane" MCP server.',
    '',
  ].join('\n');
}
