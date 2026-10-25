# 运行时运维与架构升级

> **English**: [RUNTIME_OPERATIONS.md](./RUNTIME_OPERATIONS.md)

本指南面向单所有者 ToolPlane 部署的运维人员，说明运行时恢复、经审阅的 Pi 能力、限定范围的客户端登记与只读历史存储；不引入 active-active 执行，也不构成生产迁移授权。

## 升级顺序

1. 备份 Postgres 和托管运行时卷，记录当前版本及恢复流程。数据库与数据卷的恢复是不同操作。
2. 停止旧应用，确认其子进程和外部复制、导入、删除操作已结束。不要让新旧实例同时操作同一运行域。
3. 审阅目标版本对应的仓库迁移，仅在明确核实的目标数据库通过现有部署 migrator 应用，然后生成匹配的 Prisma client 并构建应用。保留的消息、文件和审计/来源记录不是可随意清除的迁移数据。
4. 使用 `pnpm start` 或生产镜像启动一个应用进程，等待 `/api/v1/readiness` 返回 HTTP 200，再接收运行时流量。`/api/v1/health` 只表示存活，不证明恢复完成。
5. 受控切换前排空全部旧运行时活动任务。Toolkit 可转换内容冻结为私有包，撤销旧客户端凭据，客户端须按明确选择的版本与范围重新登记；不自动重发公开版本，不恢复旧执行。历史消息和文件保留只读，见 [Toolkit 受控切换](./TOOLKIT_SYNC.md)。

新操作运行时不要只回退应用程序。先停止所有者，再采用验证过的数据库/卷恢复或向前修复方案。生产备份和凭据不能进入测试产物。

在线发布更新必须使用受管生产启动器。下载校验完成后，更新器先排空当前 runtime owner，**确认干净退出后才替换任何运行文件**，确保停机阶段的动态导入仍来自旧版本。缺少停机入口或排空失败时保留旧文件并报告失败；成功替换后发送 SIGTERM，由启动器完成退出，不直接调用 `process.exit()`。排空失败后的运行时保持阻断，须人工核对恢复，不能自动确认 dirty 标记。

更新完成必须同时满足目标版本、替换后的进程标识和 `runtimeReady=true`。本地更新状态接口在新进程处于 idle、运行时尚未就绪时返回 HTTP 503 和 `Retry-After: 2`，防止旧版界面把版本号变化误报为成功；下载、应用及失败状态仍正常返回，保留进度与错误信息。恢复阻塞不能靠页面刷新或删除所有权标记绕过。

Docker/Coolify 健康检查应使用 `/api/v1/readiness`，而不是 `/api/v1/health`，停机宽限须为 60 秒（手工重启使用 `docker restart --timeout 60`）。发布归档不会修改已有容器的健康检查和停止超时配置，应更新部署定义并在受控重部署时生效。原地更新后的容器不能直接按旧镜像重建，必须先保留当前运行版本。

Docker 构建与运行阶段共用 `python-runtime-base`，确保 Prisma 组装时检测到的 OpenSSL ABI 与启动环境一致。须保持这些系统库一致，否则镜像可能只包含 OpenSSL 1.1 引擎，而生产需要 OpenSSL 3，导致启动时临时联网下载。上线前应使用最终镜像，在禁止外网访问的隔离备份数据库上验证 `prisma migrate deploy`。

受管启动器在 Next 前加载 `abort-signal.cjs`，对原生 `AbortSignal.any()` 的结果短暂添加再移除 abort 监听器，启动弱引用源信号跟踪。Node 24.21 否则会在超时后保留嵌套组合信号，最终令 MCP/消息通道请求报 `Set maximum size exceeded`。发布组装时须将该文件与内嵌 `server.cjs` 放在同一目录。将来升级 Node 后，先运行 `pnpm vitest run tests/unit/abort-signal.test.ts` 验证，再移除兼容处理。已经耗尽信号集合的进程须受控重启；只重启 MCP bridge 无法清空主进程的信号集合。

## 共享 MCP 凭据切换

共享 MCP Deployment 的环境值使用 `AUTH_SECRET` 加密，保存在绑定工作区的
`credentialEnvelope` 中；数据库 `env` 只保存空字符串，公开序列化与 Deployment
列表只提供环境变量名和空值/`configured` 掩码状态。API 响应或导出不得包含
明文或密文 envelope。实时运行访问必须先验证工作区归属，再显式解密凭据。
旧非空明文配置在显式迁移前禁止运行。恢复数据库时必须保留原
`AUTH_SECRET`；更改此密钥不等于轮换凭据。

