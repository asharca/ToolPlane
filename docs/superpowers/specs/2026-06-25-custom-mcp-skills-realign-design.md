# 设计:自定义 MCP 对齐ToolPlane + 自定义 Skill(完整)

> 日期:2026-06-25 · 状态:已批准设计,待实现计划
> 一个 spec,两部分:**A** 把已实现的自定义 MCP 对齐 ToolPlane console ToolPlane(4 来源全部真实运行、字段/入口对齐、去掉 env/args);**B** 新增完整的自定义 Skill(Create new / GitHub 导入 / 文件夹上传 + 草稿/发布 + frontmatter 属性 + 编辑器)。
>
> ToolPlane取证(已登录 4sharca 工作区实地查看):
> - **Deploy custom MCP** 对话框入口 = `/<ws>/mcp/new` 浏览页的 **"Add custom"** 按钮;4 来源全部可用;字段:npm Package / PyPI Package / GitHub Repository / Docker Image+**Start Command**;+ Server Name + `/<ws>/mcp/<slug>` 预览;**无 env/args**。
> - **Add skill** 对话框 3 来源:Import from GitHub(同步)/ Upload a folder / Create new(空白 SKILL.md)。Create new = Name+Description→**Draft**。编辑器:状态(Draft→Publish)、属性徽章(Effort / User-invocable / Agent-invocable / Tools / Toolkits)、Files 面板(可多文件)、SKILL.md 编辑器 + Source 切换。

## 决策汇总

| 维度 | 决策 |
|---|---|
| MCP 来源 | npm / PyPI / GitHub / Docker **四个都完整真实运行** |
| MCP 运行机制 | 复用现有 stdio bridge;仅扩展 `buildSpawnSpec`(npx / uvx / npx git-url / docker run) |
| MCP env/args | 创建对话框**去掉**(对齐ToolPlane);Docker 保留 Start Command;**env 改由检查器 Variables 标签页管理**(ToolPlane如此) |
| MCP 入口 | 移到 `/mcp/new` 的 "Add custom";居中 Dialog 替换右侧抽屉 |
| MCP 浏览页 | `/mcp/new` 对齐ToolPlane:Featured 区 + All MCPs 分页表 + 搜索 + Add custom |
| MCP 检查器 | 已基本一致(Overview/Variables/Tools/Logs);补齐 **Variables** 标签页的真实 env 配置 |
| Skill 范围 | 完整:Create new + GitHub 导入 + 文件夹上传 + 草稿/发布 + 属性 + 编辑器 |
| Skill 数据 | `InstalledSkill.skillId` 改可空 + 自定义字段;自定义 skill 仍是 InstalledSkill(复用绑定/下载) |
| 交付 | 一个 spec → 一个 plan(用户明确"不拆") |

---

# Part A · 自定义 MCP 对齐ToolPlane

## A1. 运行时:4 来源全部真实

`Deployment` 模型够用(已有 `serverId?` + `source/sourceRef/name/installCfg`)。`installCfg` 重定义为 `{ env?: Record<string,string>, startCommand?: string }`。**创建对话框不收 env/args**(对齐ToolPlane);`env` 改由检查器 Variables 标签页编辑(见 A5),`startCommand` 仅 Docker 用。supervisor 启动时把 `installCfg.env` 注入进程(`resolveSpawnSpec` 已透传 env),改 env 后 Restart 生效。

扩展纯函数 `buildSpawnSpec(source, ref, cfg)` → `{ command, args }`:

- `npm` → `npx -y <ref>`
- `pypi` → `uvx <ref>`
- `github` → `npx -y <ref>`(`ref` = git URL;`npx` 可直接跑 npm 体系的 git 仓库)
- `docker` → `docker run -i --rm <ref> <…splitWhitespace(cfg.startCommand)>`

