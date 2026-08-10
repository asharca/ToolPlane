import { describe, expect, it } from 'vitest';
import {
  AGENT_ENDPOINT_RUNTIME_MANAGED_BY,
  endpointAllowsTool,
  intersectEndpointTools,
  isAgentEndpointRuntimeSandboxConfig,
  parseAgentEndpointToolPolicy,
} from '@/lib/agents/public-api/tool-policy';

describe('Agent Endpoint tool policy', () => {
  it('parses a strict deployment-to-tool allowlist', () => {
    expect(parseAgentEndpointToolPolicy({
      dep1: ['read', 'read', '', 1],
      dep2: 'all',
    })).toEqual({ dep1: ['read'] });
  });

  it('intersects listed and called tools with the revision policy', () => {
    const policy = { dep1: ['read'] };
    expect(intersectEndpointTools([{ name: 'read' }, { name: 'write' }], policy, 'dep1'))
      .toEqual([{ name: 'read' }]);
    expect(endpointAllowsTool(policy, 'dep1', 'read')).toBe(true);
    expect(endpointAllowsTool(policy, 'dep1', 'write')).toBe(false);
  });

  it('recognizes the durable hidden-runtime sandbox marker', () => {
    expect(AGENT_ENDPOINT_RUNTIME_MANAGED_BY).toBe('agent-endpoint-runtime');
    expect(isAgentEndpointRuntimeSandboxConfig({
      managedBy: AGENT_ENDPOINT_RUNTIME_MANAGED_BY,
    })).toBe(true);
    expect(isAgentEndpointRuntimeSandboxConfig({ managedBy: 'agent-runtime' })).toBe(false);
  });
});
