import { describe, it, expect } from 'vitest';
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';

describe('parseCustomMcpInput', () => {
  it('npm package', () => {
    expect(parseCustomMcpInput({ source: 'npm', ref: '@scope/server', name: 'S' })).toEqual({
      source: 'npm', ref: '@scope/server', name: 'S', installCfg: null,
    });
  });
  it('pypi package', () => {
    expect(parseCustomMcpInput({ source: 'pypi', ref: 'mcp-server-fetch', name: 'F' }).source).toBe('pypi');
  });
  it('github url accepted', () => {
    expect(parseCustomMcpInput({ source: 'github', ref: 'https://github.com/org/repo', name: 'G' }).ref).toBe('https://github.com/org/repo');
  });
  it('docker image + startCommand stored in installCfg', () => {
    expect(parseCustomMcpInput({ source: 'docker', ref: 'mcp/slack', name: 'D', startCommand: 'node a.js' }).installCfg).toEqual({ startCommand: 'node a.js' });
  });
  it('rejects non-github url for github source', () => {
    expect(() => parseCustomMcpInput({ source: 'github', ref: 'https://evil.com/x/y', name: 'G' })).toThrow();
  });
  it('rejects bad npm name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'Bad Name!', name: 'S' })).toThrow();
  });
  it('rejects empty name', () => {
    expect(() => parseCustomMcpInput({ source: 'npm', ref: 'x', name: '  ' })).toThrow();
  });
  it('rejects unknown source', () => {
    expect(() => parseCustomMcpInput({ source: 'brew', ref: 'x', name: 'S' })).toThrow();
  });
});
