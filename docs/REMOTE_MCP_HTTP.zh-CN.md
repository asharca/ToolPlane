# 远程 MCP：HTTP 兼容与传输风险

> **English**: [REMOTE_MCP_HTTP.md](./REMOTE_MCP_HTTP.md)

本文面向将 ToolPlane 连接到远程 MCP 服务的用户与管理员。远程 MCP 支持 `https://`（推荐）、`http://`，以及 1–65535 范围内的显式端口。JSON 配置中的 `"type": "http"` 表示 Streamable HTTP 传输，不代表地址必须使用明文 HTTP；HTTPS 地址仍使用这个 type。

## HTTP 示例

```json
{
  "mcpServers": {
    "internal-mcp": {
      "type": "http",
      "url": "http://mcp.example.com:8000/mcp"
    }
  }
}
```

需要认证时，JSON 导入仍支持通过 `headers.Authorization` 使用 Bearer 认证。但凭据存入 ToolPlane 的受管变量，不代表它在上游 HTTP 网络链路上被加密。

## 用户必须知道的风险

**HTTP 不提供 TLS 加密、服务器身份校验或传输完整性保护。** ToolPlane 与远程 MCP 之间的 Bearer Token、其他认证请求头、工具参数和返回数据可能被窃听或篡改。泄露的凭据可能被盗用；篡改后的工具结果也可能影响 Agent 后续行为。

优先使用 HTTPS。确实需要 HTTP 时，只应在经过评估的可信隔离网络，或覆盖完整连接的加密隧道内使用。内网并非天然安全。避免通过明文 HTTP 发送生产凭据或敏感数据。

**ToolPlane 网页使用 HTTPS，不会保护 ToolPlane → 上游 MCP 的 HTTP 连接。** 浏览器的安全连接标志不能证明这段上游链路安全。

自定义 MCP 部署对话框会针对 HTTP 地址显示本地化风险提示，但不会阻止部署。HTTPS 仍是推荐示例。HTTP bridge 也会在启动时发出不包含端点地址或认证值的警告。

## 安全边界保持不变

支持 HTTP 不等于允许任意目标。私有地址仍需管理员私网目标白名单批准；localhost、回环、链路本地/云元数据和其他受限地址仍被拦截。DNS 解析校验与固定、请求同源限制及禁止重定向保持不变。

端点 URL 不能包含用户名、密码、查询参数或片段。现有查询参数例外仅限 SSE 服务返回的同源会话 POST 地址。

这是一项针对显式配置 HTTP 端点的兼容功能，不会在 HTTPS 失败后自动降级到 HTTP，也不改变 OAuth 的 TLS 要求。
