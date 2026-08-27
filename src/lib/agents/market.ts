import 'server-only';

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { agentReleaseChecksum as calculateAgentReleaseChecksum } from '@/lib/agents/market-artifact';
import { HERMES_RUNTIME_KIND, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { createAgentRecords } from '@/lib/agents/mutations';
import { MAX_AGENT_MARKET_ENV_REQUIREMENTS } from '@/lib/agents/market-limits';
import { DEFAULT_SANDBOX_IMAGE, sandboxVolumeName } from '@/lib/sandboxes/runtime';
import {
  buildInstalledSkillMarkdown,
  buildSkillMarkdown,
  installedSkillExtraFiles,
} from '@/lib/skills/artifact';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';

export const AGENT_MARKET_MANIFEST_VERSION = 1 as const;

const MAX_GRAPH_AGENTS = 64;
const MAX_GRAPH_RESOURCES = 512;
const MAX_MANIFEST_BYTES = 4_000_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const modelRequirementSchema = z.object({
  format: z.string().min(1).max(64),
  model: z.string().min(1).max(240),
}).strict();

const hermesRuntimeSchema = z.object({
  kind: z.literal(HERMES_RUNTIME_KIND),
  image: z.string().min(1).max(255),
}).strict();

const piRuntimeSchema = z.object({
  kind: z.literal('pi'),
}).strict();

const portableRuntimeSchema = z.discriminatedUnion('kind', [
  piRuntimeSchema,
  hermesRuntimeSchema,
]);

const hermesProviderRequirementSchema = z.object({
  format: z.string().min(1).max(64),
}).strict();

const portableAgentSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  slug: z.string().min(1).max(120),
  systemPrompt: z.string().max(200_000).nullable(),
  maxSteps: z.number().int().min(0).max(1000),
  modelRequirement: modelRequirementSchema.nullable(),
  // Optional only for checksum-compatible parsing of legacy v1 releases.
  // Every newly published release writes an explicit Pi or Hermes runtime.
  runtime: portableRuntimeSchema.optional(),
  modelProviderRequirements: z.array(hermesProviderRequirementSchema).max(64).optional(),
  deploymentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  skillKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  toolkitKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  subAgentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_AGENTS),
}).strict().superRefine((agent, context) => {
  if (agent.runtime?.kind === HERMES_RUNTIME_KIND) {
    if (agent.systemPrompt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['systemPrompt'],
        message: 'Hermes runtime prompts are private and cannot be included in a market release.',
      });
    }
    if (agent.modelRequirement !== null) {
      context.addIssue({
        code: 'custom',
        path: ['modelRequirement'],
        message: 'Hermes runtimes use model provider links instead of a single model requirement.',
      });
    }
  } else if (agent.modelProviderRequirements !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['modelProviderRequirements'],
      message: 'Only Hermes runtimes may declare model provider requirements.',
    });
  }
});

const portableDeploymentSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  catalogSlug: z.string().min(1).max(240),
  source: z.enum(['npm', 'pypi', 'github', 'docker']),
  sourceRef: z.string().min(1).max(2000),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(256),
  publicEnv: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().max(50_000),
  ),
  startCommand: z.string().min(1).max(4000).optional(),
  network: z.literal('none').optional(),
  mcpToolExposure: z.enum(['all', 'allowlist']),
  mcpAllowedTools: z.array(z.string().min(1).max(240)).max(1000),
}).strict();

const skillFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(1_000_000),
  encoding: z.literal('base64').optional(),
}).strict();

const portableSkillSchema = z.object({
  key: z.string().min(1).max(80),
  origin: z.enum(['catalog', 'custom']),
  catalogSlug: z.string().min(1).max(240).optional(),
  sourceSha: z.string().min(1).max(240).optional(),
  name: z.string().min(1).max(240),
  slug: z.string().min(1).max(120),
  description: z.string().nullable(),
  content: z.string().max(1_000_000),
  files: z.array(skillFileSchema),
  userInvocable: z.boolean(),
  agentInvocable: z.boolean(),
  effort: z.string().min(1).max(64),
}).strict();

const portableToolkitSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  slug: z.string().min(1).max(120),
  enabled: z.boolean(),
  deploymentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  skillKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
}).strict();

const agentReleaseManifestSchema = z.object({
  schemaVersion: z.literal(AGENT_MARKET_MANIFEST_VERSION),
  rootAgentKey: z.string().min(1).max(80),
  agents: z.array(portableAgentSchema).min(1).max(MAX_GRAPH_AGENTS),
  deployments: z.array(portableDeploymentSchema).max(MAX_GRAPH_RESOURCES),
  skills: z.array(portableSkillSchema).max(MAX_GRAPH_RESOURCES),
  toolkits: z.array(portableToolkitSchema).max(MAX_GRAPH_RESOURCES),
}).strict().superRefine((manifest, context) => {
  const environmentRequirementCount = manifest.deployments.reduce(
    (total, deployment) => total + deployment.requiredEnv.length,
    0,
  );
  if (environmentRequirementCount > MAX_AGENT_MARKET_ENV_REQUIREMENTS) {
    context.addIssue({
      code: 'custom',
      path: ['deployments'],
      message: `Agent releases may require at most ${MAX_AGENT_MARKET_ENV_REQUIREMENTS} environment variables.`,
    });
  }
});

const agentReleaseSummarySchema = z.object({
  agentCount: z.number().int().nonnegative(),
  subAgentCount: z.number().int().nonnegative(),
  deploymentCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
  toolkitCount: z.number().int().nonnegative(),
  resourceCount: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  models: z.array(modelRequirementSchema),
  runtimes: z.array(z.enum(['native', 'pi', HERMES_RUNTIME_KIND])).min(1),
}).strict();

const agentInstallRequirementsSchema = z.object({
  providers: z.array(z.object({
    agentKey: z.string(),
    format: z.string(),
    model: z.string(),
    satisfied: z.boolean(),
    providerId: z.string().optional(),
  }).strict()),
  environment: z.array(z.object({
    deploymentKey: z.string(),
    variable: z.string(),
    required: z.literal(true),
  }).strict()).max(MAX_AGENT_MARKET_ENV_REQUIREMENTS),
  runtimes: z.array(z.object({
    agentKey: z.string(),
    kind: z.literal(HERMES_RUNTIME_KIND),
    setupRequired: z.literal(true),
  }).strict()).default([]),
}).strict();

const agentInstallResourceMapSchema = z.object({
  agents: z.record(z.string(), z.string()),
  deployments: z.record(z.string(), z.string()),
  skills: z.record(z.string(), z.string()),
  toolkits: z.record(z.string(), z.string()),
}).strict();

export type AgentModelRequirement = z.infer<typeof modelRequirementSchema>;
export type PortableAgentDefinition = z.infer<typeof portableAgentSchema>;
export type PortableDeploymentDefinition = z.infer<typeof portableDeploymentSchema>;
export type PortableSkillDefinition = z.infer<typeof portableSkillSchema>;
export type PortableToolkitDefinition = z.infer<typeof portableToolkitSchema>;
export type AgentReleaseManifestV1 = z.infer<typeof agentReleaseManifestSchema>;
export type AgentReleaseSummary = z.infer<typeof agentReleaseSummarySchema>;
export type AgentInstallRequirements = z.infer<typeof agentInstallRequirementsSchema>;
export type AgentInstallResourceMap = z.infer<typeof agentInstallResourceMapSchema>;

export type AgentPortabilityIssueCode =
  | 'agent_not_found'
  | 'cross_workspace_agent'
  | 'cross_workspace_provider'
  | 'cross_workspace_deployment'
  | 'cross_workspace_skill'
  | 'cross_workspace_toolkit'
  | 'unsupported_runtime'
  | 'external_sandbox'
  | 'custom_mcp'
  | 'unverified_catalog_mcp'
  | 'invalid_catalog_recipe'
  | 'invalid_skill_bundle'
  | 'invalid_definition'
  | 'graph_too_large'
  | 'manifest_too_large';

export type AgentPortabilityIssue = {
  code: AgentPortabilityIssueCode;
  path: string;
  message: string;
  resourceId?: string;
};

export type AgentPortabilityAssessment =
  | { portable: true; issues: []; manifest: AgentReleaseManifestV1; summary: AgentReleaseSummary }
  | { portable: false; issues: AgentPortabilityIssue[] };

export type AgentMarketErrorCode =
  | 'not_authorized'
  | 'agent_not_found'
  | 'not_portable'
  | 'listing_not_found'
  | 'listing_conflict'
  | 'release_not_found'
  | 'listing_unavailable'
  | 'invalid_manifest'
  | 'idempotency_conflict'
  | 'target_workspace_not_found'
  | 'install_failed';

export class AgentMarketError extends Error {
  readonly code: AgentMarketErrorCode;
  readonly details?: unknown;

  constructor(code: AgentMarketErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentMarketError';
    this.code = code;
    this.details = details;
  }
}

