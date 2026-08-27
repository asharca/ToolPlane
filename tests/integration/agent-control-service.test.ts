// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createConfiguredAgent } from '@/lib/agents/mutations';
import {
  createAgentFromControl,
  getAgentControlAgent,
  listAgentControlAgents,
  listAgentControlResources,
  type CreateAgentFromControlInput,
} from '@/lib/agents/control-service';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let ownerId = '';
let workspaceId = '';
let workspaceSlug = '';
let providerId = '';
let deploymentId = '';
let sandboxDeploymentId = '';
let installedSkillId = '';
let toolkitId = '';
let sandboxId = '';
let childAgentId = '';
let foreignOwnerId = '';
let foreignWorkspaceId = '';
let foreignProviderId = '';
let foreignDeploymentId = '';
let foreignSkillId = '';
let foreignToolkitId = '';
let foreignSandboxId = '';
let foreignAgentId = '';

beforeAll(async () => {
  const owner = await db.user.create({
    data: { email: `agent-control-owner-${stamp}@test.dev`, passwordHash: 'x' },
  });
  ownerId = owner.id;
  workspaceSlug = `agent-control-${stamp}`;
  const workspace = await db.workspace.create({
    data: {
      slug: workspaceSlug,
      name: 'Agent control',
      ownerId,
      members: { create: { userId: ownerId, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: 'Safe provider',
      format: 'openai',
      baseUrl: 'https://secret-provider.invalid/v1',
      apiKey: 'SUPER_SECRET_PROVIDER_KEY',
      models: ['model-safe'],
    },
  });
  providerId = provider.id;
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: 'Safe MCP',
      source: 'npm',
      sourceRef: 'safe-mcp',
      status: 'stopped',
      installCfg: { env: { TOKEN: 'SUPER_SECRET_DEPLOYMENT_ENV' } },
    },
  });
  deploymentId = deployment.id;
  const skill = await db.installedSkill.create({
    data: {
      workspaceId,
      name: 'Safe skill',
      slug: `safe-skill-${stamp}`,
      description: 'Safe public description',
      content: '# SUPER_SECRET_SKILL_CONTENT',
      files: { 'secret.txt': 'SUPER_SECRET_SKILL_FILE' },
      source: 'upload',
    },
  });
  installedSkillId = skill.id;
  const toolkit = await db.toolkit.create({
    data: {
      workspaceId,
      name: 'Safe toolkit',
      slug: `safe-toolkit-${stamp}`,
      servers: { create: { deploymentId } },
      skills: { create: { installedSkillId } },
    },
  });
  toolkitId = toolkit.id;
  const sandboxDeployment = await db.deployment.create({
    data: { workspaceId, name: 'Sandbox runtime', source: 'sandbox', status: 'stopped' },
  });
  sandboxDeploymentId = sandboxDeployment.id;
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: sandboxDeployment.id,
      name: 'Safe sandbox',
      slug: `safe-sandbox-${stamp}`,
      kind: 'docker',
      config: { env: { TOKEN: 'SUPER_SECRET_SANDBOX_ENV' } },
    },
  });
  sandboxId = sandbox.id;
  const child = await db.agent.create({
    data: { workspaceId, name: 'Child agent', slug: `child-${stamp}`, runtimeKind: 'pi' },
  });
  childAgentId = child.id;

  const foreignOwner = await db.user.create({
    data: { email: `agent-control-foreign-${stamp}@test.dev`, passwordHash: 'x' },
  });
  foreignOwnerId = foreignOwner.id;
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `agent-control-foreign-${stamp}`,
      name: 'Foreign',
      ownerId: foreignOwnerId,
      members: { create: { userId: foreignOwnerId, role: 'owner' } },
    },
  });
  foreignWorkspaceId = foreignWorkspace.id;
  const foreignProvider = await db.modelProvider.create({
    data: {
      workspaceId: foreignWorkspaceId,
      name: 'Foreign provider',
      format: 'openai',
      baseUrl: 'https://foreign.invalid/v1',
      apiKey: 'foreign-key',
    },
  });
  foreignProviderId = foreignProvider.id;
  const foreignDeployment = await db.deployment.create({
    data: { workspaceId: foreignWorkspaceId, name: 'Foreign MCP', source: 'npm' },
  });
  foreignDeploymentId = foreignDeployment.id;
  const foreignSkill = await db.installedSkill.create({
    data: { workspaceId: foreignWorkspaceId, name: 'Foreign skill', slug: `foreign-skill-${stamp}` },
  });
  foreignSkillId = foreignSkill.id;
  const foreignToolkit = await db.toolkit.create({
    data: { workspaceId: foreignWorkspaceId, name: 'Foreign toolkit', slug: `foreign-tk-${stamp}` },
  });
  foreignToolkitId = foreignToolkit.id;
  const foreignSandboxDeployment = await db.deployment.create({
    data: { workspaceId: foreignWorkspaceId, name: 'Foreign sandbox dep', source: 'sandbox', status: 'stopped' },
  });
  const foreignSandbox = await db.sandbox.create({
    data: {
      workspaceId: foreignWorkspaceId,
      deploymentId: foreignSandboxDeployment.id,
      name: 'Foreign sandbox',
      slug: `foreign-sandbox-${stamp}`,
    },
  });
  foreignSandboxId = foreignSandbox.id;
  const foreignAgent = await db.agent.create({
    data: { workspaceId: foreignWorkspaceId, name: 'Foreign agent', slug: `foreign-agent-${stamp}`, runtimeKind: 'pi' },
  });
  foreignAgentId = foreignAgent.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.workspace.delete({ where: { id: foreignWorkspaceId } });
  await db.user.delete({ where: { id: ownerId } });
  await db.user.delete({ where: { id: foreignOwnerId } });
  await db.$disconnect();
});

