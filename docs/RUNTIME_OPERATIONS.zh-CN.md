# 运行时运维与架构升级

> **English**: [RUNTIME_OPERATIONS.md](./RUNTIME_OPERATIONS.md)

本指南面向单所有者 ToolPlane 部署的运维人员，说明架构加固迁移、运行时恢复、安装凭据及普通 Hermes 附件配额，不引入 active-active 执行。

## 升级顺序

1. 备份 Postgres 和托管运行时卷，记录当前版本及恢复流程。数据库与数据卷的恢复是不同操作。
2. 停止旧应用，确认其子进程和外部复制、导入、删除操作已结束。不要让新旧实例同时操作同一运行域。
3. 用现有部署 migrator 或 `pnpm exec prisma migrate deploy`，在明确核实的目标数据库应用 `20260917000000_architecture_hardening`，然后生成 Prisma client 并构建新应用。迁移增加安装登记、Token 登记/到期字段和附件预留，不删除旧 Token 或附件元数据。
4. 使用 `pnpm start` 或生产镜像启动一个应用进程，等待 `/api/v1/readiness` 返回 HTTP 200，再接收运行时流量。`/api/v1/health` 只表示存活，不证明恢复完成。
5. 使用生成的命令重新登记客户端安装，验证权限、同步与设备登记后，再显式撤销旧凭据或移除旧本地目录。旧的 scoped Token 仍仅能访问所属 Toolkit；曾把它用于账户操作的调用方须改用个人 Token。

新操作运行时不要只回退应用程序。先停止所有者，再采用验证过的数据库/卷恢复或向前修复方案。生产备份和凭据不能进入测试产物。

在线发布更新必须使用受管生产启动器。下载校验完成后，更新器先排空当前 runtime owner，**确认干净退出后才替换任何运行文件**，确保停机阶段的动态导入仍来自旧版本。缺少停机入口或排空失败时保留旧文件并报告失败；成功替换后发送 SIGTERM，由启动器完成退出，不直接调用 `process.exit()`。排空失败后的运行时保持阻断，须人工核对恢复，不能自动确认 dirty 标记。

更新完成必须同时满足目标版本、替换后的进程标识和 `runtimeReady=true`。本地更新状态接口在新进程处于 idle、运行时尚未就绪时返回 HTTP 503 和 `Retry-After: 2`，防止旧版界面把版本号变化误报为成功；下载、应用及失败状态仍正常返回，保留进度与错误信息。恢复阻塞不能靠页面刷新或删除所有权标记绕过。

Docker/Coolify 健康检查应使用 `/api/v1/readiness`，而不是 `/api/v1/health`，停机宽限须为 60 秒（手工重启使用 `docker restart --timeout 60`）。发布归档不会修改已有容器的健康检查和停止超时配置，应更新部署定义并在受控重部署时生效。原地更新后的容器不能直接按旧镜像重建，必须先保留当前运行版本。

受管启动器在 Next 前加载 `abort-signal.cjs`，对原生 `AbortSignal.any()` 的结果短暂添加再移除 abort 监听器，启动弱引用源信号跟踪。Node 24.21 否则会在超时后保留嵌套组合信号，最终令 MCP/消息通道请求报 `Set maximum size exceeded`。发布组装时须将该文件与内嵌 `server.cjs` 放在同一目录。将来升级 Node 后，先运行 `pnpm vitest run tests/unit/abort-signal.test.ts` 验证，再移除兼容处理。已经耗尽信号集合的进程须受控重启；只重启 MCP bridge 无法清空主进程的信号集合。

## 单一运行时所有者

`runtime/owner.ts` 用**独立长期连接**持有 PostgreSQL session advisory lock，不使用连接池中的短事务锁。数据库和 `TOOLPLANE_RUNTIME_DOMAIN`（默认 `default`）确定所有权域，同域两个进程不能同时恢复或操作运行时。操作同一 Docker 资源的所有应用必须使用相同数据库和 domain；改 domain 不是绕过所有权冲突的安全办法。