export type AgentMarketListingSummary = {
  id: string;
  slug: string;
  directorySlug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  categories: { slug: string; name: string }[];
  curated: boolean;
  isFeatured: boolean;
  publishedAt: Date;
  updatedAt: Date;
  installCount: number;
  workspaceSlug: string | null;
  workspaceName: string | null;
  latestReleaseId: string;
  latestVersion: number;
  releaseSummary: AgentReleaseSummary;
};

export type AgentMarketListingDetail = {
  listing: {
    id: string;
    slug: string;
    directorySlug: string;
    name: string;
    author: string | null;
    summary: string | null;
    iconUrl: string | null;
    tags: string[];
    categories: { slug: string; name: string }[];
    curated: boolean;
    isFeatured: boolean;
    status: 'published';
    publishedAt: Date;
    updatedAt: Date;
    installCount: number;
  };
  workspace: { slug: string; name: string } | null;
  release: {
    id: string;
    version: number;
    manifestVersion: 1;
    checksum: string;
    publishedAt: Date;
    summary: AgentReleaseSummary;
  };
  manifest: AgentReleaseManifestV1;
};

export type PublisherAgentListing = {
  id: string;
  slug: string;
  directorySlug: string;
  name: string;
  author: string | null;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  status: string;
  latestVersion: number;
  publishedAt: Date | null;
  installCount: number;
  latestRelease: null | {
    id: string;
    version: number;
    manifestVersion: number;
    checksum: string;
    publishedAt: Date;
    summary: AgentReleaseSummary;
  };
  pendingRelease: null | {
    id: string;
    version: number;
    manifestVersion: number;
    checksum: string;
    publishedAt: Date;
    name: string;
    summary: string | null;
    iconUrl: string | null;
    tags: string[];
    reviewStatus: string;
    summaryData: AgentReleaseSummary;
  };
};

const MARKET_DEPLOYMENT_SELECT = {
  id: true,
  workspaceId: true,
  serverId: true,
  name: true,
  mcpToolExposure: true,
  mcpAllowedTools: true,
  server: {
    select: {
      id: true,
      slug: true,
      name: true,
      verifiedAt: true,
      installCfg: true,
    },
  },
} satisfies Prisma.DeploymentSelect;

const MARKET_INSTALLED_SKILL_SELECT = {
  id: true,
  workspaceId: true,
  skillId: true,
  name: true,
  slug: true,
  description: true,
  content: true,
  files: true,
  userInvocable: true,
  agentInvocable: true,
  effort: true,
  source: true,
  skill: {
    select: {
      id: true,
      slug: true,
      name: true,
      author: true,
      description: true,
      content: true,
      files: true,
      sourceSha: true,
    },
  },
} satisfies Prisma.InstalledSkillSelect;

const MARKET_TOOLKIT_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  slug: true,
  enabled: true,
  servers: { select: { deployment: { select: MARKET_DEPLOYMENT_SELECT } } },
  skills: { select: { installedSkill: { select: MARKET_INSTALLED_SKILL_SELECT } } },
} satisfies Prisma.ToolkitSelect;

const MARKET_AGENT_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  slug: true,
  runtimeKind: true,
  systemPrompt: true,
  model: true,
  maxSteps: true,
  provider: { select: { id: true, workspaceId: true, format: true } },
  modelProviders: {
    select: { provider: { select: { id: true, workspaceId: true, format: true } } },
  },
  runtime: {
    select: {
      id: true,
      workspaceId: true,
      kind: true,
      image: true,
      sandbox: { select: { workspaceId: true } },
    },
  },
  sandboxes: {
    select: { sandbox: { select: { id: true, workspaceId: true, kind: true, network: true } } },
  },
  servers: { select: { deployment: { select: MARKET_DEPLOYMENT_SELECT } } },
  skills: { select: { installedSkill: { select: MARKET_INSTALLED_SKILL_SELECT } } },
  toolkits: { select: { toolkit: { select: MARKET_TOOLKIT_SELECT } } },
  subAgents: { select: { child: { select: { id: true, workspaceId: true, name: true } } } },
} satisfies Prisma.AgentSelect;

type LoadedMarketAgent = Prisma.AgentGetPayload<{ select: typeof MARKET_AGENT_SELECT }>;
type LoadedMarketDeployment = Prisma.DeploymentGetPayload<{ select: typeof MARKET_DEPLOYMENT_SELECT }>;
type LoadedMarketSkill = Prisma.InstalledSkillGetPayload<{ select: typeof MARKET_INSTALLED_SKILL_SELECT }>;
type LoadedMarketToolkit = Prisma.ToolkitGetPayload<{ select: typeof MARKET_TOOLKIT_SELECT }>;

type CollectorState = {
  workspaceId: string;
  issues: AgentPortabilityIssue[];
  issueKeys: Set<string>;
  agentKeys: Map<string, string>;
  deploymentKeys: Map<string, string | null>;
  skillKeys: Map<string, string | null>;
  toolkitKeys: Map<string, string | null>;
  agents: PortableAgentDefinition[];
  deployments: PortableDeploymentDefinition[];
  skills: PortableSkillDefinition[];
  toolkits: PortableToolkitDefinition[];
};

function pushIssue(state: CollectorState, issue: AgentPortabilityIssue) {
  const key = `${issue.code}:${issue.resourceId ?? ''}:${issue.path}`;
  if (state.issueKeys.has(key)) return;
  state.issueKeys.add(key);
  state.issues.push(issue);
}

function nextKey(prefix: string, size: number): string {
  return `${prefix}_${size + 1}`;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug || fallback;
}

async function uniqueDirectorySlug(
  tx: Prisma.TransactionClient,
  desired: string,
): Promise<string> {
  const base = slugify(desired, 'agent');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const conflict = await tx.agentListing.findUnique({
      where: { directorySlug: candidate },
      select: { id: true },
    });
    if (!conflict) return candidate;
  }
  throw new AgentMarketError('listing_conflict', 'Could not allocate a unique agent directory slug.');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortedRecord(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export function agentReleaseChecksum(manifest: AgentReleaseManifestV1): string {
  return calculateAgentReleaseChecksum(manifest);
}

function portableAgentRuntimeKind(agent: PortableAgentDefinition): 'pi' | 'hermes' {
  // Legacy v1 manifests omitted runtime to mean the in-process harness.
  return agent.runtime?.kind ?? 'pi';
}

export function parseAgentReleaseManifest(raw: unknown, expectedChecksum?: string): AgentReleaseManifestV1 {
  const parsed = agentReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError('invalid_manifest', 'The agent release manifest is invalid.', {
      issues: parsed.error.issues,
    });
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new AgentMarketError('invalid_manifest', 'The agent release manifest is too large.');
  }
  if (expectedChecksum && agentReleaseChecksum(parsed.data) !== expectedChecksum) {
    throw new AgentMarketError('invalid_manifest', 'The agent release checksum does not match.');
  }
  return parsed.data;
}

export function summarizeAgentReleaseManifest(manifest: AgentReleaseManifestV1): AgentReleaseSummary {
  const models = new Map<string, AgentModelRequirement>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    models.set(`${agent.modelRequirement.format}\0${agent.modelRequirement.model}`, agent.modelRequirement);
  }
  const deploymentCount = manifest.deployments.length;
  const skillCount = manifest.skills.length;
  const toolkitCount = manifest.toolkits.length;
  const subAgentCount = Math.max(0, manifest.agents.length - 1);
  const runtimes = [...new Set(
    manifest.agents.map((agent) => agent.runtime?.kind ?? 'pi'),
  )].sort((a, b) => a.localeCompare(b)) as Array<'pi' | 'hermes'>;
  return {
    agentCount: manifest.agents.length,
    subAgentCount,
    deploymentCount,
    skillCount,
    toolkitCount,
    resourceCount: deploymentCount + skillCount + toolkitCount,
    toolCount: deploymentCount + skillCount + subAgentCount,
    models: [...models.values()].sort((a, b) => (
      a.format.localeCompare(b.format) || a.model.localeCompare(b.model)
    )),
    runtimes,
  };
}

export type CatalogAgentManifestInput = {
  name: string;
  slug: string;
  systemPrompt: string | null;
  maxSteps: number;
  modelFormat?: string | null;
  model?: string | null;
  serverIds?: readonly string[];
  skillIds?: readonly string[];
};

/**
 * Build a portable release exclusively from administrator-managed catalog
 * resources. This is the safe source for an admin-created directory template:
 * no workspace deployment ids, credentials, conversations, or runtime state
 * can enter the artifact.
 */
