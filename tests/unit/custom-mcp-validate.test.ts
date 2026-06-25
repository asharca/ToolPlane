import { describe, it, expect } from 'vitest';
import { parseCustomMcpInput } from '@/lib/workspace/custom-mcp';

const base = { source: 'npm', packageRef: '@scope/server', name: 'My Server', env: [], args: '' };

describe('parseCustomMcpInput', () => {
  it('normalizes a valid npm input', () => {
    const out = parseCustomMcpInput({
      ...base,
      env: [{ key: 'API_KEY', value: 'abc' }],
      args: '--port 3000  --verbose',
    });
    expect(out).toEqual({
      source: 'npm',
      packageRef: '@scope/server',
      name: 'My Server',
      installCfg: { env: { API_KEY: 'abc' }, args: ['--port', '3000', '--verbose'] },
    });
  });

  it('rejects an invalid npm package name', () => {
    expect(() => parseCustomMcpInput({ ...base, packageRef: 'Bad Name!' })).toThrow();
  });

  it('rejects an invalid env var key', () => {
    expect(() => parseCustomMcpInput({ ...base, env: [{ key: '1BAD', value: 'x' }] })).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => parseCustomMcpInput({ ...base, name: '   ' })).toThrow();
  });
});
