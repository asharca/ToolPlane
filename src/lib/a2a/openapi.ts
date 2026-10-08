import { z } from 'zod';
import { A2ASendSchema, A2AGetSchema, A2ACancelSchema, A2AListSchema } from './validation';

const partFields = A2ASendSchema.shape.message.shape.parts.element.shape;
const documentedSendSchema = A2ASendSchema.extend({
  message: A2ASendSchema.shape.message.extend({
    parts: z.array(z.object({
      text: partFields.text.unwrap(), metadata: partFields.metadata, filename: partFields.filename,
      mediaType: z.enum(['', 'text/plain']).optional(),
    }).strict()).min(1).max(32),
    extensions: z.array(z.string()).max(0).optional(),
  }),
  configuration: A2ASendSchema.shape.configuration.unwrap().omit({ taskPushNotificationConfig: true }).optional(),
});

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const taskId = { id: 'REPLACE_WITH_TASK_ID' };
const message = { messageId: 'REPLACE_WITH_UNIQUE_MESSAGE_ID', role: 'ROLE_USER', parts: [{ text: 'Hello from an A2A client.' }] };
const sendParams = { message, configuration: { returnImmediately: true, historyLength: 0 } };
const methods = [
  ['SendMessage', 'A2ASendParams', sendParams],
  ['SendStreamingMessage', 'A2ASendParams', { message }],
  ['GetTask', 'A2AGetParams', taskId],
  ['ListTasks', 'A2AListParams', { pageSize: 20, historyLength: 0 }],
  ['SubscribeToTask', 'A2ASubscribeParams', taskId],
  ['CancelTask', 'A2ACancelParams', taskId],
] as const;
const id = { type: ['string', 'integer', 'null'] };
const metadata = { type: 'object', additionalProperties: true };
const taskStates = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED'];
const jsonContent = (schema: object) => ({ 'application/json': { schema } });
const pathParameter = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const versionHeader = { name: 'A2A-Version', in: 'header', required: true, schema: { type: 'string', const: '1.0', default: '1.0' } };
const localSecurity = [{ a2aAccountToken: [] }];
const publicSecurity = [{ a2aServiceKey: [] }];
const rpcErrors = Object.fromEntries([
  ['401', 'Missing, invalid, expired or revoked Bearer credential.'],
  ['403', 'Origin header present, insufficient scope, or access denied.'],
  ['404', 'Agent or Endpoint unavailable to this identity.'],
  ['413', 'Request exceeds the configured body limit.'],
  ['415', 'Content-Type must be application/json.'],
  ['429', 'Rate, concurrency or resource quota exceeded. Honor Retry-After.'],
].map(([status, description]) => [status, { description, content: jsonContent(ref('A2ARpcError')) }]));
const rpcOperation = {
  summary: 'Send, query, stream or cancel A2A tasks',
  description: 'A2A 1.0 JSON-RPC; choose a method from the request examples. SendMessage returns result.task; GetTask and CancelTask return the task directly in result. ListTasks returns result.tasks and nextPageToken. SendStreamingMessage and SubscribeToTask return SSE JSON-RPC envelopes containing task, statusUpdate or artifactUpdate. Streams contain task events, not individual model tokens. Disconnecting does not cancel accepted work. Check error even on HTTP 200. Notifications without id return HTTP 202 without executing a task.',
  parameters: [versionHeader],
  requestBody: { required: true, content: { 'application/json': {
    schema: { oneOf: methods.map(([method, params]) => ({
      title: method, type: 'object', additionalProperties: false, required: ['jsonrpc', 'method', 'params'],
      properties: { jsonrpc: { const: '2.0' }, id, method: { const: method }, params: ref(params) },
    })) },
    examples: Object.fromEntries(methods.map(([method, , params]) => [method, { summary: method, value: { jsonrpc: '2.0', id: 1, method, params } }])),
  } } },
  responses: {
    '200': { description: 'JSON-RPC result or error; streaming methods use text/event-stream.', content: {
      ...jsonContent({ oneOf: [ref('A2ARpcResult'), ref('A2ARpcError')] }),
      'text/event-stream': { schema: { type: 'string' }, example: 'data: {"jsonrpc":"2.0","id":1,"result":{"task":{"id":"task-id","contextId":"context-id","status":{"state":"TASK_STATE_WORKING"}}}}\n\n' },
    } },
    '202': { description: 'Notification accepted without executing work. Include id to invoke a method.' },
    ...rpcErrors,
  },
};
const cardResponse = { description: 'Authenticated A2A 1.0 Agent Card. Fetching it does not start a task.', content: jsonContent(ref('A2AAgentCard')) };
const localDescription = 'Enable External A2A & channel access in Agent settings after configuring its model and sandbox. Use an account-level personal Bearer token from Account settings → API tokens, belonging to a user with workspace access. Server-to-server only: every Origin header is rejected, including an empty value. Cookies, Toolkit tokens and published-service keys are not accepted. Never share an account token with third parties. Card and RPC share this URL, using GET and POST respectively.';
const publicDescription = 'Publish an active isolated Hermes Endpoint, enable its A2A access, then create a dedicated client/key in Agent settings → A2A. Requires a service key with a2a:read, a2a:send and/or a2a:cancel scopes for the requested operation; ordinary Responses keys do not grant A2A access. Keep keys server-side. Task access is scoped to the client identity that created the task, not merely knowledge of its ID. Browser Origin requests are rejected.';