export async function buildCatalogAgentManifest(
  tx: Prisma.TransactionClient,
  input: CatalogAgentManifestInput,
): Promise<AgentReleaseManifestV1> {
  const serverIds = sortedUnique(input.serverIds ?? []);
  const skillIds = sortedUnique(input.skillIds ?? []);
  if (serverIds.length + skillIds.length > MAX_GRAPH_RESOURCES) {
    throw new AgentMarketError('not_portable', 'The template contains too many catalog resources.');
  }

  const [servers, skills] = await Promise.all([
    serverIds.length
      ? tx.server.findMany({
          where: { id: { in: serverIds } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            slug: true,
            name: true,
            verifiedAt: true,
            installCfg: true,
          },
        })
      : Promise.resolve([]),
    skillIds.length
      ? tx.skill.findMany({
          where: { id: { in: skillIds } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            slug: true,
            name: true,
            author: true,
            description: true,
            content: true,
            files: true,
            sourceSha: true,
          },
        })
      : Promise.resolve([]),
  ]);
  if (servers.length !== serverIds.length || skills.length !== skillIds.length) {
    throw new AgentMarketError('not_portable', 'One or more selected catalog resources no longer exist.');
  }

  const deployments: PortableDeploymentDefinition[] = servers.map((server, index) => {
    const recipe = parseServerRecipe(server.installCfg);
    if (!server.verifiedAt || !recipe) {
      throw new AgentMarketError(
        'not_portable',
        `Catalog MCP "${server.name}" is not verified with a portable recipe.`,
      );
    }
    const publicEnv = sortedRecord(recipe.envValues);
    return {
      key: `deployment_${index + 1}`,
      name: server.name,
      catalogSlug: server.slug,
      source: recipe.source,
      sourceRef: recipe.ref,
      requiredEnv: sortedUnique(recipe.env).filter((name) => !(name in publicEnv)),
      publicEnv,
      ...(recipe.startCommand ? { startCommand: recipe.startCommand } : {}),
      ...(recipe.network === 'none' ? { network: 'none' as const } : {}),
      mcpToolExposure: 'all' as const,
      mcpAllowedTools: [],
    };
  });
  const portableSkills: PortableSkillDefinition[] = skills.map((skill, index) => ({
    key: `skill_${index + 1}`,
    origin: 'catalog' as const,
    catalogSlug: skill.slug,
    ...(skill.sourceSha ? { sourceSha: skill.sourceSha } : {}),
    name: skill.name,
    slug: skill.slug,
    description: skill.description,
    content: buildSkillMarkdown(skill),
    files: installedSkillExtraFiles({
      skillId: skill.id,
      skill,
      name: null,
      slug: null,
      description: null,
      content: null,
      files: null,
    }),
    userInvocable: true,
    agentInvocable: true,
    effort: 'default',
  }));

  const modelFormat = input.modelFormat?.trim() || null;
  const model = input.model?.trim() || null;
  const manifest: AgentReleaseManifestV1 = {
    schemaVersion: AGENT_MARKET_MANIFEST_VERSION,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: input.name.trim().slice(0, 240),
      slug: slugify(input.slug, 'agent'),
      systemPrompt: input.systemPrompt?.trim() || null,
      maxSteps: Number.isFinite(input.maxSteps)
        ? Math.max(0, Math.min(1000, Math.trunc(input.maxSteps)))
        : 8,
      modelRequirement: modelFormat && model ? { format: modelFormat, model } : null,
      runtime: { kind: 'pi' },
      deploymentKeys: deployments.map(({ key }) => key),
      skillKeys: portableSkills.map(({ key }) => key),
      toolkitKeys: [],
      subAgentKeys: [],
    }],
    deployments,
    skills: portableSkills,
    toolkits: [],
  };
  return parseAgentReleaseManifest(manifest);
}

function invalidResourceCount(state: CollectorState): boolean {
  return state.deployments.length + state.skills.length + state.toolkits.length >= MAX_GRAPH_RESOURCES;
}

function collectDeployment(
  state: CollectorState,
  deployment: LoadedMarketDeployment,
  path: string,
): string | null {
  const cached = state.deploymentKeys.get(deployment.id);
  if (cached !== undefined) return cached;
  if (invalidResourceCount(state)) {
    pushIssue(state, {
      code: 'graph_too_large',
      path,
      message: `The agent graph contains more than ${MAX_GRAPH_RESOURCES} resources.`,
    });
    state.deploymentKeys.set(deployment.id, null);
    return null;
  }
  if (deployment.workspaceId !== state.workspaceId) {
    pushIssue(state, {
      code: 'cross_workspace_deployment',
      path,
      message: 'An MCP deployment belongs to another workspace.',
      resourceId: deployment.id,
    });
    state.deploymentKeys.set(deployment.id, null);
    return null;
  }
  if (!deployment.serverId || !deployment.server) {
    pushIssue(state, {
      code: 'custom_mcp',
      path,
      message: 'Custom MCP deployments are not portable in agent marketplace v1.',
      resourceId: deployment.id,
    });
    state.deploymentKeys.set(deployment.id, null);
    return null;
  }
  if (!deployment.server.verifiedAt) {
    pushIssue(state, {
      code: 'unverified_catalog_mcp',
      path,
      message: `Catalog MCP "${deployment.server.name}" has not been verified.`,
      resourceId: deployment.id,
    });
    state.deploymentKeys.set(deployment.id, null);
    return null;
  }
  const recipe = parseServerRecipe(deployment.server.installCfg);
  if (!recipe) {
    pushIssue(state, {
      code: 'invalid_catalog_recipe',
      path,
      message: `Catalog MCP "${deployment.server.name}" has no portable deployment recipe.`,
      resourceId: deployment.id,
    });
    state.deploymentKeys.set(deployment.id, null);
    return null;
  }

  const key = nextKey('deployment', state.deployments.length);
  const publicEnv = sortedRecord(recipe.envValues);
  const requiredEnv = sortedUnique(recipe.env).filter((name) => !(name in publicEnv));
  state.deploymentKeys.set(deployment.id, key);
  state.deployments.push({
    key,
    name: deployment.server.name,
    catalogSlug: deployment.server.slug,
    source: recipe.source,
    sourceRef: recipe.ref,
    requiredEnv,
    publicEnv,
    ...(recipe.startCommand ? { startCommand: recipe.startCommand } : {}),
    ...(recipe.network === 'none' ? { network: 'none' as const } : {}),
    mcpToolExposure: deployment.mcpToolExposure,
    mcpAllowedTools: sortedUnique(deployment.mcpAllowedTools),
  });
  return key;
}

function collectSkill(
  state: CollectorState,
  installed: LoadedMarketSkill,
  path: string,
): string | null {
  const cached = state.skillKeys.get(installed.id);
  if (cached !== undefined) return cached;
  if (invalidResourceCount(state)) {
    pushIssue(state, {
      code: 'graph_too_large',
      path,
      message: `The agent graph contains more than ${MAX_GRAPH_RESOURCES} resources.`,
    });
    state.skillKeys.set(installed.id, null);
    return null;
  }
  if (installed.workspaceId !== state.workspaceId) {
    pushIssue(state, {
      code: 'cross_workspace_skill',
      path,
      message: 'An installed skill belongs to another workspace.',
      resourceId: installed.id,
    });
    state.skillKeys.set(installed.id, null);
    return null;
  }

  let content: string;
  let files: PortableSkillDefinition['files'];
  try {
    content = buildInstalledSkillMarkdown(installed);
    files = installedSkillExtraFiles(installed);
  } catch (error) {
    pushIssue(state, {
      code: 'invalid_skill_bundle',
      path,
      message: error instanceof Error ? error.message : 'The skill bundle is invalid.',
      resourceId: installed.id,
    });
    state.skillKeys.set(installed.id, null);
    return null;
  }

  const catalog = installed.skillId && installed.skill ? installed.skill : null;
  const name = (catalog?.name ?? installed.name ?? 'Skill').trim() || 'Skill';
  const skillSlug = slugify(catalog?.slug ?? installed.slug ?? name, 'skill');
  const key = nextKey('skill', state.skills.length);
  state.skillKeys.set(installed.id, key);
  state.skills.push({
    key,
    origin: catalog ? 'catalog' : 'custom',
    ...(catalog ? { catalogSlug: catalog.slug } : {}),
    ...(catalog?.sourceSha ? { sourceSha: catalog.sourceSha } : {}),
    name,
    slug: skillSlug,
    description: catalog?.description ?? installed.description ?? null,
    content,
    files,
    userInvocable: installed.userInvocable,
    agentInvocable: installed.agentInvocable,
    effort: installed.effort || 'default',
  });
  return key;
}

