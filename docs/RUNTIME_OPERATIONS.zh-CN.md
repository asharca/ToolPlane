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

## 单一运行时所有者

`runtime/owner.ts` 用**独立长期连接**持有 PostgreSQL session advisory lock，不使用连接池中的短事务锁。数据库和 `TOOLPLANE_RUNTIME_DOMAIN`（默认 `default`）确定所有权域，同域两个进程不能同时恢复或操作运行时。操作同一 Docker 资源的所有应用必须使用相同数据库和 domain；改 domain 不是绕过所有权冲突的安全办法。

所有者经历 acquiring → recovering → ready，再经过 draining → stopped。执行入口未就绪时返回 503 和 `Retry-After`；恢复所需的签名 runtime 回调仍独立校验凭据。所有权连接丢失会中止受管操作、停止新工作，并保留恢复阻断。已有的数据库准入锁和预算控制仍与进程所有权相互独立。

`SystemSetting` 中的 dirty 标记仅在确认干净退出后移除。崩溃、数据库断连或不确定的 Docker 操作之后，即使 advisory lock 已释放，下个进程也拒绝自动接管。应检查日志、停止所有旧 owner，并确认 Docker helper、复制与删除操作已结束；之后才将 `TOOLPLANE_RUNTIME_RECOVERY_ACK` 设为恢复错误中打印的准确 UUID，用于**一次重启**，恢复后移除该变量。这是对外部操作已核对的确认，不是密码、强制解锁开关或自动高可用。无效标记需要排查，不能随意猜 UUID。

生产启动器收到 SIGTERM/SIGINT 后停止接收 HTTP、停止维护任务/coordinator/broker，有界排空或中止已跟踪工作，最后释放独立连接锁。启动器外层退出上限为 50 秒，Compose 提供 60 秒。超时或不确定操作保留 dirty 标记。自定义进程管理器应给予同等宽限并调用受管停机流程。`pnpm dev` 不具备生产启动器的信号编排，异常停止后可能需要显式恢复。

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
