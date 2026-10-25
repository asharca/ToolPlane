import { z } from "zod";
import { MAX_AGENT_MARKET_ENV_REQUIREMENTS } from "@/lib/agents/market-limits";
import { mcpEnvironmentState } from "@/lib/workspace/mcp-environment";

const resourceKeySchema = z.string().min(1).max(80);
const resourceIdSchema = z.string().min(1).max(200);

const providerRequirementSchema = z
  .object({
    agentKey: resourceKeySchema,
    format: z.string().min(1).max(64),
    model: z.string().min(1).max(240),
    // Kept optional for compatibility with install records created before setup
    // state became dynamic. Neither field is trusted when rendering the guide.
    satisfied: z.boolean().optional(),
    providerId: resourceIdSchema.optional(),
  })
  .strict();

const environmentRequirementSchema = z
  .object({
    deploymentKey: resourceKeySchema,
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    required: z.literal(true),
  })
  .strict();

const runtimeRequirementSchema = z
  .object({
    agentKey: resourceKeySchema,
    kind: z.literal("hermes"),
    setupRequired: z.literal(true),
  })
  .strict();

const resourceMapSchema = z
  .object({
    agents: z.record(resourceKeySchema, resourceIdSchema),
    deployments: z.record(resourceKeySchema, resourceIdSchema),
    skills: z.record(resourceKeySchema, resourceIdSchema),
    toolkits: z.record(resourceKeySchema, resourceIdSchema),
    sandboxes: z.record(resourceKeySchema, resourceIdSchema).default({}),
    sandboxDeployments: z
      .record(resourceKeySchema, resourceIdSchema)
      .default({}),
  })
  .strict();

