# 在控制台接入 A2A

> [English](A2A_CONSOLE.md)

日常使用通过现有智能体 Work/聊天界面对接 Pi；A2A 作为供其他 Agent 调用的集成接口保留。设置页不再常驻“执行记录／待审批”或任务调试区；历史、任务进度和根任务审批仍可通过 `/app/{workspace}/agents/{agentId}?settings=a2a&task={taskId}` 查看。打开链接不会提交任务或授予权限。内部子任务由父智能体发起委派即授权使用已配置工具，不再逐项等待人工审批。

面向工作区使用者。打开 **Agent 设置 → A2A 接入**，也可进入
`/app/{workspace}/agents/{agentId}?settings=a2a`。

“让外部服务调用此 Agent”区域直接提供接入步骤、账户 Token 管理入口（或 Hermes 服务密钥说明）、可复制的 Card / SendMessage / GetTask / SubscribeToTask / CancelTask 示例、响应解析和常见错误排查。未配置有效连接地址时仍可阅读指南；阅读或复制示例不会自动提交任务。
页面使用原生 A2A 1.0 核心，不需要在浏览器粘贴账户 Token。

## 内部协作

先配置 Pi、Claude Code、DSH 或 Hermes RPC 的模型与独占联网 Docker 沙箱，
再在调用方“配置允许委派的 Agent”中选择子智能体。经已认证聊天、Work 或 control
入口发起内部委派时，调用方与所选目标均无需额外开启 A2A 开关。
勾选只授权这些有向关联，不自动开放整个工作区。托管 Hermes 不支持该内部执行模式。

独立 Context 不是独立文件系统：任务可使用目标沙箱中的文件、记忆和已配置工具。
取消勾选后，相关授权在重新校验时失效；已经发生的副作用不会回滚。
独立的“外部 A2A 与渠道访问”开关仍须所有者或管理员确认，控制外部调用、
账户令牌认证的 A2A 根任务入口及渠道执行授权，不控制已勾选子智能体的内部委派。

通过自己拥有的根任务链接查看有界父子任务树，并处理根工具调用所需的人工审批。设置页不再提供提交、列表或追问的任务调试控件，请使用现有聊天／Work 界面或文档中的 A2A API。每次检查当前用户、目标配置和委派关系；失效或无权访问的子树不返回，知道其他人的任务 ID 不代表有权限。

提交会消耗模型与工具资源，不会在打开页面时自动执行。显示“已接受”不代表“已完成”；
任务树正常每 2.5 秒只读刷新，页面隐藏时暂停，全部可见任务终结后停止。可手动暂停、
恢复或刷新。单次请求最多 15 秒，连续网络错误会退避并在三次后停止，不会重复提交任务。
这是状态轮询，不是逐 Token 流。离开页面不会取消任务；取消请求可能先返回 WORKING，
实际停止后才进入终态。已终结任务不能原地重开。

文本和 JSON 以转义文本显示。小型内联文件必须点击下载，以附件数据处理，不预览 HTML；
文件名会清理，临时对象地址会回收，也不会抓取远程文件 URL。格式与大小见
[内部协作交付物](A2A_LOCAL_COLLABORATION.zh-CN.md#交付物)。

## 对外服务和凭据

先在托管 Hermes 的 **API 发布配置** 中发布有效的隔离 Endpoint，再启用“对外 A2A”。
账户令牌入口与公开发布是两个独立授权，公开调用不会获得私人 Agent 的权限。

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
仅当 `NODE_ENV=development` 时，额外允许 RFC1918 私有 IPv4 地址使用 HTTP：
`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；不放行公网 HTTP 或任意域名。
例如在 `.env` 设置 `NEXT_PUBLIC_APP_URL="http://10.0.10.2:3002"`，
运行 `pnpm dev --hostname 0.0.0.0 --port 3002`，浏览器也通过同一地址访问。
此规则同时用于控制台、连接示例及本地/对外 Agent Card；登录、工作区权限和严格
Origin 校验仍然生效。生产部署继续使用 HTTPS；内网 HTTP 不加密凭据，仅用于可信开发网络。

示例只引用环境变量，不填充真实密钥。服务端本地集成使用 `TOOLPLANE_ACCOUNT_TOKEN`，
对外集成使用 `TOOLPLANE_A2A_TOKEN`。两种 Token 不能混用；Card 也需要鉴权。
每个新任务替换 messageId；只在重试同一请求时复用完全相同的 ID 和内容。查询时替换 Task ID。

平台内说明提供可复制的 Token `export` 设置命令和 `uuidgen`，并直接展开 Card 与
SendMessage 的完整 curl 示例。请在能访问所示地址的电脑上，使用 Mac“终端”、Linux
终端或 Windows WSL Bash 逐条执行，不是在 ToolPlane 聊天框、浏览器控制台或 Agent
沙箱执行。在本机替换 Token 占位符，后续命令保持在同一终端窗口；命令历史可能保存
Token，不要分享历史或截图。获取 Card 不启动任务；SendMessage 会运行 Agent 并可能
消耗资源。正式接入由自己的后端程序发送相同 HTTP 请求。仅需内部 Agent 协作时，
勾选允许的子 Agent 即可，不需要运行这些终端命令。

## 浏览器和协议的边界

控制台通过独立同源 BFF 读取配置、管理凭据和调用本地任务：

```text
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console
POST /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/rpc
GET /api/v1/workspaces/{slug}/agents/{agentId}/a2a/console/tasks?rootTaskId=...
```

这是 ToolPlane 的控制台接口，不是新定义的 A2A 标准传输。浏览器写入必须具备有效登录态和
与部署配置一致的 Origin；显式 Authorization、跨站请求、伪造工作区/用户/权限被拒绝。
管理操作在事务中重新检查当前管理员资格。

公开 A2A 和服务端本地协议入口保持原有 Bearer 验证，不因此接受 Cookie 或浏览器跨域请求。
控制台不伪造账户 Token，也不绕回旧 Responses/协作 Worker。原生任务审批与 Work 审批记录独立；
受支持经典入口通过[统一适配](A2A_INGRESS_APPROVALS.zh-CN.md)进入原生核心；渠道需要显式绑定真实操作人，旧记录不自动重放。

对外连接区还提供[原生 MCP 适配](A2A_MCP_BRIDGE.zh-CN.md)，复用显式授予 A2A 权限的服务凭据。
连接对象是示例，不是所有客户端都通用的配置文件。

本页不包含大文件上传、OAuth 自动发现、逐 Token 流或任意网络连通性探测。
完整协议说明见[公开 A2A](A2A_NATIVE.zh-CN.md)与[内部协作](A2A_LOCAL_COLLABORATION.zh-CN.md)。

内部任务现在可通过[远程 Agent 注册与委派](A2A_REMOTE_AGENTS.zh-CN.md)调用经过单独批准的外部 A2A 服务。部署来源白名单、工作区注册和发起方 Agent 授权都必须显式配置；不自动开放私人资源。
