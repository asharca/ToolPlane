# 在控制台接入 A2A

> [English](A2A_CONSOLE.md)

面向工作区使用者。打开 **Agent 设置 → A2A 接入**，也可进入
`/app/{workspace}/agents/{agentId}?settings=a2a`。
页面使用原生 A2A 1.0 核心，不需要在浏览器粘贴账户 Token。

## 内部协作

先配置 Pi、Claude Code、DSH 或 Hermes RPC 的模型与独占联网 Docker 沙箱。
工作区所有者或管理员点击“启用内部 A2A”，确认开放范围；普通成员只能查看信息、
调用已启用的 Agent。在“配置允许委派的 Agent”中选择目标，并分别启用这些目标。
不会自动启用整个工作区。托管 Hermes 不支持该内部执行模式。

独立 Context 不是独立文件系统：任务可使用目标沙箱中的文件、记忆和已配置工具。
关闭内部 A2A 后，已有执行及后代会在原生任务核心重新校验授权时停止；
已经发生的外部副作用不会回滚。

“本地任务调试”使用当前登录成员的身份向同一 A2A Handler 发起请求：
提交新任务、查看自己最近 20 个任务、按 Task ID 查询、为 INPUT_REQUIRED 任务补充信息，
以及请求取消。列表是有界预览，不是工作区所有人的任务列表；列表结果不附交付物，
选中后点击“查询任务”获取当前状态和文本结果。其他成员、工作区和委派专属任务的 ID
不能凭空获得访问权限。

提交会消耗模型与工具资源，不会在打开页面时自动执行。显示“已接受”不代表“已完成”；
页面当前使用手动查询，不是自动流式聊天。离开页面不会取消任务。取消请求可能先返回
WORKING，实际停止后才进入终态。已终结任务不能原地重开。

## 对外服务和凭据

先在托管 Hermes 的 **API 发布配置** 中发布有效的隔离 Endpoint，再启用“对外 A2A”。
内部启用与公开发布是两个独立授权，公开调用不会获得私人 Agent 的权限。

在“外部客户端凭据”输入集成名称，创建专用客户端与密钥。客户端、密钥哈希和审计在同一
事务中保存，权限固定为 `a2a:send`、`a2a:read`、`a2a:cancel`，不会提升旧 Responses 客户端。
页面只显示专用 A2A 客户端，普通成员看不到密钥管理数据。

明文密钥只在创建成功时返回一次，只保留在当前页面内存；三分钟后、离开页签或点击隐藏
会清除。不写入 localStorage/sessionStorage，不自动插入示例或公开日志。
新增替换密钥不会自动撤销旧密钥：先更新调用方，再明确撤销旧密钥。
即使服务已关闭，管理员仍可撤销密钥。

创建客户端或密钥不是幂等操作。网络断开或响应丢失时先刷新列表确认，不自动重试。
列表刷新失败不会隐藏已经成功返回的密钥。每个 Endpoint 的此入口限制 100 个客户端，
每客户端最多 50 条密钥记录；历史撤销记录也计入该上限。

## 复制连接信息

页面分别展示本地和对外的 RPC / Agent Card 地址，以及获取 Card、SendMessage、GetTask、
SubscribeToTask、CancelTask 的 curl 示例。地址来自部署配置 `NEXT_PUBLIC_APP_URL`，
不从不可信 Host / X-Forwarded-Host 生成。生产地址需要 HTTPS，回环地址允许 HTTP。

示例只引用环境变量，不填充真实密钥。服务端本地集成使用 `TOOLPLANE_ACCOUNT_TOKEN`，
对外集成使用 `TOOLPLANE_A2A_TOKEN`。两种 Token 不能混用；Card 也需要鉴权。
每个新任务替换 messageId；只在重试同一请求时复用完全相同的 ID 和内容。查询时替换 Task ID。

## 浏览器和协议的边界

控制台通过独立同源 BFF 读取配置、管理凭据和调用本地任务：

```text
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/rpc
```

这是 ToolPlane 的控制台接口，不是新定义的 A2A 标准传输。浏览器写入必须具备有效登录态和
与部署配置一致的 Origin；显式 Authorization、跨站请求、伪造工作区/用户/权限被拒绝。
管理操作在事务中重新检查当前管理员资格。

公开 A2A 和服务端本地协议入口保持原有 Bearer 验证，不因此接受 Cookie 或浏览器跨域请求。
控制台不伪造账户 Token，也不绕回旧 Responses/协作 Worker。调试任务不属于 Work 审批流程；
原有 Work、聊天和消息渠道并未自动迁移。

本页不包含远程 Agent 导入、文件交付、OAuth 自动发现、逐 Token 流或任意网络连通性探测。
完整协议说明见[公开 A2A](A2A_NATIVE.zh-CN.md)与[内部协作](A2A_LOCAL_COLLABORATION.zh-CN.md)。
