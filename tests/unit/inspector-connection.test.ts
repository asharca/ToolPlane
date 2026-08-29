import { describe, expect, it } from 'vitest';
import {
  readMcpInspectorConnection,
  withMcpInspectorConnection,
} from '@/lib/workspace/inspector-connection';

describe('MCP Inspector connection marker', () => {
  it('round-trips a validated marker without dropping existing deployment config', () => {
    const value = withMcpInspectorConnection(
      { env: { TOKEN: 'kept' } },
      [{ name: 'search', inputSchema: { type: 'object' } }],
      'sandbox-1',
      '2026-08-29T00:00:00.000Z',
    );
    expect(value).toMatchObject({
      env: { TOKEN: 'kept' },
      toolCatalog: [{ name: 'search' }],
    });
    expect(readMcpInspectorConnection(value)).toEqual({
      sandboxId: 'sandbox-1',
      connectedAt: '2026-08-29T00:00:00.000Z',
    });
    expect(readMcpInspectorConnection({ mcpInspector: { sandboxId: 'x', connectedAt: 'bad' } })).toBeNull();
  });
});
