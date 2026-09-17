# Agent Control MCP

> **中文**：[AGENT_CONTROL_MCP.zh-CN.md](./AGENT_CONTROL_MCP.zh-CN.md)

ToolPlane exposes each workspace as an authenticated, stateless Streamable HTTP
MCP server for creating and using agents:

```text
POST /api/v1/workspaces/<workspace-slug>/agents/mcp
Authorization: Bearer <personal-api-token>
```

The console's **Agents → Connect AI** page can generate connection configs for clients such as Claude Code, Codex, and Cursor directly. Create a personal API token in account settings at `/app?view=account`; cookie sessions cannot call this endpoint, and the scoped tokens issued by the Toolkit install flow do not have agent-management permissions.

## Client configuration

```toml
[mcp_servers.toolplane-agent-control]
url = "https://toolplane.example/api/v1/workspaces/acme/agents/mcp"
http_headers = { Authorization = "Bearer <API_TOKEN>" }
```

Any client that supports remote HTTP MCP can use the same URL and Bearer header.
The server is stateless and supports `initialize`, `ping`, `tools/list`, and `tools/call`.
It implements MCP `2025-06-18` and is compatible with Streamable HTTP `2025-03-26`; a single request body is capped at 256 KiB.

## Tools

| Tool | Purpose |
|---|---|
| `list_agent_resources` | Safely lists bindable model provider, MCP, Skill, Toolkit, and Sandbox IDs |
| `inspect_mcp_deployment` | Shows the tools a running MCP exposes to AI, with input schemas |
| `list_agents` | Lists agents with readiness and resource counts; also discovers Sub-agent IDs |
| `get_agent` | Reads one agent's safe config, bindings, runtime state, and console path |
| `create_agent` | Creates and configures an agent with all resource bindings in a single DB transaction |
| `send_message_to_agent` | Invokes an agent and persists the conversation; the returned `conversationId` continues the session |

Recommended order of operations for the AI:

1. Call `list_agent_resources` and `list_agents` to get the IDs available in the current workspace.
2. Call `inspect_mcp_deployment` for each MCP you plan to bind.
3. Call `create_agent`. Pi agents take `providerId`, `model`,
   `systemPrompt`; Hermes agents take `providerIds` and use an image approved by the instance admin.
4. Call `get_agent` to check `configured` / `ready` and the actual bindings.
5. Call `send_message_to_agent`; pass the `conversationId` back to continue the conversation.

The `create_agent.runtime` argument accepts only `"pi"` and `"hermes"`. `"native"` is not a valid value. The console supports additional runtimes (`"claude-code"` and `"dsh"`), but this MCP creation schema does not expose them. See [`control-mcp.ts`](../src/lib/agents/control-mcp.ts) for the tool contract and [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) for the platform runtime inventory.

Model configuration can be omitted, in which case a Draft agent is created that can be finished in the console.
`maxSteps` is the maximum number of tool-call rounds per reply, in the range `1..1000`, default `100`.
`create_agent` is not idempotent; if the client disconnects or times out before the response, call
`list_agents` first to check whether the agent was created before retrying.

## Raw JSON-RPC example

```bash
curl -sS "https://toolplane.example/api/v1/workspaces/acme/agents/mcp" \
  -H "Authorization: Bearer $TOOLPLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/call",
    "params":{
      "name":"create_agent",
      "arguments":{
        "name":"Research assistant",
        "runtime":"pi",
        "providerId":"provider-id-from-list_agent_resources",
        "model":"model-id-from-provider",
        "systemPrompt":"Research carefully and cite the evidence.",
        "deploymentIds":[],
        "installedSkillIds":[],
        "toolkitIds":[]
      }
    }
  }'
```

## Security boundaries

- All queries and writes are re-scoped to the workspace in the URL; a cross-workspace ID fails the whole
  `create_agent` transaction, leaving no half-created agent.
- Provider API keys, MCP environment variables, Hermes env config, Skill files, and Channel
  credentials never appear in MCP responses.
- Agent Control MCP provides no tool to delete agents or create model providers.
- The AI cannot choose the Hermes Docker image; only trusted images configured by the instance admin are used, so
  provider credentials are never projected into arbitrary third-party images through this creation tool.
- Standard gateway events record method, tool name, outcome, and timing. The route also passes the MCP response to the diagnostic logging pipeline: only when a matching resource capture explicitly enables Agent content (`includeAgentContent=true`), sanitized response payloads can be stored in `LogDetail`, including returned agent configuration or model output. Redaction is not anonymization. See [Logging and Audit](./OBSERVABILITY.md); ordinary captures remain metadata-only for this payload; Agent content details expire within at most 24 hours. Public Endpoint payload suppression cannot be overridden.
- `send_message_to_agent` only accepts a `conversationId` that belongs to the target workspace and target agent.
