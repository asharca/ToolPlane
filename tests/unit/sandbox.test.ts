import { describe, it, expect } from 'vitest';
import { sandboxFlags, envFlags, MCP_NETWORK } from '@/lib/process/sandbox';
import { parseSandboxDirectoryText } from '@/lib/sandboxes/file-list';

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

describe('parseSandboxDirectoryText', () => {
  it('uses the requested path for legacy ls output without a path field', () => {
    const listing = parseSandboxDirectoryText(
      JSON.stringify({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'total 4\n-rw-r--r-- 1 root root 46 Jul 4 14:01 sample.csv\n',
        stderr: '',
      }),
      'data',
    );

    expect(listing).toEqual({
      path: 'data',
      entries: [{ name: 'sample.csv', type: 'file', size: 46 }],
    });
  });
});
