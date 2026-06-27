import { describe, it, expect } from 'vitest';
import { sandboxFlags, envFlags, MCP_NETWORK } from '@/lib/process/sandbox';

describe('sandboxFlags', () => {
  it('isolated: hardening flags + the dedicated sandbox network', () => {
    const f = sandboxFlags('isolated');
    expect(f).toEqual(
      expect.arrayContaining([
        '--rm',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--network',
        MCP_NETWORK,
      ]),
    );
    expect(f).toContain('--memory');
    expect(f).toContain('--pids-limit');
    expect(f).toContain('--cpus');
  });

  it('none: full network isolation', () => {
    expect(sandboxFlags('none')).toContain('none');
    expect(sandboxFlags('none')).not.toContain(MCP_NETWORK);
  });
});

describe('envFlags', () => {
  it('maps to -e KEY=VALUE pairs', () => {
    expect(envFlags({ A: '1', B: '2' })).toEqual(['-e', 'A=1', '-e', 'B=2']);
  });
  it('empty for no env', () => {
    expect(envFlags({})).toEqual([]);
  });
});
