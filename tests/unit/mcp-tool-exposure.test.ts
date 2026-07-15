import { describe, expect, it } from 'vitest';
import {
  filterMcpToolsForAi,
  isMcpToolExposedToAi,
  mcpToolPolicyFromStored,
} from '@/lib/workspace/mcp-tool-exposure';

describe('MCP tool exposure policy', () => {
  const tools = [{ name: 'read' }, { name: 'write' }];

  it('allows every current and future tool in all mode', () => {
    const policy = mcpToolPolicyFromStored({
      mcpToolExposure: 'all',
      mcpAllowedTools: [],
    });
    expect(filterMcpToolsForAi(tools, policy)).toEqual(tools);
    expect(isMcpToolExposedToAi(policy, 'future-tool')).toBe(true);
  });

  it('uses exact names in allowlist mode and permits an explicit empty list', () => {
    const selected = { mode: 'allowlist' as const, allowedTools: ['read', 'READ'] };
    expect(filterMcpToolsForAi(tools, selected)).toEqual([{ name: 'read' }]);
    expect(filterMcpToolsForAi(tools, { mode: 'allowlist', allowedTools: [] })).toEqual([]);
  });

  it('fails closed when the workspace-scoped policy row is absent', () => {
    expect(filterMcpToolsForAi(tools, undefined)).toEqual([]);
    expect(isMcpToolExposedToAi(undefined, 'read')).toBe(false);
  });
});
