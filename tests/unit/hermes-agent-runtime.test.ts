import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_HERMES_IMAGE, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { renderHermesConfig, renderHermesSkillBundle } from '@/lib/agents/hermes/config';
import {
  createHermesDashboardAccessToken,
  createHermesDashboardPath,
  createHermesDashboardBrokerAccessToken,
  deriveHermesRuntimeToken,
  verifyHermesDashboardAccessToken,
  verifyHermesDashboardBrokerAccessToken,
  verifyHermesRuntimeToken,
} from '@/lib/agents/hermes/token';

describe('Hermes agent runtime contract', () => {
  it('accepts Docker image references and rejects argument-shaped values', () => {
    expect(resolveHermesImage('nousresearch/hermes-agent:v2026.6.5')).toBe(
      'nousresearch/hermes-agent:v2026.6.5',
    );
    expect(resolveHermesImage('--privileged')).toBe(DEFAULT_HERMES_IMAGE);
    expect(resolveHermesImage('image name')).toBe(DEFAULT_HERMES_IMAGE);
  });

  it('derives scoped runtime tokens without storing plaintext secrets', () => {
    vi.stubEnv('AUTH_SECRET', 'runtime-test-secret');
    const api = deriveHermesRuntimeToken('runtime-1', 'hermes-api');
    const mcp = deriveHermesRuntimeToken('runtime-1', 'toolplane-mcp');

    expect(api).toMatch(/^tphr_/);
    expect(api).not.toBe(mcp);
    expect(verifyHermesRuntimeToken('runtime-1', 'hermes-api', api)).toBe(true);
    expect(verifyHermesRuntimeToken('runtime-2', 'hermes-api', api)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('issues expiring dashboard capabilities scoped to one runtime', () => {
    vi.stubEnv('AUTH_SECRET', 'runtime-test-secret');
    const now = Date.parse('2026-07-11T12:00:00Z');
    const token = createHermesDashboardAccessToken('runtime-1', now);

    expect(token).toMatch(/^tpdh_/);
    expect(createHermesDashboardPath('runtime-1', now)).toBe(
      `/api/v1/agent-runtimes/runtime-1/dashboard/${encodeURIComponent(token)}/`,
    );
    expect(verifyHermesDashboardAccessToken('runtime-1', token, now)).toBe(true);
    expect(verifyHermesDashboardAccessToken('runtime-2', token, now)).toBe(false);
    expect(verifyHermesDashboardAccessToken('runtime-1', token, now + 9 * 60 * 60 * 1000)).toBe(false);
    expect(verifyHermesDashboardAccessToken('runtime-1', `${token}x`, now)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('binds broker capabilities to the ToolPlane parent origin', () => {
    vi.stubEnv('AUTH_SECRET', 'runtime-test-secret');
    const now = Date.parse('2026-07-11T12:00:00Z');
    const token = createHermesDashboardBrokerAccessToken(
      'runtime-1',
      'http://toolplane.test:3000/path-is-normalized',
      now,
    );

    expect(token).toMatch(/^tpdb_/);
    expect(verifyHermesDashboardBrokerAccessToken('runtime-1', token, now)).toEqual({
      expiresAt: Math.floor(now / 1000) + 8 * 60 * 60,
      parentOrigin: 'http://toolplane.test:3000',
    });
    expect(verifyHermesDashboardBrokerAccessToken('runtime-2', token, now)).toBeNull();
    expect(
      verifyHermesDashboardBrokerAccessToken('runtime-1', token, now + 9 * 60 * 60 * 1000),
    ).toBeNull();
    vi.unstubAllEnvs();
  });

  it('renders managed runtime settings without taking ownership of the system prompt', () => {
    const config = renderHermesConfig({
      maxSteps: 12,
      provider: {
        format: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/',
        apiKey: 'provider-secret',
        model: 'claude-sonnet',
      },
      mcpUrl: 'https://toolplane.test/api/v1/agent-runtimes/runtime-1/mcp',
      mcpToken: 'runtime-token',
    });

    expect(config).toContain('api_mode: anthropic_messages');
    expect(config).toContain('base_url: "https://api.anthropic.com"');
    expect(config).toContain('Authorization: "Bearer runtime-token"');
    expect(config).toContain('hard_stop_enabled: true');
    expect(config).not.toContain('system_prompt');
  });

  it('renders a deterministic Hermes skill bundle', () => {
    const bundle = renderHermesSkillBundle(['pdf', 'github']);
    expect(bundle.indexOf('toolplane-agent/github')).toBeLessThan(
      bundle.indexOf('toolplane-agent/pdf'),
    );
  });

  it('rewrites loopback model endpoints for the Docker runtime', () => {
    const config = renderHermesConfig({
      maxSteps: 8,
      provider: {
        format: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'local',
        model: 'qwen',
      },
      mcpUrl: 'http://host.docker.internal:3000/mcp',
      mcpToken: 'token',
    });
    expect(config).toContain('base_url: "http://host.docker.internal:11434/v1"');
  });

  it('configures Responses providers with the Hermes responses API mode', () => {
    const config = renderHermesConfig({
      maxSteps: 8,
      provider: {
        format: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'provider-secret',
        model: 'gpt-x',
      },
      mcpUrl: 'https://toolplane.test/mcp',
      mcpToken: 'token',
    });

    expect(config).toContain('api_mode: codex_responses');
  });
});
