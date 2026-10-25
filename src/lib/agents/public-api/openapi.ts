export const agentPublicApiOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "ToolPlane historical Agent API",
    version: "2.0.0",
    description:
      "Legacy public Agent execution and publication are retired. Retained transcripts and response records remain available through their original scoped read authorization; cancellation drains existing operations only. Create a newly authorized Pi Agent and a new pinned session for execution. Historical data is never repinned or resumed as Pi state.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      agentApiKey: { type: "http", scheme: "bearer" },
      agentClientToken: { type: "http", scheme: "bearer" },
    },
    parameters: {
      endpointId: {
        name: "endpointId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      responseId: {
        name: "responseId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      conversationId: {
        name: "conversationId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    },
    responses: {
      retired: {
        description:
          "Gone. Legacy execution and historical transcript mutation are retired; use a new authorized Pi Agent session rather than attempting to resume old runtime state.",
      },
      unauthorized: {
        description:
          "The original endpoint/client read authorization is absent, expired, revoked, or outside its scope.",
      },
      notFound: {
        description:
          "The record is not visible to this endpoint/client/subject authorization.",
      },
    },
  },
  paths: {
    "/api/v1/agent-endpoints/{endpointId}/responses": {
      post: {
        deprecated: true,
        summary: "Retired legacy execution",
        parameters: [{ $ref: "#/components/parameters/endpointId" }],
        responses: { "410": { $ref: "#/components/responses/retired" } },
      },
    },
    "/api/openai/v1/chat/completions": {
      post: {
        deprecated: true,
        summary: "Retired legacy OpenAI-compatible execution",
        responses: { "410": { $ref: "#/components/responses/retired" } },
      },
    },
    "/api/v1/agent-endpoints/{endpointId}/responses/{responseId}": {
      get: {
        summary: "Read a retained response record",
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { $ref: "#/components/parameters/endpointId" },
          { $ref: "#/components/parameters/responseId" },
        ],
        responses: {
          "200": {
            description:
              "Persisted agent.response including original endpoint revision, output text, status, usage, request ID and error. No runtime is started.",
          },
          "401": { $ref: "#/components/responses/unauthorized" },
          "404": { $ref: "#/components/responses/notFound" },
        },
      },
    },
    "/api/v1/agent-endpoints/{endpointId}/responses/{responseId}/cancel": {
      post: {
        summary:
          "Request cancellation of an existing legacy operation without replay",
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { $ref: "#/components/parameters/endpointId" },
          { $ref: "#/components/parameters/responseId" },
        ],
        responses: {
          "200": {
            description:
              "Persisted response plus cancellation_requested. Cancellation does not erase history or sandbox volumes and does not imply rollback of side effects.",
          },
          "401": { $ref: "#/components/responses/unauthorized" },
          "404": { $ref: "#/components/responses/notFound" },
        },
      },
    },
    "/api/v1/agent-endpoints/{endpointId}/conversations/{conversationId}": {
      get: {
        summary: "Read a retained transcript page",
        security: [{ agentApiKey: [] }, { agentClientToken: [] }],
        parameters: [
          { $ref: "#/components/parameters/endpointId" },
          { $ref: "#/components/parameters/conversationId" },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          { name: "after", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Original endpoint revision and bounded user/assistant messages in sequence order with a continuation cursor. No current Agent configuration or runtime recovery is substituted.",
          },
          "401": { $ref: "#/components/responses/unauthorized" },
          "404": { $ref: "#/components/responses/notFound" },
        },
      },
      delete: {
        deprecated: true,
        summary: "Historical transcripts are read-only",
        parameters: [
          { $ref: "#/components/parameters/endpointId" },
          { $ref: "#/components/parameters/conversationId" },
        ],
        responses: { "410": { $ref: "#/components/responses/retired" } },
      },
    },
  },
} as const;
