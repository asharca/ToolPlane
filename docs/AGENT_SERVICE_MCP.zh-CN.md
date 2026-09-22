# Agent 服务 MCP：只调用，不管理

> **English**: [AGENT_SERVICE_MCP.md](./AGENT_SERVICE_MCP.md)

这是 Agent 服务化的第一个增量：给已经发布的公共 Endpoint 增加独立的调用型 MCP 入口。它不是 [Agent Control MCP](./AGENT_CONTROL_MCP.zh-CN.md)，也不包含 A2A 或持久异步任务实现。

```text
POST /api/v1/agent-endpoints/<公开 Endpoint ID>/mcp
Authorization: Bearer <Agent API Key 或无 Origin 绑定的 Agent Client Token>
Accept: application/json, text/event-stream
Content-Type: application/json
```

## 准备与权限

先按[公共 API 文档](./AGENT_PUBLIC_API.zh-CN.md)发布可运行的 Endpoint，并创建调用方专属的 API Client 和密钥。URL 使用 `agep_...` 公开标识，不是工作区 Agent 的内部 ID。入口复用现有发布版本、公共运行隔离、会话归属、配额、超时与保留策略；没有新数据库迁移，也没有新增运行时支持。

现有有效 Endpoint 凭据可使用这个传输入口，不需要把个人账户 Token 交给外部 Agent。每个不互信的集成应使用不同 API Client；永久密钥的权限边界是该 Client，不能把模型填写的 `end_user` 当成独立用户认证。需要用户级隔离时，由可信后端签发绑定 subject 的短期 Client Token。

此版只用于服务端到服务端调用，拒绝所有带 `Origin` 的请求，包括 `Origin: null`。不支持浏览器直连、CORS 或 OAuth 自动发现。接入客户端必须支持远程 Streamable HTTP 和预配置 Authorization Header。Cookie、个人 Token、Toolkit Token 和内部运行 Token 都不是此接口的凭据。

| 工具 | 所需作用域 | 作用 |
|---|---|---|
| `invoke_agent` | `responses:create` | 调用当前发布的 Agent；传回 `conversation_id` 可继续自己的对话 |
| `get_agent_response` | `responses:read` | 查询属于当前 Client／已认证 subject 的结果 |
| `cancel_agent_response` | `responses:create` + `responses:read` | 请求取消并返回公开响应状态 |

`tools/list` 根据当前凭据过滤工具；`tools/call` 再次检查作用域。取消工具要求额外读权限，因为它返回响应内容。没有创建 Agent、列出工作区资源、配置模型或获取私人提示词的工具。参数采用严格白名单，不允许传入 `agentId`、其他 Endpoint、系统提示词、模型或工具覆盖。

## 最小调用

配置客户端的远程 MCP URL 和 Authorization Header。客户端负责标准初始化；也可以用以下无会话请求手工检查协议：

```bash
# ENDPOINT_URL 例：https://toolplane.example/api/v1/agent-endpoints/agep_.../mcp
curl "$ENDPOINT_URL" \
  -H "Authorization: Bearer $TOOLPLANE_AGENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-test","version":"1"}}}'

curl "$ENDPOINT_URL" \
  -H "Authorization: Bearer $TOOLPLANE_AGENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl "$ENDPOINT_URL" \
  -H "Authorization: Bearer $TOOLPLANE_AGENT_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"input":"审查这段补丁并说明问题。","end_user":"review-worker","idempotency_key":"review-request-001"}}}'
```

密钥只放在客户端凭据配置中，不放进提示词或工具参数。入口会拒绝把当前 Bearer 凭据原文带入调用参数的请求；这不是对任意敏感业务内容的自动匿名化。

## 结果、重试与取消

结果放在 MCP `result.content` 的文本 JSON 中，沿用公共 Responses API 的 `id`、`conversation_id`、`status`、`output_text`、`usage` 等字段，不返回内部运行 ID 或容器配置。`usage` 是现有字符数统计，不是精确 Token 或金额。

每次新业务动作必须提供新的 `idempotency_key`。网络重试只能复用完全相同的 key 和参数；JSON-RPC `id` 不是业务幂等键。已保存请求会复用现有公开响应，不重新执行模型。幂等依赖记录保留期，不保证记录删除后的无限期去重，也不保证外部工具的副作用恰好发生一次。

返回 `running` 或 `provisioning` 只表示原请求尚未完成；查询自己的 response，不能把 HTTP 200 或 `isError: false` 当成业务完成。调用失败返回 `isError: true` 与稳定的公开错误信息。查询操作成功时，查到的业务结果仍可能是失败状态。

此版调用保持同步并沿用 Responses API 的断连中止语义，不启动脱离请求的后台执行器。客户端超时应与 Endpoint 超时配合。尚未实现断连后持久续跑、SSE 订阅、父 Agent 自动唤醒或 A2A Tasks。取消工具不会撤销已经发生的副作用；取消状态也不表示原生进程已经确认停止。

## 协议与安全边界

实现 MCP `2025-06-18`，兼容 `2025-03-26`，不宣称这是最新协议版本。未知初始化版本协商回服务器支持版本；不支持的 `MCP-Protocol-Version` Header 返回 400。GET、DELETE、OPTIONS 返回 405，无独立 SSE 流、MCP Session 或分页工具列表。

参考：[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[工具契约](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。请求仅接受单个 JSON-RPC 消息；通知不能执行工具。初始化和发现同样经过认证及额度检查，客户端应复用连接配置并避免高频轮询。

入口与执行保持 `suppressPayload`，不为公共调用采集请求／响应正文。外部调用仍只进入公开运行环境，不通过本入口访问私人 Agent 或内部协作允许清单。

## 验证与后续

```bash
pnpm vitest run tests/unit/agent-service-mcp.test.ts tests/integration/agent-service-mcp-auth.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

集成测试需要隔离 PostgreSQL，测试不启动真实模型或沙箱。单元测试包含仓库官方 MCP SDK 的内存传输握手、发现与调用检查。真实 CLI、公开 Hermes 模型和线上部署需要独立端到端验收。

后续独立增量：协作任务持久事件及父任务续轮、统一 Tasks API、A2A 服务端和 Agent Card、远程 Agent 注册，以及更多公开运行时的隔离验收。本补丁不修改旧协作任务状态机或托管 Hermes 卷。
