// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseServerRecipe, recipeToDeploymentData } from '@/lib/workspace/server-recipe';

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

  it('returns null for an unknown source', () => {
    expect(parseServerRecipe({ source: 'cargo', ref: 'x' })).toBeNull();
  });

  it('returns null for an invalid ref', () => {
    expect(parseServerRecipe({ source: 'npm', ref: 'Has Spaces!' })).toBeNull();
  });

  it('returns null for empty / non-object input', () => {
    expect(parseServerRecipe(null)).toBeNull();
    expect(parseServerRecipe({})).toBeNull();
    expect(parseServerRecipe('npm')).toBeNull();
  });
});

describe('recipeToDeploymentData', () => {
  it('seeds declared env keys empty and maps source/ref', () => {
    const d = recipeToDeploymentData({ source: 'npm', ref: 'firecrawl-mcp', env: ['FIRECRAWL_API_KEY', 'OTHER'] });
    expect(d.source).toBe('npm');
    expect(d.sourceRef).toBe('firecrawl-mcp');
    expect(d.installCfg.env).toEqual({ FIRECRAWL_API_KEY: '', OTHER: '' });
    expect(d.installCfg.startCommand).toBeUndefined();
  });

  it('carries startCommand and network when present', () => {
    const d = recipeToDeploymentData({ source: 'docker', ref: 'mcp/slack', env: [], startCommand: 'run', network: 'none' });
    expect(d.installCfg).toEqual({ env: {}, startCommand: 'run', network: 'none' });
  });
});
