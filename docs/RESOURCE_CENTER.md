# 工作区资源中心

> **English**：[Workspace Resource Center](./RESOURCE_CENTER.en.md)

本文介绍登录后的工作区控制台。`{workspace}` 是工作区 slug。

## 路由

| 页面 | 路由 |
|---|---|
| 资源发现 | `/app/{workspace}/market` |
| 工作区资源 | `/app/{workspace}/market/installed` |
| 可用更新 | `/app/{workspace}/market/installed?updates=1` |
| 我的发布 | `/app/{workspace}/market/publish` |
| 统一包导入 | `/app/{workspace}/market/import`（GitHub 固定 commit 或 ZIP；保留独立 Skill 兼容入口） |
| 资源详情 | `/app/{workspace}/market/items/{namespace}/{listingSlug}` |
| Pi 包目录 | `/app/{workspace}/market/pi-packages`（历史入口） |
| 旧包组装入口 | 重定向到 `/app/{workspace}/market/import?type=pi` |
| 包来源与凭据 | `/app/{workspace}/market/sources` |
| 只读 Toolkit 历史 | `/app/{workspace}/toolkits` 和 `/app/{workspace}/toolkits/{slug}` |

工作区外壳有三个平级主入口：助手（`/app/{workspace}/chat`）、智能体（`/app/{workspace}/agents`）和资源中心（`/app/{workspace}/market`）。工作区页面标签、通知、工作区切换和账户入口保留，知识库与日志保留为次级入口。工作区设置链接到已有的成员、模型提供方与凭据、共享 MCP 连接和资源来源页面；平台管理员另可进入真实的 `/admin/settings` 配额与限制页面，普通工作区成员不能修改平台配额。

资源中心提供 MCP、Skill、Pi 包、Agent 预设和 Assistant 预设的跨类型目录。Toolkit 不再是可选的独立资源产品；历史 `/market/toolkits` 发现地址重定向到 Pi 包发现，不提供旧执行兼容端点。历史 `/toolkits/pi-packages` 与 `/toolkits/pi-packages/sources` 书签重定向到资源中心真实的组装与来源页面；当前导航使用新地址。

## 发现、安装与管理

在“发现”的单层筛选面板中按资源类型、来源和兼容目标（`target=agent` 或 `target=assistant`）搜索。搜索框始终可见，支持键盘操作的筛选面板可在窄屏收起。Agent 结果不含 Assistant 预设与已停用的 Toolkit；Assistant 结果包含 Assistant 预设和远程 Streamable HTTP／SSE MCP，不提供 Skill、Pi 包或 Prompt 导入。版本提供的运行环境信息仍在卡片中显示；工作区配置状态与运行状态分开，资源安装不代表执行正在运行。

“工作区资源”列出工作区安装；“更新”是在同一生命周期页面中筛出的可更新安装；“我的发布”列出本工作区的发布条目，包括私有条目和公开审核中的条目，并进入对应发布流程。安装到工作区不等于已绑定到 Agent，也不等于 MCP 进程已配置、测试或运行；Skill 的“允许 Agent 调用”设置不是 Agent 绑定。Assistant 仅配置远程 MCP，不导入 Prompt 资源、不安装 Pi 包。

更改 Pi 工作区安装版本不会自动改写任何 Agent 默认版本。只有通过 `/app/{workspace}/market/installed/{installId}/configure?releaseId={approvedReleaseId}` 明确把已批准版本应用到所选 Agent，才会更改该 Agent 新会话使用的默认版本；其他 Agent 不变，既有会话继续使用其锁定的版本快照。

更新或回滚前，界面会显示当前与目标版本及发布说明，并列出有界文件路径差异、权限与环境变量键、传输与运行时兼容性变化及配置变化；影响说明区分工作区安装、Agent 默认和既有会话版本。先查看并确认影响，再确认操作；只能选择同一条目中已批准的版本，差异不包含文件内容或密钥。已修改的 Skill 不会被静默覆盖，其更新受本地修改保护。

## 导入与发布

统一入口是 /app/{workspace}/market/import?type=pi。包作者提交 GitHub 仓库 URL 和固定的 40 位 commit SHA，或上传一个以唯一 toolplane.json 为根索引的 ZIP。导入器先做只读预览、资源 manifest 校验、路径安全检查、checksum 和 secret scan，再创建不可变的导入版本；预览阶段不执行扩展代码、不启动 MCP、不创建 Agent runtime，也不安装依赖。