先备份数据库、停止应用/runtime owner，并独立确认所有 MCP 子进程及容器已经
退出。脚本不会停止服务或核对外部进程。所选工作区的 Deployment 持久状态必须
全部为 `stopped`、`error` 或 `setup_required`，否则拒绝；陈旧的空闲状态不能
证明实际进程已退出。核对目标 `DATABASE_URL`、`AUTH_SECRET` 后，按工作区的
数据库 ID（不是 slug）逐个执行：

```bash
# 默认只读 dry-run，仅输出计数。
pnpm exec node --conditions=react-server --import tsx scripts/migrate-mcp-credentials.ts --workspace WORKSPACE_ID
# 审阅 dry-run 并确认停机后，显式写入。
pnpm exec node --conditions=react-server --import tsx scripts/migrate-mcp-credentials.ts --workspace WORKSPACE_ID --apply
```

每次执行使用一个 Serializable 事务，更新时比较原工作区、状态、时间戳和配置；
并发修改、无效配置或明文/密文混合配置会回滚整批。已迁移行仅校验、不重写，
重复执行幂等。不会输出凭据值、密文、哈希或数据库错误；须私下排查失败，
不要将配置粘贴到日志或支持产物中。全部必需工作区迁移后再启动一个 owner，
等待 readiness 成功。

通过已认证的 Deployment 环境设置轮换或撤销值，不要直接修改 envelope 元数据。
轮换/撤销先停止旧进程，再存储重新密封的值；停止失败时不得绕过。
新运行连接通过显式私有解析器取得当前工作区凭据，元数据不能作为凭据来源。
本脚本只转换共享 MCP Deployment 环境值，不转换目录 recipe 或 Agent 专属凭据引用。
隔离测试数据库的聚焦回归入口：
`pnpm vitest run tests/integration/mcp-environment-credentials.test.ts`。

Docker MCP 的环境值只通过运行时 stdin 引导传入，不使用 Docker 环境参数、
镜像/构建层或 secret 文件。引导读取一行私有数据后 exec 原镜像入口和命令，
后续 stdin 完整保留给 MCP JSON-RPC。需要环境投影（包括包缓存设置）的镜像
必须提供带内建 `read`、`printf`、`eval`、`export` 的 POSIX `/bin/sh`；
无 shell 镜像将拒绝启动。没有环境投影的 Docker recipe 保留原入口，不要求
引导。禁止通过添加 `--env`、`--env-file` 绕过该传输约束。
运行时诊断会同时脱敏已配置环境和仅容器可见环境投影中的值，不依赖键名是否
看起来与密钥有关。仅存在于容器环境投影中的值也不得出现在捕获的 stderr 或
运行时日志响应中。

## 单一运行时所有者

`runtime/owner.ts` 用**独立长期连接**持有 PostgreSQL session advisory lock，不使用连接池中的短事务锁。数据库和 `TOOLPLANE_RUNTIME_DOMAIN`（默认 `default`）确定所有权域，同域两个进程不能同时恢复或操作运行时。操作同一 Docker 资源的所有应用必须使用相同数据库和 domain；改 domain 不是绕过所有权冲突的安全办法。

所有者经历 acquiring → recovering → ready，再经过 draining → stopped。执行入口未就绪时返回 503 和 `Retry-After`；恢复所需的签名 runtime 回调仍独立校验凭据。所有权连接丢失会中止受管操作、停止新工作，并保留恢复阻断。已有的数据库准入锁和预算控制仍与进程所有权相互独立。

`SystemSetting` 中的 dirty 标记仅在确认干净退出后移除。崩溃、数据库断连或不确定的 Docker 操作之后，即使 advisory lock 已释放，下个进程也拒绝自动接管。应检查日志、停止所有旧 owner，并确认 Docker helper、复制与删除操作已结束；之后才将 `TOOLPLANE_RUNTIME_RECOVERY_ACK` 设为恢复错误中打印的准确 UUID，用于**一次重启**，恢复后移除该变量。这是对外部操作已核对的确认，不是密码、强制解锁开关或自动高可用。无效标记需要排查，不能随意猜 UUID。

生产启动器收到 SIGTERM/SIGINT 后停止接收 HTTP、停止维护任务/coordinator/broker，有界排空或中止已跟踪工作，最后释放独立连接锁。启动器外层退出上限为 50 秒，Compose 提供 60 秒。超时或不确定操作保留 dirty 标记。自定义进程管理器应给予同等宽限并调用受管停机流程。`pnpm dev` 不具备生产启动器的信号编排，异常停止后可能需要显式恢复。

