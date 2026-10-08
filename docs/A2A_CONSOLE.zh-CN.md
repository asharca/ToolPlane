# 在控制台接入 A2A

> [English](A2A_CONSOLE.md)

日常使用通过现有智能体 Work/聊天界面对接 Pi；A2A 作为供其他 Agent 调用的集成接口保留。设置页不再常驻“执行记录／待审批”或任务调试区；历史、任务进度和交互入口根任务审批仍可通过 `/app/{workspace}/agents/{agentId}?settings=a2a&task={taskId}` 查看。打开链接不会提交任务或授予权限。已鉴权的入站 A2A 根任务与内部委派子任务直接使用已配置工具，无需人工审批；普通聊天、Work、Control 和渠道根任务策略不变。

面向工作区使用者。打开 **Agent 设置 → A2A 接入**，也可进入
`/app/{workspace}/agents/{agentId}?settings=a2a`。

设置页只保留访问开关、授权、连接地址和凭据管理，不再内嵌教程或请求示例。接入时访问部署域名的 `/docs-api`：独立 Scalar 参考页从 `/api/v1/openapi.json` 加载 API 定义，统一展示账户 A2A、发布服务 A2A、MCP 桥接及现有 Agent API。文档无需登录，不包含账户数据或真实密钥。

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

## 连接地址与 API 文档

设置页分别展示账户入口和发布服务的 RPC / Agent Card 地址，可直接复制。地址来自部署配置 `NEXT_PUBLIC_APP_URL`，不从不可信 Host / X-Forwarded-Host 生成。生产环境需要 HTTPS；回环地址允许 HTTP，开发环境还允许 RFC1918 私有 IPv4。

接口参数、鉴权、JSON-RPC 方法、SSE 响应和调用示例统一在 `/docs-api` 查看。Scalar 随应用打包，不依赖运行时 CDN，也不持久化凭据或启用托管 AI。A2A 是服务端到服务端接口，请复制生成的请求到自己的后端执行，不改变原有 Origin、Bearer 和工作区权限校验。


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

原生 MCP 适配的接入地址、协议和工具说明也在 `/docs-api`，使用同一专用 A2A 服务凭据。内部实现与协议边界见 [MCP 桥接](A2A_MCP_BRIDGE.zh-CN.md)。

本页不包含大文件上传、OAuth 自动发现、逐 Token 流或任意网络连通性探测。
完整协议说明见[公开 A2A](A2A_NATIVE.zh-CN.md)与[内部协作](A2A_LOCAL_COLLABORATION.zh-CN.md)。

内部任务现在可通过[远程 Agent 注册与委派](A2A_REMOTE_AGENTS.zh-CN.md)调用经过单独批准的外部 A2A 服务。部署来源白名单、工作区注册和发起方 Agent 授权都必须显式配置；不自动开放私人资源。
