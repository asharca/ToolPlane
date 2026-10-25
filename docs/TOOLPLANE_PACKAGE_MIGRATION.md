# ToolPlane 包导入改造清单

本文与 [`TOOLPLANE_PACKAGE_STANDARD.md`](./TOOLPLANE_PACKAGE_STANDARD.md) 配套，给实现者列出需要删除、保留和新增的代码边界。

## 删除或改为不可达

### 市场 UI

- `src/app/app/[workspace]/market/import/page.tsx`
  - 删除 `DeployCustomMcpDialog`，不再从导入页直接创建 `source=config` 的 MCP deployment。
  - 删除 `PiPackageComposeForm`，不再从已安装 Skill、MCP 或已有 Pi release 组装包。
  - 删除 Pi 的 npm source 选项。
  - 页面改为一个统一的 Package Import 表单，只有 `github` 和 `zip` 两个来源，并在预览中识别包内资源。
  - 若保留独立 Skill 导入，Skill 页可以继续提供自己的 GitHub/ZIP 流程，但市场统一导入页不再渲染 `AddSkillDialog`。

- `src/app/app/[workspace]/market/publish/page.tsx`
  - 删除本地 `McpPublishForm`、Agent 发布链接和 `AssistantPublishForm` 行。
  - 删除“compose Pi package”链接和由本地 workspace resource 直接发布的卡片。
  - 只保留已导入 listing/release 的版本管理；新版本从 GitHub/ZIP 导入产生。

- `src/components/dashboard/market/SkillPublishForm.tsx`
  - 删除 `PiPackageComposeForm`、`publishAssembledPiPackageReleaseAction` 及其资源选择器。
  - 删除 Pi 的 npm source UI；GitHub source 必须要求固定 commit，ZIP 必须走统一包根校验。
  - 不再从 `deploymentId`、`assistantId` 或工作区 Agent/Assistant 记录创建市场 release。

- `src/components/dashboard/DeployCustomMcpDialog.tsx`
  - 从市场导入流程移除。运行时 MCP 文件上传 API 不属于此改造范围，继续保留其路径安全和大小限制。

- Agent/Assistant 的本地 publish 页面和 action
  - 移除 `/market/publish` 中指向 `/market/agents/{id}/publish` 的本地发布入口。
  - `publishAgentRelease`、`publishAssistantReleaseAction` 和 `publishMcpReleaseAction` 不再被普通 workspace 本地发布 UI 调用。
  - 若后台仍需要管理员维护平台内置 listing，可以保留 admin-only 入口，但它不能接受用户 workspace 资源作为普通包导入替代品。

### 后端 action 和数据流

- `src/lib/market/actions.ts`
  - 保留 ZIP/GitHub 包的 preview、digest、secret scan、release 创建路径。
  - 移除或拒绝 `publishAssembledPiPackageReleaseAction`；旧 action 对外返回明确的 deprecated/410 错误，不能继续接受旧 composition payload。
  - `PiPackageCaptureInput` 的公开入口只接受 `sourceType=zip` 或固定 GitHub commit；npm source 只允许作为包内部的精确依赖描述。

- `src/lib/market/pi-package-source.ts`
  - 将独立 npm source 从用户导入入口拒绝；保留其解析器用于官方 Pi catalog、历史 release 和包内部精确依赖校验。不要删除 `src/lib/market/pi-package-catalog.ts` 或官方目录的 npm 安装路径。
  - Git source 必须规范化为 `https://github.com/<owner>/<repo>` 加完整 commit SHA。

- `src/lib/market/pi-package-assembly.ts` 与相关 assembly tests
  - 不再被用户市场导入流程使用。只有在平台内部仍有明确的 admin template 生成需求时才保留模块，并禁止普通 workspace 调用。

## 新增统一包导入器

建议新增 `src/lib/market/toolplane-package.ts`（名称可按项目约定调整），集中实现：

1. 读取并严格校验根 `toolplane.json`。
2. 解析 GitHub URL + commit 或 ZIP 原始 bytes。
3. 规范化 ZIP 根目录、拒绝路径穿越/符号链接/特殊文件/重复路径和 zip bomb。
4. 解析资源清单并调用现有专用校验器：Pi、MCP portable recipe、Agent release manifest、Assistant market manifest、Skill bundle。
5. 生成规范化内容 SHA-256、资源摘要、环境变量名称和 MCP 工具 allowlist。
6. 在预览阶段只读，不执行包中代码、不安装依赖、不启动 MCP。
7. 以 source pin + content digest 创建不可变导入版本，重复导入保持幂等。

建议新增服务端 action/API：

- `previewToolplanePackageAction`
- `importToolplanePackageAction`
- GitHub source 输入：`repositoryUrl`、`commitSha`
- ZIP source 输入：`archive`
- 两者都返回 `packageDigest`、`resourceSummary`、`requirements`、`scanFindings` 和 `releaseId`/preview token

导入 action 必须复用现有 workspace owner/admin 授权、listing 审核和 install `needs_setup` 流程，不能绕过它们。

## 文档和路由

- 用 `TOOLPLANE_PACKAGE_STANDARD.md` 的内容更新 `docs/RESOURCE_CENTER.md` 和 `docs/RESOURCE_CENTER.en.md`。
- 删除文档中关于 Skill 文件夹上传、Pi npm/组合发布、内联 MCP 创建和 Agent `/publish` 的旧说明；如果独立 Skill 页保留，其入口必须单独标注，不要把它描述成统一市场包导入。
- `/market/compose` 重定向到 `/market/import`；历史本地 publish URL 应返回重定向或 410，而不是继续接受旧 payload。
- README、帮助文案和 API 文档都应说明：包作者提供 GitHub 固定 commit 或 ZIP，凭据只在安装时由目标工作区填写。

## 测试门槛

### 单元测试

- 根 manifest：未知字段、重复 resource id、越界 manifest path、缺失资源、版本和 ID 格式。
- GitHub：非 `github.com`、HTTP、branch/tag、缺少或非 40 位 commit SHA。
- ZIP：路径穿越、绝对路径、符号链接、重复规范化路径、特殊文件、zip bomb、双重 `toolplane.json` 和缺失索引。
- Pi：npm 独立 source 被拒绝；GitHub commit、ZIP、checksum、资源路径和 secret scan。
- MCP：浮动版本、未允许命令、`sh -c`、凭据值、未固定 Docker/Git source 被拒绝。
- Agent/Assistant：workspace ID、provider ID、deployment ID、对话记录和 secret 不得进入 manifest；引用关系和 checksum 必须完整。

### 集成测试

- 预览不会创建 deployment、Agent、sandbox、runtime 或安装依赖。
- 确认导入后只产生 draft/reviewable release；安装起始状态为 `needs_setup`。
- 同一 GitHub commit 或 ZIP digest 重复导入是幂等的。
- 旧 composition、inline MCP create、本地 Agent/Assistant publish URL 不再可达。
- 现有已批准 listing 的安装、撤回和版本审核不受影响。

## 实施顺序

1. 先落地统一 manifest、GitHub/ZIP 预览和安全校验，并为新导入路径补测试。
2. 将现有 Pi ZIP/Git capture 接到统一导入器，确保历史 release 读取仍兼容。
3. 接入 MCP、Agent、Assistant 专用 manifest 校验和 `needs_setup` 安装流程。
4. 删除 UI 中的本地 publish、compose、inline MCP create 和 npm Pi source。
5. 更新中英文文档和旧路由重定向。
6. 运行 `pnpm lint`、相关单元/集成测试和构建；确认没有旧 action 或 stale link 仍能提交本地 workspace 资源。

