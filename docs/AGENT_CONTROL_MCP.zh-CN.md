# Agent Control MCP


ToolPlane 把每个工作区暴露为一个带鉴权的无会话 Streamable HTTP MCP 服务器，用于创建和使用智能体：

```text
POST /api/v1/workspaces/<workspace-slug>/agents/mcp
Authorization: Bearer <personal-api-token>
```

在控制台的 **Agents → Connect AI** 可以直接生成 Claude Code、Codex、Cursor
等客户端的连接配置。个人 API Token 在账户设置 `/app?view=account` 中创建；Cookie
会话不能调用此端点，Toolkit 安装流程签发的受限 Token 不具备智能体管理权限。

## 客户端配置

```toml
[mcp_servers.toolplane-agent-control]
url = "https://toolplane.example/api/v1/workspaces/acme/agents/mcp"
http_headers = { Authorization = "Bearer <API_TOKEN>" }
```

任何支持远程 HTTP MCP 的客户端也可以使用同一 URL 和 Bearer Header。
服务是无会话的，支持 `initialize`、`ping`、`tools/list` 和 `tools/call`。
它实现 MCP `2025-06-18`，并兼容 Streamable HTTP `2025-03-26`；单次请求体
上限为 256 KiB。

## 工具

| 工具 | 用途 |
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
3. 调用 `create_agent`。Pi Agent 使用 `providerId`、`model`、
   `systemPrompt`。
4. 调用 `get_agent` 检查 `configured` / `ready` 和实际绑定。
5. 调用 `send_message_to_agent`；继续对话时传回 `conversationId`。

`create_agent.runtime` 只接受 `"pi"`，`"native"` 不是有效值。其他控制台运行时不因此自动获得 MCP 创建支持。工具契约见 [`control-mcp.ts`](../src/lib/agents/control-mcp.ts)，平台运行时清单见 [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts)。

模型配置可以省略，此时会创建可在控制台继续设置的 Draft Agent。
`maxSteps` 表示单次回复的最大工具调用轮次，范围为 `1..1000`，默认值为 `100`。
`create_agent` 是非幂等操作；如果客户端在响应前断线或超时，应先调用
`list_agents` 确认是否已经创建，再决定是否重试。

## 原始 JSON-RPC 示例

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

## 安全边界

- 所有查询和写入都再次限制到 URL 指定的 workspace；跨工作区 ID 会使整个
  `create_agent` 事务失败，不会留下半成品 Agent。
- Provider API Key、MCP 环境变量、Skill 文件和 Channel
  凭据不会出现在 MCP 响应中。
- Agent Control MCP 不提供删除 Agent 或创建模型 Provider 的工具。
- 常规网关事件记录方法、工具名、结果和耗时。路由还会把 MCP 响应交给诊断日志管道：只有匹配资源的诊断采集显式开启 Agent 内容（`includeAgentContent=true`）时，脱敏响应载荷可能存入 `LogDetail`，其中可能包含返回的 Agent 配置或模型输出。脱敏不等于匿名化，参见[日志与审计](./OBSERVABILITY.zh-CN.md)，普通采集不隐式获取 Agent 内容，此类详情最多保留 24 小时；公共 Endpoint 的禁止采集策略不可覆盖。
- `send_message_to_agent` 只接受属于目标 workspace 和目标 Agent 的
  `conversationId`。
