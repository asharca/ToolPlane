# 能力客户端登记与历史 Toolkit 受控切换

> **English**：[TOOLKIT_SYNC.en.md](./TOOLKIT_SYNC.en.md)

Toolkit 执行及旧安装器已退出产品路径。历史 Toolkit 保留只读，不再作为独立发布、执行的组合产品。私有 Pi 包在资源中心 `/app/:workspace/market/compose` 组装，捕获源在 `/app/:workspace/market/sources` 管理。

## 冻结预览与发布

捕获或组装预览返回 `sourceDigest`，提交必须携带同一摘要；字节或依赖改变后必须重新预览。也可以选择自己拥有的不可变私有 release 作为冻结来源。禁止将私有 listing 原地转公开，从而泄露历史版本：只能把选定字节提交到独立公开 listing，重新接受人工审核；公开制品不携带认证源或私有来源元数据。扫描覆盖实际分发字节，包括解码后的二进制 Skill 附件。

Skill 保留 `SKILL.md`、相对附件路径、二进制内容及包格式支持的执行属性。归档校验路径和符号链接边界，Web 进程不执行捕获源。原生扩展的命令和工具注册在 Agent Review + Apply 和运行时由隔离 Pi 预检判断，不再用正则表达式猜测 JavaScript 执行行为。

## 统一登记

复用 Pi package client registration，可选择：

- 工作区已就绪包安装：`marketInstallId`；或
- 固定独立 Skill、MCP、包版本：`selections`。

每项只能有 `{ releaseId, checksum, kind }`，kind 为 `skill`、`mcp`、`pi-package`。登记不是新市场 listing，也不是可单独发布的 combo。数据库维护规范化 release 引用并校验 checksum/kind，阻止删除被引用版本、变更登记 owner/workspace/client 身份。

账号认证 API：

| 操作 | 路径 | 请求 |
|---|---|---|
| 列表/创建 | `GET/POST /api/v1/workspaces/:workspace/pi-packages/installations` | POST：`client`、`label`、`marketInstallId` 或 `selections`，以及明确的 `bindings` |
| 重新审核更新 | `PATCH /api/v1/workspaces/:workspace/pi-packages/installations/:id` | 必填整数 `expectedConfigVersion`；选定 `releaseId` 或 `selections`、`bindings`；扩大权限时明确 `confirmExpandedPrivileges` |
| 撤销 | `DELETE /api/v1/workspaces/:workspace/pi-packages/installations/:id` | 无 |

登记 Token 使用的 artifact、manifest、MCP、revoke 端点仍位于 `/api/v1/pi-packages/installations/:id/`。Token 随机生成、只存哈希、可撤销且仅限一个登记，不能作为账号 API 凭据。每次请求重新校验工作区成员、release 审核状态、实时 MCP 工具权限和连接配置。选择更新是 owner 范围内针对独立递增 `configVersion` 的 CAS，陈旧审核不能覆盖并发配置更新；普通认证的 `lastUsedAt` 写入不改变版本。扩大权限必须重新确认。非 Pi 客户端只展示实际支持的 Skill/MCP，不宣称安装了 Pi 原生扩展、Prompt 或 Theme。

包配置向导可配置新连接，并允许同一鉴权幂等操作创建且尚未共享的连接在部分失败后原地修正凭据。预存/共享 MCP 仍须在连接设置明确确认受影响对象后修改。明确选中 Agent 并 Review + Apply 后，以其当前已应用修订为基线，仅合入本次包和确认的 MCP 范围，发布新默认（`enabled: true`、`agentRevisionId`），不应用无关草稿或改变既有会话修订。目标没有已应用修订时，须先 Prepare、审阅并 Apply 配置，检查前不产生安装副作用。HTTP 明文连接在操作者明确批准前保持 `setup_required`，制品 flag 不代表用户同意。

## 危险 release 撤销与保留

`POST /api/v1/pi-packages/releases/:releaseId/revoke` 接收 `{ workspace, reason }`。发布工作区管理员或平台管理员可把危险版本标记为 `revoked`，关联外部登记同步撤销，执行边界立即重新检查状态。引用和历史内容保留可读/审计。卸载不是安全撤销：从默认配置移除包不能破坏已固定会话制品。AgentRevision 和 Assistant Prompt 中的 `sourceReleaseId` 独立保留源版本，即使原安装已移除。公开下架不等于授权删除被引用历史。

## Toolkit 受控转换

维护端点：`POST /api/v1/workspaces/:workspace/toolkits/cutover`。

```json
{ "toolkitId": "owned-toolkit-id", "mode": "dry-run" }
```

结果报告 `ready`、`blocked` 或 `already-applied`，可用时返回冻结摘要、blockers 和 `requiresReauthorization: true`。先排空相关旧 Work、公开端点、A2A 活动任务，再显式应用已审核摘要：

```json
{ "toolkitId": "owned-toolkit-id", "mode": "apply", "expectedDigest": "64-character-sha256", "confirmReauthorization": true }
```

领域服务为 `src/lib/toolkits/cutover.ts` 的 `cutoverToolkitToPrivatePackage`。要求工作区 owner/admin 或平台管理员权限，在工作区锁下事务执行。活动任务、陈旧字节、不可转换/空内容或疑似凭据均拒绝 apply。成功后只创建 **PRIVATE** 冻结包，不自动安装、授权或公开；旧市场关联归档；撤销旧 Toolkit 客户端 Token/登记；禁用旧 Toolkit；写入来源和审计。重复调用返回原转换记录，不重复生成包。旧公开版本绝不自动重发，历史记录不删除，非 Pi 会话不能伪造为 Pi 恢复状态。

此操作是显式维护接口，不是启动时自动迁移。部署代码、阅读文档或 dry-run 均不授权操作生产环境、执行迁移或改动运行服务。旧 Toolkit 同步、安装和执行路由已移除，不保留兼容执行垫片；历史记录仍通过历史界面只读访问。管理员市场修改或审核也不能重新发布已退役 Toolkit。

## 回归覆盖

核心行为测试位于 `tests/integration/pi-package-market.test.ts`、`pi-package-bindings.test.ts`、`pi-package-clients.test.ts`、`toolkit-market.test.ts`、`capability-client-registration-schema.test.ts`，以及包配置/组装单元测试。由主验证流程在隔离测试数据库运行；实现 worker 不执行数据库或运行时操作。
