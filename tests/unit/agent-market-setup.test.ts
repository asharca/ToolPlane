import { describe, expect, it } from 'vitest';
import {
  parseAgentMarketSetupGuide,
  type AgentMarketSetupCurrentState,
} from '@/lib/agents/market-setup';

function install(overrides: Record<string, unknown> = {}) {
  return {
    status: 'needs_setup',
    requirements: {
      providers: [
        {
          agentKey: 'agent_1',
          format: 'openai',
          model: 'gpt-5',
          satisfied: false,
        },
        {
          agentKey: 'agent_2',
          format: 'anthropic',
          model: 'claude-sonnet',
          satisfied: true,
          providerId: 'provider-private-id',
        },
      ],
      environment: [
        {
          deploymentKey: 'deployment_1',
          variable: 'CONFIGURED_API_KEY',
          required: true,
        },
        {
          deploymentKey: 'deployment_1',
          variable: 'MISSING_API_KEY',
          required: true,
        },
      ],
      runtimes: [] as Array<{ agentKey: string; kind: 'hermes'; setupRequired: true }>,
    },
    resourceMap: {
      agents: {
        agent_1: 'agent-target-1',
        agent_2: 'agent-target-2',
      },
      deployments: { deployment_1: 'deployment-target-1' },
      skills: { skill_1: 'skill-target-1' },
      toolkits: { toolkit_1: 'toolkit-target-1' },
    },
    ...overrides,
  };
}

function current(): AgentMarketSetupCurrentState {
  return {
    agents: [
      {
        id: 'agent-target-1',
        model: 'gpt-5',
        provider: { format: 'openai' },
      },
      {
        id: 'agent-target-2',
        model: null,
        provider: null,
      },
    ],
    deployments: [{
      id: 'deployment-target-1',
      installCfg: {
        env: {
          CONFIGURED_API_KEY: 'live-secret-value',
          MISSING_API_KEY: '   ',
        },
      },
    }],
  };
}

describe('parseAgentMarketSetupGuide', () => {
  it('uses current state instead of install-time provider and environment snapshots', () => {
    const guide = parseAgentMarketSetupGuide(install(), current());

    expect(guide).toEqual({
      missingProviders: [{
        agentId: 'agent-target-2',
        format: 'anthropic',
        model: 'claude-sonnet',
      }],
      environment: [{
        deploymentId: 'deployment-target-1',
        variable: 'MISSING_API_KEY',
      }],
      runtimes: [],
    });
    expect(JSON.stringify(guide)).not.toContain('live-secret-value');
    expect(JSON.stringify(guide)).not.toContain('provider-private-id');
    expect(JSON.stringify(guide)).not.toContain('CONFIGURED_API_KEY');
    expect(JSON.stringify(guide)).not.toContain('skill-target');
    expect(JSON.stringify(guide)).not.toContain('toolkit-target');
  });

  it('ignores stale ready status and recreates guidance after configuration is removed', () => {
    const readyInstall = install({ status: 'ready' });
    const configured = current();
    configured.agents[1] = {
      id: 'agent-target-2',
      model: 'claude-sonnet',
      provider: { format: 'anthropic' },
    };
    configured.deployments[0].installCfg = {
      env: {
        CONFIGURED_API_KEY: 'configured-secret',
        MISSING_API_KEY: 'also-configured-secret',
      },
    };
    expect(parseAgentMarketSetupGuide(readyInstall, configured)).toBeNull();

    configured.agents[1] = { id: 'agent-target-2', model: null, provider: null };
    configured.deployments[0].installCfg = { env: { CONFIGURED_API_KEY: 'configured-secret' } };
    expect(parseAgentMarketSetupGuide(readyInstall, configured)).toEqual({
      missingProviders: [{
        agentId: 'agent-target-2',
        format: 'anthropic',
        model: 'claude-sonnet',
      }],
      environment: [{
        deploymentId: 'deployment-target-1',
        variable: 'MISSING_API_KEY',
      }],
      runtimes: [],
    });
  });

  it('fails closed for extra fields, malformed variable names, and broken references', () => {
    expect(parseAgentMarketSetupGuide(
      { ...install(), leakedSecret: 'do-not-render' },
      current(),
    )).toBeNull();

    const malformedVariable = install();
    malformedVariable.requirements.environment[0].variable = 'API KEY=value';
    expect(parseAgentMarketSetupGuide(malformedVariable, current())).toBeNull();

    const validInstall = install();
    const missingDeployment = {
      ...validInstall,
      resourceMap: {
        ...validInstall.resourceMap,
        deployments: {},
      },
    };
    expect(parseAgentMarketSetupGuide(missingDeployment, current())).toBeNull();
  });

  it('does not expose deleted or out-of-workspace resource ids', () => {
    expect(parseAgentMarketSetupGuide(install(), {
      agents: [],
      deployments: [],
    })).toBeNull();
  });

  it('accepts persisted runtime requirements and links unfinished Hermes setup', () => {
    const value = install();
    value.requirements.runtimes = [{
      agentKey: 'agent_2',
      kind: 'hermes',
      setupRequired: true,
    }];
    const state = current();
    state.agents[1] = {
      id: 'agent-target-2',
      model: null,
      provider: null,
      runtimeKind: 'hermes',
      runtime: { status: 'setup_required' },
    };

    expect(parseAgentMarketSetupGuide(value, state)?.runtimes).toEqual([{
      agentId: 'agent-target-2',
      kind: 'hermes',
    }]);
  });
});