function createInput(overrides: Partial<CreateAgentFromControlInput> = {}): CreateAgentFromControlInput {
  return {
    name: `Created agent ${Math.random().toString(36).slice(2)}`,
    runtime: 'pi',
    systemPrompt: 'Use the attached tools carefully.',
    providerId,
    providerIds: [],
    model: 'model-safe',
    maxSteps: 12,
    deploymentIds: [deploymentId],
    installedSkillIds: [installedSkillId],
    toolkitIds: [toolkitId],
    sandboxIds: [sandboxId],
    subAgentIds: [childAgentId],
    ...overrides,
  };
}

describe('Agent Control service', () => {
  it('returns discoverable resources without provider, deployment, skill, or sandbox secrets', async () => {
    const resources = await listAgentControlResources(workspaceId);
    expect(resources.providers).toContainEqual({
      id: providerId,
      name: 'Safe provider',
      format: 'openai',
      models: ['model-safe'],
    });
    expect(resources.deployments.some(({ id }) => id === deploymentId)).toBe(true);
    expect(resources.deployments.some(({ id }) => id === sandboxDeploymentId)).toBe(false);
    const serialized = JSON.stringify(resources);
    expect(serialized).not.toContain('SUPER_SECRET');
    expect(serialized).not.toContain('secret-provider.invalid');
    expect(serialized).not.toContain('installCfg');
    expect(serialized).not.toContain('content');
    expect(serialized).not.toContain('config');
  });

  it('atomically creates a configured native agent with all workspace bindings', async () => {
    const result = await createAgentFromControl(workspaceId, workspaceSlug, createInput({
      name: 'Atomic research agent',
    }));

    expect(result.created).toBe(true);
    expect(result.agent).toMatchObject({
      name: 'Atomic research agent',
      configured: true,
      ready: true,
      systemPrompt: 'Use the attached tools carefully.',
      maxSteps: 12,
      model: { providerId, model: 'model-safe' },
    });
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: result.agent.id },
      include: { servers: true, skills: true, toolkits: true, sandboxes: true, subAgents: true },
    });
    expect(stored.servers.map(({ deploymentId: id }) => id)).toEqual([deploymentId]);
    expect(stored.skills.map(({ installedSkillId: id }) => id)).toEqual([installedSkillId]);
    expect(stored.toolkits.map(({ toolkitId: id }) => id)).toEqual([toolkitId]);
    expect(stored.sandboxes.map(({ sandboxId: id }) => id)).toEqual([sandboxId]);
    expect(stored.subAgents.map(({ childId: id }) => id)).toEqual([childAgentId]);

    const safe = await getAgentControlAgent(workspaceId, workspaceSlug, result.agent.id);
    expect(JSON.stringify(safe)).not.toContain('SUPER_SECRET');
    expect(JSON.stringify(await listAgentControlAgents(workspaceId))).not.toContain('SUPER_SECRET');
  });

  it('atomically creates Hermes runtime records and multi-provider bindings before Docker sync', async () => {
    const created = await createConfiguredAgent(
      workspaceId,
      {
        name: 'Hermes control agent',
        systemPrompt: null,
        providerId: null,
        providerIds: [providerId],
        model: null,
        maxSteps: 20,
      },
      {
        deploymentIds: [deploymentId],
        installedSkillIds: [installedSkillId],
        toolkitIds: [],
      },
      { runtime: 'hermes', hermesImage: 'nousresearch/hermes-agent:v2026.8.3' },
    );
    const stored = await db.agent.findUniqueOrThrow({
      where: { id: created.id },
      include: { runtime: true, modelProviders: true },
    });
    expect(stored).toMatchObject({
      providerId: null,
      model: null,
      systemPrompt: null,
      maxSteps: 20,
      runtime: {
        kind: 'hermes',
        image: 'nousresearch/hermes-agent:v2026.8.3',
        status: 'setup_required',
      },
    });
    expect(stored.modelProviders.map(({ providerId: id }) => id)).toEqual([providerId]);
    await expect(getAgentControlAgent(workspaceId, workspaceSlug, created.id)).resolves.toMatchObject({
      configured: true,
      ready: false,
      runtime: { kind: 'hermes', status: 'setup_required' },
    });
  });

  it.each([
    ['provider', () => createInput({ providerId: foreignProviderId })],
    ['deployment', () => createInput({ deploymentIds: [foreignDeploymentId] })],
    ['skill', () => createInput({ installedSkillIds: [foreignSkillId] })],
    ['toolkit', () => createInput({ toolkitIds: [foreignToolkitId] })],
    ['sandbox', () => createInput({ sandboxIds: [foreignSandboxId] })],
    ['sub-agent', () => createInput({ subAgentIds: [foreignAgentId] })],
  ])('rejects a foreign-workspace %s without leaving a partial agent', async (_label, buildInput) => {
    const before = await db.agent.count({ where: { workspaceId } });
    await expect(createAgentFromControl(workspaceId, workspaceSlug, buildInput()))
      .rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(db.agent.count({ where: { workspaceId } })).resolves.toBe(before);
  });
});
