// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  getToolkitMcpCandidates,
  getToolkitSkillCandidates,
} from '@/lib/toolkits/queries';

const stamp = Date.now();
const ownerEmail = `toolkit-candidates-owner-${stamp}@test.dev`;
const foreignEmail = `toolkit-candidates-foreign-${stamp}@test.dev`;
const ownerSlug = `toolkit-candidates-owner-${stamp}`;
const foreignSlug = `toolkit-candidates-foreign-${stamp}`;

let ownerWorkspaceId = '';
let toolkitId = '';
let availableDeploymentIds: string[] = [];
let availableSkillIds: string[] = [];

describe('toolkit candidate queries', () => {
  beforeAll(async () => {
    const [owner, foreign] = await Promise.all([
      db.user.create({ data: { email: ownerEmail, passwordHash: 'x' } }),
      db.user.create({ data: { email: foreignEmail, passwordHash: 'x' } }),
    ]);
    const [ownerWorkspace, foreignWorkspace] = await Promise.all([
      db.workspace.create({
        data: {
          slug: ownerSlug,
          name: 'Toolkit Candidates Owner',
          ownerId: owner.id,
          members: { create: { userId: owner.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: foreignSlug,
          name: 'Toolkit Candidates Foreign',
          ownerId: foreign.id,
          members: { create: { userId: foreign.id, role: 'owner' } },
        },
      }),
    ]);
    ownerWorkspaceId = ownerWorkspace.id;

    const toolkit = await db.toolkit.create({
      data: { workspaceId: ownerWorkspace.id, slug: 'candidate-kit', name: 'Candidate Kit' },
    });
    toolkitId = toolkit.id;

    const [availableMcp, availableNullSourceMcp, linkedMcp] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Available MCP',
          source: 'npm',
          sourceRef: '@example/available-mcp',
          installCfg: { command: 'npx' },
          status: 'stopped',
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Available MCP Without Source',
          source: null,
          installCfg: { command: 'node' },
          status: 'stopped',
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Linked MCP',
          source: 'docker',
          sourceRef: 'example/linked-mcp:latest',
          installCfg: { image: 'example/linked-mcp:latest' },
          status: 'stopped',
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Sandbox MCP',
          source: 'sandbox',
          sourceRef: 'sandbox',
          installCfg: { image: 'sandbox:latest' },
          status: 'stopped',
        },
      }),
    ]);
    availableDeploymentIds = [availableMcp.id, availableNullSourceMcp.id];
    await Promise.all([
      db.toolkitServer.create({
        data: { toolkitId: toolkit.id, deploymentId: linkedMcp.id },
      }),
      db.deployment.create({
        data: {
          workspaceId: foreignWorkspace.id,
          name: 'Foreign MCP',
          source: 'npm',
          sourceRef: '@example/foreign-mcp',
          installCfg: { command: 'npx' },
          status: 'stopped',
        },
      }),
    ]);

    const [availableSkill, linkedSkill] = await Promise.all([
      db.installedSkill.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Available Skill',
          slug: 'available-skill',
          description: 'Available for the toolkit',
          content: '# Available Skill',
          files: { 'scripts/run.ts': 'console.log("available")' },
          source: 'github',
          sourceRef: 'example/skills/available-skill',
        },
      }),
      db.installedSkill.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Linked Skill',
          slug: 'linked-skill',
          content: '# Linked Skill',
          files: { 'scripts/run.ts': 'console.log("linked")' },
          source: 'upload',
        },
      }),
    ]);
    availableSkillIds = [availableSkill.id];
    await Promise.all([
      db.toolkitSkill.create({
        data: { toolkitId: toolkit.id, installedSkillId: linkedSkill.id },
      }),
      db.installedSkill.create({
        data: {
          workspaceId: foreignWorkspace.id,
          name: 'Foreign Skill',
          slug: 'foreign-skill',
          content: '# Foreign Skill',
          files: { 'scripts/run.ts': 'console.log("foreign")' },
          source: 'github',
        },
      }),
    ]);

  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug: { in: [ownerSlug, foreignSlug] } } });
    await db.user.deleteMany({ where: { email: { in: [ownerEmail, foreignEmail] } } });
    await db.$disconnect();
  });

  it('returns only unlinked, non-sandbox MCPs from the toolkit workspace', async () => {
    const candidates = await getToolkitMcpCandidates(ownerWorkspaceId, toolkitId);

    expect(candidates.map(({ id }) => id).sort()).toEqual([...availableDeploymentIds].sort());
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('installCfg');
    }
  });

  it('returns only unlinked skills from the toolkit workspace without artifact fields', async () => {
    const candidates = await getToolkitSkillCandidates(ownerWorkspaceId, toolkitId);

    expect(candidates.map(({ id }) => id)).toEqual(availableSkillIds);
    for (const candidate of candidates) {
      expect(candidate).not.toHaveProperty('content');
      expect(candidate).not.toHaveProperty('files');
    }
  });
});
