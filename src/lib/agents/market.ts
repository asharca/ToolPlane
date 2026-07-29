import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';

export const AGENT_MARKET_MANIFEST_VERSION = 1 as const;

const MAX_GRAPH_AGENTS = 64;
const MAX_GRAPH_RESOURCES = 512;
const MAX_MANIFEST_BYTES = 32_000_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const modelRequirementSchema = z.object({
  format: z.string().min(1).max(64),
  model: z.string().min(1).max(240),
}).strict();

const portableAgentSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  slug: z.string().min(1).max(120),
  systemPrompt: z.string().nullable(),
  maxSteps: z.number().int().min(0).max(1000),
  modelRequirement: modelRequirementSchema.nullable(),
  deploymentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  skillKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  toolkitKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_RESOURCES),
  subAgentKeys: z.array(z.string().min(1).max(80)).max(MAX_GRAPH_AGENTS),
}).strict();

const portableDeploymentSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  catalogSlug: z.string().min(1).max(240),
  source: z.enum(['npm', 'pypi', 'github', 'docker']),
  sourceRef: z.string().min(1).max(2000),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(256),
  publicEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  startCommand: z.string().min(1).max(4000).optional(),
  network: z.literal('none').optional(),
  mcpToolExposure: z.enum(['all', 'allowlist']),
  mcpAllowedTools: z.array(z.string().min(1).max(240)).max(1000),
}).strict();

const skillFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string(),
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
  content: z.string(),
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
}).strict();

const agentReleaseSummarySchema = z.object({
  agentCount: z.number().int().nonnegative(),
  subAgentCount: z.number().int().nonnegative(),
  deploymentCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
  toolkitCount: z.number().int().nonnegative(),
  resourceCount: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  models: z.array(modelRequirementSchema),
  runtimes: z.array(z.literal('native')),
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
  }).strict()),
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

export type PublicAgentListingSummary = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  iconUrl: string | null;
  tags: string[];
  publishedAt: Date;
  updatedAt: Date;
  installCount: number;
  workspaceSlug: string;
  workspaceName: string;
  latestReleaseId: string;
  latestVersion: number;
  releaseSummary: AgentReleaseSummary;
};

