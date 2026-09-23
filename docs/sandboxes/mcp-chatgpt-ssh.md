# 沙箱 MCP、ChatGPT OAuth 与 SSH

## 支持范围

Docker、用户 Connector、新建 SSH 沙箱复用同一 Streamable HTTP 入口；普通 Agent 绑定不改变授权单位。授权单位始终是一个 Sandbox，而不是整个账户。

Hermes 私有运行卷包含原生配置与凭据，本入口**不导出 Hermes / legacy host**。不要为满足“所有沙箱”而代理 Hermes Dashboard、PTY 或私有 API。SSH 与 Connector 是远端账号权限，不是容器隔离；文件工具根目录不限制 shell 能访问的内容。

## ChatGPT 连接

1. 先迁移数据库、部署此版本，配置 `TOOLPLANE_PUBLIC_URL=https://你的域名`（或使用已有 `NEXT_PUBLIC_APP_URL`）。源站必须没有路径、查询、片段；生产必须 HTTPS，HTTP 仅允许 loopback 开发。
2. 启动沙箱；详情页 → 设置 → **MCP 导出**，复制 `https://你的域名/api/v1/sandboxes/{sandboxId}/mcp`。
3. 在 ChatGPT 开发者模式创建自定义 MCP，填写上述 URL，认证选择 **OAuth**。客户端 ID/Secret 留空，由 DCR 自动注册；不填写个人 API Key，也不要选择 No Auth。
4. 跳转 ToolPlane 登录并确认具体沙箱。读取、续期默认勾选，写入与执行必须明确勾选。ChatGPT 的写操作确认与 ToolPlane OAuth 授权是不同层面的控制。
5. 返回 ChatGPT，尝试“调用 sandbox_info”，再在明确授权后测试写入及执行。更改已授予的工具集合后刷新 ChatGPT 的工具定义/重新连接。

ChatGPT 需要能访问公网 HTTPS 地址、OAuth 元数据及授权端点。反向代理不能重写成 HTML 登录页、拦截 `Authorization`/`WWW-Authenticate`、要求浏览器专用 Cookie 或对这些端点加验证码。内部 MCP 调用等待上限 180 秒，代理超时建议至少 210 秒；长命令仍可能超过客户端自身预算。HTTP 断线不代表命令未执行，不要自动重试写操作。

官方依据（核对日期：2026-09-23）：
- https://developers.openai.com/api/docs/guides/developer-mode — Streamable HTTP、OAuth、自定义工具、不要求 search/fetch。
- https://developers.openai.com/plugins/build/auth — 资源发现、PKCE S256、DCR、issuer 回传、resource audience 与续期。

**验收边界：** 自动化覆盖真正 MCP SDK 的传输和 OAuth 客户端以及 PostgreSQL 授权状态；这不等于替用户在公网部署后完成了 ChatGPT 浏览器连接。发布前仍必须按上述步骤实际连接。没有声称获得 OpenAI 认证或应用商店审核。

## OAuth 行为

- 401 响应提供 `WWW-Authenticate: Bearer resource_metadata="..."`，PRM 位于 `/.well-known/oauth-protected-resource/api/v1/sandboxes/{sandboxId}/mcp`。
- AS 元数据：`/.well-known/oauth-authorization-server`；同一个 canonical issuer。
- `/api/v1/sandbox-oauth/register|authorize|token|revoke`。
- DCR 支持 public `none`、`client_secret_post`、`client_secret_basic`。支持注册后保存的固定客户端凭据，不宣称支持 CIMD/private_key_jwt。
- 必须 authorization_code + PKCE S256；redirect URI 精确匹配。成功和已验证 callback 的错误回调均包含 `iss`。声明 RFC 9207 后，ChatGPT 可使用 `https://chatgpt.com/connector_platform_oauth_redirect`；始终接受客户端实际注册的精确 URI，不靠域名通配。
- `resource` 在授权、换取令牌和续期时绑定同一个沙箱 URL；跨沙箱、过期、撤销、已离开工作区或停用用户均不接受。
- access token 1 小时；`offline_access` 才提供 refresh token；授权最长 30 天，续期不延长绝对有效期。轮换立即使旧 access token 失效。旧 refresh token 重用会撤销整份授权，客户端应串行续期，失败后重新连接。
- 服务端只存 opaque token/code/client secret 的哈希。授权确认页的 JWT 仅用于短期 CSRF 绑定，不能访问 MCP。
- 读取工具有 `readOnlyHint=true`；写入/执行显式标为有副作用。工具列表和调用均取固定沙箱工具、授权 scope、Deployment 工具策略三者交集。
- 授权列表在沙箱设置可查看/撤销。撤销阻止后续调用，不回滚已执行操作，也不承诺强制终止已受理的远端进程。
- GET/DELETE MCP 返回已鉴权的 405；采用无状态 JSON 响应，没有长期 SSE 会话、传输会话 ID 或断线后自动重放。
- 生产还应在可信反向代理对公共 DCR/OAuth 限流。内置每进程限额和注册总量上限不替代多副本/边缘抗滥用保护。不要把请求/响应体、Authorization、授权确认表单记录到代理日志。