function collectToolkit(
  state: CollectorState,
  toolkit: LoadedMarketToolkit,
  path: string,
): string | null {
  const cached = state.toolkitKeys.get(toolkit.id);
  if (cached !== undefined) return cached;
  if (invalidResourceCount(state)) {
    pushIssue(state, {
      code: 'graph_too_large',
      path,
      message: `The agent graph contains more than ${MAX_GRAPH_RESOURCES} resources.`,
    });
    state.toolkitKeys.set(toolkit.id, null);
    return null;
  }
  if (toolkit.workspaceId !== state.workspaceId) {
    pushIssue(state, {
      code: 'cross_workspace_toolkit',
      path,
      message: 'A toolkit belongs to another workspace.',
      resourceId: toolkit.id,
    });
    state.toolkitKeys.set(toolkit.id, null);
    return null;
  }

  const key = nextKey('toolkit', state.toolkits.length);
  state.toolkitKeys.set(toolkit.id, key);
  const deploymentKeys = toolkit.servers
    .slice()
    .sort((a, b) => a.deployment.id.localeCompare(b.deployment.id))
    .map(({ deployment }) => collectDeployment(state, deployment, `${path}.deployments`))
    .filter((value): value is string => Boolean(value));
  const skillKeys = toolkit.skills
    .slice()
    .sort((a, b) => a.installedSkill.id.localeCompare(b.installedSkill.id))
    .map(({ installedSkill }) => collectSkill(state, installedSkill, `${path}.skills`))
    .filter((value): value is string => Boolean(value));
  state.toolkits.push({
    key,
    name: toolkit.name,
    slug: slugify(toolkit.slug || toolkit.name, 'toolkit'),
    enabled: toolkit.enabled,
    deploymentKeys: sortedUnique(deploymentKeys),
    skillKeys: sortedUnique(skillKeys),
  });
  return key;
}

async function collectPortableManifest(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  rootAgentId: string,
): Promise<AgentPortabilityAssessment> {
  const state: CollectorState = {
    workspaceId,
    issues: [],
    issueKeys: new Set(),
    agentKeys: new Map([[rootAgentId, 'agent_1']]),
    deploymentKeys: new Map(),
    skillKeys: new Map(),
    toolkitKeys: new Map(),
    agents: [],
    deployments: [],
    skills: [],
    toolkits: [],
  };
  const queue = [rootAgentId];
  const processed = new Set<string>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const agentId = queue[cursor];
    if (processed.has(agentId)) continue;
    processed.add(agentId);
    const agent: LoadedMarketAgent | null = await tx.agent.findUnique({
      where: { id: agentId },
      select: MARKET_AGENT_SELECT,
    });
    const key = state.agentKeys.get(agentId) ?? nextKey('agent', state.agentKeys.size);
    state.agentKeys.set(agentId, key);
    const path = `agents.${key}`;
    if (!agent) {
      pushIssue(state, {
        code: 'agent_not_found',
        path,
        message: 'An agent in the delegation graph no longer exists.',
        resourceId: agentId,
      });
      continue;
    }
    if (agent.workspaceId !== workspaceId) {
      pushIssue(state, {
        code: 'cross_workspace_agent',
        path,
        message: 'An agent in the delegation graph belongs to another workspace.',
        resourceId: agent.id,
      });
      continue;
    }
    const isHermes = agent.runtimeKind === HERMES_RUNTIME_KIND;
    const isPi = agent.runtimeKind === 'pi';
    if (!isHermes && !isPi) {
      pushIssue(state, {
        code: 'unsupported_runtime',
        path: `${path}.runtime`,
        message: `Runtime "${agent.runtimeKind}" is not portable in agent marketplace v1.`,
        resourceId: agent.id,
      });
    }
    if (agent.runtime && (!isHermes || agent.runtime.kind !== HERMES_RUNTIME_KIND)) {
      pushIssue(state, {
        code: 'unsupported_runtime',
        path: `${path}.runtime`,
        message: `Runtime "${agent.runtime.kind}" is not portable in agent marketplace v1.`,
        resourceId: agent.runtime.id,
      });
    }
    if (isHermes && (!agent.runtime || agent.runtime.kind !== HERMES_RUNTIME_KIND)) {
      pushIssue(state, {
        code: 'invalid_definition',
        path: `${path}.runtime`,
        message: 'The Hermes Agent runtime record is missing or inconsistent.',
        resourceId: agent.id,
      });
    }
    if (isHermes && agent.runtime && (
      agent.runtime.workspaceId !== workspaceId
      || agent.runtime.sandbox.workspaceId !== workspaceId
    )) {
      pushIssue(state, {
        code: 'invalid_definition',
        path: `${path}.runtime`,
        message: 'The Hermes runtime and its sandbox must belong to the published workspace.',
        resourceId: agent.runtime.id,
      });
    }
    if (isPi) {
      const sandbox = agent.sandboxes[0]?.sandbox;
      if (
        agent.sandboxes.length !== 1
        || !sandbox
        || sandbox.workspaceId !== workspaceId
        || sandbox.kind !== 'docker'
        || sandbox.network === 'none'
      ) {
        pushIssue(state, {
          code: 'invalid_definition',
          path: `${path}.sandboxes`,
          message: 'Pi Agents require exactly one networked Docker sandbox in the published workspace.',
          resourceId: agent.id,
        });
      }
    } else if (agent.sandboxes.length > 0) {
      for (const { sandbox } of agent.sandboxes) {
        pushIssue(state, {
          code: 'external_sandbox',
          path: `${path}.sandboxes`,
          message: 'Only Pi Agents may attach a portable sandbox.',
          resourceId: sandbox.id,
        });
      }
    }
    if (!isHermes && agent.provider && agent.provider.workspaceId !== workspaceId) {
      pushIssue(state, {
        code: 'cross_workspace_provider',
        path: `${path}.provider`,
        message: 'The model provider belongs to another workspace.',
        resourceId: agent.provider.id,
      });
    }
    if (isHermes) {
      for (const { provider } of agent.modelProviders) {
        if (provider.workspaceId === workspaceId) continue;
        pushIssue(state, {
          code: 'cross_workspace_provider',
          path: `${path}.modelProviders`,
          message: 'A Hermes model provider belongs to another workspace.',
          resourceId: provider.id,
        });
      }
    }

    const deploymentKeys = agent.servers
      .slice()
      .sort((a, b) => a.deployment.id.localeCompare(b.deployment.id))
      .map(({ deployment }) => collectDeployment(state, deployment, `${path}.deployments`))
      .filter((value): value is string => Boolean(value));
    const skillKeys = agent.skills
      .slice()
      .sort((a, b) => a.installedSkill.id.localeCompare(b.installedSkill.id))
      .map(({ installedSkill }) => collectSkill(state, installedSkill, `${path}.skills`))
      .filter((value): value is string => Boolean(value));
    const toolkitKeys = agent.toolkits
      .slice()
      .sort((a, b) => a.toolkit.id.localeCompare(b.toolkit.id))
      .map(({ toolkit }) => collectToolkit(state, toolkit, `${path}.toolkits`))
      .filter((value): value is string => Boolean(value));

    const subAgentKeys: string[] = [];
    for (const { child } of agent.subAgents.slice().sort((a, b) => a.child.id.localeCompare(b.child.id))) {
      if (child.workspaceId !== workspaceId) {
        pushIssue(state, {
          code: 'cross_workspace_agent',
          path: `${path}.subAgents`,
          message: `Sub-agent "${child.name}" belongs to another workspace.`,
          resourceId: child.id,
        });
        continue;
      }
      let childKey = state.agentKeys.get(child.id);
      if (!childKey) {
        if (state.agentKeys.size >= MAX_GRAPH_AGENTS) {
          pushIssue(state, {
            code: 'graph_too_large',
            path: `${path}.subAgents`,
            message: `The delegation graph contains more than ${MAX_GRAPH_AGENTS} agents.`,
          });
          continue;
        }
        childKey = nextKey('agent', state.agentKeys.size);
        state.agentKeys.set(child.id, childKey);
        queue.push(child.id);
      }
      subAgentKeys.push(childKey);
    }

    const modelProviderRequirements = isHermes
      ? sortedUnique(agent.modelProviders
        .filter(({ provider }) => provider.workspaceId === workspaceId)
        .map(({ provider }) => provider.format))
        .map((format) => ({ format }))
      : undefined;
    const runtime = isHermes && agent.runtime?.kind === HERMES_RUNTIME_KIND
      ? { kind: 'hermes' as const, image: resolveHermesImage(agent.runtime.image) }
      : { kind: 'pi' as const };
    state.agents.push({
      key,
      name: agent.name,
      slug: slugify(agent.slug || agent.name, 'agent'),
      systemPrompt: isHermes ? null : agent.systemPrompt,
      maxSteps: agent.maxSteps,
      modelRequirement: !isHermes && agent.provider && agent.provider.workspaceId === workspaceId && agent.model
        ? { format: agent.provider.format, model: agent.model }
        : null,
      runtime,
      ...(modelProviderRequirements ? { modelProviderRequirements } : {}),
      deploymentKeys: sortedUnique(deploymentKeys),
      skillKeys: sortedUnique(skillKeys),
      toolkitKeys: sortedUnique(toolkitKeys),
      subAgentKeys: sortedUnique(subAgentKeys),
    });
  }

  if (state.issues.length > 0) return { portable: false, issues: state.issues };
  const parsedManifest = agentReleaseManifestSchema.safeParse({
    schemaVersion: AGENT_MARKET_MANIFEST_VERSION,
    rootAgentKey: state.agentKeys.get(rootAgentId) ?? 'agent_1',
    agents: state.agents,
    deployments: state.deployments,
    skills: state.skills,
    toolkits: state.toolkits,
  });
  if (!parsedManifest.success) {
    return {
      portable: false,
      issues: parsedManifest.error.issues.map((issue) => ({
        code: 'invalid_definition' as const,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const manifest = parsedManifest.data;
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_BYTES) {
    return {
      portable: false,
      issues: [{
        code: 'manifest_too_large',
        path: 'manifest',
        message: `The portable agent manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`,
      }],
    };
  }
  return { portable: true, issues: [], manifest, summary: summarizeAgentReleaseManifest(manifest) };
}

export async function assessAgentPortability(input: {
  workspaceId: string;
  agentId: string;
}): Promise<AgentPortabilityAssessment> {
  return db.$transaction(
    (tx) => collectPortableManifest(tx, input.workspaceId, input.agentId),
    { isolationLevel: 'RepeatableRead' },
  );
}

function cleanListingTags(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim().toLocaleLowerCase().slice(0, 40))
    .filter(Boolean))]
    .slice(0, 20);
}