export type PublicAgentListingDetail = {
  listing: {
    id: string;
    slug: string;
    name: string;
    summary: string | null;
    iconUrl: string | null;
    tags: string[];
    status: 'published';
    publishedAt: Date;
    updatedAt: Date;
    installCount: number;
  };
  workspace: { slug: string; name: string };
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
  name: string;
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
  systemPrompt: true,
  model: true,
  maxSteps: true,
  provider: { select: { id: true, workspaceId: true, format: true } },
  runtime: { select: { id: true, kind: true } },
  sandboxes: { select: { sandbox: { select: { id: true, workspaceId: true, kind: true } } } },
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortedRecord(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function manifestChecksum(manifest: AgentReleaseManifestV1): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function parseManifest(raw: unknown, expectedChecksum?: string): AgentReleaseManifestV1 {
  const parsed = agentReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentMarketError('invalid_manifest', 'The agent release manifest is invalid.', {
      issues: parsed.error.issues,
    });
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new AgentMarketError('invalid_manifest', 'The agent release manifest is too large.');
  }
  if (expectedChecksum && manifestChecksum(parsed.data) !== expectedChecksum) {
    throw new AgentMarketError('invalid_manifest', 'The agent release checksum does not match.');
  }
  return parsed.data;
}

function buildReleaseSummary(manifest: AgentReleaseManifestV1): AgentReleaseSummary {
  const models = new Map<string, AgentModelRequirement>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    models.set(`${agent.modelRequirement.format}\0${agent.modelRequirement.model}`, agent.modelRequirement);
  }
  const deploymentCount = manifest.deployments.length;
  const skillCount = manifest.skills.length;
  const toolkitCount = manifest.toolkits.length;
  const subAgentCount = Math.max(0, manifest.agents.length - 1);
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
    runtimes: ['native'],
  };
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
    if (agent.runtime) {
      pushIssue(state, {
        code: 'unsupported_runtime',
        path: `${path}.runtime`,
        message: `Runtime "${agent.runtime.kind}" is not portable in agent marketplace v1.`,
        resourceId: agent.runtime.id,
      });
    }
    if (agent.sandboxes.length > 0) {
      for (const { sandbox } of agent.sandboxes) {
        pushIssue(state, {
          code: 'external_sandbox',
          path: `${path}.sandboxes`,
          message: 'Agents with attached sandboxes are not portable in agent marketplace v1.',
          resourceId: sandbox.id,
        });
      }
    }
    if (agent.provider && agent.provider.workspaceId !== workspaceId) {
      pushIssue(state, {
        code: 'cross_workspace_provider',
        path: `${path}.provider`,
        message: 'The model provider belongs to another workspace.',
        resourceId: agent.provider.id,
      });
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

    state.agents.push({
      key,
      name: agent.name,
      slug: slugify(agent.slug || agent.name, 'agent'),
      systemPrompt: agent.systemPrompt,
      maxSteps: agent.maxSteps,
      modelRequirement: agent.provider && agent.provider.workspaceId === workspaceId && agent.model
        ? { format: agent.provider.format, model: agent.model }
        : null,
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
  return { portable: true, issues: [], manifest, summary: buildReleaseSummary(manifest) };
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
        select: { id: true, slug: true, name: true },
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

      const listing = existing
        ? await tx.agentListing.update({
            where: { id: existing.id },
            data: {
              publishedById: input.publishedById,
              slug: listingSlug,
              name: listingName,
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
              name: listingName,
              summary: listingSummary,
              iconUrl,
              tags,
            },
          });
      const version = listing.latestVersion + 1;
      const checksum = manifestChecksum(assessment.manifest);
      const release = await tx.agentRelease.create({
        data: {
          listingId: listing.id,
          version,
          manifestVersion: AGENT_MARKET_MANIFEST_VERSION,
          manifest: assessment.manifest as Prisma.InputJsonValue,
          releaseSummary: assessment.summary as Prisma.InputJsonValue,
          checksum,
        },
      });
      const publishedAt = release.publishedAt;
      const publishedListing = await tx.agentListing.update({
        where: { id: listing.id },
        data: {
          status: 'published',
          latestVersion: version,
          latestReleaseId: release.id,
          publishedAt,
        },
      });
      return { listing: publishedListing, release };
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
  actorId?: string;
}): Promise<{ id: string; status: string } | null> {
  return db.$transaction(async (tx) => {
    if (input.actorId) await assertPublisherAccess(tx, input.workspaceId, input.actorId);
    const listing = await tx.agentListing.findFirst({
      where: {
        publisherWorkspaceId: input.workspaceId,
        sourceAgentId: input.agentId,
      },
      select: { id: true },
    });
    if (!listing) return null;
    return tx.agentListing.update({
      where: { id: listing.id },
      data: { status: 'disabled' },
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
      name: true,
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
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
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
  };
}

export async function listPublicAgentListings(input: {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'newest' | 'popular';
} = {}): Promise<{
  items: PublicAgentListingSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)));
  const term = input.q?.trim().slice(0, 200) ?? '';
  const normalizedTag = term.toLocaleLowerCase();
  const where: Prisma.AgentListingWhereInput = {
    status: 'published',
    latestReleaseId: { not: null },
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { summary: { contains: term, mode: 'insensitive' } },
            { slug: { contains: term, mode: 'insensitive' } },
            { publisherWorkspace: { name: { contains: term, mode: 'insensitive' } } },
            { publisherWorkspace: { slug: { contains: term, mode: 'insensitive' } } },
            { tags: { has: normalizedTag } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.AgentListingOrderByWithRelationInput[] = input.sort === 'newest'
    ? [{ publishedAt: 'desc' }, { updatedAt: 'desc' }]
    : [{ installCount: 'desc' }, { publishedAt: 'desc' }];
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
        name: true,
        summary: true,
        iconUrl: true,
        tags: true,
        publishedAt: true,
        updatedAt: true,
        installCount: true,
        latestVersion: true,
        publisherWorkspace: { select: { slug: true, name: true } },
        latestRelease: { select: { id: true, releaseSummary: true } },
      },
    }),
  ]);

  const items: PublicAgentListingSummary[] = [];
  for (const row of rows) {
    if (!row.latestRelease || !row.publishedAt) continue;
    items.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      installCount: row.installCount,
      workspaceSlug: row.publisherWorkspace.slug,
      workspaceName: row.publisherWorkspace.name,
      latestReleaseId: row.latestRelease.id,
      latestVersion: row.latestVersion,
      releaseSummary: parseReleaseSummary(row.latestRelease.releaseSummary),
    });
  }
  return { items, total, page, pageSize };
}

