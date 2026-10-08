import { createHash } from 'node:crypto';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import type { PiPackageManifestV1 } from '@/lib/market/pi-package-manifest';
import { describe, it, expect } from 'vitest';
import { resolveAgentTools, resolveAgentPiPackages } from '@/lib/agents/resolve';

const skill = (id: string) => ({
  installedSkill: {
    id,
    skillId: id,
    skill: { slug: id, name: id, description: null, author: null },
    name: null,
    slug: null,
    description: null,
    content: null,
    userInvocable: true,
    agentInvocable: true,
    effort: null,
  },
});

describe('resolveAgentTools', () => {
  it('merges direct servers/skills with toolkit-expanded ones and dedupes', () => {
    const { deploymentIds, skills } = resolveAgentTools({
      servers: [{ deploymentId: 'd1' }],
      skills: [skill('s1')],
      toolkits: [
        {
          toolkit: {
            servers: [{ deploymentId: 'd1' }, { deploymentId: 'd2' }],
            skills: [skill('s1'), skill('s2')],
          },
        },
      ],
    });
    expect(deploymentIds.sort()).toEqual(['d1', 'd2']);
    expect(skills.map((s) => s.skill?.slug).sort()).toEqual(['s1', 's2']);
  });

  it('returns empty arrays when nothing is attached', () => {
    expect(resolveAgentTools({ servers: [], skills: [], toolkits: [] })).toEqual({
      deploymentIds: [],
      sandboxDeploymentIds: [],
      skills: [],
      subAgents: [],
    });
  });

  it('adds only the selected sandbox deployment to the agent tool list', () => {
    const { deploymentIds, sandboxDeploymentIds } = resolveAgentTools({
      servers: [{ deploymentId: 'mcp1' }],
      skills: [],
      toolkits: [],
      sandboxes: [{ sandboxId: 'sandbox-id', isDefault: true, sandbox: { id: 'sandbox-id', deploymentId: 'sandbox1' } }],
    }, 'sandbox-id');
    expect(deploymentIds.sort()).toEqual(['mcp1', 'sandbox1']);
    expect(sandboxDeploymentIds).toEqual(['sandbox1']);
  });

  it('filters out skills where agentInvocable is false', () => {
    const s1 = skill('s1');
    const s2 = { installedSkill: { ...skill('s2').installedSkill, agentInvocable: false } };
    const { skills } = resolveAgentTools({ servers: [], skills: [s1, s2], toolkits: [] });
    expect(skills).toHaveLength(1);
    expect(skills[0].skill?.slug).toBe('s1');
  });

  it('does not treat legacy draft status as a visibility gate', () => {
    const draftSkill = {
      installedSkill: {
        id: 'custom-draft',
        skillId: null,
        skill: null,
        name: 'Draft Skill',
        slug: 'draft-skill',
        description: null,
        content: null,
        userInvocable: true,
        agentInvocable: true,
        effort: null,
        status: 'draft',
      },
    };
    const publishedSkill = {
      installedSkill: {
        id: 'custom-published',
        skillId: null,
        skill: null,
        name: 'Published Skill',
        slug: 'published-skill',
        description: null,
        content: null,
        userInvocable: true,
        agentInvocable: true,
        effort: null,
        status: 'published',
      },
    };
    const { skills } = resolveAgentTools({ servers: [], skills: [draftSkill, publishedSkill], toolkits: [] });
    expect(skills.map((s) => s.slug).sort()).toEqual(['draft-skill', 'published-skill']);
  });

  it('does not expose a Hermes-owned system prompt as a sub-agent description', () => {
    const { subAgents } = resolveAgentTools({
      servers: [],
      skills: [],
      toolkits: [],
      subAgents: [{
        child: {
          id: 'hermes-1',
          name: 'Hermes',
          slug: 'hermes',
          systemPrompt: 'Legacy ToolPlane prompt',
          runtimeKind: 'hermes',
        },
      }],
    });

    expect(subAgents).toEqual([{
      id: 'hermes-1',
      name: 'Hermes',
      slug: 'hermes',
      description: null,
    }]);
  });
});

