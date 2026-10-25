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
| 导入与发布入口 | `/app/{workspace}/market/import`（`?type=skill`、`?type=pi` 或 `?type=mcp`） |
| 资源详情 | `/app/{workspace}/market/items/{namespace}/{listingSlug}` |
| Pi 包专用目录 | `/app/{workspace}/market/pi-packages` |
| 包组装与管理 | `/app/{workspace}/market/compose` |
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

从工作区控制台打开 `/market/import`，选择 Skill、Pi 或 MCP。该页面直接呈现按来源区分的引导表单：Skill 和 Pi 可先预览来源再导入或发布，MCP 的“创建工作区 MCP”表单创建部署；导入、安装、配置和 Agent 启用仍是明确区分的步骤。

Pi Agent 预设通过“我的发布”中的真实入口 `/app/{workspace}/agents/{agentId}/publish` 发布。工作区所有者审阅可移植定义、选择分类并明确确认公开内容后，提交不可变版本供管理员审核。安装已批准的预设会创建新的 Pi Agent 草稿；开始任务前须配置凭据、审阅能力授权并明确应用修订。发布或安装预设不会恢复已退役运行时的会话，也不会使历史文件或消息变为可写。

### Skill

Skill 流程支持文件夹、ZIP 上传和 GitHub 来源。预览不会写入资源；ZIP 预览列出根 Skill，选择需要导入的根目录后再提交。导入会重新校验来源，因此内容变化或预览过期会报错，而不会悄悄导入另一份归档。导入后的 Skill 属于工作区资源；在 Skill 详情的“为 Agent 启用”流程中可明确绑定到单个 Agent，不会替换其其他资源。公开发布使用单独的审核流程。

### Pi 包

Pi 导入入口支持 npm、Git、ZIP 来源预览与发布，也可从现有工作区资源组合 Pi 包。选择工作区私有使用时，所有者或管理员必须明确确认代码信任；ZIP 来源也要求明确执行授权。此信任仅适用于本工作区，不等同于公开人工审核或官方目录验证。公开提交会进入人工审核；已批准的私有版本可用冻结版本和新的条目资料提交为独立的公开待审核条目，原私有条目不会直接切换可见性。

在“我的发布”中选择“提交新版本”会打开内联路由 `/app/{workspace}/market/import?type=pi&listingId={listingId}`，并沿用原条目身份。仅更新工作区安装不会更改 Agent 默认版本。包设置可基于一个选定 Agent 当前已应用的修订，明确审阅并应用此包及其列出的 MCP 工具；预期修订过期时拒绝覆盖。新的不可变默认修订仅用于新会话，其他 Agent、现有会话及无关草稿改动均不受影响。若 Agent 尚无已应用的修订，须先通过链接进入 Agent 页面，准备、审阅并应用配置，再刷新包设置。现有或复用的共享 MCP 配置须通过受影响对象确认流程修改，不能在包设置中静默更改。

共享连接限制不禁止重试配置同一次包设置操作新建的连接：该连接仍须由当前操作者拥有，且尚未共享。同一操作之外的复用，或已被其他对象引用的连接，须走正常的共享连接影响审阅流程，不能通过包设置直接写入配置。

目录来源导入同样要求先预览并提交不可变的 `sourceDigest`，同时明确确认执行授权。上游重新捕获入口进入完整发布预览页，不再一键提交未经预览的捕获操作。

捕获和组装表单在提交被拒绝时保留已选文件与填写的资料，补齐遗漏项无需重新上传。来源变化或预览过期导致的拒绝会使旧预览失效，并禁用捕获提交，直到重新预览当前来源。

### MCP

`/app/{workspace}/market/import?type=mcp` 提供内联工作区 MCP JSON 部署表单。stdio 配方使用 `command`、`args` 和环境变量；远程 MCP 使用 Streamable HTTP 或 SSE 端点与可选认证。HTTPS 为推荐选项；HTTP 需要安装用户单独勾选明文风险确认，配方或导入 JSON 内的标记不代表用户同意。未确认的连接停留在待配置状态，可在连接详情明确批准；批准不会自动启动执行。HTTP 可能暴露认证头、工具参数与结果，仅应在经评估的可信隔离网络或覆盖全链路的加密隧道中使用。私有目标仍需管理员白名单；受限地址、DNS 校验与固定、同源请求及禁止重定向等现有边界保持不变。