function isPrismaError(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code),
  );
}

async function assertPublisherAccess(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [
        { ownerId: userId },
        { members: { some: { userId, role: { in: ['owner', 'admin'] } } } },
      ],
    },
    select: { id: true },
  });
  if (!workspace) {
    throw new AgentMarketError(
      'not_authorized',
      'Only a workspace owner or admin can publish agents.',
    );
  }
}

export async function publishAgentRelease(input: {
  workspaceId: string;
  agentId: string;
  publishedById: string;
  listing?: {
    slug?: string;
    name?: string;
    summary?: string | null;
    iconUrl?: string | null;
    tags?: string[];
  };
}) {
  try {
    return await db.$transaction(async (tx) => {
      await assertPublisherAccess(tx, input.workspaceId, input.publishedById);
      const sourceAgent = await tx.agent.findFirst({
        where: { id: input.agentId, workspaceId: input.workspaceId },
        select: {
          id: true,
          slug: true,
          name: true,
          workspace: { select: { slug: true, name: true } },
        },
      });
      if (!sourceAgent) {
        throw new AgentMarketError('agent_not_found', 'The source agent was not found.');
      }

      const assessment = await collectPortableManifest(tx, input.workspaceId, input.agentId);
      if (!assessment.portable) {
        throw new AgentMarketError(
          'not_portable',
          'The agent contains resources that cannot be published safely.',
          { issues: assessment.issues },
        );
      }

      const requestedSlug = input.listing?.slug ?? sourceAgent.slug;
      const listingSlug = slugify(requestedSlug, sourceAgent.slug || 'agent');
      const listingName = input.listing?.name?.trim().slice(0, 240) || sourceAgent.name;
      const listingSummary = input.listing?.summary?.trim().slice(0, 4000) || null;
      const iconUrl = input.listing?.iconUrl?.trim().slice(0, 2000) || null;
      const tags = cleanListingTags(input.listing?.tags);
      const existing = await tx.agentListing.findUnique({
        where: { sourceAgentId: sourceAgent.id },
      });
      if (existing && existing.publisherWorkspaceId !== input.workspaceId) {
        throw new AgentMarketError('listing_conflict', 'The agent is already listed elsewhere.');
      }
      const slugConflict = await tx.agentListing.findFirst({
        where: {
          publisherWorkspaceId: input.workspaceId,
          slug: listingSlug,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        select: { id: true },
      });
      if (slugConflict) {
        throw new AgentMarketError(
          'listing_conflict',
          'Another agent listing in this workspace already uses that slug.',
        );
      }
      const directorySlug = existing?.directorySlug
        ?? await uniqueDirectorySlug(tx, listingSlug);

      const listing = existing
        ? await tx.agentListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              slug: listingSlug,
              name: listingName,
              author: sourceAgent.workspace.name,
              summary: listingSummary,
              iconUrl,
              tags,
            },
          })
        : await tx.agentListing.create({
            data: {
              publisherWorkspaceId: input.workspaceId,
              sourceAgentId: sourceAgent.id,
              publishedById: input.publishedById,
              slug: listingSlug,
              directorySlug,
              name: listingName,
              author: sourceAgent.workspace.name,
              summary: listingSummary,
              iconUrl,
              tags,
            },
          });
      if (listing.pendingReleaseId) {
        await tx.agentRelease.updateMany({
          where: { id: listing.pendingReleaseId, reviewStatus: 'pending' },
          data: {
            reviewStatus: 'rejected',
            reviewedAt: new Date(),
            reviewNote: 'Superseded by a newer publisher submission.',
          },
        });
      }
      const version = listing.latestVersion + 1;
      const checksum = agentReleaseChecksum(assessment.manifest);
      const release = await tx.agentRelease.create({
        data: {
          listingId: listing.id,
          version,
          manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
          manifest: assessment.manifest as Prisma.InputJsonValue,
          releaseSummary: assessment.summary as Prisma.InputJsonValue,
          checksum,
          name: listingName,
          summary: listingSummary,
          iconUrl,
          tags,
          reviewStatus: 'pending',
        },
      });
      const submittedListing = await tx.agentListing.update({
        where: { id: listing.id },
        data: {
          status: listing.status === 'published' && listing.latestReleaseId ? 'published' : 'draft',
          latestVersion: version,
          pendingReleaseId: release.id,
        },
      });
      return { listing: submittedListing, release };
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof AgentMarketError) throw error;
    if (isPrismaError(error, ['P2002', 'P2034'])) {
      throw new AgentMarketError(
        'listing_conflict',
        'The listing changed while it was being published. Try again.',
      );
    }
    throw error;
  }
}

export async function unpublishAgentListing(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}): Promise<{ id: string; status: string } | null> {
  return db.$transaction(async (tx) => {
    await assertPublisherAccess(tx, input.workspaceId, input.actorId);
    const listing = await tx.agentListing.findFirst({
      where: {
        publisherWorkspaceId: input.workspaceId,
        sourceAgentId: input.agentId,
      },
      select: { id: true, pendingReleaseId: true },
    });
    if (!listing) return null;
    if (listing.pendingReleaseId) {
      await tx.agentRelease.updateMany({
        where: { id: listing.pendingReleaseId, reviewStatus: 'pending' },
        data: {
          reviewStatus: 'rejected',
          reviewedAt: new Date(),
          reviewNote: 'Withdrawn by the publisher.',
        },
      });
    }
    return tx.agentListing.update({
      where: { id: listing.id },
      data: { status: 'disabled', pendingReleaseId: null },
      select: { id: true, status: true },
    });
  });
}

export async function withdrawPendingAgentRelease(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}): Promise<{ id: string; status: string } | null> {
  return db.$transaction(async (tx) => {
    await assertPublisherAccess(tx, input.workspaceId, input.actorId);
    const listing = await tx.agentListing.findFirst({
      where: {
        publisherWorkspaceId: input.workspaceId,
        sourceAgentId: input.agentId,
      },
      select: { id: true, status: true, latestReleaseId: true, pendingReleaseId: true },
    });
    if (!listing?.pendingReleaseId) return null;
    await tx.agentRelease.updateMany({
      where: { id: listing.pendingReleaseId, reviewStatus: 'pending' },
      data: {
        reviewStatus: 'rejected',
        reviewedAt: new Date(),
        reviewNote: 'Withdrawn by the publisher.',
      },
    });
    return tx.agentListing.update({
      where: { id: listing.id },
      data: {
        pendingReleaseId: null,
        status: listing.latestReleaseId ? listing.status : 'draft',
      },
      select: { id: true, status: true },
    });
  });
}

