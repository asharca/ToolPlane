# Agent 公共 API

> **English**: [AGENT_PUBLIC_API.md](./AGENT_PUBLIC_API.md)

ToolPlane 通过自己的 HTTPS 网关暴露已发布的 Agent Endpoint。它绝不公开 Hermes 容器
API、dashboard 端口、runtime token、模型 provider 密钥、工作区会话或 MCP runtime
token。

## 必需的部署拓扑

公共 Hermes 执行目前只支持恰好一个拥有 runtime 的 ToolPlane 应用进程或副本。
Hermes/Docker supervisor、runtime 写租约、执行队列和 MCP 子进程表都是进程本地的。
Postgres 协调准入、用量、幂等和取消状态，但这并不意味着 runtime 执行可以安全地
active-active 运行。把所有 Agent API 执行和生命周期工作路由到这一个 owner；不要在多个
ToolPlane 应用副本间运行此功能。Active-active 运行需要外部 runtime owner/supervisor
和分布式执行队列，本版本不包含。

## 发布之前

Endpoint 是 Hermes Agent 的版本化公开部署。发布会创建干净的托管 runtime 分配，而不
是复用 Agent 的控制台卷。控制台会话、记忆、附件、环境变量、本地插件、cron 任务和文
件都不会被复制。

发布者需显式选择 Endpoint 使用的 Skills 和 MCP deployments。每个选中的 MCP
Deployment 必须显式标记 `publicInvocable`，使用 ToolPlane 的 `allowlist` 暴露模式，
且工具白名单非空。Endpoint 修订会快照该白名单。每次 `tools/list` 和 `tools/call`
时，runtime MCP 网关会把快照与 Deployment 当前的 `publicInvocable` 标志和当前暴露
策略取交集，因此撤销公开批准立即生效，无需重新发布。

公共 MCP deployments 是工作区级服务，不是按主体的沙箱，ToolPlane 也不会自动把
`end_user` 注入工具参数。只应发布无状态的工具，或每次操作都独立鉴权并强制租户范围
的工具。不要暴露凭据可跨 API 客户端或终端用户主体读写数据的共享工具。

公共 runtime 不会获得子 Agent、任意沙箱、ToolPlane 用户 token、终端和 dashboard 能
力。ToolPlane 还会在托管公共配置中禁用 Hermes 的终端、文件、代码执行、web/浏览器、
记忆、委派、cron、消息等内建工具集。只有已发布的 `mcp-toolplane` 接口面被启用。

公共修订只接受运行中的 ToolPlane 版本审核过的 Hermes release tag。发布时，
ToolPlane 拉取审核过的 tag，解析其 registry digest，并把不可变的
`repository@sha256:...` 值持久化到修订中；公共 runtime 执行该固定 digest。运维者可
以用 `TOOLPLANE_PUBLIC_HERMES_IMAGES` 额外允许精确的 digest。`latest`、未解析的
tag 和任意自定义 tag 都会被拒绝。

隔离模式：

- `subject`（推荐）：每个 API 客户端 + HMAC 命名空间的 `end_user` 获得独立的隐藏
  Hermes Agent、容器和卷。会话记录由服务器持有，不同 API 客户端和主体之间不
  能共享文件或 runtime 状态。
- `shared`：一个干净的公共 runtime 由所有调用方共享。仅在单一信任域内、有意共享记
  忆且不会提交用户私有内容时使用。

## 认证

长效密钥以 `tp_agent_` 开头，scoped 到一个 Endpoint 客户端，只显示一次。ToolPlane
只存储 SHA-256 哈希。密钥可过期或吊销，不影响 Endpoint。它们是服务器凭据，绝不能
嵌入浏览器 JavaScript 或移动应用。

带 `client_tokens:create` 权限的服务器密钥可以签发有效期最长 15 分钟的
`tp_client_` token。token 绑定 Endpoint、API 客户端、终端用户的 HMAC、scopes，
以及（浏览器使用时）一个精确的允许源。ToolPlane 拒绝带 `Origin` 的请求使用长效密
钥；Endpoint 的 CORS 配置并不能让长效密钥在浏览器中安全。

```bash
curl https://toolplane.example.com/api/v1/agent-endpoints/agep_xxx/client-tokens \
  -H 'Authorization: Bearer tp_agent_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"end_user":"customer-42","origin":"https://app.example.com","expires_in":900}'
```

成功签发返回 `201 Created`。短期 token 以明文返回，它不能替代对长效服务器密钥的
保密。

## 原生 Responses API

```bash
curl -N https://toolplane.example.com/api/v1/agent-endpoints/agep_xxx/responses \
  -H 'Authorization: Bearer tp_agent_xxx' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: request-123' \
  -d '{
    "input": "Summarize the deployment status.",
    "end_user": "customer-42",
    "stream": true
  }'
```

首个响应返回一个 `cnv_...` 会话 ID。后续轮次带上它。会话 ID 绑定 Endpoint、API
客户端和终端用户主体；有效密钥无法读取其他客户端或主体的会话。

流式使用版本化的 SSE 事件：