环境缺 `uvx`/`docker`/`git` → 子进程 spawn 失败 → bridge 非零退出 → `error` 状态(已有机制),优雅降级并在列表/检查器可见、可重试。**bridge / supervisor / 网关 / `resolveSpawnSpec` 的 builtin 分支均不变**;`resolveSpawnSpec` 的 custom 分支改为读 `source/sourceRef/installCfg.startCommand`。

## A2. 校验

`parseCustomMcpInput`(`lib/workspace/custom-mcp.ts`)重写,去掉 env/args,按来源校验 `ref`:

- `source`:枚举 `npm|pypi|github|docker`
- npm / pypi:包名字符集正则
- github:必须是 `https://github.com/<org>/<repo>` URL(限 `github.com` 主机)
- docker:镜像名正则 `^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$`,可选 `startCommand`(空格分词)
- `name`:必填
- 输出 `{ source, ref, name, installCfg }`,其中 `installCfg = source==='docker' ? { startCommand } : null`

## A3. UI 对齐

- **入口迁移**:从 `/mcp` 列表页移除 "Deploy custom MCP" 按钮;在 `/mcp/new` 浏览页搜索栏旁加 **"Add custom"** 按钮。
- **居中 Dialog**(替换右侧抽屉,对齐ToolPlane):信任警告 + 4 来源分段标签(全部可用)+ 随来源变化的字段(npm/PyPI=包名,GitHub=仓库 URL,Docker=镜像 + Start Command)+ Server Name + `/<ws>/mcp/<slug>` 预览 + Cancel/Deploy。用 `createPortal` 渲染到 `document.body`,逃出 header 的 backdrop-blur 层叠上下文(同上一功能已落地的修复)。
- `deployCustomServerAction` 改为解析 `{ source, ref, name, startCommand }`(去掉 env/args)。

## A4. 回退既有实现(对齐的一部分)

现有 `DeployCustomMcpLauncher`(右侧抽屉、创建表单里的 env-rows + args、仅 npm)→ 用新的 4 来源居中 Dialog 组件替换;`spawn-spec.ts` / `custom-mcp.ts` / `deployCustomServerAction` 从**创建表单**移除 env/args(env 改到 Variables 标签页,见 A5)。

## A5. 检查器 Variables 标签页(真实 env 配置)

ToolPlane检查器 Variables 标签页 = 「My Credentials / Your personal API keys for this server」:列出变量(name、`required` 徽章、description)+ 值输入框 + Save。对齐实现:

- 每个 Deployment 在 `installCfg.env`(`Record<string,string>`)里存环境变量值。
- Variables 标签页:可增删的 KEY/value 行(value 视为密钥,密码框样式)+ Save(`setDeploymentEnvAction`,工作区鉴权)。catalog server 若声明了必填变量(`Server.installCfg.variables`,可选,后续 seed)则预列出 name/required/description;自定义 server 由用户自行加行。
- Save 后 env 写入 `installCfg.env`;**Restart 后注入新进程**(supervisor 已合并 `spec.env`)。当前 `/mcp/[deploymentId]` 的 Variables 标签页占位文案("no configurable variables")替换为该编辑器。

## A6. `/mcp/new` 浏览页对齐

对齐ToolPlane浏览页结构:顶部搜索栏 + **Add custom** 按钮;**Featured** 区(`Server.isFeatured` 卡片网格);**All MCPs** 分页表(Name / Description / Add,每页 ~25,复用现有分页模式);每行/卡片 Add = `deployServerAction`(catalog 部署,不变)。端点 URL 域名沿用ToolPlane(`/api/v1/mcp/<id>/rpc`),不强求ToolPlane的 `ToolPlane gateway` 域(§非目标)。

---

# Part B · 自定义 Skill(完整)

## B1. 数据模型

`InstalledSkill` 改动:

