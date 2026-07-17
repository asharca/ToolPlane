export type HermesProviderProjection = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

export type HermesConfigProjection = {
  maxSteps: number;
  providers: HermesProviderProjection[];
  mcpUrl: string;
  mcpToken: string;
};

const TOOLPLANE_PROVIDER_PREFIX = 'toolplane-';

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

function hermesApiMode(format: string): string {
  if (format === 'anthropic') return 'anthropic_messages';
  if (format === 'openai-responses') return 'codex_responses';
  return 'chat_completions';
}

export function hermesProviderName(providerId: string): string {
  const suffix = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${TOOLPLANE_PROVIDER_PREFIX}${suffix || 'provider'}`;
}

export function renderHermesConfig(input: HermesConfigProjection): string {
  const maxTurns = Math.max(1, Math.min(Math.trunc(input.maxSteps) || 1, 500));
  const providers = input.providers.map((provider) => ({
    ...provider,
    models: [...new Set(provider.models.map((model) => model.trim()).filter(Boolean))],
    key: hermesProviderName(provider.id),
  }));
  const bootstrapProvider = providers.find((provider) => provider.models.length > 0);
  const model = bootstrapProvider
    ? [
        'model:',
        `  provider: ${yamlString(`custom:${bootstrapProvider.key}`)}`,
        `  default: ${yamlString(bootstrapProvider.models[0])}`,
      ]
    : [];
  const providerInventory = providers.length === 0
    ? ['providers: {}']
    : [
        'providers:',
        ...providers.flatMap((provider) => [
          `  ${yamlString(provider.key)}:`,
          `    name: ${yamlString(provider.name)}`,
          `    api: ${yamlString(normalizedBaseUrl(provider))}`,
          `    api_key: ${yamlString(provider.apiKey)}`,
          `    transport: ${hermesApiMode(provider.format)}`,
          `    discover_models: ${provider.models.length === 0 ? 'true' : 'false'}`,
          ...(provider.models.length > 0
            ? [
                `    default_model: ${yamlString(provider.models[0])}`,
                '    models:',
                ...provider.models.map((providerModel) => `      ${yamlString(providerModel)}: {}`),
              ]
            : ['    models: {}']),
        ]),
      ];

  return [
    ...model,
    ...providerInventory,
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