const marketInstallSchema = z
  .object({
    // This is only the status at install time. Current setup state is always
    // derived from the target resources below.
    status: z.enum(["needs_setup", "ready"]),
    requirements: z
      .object({
        providers: z.array(providerRequirementSchema).max(64),
        environment: z
          .array(environmentRequirementSchema)
          .max(MAX_AGENT_MARKET_ENV_REQUIREMENTS),
        runtimes: z.array(runtimeRequirementSchema).max(64).default([]),
        legacyToolkitConversions: z
          .array(
            z
              .object({
                toolkitKey: resourceKeySchema,
                name: z.string().min(1).max(240),
                agentKeys: z.array(resourceKeySchema).max(64),
                requiresPrivatePackageConversion: z.literal(true),
                requiresReauthorization: z.literal(true),
              })
              .strict(),
          )
          .max(128)
          .default([]),
      })
      .strict(),
    resourceMap: resourceMapSchema,
  })
  .strict()
  .superRefine((install, context) => {
    for (const provider of install.requirements.providers) {
      if (!(provider.agentKey in install.resourceMap.agents)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", "providers"],
          message: "Provider requirement references an unknown agent.",
        });
      }
    }
    for (const environment of install.requirements.environment) {
      if (!(environment.deploymentKey in install.resourceMap.deployments)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", "environment"],
          message: "Environment requirement references an unknown deployment.",
        });
      }
    }
    for (const runtime of install.requirements.runtimes) {
      if (!(runtime.agentKey in install.resourceMap.agents)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", "runtimes"],
          message: "Runtime requirement references an unknown agent.",
        });
      }
    }
    for (const conversion of install.requirements.legacyToolkitConversions) {
      if (
        conversion.agentKeys.some((key) => !(key in install.resourceMap.agents))
      ) {
        context.addIssue({
          code: "custom",
          path: ["requirements", "legacyToolkitConversions"],
          message: "Toolkit conversion references an unknown agent.",
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
  runtimes: Array<{
    agentId: string;
    kind: "hermes";
  }>;
  legacyToolkitConversions: Array<{
    toolkitKey: string;
    name: string;
    agentIds: string[];
    requiresPrivatePackageConversion: true;
    requiresReauthorization: true;
  }>;
};

export type AgentMarketSetupCurrentState = {
  agents: Array<{
    id: string;
    model: string | null;
    provider: { format: string } | null;
    runtimeKind?: string;
    runtime?: { status: string } | null;
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

function guideFromCurrentState(
  install: ParsedMarketInstall,
  current: AgentMarketSetupCurrentState,
): AgentMarketSetupGuide | null {
  const agents = new Map(current.agents.map((agent) => [agent.id, agent]));
  const deployments = new Map(
    current.deployments.map((deployment) => [deployment.id, deployment]),
  );

  const missingProviders = new Map<
    string,
    AgentMarketSetupGuide["missingProviders"][number]
  >();
  for (const requirement of install.requirements.providers) {
    const agentId = install.resourceMap.agents[requirement.agentKey];
    const agent = agents.get(agentId);
    // A missing row is either a deleted install resource or an out-of-workspace
    // id. In both cases it must not be exposed to the client as a navigation id.
    if (!agent) continue;
    if (
      agent.provider?.format === requirement.format &&
      agent.model === requirement.model
    )
      continue;
    const key = `${agentId}\0${requirement.format}\0${requirement.model}`;
    missingProviders.set(key, {
      agentId,
      format: requirement.format,
      model: requirement.model,
    });
  }

  const environment = new Map<
    string,
    AgentMarketSetupGuide["environment"][number]
  >();
  for (const requirement of install.requirements.environment) {
    const deploymentId =
      install.resourceMap.deployments[requirement.deploymentKey];
    const deployment = deployments.get(deploymentId);
    if (!deployment) continue;
    const env = mcpEnvironmentState(deployment.installCfg);
    if (env[requirement.variable] === "configured") continue;
    const key = `${deploymentId}\0${requirement.variable}`;
    environment.set(key, { deploymentId, variable: requirement.variable });
  }

  const runtimes = new Map<string, AgentMarketSetupGuide["runtimes"][number]>();
  for (const requirement of install.requirements.runtimes) {
    const agentId = install.resourceMap.agents[requirement.agentKey];
    const agent = agents.get(agentId);
    if (!agent) continue;
    if (
      agent.runtimeKind === requirement.kind &&
      agent.runtime?.status !== "setup_required"
    )
      continue;
    runtimes.set(`${agentId}\0${requirement.kind}`, {
      agentId,
      kind: requirement.kind,
    });
  }

  const guide = {
    missingProviders: [...missingProviders.values()].sort(
      (a, b) =>
        a.agentId.localeCompare(b.agentId) ||
        a.format.localeCompare(b.format) ||
        a.model.localeCompare(b.model),
    ),
    environment: [...environment.values()].sort(
      (a, b) =>
        a.deploymentId.localeCompare(b.deploymentId) ||
        a.variable.localeCompare(b.variable),
    ),
    runtimes: [...runtimes.values()].sort(
      (a, b) =>
        a.agentId.localeCompare(b.agentId) || a.kind.localeCompare(b.kind),
    ),
    legacyToolkitConversions: install.requirements.legacyToolkitConversions.map(
      (conversion) => ({
        toolkitKey: conversion.toolkitKey,
        name: conversion.name,
        agentIds: conversion.agentKeys
          .map((key) => install.resourceMap.agents[key])
          .filter((id) => agents.has(id)),
        requiresPrivatePackageConversion: true as const,
        requiresReauthorization: true as const,
      }),
    ),
  };

  return guide.missingProviders.length > 0 ||
    guide.environment.length > 0 ||
    guide.runtimes.length > 0 ||
    guide.legacyToolkitConversions.length > 0
    ? guide
    : null;
}

/**
 * Strictly validates persisted marketplace metadata and derives the setup
 * guide from current resource metadata. Credential presence metadata alone
 * determines readiness; no secret values are decrypted or returned.
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

  const agentIds = [
    ...new Set(
      [
        ...parsed.data.requirements.providers.map(
          (requirement) => requirement.agentKey,
        ),
        ...parsed.data.requirements.runtimes.map(
          (requirement) => requirement.agentKey,
        ),
        ...parsed.data.requirements.legacyToolkitConversions.flatMap(
          (requirement) => requirement.agentKeys,
        ),
      ].map((key) => parsed.data.resourceMap.agents[key]),
    ),
  ];
  const deploymentIds = [
    ...new Set(
      parsed.data.requirements.environment.map(
        (requirement) =>
          parsed.data.resourceMap.deployments[requirement.deploymentKey],
      ),
    ),
  ];
  return { agentIds, deploymentIds };
}

export function parseAgentMarketResourceMap(
  input: unknown,
): ParsedMarketInstall["resourceMap"] | null {
  const parsed = resourceMapSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
