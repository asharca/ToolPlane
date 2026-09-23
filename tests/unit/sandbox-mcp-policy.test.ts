import { describe, it, expect } from 'vitest';
import { normalizeSandboxMcpTools, sandboxMcpExportable } from '@/lib/sandboxes/mcp-policy';
describe('sandbox MCP grant policy', () => {
  it('defaults to read-only without execution', () => {
    expect(normalizeSandboxMcpTools(undefined)).toEqual(['sandbox_info', 'list_dir', 'read_file', 'download_file']);
  });
  it('deduplicates explicit permissions', () => {
    expect(normalizeSandboxMcpTools(['read_file', 'read_file'])).toEqual(['read_file']);
  });
  it('rejects private runtime methods and empty wildcard grants', () => {
    for (const value of [[], ['*'], ['hermes_dashboard'], ['terminal_session'], ['tools/call'], null]) {
      expect(() => normalizeSandboxMcpTools(value)).toThrow();
    }
  });
  it('treats user and ordinary agent sandboxes identically by backend kind', () => {
    for (const kind of ['docker', 'connector', 'ssh']) expect(sandboxMcpExportable(kind)).toBe(true);
  });
  it('keeps credential-bearing and legacy runtimes blocked', () => {
    for (const kind of ['hermes', 'host', '', 'future-runtime']) expect(sandboxMcpExportable(kind)).toBe(false);
  });
});