## SSH 配置与创建

控制面需要 Linux、`/usr/bin/ssh`；Dockerfile 已安装 openssh-client。目标需要 POSIX/Linux、`/usr/bin/python3` 和已存在的工作目录。Node/Bash 工具还需远端安装对应解释器。不支持密码、加密私钥、跳板机、Windows SSH 或 SSH 快照/克隆。

管理员参考 `ssh-targets.example.json`，设置：

```text
TOOLPLANE_SSH_TARGETS_FILE=/run/toolplane-ssh/targets.json
```

目标和 credential 文件应通过只读挂载供控制面读取。私钥 0600，known_hosts 不允许组或其他用户写入。通过可信渠道验证主机指纹，再写入 known_hosts；不要不加验证地信任 ssh-keyscan 输出。密钥绝不放进 Git、数据库、Agent 沙箱或浏览器。

目标按 `workspaceIds` 分配；普通用户/Agent 不能覆盖 host、username、key 或 known_hosts。沙箱页面 **创建 SSH 沙箱** 只列当前工作区的目标名称/id，并要求确认远端权限风险。旧 SSH 记录没有 `sshTargetId` 的继续禁用，不能悄悄信任旧主机配置。

使用专用、最小权限远端账号。停止、删除沙箱仅关闭控制面连接和移除记录，不关机、不删除远端工作目录。SSH 使用远端主机网络，不意味着数据库中的通用 network 字段给远端加了容器防火墙。目标配置变更后停止并重启相关沙箱；同一远端目录重复分配不会自动产生隔离。

## 其他 Agent 的手动令牌

仍支持单沙箱 `mcpsbx_` Bearer key，账户级凭据仅用于管理，不要交给外部 Agent。

```bash
export TOOLPLANE_URL=https://你的域名
# TOOLPLANE_API_TOKEN 通过安全的环境配置提供，避免保存在 shell 历史。
node scripts/sandbox-manage-sandbox.mjs targets WORKSPACE_ID
node scripts/sandbox-manage-sandbox.mjs create-ssh WORKSPACE_ID linux-worker "Linux worker" --acknowledge-host-access
umask 077
node scripts/sandbox-manage-sandbox.mjs issue-token SANDBOX_ID "Reader" > sandbox-credential.json
# 需要执行时明确传入 --write --execute；默认只读。
node scripts/sandbox-manage-sandbox.mjs tokens SANDBOX_ID
node scripts/sandbox-manage-sandbox.mjs revoke SANDBOX_ID TOKEN_ID
```

手动 key 1–90 天，有效期默认 7 天；只展示一次明文。管理 API 同时支持同源浏览器 session，写操作严格校验 Origin。显式无效 Bearer 不会降级到 Cookie。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm db:generate
# 核对 DATABASE_URL 是你的测试/目标库；执行迁移会修改数据库。
pnpm exec prisma migrate deploy
pnpm vitest run tests/unit/sandbox-mcp-policy.test.ts tests/unit/sandbox-mcp-access.test.ts tests/unit/sandbox-oauth-policy.test.ts tests/integration/sandbox-mcp-oauth.test.ts
python3 -m unittest discover -s tests/sandbox-ssh -p 'test_ssh_worker.py' -v
node --test tests/sandbox-ssh/ssh-adapter.test.mjs
pnpm lint
pnpm test
pnpm build
pnpm runtime:assemble
```

Linux CI 另启动一次性 loopback sshd，验证真实 SSH host-key 验证、命令、UTF-8/二进制文件和超时。所有密钥/账户仅属于该临时 runner，不连接生产主机。现有 Connector Linux/macOS/Windows 检查保持不变。
