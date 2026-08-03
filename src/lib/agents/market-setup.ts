import { z } from 'zod';
import { MAX_AGENT_MARKET_ENV_REQUIREMENTS } from '@/lib/agents/market-limits';

const resourceKeySchema = z.string().min(1).max(80);
const resourceIdSchema = z.string().min(1).max(200);

const providerRequirementSchema = z.object({
  agentKey: resourceKeySchema,
  format: z.string().min(1).max(64),
  model: z.string().min(1).max(240),
  // Kept optional for compatibility with install records created before setup
  // state became dynamic. Neither field is trusted when rendering the guide.
  satisfied: z.boolean().optional(),
  providerId: resourceIdSchema.optional(),
}).strict();

const environmentRequirementSchema = z.object({
  deploymentKey: resourceKeySchema,
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  required: z.literal(true),
}).strict();

const resourceMapSchema = z.object({
  agents: z.record(resourceKeySchema, resourceIdSchema),
  deployments: z.record(resourceKeySchema, resourceIdSchema),
  skills: z.record(resourceKeySchema, resourceIdSchema),
  toolkits: z.record(resourceKeySchema, resourceIdSchema),
}).strict();

const marketInstallSchema = z.object({
  // This is only the status at install time. Current setup state is always
  // derived from the target resources below.
  status: z.enum(['needs_setup', 'ready']),
  requirements: z.object({
    providers: z.array(providerRequirementSchema).max(64),
    environment: z.array(environmentRequirementSchema).max(MAX_AGENT_MARKET_ENV_REQUIREMENTS),
  }).strict(),
  resourceMap: resourceMapSchema,
}).strict().superRefine((install, context) => {
  for (const provider of install.requirements.providers) {
    if (!(provider.agentKey in install.resourceMap.agents)) {
      context.addIssue({
        code: 'custom',
        path: ['requirements', 'providers'],
        message: 'Provider requirement references an unknown agent.',
      });
    }
  }
  for (const environment of install.requirements.environment) {
    if (!(environment.deploymentKey in install.resourceMap.deployments)) {
      context.addIssue({
        code: 'custom',
        path: ['requirements', 'environment'],
        message: 'Environment requirement references an unknown deployment.',
      });
    }
  }
});

type ParsedMarketInstall = z.infer<typeof marketInstallSchema>;

export type AgentMarketSetupGuide = {
  missingProviders: Array<{
    agentId: string;
    format: string;
    model: string;
  }>;
  environment: Array<{
    deploymentId: string;
    variable: string;
  }>;
};

export type AgentMarketSetupCurrentState = {
  agents: Array<{
    id: string;
    model: string | null;
    provider: { format: string } | null;
  }>;
  deployments: Array<{
    id: string;
    installCfg: unknown;
  }>;
};

export type AgentMarketSetupResourceIds = {
  agentIds: string[];
  deploymentIds: string[];
};

function readEnvironment(installCfg: unknown): Record<string, unknown> {
  if (!installCfg || typeof installCfg !== 'object' || Array.isArray(installCfg)) return {};
  const env = (installCfg as Record<string, unknown>).env;
  return env && typeof env === 'object' && !Array.isArray(env)
    ? env as Record<string, unknown>
    : {};
}

function guideFromCurrentState(
  install: ParsedMarketInstall,
  current: AgentMarketSetupCurrentState,
): AgentMarketSetupGuide | null {
  const agents = new Map(current.agents.map((agent) => [agent.id, agent]));
  const deployments = new Map(current.deployments.map((deployment) => [deployment.id, deployment]));

  const missingProviders = new Map<string, AgentMarketSetupGuide['missingProviders'][number]>();
  for (const requirement of install.requirements.providers) {
    const agentId = install.resourceMap.agents[requirement.agentKey];
    const agent = agents.get(agentId);
    // A missing row is either a deleted install resource or an out-of-workspace
    // id. In both cases it must not be exposed to the client as a navigation id.
    if (!agent) continue;
    if (agent.provider?.format === requirement.format && agent.model === requirement.model) continue;
    const key = `${agentId}\0${requirement.format}\0${requirement.model}`;
    missingProviders.set(key, {
      agentId,
      format: requirement.format,
      model: requirement.model,
    });
  }

  const environment = new Map<string, AgentMarketSetupGuide['environment'][number]>();
  for (const requirement of install.requirements.environment) {
    const deploymentId = install.resourceMap.deployments[requirement.deploymentKey];
    const deployment = deployments.get(deploymentId);
    if (!deployment) continue;
    const env = readEnvironment(deployment.installCfg);
    const value = env[requirement.variable];
    if (typeof value === 'string' && value.trim().length > 0) continue;
    const key = `${deploymentId}\0${requirement.variable}`;
    environment.set(key, { deploymentId, variable: requirement.variable });
  }

  const guide = {
    missingProviders: [...missingProviders.values()].sort((a, b) => (
      a.agentId.localeCompare(b.agentId)
      || a.format.localeCompare(b.format)
      || a.model.localeCompare(b.model)
    )),
    environment: [...environment.values()].sort((a, b) => (
      a.deploymentId.localeCompare(b.deploymentId) || a.variable.localeCompare(b.variable)
    )),
  };

  return guide.missingProviders.length > 0 || guide.environment.length > 0
    ? guide
    : null;
}

/**
 * Strictly validates persisted marketplace metadata and derives the setup
 * guide from current, server-only resource state. Secret values in installCfg
 * are used only for presence checks and can never enter the returned DTO.
 */
export function parseAgentMarketSetupGuide(
  input: unknown,
  current: AgentMarketSetupCurrentState,
): AgentMarketSetupGuide | null {
  const parsed = marketInstallSchema.safeParse(input);
  if (!parsed.success) return null;
  return guideFromCurrentState(parsed.data, current);
}

/**
 * Returns the strictly validated target ids needed by the server query. The
 * query must still scope these ids to the current workspace before deriving a
 * client guide.
 */
export function parseAgentMarketSetupResourceIds(
  input: unknown,
): AgentMarketSetupResourceIds | null {
  const parsed = marketInstallSchema.safeParse(input);
  if (!parsed.success) return null;

  const agentIds = [...new Set(parsed.data.requirements.providers.map(
    (requirement) => parsed.data.resourceMap.agents[requirement.agentKey],
  ))];
  const deploymentIds = [...new Set(parsed.data.requirements.environment.map(
    (requirement) => parsed.data.resourceMap.deployments[requirement.deploymentKey],
  ))];
  return { agentIds, deploymentIds };
}
