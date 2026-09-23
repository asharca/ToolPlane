# 注册和委派远程 A2A Agent

> [English](A2A_REMOTE_AGENTS.md)

面向部署管理员、工作区管理员和 Agent 使用者。此功能允许 ToolPlane 内部 Agent 把明确的
文本任务委派给经过授权的外部 A2A 服务。任务仍使用原生 A2ATask / Context / Worker 和
父任务等待机制，不调用旧 Responses 执行器、不伪造 Endpoint 或 API 客户端。

## 先配置部署级网络白名单

默认不允许任何远程出站连接。部署管理员在应用环境中配置精确的 HTTPS **来源** JSON 数组：

```dotenv
TOOLPLANE_A2A_REMOTE_ORIGINS='["https://agents.partner.example"]'
```

来源包含协议、主机和可选端口，不包含路径、通配符、凭据、查询参数或片段。
Compose 已传递此环境变量；更改后按单运行时所有者的正常升级/重启流程使新进程读取配置。
工作区管理员不能在页面上绕过部署级白名单。

每次连接都重新检查来源、解析 DNS，并拒绝私网、回环、链路本地、多播及保留地址；
混合公私网 DNS 结果也被拒绝。HTTPS 连接固定使用此次校验后的地址，保留原域名的 TLS
证书检查，不自动使用代理环境或跟随重定向。Card 与 RPC 必须是**同一批准来源上的不同路径**。
因此这一版不支持访问仅在私有网络内可达的远程 Agent。

## 在控制台注册和授权

打开 **Agent 设置 → A2A 接入 → 远程 A2A Agent**。管理员填写显示名称、Agent Card 完整
地址、JSON-RPC 完整地址，以及可选的远端 Bearer 密钥，点击验证注册。验证会访问 Card，
但不会执行任务。服务保存时默认关闭，当前 Agent 也默认没有调用权限。

管理员需要分别执行“启用远程服务”和“授权当前 Agent”。服务注册在工作区内，授权按
发起方 Agent 分开配置；普通成员只能发现当前 Agent 已获准使用的目标，不能自行注册或授权。
每个工作区最多 100 个连接，每个连接最多授权 100 个 Agent；没有自动互联网发现。

当前支持官方 SDK `@a2a-js/sdk@1.2.0` 对应的 **A2A 1.0 JSONRPC 文本配置**。
Card 必须声明精确的 RPC 地址、1.0 版本、text/plain 输入与输出及能力；其他接口地址不会
被客户端自动选用。不支持的必需扩展、OAuth、API Key 自定义头或 mTLS 授权会被明确拒绝，
不降级到旧协议。无鉴权服务或单一 HTTP Bearer 服务可以注册。

Card 是能力声明，不是信任证明。本功能没有进行 Card 签名认证或官方 TCK 认证；管理员应
确认对端身份、数据处理政策和凭据权限。TLS 校验不等于对端输出可信。

## 凭据与配置变更

远端密钥只供平台发起网络请求，使用平台现有加密存储，密文绑定连接记录和工作区。
密钥不会放入 Agent 工具参数、任务授权快照、返回列表、审计或提示词。控制台输入只在
页面内存中保留，隐藏页面或三分钟后清除，不写入 localStorage/sessionStorage。

“替换远端密钥”不会返回之前的密钥。启用、关闭、授权与密钥变更都会递增配置修订，
旧任务授权不再匹配；执行/观察时复核后停止继续访问，已在途请求无法撤回。停止本地观察**不能保证远端
已停止执行**，必要时应由管理员在对端确认任务状态。改变地址或重新获取 Card 需注册
新的连接；本版没有原地改地址、自动 Card 刷新或删除连接接口。

注册及密钥修改没有自动重试。网络中断时先刷新确认结果，再决定是否重新操作。

## 从原生 Agent 任务委派

先启用调用方的内部 A2A，通过本地任务调试或原生本地 API 发起根任务。
运行时受限 MCP 工具新增：

| 工具 | 用途 |
|---|---|
| `a2a_list_remote_agents` | 发现当前 Agent 被允许使用的有效远程连接 ID 与名称 |
| `a2a_send_remote_message` | `remoteAgentId` 加标准 SendMessageRequest，创建同一个原生核心中的子任务 |
| `a2a_get_task` / `a2a_cancel_task` | 查询或请求取消当前父任务的直接子任务 |
| `a2a_await_tasks` | 结束本轮并持久等待本地/远程子任务，之后恢复父任务 |