export async function getPublicAgentListing(
  workspaceSlug: string,
  listingSlug: string,
): Promise<PublicAgentListingDetail | null> {
  const row = await db.agentListing.findFirst({
    where: {
      slug: listingSlug,
      status: 'published',
      publisherWorkspace: { slug: workspaceSlug },
      latestReleaseId: { not: null },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      summary: true,
      iconUrl: true,
      tags: true,
      status: true,
      publishedAt: true,
      updatedAt: true,
      installCount: true,
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
  if (!row?.latestRelease || !row.publishedAt || row.latestRelease.manifestVersion !== 1) return null;
  const manifest = parseManifest(row.latestRelease.manifest, row.latestRelease.checksum);
  return {
    listing: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      iconUrl: row.iconUrl,
      tags: row.tags,
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
      listing: { select: { id: true, status: true } },
    },
  });
  if (!release) throw new AgentMarketError('release_not_found', 'The agent release was not found.');
  if (release.listing.status !== 'published') {
    throw new AgentMarketError('listing_unavailable', 'This agent listing is not currently available.');
  }
  if (release.manifestVersion !== AGENT_MARKET_MANIFEST_VERSION) {
    throw new AgentMarketError('invalid_manifest', 'This agent release uses an unsupported manifest version.');
  }
  const manifest = parseManifest(release.manifest, release.checksum);
  validateManifestReferences(manifest);

  const uniqueModelRequirements = new Map<string, AgentModelRequirement>();
  for (const agent of manifest.agents) {
    if (!agent.modelRequirement) continue;
    uniqueModelRequirements.set(
      `${agent.modelRequirement.format}\0${agent.modelRequirement.model}`,
      agent.modelRequirement,
    );
  }
  const providerClauses = [...uniqueModelRequirements.values()].map((requirement) => ({
    format: requirement.format,
    models: { has: requirement.model },
  }));
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

  const deploymentMap: Record<string, string> = {};
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
      select: { id: true },
    });
    deploymentMap[definition.key] = deployment.id;
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
    const agent = await tx.agent.create({
      data: {
        workspaceId: input.targetWorkspaceId,
        name: requestedName,
        slug: agentSlug,
        systemPrompt: definition.systemPrompt,
        providerId: provider?.id ?? null,
        model: provider && requirement ? requirement.model : null,
        maxSteps: definition.maxSteps,
      },
      select: { id: true, name: true, slug: true },
    });
    agentMap[definition.key] = agent.id;
    createdAgents.set(definition.key, agent);
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
    environment: manifest.deployments.flatMap((definition) => (
      definition.requiredEnv.map((variable) => ({
        deploymentKey: definition.key,
        variable,
        required: true as const,
      }))
    )),
  };
  const resourceMap: AgentInstallResourceMap = {
    agents: agentMap,
    deployments: deploymentMap,
    skills: skillMap,
    toolkits: toolkitMap,
  };
  const needsSetup = requirements.environment.length > 0
    || requirements.providers.some(({ satisfied }) => !satisfied);
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