- `skillId String?`(可空)、`skill Skill? @relation(...)`(可空)
- 新增:`name String?`、`slug String?`、`description String?`、`content String?`(SKILL.md 正文)、`source String?`(`catalog`|`custom`|`github`|`upload`)、`sourceRef String?`、`status String @default("published")`(`draft`|`published`)
- 属性:`userInvocable Boolean @default(true)`、`agentInvocable Boolean @default(true)`、`effort String @default("default")`
- `files Json?`(文件夹上传的附加文件 `[{ path, content }]`)
- `@@unique([workspaceId, skillId])` 保留(Postgres 多 NULL 互不相同 → 一个工作区可多个自定义 skill)
- 约定:catalog 安装 → `skillId` 有值、`source` 为 null;自定义 → `skillId=null`、`source` 有值。路由仍用 `installId`(`/skills/[installId]`),`slug` 仅用于展示/frontmatter。

迁移:`pnpm db:migrate`(加字段后重启 dev server)。

## B2. SKILL.md 组装分支

`lib/skills/artifact.ts`:
- catalog(无 content)→ 现有 `buildSkillMarkdown(skillMeta)` 合成(不变)。
- 自定义(有 content)→ 新 `buildCustomSkillMarkdown(installedSkill)`:由 `slug/name/description/userInvocable/agentInvocable/effort` 拼 YAML frontmatter + `content` 正文。
- 下载路由 `/api/v1/skills/[installId]/download` 与检查器据 `source` 选择对应函数。

## B3. Agent/Toolkit 集成(关键)

自定义 skill 绑定 agent/toolkit 复用现有 `AgentSkill`/`ToolkitSkill`(FK 到 InstalledSkill)。但 `resolveAgentTools`(`lib/agents/resolve.ts`)和 `assembleSystemPrompt` 现在读 `installedSkill.skill`(catalog 关系),自定义时为 null。需让二者支持自定义:取 InstalledSkill 自身字段(name/slug/description/content)→ 系统提示用 `content`。这是必须修的消费点(类比 MCP 的 nullable-server)。

## B4. UI —— Add skill 对话框(3 来源)

`/skills` 的 "Add skill" 打开对话框:
- **Create new**:Name + Description → `createCustomSkillAction` → 建 draft 自定义 skill(content = 起始模板:`## What this skill does` / `## How to use it`)→ 跳 `/skills/[installId]` 编辑器。
- **Import from GitHub**:仓库 URL → `importSkillFromGithubAction` → 拉取该仓库的 `SKILL.md`(经 `raw.githubusercontent.com`,限 `github.com` 来源,3s 超时)→ 建自定义 skill(`source=github`、`content`=拉取内容、`status=draft`)。一次性导入(自动同步留后续)。
- **Upload a folder**:`<input webkitdirectory multiple>` 客户端读取 → `uploadSkillFolderAction` → `SKILL.md` 入 `content`,其余入 `files`(限文本类型、单文件 ≤256KB、总数 ≤20)。

## B5. UI —— 编辑器(`/skills/[installId]`)

- **自定义可编辑**:头部(name、Draft/Published 徽章、Publish/Unpublish 按钮、More actions→删除);Description;属性控件(User-invocable / Agent-invocable 开关、Effort 下拉)写入 frontmatter;Files 面板(SKILL.md + 上传附加文件列表);SKILL.md markdown 编辑器(textarea)+ Save;**Source(源码)/ Rendered(用项目已有的 Streamdown 预览)** 切换;Download。
- **catalog 只读**:保持现状(合成 SKILL.md 预览/复制/下载)。

## B6. 后端 actions(`lib/skills/actions.ts`,全部工作区鉴权,仅自定义可改/删)

`createCustomSkillAction` / `updateSkillContentAction` / `updateSkillAttributesAction` / `publishSkillAction`(toggle draft↔published)/ `deleteCustomSkillAction` / `importSkillFromGithubAction` / `uploadSkillFolderAction`。

## B7. 列表 / 下载 / 消费点