工具使用示意（在 Agent 的受限运行环境中调用，不是新的 A2A 网络方法）：

```json
{
  "remoteAgentId": "<已注册并授权的连接ID>",
  "request": {
    "message": {
      "messageId": "<新消息的唯一ID>",
      "role": "ROLE_USER",
      "parts": [{ "text": "只审查以下明确提供的代码，不读取其他文件。" }]
    },
    "configuration": { "returnImmediately": true, "historyLength": 0 }
  }
}
```

内容会离开 ToolPlane：不要未经授权提交私人文件、记忆或凭据。平台只发送本次明确的
文本，不投影本地账户、模型凭据、运行 Token、授权元数据或本地任务 ID。远端要求的租户
来自已批准的 Card，不接受模型临时更换目标 URL 或连接凭据。

ToolPlane Task ID 与远端 Task ID 分开。查询与续写使用返回的 **ToolPlane 子任务 ID**，
平台内部保存对应关系；INPUT_REQUIRED 时用相同子 taskId、新 messageId 补充信息。
远端文本作为不可信任务数据传回父任务，不能作为系统指令或权限。恢复时再次核对远端授权；已撤权的结果不再注入父任务。远程 Agent 不会因为
本次委派而得到继续调用 ToolPlane 私人 Agent 的能力。

## 等待、取消和故障恢复

发送前先持久记录消息标识，业务提交不自动重发。远端返回已接受任务后释放本地执行槽，
由有界观察器用标准 GetTask 读取结果，内部阶段为 `remote-waiting`，对外仍是官方 WORKING。
远端完成或追问后，原生父任务等待机制照常汇总和恢复，不引入另一套任务状态机。

请求取消先标记待取消；只发一次 CancelTask，然后查询确认。远端返回 CANCELED 才表示
远端取消已确认；若远端抢先完成，真实完成结果优先，不伪造取消成功。

首次提交断线且不知道远端 Task ID 时，ToolPlane 任务失败并提示结果不确定，**不会为了
重试而自动再发一次任务**。知道远端 ID 的工作中任务在平台重启后只恢复观察，不重发消息。
读失败最多四次退避重试（2/4/8/16 秒），截止时间、授权撤销或持续失败后停止观察，标记
本地失败并明确远端可能仍在执行。已发生的外部副作用不会回滚，也不保证 exactly-once。

父任务的取消/失败会向后代传播。当前有效授权允许取消已知远端任务；连接关闭、密钥变化、
成员移除或部署白名单撤销后不能继续借用旧授权发网络请求，包括取消。

## 限制、迁移和验证

请求最多 256 KiB、响应最多 512 KiB、Card 最多 64 KiB，每个 HTTPS 请求（含 DNS）最多
15 秒、全局最多 16 个连接；远程任务观察每批最多四个。Task 的输入、输出、根链深度、
根任务数量、截止时间和聚合存储/输出保护继承[原生资源限制](A2A_RESOURCE_LIMITS.zh-CN.md)。
远端输出仅接受文本，不抓取文件 URL、执行 HTML，或接受混合 Part oneof。其他输入输出
模式、推送订阅、公开 Agent 向远端再委派、远程文件、原生审批和传统 Work 迁移不在此配置内。

在前面三个 A2A 迁移之后应用 `20260923060000_a2a_remote_agents`，重新生成 Prisma Client。
新增独立注册表、远端 ID/观察字段和跨工作区外键约束，保留现有任务/快照/存储计量。
本次实现没有为任何实际 Agent 注册、启用外部连接或执行生产迁移。

```bash
pnpm exec prisma generate
pnpm vitest run tests/unit/a2a-remote-*.test.ts tests/unit/agent-a2a-remotes.test.tsx tests/integration/a2a-remote*.test.ts
pnpm exec tsc --noEmit
```

测试使用未修改的官方 A2A ClientFactory/JSONRPC transport、替身网络和隔离数据库。
本地 PGlite 模式明确跳过真实 PostgreSQL 并发领取用例；不能将这些结果当成真实远端、
CLI/模型、浏览器端到端或完整官方 TCK 验收。