function parseReleaseSummary(raw: unknown): AgentReleaseSummary {
  const parsed = agentReleaseSummarySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError('invalid_manifest', 'The agent release summary is invalid.', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function getAgentListingForPublisher(
  workspaceId: string,
  agentId: string,
): Promise<PublisherAgentListing | null> {
  const listing = await db.agentListing.findFirst({
    where: { publisherWorkspaceId: workspaceId, sourceAgentId: agentId },
    select: {
      id: true,
      slug: true,
      directorySlug: true,
      name: true,
      author: true,
      summary: true,
      iconUrl: true,
      tags: true,
      status: true,
      latestVersion: true,
      publishedAt: true,
      installCount: true,
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          checksum: true,
          publishedAt: true,
          releaseSummary: true,
        },
      },
      pendingRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          checksum: true,
          publishedAt: true,
          name: true,
          summary: true,
          iconUrl: true,
          tags: true,
          reviewStatus: true,
          releaseSummary: true,
        },
      },
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    slug: listing.slug,
    directorySlug: listing.directorySlug,
    name: listing.name,
    author: listing.author,
    summary: listing.summary,
    iconUrl: listing.iconUrl,
    tags: listing.tags,
    status: listing.status,
    latestVersion: listing.latestVersion,
    publishedAt: listing.publishedAt,
    installCount: listing.installCount,
    latestRelease: listing.latestRelease
      ? {
          id: listing.latestRelease.id,
          version: listing.latestRelease.version,
          manifestVersion: listing.latestRelease.manifestVersion,
          checksum: listing.latestRelease.checksum,
          publishedAt: listing.latestRelease.publishedAt,
          summary: parseReleaseSummary(listing.latestRelease.releaseSummary),
        }
      : null,
    pendingRelease: listing.pendingRelease
      ? {
          id: listing.pendingRelease.id,
          version: listing.pendingRelease.version,
          manifestVersion: listing.pendingRelease.manifestVersion,
          checksum: listing.pendingRelease.checksum,
          publishedAt: listing.pendingRelease.publishedAt,
          name: listing.pendingRelease.name,
          summary: listing.pendingRelease.summary,
          iconUrl: listing.pendingRelease.iconUrl,
          tags: listing.pendingRelease.tags,
          reviewStatus: listing.pendingRelease.reviewStatus,
          summaryData: parseReleaseSummary(listing.pendingRelease.releaseSummary),
        }
      : null,
  };
}

export type AgentMarketListInput = {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'newest' | 'popular' | 'name';
  category?: string;
};

export async function listAgentMarketListings(input: AgentMarketListInput = {}): Promise<{
  items: AgentMarketListingSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const requestedPage = input.page ?? 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)));
  const term = input.q?.trim().slice(0, 200) ?? '';
  const normalizedTag = term.toLocaleLowerCase();
  const category = input.category?.trim().slice(0, 120) ?? '';
  const where: Prisma.AgentListingWhereInput = {
    status: 'published',
    latestReleaseId: { not: null },
    publisherWorkspace: { is: {} },
    latestRelease: { is: { reviewStatus: 'approved' } },
    ...(category ? { categories: { some: { slug: category } } } : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { author: { contains: term, mode: 'insensitive' } },
            { summary: { contains: term, mode: 'insensitive' } },
            { slug: { contains: term, mode: 'insensitive' } },
            { directorySlug: { contains: term, mode: 'insensitive' } },
            { publisherWorkspace: { is: { name: { contains: term, mode: 'insensitive' } } } },
            { publisherWorkspace: { is: { slug: { contains: term, mode: 'insensitive' } } } },
            { categories: { some: { name: { contains: term, mode: 'insensitive' } } } },
            { tags: { has: normalizedTag } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.AgentListingOrderByWithRelationInput[] = [
    { isFeatured: 'desc' },
    ...(input.sort === 'newest'
      ? [{ publishedAt: 'desc' as const }, { updatedAt: 'desc' as const }]
      : input.sort === 'name'
        ? [{ name: 'asc' as const }, { publishedAt: 'desc' as const }]
        : [{ installCount: 'desc' as const }, { publishedAt: 'desc' as const }]),
  ];
  const [total, rows] = await Promise.all([
    db.agentListing.count({ where }),
    db.agentListing.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        directorySlug: true,
        name: true,
        author: true,
        summary: true,
        iconUrl: true,
        tags: true,
        curated: true,
        isFeatured: true,
        publishedAt: true,
        updatedAt: true,
        installCount: true,
        categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
        publisherWorkspace: { select: { slug: true, name: true } },
        latestRelease: { select: { id: true, version: true, releaseSummary: true } },
      },
    }),
  ]);

  const items: AgentMarketListingSummary[] = [];
  for (const row of rows) {
    // Keep this guard even though the query filters the relation: it protects
    // the directory from an inconsistent row returned by the database.
    if (!row.publisherWorkspace || !row.latestRelease || !row.publishedAt) continue;
    items.push({
      id: row.id,
      slug: row.slug,
      directorySlug: row.directorySlug,
      name: row.name,
      author: row.author,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
      categories: row.categories,
      curated: row.curated,
      isFeatured: row.isFeatured,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      installCount: row.installCount,
      workspaceSlug: row.publisherWorkspace?.slug ?? null,
      workspaceName: row.publisherWorkspace?.name ?? null,
      latestReleaseId: row.latestRelease.id,
      latestVersion: row.latestRelease.version,
      releaseSummary: parseReleaseSummary(row.latestRelease.releaseSummary),
    });
  }
  return { items, total, page, pageSize };
}

export async function listAgentMarketCategories() {
  return db.category.findMany({
    where: {
      agentListings: {
        some: {
          status: 'published',
          latestReleaseId: { not: null },
          latestRelease: { is: { reviewStatus: 'approved' } },
        },
      },
    },
    orderBy: { name: 'asc' },
    select: {
      slug: true,
      name: true,
      _count: {
        select: {
          agentListings: {
            where: {
              status: 'published',
              latestReleaseId: { not: null },
              latestRelease: { is: { reviewStatus: 'approved' } },
            },
          },
        },
      },
    },
  });
}

async function findAgentMarketListing(
  identity: Prisma.AgentListingWhereInput,
): Promise<AgentMarketListingDetail | null> {
  const row = await db.agentListing.findFirst({
    where: {
      ...identity,
      status: 'published',
      publisherWorkspace: { is: {} },
      latestReleaseId: { not: null },
      latestRelease: { is: { reviewStatus: 'approved' } },
    },
    select: {
      id: true,
      slug: true,
      directorySlug: true,
      name: true,
      author: true,
      summary: true,
      iconUrl: true,
      tags: true,
      curated: true,
      isFeatured: true,
      status: true,
      publishedAt: true,
      updatedAt: true,
      installCount: true,
      categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
      publisherWorkspace: { select: { slug: true, name: true } },
      latestRelease: {
        select: {
          id: true,
          version: true,
          manifestVersion: true,
          manifest: true,
          releaseSummary: true,
          checksum: true,
          publishedAt: true,
        },
      },
    },
  });
  if (!row?.publisherWorkspace || !row.latestRelease || !row.publishedAt || row.latestRelease.manifestVersion !== 1) {
    return null;
  }
  const manifest = parseAgentReleaseManifest(row.latestRelease.manifest, row.latestRelease.checksum);
  return {
    listing: {
      id: row.id,
      slug: row.slug,
      directorySlug: row.directorySlug,
      name: row.name,
      author: row.author,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
      categories: row.categories,
      curated: row.curated,
      isFeatured: row.isFeatured,
      status: 'published',
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      installCount: row.installCount,
    },
    workspace: row.publisherWorkspace,
    release: {
      id: row.latestRelease.id,
      version: row.latestRelease.version,
      manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
      checksum: row.latestRelease.checksum,
      publishedAt: row.latestRelease.publishedAt,
      summary: parseReleaseSummary(row.latestRelease.releaseSummary),
    },
    manifest,
  };
}

export function getAgentMarketListing(
  listingId: string,
): Promise<AgentMarketListingDetail | null> {
  return findAgentMarketListing({ id: listingId });
}

export function getAgentMarketListingByDirectorySlug(
  directorySlug: string,
): Promise<AgentMarketListingDetail | null> {
  return findAgentMarketListing({ directorySlug });
}

export type MaterializeAgentReleaseResult = {
  install: {
    id: string;
    releaseId: string;
    targetWorkspaceId: string;
    agentId: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
  agent: { id: string; name: string; slug: string };
  reused: boolean;
  requirements: AgentInstallRequirements;
  resourceMap: AgentInstallResourceMap;
};

function validateManifestReferences(manifest: AgentReleaseManifestV1) {
  function uniqueKeys(label: string, keys: string[]) {
    if (new Set(keys).size !== keys.length) {
      throw new AgentMarketError('invalid_manifest', `The release contains duplicate ${label} keys.`);
    }
  }
  uniqueKeys('agent', manifest.agents.map(({ key }) => key));
  uniqueKeys('deployment', manifest.deployments.map(({ key }) => key));
  uniqueKeys('skill', manifest.skills.map(({ key }) => key));
  uniqueKeys('toolkit', manifest.toolkits.map(({ key }) => key));

  const agents = new Set(manifest.agents.map(({ key }) => key));
  const deployments = new Set(manifest.deployments.map(({ key }) => key));
  const skills = new Set(manifest.skills.map(({ key }) => key));
  const toolkits = new Set(manifest.toolkits.map(({ key }) => key));
  if (!agents.has(manifest.rootAgentKey)) {
    throw new AgentMarketError('invalid_manifest', 'The release root agent is missing.');
  }
  const requireKeys = (label: string, values: string[], available: Set<string>) => {
    const missing = values.filter((value) => !available.has(value));
    if (missing.length) {
      throw new AgentMarketError('invalid_manifest', `The release references missing ${label} resources.`, {
        missing,
      });
    }
  };
  for (const agent of manifest.agents) {
    requireKeys('deployment', agent.deploymentKeys, deployments);
    requireKeys('skill', agent.skillKeys, skills);
    requireKeys('toolkit', agent.toolkitKeys, toolkits);
    requireKeys('sub-agent', agent.subAgentKeys, agents);
  }
  for (const toolkit of manifest.toolkits) {
    requireKeys('deployment', toolkit.deploymentKeys, deployments);
    requireKeys('skill', toolkit.skillKeys, skills);
  }
}

async function assertInstallerAccess(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true },
  });
  if (!workspace) {
    throw new AgentMarketError(
      'target_workspace_not_found',
      'The target workspace was not found or access was denied.',
    );
  }
}

