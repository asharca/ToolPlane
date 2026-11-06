# ToolPlane 错题本

记录开发中真实发生的错误、返工和验证缺口，让后续编码 Agent 不再踩同一个坑。
参考 [Magpie 的 LESSONS.md](https://github.com/yetone/magpie/blob/main/LESSONS.md)，
但只收录 ToolPlane 自己有证据的教训，不照搬其他项目的事故或统计。
这是仓库开发记录，不是产品内 Agent 的用户记忆，也不授予部署、发布或修改生产环境的权限。

## 怎么使用

- **改动前**：阅读本文件，找出与本次任务相关的教训，再读对应源码和文档。
- **纠错后**：用户纠正、修复返工、回归或验证遗漏暴露出可复用教训时，在同一改动中补记；正常完成任务不必凑条目。尚未解决的问题仍需明确报告、按项目现有方式跟踪，不能靠写入错题本冒充修复。
- **记录方式**：一条教训写清规则、错误与原因、下次怎么验证，以及可追溯的 issue、提交、测试或文档链接。没有证据的推测不记成事故；不粘贴凭据、私人会话或原始敏感日志。
- **合并与计数**：相同根因合并到已有条目，追加证据和复现日期。日期指实际确认该类错误的日期，同一天多次只计一次；文档整理、重复阅读和补链接不增加次数。不知道历史日期时明确写未知。
- **提升与瘦身**：同类错误在至少三个不同日期被确认后，把仍适用的规则提升到 [AGENTS.md](AGENTS.md) 或相关子系统文档；本文件仅保留教训标题、证据、日期和规范链接，不复制整套规范。安全要求立即执行，不等待累计三次。过时条目说明失效原因或替代规则。

以下是 2026-10-18 根据仓库现有修复记录整理的初始条目；历史发生日期未逐一核实，
不将整理日期算作复发日期。不配置无人值守扫描或自动修改规范，后续在实际纠错时维护。

## 运行时与发布

### TP-L001：进程活着、版本正确，不代表运行时可用

**已提升规范**：[AGENTS.md 验证要求](AGENTS.md#verification)；升级和接管仍遵循[运行时运维](https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS)。

- **历史证据**：[变更日志](CHANGELOG.md)中的升级判定与排空修复；2026-10-30 修改 Next 配置后旧 owner dirty 标记使 readiness 返回 503，按原域核验并恢复后返回 200。
- **2026-11-01 证据**：源码导出和测试通过，Turbopack instrumentation 模块图仍缺失 A2A 新导出；受控重启后恢复。另一次独立 Node 进程继承失效 `NODE_CHANNEL_FD` / `NODE_CHANNEL_SERIALIZATION_MODE`，完成后 SIGABRT；排除这两个进程私有键后退出 0。
- **2026-11-02 证据**：OMP 真实 Work 首轮以 `Sandbox command failed (2)` 失败，原因是每轮技能目录不匹配 materializer 的安全白名单；随后真实 CLI 启动又发现 `find` 不属于当前可用内置工具。配置/类型测试无法覆盖这两步。Webpack 冷启动还将 early-return 后的 Node 动态导入纳入 Edge bundle；改为正分支保护后 readiness 200。依据：[沙箱执行器](src/lib/agents/sandbox-runtime.ts)、[运行时工具清单](src/lib/agents/runtime-kind.ts)、[instrumentation](src/instrumentation.ts)。
- **同日 UI 验收补充**：开发实例遗漏磁盘上已存在的 Work UI 路由，独立 typegen 和生产构建均能识别；完整构建返回 200 后，真实 ask → 浏览器回复 → todo 完成闭环通过。切换本地生产模式还暴露 `.env` 的公开地址端口与验收监听端口不同；仅为验收进程明确设置 `TOOLPLANE_RUNTIME_ORIGIN` 后回调恢复。下次除 readiness 外，还须核对沙箱实际回调地址及带认证的 UI 路由，并完成一次真实交互，不能用构建通过代替验收。
- **同日原生子任务补充**：固定 OMP 18.14.0 实测暴露 `pi.typebox` 是含 `Type` 的模块、task 的 `tools` 指父 eval 工具而非内置工具白名单、batch `context` 不能为空，以及子代理发现使用私有 HOME 下的 `.omp/agent`。仅测转换函数未覆盖这些 ABI。下次先用固定二进制完成扩展启动与真实子任务，再验收问答回传；同步迁移技能落盘路径和 materializer 白名单。普通子任务的 todo 被上游主动移除，不能以模拟实现冒充原生支持。依据：[原生宿主](scripts/omp-session.mjs)、[可信策略](scripts/omp-policy.mjs)、[任务输入边界回归](tests/unit/omp-capability-runtime.test.ts)。
- **2026-11-03 导入验收补充**：模拟外部边界的导入测试通过后，真实 OMP loader 依次暴露 tmpfs 默认 `noexec` 无法映射原生 addon、离线启动仍需要 `auth: none` 的模型描述、RPC 真实命令为 `get_available_commands` 而非 `get_commands`。固定二进制的无网络、无凭据隔离启动修正后，实际加载两个导入包与一个技能成功。真实 MCP 目录发现也成功，但 Docker `--rm` 与显式删除竞态抛出 `removal ... is already in progress`，使预览失败并遗留临时记录；清理须在同一总截止时间内确认删除完成，不能吞错或仅等待进程退出。下次同时验证真实加载器、工具发现和预览资源回收，而不只看模拟的提交成功。依据：[原生预检](scripts/omp-preflight.mjs)、[预检隔离环境](src/lib/agents/omp-preflight.ts)、[容器删除](src/lib/process/deployment-runtime-container.ts)、[生命周期回归](tests/unit/deployment-runtime-container.test.ts)。
- **2026-11-03 用户反馈后的过程验收**：最终回复成功没有覆盖三种进行中故障：Work 每五秒刷新使翻译函数身份变化，子智能体 effect 将其当请求依赖，列表在 994px 与 72px 间跳变；运行态活动被 208px 窗口裁剪，展开还会触发自动滚到底；Pi 宿主发扁平 text_delta 而消费方仅识别 message_update，真正增量被丢弃，结束补发掩盖问题。修复后两轮后台刷新无额外子智能体请求、列表高度稳定；真实 Pi Work 在结束前收到多个正文增量；移动端工具结果可滚到尾标记。下次必须验收后台刷新、运行中展开和终态前增量，而非仅截图最终回复；驻留宿主协议更新还须触发安全重载。依据：[配置加载](src/components/dashboard/agents/SubagentResources.tsx)、[活动容器](src/components/dashboard/ConversationMessage.tsx)、[会话滚动](src/components/agents/message-scroller.tsx)、[Pi 宿主](scripts/pi-sdk-session.mjs)、[真实宿主回归](tests/integration/pi-sdk-host.test.ts)。
- **2026-11-04 本地替换补充**：前一轮直接调用 Next CLI 的实例退出后，受管启动器检测到 dirty 标记并拒绝接管。确认旧 PID 已退出、没有活动 Work／助手 Run 或相关 Docker exec/cp 后，按运维流程使用日志给出的准确 ACK 单次恢复，readiness 返回 200。后续本地生产验收也必须通过 `pnpm start`／`scripts/start-server.cjs`，不能用 Next 的 Ready 日志代替受管停机和运行时就绪。
- **同日导航轨道补充**：用户指出轨道出现后正文被挤压、与输入栏错位。原因是已绝对定位的 PreviewRail 又触发消息视口单侧 `pr-10`，输入栏没有同等占位。移除此应用层动态占位后，真实浏览器中轨道显隐均不改变消息列和输入栏的左右边界；1280px 与 390px 视口、长消息导航跳转均已检查。下次验证轨道出现前后的共同列宽与中心线，而不只看一张有轨道的截图。依据：[消息滚动容器](src/components/agents/message-scroller.tsx)、[输入栏](src/components/dashboard/ConversationComposer.tsx)。
- **同日终端刷新补充（用户反馈）**：Work 后台刷新改变翻译函数及输入回调身份，`SandboxConsole` 的 effect 清理直接 DELETE 当前 PTY，再创建新 shell。终端初始化改用 `useEffectEvent`，仅由资源身份、面板和运行状态或显式重连控制生命周期；创建晚返回时按自身 session ID 回收，不覆盖新终端。真实浏览器连续四轮后台刷新后，shell PID、环境变量、当前目录与未提交命令保留；真实延迟创建与手动重连验证旧 PTY 被回收且新 shell 可交互。下次除观察连接状态，还须检查后台刷新期间的 PTY 创建／删除及真实 shell 状态。规范：[沙箱终端生命周期](https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/SANDBOXES#智能体共享沙箱与会话目录)；实现：[SandboxConsole](src/components/dashboard/sandboxes/SandboxConsole.tsx)。
- **同日发布前迁移验收**：全新数据库连续部署时，相邻 MCP 迁移在同一连接重复 `CREATE FUNCTION pg_temp.mcp_catalog_names`；后一个迁移改为 `CREATE OR REPLACE FUNCTION`。隔离空库的完整 `prisma migrate deploy` 退出 0 后删除验收库。已有开发库上分次迁移成功不能替代发布前同连接的完整迁移链验证。依据：[目录跟随迁移](prisma/migrations/20261101010000_mcp_bindings_follow_catalog/migration.sql)。
- **同日完整 CI 补充**：迁移解锁后，核心套件发现 14 个失败：资源授权测试向按钮而非选择框原生表单值发送 change，旧 SSH 文件注册表夹具调用已退役入口，OMP 包禁止断言和 MCP 清理调用次数断言仍绑定旧实现。修正真实表单值交互，移除失效契约／调用形状断言，不放宽运行时授权。修正后的四个文件共 106 项测试分别通过（95＋11）；发布仍须等待完整 CI，不能用局部测试或预推送类型检查替代。
- **同日合并后重跑补充**：PR 全套通过后，main 的后台聊天测试读出 `succeeded` 在 `tool_calling` 之前；测试查询没有 `orderBy`，而真实订阅按 `sequence` 升序。测试改用同一持久序号排序，不修改运行时事件和状态机。数据库无显式排序不保证插入顺序；不能依赖本机或某次 CI 的行返回顺序。依据：[后台执行测试](tests/integration/chat-background.test.ts)、[事件订阅](src/lib/chat/run-control.ts)。
- **同日生产升级演练补充**：旧库多个会话共用一个 AgentRuntime 沙箱，Hermes 退休迁移先回填 Conversation.sandboxId，但其唯一索引直到后续共享沙箱迁移才删除，恢复库实测触发 `Conversation_sandboxId_key` 冲突。把索引解除提前到回填之前，后续删除改为幂等；同一备份重建后，正式镜像加只读修正迁移的完整 27 项升级成功。空库迁移通过不能覆盖真实旧库的数据分布，切换前须从生产备份恢复并验证完整待执行链。
- **同日生产 Pi 迁移补充**：容器内原生预检把私有 `/tmp` 暂存目录交给宿主 Docker daemon bind mount，真实发布报 `PI_CAPABILITY_PREFLIGHT_FAILED` / `bind source path does not exist`；readiness 当时仍为 200。部署增加同绝对路径的专用 `TMPDIR` 挂载并受控重建后，17 个新 Pi 修订均完成真实预检与发布。下次容器化验收须覆盖准备／应用修订，不能只验应用启动。规范：[运行时运维](https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS)；实现：[原生预检](src/lib/agents/sandbox-runtime.ts)。
- **SDK 导出补充（2026-11-05，线上保存失败）**：共享 `TMPDIR` 不能让应用私有 `/app/scripts/pi-sdk-install.mjs` 在 daemon 宿主出现。固定 SDK 镜像改由 stdin 接收应用读取的可信源码，保留禁网、只读根和降权。真实生产容器设置保存越过导出并成功发布修订；下次必须用脚本仅存在于应用容器内、无现成 SDK 缓存的部署路径验证，不能以宿主进程成功导出代替。
- **发布等待补充（2026-11-04，用户催查）**：`v0.33.3` 发布作业时间戳显示 15:52:16 UTC 已完成、耗时 9 分 39 秒，但 `gh run watch` 的返回累计约 33 分钟，期间仍沿用等待状态，延误线上切换。不能把监视命令尚未返回等同于远端仍在构建；用户报告等待异常时，用 `gh run view --json status,conclusion,jobs` 与 Release／镜像可用性独立核对，再报告实际阻塞点。最终按固定镜像摘要受控重建，核对容器版本 `0.33.3`、新启动时间及公网 readiness，不以 Release 存在代替部署成功。
- **本地 :3000 复发（2026-11-05，用户报告 `did not complete (4)`）**：受管启动的 `:3000` 实例未设 `TOOLPLANE_RUNTIME_ORIGIN`，回落到 `.env` 的 `NEXT_PUBLIC_APP_URL`（`:3007`），沙箱模型请求被拒；`nativeFailure` 只给出 `PI_EXECUTION_FAILED`，需从宿主配置的 `baseUrl` 与沙箱内实测连通性定位。重启时继承的 shell 环境还指向另一套 smoke 库和已被占用的 Connector 端口，首次重启 readiness 503；移除这些覆盖、仅追加运行时 Origin 后为 200。修复 Origin 后又暴露上游网关对该 provider 密钥全部模型返回 503，属外部故障。下次本地启动后，从沙箱内实测运行时 Origin，并用一次真实 Work 的原生 `bash` 结果验收，不以 readiness 代替。
- **捕获镜像补充（2026-11-05，线上私有插件同步失败）**：应用更新后发送含 `allowHttp` 的捕获配置，daemon 上仍是只接受 `authentication,registry,type` 的旧 `toolplane-pi-package-capture:0.87.1`；来源已解析固定 GitHub 提交，捕获阶段却报 `package_capture_failed`，页面仅显示 `registry_sync_failed`。SDK 版本标签相同不代表可信脚本和宿主协议相同。按 Dockerfile 的 `pi-package-capture` target 重建独立镜像后，禁网、只读根、非 root 的真实提示词包捕获返回完整快照且校验和一致。下次更新捕获协议或可信脚本时同步构建辅助镜像，并在应用实际连接的 Docker daemon 上完成真实包捕获和来源同步，不能仅验应用 readiness；重试前检查来源租约，避免覆盖用户已启动的同步。
- **捕获修复验收**：重建镜像摘要为 `sha256:9e0f2dab851e85dffa2ae5bb9224d7f706786eec27c86f659224247e28b94242`；既有来源同步任务 `cmw3dqkde00f401o3b6kxvhtk` 随后对固定提交 `34dcae67c6ef3ffda05e925d3406503695a6a52b` 返回 `succeeded`，来源状态 `synced`，索引资源 1 个，无错误。受保护的人工入队未匹配正在同步的来源，未新增重复任务。
- **提交详情大小补充（2026-11-05，同一私有来源再次失败）**：`resolveCommit()` 请求完整提交详情，却以 256 KiB 限制响应；真实 GitHub 返回 209 个变更文件、307116 字节，导致尚未解析 SHA 就报 `github_response_too_large`。按用户要求仅取消此请求的响应大小限制，保留其他资源限额和鉴权；17 MiB 提交详情回归及来源边界共 34 项通过。受控替换生产镜像后，任务 `commit-repair-935faee9-e7ed-4d46-bf61-aa6e4d9ac1e3` 对提交 `54403f29c85478a9ab44a311a4be066f8eeca3d2` 同步成功，来源 `synced`，活动资源 3 个。下次同步验收须覆盖包含大量文件变更的提交，而不只验证小响应或首次同步。
- **模型重试接线补充（2026-11-05，线上 `empty_stream` 后新增重试）**：首版把工作区重试次数接在 `sandbox-turn.ts`，宿主回归测试全部通过，但真实 Work 走 A2A `pi-executor` → `task-options` → `runSandboxAgentTurn`，绕过了该入口，伪网关只收到一次请求。改为在 `runNativeSessionExec` 组装每轮 context 时读取工作区设置，真实 Work 观察到一次空流后重试成功，以及重试 2 次后报 `EMPTY_STREAM RETRIED_2`。另外 Pi 的会话初始化会从存储重算 settings，在 `refreshContext` 里应用的覆盖会丢失，须在会话就绪后应用。下次给每轮执行加设置时，接到所有入口共用的宿主调用处，并用一个可控上游跑真实 Work，数实际请求次数。
- **本地重建迁移遗漏（2026-11-05，用户反馈 Work 页面报错）**：替换 `toolplane-3000` 时复制旧容器的 `Entrypoint=[node]` 与启动命令，绕过镜像的 `docker-entrypoint.sh`；首页及 readiness 均为 200，登录后的 `/app/smoke/work` 却因 `Agent.monthlyBudgetMicros` 缺失报 P2022。核实本地目标库并备份、受控停止应用后，恢复镜像默认入口，成功应用唯一待执行的 `20261105030000_agent_triggers_usage`；smoke 账户实际登录后的 Work 页面 HTTP 200，列表和输入区可见。下次保留部署环境和挂载不等于盲目复制入口覆盖；替换前检查 `prisma migrate status`，并验收带认证的实际业务路由。依据：[镜像入口](docker-entrypoint.sh)、[字段迁移](prisma/migrations/20261105030000_agent_triggers_usage/migration.sql)。
- **本地 :3000 预检复发（2026-11-06，用户报告创建智能体 `PI_CAPABILITY_PREFLIGHT_FAILED`）**：前一日重建 `toolplane-3000` 时沿用旧容器的环境和挂载，仍缺上文“生产 Pi 迁移补充”要求的同绝对路径 `TMPDIR` 挂载；容器内 `docker create --mount type=bind,source=/tmp/...` 实测返回 `bind source path does not exist`，readiness 仍为 200。确认无活动 Work／助手 Run 后受控停止，保留旧容器为 `toolplane-3000-pre-tmpdir-20261106`，以相同镜像、入口、环境追加 `TMPDIR=/home/ashark/Services/toolplane-3000/runtime-tmp` 及同路径 bind 重建；readiness 200，真实浏览器创建无资源及含 MCP＋技能的 Pi 智能体均发布修订 1，新 Work 原生 bash 返回 `TMPDIR_FIX_OK`。下次替换任何容器化实例，除迁移状态和入口外，还须核对 `TMPDIR` 挂载并完成一次真实创建／发布修订。
- **确认日期**：历史日期未知；初始整理于 2026-10-18；2026-10-30、2026-11-01、2026-11-02、2026-11-03、2026-11-04、2026-11-05、2026-11-06 实测确认。

### TP-L002：构建成功，不代表最终镜像里的原生依赖能启动

**规则**：原生依赖的构建环境必须与最终运行环境的系统 ABI 对齐，验证最终产物而非仅验证构建阶段。

- **错误与原因**：Docker 构建阶段与运行阶段的 OpenSSL 不一致，会打包 OpenSSL 1.1 的 Prisma 引擎，而运行环境需要 OpenSSL 3，导致启动时尝试额外下载引擎。
- **下次怎么验证**：保持构建和运行阶段共享 `python-runtime-base`；在禁止外网的隔离备份数据库环境中，用最终镜像执行 `prisma migrate deploy`。不能用构建成功替代这个检查，也不能直接拿生产数据库试验。
- **证据**：[运行维护文档中的 Docker/OpenSSL 修复与验收要求](https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS#user-content-升级顺序)。
- **确认日期**：历史日期未知；初始整理于 2026-10-18，未统计复发次数。

## 开发工具与验证

### TP-L003：检查暂存文件，也要使用暂存版本的项目上下文

**规则**：提交检查针对完整的暂存快照运行，不混入工作区尚未暂存的配置或依赖声明，不改写用户的部分暂存内容。

- **错误与原因**：只抽取待提交源码、遗漏 `package.json` 等上下文，会让 Biome 丢失 React/Next 规则或误报有效的局部例外；读取工作区配置又会验证一个并未提交的组合。
- **下次怎么验证**：在隔离临时仓库中检查部分暂存场景，让源码、配置和依赖声明的暂存版与工作区版不同；确认检查结果由索引内容决定，检查前后索引及工作区内容均未被改写。
- **证据**：[Unreleased 修复记录](CHANGELOG.md#unreleased)中的暂存快照上下文修复；[check-staged.mjs](scripts/check-staged.mjs)从索引提取源码及 `biome.json`、`.gitignore`、`package.json`，在临时目录执行检查并清理。
- **确认日期**：历史日期未知；初始整理于 2026-10-18，未统计复发次数。

### TP-L004：测试保护核心行为，不锁定实现细节或覆盖率数字

**规则**：永久测试以核心用户行为和安全不变量为边界，优先复用真实集成链路；普通页面、样式、文案、种子名称、内部转发和查询形状不建立长期断言。覆盖率仅作诊断，不设全仓百分比门槛。

- **错误与原因**：用户在 2026-10-26 要求收敛到核心功能。清理前单元与集成测试共 561 个文件、约 5.12 MB，业务源码约 6.41 MB；其中大型 mock 测试和种子名称断言随实现调整频繁返工，已有的全仓四项 80% 门槛不能区分这类断言与真正的行为保护。
- **下次怎么验证**：新增永久测试前指出它保护的核心失败后果，并检查集成测试是否已经覆盖；重构应尽量不需要同步改写内部调用快照。CI 运行保留的核心套件，实际执行受影响路径，不以覆盖率或测试数量替代正确性。
- **证据**：清理前的 [sandbox actions 大型 mock 测试](https://github.com/asharca/ToolPlane/blob/8dab4aa09edbf187832c1d2ae7c48ec9d2a36432/tests/unit/sandbox-actions.test.ts)、[种子数据断言](https://github.com/asharca/ToolPlane/blob/8dab4aa09edbf187832c1d2ae7c48ec9d2a36432/tests/unit/smoke-mcp-catalog.test.ts)；现行边界见 [AGENTS.md 的 Verification](AGENTS.md#verification) 与 [README 开发命令](README.md#开发命令)。
- **验证隔离补充（2026-11-01）**：A2A 集成测试与运行中的开发服务共用数据库时，开发 worker 可领取测试任务并创建 Deployment，干扰远端状态与容量断言；Postgres 日志确认 A2AContext 插入与 Deployment 插入形成 Agent／Workspace 锁死锁。串行测试文件不能隔离另一个服务进程；运行任务型集成测试应使用不被开发 worker 连接的独立本地数据库。检查数据库连接目标，并用独立库重跑受影响的 A2A 集成场景。
- **环境传递补充（2026-11-03）**：仅在 Eval 中构造隔离库环境对象、却未传给实际启动测试的 shell，仍会连接开发库；本次中止误启动并按精确 fixture ID 清理残留，随后在独立库通过 102 项集成检查。启动测试的同一进程必须设置并检查实际 `DATABASE_URL` 的主机和库名，不以另一个进程里的变量作为隔离证据。
- **独立 UI 实例补充（2026-11-05）**：临时 Next 启动器曾被继承的 `DATABASE_URL` 覆盖 `.env`，隔离库仍使用了错误数据库的口令；修正后又与已有 Connector broker 共用端口，导致 readiness 返回 503。验证实例须显式确定实际子进程的连接目标及配置优先级，并隔离 HTTP、Connector 与运行时所有权域；`Ready in` 不替代 `/api/v1/readiness`。本次换用干净独立库及独立 broker 端口后 readiness 为 200，再验证真实管理员保存、刷新、审计与恢复默认；未修改线上配置或清除既有实例的 dirty 标记。
- **预检 fixture 补充（2026-11-02）**：`a2a-local.test.ts` 每次 `beforeEach` 为五个 Agent 完整发布修订，反复执行相同 Docker 原生能力预检，导致 24 项在 hook 的 10 秒上限超时。授权数据库用例沿用 `agents-mutations.test.ts` 的真实配置捕获与事务内不可变修订 fixture，不绕过数据库约束；原生发布预检保留在显式发布与运行时验收路径。未提高 timeout，修正后本地委派与历史资源两文件 71 项在 34.47 秒通过。历史 fixture 同时须原子写入子定义与当前版本，固定修订会话须显式标为已解析，不能靠放宽数据库约束让测试通过。
- **Node 版本补充（2026-11-05）**：首次 A2A 文件验收命令实际使用继承 PATH 中的 Node 22.12.0，不符合 `package.json` 的 Node ≥26.12.1 要求，集成 fixture 的 10 秒 hook 超时。显式使用已安装的 Node 26.12.1 后，同一隔离库的五文件 148 项检查通过；未提高超时。下次在启动检查及 UI 的实际子进程中核对 `process.version`／`process.execPath`，并让 pnpm 子命令沿用同一 PATH；不能以另一个终端的版本或工具退出码推断运行环境。依据：[运行时要求](package.json)、[文件存储回归](tests/integration/a2a-files.test.ts)。
- **确认日期**：2026-10-26。

### TP-L005：人工待处理队列上限不能累计计算执行回执

**规则**：队列容量只统计当前租约下未过期、未消费的人工待处理审批；单次执行回执必须保留，但不能把回执历史数量当成工具调用额度。自动授权仍必须执行实时权限、参数绑定、单次消费、存储和截止时间校验。

- **错误与原因**：2026-10-27 只读调查确认，原生工具审批在判断自动授权之前累计统计任务全部回执，导致第 33 个唯一调用被拒绝；已消费和旧租约回执也占用了所谓审批上限。
- **下次怎么验证**：真实审批链路覆盖超过 32 次自动调用及逐次人工批准；验证当前未过期 pending/approved 人工队列仍有界，消费、拒绝、过期与换租约可释放容量，历史不能遮住待处理审批；继续验证重复消费、参数变化和旧租约拒绝。
- **证据**：[审批实现](src/lib/a2a/tool-approvals.ts)、[核心集成回归](tests/integration/a2a-local.test.ts)中的 native tool approval decisions、[队列与回执语义](https://asharca.github.io/toolplane-docs/docs/zh/guides/docs/A2A_INGRESS_APPROVALS#user-content-执行前审批)。本条记录已确认根因，不代表回归检查已执行或生产已部署。
- **确认日期**：2026-10-27。

### TP-L006：插件切换必须保留执行撤销与真实快照路径语义

**规则**：目录撤下与安全撤销必须在已固定版本的执行入口再次校验；索引移除不等同管理员撤下。能力指纹按快照根目录定位 `package.json` 和资源路径，不能用脱离真实目录结构的 fixture 验证版本升级。

- **错误与原因**：2026-10-30 插件中心切换回归中，固定会话绕过目录状态，旧测试仍写入 `disabled`/`rejected`，能力测试把文件放在根目录而不是 `package/`，遮住仅改版本号也触发审核的问题；版本引用触发器还未校验安装记录所属工作区与发布来源。
- **下次怎么验证**：逐文件运行资源路由、版本引用、包绑定与能力指纹测试；覆盖 `withdrawn`/`revoked` 对固定会话拒绝执行、无效安装引用拒绝写入，以及真实 `package/package.json` 仅版本变化无需审核。测试环境需满足 Node 引擎和 disposable 数据库要求，不能把前置条件失败报告为行为通过。
- **Python 缓存污染（2026-11-05）**：线上日报技能导入 `gb_layout` 后，固定快照新增 `__pycache__/gb_layout.cpython-311.pyc`，后续“继续”在准备阶段被完整性校验拒绝。临时副本仅移除该缓存即通过原校验，另两个插件及 SDK 均正常。原生 Pi 宿主须在启动扩展和工具前设置 `PYTHONDONTWRITEBYTECODE=1`，不能忽略快照中的额外文件。验证使用真实 SDK 的 bash 执行 Python import，并重启宿主继续一轮，确认技能目录未新增文件；回归见 `tests/integration/pi-sdk-host.test.ts`。
- **证据**：[执行撤销校验](src/lib/pi-packages/revocation.ts)、[版本引用触发器](prisma/migrations/20261030000000_plugin_center/migration.sql)、[资源路由集成测试](tests/integration/pi-sdk-resource-routing.test.ts)、[版本引用集成测试](tests/integration/capability-client-registration-schema.test.ts)、[能力指纹测试](tests/unit/plugin-capabilities.test.ts)。
- **确认日期**：2026-10-30。

### TP-L007：不可变边界的版本校验必须配套入口解析

**规则**：用户提交浮动包名时，在创建、修改或绑定的授权入口解析并保存精确版本；已有部署也要在捕获定义校验和之前完成解析。网络请求必须在数据库事务之外，会话边界仍拒绝浮动引用。

- **错误与原因**：普通 npm/PyPI MCP 部署保留浮动包名，绑定 Agent 后捕获不可变配方时直接抛出 `MCP_EXACT_PACKAGE_VERSION_REQUIRED`，把内部安全约束暴露给用户，而不是自动解析版本。
- **下次怎么验证**：使用真实绑定集成链路和受控 registry 响应，覆盖浮动 npm 部署自动保存精确版本并继续捕获、registry 失败返回可本地化错误，以及会话边界仍拒绝未固定配方；同时覆盖 npx/uvx/uv 参数保持不变。
- **证据**：[配方解析](src/lib/process/mcp-pinning.ts)、[绑定回归](tests/integration/agent-resource-binding.test.ts)、[配方边界回归](tests/unit/mcp-portable-recipe.test.ts)。
- **确认日期**：2026-10-31（用户报告；具体检查结果以本次交付记录为准）。

### TP-L008：会话修订只能经升级入口前移，非执行字段不能发布修订

**规则**：只有进入执行配置的字段才发布修订；会话固定修订只能通过专用升级服务原地前移到同一 owner 的当前修订（数据库触发器只放行非空到非空的同 owner 变更），其他写入不得改动固定引用。

- **错误与原因**：助手置顶/改名也走发布路径，每次生成内容相同的新修订，旧会话因此显示“已过期”；当时的会话升级接口直接改 `ChatThread.assistantRevisionId`，被旧版 `ChatThread_revision_pin` 触发器拒绝，返回 500，单元测试的 mock 数据库发现不了。之后触发器改为允许同 owner 原地升级（`20261101000000_mcp_tool_selection`）。
- **下次怎么验证**：置顶后确认修订号不变（`tests/unit/chat-assistant-lifecycle.test.ts`）；涉及会话固定引用的写操作，在真实 Postgres 上走一次接口（`tests/integration/chat-background.test.ts`、`tests/integration/agent-conversation-revisions.test.ts`），而不是只跑 mock。
- **证据**：[`updateChatAssistant`](src/lib/chat/service.ts)、[Agent 会话升级](src/lib/agents/conversation-revisions.ts)、[触发器](prisma/migrations/20261101000000_mcp_tool_selection/migration.sql)。
- **入口链路补充（2026-11-03）**：真实 `/chat` 在显式升级后约 153ms 即失败、没有沙箱执行；只读数据库确认 Conversation 已固定新修订，而原 `A2AEntryBinding` 指向的 Context 仍固定旧修订，下一次准入从 Context 继承旧 pin，和已升级的沙箱冲突。升级须原子推进自己绑定的普通入口 Context 与目标指纹，保留历史任务/grant/receipt；同版本显式升级可校准旧不一致。验证应在已有会话升级后真正提交下一轮，并覆盖父任务终态但后代仍在停止时拒绝升级（`tests/integration/a2a-local.test.ts`）。
- **文件边界补充（2026-11-03）**：真实 Work 输入无附件却停在 `file-staging-failed`；只读数据库确认文件数为零、任务与 Context 固定修订 2，而 Agent 默认修订为 5。`listTaskFiles` 的授权先于文件枚举，文件读取器未传入任务及祖先 grant 的修订，按新默认指纹比较而拒绝旧任务。文件列表、读取与暂存必须使用相同固定授权，并继续检查实时撤销；回归同时覆盖无附件 Work、新默认发布后的子文件实际内容，以及父子关系/委派开关撤销（`tests/integration/a2a-local.test.ts`）。
- **双身份绑定补充（2026-11-03）**：真实已有原生历史的 Work 在 UI 暂存成功后模型返回 `403 runtime grant is no longer valid`；只读数据库确认 Conversation 已绑定沙箱，而新任务 Context 的 `sandboxId` 仍为空。沙箱复用分支只返回卷，没有补齐 Context 绑定，任务 UI 的映射查询通过却被模型/MCP 的严格双身份校验拒绝。复用分支须在事务内绑定缺失的一侧并拒绝修订或沙箱冲突；集成验证须调用真实 `resolveAgentRuntimeGrant`，不能只验证 token 可解码、UI 成功或用 fixture 回填掩盖缺口（`tests/integration/a2a-local.test.ts`）。
- **确认日期**：2026-10-31（用户报告）；2026-11-01 改为原地升级（用户要求）。

### TP-L009：运行失败要带原因，零权限授权不能进入执行

**规则**：运行时失败不能只留一个通用错误码；能定位到具体资源时，错误要写明哪个资源、因为哪条固定拒绝码失败，控制台翻译成可操作的提示。不授予任何工具的 MCP 授权不进入会话；MCP 绑定默认开放全部工具，避免出现“已绑定却没有工具”的状态。

- **错误与原因**：智能体在设置里绑定 MCP 后没有开放任何工具，修订中的授权为空；会话启动时 Pi MCP 扩展列工具被拒（`MCP_TOOL_FORBIDDEN`，403），整个会话中止，控制台只显示 `PI_SDK_REQUEST_FAILED` 对应的“Pi SDK 执行失败”，要查容器和数据库才能定位。
- **下次怎么验证**：`tests/integration/pi-sdk-resource-routing.test.ts` 覆盖零工具授权不进入会话；`tests/unit/agent-runtime-proxy.test.ts` 覆盖拒绝响应带 `data.reason`；改动 Pi 扩展源码后，用本地 403 服务直接运行 `piMcpExtensionSource()` 生成的扩展，确认先发出 `toolplane_mcp_unavailable` 事件。
- **证据**：[会话 MCP 过滤](src/lib/agents/pi-session-packages.ts)、[扩展与宿主事件](src/lib/agents/sandbox-runtime.ts)、[运行时路由](src/app/api/v1/agent-runtime/mcp/[deploymentId]/rpc/route.ts)、[错误文案](src/components/dashboard/useRuntimeErrorText.ts)。
- **2026-11-05 复发（用户要求提示更清晰）**：宿主已产生已翻译的 `PI_SDK_MODEL_FAILED`，但 worker 的错误码白名单把它压成 `PI_EXECUTION_FAILED`，`agentEntryResult` 再改写成 `Agent execution did not complete (4)`；`PI_MCP_TOOLS_UNAVAILABLE` 同样被吞。首次修复后真实 Work 仍缺原因：常驻 broker `native-runtime-session.mjs` 会重新序列化宿主响应并丢掉新字段，而直连宿主的测试绕过了它。现由 [`runtime-failure.ts`](src/lib/agents/runtime-failure.ts) 统一“错误码＋白名单原因”（`HTTP_nnn`／`UNREACHABLE`／`TIMEOUT`），broker 源码纳入常驻会话签名。下次改宿主协议字段，须经真实 broker 回归（[`native-runtime-session.test.ts`](tests/integration/native-runtime-session.test.ts)，修复前失败）并在真实 Work 页面核对文案，不能只测宿主进程。
- **任务时限补充（2026-11-05，用户反馈线上频繁超时）**：指定任务从提交到过期一直为 `SUBMITTED`，没有执行或沙箱绑定证据，却只显示 `Task deadline exceeded.`；其他执行中到期又可能被通用 `PI_EXECUTION_FAILED` 覆盖。任务总时限包含排队、准备和执行，必须按最后已记录阶段说明，不能把它直接解释为供应商单次请求或工具自身超时。阶段投影与 UI、终态共用任务锁，保留租约校验和显式取消优先级；列表只投影固定错误码，不带正文。修复前两项真实数据库回归分别缺码、返回泛化错误；修复后相关 131 项通过。独立数据库 HTTP 烟测覆盖排队、准备、等待模型、生成、工具五阶段的持久化和日志列表／详情，并验证未授权返回 401；实际组件在中英文、390px 和桌面浏览器核对文案。下次同时验证阶段不会被 UI 更新、过期或旧租约回调覆盖；旧记录无证据时只说明阶段未知，不推断根因。
- **确认日期**：2026-10-31（用户报告）；2026-11-05（用户报告）。

### TP-L010：工具失败是工具结果，不是整轮失败

**规则**：模型能读到并处理的工具错误（命令非零退出、MCP 工具返回错误）只记录为失败的工具结果，不让整轮失败；整轮失败时也要保存已写入的会话历史，避免下一条消息变成 `PI_SDK_SESSION_MISSING`。

- **错误与原因**：`pi-sdk-session.mjs` 在任一 `tool_execution_end.isError` 时设置 `PI_SDK_TOOL_FAILED`，模型已经正常回答也判整轮失败；失败分支不写状态文件，下一轮因 `historyRequired` 直接报会话丢失。用户看到的是“调用 MCP 老是失败”，实际是 `grep` 没匹配到返回 1 就让任务失败。旧测试把“工具失败即整轮失败”固定成了契约。
- **下次怎么验证**：在 Node 26 下运行 `tests/integration/pi-sdk-host.test.ts`：失败工具后本轮成功且会话已保存；停止后的下一条消息能在同一会话继续。改动失败分支时，先临时去掉修复确认回归测试会失败。
- **证据**：[会话宿主](scripts/pi-sdk-session.mjs)、[宿主集成测试](tests/integration/pi-sdk-host.test.ts)。
- **2026-11-04 首次失败补充（用户反馈）**：首次接纳失败后，Work 保存的 assistant 模型标签、`work-runtime: failed` 和耗时元数据被消息条数及“存在 assistant”双重判定误认为原生历史，下一次显式请求因空 OMP session 继续失败。入口和 Pi／OMP 启动统一使用实质历史判定，仅跳过已知的展示元数据；正文、推理、工具活动、完成记录及未知内容仍保守要求恢复。原失败 Work 真实 bash 返回 `NATIVE_HISTORY_RECOVERED_OK`，同智能体新 Work 首轮真实 bash 返回 `FRESH_NATIVE_OK`。回归：[上下文边界测试](tests/unit/conversation-context.test.ts)；实现：[共享历史判定](src/lib/agents/conversation-context.ts)、[入口参数](src/lib/agents/execution/task-options.ts)、[沙箱宿主配置](src/lib/agents/sandbox-runtime.ts)。
- **确认日期**：2026-10-31、2026-11-04（用户报告）。

### TP-L011：设置放在拥有它的对象上，复用已有控件

**规则**：动手前先确认一个设置归哪个对象管（MCP 部署、Agent 还是会话），并找到界面上已有的对应控件；需求说“在某处选择”时先看那里是否已有入口，不要在另一处另起一套平行设置。

- **错误与原因**：用户要求 MCP 工具默认全选、可指定，实现时在 Agent 设置和助手编辑器里各加了“全部工具 / 指定工具”，并新增 `toolSelection` 字段；而 MCP 工具页已有“工具访问权限”控制所有已连接 Agent 可用的工具，用户随即指出选择应在那里进行，导致字段、界面和测试返工删除。
- **下次怎么验证**：方案阶段列出该设置的现有入口（`grep` 相关字段在页面中的使用，如 `mcpToolExposure`），在回复中说明放在哪里、为何不复用已有入口；不确定时先问。
- **证据**：[工具访问权限编辑器](src/components/dashboard/McpToolExposureEditor.tsx)、[绑定跟随目录](src/lib/process/mcp-grant-sync.ts)、[删除字段的迁移](prisma/migrations/20261101010000_mcp_bindings_follow_catalog/migration.sql)。
- **频道接入补充（2026-11-01）**：微信已经添加并完成配置，仍因独立的 A2A“消息渠道执行身份”开关报 `Authorize a native channel operator in Agent A2A settings first.`；用户明确不需要第二次手动启用。频道添加应绑定当前管理账户，扫码完成应自动启动，而不是耦合 A2A 委派开关。验证须覆盖入站/出站均关闭时的真实频道任务接纳、非管理员不能绑定身份，以及真实页面和 API 创建后的身份持久化；不能把工作区所有者当作未绑定记录的默认身份。证据：[频道管理入口](src/app/api/v1/workspaces/[slug]/agent-channels/route.ts)、[原生入口策略](src/lib/a2a/local-policy.ts)、[频道集成回归](tests/integration/agent-channels.test.ts)。
- **确认日期**：2026-11-01（用户纠正）。

### TP-L012：移动侧栏中的 Portal 要在打开时重测位置

**规则**：浮层依赖触发器的视口坐标时，在打开时重新测量；不能把侧栏挂载或动画期间的坐标永久复用。

- **错误与原因**：系统更新面板桌面实测正常，但在 390px 宽移动侧栏内打开后，左边界为 -196px，裁掉了标题、当前版本及大部分日志；定位 hook 只监听尺寸、滚动和窗口变化，没有随浮层打开重测侧栏动画后的坐标。
- **下次怎么验证**：真实打开移动侧栏，再打开弹层，检查完整标题、两列版本和内容滚动；同时检查弹层视口边界，而不是只检查 DOM 文本存在。本次修复后左边界 14px、右边界 388px，390px 视口内完整可读。
- **证据**：[Popover 打开测量](src/components/motion/popover.tsx)、[定位 hook](src/components/motion/popover-position.ts)、[系统更新面板](src/components/dashboard/SystemUpdateButton.tsx)；本次实际浏览器截图与视口边界检查。
- **确认日期**：2026-11-01。

### TP-L013：新增翻译必须同时验证新页面和已打开页面

**规则**：修改 locale JSON 后，不只看磁盘键值和新开页面；同时检查已打开页面在热更新后收到的消息及浏览器错误。不要用硬编码文案或吞掉 `MISSING_MESSAGE` 代替修正消息来源。

- **错误与原因**：系统更新新增版本、Changelog 翻译后，新开浏览器页面实测正常，但用户已打开的页面继续报告这些键缺失；此前交付只验证了新页截图，没有覆盖长驻布局中的旧消息快照。此次检查确认 `src/i18n/request.ts` 使用的两份 JSON 均已有这些键，新的页面响应和实际中英文页面均包含正确翻译，无需重复添加键或改写加载器。
- **下次怎么验证**：保留一个修改前已打开的页面，更新翻译后检查 console 和实际文案；若旧页消息未更新，执行整页刷新后再核验。不能为了修复旧客户端快照而盲目重启 runtime owner。
- **证据**：[消息加载入口](src/i18n/request.ts)、[长驻工作区布局](src/app/app/[workspace]/layout.tsx)、[系统更新面板](src/components/dashboard/SystemUpdateButton.tsx)；2026-11-01 用户报告及本次真实中英文浏览器 console 检查。
- **确认日期**：2026-11-01（用户报告）。

### TP-L014：运行时工具必须穿过真实协议协商与会话审批验收

**规则**：生成的 MCP 客户端用官方 SDK 的真实 StreamableHTTP 服务验证发现及调用；会话审批复用现有 origin 策略，并在当前实际服务地址完成浏览器决策，不能只看 mock 返回或待审批卡片。

- **错误与原因**：客户端仅声明 `Accept: application/json` 时，官方传输在工具发现阶段返回 HTTP 406，普通 Agent 执行还未调用工具就失败；只发送频道接收回执会掩盖这个失败。新增会话审批入口另按配置端口比较 Origin，本地配置为 `:3007`、实际服务为 `:3000` 时，同源浏览器点击也被 403 拒绝，遗漏了已有 `originFromRequest` 的本地端口策略。
- **下次怎么验证**：真实传输先证明旧 JSON-only 请求为 406，再通过生成的客户端完成工具发现及一次调用；请求必须声明 JSON 和 SSE。真实浏览器在实际服务地址完成一次批准或拒绝，核对保存结果；保留非法 Origin、显式 Authorization、其他操作人和错配会话的拒绝用例。频道正常结果、人工审批通知与安全失败回传分别验证，不把接收回执视为完成证明。
- **证据**：[原生 MCP 客户端](src/lib/agents/sandbox-runtime.ts)、[官方 SDK 宿主回归](tests/integration/pi-sdk-host.test.ts)、[会话审批入口](src/lib/agents/execution/conversation-http.ts)、[频道权限与持久化回归](tests/integration/agent-channels.test.ts)。2026-11-01 独立 smoke 实测旧请求 406，修复后发现成功、算术工具返回 `42` 且只执行一次；浏览器在 `:3000` 的拒绝决策持久化为 `denied`，390px 页面无横向溢出。
- **沙箱管理补充（2026-11-01）**：`sandboxManagementUser` 用配置的公开 Origin（`:3007`）比较 Cookie 请求，实际服务在 `:3000` 时 SSH 创建和 MCP 导出令牌管理对同源浏览器一律返回“工作区不存在”。改为复用 `isSameOriginRequest`；同日确认，不增加计数。验证：在实际服务地址用浏览器会话调用一次变更接口，而不是只用 Bearer 或 mock。证据：[管理入口](src/lib/sandboxes/mcp-management.ts)、[OAuth 集成回归](tests/integration/sandbox-mcp-oauth.test.ts)。
- **频道消息 ID 补充（2026-11-05，用户报告 Discord 无法回应）**：线上 Discord 频道每条普通消息都回复“本次执行未能完成”，日志只有 `Channel execution was rejected.`，且该连接从未创建会话。原因是 Discord、Telegram、Slack 适配器发出的入站事件缺少 `messageId`，`runLoadedAgentMessage` 按原生去重要求返回 400；频道集成测试直接构造带 `messageId` 的请求并 mock 了 `channel-runtime`，绕过了适配器。三个适配器改为携带平台消息 ID（Discord 消息/交互 ID、Telegram `message_id`、Slack `ts`／斜杠命令 envelope），拒绝日志附带状态码与固定错误文本。下次新增或修改频道适配器，须从适配器入站处理（[消息 ID 回归](tests/unit/channel-adapter-message-ids.test.ts)，修复前三项失败）驱动到 `runAgentChannelMessage` 的接纳条件，不能只用手工构造的请求体验收。
- **确认日期**：2026-11-01；2026-11-05（用户报告）。

### TP-L015：嵌套浮层的 Escape 必须止于当前层

**规则**：下拉框通过 Portal 出现在弹窗中时，当前浮层处理 Escape 后必须停止事件冒泡，并恢复触发按钮焦点；不能只调用 `preventDefault()`，也不能只验证浮层从 DOM 消失。

- **错误与原因**：全站下拉重做后的 390px 浏览器验收发现，模型搜索输入按 Escape 会连同智能体创建弹窗一起关闭；旧处理仅阻止默认行为，按键继续到达外层弹窗的全局监听。即时检查还可能把正在退出的弹窗误判为仍然打开。
- **下次怎么验证**：实际打开创建弹窗及模型下拉，按 Escape 后等待焦点返回模型按钮，确认下拉关闭而创建表单仍可操作；同时验证搜索、方向键及 Enter 选择。检查浮层内其他可聚焦控件的 Escape，而不只检查搜索输入。
- **证据**：[模型选择器的根级按键处理](src/components/dashboard/models/ModelPicker.tsx)。本次真实移动浏览器已确认 Escape 后按钮重新获得焦点、创建表单保留，并通过搜索与键盘选择更新未提交的模型字段。
- **侧栏补充（2026-11-05）**：资源菜单通过 Portal 冒泡的 Escape 会到达移动侧栏的关闭处理；菜单关闭后的无条件异步 focus 还可能抢走新确认弹窗焦点并滚回原行。菜单边界消费 Escape，仅在菜单自身持有焦点时同步恢复原行且 `preventScroll`。390px 实测菜单关闭后侧栏和分组仍展开。依据：[资源菜单事件与焦点边界](src/components/agents/ai-sidebar.tsx)。
- **确认日期**：2026-11-01。

### TP-L016：不同日志页签不能复用上一种数据的组件状态

**规则**：同一个客户端组件按页签渲染不同数据结构时，组件身份必须包含日志类型；涉及工作区切换时同时包含工作区身份。不能依赖 `useEffect` 在渲染后清空旧结果，也不能给必需字段加空值兜底掩盖类型混用。

- **错误与原因**：用户报告 A2A 日志页报错。浏览器实测从已有 MCP 记录的页签切到 A2A，`LogExplorer` 仍持有 MCP 列表，`A2ATaskTable` 读取不存在的 `taskId` 并调用 `slice`，触发页面错误边界。直接打开 A2A 页正常；此前逐页直达验证遗漏了真实客户端切换。
- **下次怎么验证**：使用真实非空数据，点击 MCP、智能体工具、内部调用、A2A 页签往返，等待列表加载完成并检查记录类型及浏览器异常；不能只用整页导航验证。管理后台也使用相同查看器，应检查两个入口。
- **证据**：[工作区查看器身份](src/app/app/[workspace]/observability/page.tsx)、[管理后台查看器身份](src/app/admin/logs/page.tsx)、[旧数据读取处](src/components/observability/A2ATaskTable.tsx)。本次浏览器已复现修复前的 `Cannot read properties of undefined (reading 'slice')`，修复后工作区四类页签往返成功，A2A 方向筛选正常提交。
- **确认日期**：2026-11-01（用户报告）。

### TP-L017：沙箱工具目录不能走部署目录持久化

**规则**：列出沙箱运行时（`source=sandbox`）工具时，使用 `listMcpTools(..., { persistCatalog: false })`；沙箱目录是固定运行时代码，不写入部署配置。工具发现要经真实运行中的沙箱和实际 HTTP 入口验证，不能只看 mock。

- **错误与原因**：`persistDeploymentMcpToolCatalog` 对 `source=sandbox` 直接返回空数组，`listMcpTools` 默认走持久化，导致外挂沙箱运行时入口和 MCP 导出网关列出零个工具，但 `tools/call` 照常可用。mock 单元测试全部通过；真实会话中模型看不到工具，转而用 curl 直接调用运行时入口。
- **下次怎么验证**：启动一个真实 Docker 沙箱，用会话运行时令牌请求 `/api/v1/agent-runtime/sandboxes/{id}/rpc` 的 `tools/list`，核对按访问级别返回的工具名；再跑一轮真实会话，确认日志 `sandbox.tool` 记录了外挂沙箱的 `deploymentId`。
- **证据**：[共享分发](src/lib/sandboxes/tool-dispatch.ts)、[目录持久化](src/lib/process/mcp-tool-catalog-store.ts)、[运行时入口](src/app/api/v1/agent-runtime/sandboxes/[sandboxId]/rpc/route.ts)。2026-11-01 实测修复前 `tools/list` 为空、`tools/call` 成功，修复后完整权限返回 8 个工具、只读返回 4 个且 `shell_exec` 被拒。
- **确认日期**：2026-11-01。

### TP-L018：澄清选项要按用户看到的操作描述，推荐项要贴合原话

**规则**：向用户确认需求时，选项写成用户在界面上会做什么（如“在界面填写服务器地址和私钥”），不要只用内部机制名（如“管理员授权目标”）；推荐项应贴合用户原话，而不是改动最小或现有实现。

- **错误与原因**：用户要求“沙箱可以 ssh”，我把“沿用管理员授权的 SSH 目标（`TOOLPLANE_SSH_TARGETS_FILE`）”列为推荐项，用户按推荐选择后才发现本意是“有 SSH 服务器就直接在界面添加”，导致创建入口、凭据存储、运行时和文档返工。
- **下次怎么验证**：发出澄清前，逐项检查选项描述能否被不了解代码的用户读懂，并说明各选项下用户实际怎么操作；推荐理由不能只是“改动小/安全面小”，要与原话逐字对照。
- **证据**：[SSH 服务器入口](src/lib/sandboxes/ssh-management.ts)、[凭据与网络策略](src/lib/sandboxes/ssh-servers.ts)、[网络策略回归](tests/integration/ssh-server-policy.test.ts)。
- **确认日期**：2026-11-01（用户纠正）。

### TP-L019：JSONB 幂等校验不能依赖对象键顺序

**规则**：比较数据库往返后的结构化请求时，按结构和值比较；数组顺序保留，对象键顺序不能作为请求身份。必须在真实 Postgres 上覆盖重复请求和同 ID 修改内容两种情况。

- **错误与原因**：原生 Pi UI 用 `JSON.stringify` 比较持久请求与重发请求，Postgres JSONB 重排对象键后，相同 dialog 被误判为 ID 复用。`a2a-local.test.ts` 的取消后重发回归实际失败；改为 `isDeepStrictEqual` 后通过，修改标题仍被拒绝。
- **下次怎么验证**：运行 `native Pi UI projections` 集成组，覆盖写库、读取、原请求重发返回取消，以及同 ID 改内容拒绝；不能用保持插入顺序的内存 mock 代替。
- **证据**：[原生 UI 投影](src/lib/agents/execution/native-ui.ts)、[数据库边界回归](tests/integration/a2a-local.test.ts)。
- **确认日期**：2026-11-02。

### TP-L020：原生运行时接入不应建立第二套资源配置入口

**规则**：普通创建保持 Pi 优先，接入运行时时复用平台已有 Skill、MCP、插件和平台 Agent 的资源管理、绑定和授权；不把本机配置上传或独立子定义管理作为用户必经入口。用户明确要求可选迁移时，导入只负责转换到这些既有资源及固定修订，不另建一套长期资源库，也不将 OMP 专属语义静默改成 Pi。

- **错误与原因**：OMP 接入增加了“OMP 配置”导入页与创建/发布导入链路，将用户要求的直接对接平台资源错误实现为另一套配置迁移入口；用户明确纠正。
- **同日子智能体纠正**：用户要求恢复勾选平台已有 Agent；此前将子智能体替换为独立定义/版本管理，是同一类错误：把运行时内部机制误当作平台产品模型。随后用户明确选择两种互斥模式：平台 Agent 绑定沿用本地 A2A 与子 Agent 自身授权；OMP 原生模式按任务动态生成会话内角色，不恢复手工定义库。不能将平台 Agent 复制成 OMP 进程内定义。
- **下次怎么验证**：从普通创建和 Agent 设置实际选择平台技能、MCP、插件，确认新会话使用绑定的冻结资源；按最新用户决定验证原生子任务与平台委派可共存且原生无需预注册定义，旧会话不受草稿切换影响。可选导入另验导出、兼容性预览、明确排除、MCP 检查授权及最终确认；必须证明所选资源真正加载并执行，不能只证明配置可解析或 Agent 已创建。
- **证据**：[创建界面](src/components/dashboard/agents/AgentsBrowser.tsx)、[设置界面](src/components/dashboard/agents/AgentSettingsForm.tsx)、[运行时资源适配](src/lib/agents/sandbox-runtime.ts)。此前移除独立配置导入产品入口，保留内部历史快照与追加指令编辑。
- **当时验证**：OMP 创建流程直接显示平台 MCP/技能选择；桌面和移动端高级设置均无独立配置入口，插件勾选可用；当时删除的导入/预览 API 实际返回 404。资源授权与固定历史回归共 48 项通过。这不是禁止后续明确请求的可选迁移入口。
- **2026-11-02 后续（用户决定）**：用户在评审子智能体体验后明确放开互斥，平台 Agent 与 OMP 原生子任务可同时启用；仍不恢复手工定义库，也不把平台 Agent 复制成 OMP 进程内定义。修订字段 `subagentMode: "native"` 现表示启用原生子任务。依据：[子智能体设置](src/lib/agents/platform-subagents.ts)、[修订约束](src/lib/agents/revision-types.ts)、[约束迁移](prisma/migrations/20261102040000_agent_subagent_modes_coexist/migration.sql)。
- **2026-11-03 后续（用户决定）**：用户要求保留 Pi 为主，同时支持导入已有 OMP 配置、技能、MCP 和插件。普通创建无需本机配置；可选导入默认保留 OMP，迁移 Pi 必须显式选择并暴露不兼容项。模型和凭据映射到平台授权资源，原生角色作为私有包内容，不创建另一套平台子定义库。
- **2026-11-05 后续（用户决定）**：用户明确要求退役 OMP；可执行运行时收敛为 Pi，OMP 历史只读，配置导入仅迁往 Pi。保留历史身份与固定快照，不将原生 task、角色模型、hook 或 eval 静默解释为 Pi 能力；不兼容项须明确处理。此前“导入默认保留 OMP”和双原生执行支持不再适用。
- **同日验收补充**：执行 API 已拒绝 OMP，但 Work 侧栏仍用“可展示历史”的运行时集合计算 `supportsWork`，误显示“新建工作”和“尚未配置”。可展示历史不等于可执行；实际页面须同时检查历史消息、侧栏创建入口和设置提示，不能只验证主输入框及 HTTP 410。修正位于 [Work 页面](src/app/app/[workspace]/work/page.tsx)。
- **同日导出实测补充**：真实本机目录中的 AppleDouble 元数据和 `config.yml.backup-20261003` 被误列为阻塞项；应不读取这些私有非执行状态、报告警告，而不是阻止有效配置迁移。无法打包的原生资源仍保留可明确排除的阻塞条目，不能让 issue 引用的资源在界面上消失。依据：[离线导出器](scripts/export-omp-config.mjs)、[导出边界回归](tests/unit/export-omp-config.test.ts)。
- **确认日期**：2026-11-02、2026-11-03（用户纠正及真实导出）。

### TP-L021：多阶段审核表单不能让 React 自动重置选择器

**规则**：保存草稿后还需审核、应用的受控表单，沿用显式 `onSubmit`、`preventDefault()` 与 `new FormData()` 的提交方式，避免 React 19 的函数 `action` 完成后自动重置表单，触发第三方选择器的 reset 回调。

- **错误与原因**：双模式子智能体在实际 `:3000` 页面保存原生并发 2、深度 1 后，PUT 已正确持久化，界面却回退到深度 3、重新标脏且审核区消失。React 自动 reset 触发 Radix Select 的初始值回调；该回调不检查 `defaultPrevented`，仅拦截 `onReset` 不能解决。
- **下次怎么验证**：实际改动非默认下拉值，跨页签返回后保存，等待权限审核出现并确认选择值未回退、未重新标脏；点击应用后重开页面核对已应用修订，再验证取消不落库。不能把 HTTP 200 或数据库草稿正确当成整个设置流程成功。
- **证据**：[Agent 设置表单](src/components/dashboard/agents/AgentSettingsForm.tsx)、[共享 FormSelect](src/components/ui/FormSelect.tsx)；复用既有 AssistantEditor 的显式提交流程，不修改 vendored Radix 源码。
- **快照传输补充（2026-11-05，真实保存验收）**：Office 技能的 XML 附件以 U+FEFF 开头，Prepare 的正确摘要跨 Flight 后对应内容少一个字符，发布抛出 `AGENT_SKILL_CHECKSUM_MISMATCH`；纯 JSON／数据库回归均未触发。审核 action 返回完整 `configJson`，客户端解析后继续现有审核与 CAS 提交，不放宽校验或改写原始内容。真实生产页面保留五个技能完成保存，发布 v7；下次验收须包含带 BOM 的长附件并完成浏览器 Prepare → Apply 往返，不能只验证捕获函数或普通短文本。
- **插件来源补充（2026-11-05，用户报告）**：新增私有来源失败时，React Action 正常返回错误状态仍触发 reset，文本和 PAT 被清空；只在冒泡阶段 `preventDefault()` 后，Radix 原生监听仍把“私有”改回“公开”。`PluginActionForm` 在失败的 reset 捕获阶段同时阻止默认行为和传播，成功仍允许重置。隔离数据库上的真实页面已验证仓库格式拒绝、GitHub 拒绝 PAT 后全部输入保留，以及真实公开来源注册成功后表单清空并可读回记录；原生产失败输入已丢失，不能把格式错误推测为已确认的 PAT 权限问题。下次必须检查实际提交的可见性、失败后 PAT 是否保留，以及成功重置，不只检查错误文案。依据：[插件表单](src/components/dashboard/plugins/PluginForms.tsx)、[来源校验](src/lib/plugins/sources.ts)。
- **确认日期**：2026-11-02（真实浏览器验收）。

### TP-L022：A2A 错误不能用子类携带内部原因

**规则**：需要给 `@a2a-js/sdk` 错误附加仅供内部界面使用的原因时，保留原错误类实例（如用 `WeakMap` 关联原因），不要派生子类。SDK 的 `toJsonRpcError` 按 `error.name` 查表，子类会把 `TASK_NOT_FOUND` 变成内部错误。

- **错误与原因**：为子智能体就绪原因新增 `TaskNotFoundError` 子类后，`a2a-local` 全部通过，但入站关闭时真实 A2A 路由返回 `Internal A2A service error`，而不是 `-32001` 任务不存在；只有走 SDK HTTP 封装的 `pi-agent-communication` 用例发现。
- **下次怎么验证**：改动 A2A 错误类型后，运行经过真实 A2A HTTP 路由的 `tests/integration/pi-agent-communication.test.ts` 外部 SDK 边界组，核对 envelope code，而不只看 `instanceof`。
- **证据**：[就绪原因](src/lib/a2a/local-policy.ts)、[外部 SDK 边界回归](tests/integration/pi-agent-communication.test.ts)。
- **确认日期**：2026-11-02。

### TP-L023：委派验收必须检查产物与实际产品入口

**规则**：真实委派验收同时核对父调用、独立子执行、有效产物及用户实际使用的入口；任务终态和替代 API 成功不能代替产品验收。

- **证据**：2026-11-03 Pi 父 Agent 等待约 31 秒收到 OMP 子任务完成，浏览器显示活动，但文本产物为空；Work coordinator 使用独立沙箱路径，未接入 `/chat` 的平台委派任务身份与工具。
- **下次怎么验证**：断言子任务返回预定内容，父任务实际使用该内容；分别从 `/chat` 和 Work 入口验证，不将其视为同一执行链路。原生与平台共存需在同一真实父会话中分别完成有效任务。
- **同日工具发现补充**：修复流编码后，OMP 已完成原生子任务，却按平台说明中的原始标签调用 `tool.pi_a2a_peers`，报 `Unknown tool from js runtime`；实际注册名为 `mcp__s1_t1__pi_a2a_peers`。宿主现将本轮已授权 host MCP 工具的 label→callName 映射和异步 JS 调用方式注入父会话，不向原生子代理注入父级委派映射；这些运行时 ID 是内部适配产物，不要求用户配置。固定 18.14.0＋真实 Qwen 的隔离诊断确认映射到达模型，模型使用 `await tool.mcp__s1_t1__pi_a2a_peers(...)`，真实宿主桥执行本地诊断工具并返回 `HOST_PEERS_OK`。依据：[宿主](scripts/omp-session.mjs)、[父会话可信策略](scripts/omp-policy.mjs)；仍需主控完成真实平台子 Agent 回传验收。
- **生产迁移补充（2026-11-04）**：用户要求全部 Agent 迁入 Pi 后正常使用；17 个新记录与修订不能证明这一点。逐个真实执行暴露旧模型返回 404／503、供应商凭据返回 401、业务 MCP 超时，以及 RouterOS MCP 的 `uvx` 向只读 `/root/.local/share/uv/tools` 写入失败。修复须保留原绑定与凭据作用域，使用同工作区已实测的模型，并给 uv 显式配置可写的工具目录；验收从原生 JSONL 核对 `bash` 调用和成功结果，不能只匹配回复中的验收字符串。外部凭据或服务不可用时明确阻塞，不以移除依赖冒充迁移完成。用户明确允许暂不绑定故障 MCP、不恢复指定 Agent 时，按授权范围交付并列明排除项，不把范围收窄包装成原功能恢复。依据：[运行手册](https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS)、`LogEvent` 的实际 MCP stderr 与迁移会话原生记录。
- **日志详情补充（2026-11-04，用户反馈）**：迁移后原生执行验收通过，但线上「智同事-小薪」最新任务的账本已有输入、产物和 4 条事件，真实详情 API 仍返回 HTTP 200、空消息和空产物。列表与状态已读统一任务账本，详情却只从旧 `LogEvent`／`LogDetail` 提取正文，形成同一执行链路的投影缺口。下次入口或调度切换须用无旧协议日志的真实任务打开用户详情页，核对消息、有效产物、来源和完整内容，并检查工作区隔离、脱敏及正文查看审计；任务完成和原生工具成功不能代替可观测性验收。依据：[A2A 详情聚合](src/lib/observability/views/a2a-tasks.ts)、[日志集成回归](tests/integration/a2a-logging.test.ts)。
- **详情验收补充（同日）**：真实账本副本暴露 `ROLE_USER`／`ROLE_AGENT` 未归一化，导致接口已有消息但详情无法按用户／智能体角色展示。已按现有视图契约映射为 `user`／`agent`，回归同时断言角色和完整正文；生产构建的工作区与管理员详情页均显示原输入和产物，API 与原账本逐字一致。隔离大载荷验收确认 91,033 字节输入、117,035 字节结果、251 个产物块和 1,005 条事件到达真实页面；导出检查 6,005 条日志与 1,005 条审计，跨页无重复或遗漏。
- **CI 验收补充（同日）**：相同日志回归在本地隔离库通过，但 CI 从迁移建立的数据库拒绝原生上下文 fixture：缺少 `targetBinding`，且跨工作区样本没有对应的 Agent，违反 `A2AContext_target_shape`。fixture 必须创建归属正确的 Agent 并填写完整目标身份；不能删掉测试、放宽数据库约束或仅凭本地库通过宣称 CI 可用。数据库边界回归须至少在迁移建立的独立库运行一次。

### TP-L024：模型流代理必须自己协商压缩编码

**规则**：代理使用 Node fetch 读取上游响应时，不能照搬沙箱客户端的 `Accept-Encoding`；流式模型请求显式使用 `identity`，下游移除编码头时必须保证输出确为解码后的 SSE 字节。

- **错误与原因**：2026-11-03 固定 OMP 18.14.0 的 Bun 客户端声明 `gzip, deflate, br, zstd`，代理原样转发，上游选择 zstd；Node fetch 仍返回压缩字节，代理却删除 `Content-Encoding`，OMP 把二进制当成 SSE，原生／平台模式均以零用量和空文本完成，历史只剩 user 与 `discarded-entry-branch`。Pi 的客户端协商未触发这个编码差异，不能以同模型 Pi 成功排除代理问题。
- **根因证据**：真实 Qwen 与固定二进制的隔离探针中，旧协商产生 12 个 HTTP 200、每个响应 `Content-Encoding: zstd` 且可解析 SSE 帧为 0，最终文本为空。改为 `identity` 后平台模式和升级后的原生模式均返回 `OMP_PROBE_OK`，分别记录 252/49 与 411/27 输入／输出 tokens；同修订的模式／策略变化仍被拒，换修订后两种升级均能继续原生历史。未记录凭据或私人会话内容。
- **下次怎么验证**：使用会返回 zstd 的真实 HTTP 上游检查压缩协商与完整 SSE 内容，再以固定运行时二进制验证非空文本和用量；不能只断言 HTTP 200、任务终态或 fetch mock 的请求头。依据：[模型代理](src/app/api/v1/agent-runtime/model/[providerId]/[[...path]]/route.ts)、[真实 HTTP 编码回归](tests/unit/agent-runtime-proxy.test.ts)。本次未运行测试，由主控统一验收。
- **确认日期**：2026-11-03。

### TP-L025：RPC 宿主工具不能占用原生 MCP 管理器的命名空间

**规则**：跨运行时复用工具工厂时，复用调用与授权逻辑，不复用另一运行时保留的注册名；工具发现、权限来源及文件工具的选择枚举必须使用同一套当前运行时名称。

- **错误与原因**：OMP 18.14.0 的 `SessionTools.#applyMCPToolRefresh` 会删除所有 `mcp__` 工具，再恢复原生管理器及 extension 所属工具，不会恢复 RPC host 所属工具。把 Pi 工厂的 `mcp__sN_tN__…` 直接交给 `set_host_tools`，刷新后连完整注册表中也找不到它，`eval` 因而报 `Unknown tool from js runtime`。原生子代理单独完成不会清空父工具，不能把此问题误修成取消子代理工具隔离或重绑定 API。
- **根因证据**：固定真实 18.14.0 二进制的隔离诊断先完成原生 `CalcProbe`，再显式调用该父会话真实的 `refreshMCPTools([])`：旧名从父级 active/all 工具表同时消失，后续 JS 调用失败，宿主回调未执行。OMP 边界统一改用更短的 `tp__sN_tN__…` 后，同一刷新和调用仍保留父工具，真实 RPC host 桥回调执行并返回 `HOST_PEERS_OK`；子代理仍只有获准的 `wait`／`eval`，未得到父级平台工具。诊断使用受控本地模型响应及无凭据宿主回调，不冒充真实平台子 Agent 的端到端验收。
- **下次怎么验证**：原生子执行后显式触发一次真实 MCP catalog refresh，再以公布的宿主名称从 `eval` 调用平台工具；同时检查 `mcp_result_to_file` 仅公布当前名称、仍走原工具授权及完整文件落盘路径。Pi catalog 保持原名，不能靠每步重注册、兼容别名或放宽权限掩盖所有权冲突。依据：[OMP 宿主适配](scripts/omp-session.mjs)；真实 `/chat` 与 Work 双模式平台回传仍由主控验收。
- **确认日期**：2026-11-03。

### TP-L026：共享沙箱迁移须覆盖身份约束和真实原生历史格式

**规则**：将物理沙箱从会话级改为 Agent 级时，逐项检查以 sandboxId 为唯一键或查询身份的会话附属表；工作目录、修订、包快照及授权仍按 Conversation／Context 绑定。原生历史迁移使用真实运行时产生的格式，不能仅用手写 session 首行样本证明可恢复。

- **错误与原因**：2026-11-03 真实旧 Pi 会话已切到共享容器，但 `PiSessionPackageSet` 仍绑定旧 sandboxId，执行在模型调用前被拒；旧唯一约束也不允许两个会话保存独立快照。OMP 真实 JSONL 首行是 `title`，第二行才是 `session`，只接受 session 首行的迁移器拒绝父会话和子任务历史。
- **修复与证据**：插件快照改为多对一沙箱关系、按会话查询并在迁移事务内移动映射；补充迁移修复已切换记录。原生路径迁移保留 title 前导字节和消息正文，仅修改路由头。真实 Pi／OMP 旧 Work 均恢复并完成 `bash pwd` 与导入扩展调用；同一 Agent 的新旧会话共用容器而保持不同目录，两个新会话分别返回 42、60。插件版本固定、负向授权及两种 JSONL 格式回归已通过。
- **下次怎么验证**：以含已固定插件及 OMP 原生子任务的真实旧会话迁移；随后为同一 Agent 新建第二会话，检查独立包版本、历史恢复、共享安装复用及文件入口作用域。不能只验新建空会话或成功构建。依据：[迁移事务](src/lib/agents/conversation-sandbox.ts)、[会话包身份](src/lib/agents/pi-session-packages.ts)、[原生路径迁移](scripts/native-session-paths.mjs)。

### TP-L027：完成通知以实时轮次结束事件为准

**规则**：REST 状态可先于 SSE 结束事件变为终态，不能因页面刷新得到 idle 就提前销毁实时订阅。通知只认可同一 startedAt 的实时 active → done；连续轮次、历史回放和重连必须分别验证。

- **错误与原因**：2026-11-03 完成通知验收发现终态刷新与 SSE done 的时序竞争；连续轮次还可能读到上一轮缓存快照。已调整订阅释放与事件快照选择，并保留轮次身份判定。
- **证据与验证**：真实 Pi Work 连续执行 bash 后，浏览器主执行环境捕获同一 startedAt 的 active snapshot、done 和原生 Notification 投递；双标签只记录一次投递。自动化探针必须与应用处于同一执行环境，本次普通 evaluate 中的全局覆盖未观测到应用构造器，改用 CDP 主环境后获得真实记录，不能据空探针断言产品故障。
- **下次怎么验证**：在已完成的真实会话中继续一轮，切到后台，核对 SSE 轮次身份和实际通知调用；覆盖多标签、重连及回放不重复。依据：[订阅生命周期](src/components/dashboard/work/WorkspaceWork.tsx)、[轮次判定](src/components/dashboard/work/completion-transition.ts)、[通知投递](src/components/dashboard/work/useWorkCompletionNotification.tsx)、[事件接口](src/app/api/v1/work-sessions/[workSessionId]/events/route.ts)。

### TP-L028：插件说明必须同时检查制品与展示入口

**规则**：插件详情应展示所选不可变版本中的 README；不能以资源路径清单替代说明，也不能从浮动分支补读后冒充该版本内容。缺少 README 时明确说明，不伪造作者文档。

- **证据**：2026-11-03 用户指出插件详情没有 README。指定的 `omp-import-agents` 版本实际只有 `package.json` 和 `import-calc.md`，页面也没有文档展示区。现已增加介绍／资源／配置分区，并将 README 纳入官方模板校验；官方 OCR 插件补文档同时递增版本，不改写旧发布。
- **下次怎么验证**：分别用含 README 和不含 README 的真实发布检查详情页，切换版本、资源及配置页；在手机宽度检查文档与搜索栏，不能只看构建通过。本次 390px 验收同时发现筛选器挤窄搜索框，已改为手机端搜索独占一行。依据：[插件详情](src/app/app/[workspace]/plugins/[listingId]/page.tsx)、[安全文档渲染](src/components/dashboard/plugins/PluginReadme.tsx)。
- **同次链接验收补充**：官方 README 已正常显示，但 `skills/ocrplane-cli/SKILL.md` 这类不带 `./` 的相对链接在 `rehype-harden` 阶段先变成 blocked，后续 `urlTransform` 无法恢复。为净化器提供固定提交的文档基准 URL，仍保留原 HTML sanitize 和协议限制；回归同时检查链接、图片的提交固定及 script／iframe／活动 URL 被拒绝。依据：[README 回归](tests/unit/plugin-readme.test.tsx)。
- **连续历史补充（2026-11-04，用户纠正）**：初版更新日志只展示所选版本，用户要求向下连续阅读历史。更新日志应按新到旧连续排列，版本导航只负责定位，不应把它当成 README 的单版本预览。下次使用多个长版本说明实际滚到最旧版本并检查移动端；本次以真实页面组件和 12 个版本的受控数据完成桌面、390px 浏览器滚动验收，数据来源为临时 fixture，未冒充线上端到端验证。

### TP-L029：消息组件接入须验证实际复制与生产 CSP

**规则**：消息展示更换为现成 UI 组件后，仍须实际点击正文、代码和工具结果的复制入口，检查剪贴板内容及权限拒绝回退；在生产 CSP 下检查代码高亮，不能只以按钮出现和构建通过判定可用。

- **证据（2026-11-03）**：助手输出验收时，正文已有复制回退，但新接入工具和代码块组件直接调用 Clipboard API，浏览器报 `Write permission denied`；代码高亮默认 WebAssembly 引擎被现有 `script-src` 拦截。工具输入标签还因误用 `console.work` 而显示词典键名。
- **修复与下次检查**：代码块和工具结果复用 [CopyButton](src/components/dashboard/CopyButton.tsx)，[高亮器](src/components/agents/agent-code.tsx) 使用 JavaScript 正则引擎，不放宽 CSP；工具标签复用 `console.agents`。用真实联网工具结果与 Markdown 代码块检查折叠、解包、复制原文、翻译及控制台错误，并分别验证创建和切换分支入口。
- **验收补充**：点击后等待“已复制”，再读取原生 `navigator.clipboard.readText()`；本次浏览器工具的剪贴板 shim 曾返回旧哨兵值，而原生 API 已读到 `const ready = true;`。选择器须限定代码块，不能以 `button.absolute` 误点侧栏折叠把手；翻译命名空间以实际词典路径为准，复制词条位于 `common.copy`。
- **发送生命周期补充（2026-11-04，用户纠正）**：用户指出已发送内容仍留在输入框，执行进度、复制按钮和模型位置没有真正对齐智能体。根因是 `await chat.sendMessage()` 等待整段执行流结束后才清空输入，期间输入的下一条草稿还会被结尾清空。提交时须先冻结本次内容并清空编辑器，结束时不能再覆盖新草稿；等待首个模型事件时也须有执行进度。复用智能体的 `ConversationActivity`、`StreamingResponse`、消息头元数据和 `MessageFooter`，而非只仿造按钮外观。回归在受控未结束的流中检查立即清空，并在完成后检查下一条草稿仍在；现已纳入 `tests/unit/workspace-assistant-chat.test.tsx`。
- **真实刷新补充（同日验收）**：真实模型流结束后，分支的 `activeMessageId` 改变了 `AssistantConversation` 的 React key，父组件刷新导致重挂载，仍清空执行期间写下的草稿。未发送文本须按会话保存在父层；回归须在完成回调触发重挂载后重新查找输入框，不能只断言已脱离 DOM 的旧元素。依据：`WorkspaceAssistantChat.tsx` 的会话 key 与 `tests/unit/workspace-assistant-chat.test.tsx` 的完成后草稿回归。
- **执行阶段补充（2026-11-04）**：会话已接纳、连接已建立或收到流 start 都不能证明模型已生成内容。分别追踪排队、准备、真实 provider 请求、首个内容与工具执行；工具后再次请求模型时回到等待阶段。使用真实 Pi／OMP `bash` 回合及助手会话观察阶段切换，并在 OMP 工具运行中刷新验证快照恢复；助手持久化回归暂停首个模型输出，检查等待阶段、游标重放及历史不受污染。依据：`src/lib/agents/execution-stages.ts`、`src/lib/chat/execution-stage.ts`、`tests/integration/chat-background.test.ts`。
- **准备耗时补充（2026-11-04，用户反馈）**：真实热会话暴露逐文件 tracked Docker exec 的固定开销；宿主脚本批量写入后，Pi／OMP 的准备等待下降，但不能省略每轮可信源码覆盖和完整性校验。性能比较须分开冷启动、热轮次与远程发现耗时；本次助手远程 `tools/list` 从约 0.4 秒波动到 1.4 秒，不能把总准备时间变化全部归因于本地并发修改。验收同时执行真实原生工具，不能只观察阶段标签。
- **创建就绪补充（2026-11-04，用户纠正）**：用户向已创建的 OMP Agent 只发“你好”，首轮沙箱仍在下载 276,244,656 字节二进制，文件写入持续约 539 秒。创建／发布必须在数据库事务外先完成固定运行时制品准备；聊天仅从已校验的服务端缓存本地分发，并在沙箱离线校验，不能把首次网络安装藏在“准备中”。失败回归检查 Agent、沙箱及 Deployment 未残留；验收须使用刚创建 Agent 自己的全新沙箱执行真实原生工具，再检查第二轮二进制未被重写，不能把已有 Agent 热会话或提示词中的哨兵文字当成功结果。依据：`src/lib/agents/omp-runtime.ts`、`scripts/omp-install.mjs`、`tests/integration/agents-mutations.test.ts`。
- **Pi 冷安装补充（同日实测）**：不能用已有 SDK 的热沙箱证明离线安装正常。全新沙箱暴露合法主目录别名被缓存路径检查拒绝，以及 `FileHandle.createWriteStream({ autoClose: false })` 的流结束后 `FileHandle.close()` 未收尾；流改用显式 fd，主目录先取 canonical path。验收从固定镜像真实导出制品，在禁网、只读根容器完成离线安装并执行版本检查，再由新建 Pi Agent 实际完成首次和第二轮 `bash`，从原生 JSONL 核对成功的 toolResult。测量分开记录：本次 Pi 首轮准备 25.51 秒、热轮 1.35 秒，OMP 热轮 3.80 秒；不能把共享缓存就绪称为首轮无等待，或把供应商 503 算成本地安装耗时。依据：`src/lib/agents/pi-runtime.ts`、`scripts/pi-sdk-install.mjs`、真实 Work 与原生会话记录。
- **2026-11-05 冷准备优化（用户再次反馈慢）**：固定 SDK 的 14,106 个文件、约 119 MB 在独立禁网容器中安装需 10.05 秒；逐文件流式复制再逐文件流式校验重复创建大量 stream。专用安装进程改用 256 KiB 复用缓冲区做文件复制与摘要，保留归档摘要、路径／链接验证及安装后完整校验，同一制品安装降到 3.22 秒。全新 Pi Agent 真实首轮准备 11.05 秒，闲置后会话重启 2.60 秒、紧接热轮 0.99 秒，三轮均有成功原生 bash 结果。下次须单独测量离线安装与端到端阶段；不能把安装提速比例当成整个首轮比例，也不能把仍需沙箱启动、资源加载和远程发现的首轮称为零准备。依据：`scripts/pi-sdk-install.mjs`、Work `cmw36flzj004h9mmqlccxj02j`。

### TP-L030：CI 提速要减少默认工作，不只缩短超时

**规则**：用户要求轻量 CI 时，先读取真实步骤耗时，将静态检查与数据库、运行时测试拆成独立作业；不能只缩短超时或把完整测试换成仍需建库的测试子集。超时是失败上限，不是性能目标。

- **证据（2026-11-04，用户再次纠正）**：默认检查虽已缩为 6 个测试文件，仍启动 PostgreSQL、应用迁移，总耗时约 1 分 46 秒；其中静态检查约 49 秒、测试约 14 秒、容器准备约 12 秒。默认 `validate` 进一步只保留静态检查并缓存 TypeScript 增量结果，数据库与完整测试留在手动作业；不再让默认作业声明数据库服务。
- **下次怎么验证**：以不可连接的数据库地址运行默认命令，确认不访问数据库；实际观察 GitHub 新作业及其耗时，再报告提速结果，不能拿本地热缓存时间代替远端结果。
- **意图澄清（同日）**：用户明确不要求额外限制 CI 时间，只要求实际运行更快。默认作业不设置人为超时，不能用降低超时上限冒充性能优化；保留纯静态检查与缓存方案。

### TP-L031：配置草稿不能复用阻断执行的维护租约

**规则**：区分只更新草稿的配置写入与会破坏活跃沙箱的维护；草稿写入和维护互斥，但不排斥运行中、排队中或新准入的正常执行。执行容量、同会话串行及实时撤销仍独立生效，草稿租约不能升级为独占维护。

- **证据（2026-11-04，用户反馈）**：设置保存的 action、`updateAgent` 和 `setAgentTools` 使用 `withAgentMaintenanceLease`，该租约看到活跃执行就抛出 `Agent execution capacity is busy. The task has not started.`，把配置写入误判成执行准入。独立数据库回归在活跃执行租约内保存，修复前准确失败于 `updateAgent`，修复后保存成功且原会话仍固定旧修订，删除仍被拒绝。
- **真实页面验收**：修复部署到 `:3000` 后，Pi Work 的原生 `bash sleep 120` 运行中从设置页保存描述成功，默认修订从 1 升到 2，Work 与 Conversation 仍固定原修订；原生工具继续返回 `SAVE_DURING_RUN_OK`。容量和保存回归共 40 项通过。
- **下次怎么验证**：在真实任务运行期间修改并保存设置，核对新默认修订与原会话固定引用；容量回归同时验证草稿可与执行共存、不绕过并发上限、嵌套维护不能放宽互斥。不能只在 Agent 空闲时验收保存。
- **依据**：`src/lib/agents/agent-execution-gate.ts`、`tests/unit/agent-execution-gate.test.ts`、`tests/integration/agents-mutations.test.ts`。
- **固定模型补充（2026-11-05，用户报告 Task not found）**：本地准入、固定配置解析和 runtime grant 把草稿 provider 与 revision 等值比较，未应用 MiniMax 草稿便阻断固定 Qwen 的旧 Work／新入口。执行改查所选修订的 provider，并保留真实资源归属与凭据撤销。独立库先复现四个失败，修复后相关 126 项通过；生产原 v6 会话真实 `bash` 返回 `PINNED_REVISION_OK`，新 v7 MiniMax 会话返回 `NEW_REVISION_OK`。下次同时验证草稿切换／置空不改旧权限，以及固定 provider 删除／空凭据仍拒绝。

### TP-L032：沙箱分类按用户用途，不暴露内部生命周期记录

**规则**：界面只区分智能体沙箱与外挂沙箱；环境模板和历史迁移副本是内部记录，不作为并列资源分类或计入当前沙箱数量。运行状态必须来自实际执行沙箱，不能用模板的停止状态代表智能体不可用。

- **证据（2026-11-04，用户纠正）**：修复“列表全是停止”时，初版改为执行、模板、外挂、历史四类，用户明确要求只保留智能体和外挂两类。真实工作区只有 6 个当前执行沙箱，但另有 10 个模板和 47 条历史记录，暴露内部分类会放大资源数量并增加理解成本。
- **下次怎么验证**：用同时存在模板、当前执行环境与迁移副本的工作区核对两个分类及计数；在另一 Work 标签执行真实原生工具，返回列表确认对应智能体行自动更新，而非新增一个副本。自动关闭开关另以独立数据库和真实 Docker 验证：模拟该临时记录空闲 16 分钟，关闭时仍运行，重新开启后同一容器停止，不改生产时钟或用户资源。
- **依据**：`src/app/app/[workspace]/sandboxes/page.tsx`、`src/lib/sandboxes/queries.ts`、`src/lib/agents/conversation-sandbox.ts`、`tests/integration/sandbox-queries.test.ts`。

### TP-L033：会话列表改版必须验收资源菜单与失败反馈

**规则**：统一侧栏后逐类核对普通聊天、渠道和 Work 的操作权限；自定义菜单不能遗漏既有删除入口或以默认菜单回退暴露无效操作。失败的表单提交不能闪现成功状态。

- **证据（2026-11-04，用户反馈）**：线上普通聊天菜单只返回移动按钮，后端删除 action 仍存在却未接入。实际执行线上发布包的菜单回调，仅得到 Move up/down；恢复删除后，独立数据库中的真实浏览器完成取消、确认删除、正确 Agent 跳转和保留其他会话。运行时未就绪时错误显示在弹窗，另修正 SubmitButton 未传 error 导致短暂显示 Saved 的误导。
- **Work 删除与长列表补充（2026-11-05，用户反馈）**：原归档后整页跳转会重建侧栏，默认展开状态也随列表重挂载丢失；后端 `take: 100` 另会静默截断历史。改为确认后经既有生命周期真正删除、局部移除和受控展开，仅删除当前项时客户端导航。110 条会话夹具实测尾部可浏览和搜索；删除非当前项保留 URL、文档实例及两个 Agent 展开，滚动只随被删行高度调整；当前项删除切到下一会话，409 保留行与错误弹窗。真实 Docker 回归确认仅清理目标目录／附件，保留共享容器和其他会话。依据：[Work 删除集成回归](tests/integration/work-session-deletion.test.ts)。
- **首次预览纠正（2026-11-05）**：上一轮把“不反复点更多”误解成初始铺开全部，用户再次明确首次只展开前几项。首次预览与完整历史可访问是两个独立要求；改为每 Agent 前 5 条加当前项、列表尾部一次展开全部，搜索仍查全部历史。28 条夹具实测首次 5 条、一次展开 28 条、收回 5 条，搜索第 28 条后恢复 5 条；验收必须覆盖全新初始状态，不能只证明全部记录能访问。
- **下次怎么验证**：在独立数据库实际删除一次性聊天、取消另一个聊天，检查渠道无删除入口；拖动排序后刷新核对持久顺序，不能只检查菜单文案或后端函数存在。
- **依据**：`src/components/dashboard/work/WorkspaceWork.tsx`、`src/components/agents/ai-sidebar.tsx`、`src/lib/agents/actions.ts`。

### TP-L034：统一系统安全策略必须覆盖所有消费者

**规则**：私网访问复用系统白名单及其解析、优先级和拒绝策略，不能为单一传输另建部署配置。诊断应先核对现有系统授权，再建议配置变更。

- **证据（2026-11-05，用户纠正）**：10030 的系统白名单已有 `*.gshbzw.com`，MinIO 解析到 `10.0.10.150`，A2A 文件却只读取独立 JSON 来源映射。初次诊断建议增加环境变量，没有识别已存在的系统授权。文件下载已切换到 `resolvePrivateHostsSettings()`；独立数据库和真实私网 HTTP 下载验证已保存名单放行，清空后在发出下一次请求前拒绝。
- **下次怎么验证**：覆盖精确主机、子域通配、IP、名单撤销和混合 DNS 答案；确认回环／元数据永不放行，Card／RPC 不随文件策略扩大。检查部署示例和界面说明没有保留第二套配置。
- **依据**：`src/lib/a2a/remote-network.ts`、`src/lib/admin/settings.ts`、`tests/unit/a2a-remote-network.test.ts`。

### TP-L035：新增执行入口类型须覆盖数据库约束与全部会话绑定白名单；用量费用不能信任沙箱上报

**规则**：给 `submitAgentEntry` 新增 entry kind 时，同步修改 `A2AEntryBinding_kind_check`，并检索所有以会话为来源的入口白名单（运行时 grant、沙箱绑定、修订升级、会话执行接口、日志 `entryKind`）。Agent 用量费用按服务端模型单价计算，不依赖 Pi 上报的 `cost.total`。

- **证据（2026-11-05，触发器验收）**：触发器的集成测试和类型检查都通过了，但真实 webhook 运行先报 `A2AEntryBinding_kind_check` 违反（被统一记成 `TRIGGER_EXECUTION_FAILED`）；补上约束后，沙箱的模型代理又返回 403，原因是 `runtime-grant.ts` 等处只认 `chat/control/channel`，触发器会话因此拿不到 grant。另外 `buildPiModelsConfig` 把模型单价写死为 0，Pi 上报的费用始终为 0，按费用设的预算永远不会触发。修复后，同一 Agent 的定时和 webhook 运行都在真实沙箱中成功；按 ProviderModel 单价算出的费用为 1.2 美元/轮，第二轮越过 80% 告警并达到 100%，之后 REST 返回 402，智能体页面显示预算文案。
- **下次怎么验证**：新增入口时，用伪 OpenAI 上游跑一次真实沙箱回合，确认模型代理返回 200、会话写入 assistant 消息；为模型配置非零单价，核对 `AgentUsage.costMicros` 非零，并实际越过预算阈值。
- **依据**：[迁移](prisma/migrations/20261105030000_agent_triggers_usage/migration.sql)、[运行时 grant](src/lib/agents/runtime-grant.ts)、[用量计费](src/lib/agents/usage.ts)、[Pi 模型配置](src/lib/agents/sandbox-runtime.ts)。
- **确认日期**：2026-11-05。

### TP-L036：输入框工具菜单只用一个面板，+ 与 / 行为一致，子步骤在原面板内进行

**规则**：输入框的工具入口（+ 按钮、`/`、固定在工具栏的快捷按钮）共用 `src/components/dashboard/composer-menu.tsx`。面板贴在输入框外框上方，不遮挡文本区；MCP 资源、提示词（含参数表单）和服务器状态都在同一面板内逐级进入，不额外弹出全屏或居中弹窗。

- **证据（2026-11-06，用户反馈）**：上一版精简后，+ 弹层锚定在按钮上并盖住了输入框；+ 和 `/` 显示的列表不同；点 MCP 先弹出居中的选择窗，再打开另一个大小不同的选择窗。三个输入框各自维护一套菜单和三个 Mcp*PickerButton 弹窗。现在 + 等同于在光标处输入 `/`，取消时连同插入的 `/` 一起删除；解析结果晚于关闭到达时不再写入输入框。
- **下次怎么验证**：在智能体任务、智能体会话、助手三个输入框里，分别用 + 和 `/` 打开菜单并比较选项；用 `getBoundingClientRect` 确认面板底边在输入框外框之上；走一遍 MCP 提示词→参数表单→插入；按 Esc 和点外部关闭后，检查没有残留的 `/`、没有新开 `role=dialog`；390px 宽度下再看一次。
- **依据**：[共享菜单](src/components/dashboard/composer-menu.tsx)、[MCP 视图](src/components/dashboard/composer-mcp-menu.ts)、[Work 输入框回归](tests/unit/work-composer.test.tsx)。
- **确认日期**：2026-11-06。

### TP-L037：统一任务账本上的日志视图必须按来源分类

**规则**：对话、Work、渠道、控制 MCP、触发器与 Agent 间委派共用 `A2ATask` 账本；任何直接读取账本的日志或统计视图都要用 `src/lib/observability/views/task-origin.ts` 的 `entryRootSql` / `isEntryRootGrant` 区分普通运行与真正的 A2A，不能按表名把账本行都当作 A2A。

- **证据（2026-11-06，用户反馈）**：用户问为什么 Agent 对话出现在 A2A 日志里。事件写入已经把入口根任务记为 `agent.execution.*`，但 A2A 列表的 `ledger_tasks` 直接读取全部账本行；本地开发库 150 个任务中 144 个是普通运行，都显示成“内部 用户 → Agent”的 A2A 任务。现在拆出「智能体运行」视图，A2A 只保留入站、出站和委派（委派以运行的直接子任务为根，并链接来源运行）；`LogEvent.taskId` 把工具与 MCP 调用关联到所属任务。
- **下次怎么验证**：新增或修改读取账本的视图时，在同时有普通运行与委派的真实数据上核对两类行各自出现在哪个视图；回归见 `tests/integration/a2a-logging.test.ts` 的 “Agent runs and genuine A2A separation”。
- **确认日期**：2026-11-06。

### TP-L038：Pi 原生命令的前置条件提示不是运行失败

**规则**：`scripts/pi-sdk-session.mjs` 会把 SDK 抛出的未知错误统一收敛为 `PI_SDK_REQUEST_FAILED`。Pi 在会话未改变、也未调用模型时抛出的前置条件提示（例如 `/compact` 的 “Nothing to compact (session too small)”），应作为命令的完成结果返回，不能记成运行失败。

- **证据（2026-11-06，用户反馈）**：用户反馈“输入总是报错”。:3000 上短会话里的每一次 `/compact`，都在约 1.2 秒内以 `PI_SDK_REQUEST_FAILED` 失败，期间没有任何模型代理请求；原因是 Pi 的 `compact()` 在 `prepareCompaction` 返回空时直接抛错。修复后，在同一 Work 会话的真实沙箱里发送 `/compact`，任务状态为 COMPLETED，界面显示 Pi 的提示。
- **下次怎么验证**：在 `tests/integration/pi-sdk-host.test.ts` 中，对短会话执行原生命令，确认返回成功、没有发出模型请求、会话没有被改写；再在真实 Work 会话中发送一次。
- **确认日期**：2026-11-06。

### TP-L040：要在控制台展示的日志属性，不能挂在 Agent 范围的事件上

**规则**：`recordEvent` 遇到带 `agentId`（含继承的日志上下文）的事件，会把 attributes 收窄为数值遥测，防止 Agent 内容进入元数据。需要按属性聚合展示的运维事件（如发送人 ID），要在不带 agentId 的独立上下文中记录；测试 fixture 必须和真实连接一样绑定 Agent。

- **证据（2026-11-06，频道重设计验收）**：`channel.sender_rejected` 的集成测试使用未绑定 Agent 的连接，属性完整，测试通过；在 :3000 上对已绑定 Agent 的真实连接调用准入后，两条拒绝日志的 `attributes.data` 都是 `{}`，控制台“最近被拒绝的发送者”因此始终为空。同一轮验收还发现查询读取的是 `attributes->>'userId'`，实际字段在 `attributes->'data'` 之下。现改为以 `withLogContext({ workspaceId, channelId }, …, true)` 记录、按 `data` 读取，回归 fixture 已绑定 Agent。
- **下次怎么验证**：新增依赖日志属性的控制台视图时，用绑定 Agent 的真实连接写一条事件，直接查 `LogEvent.attributes`，再在页面确认列表有数据；回归见 `tests/integration/agent-channel-access.test.ts` 的 “denies v2 empty allowlists”。依据：[事件脱敏](src/lib/observability/events.ts)、[准入记录](src/lib/agents/channel-sender-access.ts)。
- **确认日期**：2026-11-06。