function sdkAgent() {
  const bytes = Buffer.from('export default function() {}\n');
  const manifest: PiPackageManifestV1 = {
    schemaVersion: 1,
    kind: 'pi-package',
    listing: { slug: 'resolver-fixture', name: 'Resolver fixture', summary: null, iconUrl: null, tags: [], author: 'Fixture' },
    package: {
      source: { kind: 'npm', requested: 'npm:resolver-fixture@1.0.0', name: 'resolver-fixture', version: '1.0.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
      name: 'resolver-fixture', version: '1.0.0',
      runtime: { kind: 'pi-sdk', piVersion: '0.87.1', nodeMajor: 24, platform: 'linux', arch: 'arm64' },
      root: 'package', resources: { extensions: ['package/index.js'], skills: [], prompts: [], themes: [] },
      entries: [
        { type: 'directory', path: 'package' },
        { type: 'file', path: 'package/index.js', contentEncoding: 'base64', content: bytes.toString('base64'), executable: false, sha256: createHash('sha256').update(bytes).digest('hex') },
      ],
    },
  };
  return {
    runtimeKind: 'pi-sdk', workspaceId: 'workspace-a',
    piPackages: [{
      marketInstallId: 'install-z', releaseId: 'release-v1',
      marketInstall: { id: 'install-z', targetWorkspaceId: 'workspace-a', listingId: 'listing-a', status: 'ready', resourceMap: {} as unknown, listing: { id: 'listing-a', kind: 'pi-package', status: 'published' } },
      release: { id: 'release-v1', listingId: 'listing-a', reviewStatus: 'approved', checksum: marketReleaseChecksum(manifest), manifest },
    }],
  };
}

describe('resolveAgentPiPackages', () => {
  it('adds composed MCP bindings without granting unrequested tools or narrowing explicit servers', () => {
    const agent = { ...sdkAgent(), servers: [] as { deploymentId: string }[], skills: [], toolkits: [] };
    const binding = agent.piPackages[0];
    binding.release.manifest.package.toolplane = { schemaVersion: 1, mcp: [{ key: 'docs', name: 'Docs', tools: ['search'] }] };
    binding.release.checksum = marketReleaseChecksum(binding.release.manifest);
    binding.marketInstall.resourceMap = { kind: 'pi-package', mcpBindings: { docs: { deploymentId: 'docs-server', tools: ['search', 'delete'] } } };
    expect(resolveAgentTools(agent)).toMatchObject({ deploymentIds: ['docs-server'], mcpToolPolicy: { 'docs-server': ['search'] } });
    agent.servers.push({ deploymentId: 'docs-server' });
    expect(resolveAgentTools(agent)).not.toHaveProperty('mcpToolPolicy');
    binding.marketInstall.resourceMap = { kind: 'pi-package', mcpBindings: { docs: { deploymentId: 'docs-server', tools: ['delete'] } } };
    expect(() => resolveAgentTools(agent)).toThrow('PI_PACKAGE_MCP_BINDING_REQUIRED');
  });
  it('preserves pinned release identities while sorting the enabled set', () => {
    const agent = sdkAgent();
    const first = structuredClone(agent.piPackages[0]);
    first.marketInstallId = first.marketInstall.id = 'install-a';
    agent.piPackages.push(first);
    expect(resolveAgentPiPackages(agent).map(({ marketInstallId, releaseId, checksum }) => ({ marketInstallId, releaseId, checksum }))).toEqual([
      { marketInstallId: 'install-a', releaseId: 'release-v1', checksum: first.release.checksum },
      { marketInstallId: 'install-z', releaseId: 'release-v1', checksum: first.release.checksum },
    ]);
  });
  it.each(['workspace', 'install-status', 'listing-status', 'listing-kind', 'release-status', 'release-identity', 'release-listing', 'checksum', 'bytes', 'duplicate'] as const)('fails closed after %s becomes invalid', (field) => {
    const agent = sdkAgent();
    const binding = agent.piPackages[0];
    switch (field) {
      case 'workspace': binding.marketInstall.targetWorkspaceId = 'workspace-b'; break;
      case 'install-status': binding.marketInstall.status = 'failed'; break;
      case 'listing-status': binding.marketInstall.listing.status = 'unpublished'; break;
      case 'listing-kind': binding.marketInstall.listing.kind = 'skill'; break;
      case 'release-status': binding.release.reviewStatus = 'rejected'; break;
      case 'release-identity': binding.release.id = 'release-v2'; break;
      case 'release-listing': binding.release.listingId = 'other-listing'; break;
      case 'checksum': binding.release.checksum = '0'.repeat(64); break;
      case 'bytes': {
        const file = binding.release.manifest.package.entries[1];
        if (file.type !== 'file') throw new Error('Invalid fixture');
        file.content = Buffer.from('changed executable bytes').toString('base64');
        break;
      }
      case 'duplicate': agent.piPackages.push(structuredClone(binding)); break;
    }
    expect(() => resolveAgentPiPackages(agent)).toThrow('PI_PACKAGE_UNAVAILABLE');
  });
  it('rejects a missing SDK execution projection rather than silently loading no extensions', () => {
    expect(() => resolveAgentPiPackages({ runtimeKind: 'pi-sdk', workspaceId: 'workspace-a' })).toThrow('PI_PACKAGE_UNAVAILABLE');
    expect(resolveAgentPiPackages({ runtimeKind: 'pi-sdk', workspaceId: 'workspace-a', piPackages: [] })).toEqual([]);
    expect(resolveAgentPiPackages({ runtimeKind: 'pi', workspaceId: 'workspace-a' })).toEqual([]);
  });
});
