// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseAgentReleaseManifest,
  summarizeAgentReleaseManifest,
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
});