- `response.created`
- `response.output_text.delta`
- `response.completed`
- `response.failed`
- `data: [DONE]`

`Idempotency-Key` 可选，但只要 Agent 可能调用有副作用的工具就强烈建议。用同一请
求复用 key 只会重放已完成的响应（JSON 或 SSE，匹配新请求的 `stream` 选择）。如果
原响应仍在 provisioning/running，重放返回 `409 idempotency_conflict`；如果它以失
败或取消结束，则返回对应的终态错误，而不会再次运行工具。用不同的输入复用 key 也
返回 `409 idempotency_conflict`。只有有意重试且允许重复副作用时才使用新 key。

其他原生操作：

- `GET /api/v1/agent-endpoints/{endpoint_id}` — 能力与生效限制。
- `GET /api/v1/agent-endpoints/{endpoint_id}/responses/{response_id}` — 流断开后对账。
- `POST /api/v1/agent-endpoints/{endpoint_id}/responses/{response_id}/cancel` — 持久地
  请求取消。
- `GET /api/v1/agent-endpoints/{endpoint_id}/conversations/{conversation_id}` — 保留的
  文本记录。`limit` 默认 20，接受 1–100；把上次的 `next_cursor` 作为 `after` 传入。响
  应包含 `has_more` 和 `next_cursor`（字符上限可能使一页短于 `limit`）。
- `DELETE /api/v1/agent-endpoints/{endpoint_id}/conversations/{conversation_id}` — 原子
  地给会话打墓碑标记，阻止新轮次并立即移除其数据库可见消息。Hermes 会话清理是独立的
  best-effort 阶段，由维护任务重试；空 runtime/卷的垃圾回收随后进行。`204` 不依赖
  runtime 可达。

## OpenAI SDK 兼容

把 `https://toolplane.example.com/api/openai/v1` 作为 SDK base URL，把 `agep_...`
Endpoint ID 作为 model。适配器接受 user 和 assistant 文本消息。它拒绝
system/developer/tool 消息、调用方自定义工具和 provider/model 覆盖；这些能力归已
发布的 Endpoint 修订所有。此兼容路由是 server-to-server 的：因为 Endpoint id 在
JSON 的 `model` 字段而非 URL 中，未认证的浏览器预检无法对照 Endpoint 的源白名单
检查。浏览器客户端应使用原生的 endpoint-scoped Responses API。

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.TOOLPLANE_AGENT_API_KEY,
  baseURL: 'https://toolplane.example.com/api/openai/v1',
});

const result = await client.chat.completions.create({
  model: 'agep_xxx',
  user: 'customer-42',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## 限制与错误

Endpoint 和客户端有数据库支撑的每分钟和每日请求限制。准入还强制 Endpoint/客户端每
日输出字符预算、保留记录字符预算、Endpoint 持久 runtime 限制、配置的并发度，以及
每个会话/runtime 一个活跃轮次。工作区硬上限为每 UTC 日 500,000,000 输出字符和
1,000,000,000 保留记录字符。活跃运行在执行前预占其最大可能的 200,000 字符输出和
220,000 字符记录增长，因此准入是失败关闭的，不会超订预算。

公共 JSON 请求限制 256 KiB，且必须在 30 秒内读取完。一次响应最多接受 20,000 输入
字符，最多输出 200,000 字符。Endpoint 执行超时 10–840 秒，840 秒为硬上限。公共附
件和远程 URL 入站被禁用。

认证失败还按 HMAC 混淆后的客户端地址限流。运行准入、幂等、预算和会话串行化使用
Postgres 行锁/唯一约束，并对序列化冲突重试。这些持久控制防止并发请求绕过限制，但
不改变上述单 runtime owner 拓扑。断连、超时、Endpoint 停用和显式取消会中止 Hermes
fetch 并释放 runtime 租约；runtime owner 也会轮询持久取消标记。

按地址的认证限流仅在 `AGENT_API_TRUST_PROXY_HEADERS=true` 时使用代理地址头。仅在
会覆写这些头的可信反向代理之后启用；无论是否启用，全局的认证前限流始终生效。

错误使用稳定的 JSON envelope，code 如 `invalid_api_key`、`conversation_busy`、
`idempotency_conflict`、`rate_limit_exceeded`、`runtime_maintenance`、`upstream_error`。
内部 Hermes/provider 响应文本、端口、路径和密钥绝不返回。限流响应包含
`Retry-After` 和 `RateLimit-*` 头。

OpenAPI 3.1 文档位于 `/api/v1/openapi.json`。

## 保留与生命周期

ToolPlane 运行有界的启动/每小时清理。它删除过期的 Hermes 会话和数据库记录，在
Endpoint 保留窗口后移除终态响应记录，修剪用量计数器，并销毁空的隐藏容器/卷。另一
个每分钟运行的清理会停止空闲 15 分钟的公共 runtime 容器，同时保留其卷以便惰性恢
复。删除源 Agent 会先停用其 Endpoint、取消活跃的公共运行、销毁每一个隐藏的公共
runtime，然后才移除源。如果清理无法完成，删除会以失败关闭的方式中止，而不是留下一个可
调用的孤儿 runtime。