Pi、MCP、Agent、Assistant 和 Skill 都可以作为同一个外部包的资源。每种资源继续使用各自现有的 manifest 校验器。包中只声明环境变量名称、精确依赖版本和允许的 MCP 工具，不包含 API key、私钥、workspace ID、deployment ID、provider ID、会话记录或其他运行时状态。安装后由目标工作区重新绑定模型和凭据，Agent 从 needs_setup 状态开始。

以下旧入口已经停用或应重定向：

- /market/compose：重定向到统一 Pi 包导入，不再从当前工作区 Skill/MCP 组合包。
- /market/import?type=mcp：不再直接创建工作区 MCP deployment；MCP 必须来自标准包。
- /market/publish：只管理已导入 listing/release，不再发布当前工作区 MCP、Agent、Assistant 或其他本地资源。
- Pi 的 npm source：不作为用户包导入来源。官方 Pi catalog 内部的 npm 安装路径仍保留。

### Skill

独立 Skill 页面仍可提供现有 GitHub/ZIP 兼容流程；统一市场入口不再从工作区资源组合 Pi 包。若 Skill 是标准包的一部分，使用 resources/skills/<id>/ 并在根 toolplane.json 中引用。

### Pi 包

Pi 资源必须符合现有 pi-package manifest v1，固定 runtime、Pi SDK、Node major、资源路径和文件 checksum。用户只能从 GitHub 固定 commit 或完整 ZIP 导入。ZIP 必须显式确认可执行代码信任；该信任只适用于当前工作区，不等于公开人工审核。

### MCP

MCP 资源使用 portable recipe。npm/PyPI 使用精确版本，GitHub 使用完整 commit，Docker 使用 digest，远程 MCP 使用 HTTPS。包中只列 requiredEnv 名称和工具 allowlist；实际密钥在安装设置流程填写。导入不会立即启动 deployment，必须经过目标工作区授权。

### Agent 与 Assistant

Agent 使用现有 Agent release manifest v1，Assistant 使用 Assistant market manifest v1。清单可以声明 prompt、模型要求、子 Agent、Skill 和已验证 MCP 依赖，但不能包含工作区或运行时身份。安装时创建待设置资源，模型、环境变量和能力授权由目标工作区重新确认。
## 客户端登记与历史 Toolkit 切换

外部接入使用范围受限、可撤销的客户端登记，不再使用 Toolkit 执行端点。`GET /api/v1/pi-packages/registrations?workspace={workspace}` 列出当前登录账户的登记；`POST /api/v1/pi-packages/registrations` 接受 `workspace`、`client`、`label`、`bindings`，并且在 `marketInstallId` 与 `selections` 中二选一。每项显式选择包含固定的 `releaseId`、`checksum` 和 `kind`（`skill`、`mcp` 或 `pi-package`）。私密令牌与配置仅创建时显示；更新登记须提交当前整数版本 `expectedConfigVersion`，扩大权限须再次明确确认，本地安装器须使用新签发的私密配置。

历史 Toolkit 列表与详情仅供只读查看，不创建默认 Toolkit、不探测旧运行时、不签发安装链接，也不提供编辑或发布。转换由管理员在排空活动任务后通过 dry-run／apply 受控操作完成：可转换能力冻结为保留来源和审计的私有包，旧客户端令牌撤销，客户端须按新范围重新登记并授权。公开版本不会自动重发，不保留旧执行兼容层。此处说明切换约定，不构成生产迁移授权。

## 下载

- Skill 默认下载完整 ZIP 包：`/api/v1/skills/{id}/download`（文件名 `{slug}.zip`）。单独的 `/api/v1/skills/{id}/download?format=markdown` 只下载主 `SKILL.md`，文件名为 `{slug}.SKILL.md`，不包含 Skill 的其他文件。
- Pi 包通过 `/api/v1/workspaces/{workspace}/market/pi-packages/{releaseId}/download` 下载，返回 `.tgz` 包，而不是 ZIP。

请使用资源页面上对应格式的下载操作。Skill Markdown 导出与完整 Skill ZIP 是两种有意区分的下载。