async function uniqueAgentSlugForInstall(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  desired: string,
  reserved: Set<string>,
): Promise<string> {
  const base = slugify(desired, 'agent');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (reserved.has(candidate)) continue;
    const exists = await tx.agent.findFirst({
      where: { workspaceId, slug: candidate },
      select: { id: true },
    });
    if (!exists) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new AgentMarketError('install_failed', 'Could not allocate a unique agent slug.');
}

async function uniqueSandboxSlugForInstall(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  desired: string,
  reserved: Set<string>,
): Promise<string> {
  const base = `${slugify(desired, 'agent')}-runtime`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (reserved.has(candidate)) continue;
    const exists = await tx.sandbox.findFirst({
      where: { workspaceId, slug: candidate },
      select: { id: true },
    });
    if (!exists) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new AgentMarketError('install_failed', 'Could not allocate a unique runtime sandbox slug.');
}

async function uniqueToolkitSlugForInstall(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  desired: string,
  reserved: Set<string>,
): Promise<string> {
  const base = slugify(desired, 'toolkit') === 'me' ? 'market-toolkit' : slugify(desired, 'toolkit');
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (reserved.has(candidate)) continue;
    const exists = await tx.toolkit.findFirst({
      where: { workspaceId, slug: candidate },
      select: { id: true },
    });
    if (!exists) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new AgentMarketError('install_failed', 'Could not allocate a unique toolkit slug.');
}

function parseInstallRequirements(raw: unknown): AgentInstallRequirements {
  const parsed = agentInstallRequirementsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError('invalid_manifest', 'Stored install requirements are invalid.');
  }
  return parsed.data;
}

function parseInstallResourceMap(raw: unknown): AgentInstallResourceMap {
  const parsed = agentInstallResourceMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError('invalid_manifest', 'Stored install resource mapping is invalid.');
  }
  return parsed.data;
}