## 冻结的 Pi 扩展包

`pi-package` 是不可变 Pi 资源与可选扩展代码的制品。所有新执行统一走固定 Pi SDK；
其他运行时记录仅保留只读历史/文件，不提供执行兼容。创建新的 Pi 对象并明确审阅和
重新授权能力。只按上述受控升级流程应用经审阅的版本迁移，不能仅为启用包而迁移
正在运行的共享运行时。

管理员显式构建可信捕获镜像；发布请求不会隐式构建：

```bash
docker build --target pi-package-capture -t toolplane-pi-package-capture:0.87.1 .
```

捕获要求运行时 owner 已就绪，同一 owner 仅允许一次操作（`capture_busy`）。
非 root 容器无外网、无宿主文件挂载；有界 TLS CONNECT broker 拒绝私网、混合
DNS 和重定向后的私网地址。公开或明确配置凭据的 npm/Git 生产依赖一起冻结，不执行扩展 factory、
生命周期脚本、Git hooks 或 pnpmfile。需要构建的包须提供可加载产物；超过
16 MiB 的文件明确拒绝，不跳过。
上传 Pi ZIP 的原生扩展、Skill、提示词和主题共用隔离捕获、依赖冻结、文件清单及审核流程。
提交 `sourceType=zip`、`archive` File，并明确勾选 `confirmExecutableCode=on`；
不可变来源信息记录上传文件的 SHA-256。ZIP 上限为压缩 32 MiB、解压后 64 MiB、
单文件 16 MiB、20,000 项、单文件压缩比 1,000:1。仅接受 stored/deflate 普通文件和目录；
路径穿越、链接、特殊文件、大小写/Unicode 冲突、损坏头部和 CRC 不匹配均拒绝。
支持直接包根目录或外包一层目录。可信脚本更新后须重新构建捕获镜像。
Npm/Git/ZIP 发布须先以相同来源字段调用 `previewPiPackageSourceAction`，ZIP 预览
也须明确授权可执行代码。预览实际隔离捕获，仅返回资源/文件元数据、平台/runtime、
MCP 要求、解析后的固定来源和 `sourceDigest`，不返回文件内容或凭据。发布时向
`publishPiPackageReleaseAction` 传入该 digest；再次捕获并比较包含依赖的完整快照。
缺少预览返回 `source_preview_required`；上传变化、Git ref 移动或依赖漂移返回
`source_changed`，须重新预览。组装发布同样要求已审阅的冻结摘要；目录/service
调用没有省略摘要的后门。明确指定 `sourceType=release` 则选择所属工作区的准确
不可变 release，复用重新校验的冻结字节，不抓取上游。预览不创建市场记录、不安装
代码，需要与捕获相同的 owner/admin 权限和运行时所有权。

审核重新验证路径、链接、解码后的 secret scan、文件 hash 和整个 release checksum。
安装只产生 ready `MarketInstall`，不执行代码。工作区升级同时更新两个 install
版本指针，但 Agent 保留明确启用的 release；须在 task、Work 和 lease 结束后
显式应用版本。卸载在同一事务为受影响的活跃 Agent 发布“当前已应用修订仅移除该包”
的新默认，然后移除草稿绑定，不应用其他未审阅草稿改动。修订 CAS/校验失败则整次卸载
回滚；并发重复卸载不重复发布修订。新会话使用收窄后的默认，既有会话修订、被引用
制品和共享 MCP 部署保持不变。这种仅缩减能力的修订无需让无关的已撤销授权重新有效；
执行时仍强制实时限制。公共详情只投影小摘要、保留原 checksum，不返回 base64 或依赖文件。
危险 release 撤销立即阻止包含保留固定引用在内的新执行；
普通卸载/撤回 listing 不撤销同一 Agent 修订已保留的准确获批制品，仍复核实时 MCP、
provider 和凭据授权。包的 MCP 工具须同时处于固定修订授权与当前 Agent 连接的显式
允许列表；删除连接或移除必要工具会拒绝恢复，不能从包或会话文件恢复权限。
危险 release 应通过 owner/admin 鉴权的
`POST /api/v1/pi-packages/releases/{releaseId}/revoke` 提交
`{"workspace":"<工作区slug>","reason":"<经审阅的原因>"}`，不能以普通撤回/卸载代替。
该操作记录明确 `revoked` 状态、撤销依赖的客户端登记，同时保留可读 release/修订历史。
批准意味着接受扩展在 Agent 沙箱内的任意 Node、文件和网络副作用，工具审批并非
任意代码隔离边界。