- `/skills` 列表:自定义行显示 Draft/Published 徽章 + source;"Add skill" 改为打开 3 来源对话框(空态的 "Browse directory" 链接保留指向 `/tools/skills`)。
- `getInstalledSkills` 用 `include` → 标量自动返回;所有读 `installedSkill.skill.*` 的消费点需兼容 null(类比 MCP):**列表页、检查器、`/api/v1/skills/[installId]/download`、agents 详情页、toolkits/[slug] 页、`resolveAgentTools`**。用一个 `skillLabel(installedSkill)` 收敛(catalog → skill.name/slug;自定义 → name/slug)。

---

# 共享

## 安全
- 所有新 action 工作区鉴权(沿用 `authorizedWorkspace`);仅自定义 skill 可编辑/删除/发布。
- GitHub 导入:**限 `github.com` 主机**,经 `raw.githubusercontent.com` 拉取,超时 + 大小上限,防 SSRF。
- 文件夹上传:文本类型 + 单文件/总量上限。
- MCP 任意代码执行(npx/uvx/docker/git 跑第三方代码):仅在本地开发或受信任环境中接受,保留信任警告;参数以数组传 `spawn`,不经 shell。

## 测试
- 单测:`buildSpawnSpec` 四来源映射 + 各校验(`custom-mcp` 重写);`buildCustomSkillMarkdown` frontmatter 拼装;skill 各校验;`skillLabel` / `deploymentLabel` 分支。
- 集成:bridge 用假 stdio fixture(已有)验证 npx 路径;Docker/uvx 用假命令验证 spawn-spec→supervisor 连线(不真正联网/起容器)。
- 组件:MCP 4 来源 Dialog(字段随来源变、Docker 显示 Start Command)、Add skill 3 来源对话框、Skill 编辑器(保存/属性/发布)。

## 非目标 / 已知风险
- GitHub MCP 用 `npx <git-url>`,**仅适配 npm 体系仓库**;非 JS 仓库会运行失败 → error 状态(可接受、文档标注)。
- Docker/uvx 依赖本机装了 docker/uv,否则 error。
- Skill 的 GitHub 导入为**一次性**(无自动同步);多文件编辑器仅展示/下载附加文件,主要编辑 SKILL.md。
- MCP 端点 URL 使用 ToolPlane 自身域(`/api/v1/mcp/<id>/rpc`),不依赖第三方网关域。
- catalog server 的必填变量声明(`Server.installCfg.variables`)为**可选**:本 spec 让 Variables 标签页支持自由增删 env 行即可;预声明的 name/required/description 仅当数据存在时展示(seed 留后续)。

## 受影响文件(概览)
- **MCP**:`lib/process/spawn-spec.ts`(4 来源)、`lib/workspace/custom-mcp.ts`(按来源校验、去 env/args)、`lib/workspace/actions.ts`(`deployCustomServerAction` 改造 + 新 `setDeploymentEnvAction`)、`components/dashboard/DeployCustomMcpLauncher.tsx`(重写为 4 来源居中 Dialog)、`components/dashboard/VariablesEditor.tsx`(新,检查器 Variables 标签页)、`mcp/page.tsx`(移除按钮)、`mcp/new/page.tsx`(Featured + All MCPs 分页 + Add custom)、`mcp/[deploymentId]/page.tsx`(Variables 标签页接 VariablesEditor)。
- **Skill**:`prisma/schema.prisma`(+迁移)、`lib/skills/artifact.ts`、`lib/skills/actions.ts`(新)、`lib/skills/queries.ts`、`lib/agents/resolve.ts`、`lib/agents/system-prompt.ts`、`lib/workspace/queries.ts`(getInstalledSkills)、`components/dashboard/AddSkillDialog.tsx`(新)、`components/dashboard/SkillEditor.tsx`(新)、`skills/page.tsx`、`skills/[installId]/page.tsx`、`skills/new/page.tsx`、`/api/v1/skills/[installId]/download/route.ts`、`agents/[agentId]/page.tsx`、`toolkits/[slug]/page.tsx`、`skillLabel` 工具(新)。