配置、环境变量、运行时文件和工具暴露设置会影响共享连接。保存前显示实际引用该连接的 Agent／Assistant ID，必须明确确认；若并发修改导致影响对象变化，服务器拒绝保存并返回最新对象，重新确认后才能再次提交。各对象的工具权限不会因为修改共享连接而自动扩大。环境变量编辑器仅接收键名和已配置状态，不回传保存的私密值。

协议发现只进行真实握手与目录读取，不执行业务工具，也不代表工具已获授权。Assistant 仅使用远程 MCP；Agent 可使用远程连接或隔离运行时中的 stdio。创建或安装 MCP 不等于绑定或授权；需要明确选择目标与工具。独立 MCP 使用自身注册的运行时进行协议发现，不会自动创建额外沙箱。

连接详情提供目标选择、真实协议发现、逐项工具授权与应用。Agent 分支复用单项资源的源码审核与应用流程：受控的临时隔离检查继承目标默认 Docker 沙箱的环境约束，不启动模板沙箱，也不要求共享 MCP 进程运行；服务端签名审核凭据绑定用户、工作区、目标、预期修订与实际来源。尚未发布的 Agent 必须先准备并发布修订。目标切换或重新发现会清空勾选，未勾选的工具不会自动授权；审核过期、来源变化或修订冲突要求重新审核。Assistant 仅出现在实际远程连接的目标列表中，保持独立的远程发现及授权流程，不要求创建沙箱。应用只更新所选对象的新默认修订，保留其他连接与配置，并通过预期修订拒绝并发覆盖；既有会话仍固定原修订。共享连接的工具暴露策略独立约束对象授权，应用不会静默扩大该策略。

若 Pi 包声明了 MCP 需求，其引导配置会使用所选 Agent 的现有沙箱；沙箱运行时必须已运行且网络不能为“无”。流程不会静默更改沙箱设置。MCP 的 npm/PyPI 精确版本或 Git commit 是配方固定版本，不代表传递依赖或包装镜像已字节锁定；Docker 镜像引用需要 digest。凭据应通过私密配置提供，不会写入导出的便携配置。

## 客户端登记与历史 Toolkit 切换

外部接入使用范围受限、可撤销的客户端登记，不再使用 Toolkit 执行端点。`GET /api/v1/pi-packages/registrations?workspace={workspace}` 列出当前登录账户的登记；`POST /api/v1/pi-packages/registrations` 接受 `workspace`、`client`、`label`、`bindings`，并且在 `marketInstallId` 与 `selections` 中二选一。每项显式选择包含固定的 `releaseId`、`checksum` 和 `kind`（`skill`、`mcp` 或 `pi-package`）。私密令牌与配置仅创建时显示；更新登记须提交当前整数版本 `expectedConfigVersion`，扩大权限须再次明确确认，本地安装器须使用新签发的私密配置。

历史 Toolkit 列表与详情仅供只读查看，不创建默认 Toolkit、不探测旧运行时、不签发安装链接，也不提供编辑或发布。转换由管理员在排空活动任务后通过 dry-run／apply 受控操作完成：可转换能力冻结为保留来源和审计的私有包，旧客户端令牌撤销，客户端须按新范围重新登记并授权。公开版本不会自动重发，不保留旧执行兼容层。此处说明切换约定，不构成生产迁移授权。

## 下载

- Skill 默认下载完整 ZIP 包：`/api/v1/skills/{id}/download`（文件名 `{slug}.zip`）。单独的 `/api/v1/skills/{id}/download?format=markdown` 只下载主 `SKILL.md`，文件名为 `{slug}.SKILL.md`，不包含 Skill 的其他文件。
- Pi 包通过 `/api/v1/workspaces/{workspace}/market/pi-packages/{releaseId}/download` 下载，返回 `.tgz` 包，而不是 ZIP。

请使用资源页面上对应格式的下载操作。Skill Markdown 导出与完整 Skill ZIP 是两种有意区分的下载。