创建新的 **Pi Agent**，在草稿选择已安装包，再执行**保存草稿 → Prepare → 审阅 → Apply**。
没有另一种 Pi SDK runtime 选择器，也不回退旧 Harness 执行。草稿修改不启用包、不改动
已有会话。SDK 固定 0.87.1，要求 Linux、Node 24；捕获包架构须匹配 Docker daemon。
TP 组装包声明 `any/any`，但不放宽 SDK/Node 要求。可信运行时安装使用
`pnpm add --save-prod`，兼容 pnpm 10/12；执行 turn 时不安装市场包依赖。

SDK 使用官方 JSONL，不提供 Harness 检查点恢复。Conversation、A2A context 和 Work
固定不可变 Agent 修订及准确包制品；工作区更新不改变这些引用。发布/回滚创建新的
默认修订，不改写已有会话。引导安装创建工作区资源，并在明确 Review + Apply 确认后，
以所选 Agent 当前已应用修订为基线，仅合入本次包和 MCP 授权；其他草稿不应用，
既有会话固定引用不变。目标没有已应用修订时，须先从 Agent 页 Prepare、审阅并 Apply，
向导在任何安装副作用前拒绝继续。修订 CAS 失败保留原默认。
同一鉴权操作创建且尚未共享的 MCP，可在部分失败后原地修正配置重试。预存/共享连接
不会被静默重配：到实际连接设置审阅受影响对象后修改，或新建连接。仍须确认执行代码
和 MCP 权限。
后续步骤失败时返回实际已完成的 deployment/install ID 和部分结果，不假称回滚或启用。
版本更新可明确携带已审阅的目标 `mcpBindings` 原子配置；缺少新工具权限返回
`pi_package_mcp_binding_required`，固定引用不能恢复实时撤销的授权。
切换前，账号鉴权客户端可 GET
`/api/v1/workspaces/{slug}/market/installs/{installId}/diff?targetReleaseId={id}&page=1&pageSize=50`。
仅比较同一条目已批准的 Pi/Skill/MCP 版本，重新校验两端制品 checksum 和当前工作区权限。
响应只含分页变更路径（每页最多 100 条）、权限/工具与环境变量名称、传输和运行时兼容性、
配置变化标记，不返回文件字节、recipe 参数或凭据。
Work 在受理时固定引用，不等待独立卷分配。卸载移除
默认绑定但保留被引用制品和共享 MCP；发布审批与工作区/Agent/MCP 当前权限仍须复核，
不会通过快照保留已撤销权限。状态不匹配仍以 `PI_SDK_PACKAGE_SET_CHANGED` 拒绝执行。
持久会话文件缺失或未落盘宿主丢失返回 `PI_SDK_SESSION_MISSING`，须新建会话或 Work，
不重放历史，旧记录仍可读。
旧版或未解决的修订/包状态以 `AGENT_REVISION_UNRESOLVED` 拒绝执行，不从当前默认值
猜测修订、不覆盖 checksum，也不重放历史伪造恢复。无法证明准确不可变引用时保留
历史状态只读，创建新的、明确授权的 Pi 对象/会话。
文件或链接篡改返回 `PI_PACKAGE_CHECKSUM_MISMATCH`，扩展加载失败返回
`PI_EXTENSION_LOAD_FAILED`。命令保留大小写及 `:1` 等冲突后缀，纯命令给出完成回执；
终端交互 UI 不映射到 Web。

### 插件源、组装与外部安装

