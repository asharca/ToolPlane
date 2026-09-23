# Invoke native A2A services from an MCP client

> [中文](A2A_MCP_BRIDGE.zh-CN.md)

For external Agent/client integrators. This tool adapter calls the native A2A Handler,
Task store, authorization and executor. It neither runs the compatibility Responses API
nor maintains a second MCP task database.

## Connect

Publish and explicitly enable an A2A Endpoint and create a dedicated client using the
[console guide](A2A_CONSOLE.md). Configure a server-side Streamable HTTP MCP client with
this URL and a securely supplied `Authorization: Bearer <service-key>` header:

```text
POST /api/v1/agent-endpoints/{endpointId}/a2a/mcp
```

Client configuration formats vary; the console connection object is an example, not a
universal configuration file. The pinned official MCP SDK negotiates supported MCP
versions and transports tools. A2A data uses the pinned 1.0 contract. The MCP address is
not advertised as a new A2A protocol binding in the Agent Card.

Scopes must explicitly include `a2a:send`, `a2a:read` or `a2a:cancel`; cancellation also
requires read. Responses scopes or `*` alone do not gain A2A permission. Account tokens,
cookies, runtime credentials and browser Origin requests cannot authenticate this service
entry. OAuth discovery and browser CORS access are not implemented.

| MCP tool | Contract |
|---|---|
| `a2a_send_message` | Standard SendMessageRequest; always returns an accepted `{task}` immediately, not guaranteed completion |
| `a2a_get_task` | Standard GetTaskRequest; returns the caller-owned `{task}` and artifacts |
| `a2a_list_tasks` | Standard ListTasksRequest, capped at 20 summaries per page without history/artifacts |
| `a2a_cancel_task` | Standard CancelTaskRequest; returns the current `{task}`, possibly still WORKING pending executor shutdown |

Discovery is scope-filtered and every call is authorized again. The Endpoint fixes the
target; callers cannot override arbitrary Agents, workspaces, models, prompts or tools.
Operational failures are MCP `isError: true`, never a fabricated successful task result.

## Official MCP client example

Use the repository's pinned SDK. Keep the URL and credential in process/client secret
configuration. The example submits once and reads once; it does not poll indefinitely
or automatically retry writes.

```typescript
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TOOLPLANE_A2A_MCP_URL;
const token = process.env.TOOLPLANE_A2A_TOKEN;
if (!url || !token) throw new Error('Configure the MCP URL and service credential.');
const client = new Client({ name: 'a2a-caller', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
try {
  const rawResult = await client.callTool({ name: 'a2a_send_message', arguments: {
    message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Review the supplied patch.' }] },
    configuration: { returnImmediately: true, historyLength: 0 },
  } });
  const result = CallToolResultSchema.parse(rawResult);
  if (result.isError) throw new Error('Task submission failed. Inspect the safe MCP error.');
  const text = result.content.find((part) => part.type === 'text');
  if (!text || typeof text.text !== 'string') throw new Error('Missing task response.');
  const { task } = JSON.parse(text.text);
  if (!task || typeof task.id !== 'string') throw new Error('Missing task ID.');
  // Persist the task ID in your application. Disconnecting does not cancel it.
  const current = await client.callTool({ name: 'a2a_get_task', arguments: { id: task.id, historyLength: 0 } });
  if (current.isError) throw new Error('Task lookup failed.');
  // Parse current.content and inspect task.status.state before reporting completion.
} finally {
  await client.close();
}
```

Retries preserve the original messageId and business content. New tasks use new IDs.
Only INPUT_REQUIRED tasks accept continuation with the same taskId and a new messageId;
terminal tasks cannot reopen. Closing an MCP connection does not cancel accepted tasks.

For task event streams use A2A SendStreamingMessage/SubscribeToTask. This adapter exposes
ordinary MCP tools, not MCP Tasks or token streaming. The same native permissions,
cancellation, retention and [resource quotas](A2A_RESOURCE_LIMITS.md) apply.
