# Agent Control MCP

ToolPlane exposes each workspace as an authenticated, stateless Streamable HTTP
MCP server for creating and using agents:

```text
POST /api/v1/workspaces/<workspace-slug>/agents/mcp
Authorization: Bearer <personal-api-token>
```

在控制台的 **Agents → Connect AI** 可以直接生成 Claude Code、Codex、Cursor
等客户端的连接配置。Token 需要在 **Settings → API Tokens** 创建；Cookie
会话不能调用此端点，Toolkit
安装流程签发的受限 Token 不具备智能体管理权限。

## Client configuration

```toml
[mcp_servers.toolplane-agent-control]
url = "https://toolplane.example/api/v1/workspaces/acme/agents/mcp"
http_headers = { Authorization = "Bearer <API_TOKEN>" }
```

任何支持远程 HTTP MCP 的客户端也可以使用同一 URL 和 Bearer Header。
服务是无会话的，支持 `initialize`、`ping`、`tools/list` 和 `tools/call`。
它实现 MCP `2025-06-18`，并兼容 Streamable HTTP `2025-03-26`；单次请求体
上限为 256 KiB。

## Tools

| Tool | Purpose |
|---|---|
| `list_agent_resources` | 安全列出可绑定的模型提供商、MCP、Skill、Toolkit 和 Sandbox ID |
| `inspect_mcp_deployment` | 查看一个运行中 MCP 对 AI 开放的工具及输入 schema |
| `list_agents` | 列出智能体、就绪状态和资源数量，也可发现 Sub-agent ID |
| `get_agent` | 读取单个智能体的安全配置、绑定关系、运行时状态和控制台路径 |
| `create_agent` | 在单个数据库事务内创建并配置智能体及全部资源绑定 |
| `send_message_to_agent` | 调用智能体并保存对话；返回的 `conversationId` 可用于继续会话 |

推荐 AI 按以下顺序操作：

1. 调用 `list_agent_resources` 和 `list_agents` 获取当前工作区可用 ID。
2. 对计划绑定的 MCP 调用 `inspect_mcp_deployment`。
3. 调用 `create_agent`。Native Agent 使用 `providerId`、`model`、
   `systemPrompt`；Hermes Agent 使用 `providerIds` 和实例管理员批准的镜像。
4. 调用 `get_agent` 检查 `configured` / `ready` 和实际绑定。
5. 调用 `send_message_to_agent`；继续对话时传回 `conversationId`。

模型配置可以省略，此时会创建可在控制台继续设置的 Draft Agent。
`maxSteps` 范围为 `0..1000`，其中 `0` 表示使用运行时安全上限。
`create_agent` 是非幂等操作；如果客户端在响应前断线或超时，应先调用
`list_agents` 确认是否已经创建，再决定是否重试。

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
        "runtime":"native",
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

- 所有查询和写入都再次限制到 URL 指定的 workspace；跨工作区 ID 会使整个
  `create_agent` 事务失败，不会留下半成品 Agent。
- Provider API Key、MCP 环境变量、Hermes 环境配置、Skill 文件和 Channel
  凭据不会出现在 MCP 响应中。
- Agent Control MCP 不提供删除 Agent 或创建模型 Provider 的工具。
- AI 不能指定 Hermes Docker 镜像；只使用实例管理员配置的可信镜像，避免
  Provider 凭据被投影到任意第三方镜像。
- 审计日志只记录 MCP 方法和工具名，不记录 system prompt、聊天内容或模型输出。
- `send_message_to_agent` 只接受属于目标 workspace 和目标 Agent 的
  `conversationId`。