**市场 → Pi 扩展**默认展示可搜索、分页的完整 [Pi 官方目录](https://pi.dev/packages)。
成员选择精确版本后免人工审核安装；服务端验证实时目录成员身份和公共 npm 的版本、integrity，
再捕获并校验不可变制品。release 记录 `reviewPolicy: 'official-directory'`，不记录人工审核者；
这不代表安全背书或 Web 兼容。安装不执行代码，不改变 Agent 固定版本。
官方目录交互式安装同样要求 `confirmExecutableCode=on`；仅展示执行风险说明，不等于用户已授权接收可执行包。
公开的自建来源和组装包仍须人工审核。私有 npm/Git/ZIP 或组装包可由 owner/admin
明确勾选 `confirmExecutableCode=on`，授权仅在本工作区使用可执行代码；release 记录
`reviewPolicy: 'workspace-owner-trust'` 与授权人/时间，不冒充人工公共审核或官方目录批准。
私有包不进入公共发现，其他工作区不能安装或下载。含工作区信任历史的 listing 不可直接
改为公开；通过同一发布 action 提交新公开 listing，使用 `sourceType=release` 和
`targetReleaseId=<私有release-id>` 复用冻结制品。服务端验证所属工作区并重新校验快照，
进入人工审核，无须再次抓取上游。新公开制品移除私有来源和工作区 ID，不公开私有历史。
owner/admin 在**资源中心 → 来源**（`/app/{workspace}/market/sources`）管理 HTTPS
目录、npm registry 或 Git 来源；凭据加密保存且不回显，只发送到配置的 authority/path。
目录凭据不传播到发现的包地址。支持公网 HTTPS 上的私有仓库；LAN、回环、link-local、
混合 DNS 和重定向仍被阻止。捕获凭据通过可信 stdin 传入，不进入 argv 或 Docker 环境。

自建目录响应 `GET <配置地址>?query=<搜索词>&page=<从1开始页码>`，返回
`{schemaVersion:1,entries:[{name,source,description?,version?}],hasMore:boolean}`；
最多 50 项、2 MiB，`source` 是支持的 npm/Git 来源。发现目录时不执行包代码。

**资源中心 → 组装**（`/app/{workspace}/market/compose`）冻结所选 Skill 文件，为明确
选中的 MCP 工具生成真实 Pi 扩展。包默认私有，公开须明确选择并另行审核。MCP 需求
只含逻辑 key/工具名，不带凭据或发布者 deployment ID。其他工作区绑定自己的连接；
在目标 Agent 草稿审阅并 Apply 前，选择资源不会授予执行权限。纯 Skill/Prompt/Theme
包不需要空扩展。提交前审阅冻结组装结果，输入变化须重新预览。来源导入和订阅来源
重新捕获经由**资源中心 → 导入**，遵守同一预览/提交契约，不提供自动捕获即发布捷径。
Toolkit 历史只读；转换是另行授权、排空后的 dry-run/apply 操作，不是编辑或执行产品；
既有公开版本不会自动重发。

获批包可下载确定性的 npm 兼容 tarball。发布到配置的 npm registry 需要 owner/admin
权限和明确确认，不能覆盖既有版本，也不自动进入官方目录。

**资源中心 → 客户端登记**统一使用既有 Pi 包机制，固定选择包 release 或独立 Skill/MCP
release；登记本身不能作为组合产品再次发布。Pi 获取原生包资源；Claude Code、Codex、
OpenCode、Hermes 只获取支持的 Skill/MCP，不获取 Pi 扩展、提示词或主题。下载安装器
和一次性私有配置，以 `chmod 600` 保护，执行
`node pi-package-install.mjs install --config <私有配置.json>`；更新与卸载使用同一配置的
`update`/`uninstall`。安装为系统用户全局范围，不是项目级；MCP 需要连接该 TP 实例。

每项登记使用独立 hash、可撤销 Token 和固定的准确 release 选择；设备接口不接受个人
或 Toolkit Token。账号更新要求所属用户、整数 `expectedConfigVersion` 和明确审阅新增权限。
审核配置更新递增独立版本；普通认证只更新 `lastUsedAt`，不会使打开的审核表单过期。
每次请求复核成员、release、deployment 权限和实时暴露工具；新增工具不自动扩权。
更新拒绝本地修改文件和托管目录链接越界；卸载先取得自撤销确认，再删除未修改文件。
页面撤销不声称删除本地文件；关联的活跃设备登记仍阻止卸载工作区安装。不要记录、
提交或截图私有配置。

runtime owner 每五分钟至多串行检查八个到期订阅，每个包至少间隔六小时，也支持手动
检查。tag/range 和 Git 分支更新只提示；精确版本/commit 保持固定。检查不捕获、不安装、
不发布、不改变 Agent/设备。同版本 integrity 变化视为异常。用户捕获并审核新 release 后，
分别手动更新工作区和 Agent/设备，设备扩权须确认。TP 组装包从所选工作区资源显式重新
发布，不在后台静默重建。

## 不可变 Pi SDK 修订

所有可执行 Agent 均使用 **Pi SDK 0.87.1**。Chat、消息渠道、control、Work 和本地
A2A 统一走固定修订的原生 SDK 入口，不回退直接 Pi CLI、宿主 Agent 循环、Hermes
或 Harness。其他 Pi 版本会被拒绝，不会安装到活跃 Agent 或代替所选版本。
原生扩展预检需要固定隔离镜像 `toolplane-pi-package-capture:0.87.1`。
预检容器只以只读方式挂载暂存的公开辅助脚本，使用独立可写 `/tmp`，不会向只读根文件系统
复制脚本。原生加载器的命名冲突保留类型化 `PI_CAPABILITY_CONFLICT` 分类。
`PI_EXTENSION_LOAD_FAILED` 保留有界的分阶段诊断 cause；先检查实际失败阶段，不要直接归因
于扩展工厂。原生 npm 快照必须匹配执行平台与架构，不能改标签或移植字节冒充兼容。
Control MCP 只创建原生 `pi-sdk` 草稿；创建不等于执行授权，须明确配置、授权并发布不可变修订。

运行时变更流程是 **保存草稿 → Prepare → 审阅 → Apply**：

1. 保存配置只修改草稿，不改变已发布默认修订或任何现有会话。
2. Prepare 在发布事务外完成依赖捕获/构建及原生能力预检。准备结果冻结 digest 镜像、
   Pi 版本、网络/资源限制、可选的校验和验证初始快照、凭据引用、模型与指令、Skill/
   包内容及 MCP/A2A 授权；凭据明文不进入配置。
3. 审阅这份准确的配置及能力/权限变化，Apply 时同时提交预期当前修订 ID。发布重新
   验证权限、产物、源摘要和原生预检，再原子比较并切换默认修订。预期修订已过期或
   校验失败均保持旧默认修订不变，须重新 Prepare 和审阅。
4. 回滚通过 `rollbackAgentRevision(...)` 与预期当前修订 ID，以同一 Agent 的历史
   修订发布一个**新版本**。它会重新校验保留产物和当前权限，不改写历史、不恢复
   已撤销授权、不修改已有会话。保留的历史包固定引用可在卸载/撤回发布后继续使用，
   但危险 release、MCP 或凭据撤销仍会阻止执行。

卸载通过 CAS 产生仅移除该包的新默认修订，准确保留其余已应用字段，不要求无关的已撤销权限
重新变得可发布。该纯收窄操作不授予或执行任何能力、不恢复撤销权限；历史会话仍执行实时权限交集。

不要编辑运行时版本文件、在活跃沙箱安装上游新版本，或通过更新可变模板迁移会话。
新 Conversation、Work 和本地 A2A 会话持久化所选 `agentRevisionId`；已有会话继续
使用自己的修订，并与实时 provider、凭据、包、MCP 和方向性协作权限取交集。固定引用
缺失、不匹配或历史状态未解决时拒绝执行，不能以 Agent 当前配置猜测恢复。

### 单项 Skill 与 MCP 的审阅和应用

单项 Enable 是审阅并发布，不是仅绑定草稿。先选择已有发布修订的原生 Agent，再通过
`previewAgentResourceAction` 审阅完整 Skill 制品，或执行受控 MCP `tools/list` 握手。
未发布目标以 `revisionPreparationRequired` 在探测、授权或安装前拒绝。检查不调用工具、
不挂载 Agent 工作卷，也不要求共享 stdio 进程正在运行。

预览返回绑定用户、工作区、Agent、资源与当前修订的签名 `reviewReceipt`、`sourceChecksum`
及 15 分钟 `expiresAt`；回执本身不是执行授权。MCP 必须明确选择 `allowedToolNames`，
未提交不能推断为全部工具。`enableAgentResourceAction` 校验回执与 `expectedRevisionId`，
重查源/definition/文件/发现回执及实时权限，经原生预检后只将该项已审阅变更加入当前已应用
配置；不发布无关草稿、不改变已有会话固定引用。源变化或审阅过期须重新预览；失败同时回滚
授权和默认修订，成功返回真实新 `revisionId`。

## 原生会话与历史运行时边界

原生宿主在初始化 SDK 会话、发起模型请求前先检查审批 broker 的 readiness。普通会话
仅允许 `/api/v1/agent-runtime/sessions/approvals`，委派任务仅允许
`/api/v1/agent-runtime/a2a/<task-id>/approvals`。两者都保持仅 HTTP(S)、禁止内嵌凭据/
query/fragment、禁止重定向、有界响应及 runtime token 要求。readiness 拒绝会阻止模型
执行，不能因此绕过审批或重放该 turn。

每个会话按其固定环境懒创建独立持久沙箱，不读取 Agent 当前模板。原生 SDK 状态限定于
`/workspace/.toolplane/runtimes/pi-sdk/agents/<agent-id>/`；本地 A2A 使用持久化的
context ID。数据库管理身份、修订/沙箱绑定、任务回执和授权，原生会话文件管理 SDK
对话状态。保留 context 必须重新打开原会话；状态丢失须排查或恢复卷，不能伪造历史
或创建空会话冒充恢复。

同会话串行、原生/session-MCP 租约及原有 Agent/平台并发限制继续生效。停止和取消
停止绑定进程及会话 MCP sidecar，不删除工作卷。本文其他章节的通用 owner、dirty-marker
和恢复规则仍适用。工具副作用或远端回执不确定时保持未知，不得通过重放制造完成结果，
也不承诺远端 exactly-once。
会话或沙箱忙碌时，尚未领取的委派任务保持排队，不执行或重放；只有正常租约重新可用后才继续准入。
不能因共享 deployment 停止就移除已授权的固定 MCP recipe；会话 broker 校验固定镜像／recipe
与实时授权后懒启动隔离 sidecar，不借用共享 deployment 进程。

在自己拥有且空闲的 Pi SDK 会话中发送 `/compact` 或 `/compact <自定义指令>`，
将对同一保留会话执行原生 `session.compact()`。须等待原生命令结果持久化；绑定忙碌时
拒绝另开 writer，失败不回退宿主摘要或 CLI 压缩。压缩须单独验证，下述通信 smoke
不覆盖它。
已认证的会话命令请求生成原生回执 ID；外部 channel transport 送入的命令必须提供稳定消息 ID 去重。

协作使用独立入站/出站权限与明确且有界的目标授权；选择目标不会自动开启任一方向。
工作区/账户范围、实时授权、循环/深度限制、任务租约和审批策略仍然生效。旧
`set-local` / `a2aInternalEnabled` 控制已删除。个人 Bearer 仅用于操作者控制的服务，
不能放入提示词、浏览器代码或交给第三方 Agent。
每条边都按包含远端叶子的最终链深度校验固定／实时策略交集；子 Agent 对远端的较宽策略不能
扩大祖先批准的深度。续接纳入子任务结果前也须校验当前子任务权限；撤销不能让父任务无限等待
已失去授权的子任务。

非 Pi 和未解决固定修订的历史会话只读。旧 Hermes 公开执行、runtime MCP/dashboard、
终端、上传、模型和 profile 端点以 HTTP **410** 退役，不映射到新执行器。保留历史
消息、response 和绑定文件读取，以及真实已绑定操作的取消/排空。旧 `pi-harness`
任务标记仅用于绑定清理，不接受新执行或重放。转换产生须重新授权的全新 Pi 草稿，
不恢复旧运行时状态。
活跃会话终端流每 15 秒重新校验相同的当前认证身份、工作区成员资格、固定修订、沙箱映射
与 bridge；凭据、身份或执行权限撤销会关闭流，已打开连接不代表永久授权。
复用真正运行中的会话也会重验修订、卷和凭据，但不会重启 bridge，也无需关闭活跃终端；
文件或终端访问期间仍禁止会破坏会话的生命周期操作。

### 原生 SDK 验证

使用已批准的隔离 PostgreSQL/Docker 环境及固定捕获镜像，串行运行当前原生宿主、
能力、租约及通信测试：

```sh
pnpm test --no-file-parallelism tests/integration/pi-sdk-host.test.ts tests/integration/pi-sdk-capabilities.test.ts tests/integration/pi-sdk-native-leases.test.ts tests/integration/pi-agent-communication.test.ts
```

不能同时运行另一个共用该数据库的测试进程，也不能用 PGlite 证明独立会话锁生效。
已删除的 Harness host/recovery/binding 测试和 `pi-harness-recovery-check.mjs`
不再是发布检查。单元/解析器结果不能证明真实 provider、Docker 或跨账户验收通过。

### 付费模型通信 smoke

先阅读 `node scripts/pi-agent-communication-smoke.mjs --help`，再提供全部六个必填
环境变量：

| 变量 | 必需范围 |
|---|---|
| `TOOLPLANE_SMOKE_BASE_URL` | `localhost`、`127.0.0.1` 或 `[::1]` 上的隔离本地应用 origin；HTTPS 或回环 HTTP，不含凭据/路径/query/fragment |
| `TOOLPLANE_SMOKE_WORKSPACE_SLUG` | 已授权的可丢弃测试工作区 |
| `TOOLPLANE_SMOKE_AGENT_A_ID` | 已存在且已发布的 `pi-smoke-disposable-*` Pi Agent |
| `TOOLPLANE_SMOKE_AGENT_B_ID` | 另一个已存在且已发布的 `pi-smoke-disposable-*` Pi Agent |
| `TOOLPLANE_SMOKE_PERSONAL_TOKEN` | 获准访问这两个本地 A2A 端点的操作者 token，仅放环境变量 |
| `TOOLPLANE_SMOKE_DATABASE_URL` | 明确指定的本地隔离 PostgreSQL，库名包含 `test`、`acceptance` 或 `disposable` |

两个 Agent 须预先具备活跃的 Pi SDK 0.87.1 已发布修订、固定 digest 环境镜像、可用
真实模型、入站授权和原生 `bash` 权限。A 须同时具备已发布及实时出站权限，并有
明确、有界、仅文本的 A → B 授权。应用/runtime owner 和 Docker 须 ready，不能在
运行中修改配置或授权强行制造通过结果。

获准使用真实 provider 后运行 `node scripts/pi-agent-communication-smoke.mjs`。
显式指定的检查数据库连接强制只读，**不**通过该连接配置 Agent 或修改运行时账本；
已认证应用仍会创建任务，委派原生工具会写入唯一命名的 smoke 文件。带 token 的
请求只发送到所选两个本地 A2A 端点并拒绝重定向，不发到 console BFF 或第三方。

smoke 验证同一消息的幂等准入、一个真实完成的子任务、原生工具结算与文件内容、
彼此隔离且绑定修订的 context 沙箱，再在同一保留 context/session 中创建新任务，
且不再次委派。它只读检查账本绑定的容器与原生会话，并验证已发布默认修订未变。
它不安装依赖、不修改运行时配置、不杀进程、不进行崩溃/重启重放探测，也不要求
交互式杀进程/重启或审批确认。缺前提、任务要求补充输入、超时和未知结果均失败，
不跳过或伪造通过。失败清理仅取消本次提交且仍活跃的回执，无法确认时明确报告；
产物保留供检查。

这是付费模型验收，不是前提检查或崩溃恢复证明。真实 HTTPS 远端、其他账号授权和
`/compact` 须单独验证；`a2a-e2e-preflight.mjs` 仅报告前提。禁止指向生产或普通
共享开发运行时，也不能仅为运行 smoke 修改 owner/recovery ACK、迁移共享库或重启服务。

## 历史 Hermes 附件

保留历史附件元数据、归档和绑定工作区文件。通过会话范围的只读文件端点读取，包括
离线卷读取；查看历史不能启动旧运行时。旧上传/预留执行及其自动 Hermes 清理任务
已删除。不要手工删除预留行，也不能声称升级已清除保留字节。物理销毁由显式授权的
删除生命周期负责，普通停止保留卷。

新 Pi 会话文件及 Workspace/Work 附件使用当前限定范围的文件/附件生命周期，不使用
已删除的 Hermes 配额/预留流程。历史归档导入只向停止状态的存储复制文件。Connector
文件仍位于用户机器。继续监控物理磁盘和文件系统限制；只读保留不等于自动回收。

## 安装与诊断变化

排空后的 dry-run/apply 转换与只读历史保留详见 [Toolkit 受控切换](./TOOLKIT_SYNC.md)。旧 Toolkit bootstrap、同步、可执行安装链接和旧 scoped Token 不再接受。新客户端使用资源中心经审阅的登记；保护一次性配置，泄露后明确撤销登记 Token。

Agent 内容采集见[日志与审计](./OBSERVABILITY.zh-CN.md)。普通诊断不启用内容采集；显式开启后仍有大小限制、审计，最多保留 24 小时。公共 Endpoint 禁止策略不可覆盖。

## 验证边界

`tests/unit/runtime-owner.test.ts` 验证状态机和租约故障路径；`tests/integration/runtime-owner-lease.test.ts` 需要真实独立 PostgreSQL 会话，验证锁争用和连接丢失。`tests/integration/hermes-runtime-mcp.test.ts` 验证端点退役与历史保留，不执行 Hermes。上述原生 SDK 测试分别覆盖宿主/能力/租约边界。`TOOLPLANE_TEST_PGLITE=1` 仅供隔离嵌入式数据库冒烟测试，跳过其不支持的多会话场景，不能在 CI 或生产设置。Docker 生命周期及真实客户端验收需要相应运行环境，不能用解析器或 mock 测试通过替代。
