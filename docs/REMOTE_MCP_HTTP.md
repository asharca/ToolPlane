# 远程 MCP：HTTP 支持与风险 / Remote MCP HTTP risks

远程 MCP 支持 `https://`（推荐）和 `http://`，以及 1–65535 范围内的显式端口。JSON 配置中的 `"type": "http"` 表示 Streamable HTTP 传输，不代表地址必须使用明文 HTTP；HTTPS 地址仍使用这个 type。

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

需要认证时，JSON 导入仍支持 `headers.Authorization` 的 Bearer 认证。但凭据存入 ToolPlane 的受管变量，不代表它在 HTTP 网络链路上被加密。

## 必须知道的风险

**HTTP 不提供 TLS 加密、服务器身份校验或传输完整性保护。** ToolPlane 到远程 MCP 的 Bearer Token、其他认证头、工具参数和返回数据可能被窃听或篡改；泄露的凭据可能被盗用。攻击者篡改工具返回内容也可能影响 Agent 后续行为。

优先使用 HTTPS。确实需要 HTTP 时，只应在经过评估的可信隔离网络，或覆盖完整链路的加密隧道内使用。内网并非天然安全，不建议经明文 HTTP 发送生产凭据或敏感数据。

**ToolPlane 网页使用 HTTPS，不会自动保护 ToolPlane → 上游 MCP 的 HTTP 连接。** 页面锁标志不能证明上游链路安全。

自定义 MCP 部署界面会针对 HTTP 地址显示中英文风险提示；HTTPS 示例仍作为默认推荐。HTTP bridge 启动日志也会发出不包含端点地址或认证值的警告。此提示不会禁止用户继续使用 HTTP。

## 安全边界未放开

支持 HTTP 不等于允许任意目标。私有地址仍需管理员私网目标白名单批准；localhost、回环、链路本地/云元数据和其他受限地址仍被拦截。DNS 解析校验与固定、请求同源限制及禁止重定向保持不变。URL 仍不能包含用户名、密码、查询参数或片段；SSE 服务器返回的同源会话 POST 地址保留原有查询参数例外。

这是一项显式配置的 HTTP 兼容功能，不会将失败的 HTTPS 连接自动降级到 HTTP，也没有修改 OAuth 的 TLS 要求。

## English

Remote MCP accepts HTTPS (recommended), HTTP, and explicit ports from 1 to 65535. The JSON `type: "http"` selects Streamable HTTP and also works with HTTPS URLs.

HTTP has no TLS encryption, server authentication, or transport integrity. Authentication headers, tool arguments, and results can be intercepted or modified; stolen credentials can be reused. Managed credential storage does not encrypt the upstream HTTP connection. HTTPS on the ToolPlane website does not protect that connection either.

Prefer HTTPS. Use HTTP only after assessing a trusted isolated network or an encrypted tunnel covering the entire path; an internal network is not automatically safe. Avoid production credentials and sensitive data. The custom-deployment UI displays a localized warning without blocking deployment, and the bridge emits a credential-free startup warning.

Private targets still require administrator allowlisting. Loopback, link-local/metadata, and other restricted destinations remain blocked. DNS validation/pinning, same-origin requests, and redirect rejection are unchanged. No automatic HTTPS-to-HTTP fallback or OAuth TLS relaxation is introduced.