所有者经历 acquiring → recovering → ready，再经过 draining → stopped。执行入口未就绪时返回 503 和 `Retry-After`；恢复所需的签名 runtime 回调仍独立校验凭据。所有权连接丢失会中止受管操作、停止新工作，并保留恢复阻断。已有的数据库准入锁和预算控制仍与进程所有权相互独立。

`SystemSetting` 中的 dirty 标记仅在确认干净退出后移除。崩溃、数据库断连或不确定的 Docker 操作之后，即使 advisory lock 已释放，下个进程也拒绝自动接管。应检查日志、停止所有旧 owner，并确认 Docker helper、复制与删除操作已结束；之后才将 `TOOLPLANE_RUNTIME_RECOVERY_ACK` 设为恢复错误中打印的准确 UUID，用于**一次重启**，恢复后移除该变量。这是对外部操作已核对的确认，不是密码、强制解锁开关或自动高可用。无效标记需要排查，不能随意猜 UUID。

生产启动器收到 SIGTERM/SIGINT 后停止接收 HTTP、停止维护任务/coordinator/broker，有界排空或中止已跟踪工作，最后释放独立连接锁。启动器外层退出上限为 50 秒，Compose 提供 60 秒。超时或不确定操作保留 dirty 标记。自定义进程管理器应给予同等宽限并调用受管停机流程。`pnpm dev` 不具备生产启动器的信号编排，异常停止后可能需要显式恢复。

## 冻结的 Pi 扩展包

`pi-package` 是不可变 Pi 资源与可选扩展代码的制品，支持独立 `pi-sdk` runtime
和外部客户端，不迁移 Toolkit 或已有 Pi Harness 智能体。使用前应用
`20261001000000_pi_sdk_packages` 和 `20261002000000_pi_package_ecosystem`，
生成 Prisma client 并重启应用。

管理员显式构建可信捕获镜像；发布请求不会隐式构建：

```bash
docker build --target pi-package-capture -t toolplane-pi-package-capture:0.87.1 .
```

捕获要求运行时 owner 已就绪，同一 owner 仅允许一次操作（`capture_busy`）。
非 root 容器无外网、无宿主文件挂载；有界 TLS CONNECT broker 拒绝私网、混合
DNS 和重定向后的私网地址。公开或明确配置凭据的 npm/Git 生产依赖一起冻结，不执行扩展 factory、
生命周期脚本、Git hooks 或 pnpmfile。需要构建的包须提供可加载产物；超过
16 MiB 的文件明确拒绝，不跳过。

审核重新验证路径、链接、解码后的 secret scan、文件 hash 和整个 release checksum。
安装只产生 ready `MarketInstall`，不执行代码。工作区升级同时更新两个 install
版本指针，但 Agent 保留明确启用的 release；须在 task、Work 和 lease 结束后
显式应用版本。有 Agent 绑定时不能卸载。公共详情只投影小摘要并保留原 checksum，
不返回 base64 或依赖文件；SDK 资源解析遇到撤销或下架立即拒绝。
批准意味着接受扩展在 Agent 沙箱内的任意 Node、文件和网络副作用，工具审批并非
任意代码隔离边界。

在创建 Agent 时选择 **Pi SDK**，再到**设置 → Pi 扩展**启用工作区已安装包。
SDK 固定为 0.87.1，要求 Linux、Node 24；捕获包要求匹配的 Docker 架构。
TP 组装包声明 `any/any` 可移植资源，但不放宽 SDK 与 Node 要求。普通 Pi 的
Harness 会话与版本管理保持不变。可信运行时安装使用 `pnpm add --save-prod`，
兼容 pnpm 10/12；执行 turn 时不安装市场包依赖。