async function existingInstallResult(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    installedById: string;
    idempotencyKey: string;
  },
): Promise<MaterializeAgentReleaseResult | null> {
  const existing = await tx.agentInstall.findUnique({
    where: {
      targetWorkspaceId_idempotencyKey: {
        targetWorkspaceId: input.targetWorkspaceId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { agent: { select: { id: true, name: true, slug: true } } },
  });
  if (!existing) return null;
  if (
    existing.releaseId !== input.releaseId
    || existing.installedById !== input.installedById
    || !existing.agent
    || !existing.resourceMap
  ) {
    throw new AgentMarketError(
      'idempotency_conflict',
      'This idempotency key has already been used for a different installation.',
    );
  }
  return {
    install: {
      id: existing.id,
      releaseId: existing.releaseId,
      targetWorkspaceId: existing.targetWorkspaceId,
      agentId: existing.agentId,
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    },
    agent: existing.agent,
    reused: true,
    requirements: parseInstallRequirements(existing.requirements),
    resourceMap: parseInstallResourceMap(existing.resourceMap),
  };
}

async function materializeAgentReleaseTransaction(
  tx: Prisma.TransactionClient,
  input: {
    releaseId: string;
    targetWorkspaceId: string;
    installedById: string;
    idempotencyKey: string;
    name?: string;
  },
): Promise<MaterializeAgentReleaseResult> {
  await assertInstallerAccess(tx, input.targetWorkspaceId, input.installedById);
  const reused = await existingInstallResult(tx, input);
  if (reused) return reused;

  const release = await tx.agentRelease.findUnique({
    where: { id: input.releaseId },
    select: {
      id: true,
      manifestVersion: true,
      manifest: true,
      checksum: true,
      reviewStatus: true,
      listing: { select: { id: true } },
    },
  });
  if (!release) throw new AgentMarketError('release_not_found', 'The agent release was not found.');
  const currentListing = await tx.agentListing.findUnique({
    where: { id: release.listing.id },
    select: { status: true, latestReleaseId: true },
  });
  if (!currentListing || currentListing.status !== 'published') {
    throw new AgentMarketError('listing_unavailable', 'This agent listing is not currently available.');
  }
  if (release.reviewStatus !== 'approved') {
    throw new AgentMarketError('listing_unavailable', 'This agent release has not been approved.');
  }
  if (currentListing.latestReleaseId !== release.id) {
    throw new AgentMarketError('listing_unavailable', 'This agent release is no longer the current public version.');
  }
  if (release.manifestVersion !== AGENT_MARKET_MANIFEST_VERSION) {
    throw new AgentMarketError('invalid_manifest', 'This agent release uses an unsupported manifest version.');
  }
  const manifest = parseAgentReleaseManifest(release.manifest, release.checksum);
  validateManifestReferences(manifest);

  const uniqueModelRequirements = new Map<string, AgentModelRequirement>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    uniqueModelRequirements.set(
      `${agent.modelRequirement.format}\0${agent.modelRequirement.model}`,
      agent.modelRequirement,
    );
  }
  const hermesProviderFormats = sortedUnique(manifest.agents.flatMap((agent) => (
    portableAgentRuntimeKind(agent) === HERMES_RUNTIME_KIND
      ? (agent.modelProviderRequirements ?? []).map(({ format }) => format)
      : []
  )));
  const providerClauses: Prisma.ModelProviderWhereInput[] = [
    ...[...uniqueModelRequirements.values()].map((requirement) => ({
      format: requirement.format,
      models: { has: requirement.model },
    })),
    ...hermesProviderFormats.map((format) => ({ format })),
  ];
  const providers = providerClauses.length
    ? await tx.modelProvider.findMany({
        where: { workspaceId: input.targetWorkspaceId, OR: providerClauses },
        orderBy: { createdAt: 'asc' },
        select: { id: true, format: true, models: true },
      })
    : [];
  const providerByRequirement = new Map<string, { id: string }>();
  for (const requirement of uniqueModelRequirements.values()) {
    const provider = providers.find((candidate) => (
      candidate.format === requirement.format && candidate.models.includes(requirement.model)
    ));
    if (provider) {
      providerByRequirement.set(`${requirement.format}\0${requirement.model}`, provider);
    }
  }
  const providerByFormat = new Map<string, { id: string }>();
  for (const format of hermesProviderFormats) {
    const provider = providers.find((candidate) => candidate.format === format);
    if (provider) providerByFormat.set(format, provider);
  }

  const deploymentMap: Record<string, string> = {};
  const deploymentConfigByKey = new Map<string, unknown>();
  for (const definition of manifest.deployments) {
    const env: Record<string, string> = { ...definition.publicEnv };
    for (const name of definition.requiredEnv) env[name] = '';
    const installCfg = {
      env,
      ...(definition.startCommand ? { startCommand: definition.startCommand } : {}),
      ...(definition.network === 'none' ? { network: 'none' as const } : {}),
    };
    const deployment = await tx.deployment.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        serverId: null,
        name: definition.name,
        source: definition.source,
        sourceRef: definition.sourceRef,
        installCfg: installCfg as Prisma.InputJsonValue,
        status: 'stopped',
        mcpToolExposure: definition.mcpToolExposure,
        mcpAllowedTools: definition.mcpAllowedTools,
      },
      select: { id: true, installCfg: true },
    });
    deploymentMap[definition.key] = deployment.id;
    deploymentConfigByKey.set(definition.key, deployment.installCfg);
  }

  const skillMap: Record<string, string> = {};
  for (const definition of manifest.skills) {
    const installed = await tx.installedSkill.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        skillId: null,
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        content: definition.content,
        source: 'agent-market',
        sourceRef: `${release.id}:${definition.key}`,
        status: 'published',
        userInvocable: definition.userInvocable,
        agentInvocable: definition.agentInvocable,
        effort: definition.effort,
        files: definition.files as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    skillMap[definition.key] = installed.id;
  }

  const toolkitMap: Record<string, string> = {};
  const reservedToolkitSlugs = new Set<string>();
  for (const definition of manifest.toolkits) {
    const toolkitSlug = await uniqueToolkitSlugForInstall(
      tx,
      input.targetWorkspaceId,
      definition.slug,
      reservedToolkitSlugs,
    );
    const toolkit = await tx.toolkit.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        name: definition.name,
        slug: toolkitSlug,
        visibility: 'private',
        enabled: definition.enabled,
      },
      select: { id: true },
    });
    toolkitMap[definition.key] = toolkit.id;
    await Promise.all([
      tx.toolkitServer.createMany({
        data: definition.deploymentKeys.map((key) => ({
          toolkitId: toolkit.id,
          deploymentId: deploymentMap[key],
        })),
      }),
      tx.toolkitSkill.createMany({
        data: definition.skillKeys.map((key) => ({
          toolkitId: toolkit.id,
          installedSkillId: skillMap[key],
        })),
      }),
    ]);
  }

  const agentMap: Record<string, string> = {};
  const createdAgents = new Map<string, { id: string; name: string; slug: string }>();
  const reservedAgentSlugs = new Set<string>();
  const reservedSandboxSlugs = new Set<string>();
  for (const definition of manifest.agents) {
    const isRoot = definition.key === manifest.rootAgentKey;
    const requestedName = isRoot && input.name?.trim()
      ? input.name.trim().slice(0, 240)
      : definition.name;
    const desiredSlug = isRoot && input.name?.trim()
      ? slugify(requestedName, definition.slug)
      : definition.slug;
    const agentSlug = await uniqueAgentSlugForInstall(
      tx,
      input.targetWorkspaceId,
      desiredSlug,
      reservedAgentSlugs,
    );
    const requirement = definition.modelRequirement;
    const provider = requirement
      ? providerByRequirement.get(`${requirement.format}\0${requirement.model}`)
      : undefined;
    const runtimeKind = portableAgentRuntimeKind(definition);
    const isHermes = runtimeKind === HERMES_RUNTIME_KIND;
    const hermesProviderIds = isHermes
      ? [...new Set((definition.modelProviderRequirements ?? [])
        .map(({ format }) => providerByFormat.get(format)?.id)
        .filter((providerId): providerId is string => Boolean(providerId)))]
      : [];
    const agent = isHermes
      ? await createAgentRecords(
          tx,
          input.targetWorkspaceId,
          requestedName,
          agentSlug,
          {
            runtime: HERMES_RUNTIME_KIND,
            hermesImage: definition.runtime?.kind === HERMES_RUNTIME_KIND
              ? definition.runtime.image
              : undefined,
          },
          await uniqueSandboxSlugForInstall(
            tx,
            input.targetWorkspaceId,
            agentSlug,
            reservedSandboxSlugs,
          ),
        )
      : await tx.agent.create({
          data: {
            workspaceId: input.targetWorkspaceId,
            name: requestedName,
            slug: agentSlug,
            runtimeKind,
            systemPrompt: definition.systemPrompt,
            providerId: provider?.id ?? null,
            model: provider && requirement ? requirement.model : null,
            maxSteps: definition.maxSteps,
          },
          select: { id: true, name: true, slug: true },
        });
    if (!isHermes) {
      const deployment = await tx.deployment.create({
        data: {
          workspaceId: input.targetWorkspaceId,
          serverId: null,
          name: `Sandbox: ${requestedName}`,
          source: 'sandbox',
          sourceRef: DEFAULT_SANDBOX_IMAGE,
          status: 'stopped',
        },
      });
      const sandbox = await tx.sandbox.create({
        data: {
          workspaceId: input.targetWorkspaceId,
          deploymentId: deployment.id,
          name: `${requestedName} Workspace`,
          slug: await uniqueSandboxSlugForInstall(
            tx,
            input.targetWorkspaceId,
            agentSlug,
            reservedSandboxSlugs,
          ),
          kind: 'docker',
          image: DEFAULT_SANDBOX_IMAGE,
          network: 'isolated',
          config: {},
        },
      });
      await Promise.all([
        tx.deployment.update({
          where: { id: deployment.id },
          data: {
            installCfg: {
              sandboxId: sandbox.id,
              kind: 'docker',
              image: DEFAULT_SANDBOX_IMAGE,
              network: 'isolated',
              volumeName: sandboxVolumeName(sandbox.id),
              env: {},
              allowSudo: false,
            },
          },
        }),
        tx.agentSandbox.create({
          data: { agentId: agent.id, sandboxId: sandbox.id, isDefault: true },
        }),
      ]);
    }
    if (isHermes) {
      await Promise.all([
        tx.agent.update({
          where: { id: agent.id },
          data: {
            systemPrompt: null,
            providerId: null,
            model: null,
            maxSteps: definition.maxSteps,
          },
        }),
        tx.agentModelProvider.createMany({
          data: hermesProviderIds.map((providerId) => ({ agentId: agent.id, providerId })),
        }),
      ]);
    }
    agentMap[definition.key] = agent.id;
    createdAgents.set(definition.key, { id: agent.id, name: agent.name, slug: agent.slug });
  }

  for (const definition of manifest.agents) {
    const agentId = agentMap[definition.key];
    await Promise.all([
      tx.agentServer.createMany({
        data: definition.deploymentKeys.map((key) => ({
          agentId,
          deploymentId: deploymentMap[key],
        })),
      }),
      tx.agentSkill.createMany({
        data: definition.skillKeys.map((key) => ({
          agentId,
          installedSkillId: skillMap[key],
        })),
      }),
      tx.agentToolkit.createMany({
        data: definition.toolkitKeys.map((key) => ({
          agentId,
          toolkitId: toolkitMap[key],
        })),
      }),
      tx.agentSubAgent.createMany({
        data: definition.subAgentKeys.map((key) => ({
          parentId: agentId,
          childId: agentMap[key],
        })),
      }),
    ]);
  }

  const requirements: AgentInstallRequirements = {
    providers: manifest.agents.flatMap((definition) => {
      if (!definition.modelRequirement) return [];
      const provider = providerByRequirement.get(
        `${definition.modelRequirement.format}\0${definition.modelRequirement.model}`,
      );
      return [{
        agentKey: definition.key,
        format: definition.modelRequirement.format,
        model: definition.modelRequirement.model,
        satisfied: Boolean(provider),
        ...(provider ? { providerId: provider.id } : {}),
      }];
    }),
    // Persist the complete requirement list, not only values missing during
    // installation. This lets the setup UI detect a required value that is
    // removed later without ever persisting or returning the secret itself.
    environment: manifest.deployments.flatMap((definition) => (
      definition.requiredEnv.map((variable) => ({
        deploymentKey: definition.key,
        variable,
        required: true as const,
      }))
    )),
    runtimes: manifest.agents.flatMap((definition) => (
      portableAgentRuntimeKind(definition) === HERMES_RUNTIME_KIND
        ? [{ agentKey: definition.key, kind: HERMES_RUNTIME_KIND, setupRequired: true as const }]
        : []
    )),
  };
  const resourceMap: AgentInstallResourceMap = {
    agents: agentMap,
    deployments: deploymentMap,
    skills: skillMap,
    toolkits: toolkitMap,
  };
  const hasMissingEnvironment = manifest.deployments.some((definition) => {
    const rawConfig = deploymentConfigByKey.get(definition.key);
    const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown>
      : {};
    const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? config.env as Record<string, unknown>
      : {};
    return definition.requiredEnv.some((variable) => (
      typeof env[variable] !== 'string' || !env[variable].trim()
    ));
  });
  const needsSetup = hasMissingEnvironment
    || requirements.providers.some(({ satisfied }) => !satisfied)
    || requirements.runtimes.length > 0;
  const rootAgent = createdAgents.get(manifest.rootAgentKey);
  if (!rootAgent) throw new AgentMarketError('invalid_manifest', 'The root agent could not be created.');
  const install = await tx.agentInstall.create({
    data: {
      releaseId: release.id,
      targetWorkspaceId: input.targetWorkspaceId,
      installedById: input.installedById,
      agentId: rootAgent.id,
      idempotencyKey: input.idempotencyKey,
      status: needsSetup ? 'needs_setup' : 'ready',
      requirements: requirements as Prisma.InputJsonValue,
      resourceMap: resourceMap as Prisma.InputJsonValue,
    },
    select: {
      id: true,
      releaseId: true,
      targetWorkspaceId: true,
      agentId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  await tx.agentListing.update({
    where: { id: release.listing.id },
    data: { installCount: { increment: 1 } },
  });
  return { install, agent: rootAgent, reused: false, requirements, resourceMap };
}

export async function materializeAgentRelease(input: {
  releaseId: string;
  targetWorkspaceId: string;
  installedById: string;
  idempotencyKey: string;
  name?: string;
}): Promise<MaterializeAgentReleaseResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AgentMarketError('idempotency_conflict', 'A valid idempotency key is required.');
  }
  const normalized = { ...input, idempotencyKey };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => materializeAgentReleaseTransaction(tx, normalized),
        { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof AgentMarketError) throw error;
      lastError = error;
      if (!isPrismaError(error, ['P2002', 'P2034'])) break;
    }
  }
  throw new AgentMarketError(
    'install_failed',
    'The agent release could not be installed.',
    lastError instanceof Error ? { cause: lastError.message } : undefined,
  );
}
