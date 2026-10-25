# Agent Control MCP

> **English**: [AGENT_CONTROL_MCP.md](./AGENT_CONTROL_MCP.md)

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
| `list_agent_resources` | 安全列出模型 Provider、MCP recipe、Skill 和 Sandbox ID；列出资源不等于授予执行权限 |
| `inspect_mcp_deployment` | 查看一个运行中 MCP 对 AI 开放的工具及输入 schema |
| `list_agents` | 列出智能体、就绪状态和资源数量，也可发现 Sub-agent ID |
| `get_agent` | 读取单个智能体的安全配置、绑定关系、运行时状态和控制台路径 |
| `create_agent` | 在同一数据库事务创建原生 Pi 草稿和懒启动的停止状态沙箱记录，不发布修订或启动运行时 |
| `send_message_to_agent` | 调用智能体并保存对话；返回的 `conversationId` 可用于继续会话 |

推荐 AI 按以下顺序操作：

1. 调用 `list_agent_resources` 和 `list_agents` 获取当前工作区可用 ID。
2. 对计划绑定的 MCP 调用 `inspect_mcp_deployment`。
3. 调用 `create_agent`，使用 `runtime: "pi-sdk"`、`providerId`、`model` 和 `systemPrompt`。
4. 在控制台审阅并发布初始不可变环境与能力范围。草稿绑定不等于允许全部 MCP 工具，须实际发现并明确批准工具名。
5. 调用 `get_agent` 检查 `configured` / `ready` 和已发布修订，再调用 `send_message_to_agent`；继续固定会话时传回 `conversationId`。

`create_agent.runtime` 只接受 `"pi-sdk"`。旧 `"pi"`、`"hermes"`、`"claude-code"`、`"dsh"`、`"hermes-rpc"` 及不存在的 `"native"` 别名均拒绝且不创建对象。已有非 Pi 历史保持只读。工具契约见 [`control-mcp.ts`](../src/lib/agents/control-mcp.ts)，历史元数据清单见 [`runtime-kind.ts`](../src/lib/agents/runtime-kind.ts)。

模型配置可以省略。创建始终产生未发布草稿；执行须明确准备和发布初始修订，不会自动启动运行时。
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

## 安全边界

- 所有查询和写入都再次限制到 URL 指定的 workspace；跨工作区 ID 会使整个
  `create_agent` 事务失败，不会留下半成品 Agent。
- Provider API Key、MCP 环境变量、环境凭据值、Skill 文件和 Channel 凭据不会出现在 MCP 响应中。
- Agent Control MCP 不提供删除 Agent 或创建模型 Provider 的工具。
- 创建不会选择或启动旧镜像、投影秘密或手动拼接会话工作卷。原生执行使用已审阅不可变环境及每会话懒分配。
- 常规网关事件记录方法、工具名、结果和耗时。路由还会把 MCP 响应交给诊断日志管道：只有匹配资源的诊断采集显式开启 Agent 内容（`includeAgentContent=true`）时，脱敏响应载荷可能存入 `LogDetail`，其中可能包含返回的 Agent 配置或模型输出。脱敏不等于匿名化，参见[日志与审计](./OBSERVABILITY.zh-CN.md)，普通采集不隐式获取 Agent 内容，此类详情最多保留 24 小时；公共 Endpoint 的禁止采集策略不可覆盖。
- `send_message_to_agent` 只接受属于目标 workspace 和目标 Agent 的
  `conversationId`。