SDK 使用官方 JSONL，不提供 Harness 检查点恢复。包集合改变返回
`PI_SDK_PACKAGE_SET_CHANGED`；持久会话文件缺失或未落盘宿主丢失返回
`PI_SDK_SESSION_MISSING`。两者都要求新会话或新 Work，不重放历史，旧记录仍可读。
文件或链接篡改返回 `PI_PACKAGE_CHECKSUM_MISMATCH`，扩展加载失败返回
`PI_EXTENSION_LOAD_FAILED`。命令保留大小写及 `:1` 等冲突后缀，纯命令给出完成回执；
终端交互 UI 不映射到 Web。Control MCP 创建、公共 endpoint 和模板发布不开放
此 runtime，已有授权消息和工具入口仍可使用。

### 插件源、组装与外部安装

**市场 → Pi 扩展**默认展示可搜索、分页的完整 [Pi 官方目录](https://pi.dev/packages)。
成员选择精确版本后免人工审核安装；服务端验证实时目录成员身份和公共 npm 的版本、integrity，
再捕获并校验不可变制品。release 记录 `reviewPolicy: 'official-directory'`，不记录人工审核者；
这不代表安全背书或 Web 兼容。安装不执行代码，不改变 Agent 固定版本。
自建来源和组装包仍须人工审核。owner/admin 在**工具包 → Pi 包 → 工作区 Pi 来源**管理
HTTPS 目录、npm registry 或 Git 来源；凭据加密保存且不回显，只发送到配置的 authority/path。
目录凭据不传播到发现的包地址。支持公网 HTTPS 上的私有仓库；LAN、回环、link-local、
混合 DNS 和重定向仍被阻止。捕获凭据通过可信 stdin 传入，不进入 argv 或 Docker 环境。

自建目录响应 `GET <配置地址>?query=<搜索词>&page=<从1开始页码>`，返回
`{schemaVersion:1,entries:[{name,source,description?,version?}],hasMore:boolean}`；
最多 50 项、2 MiB，`source` 是支持的 npm/Git 来源。发现目录时不执行包代码。

**工具包 → Pi 包 → 新建 Pi 包**冻结所选 Skill 文件，为明确选中的 MCP 工具生成真实 Pi 扩展。
新包默认工作区私有，公开须明确选择。MCP 需求只含逻辑 key 和允许工具名，不带凭据或
发布者 deployment ID。同工作区安装可使用私有默认绑定；其他工作区必须绑定自己的服务。
有活跃 task、Work 或 lease 时禁止修改 Agent 使用的绑定。纯 Skill/Prompt/Theme 包
不需要伪造空扩展。
选择**打包现有工具包**可预填其 Skill 和当前开放的具体 MCP 工具，编辑后发布独立 Pi 包；
不会修改原工具包或 Agent 绑定。来源导入、新版本发布、撤回和更新跟踪均在工具包界面；
Pi 市场仅负责发现与安装，不提供发布表单。

获批包可下载确定性的 npm 兼容 tarball。发布到配置的 npm registry 需要 owner/admin
权限和明确确认，不能覆盖既有版本，也不自动进入官方目录。

**已安装 → 客户端安装**为 Pi、Claude Code、Codex、OpenCode 或 Hermes 创建固定
release 的独立登记。下载安装器与一次性私有配置，以 `chmod 600` 保护配置，再执行
`node pi-package-install.mjs install --config <私有配置.json>`；更新与卸载分别使用
`update`、`uninstall`。Pi 获取原生包资源，其他客户端只获取支持的 Skill/MCP 配置，
不执行任意 Pi 扩展。当前安装为操作系统用户全局范围，不是项目级；MCP 经 TP 提供，
需要连接该 TP 实例。

每台设备使用独立 hash token；设备接口不接受个人或 Toolkit token。每次请求复核成员、
release、deployment 权限和实时暴露工具。新增工具不自动扩权。更新遇到本地修改文件或
托管目录链接越界时拒绝；卸载先取得自撤销确认，再删除未修改的托管文件。页面撤销不
声称删除本地文件；活跃设备登记阻止卸载工作区安装。私有配置不得写入日志、提交或截图。

runtime owner 每五分钟至多串行检查八个到期订阅，每个包至少间隔六小时，也支持手动
检查。tag/range 和 Git 分支更新只提示；精确版本/commit 保持固定。检查不捕获、不安装、
不发布、不改变 Agent/设备。同版本 integrity 变化视为异常。用户捕获并审核新 release 后，
分别手动更新工作区和 Agent/设备，设备扩权须确认。TP 组装包从所选工作区资源显式重新
发布，不在后台静默重建。

## Pi 版本管理

在**智能体列表 → 列表选项 → 智能体管理**中集中管理当前工作区的全部普通
Pi 智能体。勾选需要更新的智能体后，点击**升级所选智能体至最新版**，也可
为所选智能体安装指定版本。默认不勾选，未选择时不能更新；需要全部更新时
先点击**全选**。服务端在任何更新前校验所有选中 ID 均属于当前工作区授权
范围内的普通 Pi 智能体，包含不可用 ID 的请求会被拒绝，其他工作区和公共
Endpoint 运行时不会进入更新范围。每批只解析一次发布版本，未选中的智能体
保留在列表中且不会被更新，结果汇总仅统计本批。某项失败不影响后续已选
智能体升级，已是目标版本的智能体跳过。
绑定的 Docker 沙箱须已启动并可联网，运行时所有者须处于 ready。原有执行
租约会拒绝忙碌沙箱的更新，不中断正在执行的 Chat、Work 或 A2A 任务。

更新将同版本的 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai`
安装到独立的 `/workspace/.toolplane/runtime-packages/pi-<version>` 目录，禁用
安装生命周期脚本。只有 `pi --version` 成功且匹配指定版本后，才原子替换
`/workspace/.toolplane/runtimes/pi/agents/<agent-id>/version`。直接 Work 与终端
CLI/SDK 会话读取此版本；未设置时使用内置默认值。A2A 托管 Pi 任务使用下述
独立固定 Harness 包。更新不删除工作文件、会话和旧包；旧 CLI 不保证数据向后兼容。

此功能更新沙箱运行时，不修改 ToolPlane 宿主的 `pi-ai` 依赖。无法读取 registry
时仍显示已成功读取的当前版本。安装或可执行文件验证失败不会切换版本；
请求中断或结果不确定时应先检查当前选定版本，再重试。可执行文件验证不等于
对任意上游版本的全部能力完成兼容性认证。

## Pi Harness 托管任务

经原生 A2A 入口准入的新本地 Pi 任务使用官方 Harness 与 SQLite Session 后端。
聊天、消息渠道和 control 沿用原任务回执；直接 Work 与裸终端不在本次迁移范围。
模型仅使用 `a2a_peers`、`a2a_call`、`a2a_status`、`a2a_cancel`，目标为
`agent:<id>` 或 `remote:<id>`。工作区授权、循环/深度限制、根任务人工审批及远端凭据隔离仍生效。内部子任务由有效的父级委派授权工具执行，仍保留单次回执、撤权和租约检查。

受管包固定在 `/workspace/.toolplane/runtime-packages/pi-harness-0.87.1`：
`pi-agent-core`、`pi-session-backend-sqlite-node`、`pi-coding-agent`、`pi-ai`
均精确锁定 **0.87.1**，复用 MCP **1.30.0** 与 A2A **1.2.0** SDK。要求
Node **>=22.19.0**、`node:sqlite`、可用 Docker 和沙箱持久卷。
**Harness 存储格式 4 尚未稳定**，不能自动升级或假设存在向后兼容/迁移能力。
安装校验版本并执行真实子进程崩溃恢复自检，失败阻止执行，不降级内存或旧执行器。

维护窗口停止新 Pi 托管任务，旧 legacy 任务自然完成或由操作者明确取消，禁止自动重发。
备份 PostgreSQL 和沙箱卷，使用部署 migrator 或 `pnpm exec prisma migrate deploy`
应用 `20260927181819_pi_harness_task_binding`，执行 `pnpm db:generate` 并重启应用。
迁移仅增加 `executionBackend` 与 `nativeOperationId`，已有行保持 `legacy`，不新增任务表或给历史任务改标签。

实机验证前，确认运行服务实际连接的数据库已有两个绑定字段；源码已部署、provider 已配置，
不等于迁移已执行。不要仅为运行 smoke 就擅自迁移共享数据库。
发布地址 `NEXT_PUBLIC_APP_URL` 必须使用 HTTPS，仅回环地址允许 HTTP。
即使客户端通过回环连接，配置为 HTTP 局域网地址仍会令 Card 发现返回 400，
RPC 初始化也无法构造 Agent Card。仅经 SSH 验证时可明确配置回环发布地址，
但沙箱运行时地址仍须能从 Docker 内访问；修改或重启共享服务前须取得授权。

PostgreSQL 保存身份、授权、回执、claim、审批与协议投影；Pi 步骤状态仅保存在
`/workspace/.toolplane/runtimes/pi/agents/<agent-id>/harness/`。Session ID 是原
A2A context ID，lane 为 `main`。恢复复用已保存 operation ID，不从平台 snapshot 重放工具。
首次迁移通过原生事务导入有效 JSONL 历史，不执行历史工具，也不删除原文件。
`PI_SESSION_MISSING` / `PI_SESSION_CORRUPT` 需要排查或恢复卷；即使同一 context
开始后续任务，也不能用空库或旧 JSONL 冒充丢失的原生 Session。

owner 停机只停止 driver，不等于用户取消。恢复仍须经过原有 owner/dirty-marker 协议，
并确认旧受跟踪进程已退出后才能打开 SQLite 新 writer。用户取消、撤权和超时清理请求
原生 abort，以原生终态提交顺序裁决。危险/未知工具不盲目重放，不确定副作用保持可见。
远端请求已发出但回执未知时不重发，不承诺远端 exactly-once；不新增 Redis、工作流服务或跨主机 SQLite writer 协调。

在已认证的会话命令界面，或绑定该会话的 Pi 消息渠道发送 `/compact` 或
`/compact <自定义指令>`。Harness 会话压缩的是原生 Session 的同一个 `main` lane，
不是旧 JSONL。调用者必须拥有该会话绑定；context 有活跃任务或会话/沙箱锁已占用时
返回 busy，不另开 writer。须等命令结果及 usage 元数据持久化后才算完成；失败不回退 CLI。
未绑定的 legacy 会话、直接 Work 和终端仍保留原路径。下述通信 smoke 不验证 `/compact`，
需在自己拥有且空闲的会话中另行验证。

配置页区分内部授权、连接外部和受认证入站。Agent Card URL 加可选远端 Token 一次
登记、启用并授权当前 Agent；多候选地址须用高级 RPC 设置明确选择。内部协作只需选择
允许调用的子智能体，调用方和目标均无需启用 `a2aInternalEnabled`。已认证的聊天、Work
和 control 仍执行工作区、账户、所选委派关系、循环/深度、租约及审批检查。
原有 `set-local` / `a2aInternalEnabled` 开关单独展示为「外部 A2A 与渠道访问」，
仍控制外部调用、个人令牌认证的 A2A 入站和渠道授权；远程目标与渠道执行身份仍需
各自授权。修改开关仍需管理员权限和确认，选择子智能体不会自动启用此开关。
个人 Bearer 只用于操作者控制的服务，不能交给第三方 Agent、放进提示词或浏览器代码。
Hermes 发布服务及独立 key 流程保持原样。

在独立真实 PostgreSQL 测试库串行运行 `pi-harness-recovery`、`pi-harness-host`、
`pi-harness-binding`、`pi-harness-worker` 和 `pi-agent-communication` 集成测试，
Vitest 加 `--no-file-parallelism`，不能同时启动另一个共用该库的测试进程，
也不能用 PGlite 代替锁/进程恢复验证。`node scripts/pi-harness-recovery-check.mjs --self-test`
使用真实官方后端，不调用付费模型，不能据此认定真实 provider 或 Docker 集成通过。

单独验证保留的直接 Pi CLI：在可丢弃 Docker 容器内安装现有固定默认 CLI 包，运行
`TOOLPLANE_NATIVE_COMMAND_SANDBOX=<container> TOOLPLANE_NATIVE_COMMAND_KIND=pi pnpm vitest run tests/integration/native-runtime-session.test.ts`。
此检查使用本机受控模型端点验证 prompt、compact、重连与历史丢失拒绝，不是付费 provider 验收。
macOS/Windows 使用 Docker Desktop host DNS，Linux 使用容器网络 gateway。

先运行 `node scripts/pi-agent-communication-smoke.mjs --help`，再配置五个必填输入：
`TOOLPLANE_SMOKE_BASE_URL`、`TOOLPLANE_SMOKE_WORKSPACE_SLUG`、
`TOOLPLANE_SMOKE_AGENT_A_ID`、`TOOLPLANE_SMOKE_AGENT_B_ID`、
`TOOLPLANE_SMOKE_PERSONAL_TOKEN`。BASE_URL 必须是 origin，仅 loopback 可用 HTTP，
其余必须 HTTPS。Token 仅放本地环境，不放命令参数、提示词或第三方服务。脚本仅将它
发送到选定工作区的公开 Agent MCP 和两个 local A2A 接口，不请求只接受会话认证的
console BFF，且拒绝重定向。控制台链接由操作者在独立已登录浏览器中打开。

使用隔离测试 app/runtime-owner；两个 Pi Agent 须配置真实模型，名称或 slug 以
`pi-smoke-disposable-` 开头，各自绑定一个不同且运行中的 Docker 沙箱，明确允许 A → B
协作。启用所需工具；根任务保留人工审批，B 的内部子调用由父级委派授权。准备真实 provider、Docker、PostgreSQL、交互终端和
`TOOLPLANE_SMOKE_ALLOW_PROCESS_KILL=1` 后，运行
`node scripts/pi-agent-communication-smoke.mjs`。在输出的控制台链接实际批准 A 的委派调用、
独立的取消和重启计数任务；B 的委派计数无需人工审批。**拒绝**单独的 denied-write 任务；实际操作后才输入脚本要求的
精确确认文字。脚本不会代批。缺前提、审批或未捕获崩溃边界都失败，不能跳过冒充通过。
未配置真实 provider 时付费模型 smoke 不可执行；本文和后端自检均不是 live smoke 通过证明。

SIGKILL 前必须观察到已提交的工具 settlement、计数 **1** 及未终结的
`assistant.effect_pending`。脚本校验受跟踪 wrapper 的精确参数、PID 文件归属、
wrapper/child 启动时间和父子关系、host/config 路径、Agent 目录及 task/context/operation，
发信号前立即复核，只杀该 child。原生观察用只读 SQLite 事务，不开第二个 SessionRepo writer。
恢复须以相同子 operation 完成且计数仍为 **1**，父任务须包含已归属子任务的真实结果。
取消还须原生 `aborted`、无 driver 且计数停止；拒绝须原生拒绝证据/`aborted` 且写入为零。

平台重启使用单独的计数任务。出现 `OPERATOR_STOP_REQUIRED` 时，**只停止自己的隔离
测试 app/runtime-owner**，保持 Docker 和 smoke 脚本运行，等待脚本观察 API 不可用、
driver 消失且原 operation 仍未终结；未提示前不要重启。确认 `STOPPED <taskId>` 后，
在 `OPERATOR_START_REQUIRED` 提示下正常启动同一应用，禁止强制接管 owner 或重发 prompt。
脚本轮询原 task，要求 task/context/operation 不变、原生完成且计数 **1**，再要求
`RESTARTED <taskId>` 与实际审批确认。已取消/拒绝任务重启后仍须原生 aborted。
每轮等待最多五分钟；若模型在观察到停机前已完成，场景失败，不伪称重启验证。
脚本不会停止共享服务或重启容器。

保留 fixture 和配置供检查；失败清理只请求取消本次创建的回执，无法确认时明确要求操作者处理。
真实 HTTPS 远端、其他账号授权和 `/compact` 仍须另行验证，不承诺远端 exactly-once。
`node scripts/a2a-e2e-preflight.mjs` 仅检查前提，不是 E2E 通过证明。


## 普通 Hermes 附件

所有大小配置经过同一解析器。单文件默认仍为 **1,000,000,000 字节**；绝对硬上限为 **2,000,000,000 字节**，与当前 `AgentAttachment.size` 的 Prisma Int 一致。`TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES` 可进一步降低硬上限。数据库设置优先于 `TOOLPLANE_MAX_ATTACHMENT_BYTES`，再到默认值，但所有来源均受硬上限约束。无效值报错，不静默放宽；数据库读取失败时，已有有效缓存的进程可使用最后有效值并显示 cached，冷启动进程拒绝新上传。

默认配额：

| 环境变量 | 默认值 | 范围 |
|---|---:|---|
| `TOOLPLANE_ATTACHMENT_WORKSPACE_BYTES` | 20,000,000,000 | 一个工作区已提交的普通 Agent 附件及待结算预留 |
| `TOOLPLANE_ATTACHMENT_AGENT_BYTES` | 5,000,000,000 | 同一 Agent 的上述用量 |
| `TOOLPLANE_ATTACHMENT_CONCURRENT_UPLOADS` | 2 | 每工作区活跃普通 Agent 上传数 |

上传前在持有工作区行锁的短事务中预留额度，不在传输整个字节流时持有数据库事务。缺少 Content-Length 时预留单文件最大额度；即使伪造头部，实际流入字节也不能超出预留。成功时写附件元数据并移除预留，二者原子完成；失败仍计入用量，直到确认物理文件清理完成。

预留 30 分钟到期，长于有界上传时间。owner 每分钟执行有限批次回收，只经所属 Hermes 沙箱删除预留中记录的最终和临时路径。运行时缺失、不可达或清理失败时继续计费；应调查原因，而非手工删除预留记录制造空闲额度。销毁卷仍由 runtime/workspace 删除流程负责。

这些是**普通 Hermes Agent 附件**配额，不是整个 Docker 磁盘配额。Workspace/Work 上传、Hermes 归档、快照和运行时直接生成的文件有各自生命周期，不会悄然计入此处。Connector 文件在用户机器上，不由本配额管理器回收。运维仍须监控物理磁盘并设置文件系统限制。已有附件计入准入用量，升级不清理它们；超过新配额的部署应显式调高配额，或通过支持的数据生命周期移除内容。

## 安装与诊断变化

稳定命名、多设备凭据、五分钟轮换宽限、可恢复本地更新和准确归属卸载，详见 [Toolkit 同步](./TOOLKIT_SYNC.md)。预览链接不再签发 Token；安装链接仍是敏感能力，泄露后应重新生成。

Agent 内容采集见[日志与审计](./OBSERVABILITY.zh-CN.md)。普通诊断不启用内容采集；显式开启后仍有大小限制、审计，最多保留 24 小时。公共 Endpoint 禁止策略不可覆盖。

## 验证边界

`tests/unit/runtime-owner.test.ts` 验证状态机和租约故障路径；`tests/integration/runtime-owner-lease.test.ts` 需要真实独立 PostgreSQL 会话，验证锁争用和连接丢失。`tests/integration/attachment-reservations.test.ts` 验证额度准入与事务结算。`TOOLPLANE_TEST_PGLITE=1` 仅供隔离嵌入式数据库冒烟测试，跳过其不支持的多会话场景，不能在 CI 或生产设置。Docker 生命周期及真实客户端验收需要相应运行环境，不能用解析器或 mock 测试通过替代。