export const a2aOpenApi = {
  tags: [
    { name: 'A2A · Console', description: 'Use your existing same-origin login session to try A2A requests in Scalar.' },
    { name: 'A2A · Account', description: localDescription },
    { name: 'A2A · Published service', description: publicDescription },
    { name: 'A2A · MCP', description: 'Streamable HTTP MCP facade for published A2A services using the same dedicated service credential.' },
  ],
  securitySchemes: {
    a2aAccountToken: { type: 'http', scheme: 'bearer', description: 'Personal account API token; server-side only. Not a Toolkit token or service key.' },
    a2aServiceKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tp_agent_', description: 'Dedicated published-service key explicitly granted A2A scopes; server-side only.' },
    consoleSession: { type: 'apiKey', in: 'cookie', name: 'mcp_session', description: 'Browser login cookie; sign in first. Do not paste or copy the cookie.' },
  },
  schemas: {
    A2ASendParams: {
      ...z.toJSONSchema(documentedSendSchema),
      description: 'Only non-empty text/plain input is supported. Each part must contain exactly one text field (no raw, url or data); extensions and push notifications are unsupported. Generate a new messageId for new work; retry only with the identical ID and payload. returnImmediately=true returns a receipt, not completion. To continue INPUT_REQUIRED work, use a new messageId with the returned taskId and contextId. Terminal tasks cannot reopen. Root tool approvals still require an authorized operator; the credential cannot bypass them.',
    },
    A2AGetParams: z.toJSONSchema(A2AGetSchema),
    A2ACancelParams: { ...z.toJSONSchema(A2ACancelSchema), description: 'Requests cancellation; WORKING is not proof of stopping. Poll GetTask for the final state. Completed side effects cannot be undone.' },
    A2AListParams: z.toJSONSchema(A2AListSchema),
    A2ASubscribeParams: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, tenant: { type: 'string', maxLength: 200 } } },
    A2APart: { type: 'object', oneOf: ['text', 'raw', 'url', 'data'].map((field) => ({ required: [field] })), properties: { text: { type: 'string' }, raw: { type: 'string', contentEncoding: 'base64' }, url: { type: 'string' }, data: {}, mediaType: { type: 'string' }, filename: { type: 'string' }, metadata } },
    A2AMessage: { type: 'object', properties: { messageId: { type: 'string' }, taskId: { type: 'string' }, contextId: { type: 'string' }, role: { enum: ['ROLE_USER', 'ROLE_AGENT'] }, parts: { type: 'array', items: ref('A2APart') }, metadata } },
    A2ATask: {
      type: 'object', required: ['id', 'contextId', 'status'],
      description: 'SUBMITTED and WORKING are not terminal. Only COMPLETED means success; FAILED, CANCELED and REJECTED are also terminal. INPUT_REQUIRED and AUTH_REQUIRED are interrupted states. Text output is in artifacts[].parts[].text; other output parts are untrusted data.',
      properties: {
        id: { type: 'string' }, contextId: { type: 'string' },
        status: { type: 'object', properties: { state: { enum: taskStates }, message: ref('A2AMessage'), timestamp: { type: 'string', format: 'date-time' } } },
        artifacts: { type: 'array', items: { type: 'object', properties: { artifactId: { type: 'string' }, name: { type: 'string' }, parts: { type: 'array', items: ref('A2APart') } } } },
        history: { type: 'array', items: ref('A2AMessage') }, metadata,
      },
    },
    A2ARpcResult: { type: 'object', required: ['jsonrpc', 'id', 'result'], properties: { jsonrpc: { const: '2.0' }, id, result: { oneOf: [
      ref('A2ATask'),
      { title: 'SendMessage result', type: 'object', required: ['task'], properties: { task: ref('A2ATask') } },
      { title: 'ListTasks result', type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: ref('A2ATask') }, nextPageToken: { type: 'string' }, pageSize: { type: 'integer' }, totalSize: { type: 'integer' } } },
    ] } } },
    A2ARpcError: { type: 'object', required: ['jsonrpc', 'id', 'error'], properties: { jsonrpc: { const: '2.0' }, id, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} } } } },
    A2AAgentCard: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' },
      supportedInterfaces: { type: 'array', items: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, protocolBinding: { const: 'JSONRPC' }, protocolVersion: { const: '1.0' } } } },
      capabilities: { type: 'object', properties: { streaming: { type: 'boolean' } } },
      defaultInputModes: { type: 'array', items: { type: 'string' } }, defaultOutputModes: { type: 'array', items: { type: 'string' } },
      skills: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
      securitySchemes: metadata, securityRequirements: { type: 'array', items: metadata },
    } },
  },
  paths: {
    '/api/v1/workspaces/{slug}/agents/{agentId}/a2a/local': {
      parameters: [pathParameter('slug'), pathParameter('agentId')],
      get: { tags: ['A2A · Account'], operationId: 'getLocalA2ACard', summary: 'Get account-scoped Agent Card', description: localDescription, security: localSecurity, responses: { '200': cardResponse, default: { description: 'Authentication, authorization or configuration failure.', content: jsonContent({ type: 'object', properties: { error: { type: 'string' } } }) } } },
      post: { ...rpcOperation, tags: ['A2A · Account'], operationId: 'callLocalA2A', security: localSecurity },
      put: { tags: ['A2A · Account'], operationId: 'configureLocalA2A', summary: 'Enable or disable external account-token access', description: 'Requires workspace owner or administrator. Does not control selected internal sub-agent delegation.', security: localSecurity, requestBody: { required: true, content: jsonContent({ type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } }) }, responses: { '200': { description: 'Updated access state.', content: jsonContent({ type: 'object', properties: { enabled: { type: 'boolean' } } }) }, default: { description: 'Authentication, authorization, configuration or validation failure.', content: jsonContent({ type: 'object', properties: { error: { type: 'string' } } }) } } },
    },
    '/api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/rpc': {
      parameters: [pathParameter('slug'), pathParameter('agentId')],
      post: { ...rpcOperation, tags: ['A2A · Console'], operationId: 'callConsoleA2A',
        summary: 'Try A2A with your login session', security: [{ consoleSession: [] }],
        description: `${rpcOperation.description} Same-origin console endpoint: the browser sends your existing login cookie. Sign in first; no Bearer token is accepted. Specify a workspace slug and accessible Agent ID.`,
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/a2a/.well-known/agent-card.json': {
      parameters: [pathParameter('endpointId')],
      get: { tags: ['A2A · Published service'], operationId: 'getPublishedA2ACard', summary: 'Get published Agent Card', description: publicDescription, security: publicSecurity, responses: { '200': cardResponse, ...rpcErrors } },
    },
    '/api/v1/agent-endpoints/{endpointId}/a2a': {
      parameters: [pathParameter('endpointId')],
      post: { ...rpcOperation, tags: ['A2A · Published service'], operationId: 'callPublishedA2A', security: publicSecurity },
    },
    '/api/v1/agent-endpoints/{endpointId}/a2a/mcp': {
      parameters: [pathParameter('endpointId')],
      post: {
        tags: ['A2A · MCP'], operationId: 'callA2AMcp', summary: 'Connect an MCP client to the published service', security: publicSecurity,
        description: 'Use a standard Streamable HTTP MCP client with this URL and Authorization: Bearer <dedicated service key>. Tools: a2a_send_message, a2a_get_task, a2a_list_tasks and a2a_cancel_task. Tool arguments use the corresponding A2A parameter schemas. Send returns immediately; list returns at most 20 summaries without history/artifacts; cancel requests stopping without waiting. No personal account tokens. No browser Origin header. The transport is stateless, with no persistent session or standalone GET event stream.',
        parameters: [{ name: 'Accept', in: 'header', required: true, schema: { type: 'string', default: 'application/json, text/event-stream' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['jsonrpc', 'method'], properties: { jsonrpc: { const: '2.0' }, id, method: { type: 'string' }, params: metadata } }, examples: { initialize: { value: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a2a-client', version: '1.0.0' } } } }, listTools: { value: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } }, sendMessage: { value: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'a2a_send_message', arguments: sendParams } } } } } } },
        responses: { '200': { description: 'MCP JSON-RPC response. Tool results contain JSON-encoded text content; check isError.', content: jsonContent({ type: 'object', properties: { jsonrpc: { const: '2.0' }, id, result: metadata, error: metadata } }) }, '202': { description: 'MCP notification accepted.' }, default: { description: 'MCP transport or authorization error.' } },
      },
    },
  },
} as const;
