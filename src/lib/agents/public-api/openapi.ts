export const agentPublicApiOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'ToolPlane Agent API',
    version: '1.1.0',
    description: 'Run published ToolPlane Agent Endpoints without exposing workspace or Hermes runtime credentials. Long-lived keys are server-side only; browsers use origin-bound short-lived client tokens with the endpoint-scoped API. Public Hermes execution requires a single runtime-owning ToolPlane app process/replica.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Responses' },
    { name: 'Conversations' },
    { name: 'Client tokens' },
    { name: 'OpenAI compatibility' },
  ],
  components: {
    securitySchemes: {
      agentApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tp_agent_' },
      agentClientToken: { type: 'http', scheme: 'bearer', bearerFormat: 'tp_client_' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['message', 'type', 'code'],
            properties: {
              message: { type: 'string' },
              type: { type: 'string' },
              code: { type: 'string' },
              request_id: { type: 'string' },
            },
          },
        },
      },
      ResponseError: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      CreateResponseRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['input', 'end_user'],
        properties: {
          input: { type: 'string', minLength: 1, maxLength: 20000 },
          conversation_id: { type: 'string', description: 'A cnv_ id returned by a previous response.' },
          end_user: { type: 'string', minLength: 1, maxLength: 200 },
          stream: { type: 'boolean', default: false },
          metadata: { type: 'object', maxProperties: 16, additionalProperties: true },
        },
      },
      Endpoint: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'object',
          'name',
          'status',
          'revision',
          'isolation_mode',
          'capabilities',
          'limits',
        ],
        properties: {
          id: { type: 'string', examples: ['agep_A1b2c3'] },
          object: { const: 'agent.endpoint' },
          name: { type: 'string' },
          status: { const: 'active' },
          revision: { type: 'integer', minimum: 1 },
          isolation_mode: { enum: ['subject', 'shared'] },
          capabilities: { type: 'object', additionalProperties: { type: 'boolean' } },
          limits: {
            type: 'object',
            additionalProperties: false,
            required: [
              'requests_per_minute',
              'requests_per_day',
              'output_characters_per_day',
              'max_concurrent',
              'max_persistent_runtimes',
              'max_stored_characters',
              'timeout_seconds',
              'max_steps',
              'retention_days',
            ],
            properties: {
              requests_per_minute: { type: 'integer', minimum: 1 },
              requests_per_day: { type: 'integer', minimum: 1 },
              output_characters_per_day: { type: 'integer', minimum: 200000 },
              max_concurrent: { type: 'integer', minimum: 1 },
              max_persistent_runtimes: { type: 'integer', minimum: 1, maximum: 1000 },
              max_stored_characters: { type: 'integer', minimum: 220000 },
              timeout_seconds: { type: 'integer', minimum: 10, maximum: 840 },
              max_steps: { type: 'integer', minimum: 1, maximum: 20 },
              retention_days: { type: 'integer', minimum: 0, maximum: 365 },
            },
          },
        },
      },
      Response: {
        type: 'object',
        required: ['id', 'object', 'endpoint_id', 'status', 'output', 'output_text', 'request_id'],
        properties: {
          id: { type: 'string', examples: ['resp_A1b2c3'] },
          object: { const: 'agent.response' },
          created_at: { type: 'integer' },
          endpoint_id: { type: 'string', examples: ['agep_A1b2c3'] },
          endpoint_revision: { type: 'integer' },
          conversation_id: { type: ['string', 'null'] },
          status: { enum: ['provisioning', 'running', 'completed', 'failed', 'cancelled'] },
          output: { type: 'array', items: { type: 'object' } },
          output_text: { type: 'string' },
          usage: { type: 'object', additionalProperties: true },
          request_id: { type: 'string' },
          error: {
            description: 'Present when the durable response reached a failed or cancelled terminal state.',
            $ref: '#/components/schemas/ResponseError',
          },
        },
      },
      ClientTokenRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['end_user'],
        properties: {
          end_user: { type: 'string', minLength: 1, maxLength: 200 },
          expires_in: { type: 'integer', minimum: 60, maximum: 900, default: 900 },
          origin: { type: 'string', format: 'uri' },
        },
      },
      ClientToken: {
        type: 'object',
        additionalProperties: false,
        required: ['token', 'token_type', 'expires_at', 'expires_in', 'endpoint_id'],
        properties: {
          token: { type: 'string', examples: ['tp_client_...'] },
          token_type: { const: 'Bearer' },
          expires_at: { type: 'string', format: 'date-time' },
          expires_in: { type: 'integer', minimum: 60, maximum: 900 },
          endpoint_id: { type: 'string', examples: ['agep_A1b2c3'] },
        },
      },
      Conversation: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'object',
          'endpoint_id',
          'endpoint_revision',
          'created_at',
          'messages',
          'has_more',
          'next_cursor',
        ],
        properties: {
          id: { type: 'string', examples: ['cnv_A1b2c3'] },
          object: { const: 'agent.conversation' },
          endpoint_id: { type: 'string', examples: ['agep_A1b2c3'] },
          endpoint_revision: { type: 'integer' },
          created_at: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'role', 'content', 'created_at'],
              properties: {
                id: { type: 'string' },
                role: { enum: ['user', 'assistant'] },
                content: { type: 'string' },
                created_at: { type: 'integer' },
              },
            },
          },
          has_more: { type: 'boolean' },
          next_cursor: { type: ['string', 'null'] },
        },
      },
      OpenAIChatCompletionRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'messages', 'user'],
        properties: {
          model: {
            type: 'string',
            description: 'The agep_ Endpoint id bound to the credential.',
          },
          messages: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'content'],
              properties: {
                role: { enum: ['user', 'assistant'] },
                content: { type: 'string', maxLength: 20000 },
              },
            },
          },
          stream: { type: 'boolean', default: false },
          user: { type: 'string', minLength: 1, maxLength: 200 },
          conversation_id: { type: 'string' },
          metadata: { type: 'object', maxProperties: 16, additionalProperties: true },
        },
      },
    },
  },
  security: [{ agentApiKey: [] }],
  paths: {
    '/api/v1/agent-endpoints/{endpointId}': {
      get: {
        tags: ['Responses'],
        summary: 'Read the published Endpoint capabilities and effective limits',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Endpoint metadata, capabilities, and configured limits',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Endpoint' } } },
          },
          401: { description: 'Invalid or out-of-scope credential', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/responses': {
      post: {
        tags: ['Responses'],
        summary: 'Create an Agent response',
        description: 'JSON bodies are limited to 256 KiB and must be read within 30 seconds. Execution is capped at the Endpoint timeout (840 seconds maximum). With an Idempotency-Key, only a completed response is replayed; an active original returns 409 and a failed/cancelled original returns its terminal error.',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 128 } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateResponseRequest' } } },
        },
        responses: {
          200: { description: 'Completed response', content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } }, 'text/event-stream': {} } },
          401: { description: 'Invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Conversation busy, conflicting idempotency payload, active replay, or cancelled terminal replay' },
          429: { description: 'Request, concurrency, daily output, retained storage, or persistent-runtime limit exceeded' },
          502: { description: 'Upstream failure, oversized output, or failed terminal replay' },
          503: { description: 'Runtime unavailable or under maintenance' },
          504: { description: 'Response exceeded its execution deadline' },
        },
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/responses/{responseId}': {
      get: {
        tags: ['Responses'],
        summary: 'Read a response',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'responseId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Response state', content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } } } }, 404: { description: 'Not found' } },
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/responses/{responseId}/cancel': {
      post: {
        tags: ['Responses'],
        summary: 'Cancel a running response',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'responseId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Cancellation requested' }, 404: { description: 'Not found' } },
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/conversations/{conversationId}': {
      get: {
        tags: ['Conversations'],
        summary: 'Read conversation messages',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum messages to return. A transcript character cap can produce a shorter page.',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: 'after',
            in: 'query',
            required: false,
            description: 'Message id from the previous page next_cursor.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'Conversation page. Continue with after=next_cursor while has_more is true.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Conversation' } } },
          },
          400: { description: 'Invalid limit or cursor' },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Conversations'],
        summary: 'Tombstone a conversation and delete its retained transcript',
        description: 'Atomically blocks new turns and deletes database-visible messages. Hermes session cleanup is best-effort, and later empty-runtime/volume garbage collection does not gate the 204 response.',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          204: { description: 'Tombstoned and database-visible transcript deleted' },
          404: { description: 'Not found' },
          409: { description: 'Conversation has an active response' },
        },
      },
    },
    '/api/v1/agent-endpoints/{endpointId}/client-tokens': {
      post: {
        tags: ['Client tokens'],
        summary: 'Mint a short-lived browser token',
        description: 'Server-to-server only. The optional origin must already be in the Endpoint allowlist.',
        security: [{ agentApiKey: [] }],
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientTokenRequest' } } } },
        responses: {
          201: {
            description: 'Short-lived token created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientToken' } } },
          },
          401: { description: 'Invalid server API key' },
        },
      },
    },
    '/api/openai/v1/models': {
      get: {
        tags: ['OpenAI compatibility'],
        summary: 'List the Endpoint model visible to this key',
        description: 'Server-to-server compatibility route. Browser clients use the endpoint-scoped native API.',
        responses: { 200: { description: 'OpenAI-compatible model list' } },
      },
    },
    '/api/openai/v1/chat/completions': {
      post: {
        tags: ['OpenAI compatibility'],
        summary: 'Create an OpenAI-compatible chat completion',
        description: 'Use the credential-bound agep_ Endpoint id as model. system, developer and tool messages, caller-defined tools, and provider/model overrides are rejected. Idempotency replay has the same completed/active/terminal semantics as the native Responses API.',
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 128 } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OpenAIChatCompletionRequest' } },
          },
        },
        responses: {
          200: { description: 'Completion JSON or SSE stream' },
          401: { description: 'Invalid API key' },
          409: { description: 'Conversation/idempotency conflict or active/cancelled replay' },
          429: { description: 'Request or resource limit exceeded' },
          502: { description: 'Upstream failure or failed terminal replay' },
          503: { description: 'Runtime unavailable or under maintenance' },
          504: { description: 'Response exceeded its execution deadline' },
        },
      },
    },
  },
} as const;
