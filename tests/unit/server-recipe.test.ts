// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  missingDeploymentRequiredEnvironment,
  missingRequiredEnvironment,
  parseServerRecipe,
  recipeToDeploymentData,
  storedRequiredEnvironment,
} from '@/lib/workspace/server-recipe';

describe('parseServerRecipe', () => {
  it('parses a valid npm recipe with env keys', () => {
    const r = parseServerRecipe({ source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY'] });
    expect(r).toEqual({ source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY'] });
  });

  it('parses docker recipe with startCommand and network', () => {
    const r = parseServerRecipe({ source: 'docker', ref: 'mcp/slack', startCommand: 'node dist/index.js', network: 'none' });
    expect(r).toEqual({ source: 'docker', ref: 'mcp/slack', env: [], startCommand: 'node dist/index.js', network: 'none' });
  });

  it('drops malformed env keys', () => {
    const r = parseServerRecipe({ source: 'pypi', ref: 'mcp-server-fetch', env: ['OK_KEY', '1bad', 42, 'also-bad'] });
    expect(r?.env).toEqual(['OK_KEY']);
  });

  it('keeps only safe HTTP source URLs', () => {
    expect(parseServerRecipe({
      source: 'npm',
      ref: 'firecrawl-mcp',
      sourceUrl: 'https://github.com/firecrawl/firecrawl-mcp-server',
    })?.sourceUrl).toBe('https://github.com/firecrawl/firecrawl-mcp-server');
    expect(parseServerRecipe({ source: 'npm', ref: 'firecrawl-mcp', sourceUrl: 'javascript:alert(1)' })?.sourceUrl)
      .toBeUndefined();
    expect(parseServerRecipe({ source: 'npm', ref: 'firecrawl-mcp', sourceUrl: 'https://secret@example.com/repo' })?.sourceUrl)
      .toBeUndefined();
  });

  it('returns null for an unknown source', () => {
    expect(parseServerRecipe({ source: 'cargo', ref: 'x' })).toBeNull();
  });

  it('returns null for an invalid ref', () => {
    expect(parseServerRecipe({ source: 'npm', ref: 'Has Spaces!' })).toBeNull();
  });

  it('parses a remote connector without persisting credentials in its URL', () => {
    expect(parseServerRecipe({
      source: 'remote',
      ref: 'https://mcp.example.com/api/mcp',
      transport: 'streamable-http',
      authType: 'headers',
      headerEnv: { 'X-API-Key': 'MCP_API_KEY' },
    })).toEqual({
      source: 'remote',
      ref: 'https://mcp.example.com/api/mcp',
      env: ['MCP_API_KEY'],
      transport: 'streamable-http',
      authType: 'headers',
      headerEnv: { 'X-API-Key': 'MCP_API_KEY' },
    });
    expect(parseServerRecipe({
      source: 'remote',
      ref: 'https://mcp.example.com/api/mcp?token=secret',
    })).toBeNull();
    expect(parseServerRecipe({ source: 'remote', ref: 'http://127.0.0.1:3000/mcp' })).toBeNull();
  });

  it('returns null for empty / non-object input', () => {
    expect(parseServerRecipe(null)).toBeNull();
    expect(parseServerRecipe({})).toBeNull();
    expect(parseServerRecipe('npm')).toBeNull();
  });

  it('parses preset envValues (and drops malformed ones)', () => {
    const r = parseServerRecipe({
      source: 'npm',
      ref: 'firecrawl-mcp',
      env: [],
      envValues: { FIRECRAWL_API_URL: 'http://firecrawl-api:3002', FIRECRAWL_API_KEY: 'self-hosted', '1bad': 'x', OK: 9 },
    });
    expect(r?.envValues).toEqual({ FIRECRAWL_API_URL: 'http://firecrawl-api:3002', FIRECRAWL_API_KEY: 'self-hosted' });
  });
});

describe('recipeToDeploymentData', () => {
  it('seeds declared env keys empty and maps source/ref', () => {
    const d = recipeToDeploymentData({ source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY', 'OTHER'] });
    expect(d.source).toBe('npm');
    expect(d.sourceRef).toBe('firecrawl-mcp');
    expect(d.installCfg.env).toEqual({ FIRECRAWL_API_KEY: '', OTHER: '' });
    expect(d.installCfg.requiredEnv).toEqual(['FIRECRAWL_API_KEY', 'OTHER']);
    expect(d.installCfg.startCommand).toBeUndefined();
  });

  it('carries startCommand and network when present', () => {
    const d = recipeToDeploymentData({ source: 'docker', ref: 'mcp/slack', env: [], startCommand: 'run', network: 'none' });
    expect(d.installCfg).toEqual({ env: {}, startCommand: 'run', network: 'none' });
  });

  it('seeds preset envValues and leaves declared keys empty', () => {
    const d = recipeToDeploymentData({
      source: 'npm',
      ref: 'firecrawl-mcp',
      env: ['EXTRA_KEY'],
      envValues: { FIRECRAWL_API_URL: 'http://firecrawl-api:3002', FIRECRAWL_API_KEY: 'self-hosted' },
    });
    expect(d.installCfg.env).toEqual({
      FIRECRAWL_API_URL: 'http://firecrawl-api:3002',
      FIRECRAWL_API_KEY: 'self-hosted',
      EXTRA_KEY: '',
    });
  });

  it('carries connector transport and auth mapping while seeding the secret variable', () => {
    const d = recipeToDeploymentData({
      source: 'remote',
      ref: 'https://mcp.example.com/mcp',
      env: ['MCP_BEARER_TOKEN'],
      transport: 'streamable-http',
      authType: 'bearer',
      bearerEnv: 'MCP_BEARER_TOKEN',
    });
    expect(d).toEqual({
      source: 'remote',
      sourceRef: 'https://mcp.example.com/mcp',
      installCfg: {
        env: { MCP_BEARER_TOKEN: '' },
        requiredEnv: ['MCP_BEARER_TOKEN'],
        transport: 'streamable-http',
        authType: 'bearer',
        bearerEnv: 'MCP_BEARER_TOKEN',
      },
    });
  });
});

describe('missingRequiredEnvironment', () => {
  const recipe = {
    source: 'npm' as const,
    ref: 'firecrawl-mcp',
    env: ['FIRECRAWL_API_KEY', 'OTHER'],
  };

  it('treats empty and whitespace-only values as missing', () => {
    expect(missingRequiredEnvironment(recipe, {
      env: { FIRECRAWL_API_KEY: '', OTHER: '   ' },
    })).toEqual(['FIRECRAWL_API_KEY', 'OTHER']);
  });

  it('accepts non-empty values for every required key', () => {
    expect(missingRequiredEnvironment(recipe, {
      env: { FIRECRAWL_API_KEY: 'secret', OTHER: 'configured' },
    })).toEqual([]);
  });

  it('carries and enforces required key names after a deployment is detached', () => {
    const installCfg = {
      env: { FIRECRAWL_API_KEY: '' },
      requiredEnv: ['FIRECRAWL_API_KEY', '1bad', 'FIRECRAWL_API_KEY'],
    };
    expect(storedRequiredEnvironment(installCfg)).toEqual(['FIRECRAWL_API_KEY']);
    expect(missingDeploymentRequiredEnvironment(installCfg)).toEqual(['FIRECRAWL_API_KEY']);
  });
});
