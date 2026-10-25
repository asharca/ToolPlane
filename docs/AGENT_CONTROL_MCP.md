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
| `list_agent_resources` | Safely lists model provider, MCP recipe, Skill and Sandbox IDs; listing a resource grants no execution authority |
| `inspect_mcp_deployment` | Shows the tools a running MCP exposes to AI, with input schemas |
| `list_agents` | Lists agents with readiness and resource counts; also discovers Sub-agent IDs |
| `get_agent` | Reads one agent's safe config, bindings, runtime state, and console path |
| `create_agent` | Creates a native Pi draft and lazy stopped sandbox records in one DB transaction; it does not publish or start a runtime |
| `send_message_to_agent` | Invokes an agent and persists the conversation; the returned `conversationId` continues the session |

Recommended order of operations for the AI:

1. Call `list_agent_resources` and `list_agents` to get the IDs available in the current workspace.
2. Call `inspect_mcp_deployment` for each MCP you plan to bind.
3. Call `create_agent` with `runtime: "pi-sdk"`, `providerId`, `model` and `systemPrompt`.
4. Review and publish the initial immutable environment and capability scopes in the console. Draft attachments do not authorize all MCP tools; discover and explicitly approve their tool names.
5. Call `get_agent` to check `configured` / `ready` and the published revision. Then call `send_message_to_agent`, passing its `conversationId` back to continue the pinned session.

The `create_agent.runtime` argument accepts only `"pi-sdk"`. Legacy `"pi"`, `"hermes"`, `"claude-code"`, `"dsh"`, `"hermes-rpc"` and the invented `"native"` alias are rejected without creation. Existing non-Pi history remains read-only. See [`control-mcp.ts`](../src/lib/agents/control-mcp.ts) for the tool contract and [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts) for historical metadata.

Model configuration can be omitted. Creation always produces an unpublished draft; execution requires explicit initial revision preparation and publication, not an automatic runtime start.
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
        "runtime":"pi-sdk",
        "providerId":"provider-id-from-list_agent_resources",
        "model":"model-id-from-provider",
        "systemPrompt":"Research carefully and cite the evidence.",
        "deploymentIds":[],
        "installedSkillIds":[]
      }
    }
  }'
```

## Security boundaries

- All queries and writes are re-scoped to the workspace in the URL; a cross-workspace ID fails the whole
  `create_agent` transaction, leaving no half-created agent.
- Provider API keys, MCP environment variables, environment credential values, Skill files and Channel credentials never appear in MCP responses.
- Agent Control MCP provides no tool to delete agents or create model providers.
- Creation does not choose or start a legacy image, project secrets, or stitch a writable session volume. Reviewed immutable environments and per-session lazy allocation define native execution.
- Standard gateway events record method, tool name, outcome, and timing. The route also passes the MCP response to the diagnostic logging pipeline: only when a matching resource capture explicitly enables Agent content (`includeAgentContent=true`), sanitized response payloads can be stored in `LogDetail`, including returned agent configuration or model output. Redaction is not anonymization. See [Logging and Audit](./OBSERVABILITY.md); ordinary captures remain metadata-only for this payload; Agent content details expire within at most 24 hours. Public Endpoint payload suppression cannot be overridden.
- `send_message_to_agent` only accepts a `conversationId` that belongs to the target workspace and target agent.
