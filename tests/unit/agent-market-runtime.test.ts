// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  agentReleaseChecksum,
  buildCatalogAgentManifest,
  parseAgentReleaseManifest,
  summarizeAgentReleaseManifest,
  type AgentReleaseManifestV1,
} from '@/lib/agents/market';

function manifest(runtime?: { kind: 'pi' }) {
  return {
    schemaVersion: 1,
    rootAgentKey: 'agent_1',
    agents: [{
      key: 'agent_1',
      name: 'Researcher',
      slug: 'researcher',
      systemPrompt: null,
      maxSteps: 8,
      modelRequirement: null,
      ...(runtime ? { runtime } : {}),
      deploymentKeys: [],
      skillKeys: [],
      toolkitKeys: [],
      subAgentKeys: [],
    }],
    deployments: [],
    skills: [],
    toolkits: [],
  };
}

describe('Agent market runtime manifests', () => {
  it('preserves legacy v1 manifests while identifying their runtime as Pi', () => {
    const parsed = parseAgentReleaseManifest(manifest());

    expect(parsed.agents[0].runtime).toBeUndefined();
    expect(summarizeAgentReleaseManifest(parsed).runtimes).toEqual(['pi']);
  });

  it('accepts the explicit Pi runtime emitted by new releases', () => {
    const parsed = parseAgentReleaseManifest(manifest({ kind: 'pi' }));

    expect(parsed.agents[0].runtime).toEqual({ kind: 'pi' });
    expect(summarizeAgentReleaseManifest(parsed).runtimes).toEqual(['pi']);
  });

  it('verifies legacy zero-step manifests before normalizing them to the current default', () => {
    const legacy = manifest() as AgentReleaseManifestV1;
    legacy.agents[0].maxSteps = 0;

    const parsed = parseAgentReleaseManifest(legacy, agentReleaseChecksum(legacy));

    expect(parsed.agents[0].maxSteps).toBe(100);
  });

  it('uses the current default when a catalog source has no finite limit', async () => {
    const parsed = await buildCatalogAgentManifest({} as never, {
      name: 'Researcher',
      slug: 'researcher',
      systemPrompt: null,
      maxSteps: Number.NaN,
    });

    expect(parsed.agents[0].maxSteps).toBe(100);
  });
});
