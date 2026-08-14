import { describe, expect, it } from 'vitest';
import { inspectMcpLog } from '@/lib/observability/mcp-log-entry';

describe('inspectMcpLog', () => {
  it('turns the legacy RPC path into a readable tool call', () => {
    expect(inspectMcpLog({
      path: '/mcp/dep-1/rpc#tools/call:create_ticket',
      statusCode: 200,
      responseBody: JSON.stringify({ result: { content: [{ type: 'text', text: 'Created' }] } }),
    })).toMatchObject({
      operation: 'toolCall',
      rpcMethod: 'tools/call',
      toolName: 'create_ticket',
      outcome: 'success',
      errorSummary: null,
    });
  });

  it('surfaces a JSON-RPC error even when the HTTP transport returned 200', () => {
    expect(inspectMcpLog({
      path: '/mcp/dep-1/rpc#tools/call:private_tool',
      statusCode: 200,
      responseBody: JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Unknown tool: private_tool' },
      }),
    })).toMatchObject({
      operation: 'toolCall',
      toolName: 'private_tool',
      outcome: 'error',
      errorSummary: 'Unknown tool: private_tool',
    });
  });

  it('recognizes MCP tool results marked as errors and health checks without a fragment', () => {
    expect(inspectMcpLog({
      path: '/mcp/dep-1/rpc#tools/call:search',
      statusCode: 200,
      responseBody: JSON.stringify({
        result: { isError: true, content: [{ type: 'text', text: 'Rate limit reached' }] },
      }),
    })).toMatchObject({ outcome: 'error', errorSummary: 'Rate limit reached' });

    expect(inspectMcpLog({
      path: '/mcp/dep-1/health',
      statusCode: 503,
    })).toMatchObject({
      operation: 'healthCheck',
      outcome: 'error',
      errorSummary: 'HTTP 503',
    });
  });
});
