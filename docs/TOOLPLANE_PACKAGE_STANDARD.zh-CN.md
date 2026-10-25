# ToolPlane 外部包标准（v1）

状态：提案，供 ToolPlane 导入器和包作者共同实现。

## 1. 目标和边界

ToolPlane 的资源作者只需要维护一个可审查、可复现的外部包。ToolPlane 从 GitHub 仓库或 ZIP 文件读取这个包，先预览和校验，再生成不可变的版本记录；安装时才把资源物化到目标工作区。

这一版的包导入范围包括：

- Pi package
- MCP deployment
- Agent（包括子 Agent、Skill 和 MCP 依赖）
- Assistant（包括允许的远程 MCP 依赖）
- Skill（作为独立资源或上述资源的依赖）

导入器不接受工作区中的现有资源作为包源。以下入口应删除或停用：

- 从当前工作区组合 Pi package 的 `PiPackageComposeForm` 和 `/market/compose`。
- 直接把当前工作区 MCP deployment 发布为市场资源的表单，以及 `/market/import` 中的内联 MCP 创建表单。
- 从当前工作区 Agent 或 Assistant 发布市场版本的表单和对应的本地发布路径。
- 以 npm 包地址作为 Pi package 的市场导入源。npm 可以作为包内部的锁定依赖，但不能作为这一版的包来源。

已经存在的市场审核、已批准版本安装、版本撤回和 listing 管理继续保留。ZIP 导入不是任意资源上传：它必须是符合本标准的完整 ToolPlane 包。

## 2. 包目录布局

包的根目录必须只有一个 `toolplane.json` 作为索引。资源文件的路径由索引引用，路径必须使用 `/` 分隔并且相对于包根目录。

推荐布局：

```text
my-toolplane-package/
├── toolplane.json
├── resources/
│   ├── skills/<skill-id>/SKILL.md
│   ├── skills/<skill-id>/files/*
│   ├── mcp/<mcp-id>.json
│   ├── pi/<pi-id>/manifest.json
│   ├── pi/<pi-id>/package/*
│   ├── agents/<agent-id>.json
│   └── assistants/<assistant-id>.json
├── LICENSE
└── README.md
```

`LICENSE` 和 `README.md` 可选，但推荐提供。包中不得包含 `.env`、私钥、云凭据、会话文件、数据库、构建缓存或 `node_modules`。

## 3. 根索引 `toolplane.json`

根索引使用 UTF-8 JSON，不允许未知字段。字段定义如下：

```json
{
  "schemaVersion": 1,
  "kind": "toolplane-package",
  "id": "com.example.crm-agent",
  "version": "1.0.0",
  "name": "CRM Agent",
  "summary": "查询 CRM 并生成跟进摘要",
  "description": "可选的较长说明",
  "author": {
    "name": "Example Org",
    "url": "https://github.com/example"
  },
  "license": "Apache-2.0",
  "tags": ["crm", "sales"],
  "resources": [
    {
      "id": "crm-mcp",
      "kind": "mcp",
      "manifest": "resources/mcp/crm-mcp.json"
    },
    {
      "id": "crm-agent",
      "kind": "agent",
      "manifest": "resources/agents/crm-agent.json"
    }
  ]
}
```

### 3.1 根字段规则

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | 必须为数字 `1`。未来不兼容版本增加版本号，不静默解释旧字段。 |
| `kind` | 必须为 `toolplane-package`。 |
| `id` | 稳定的反向域名或组织命名空间加 slug；推荐 `^[a-z0-9]+([.-][a-z0-9]+)*$`，长度不超过 120。 |
| `version` | SemVer 版本；发布后同一 `id` 和 `version` 的内容不能改变。 |
| `name` | 1 至 240 个字符。 |
| `summary` | 1 至 4000 个字符，不能包含凭据。 |
| `description` | 可选，最多 200000 个字符。 |
| `author` | 可选对象；URL 只能使用 HTTPS。 |
| `license` | 可选 SPDX 标识符。 |
| `tags` | 最多 20 个，导入器会去重并限制长度。 |
| `resources` | 至少一个资源；每个 `id` 在包内唯一，`manifest` 必须指向包内 JSON 或资源入口文件。 |

根索引不携带 GitHub branch、`latest`、浮动 npm tag 或工作区 ID。导入来源由 ToolPlane 在导入时记录，不能由包作者伪造。

本目录同时提供机器可校验的根索引草案 [`toolplane-package.schema.json`](./toolplane-package.schema.json)。JSON Schema 负责字段形状和基础长度检查；路径安全、资源专用 manifest、来源 pin 和秘密扫描仍必须由服务端校验器完成。

## 4. GitHub 和 ZIP 导入协议

### 4.1 GitHub

GitHub 导入只接受公开仓库的 HTTPS URL：

```text
https://github.com/<owner>/<repo>
```

导入请求必须同时提供 40 位 commit SHA。禁止导入 branch、tag、`main`、`master` 或未固定的 `HEAD`。导入器应按以下顺序执行：

1. 解析并规范化仓库 URL，只允许 `github.com` 主机和 HTTPS。
2. 使用 GitHub 内容 API 或受限的 git fetch 读取指定 commit。
3. 在该 commit 下寻找根目录 `toolplane.json`；不接受在仓库中任意搜索多个候选包。
4. 计算包内容的规范化 SHA-256，展示 commit、文件数、总大小和资源摘要。
5. 执行 manifest 校验、路径校验、依赖校验和秘密扫描。
6. 用户确认后，创建不可变导入版本；后续安装只使用该 commit 和内容摘要。

GitHub 仓库可以包含测试、源码和文档，但只有 `toolplane.json` 引用的文件进入资源版本。导入器不能执行仓库中的安装脚本、构建脚本或 GitHub Actions。

### 4.2 ZIP

ZIP 上传只接受一个完整的 ToolPlane 包。ZIP 根目录可以直接包含 `toolplane.json`，也可以只有一层目录包裹；导入器必须把包根规范化后再校验。存在多个 `toolplane.json`、没有索引或包含目录穿越时，直接拒绝。

ZIP 处理要求：

- 拒绝绝对路径、`..`、NUL 字符、重复规范化路径和符号链接。
- 解压前检查压缩包条目数、压缩后大小和单文件大小，防止 zip bomb。
- 只允许常规文件和目录；忽略或拒绝 Unix 特殊文件。
- 解压后重新计算每个文件的 SHA-256 和整个包的 SHA-256。
- 不执行任何脚本，不调用 `postinstall`，不自动安装依赖。
- 将 ZIP 的内容摘要和上传者记录到导入版本；同一摘要的重复导入应幂等。

第一版实现必须至少复用现有 Pi package capture 的限制：ZIP 压缩包不超过 32 MiB、最多 4096 个条目、单文件和解压后快照遵守现有的 8/16 MiB 与 64/96 MiB 限制；统一包可以采用更严格的上限，但不能放宽它们。根 manifest 仍遵守 4 MiB 限制。实现时应集中配置这些限制，并在预览错误中显示实际命中的上限。

## 5. 资源清单

除 Skill 可以把 `SKILL.md` 作为内容入口外，每种资源的 `manifest` 文件必须是 JSON，并且只能描述声明式配置。ToolPlane 已有的资源校验器应作为规范的实现来源：

- Agent 使用现有 Agent release manifest v1 的字段和引用关系。
- Assistant 使用现有 Assistant market manifest v1 的字段和 MCP requirement 关系。
- Pi 使用现有 `pi-package` manifest v1 的文件、目录、符号链接安全检查和 checksum 规则。
- MCP 使用现有 portable MCP recipe 的来源、命令、传输和凭据约束。
- Skill 使用现有 Skill 文件和内容校验规则。

导入器可以把这些资源清单包在统一索引中，但不能降低各自现有校验器的限制。

### 5.1 Skill

Skill 资源至少包含一个 `SKILL.md`。推荐使用资源 JSON 作为 `manifest` 并引用内容文件；为兼容简单 Skill，也可以把 `SKILL.md` 作为该资源的入口文件。

```json
{
  "schemaVersion": 1,
  "kind": "skill",
  "id": "crm-follow-up",
  "name": "CRM follow-up",
  "description": "生成客户跟进摘要",
  "content": "resources/skills/crm-follow-up/SKILL.md",
  "files": [
    "resources/skills/crm-follow-up/files/example.json"
  ],
  "userInvocable": true,
  "agentInvocable": true,
  "effort": "default"
}
```

Skill 文本和附属文件必须经过路径检查和秘密扫描。Skill 不能在导入时写入工作区外的路径。

### 5.2 MCP

MCP 资源只能是可移植 recipe。示例：

```json
{
  "schemaVersion": 1,
  "kind": "mcp",
  "id": "crm-mcp",
  "name": "CRM MCP",
  "source": "npm",
  "sourceRef": "@example/crm-mcp@1.4.2",
  "command": "npx",
  "args": ["-y", "@example/crm-mcp@1.4.2"],
  "requiredEnv": ["CRM_API_TOKEN"],
  "publicEnv": {
    "CRM_REGION": "us-east-1"
  },
  "network": "none",
  "mcpToolExposure": "allowlist",
  "mcpAllowedTools": ["customers.search", "customers.get"]
}
```

约束：

- `sourceRef` 必须是不可变版本。npm/PyPI 用精确版本，GitHub 用完整 commit，Docker 用 digest；不能使用 `latest`、范围版本或浮动 branch。
- `requiredEnv` 只列环境变量名；包中不能出现对应值、值的编码、值的 hash 或凭据文件。
- `publicEnv` 只能包含明确公开且无敏感性的默认值。
- 命令只能使用现有 portable MCP recipe 允许的启动方式；不得通过 `sh -c`、PowerShell 或下载后执行的方式绕过限制。
- 远程 MCP 只接受 HTTPS；认证只声明 bearer/header 的变量名，实际值在安装设置页填写。
- 默认使用 allowlist 暴露工具。`all` 只有在审核允许时才能使用。

导入 MCP 不会创建一个立即运行的工作区 deployment。它先创建待设置的安装记录，用户填写凭据并显式授权后才可启动。

### 5.3 Pi package

Pi 资源的 `manifest` 必须符合现有 `pi-package` manifest v1，并将包文件放在 `package/` 下。新导入器只允许通过外部 GitHub 仓库或完整 ZIP 取得 Pi 文件；不再提供从当前工作区 Skill/MCP 组合 Pi package 的入口，也不接受 npm URL 作为独立导入源。

Pi manifest 必须：

- 固定 `schemaVersion`、运行时 Node major、Pi SDK 版本和资源类型。
- 为每个文件提供规范化路径、编码、大小和 SHA-256。
- 拒绝目录穿越、绝对路径和不安全符号链接。
- 只声明 extensions、skills、prompts、themes 等受支持资源。
- 通过现有 secret scan；扩展代码不会在预览阶段执行。

包内部可以有 `package.json` 和 lockfile，但依赖必须精确锁定，安装器不能根据未锁定的范围重新解析版本。

### 5.4 Agent

Agent 资源使用现有 Agent release manifest v1 的结构，至少包含一个 `rootAgentKey`。它可以包含：

- Pi 或受支持的 Hermes runtime 声明。
- system prompt、最大步骤数和模型要求。
- 子 Agent 图，最多 64 个 Agent。
- portable MCP deployment、Skill 和扁平化资源引用，资源总数遵守现有上限。

Agent manifest 不得包含工作区 ID、deployment ID、provider ID、sandbox ID、会话记录、凭据或 runtime 状态。Hermes 的私有 prompt 不能被写进市场包；MCP 只能引用已验证的 portable recipe。安装时 Agent 以 `needs_setup` 状态创建，模型和环境变量必须由目标工作区重新授权。

### 5.5 Assistant

Assistant 资源使用现有 Assistant market manifest v1 的结构：名称、system prompt、最大步骤数、模型要求、模型参数和 MCP requirements。MCP requirement 只能引用包中声明的 MCP 或平台已验证的 catalog MCP，并且必须限制允许的工具名。

Assistant manifest 不得携带对话历史、用户身份、workspace ID、provider secret、MCP credential 或自动发布信息。安装后需要目标工作区绑定模型提供商和环境变量。

## 6. 完整性、隐私和执行安全

导入器必须在资源落库前完成以下检查：

1. JSON schema 和未知字段检查。
2. 所有引用路径位于包根且只解析到包内文件。
3. 文件数量、大小、manifest 大小和资源图大小限制。
4. 每个资源的专用校验器和 checksum 校验。
5. secret scan：token、私钥、连接串、`.env` 内容、凭据编码和疑似 API key 都应阻断或进入人工审核。
6. MCP source pin、命令白名单、远程 URL 和工具 allowlist 检查。
7. GitHub commit 或 ZIP 内容摘要记录。

预览阶段只做读取、解析和扫描；禁止执行包中代码、安装依赖、启动 MCP、创建 Agent runtime 或访问用户凭据。发布和安装也必须通过现有的 workspace owner/admin 授权和市场审核边界。

## 7. 导入状态和用户流程

统一入口建议为 `/market/import`：

1. 用户选择 `GitHub commit` 或 `ZIP`。
2. 输入来源并点击“预览”。
3. ToolPlane 展示包名、版本、来源、内容摘要、资源清单、模型要求、环境变量名称、MCP 工具 allowlist 和风险扫描结果。
4. 只有校验通过且用户确认后，才创建 draft import/release。
5. 市场资源进入现有审核流程；工作区安装资源进入 `needs_setup`，等待模型和凭据授权。

以下旧入口应统一删除或重定向：

| 旧入口 | 处理 |
| --- | --- |
| `/market/compose` | 重定向到 `/market/import`，不再显示本地组合表单。 |
| `/market/publish` 的本地 MCP/Agent/Assistant/Pi 卡片 | 删除；页面只保留已导入 listing 的版本管理。 |
| `/market/import?type=pi` 的 npm source 和 composition | 删除，只保留 GitHub commit/ZIP 包预览。 |
| `/market/import?type=mcp` 的内联 deployment 创建 | 删除，改为包中的 MCP manifest。 |
| Agent `/publish` 和 Assistant 本地 publish 表单 | 删除；改由包导入后的审核/版本管理完成。 |

## 8. 作者最小示例

一个只包含 Assistant 和 MCP 的包至少需要：

```text
toolplane.json
resources/mcp/crm-mcp.json
resources/assistants/crm-assistant.json
```

作者提交 GitHub 时应提供一个不可变 commit；作者提供 ZIP 时应从包根压缩并保留 `toolplane.json`。包作者不需要提供 API key，也不需要在本地启动 MCP。导入后，使用者在目标工作区的设置流程中填写 `CRM_API_TOKEN` 并选择模型提供商。

## 9. 实现验收标准

实现完成后至少应有以下测试：

- GitHub branch、tag、非 GitHub URL、缺少 commit SHA 都被拒绝。
- ZIP 中的 `../x`、绝对路径、符号链接、重复索引、zip bomb 和缺失 `toolplane.json` 都被拒绝。
- 包中出现 `.env`、私钥、API key、MCP secret value 或 Agent workspace ID 都被阻断。
- 未锁定的 npm/PyPI/GitHub/Docker MCP 依赖都被拒绝。
- Pi、Agent、Assistant manifest 的 checksum 不匹配时不能创建 release。
- 预览阶段不创建 deployment、Agent runtime 或执行扩展代码。
- 同一 GitHub commit 或 ZIP 摘要重复导入是幂等的。
- Agent 安装初始状态为 `needs_setup`，环境变量只保存名称，模型和凭据必须重新授权。
- 旧的 composition、inline MCP create、local Agent/Assistant publish UI 不再可达；旧 URL 返回重定向或明确的 410，而不是继续接受旧 payload。

  "kind": "mcp",
  "id": "crm-mcp",
  "name": "CRM MCP",
  "source": "npm",
  "sourceRef": "@example/crm-mcp@1.4.2",
  "command": "npx",
  "args": ["-y", "@example/crm-mcp@1.4.2"],
  "requiredEnv": ["CRM_API_TOKEN"],
  "publicEnv": {
    "CRM_REGION": "us-east-1"
  },
  "network": "none",
  "mcpToolExposure": "allowlist",
  "mcpAllowedTools": ["customers.search", "customers.get"]
}
```

约束：

- `sourceRef` 必须是不可变版本。npm/PyPI 用精确版本，GitHub 用完整 commit，Docker 用 digest；不能使用 `latest`、范围版本或浮动 branch。
- `requiredEnv` 只列环境变量名；包中不能出现对应值、值的编码、值的 hash 或凭据文件。
- `publicEnv` 只能包含明确公开且无敏感性的默认值。
- 命令只能使用现有 portable MCP recipe 允许的启动方式；不得通过 `sh -c`、PowerShell 或下载后执行的方式绕过限制。
- 远程 MCP 只接受 HTTPS；认证只声明 bearer/header 的变量名，实际值在安装设置页填写。
- 默认使用 allowlist 暴露工具。`all` 只有在审核允许时才能使用。

导入 MCP 不会创建一个立即运行的工作区 deployment。它先创建待设置的安装记录，用户填写凭据并显式授权后才可启动。

### 5.3 Pi package

Pi 资源的 `manifest` 必须符合现有 `pi-package` manifest v1，并将包文件放在 `package/` 下。新导入器只允许通过外部 GitHub 仓库或完整 ZIP 取得 Pi 文件；不再提供从当前工作区 Skill/MCP 组合 Pi package 的入口，也不接受 npm URL 作为独立导入源。

Pi manifest 必须：

- 固定 `schemaVersion`、运行时 Node major、Pi SDK 版本和资源类型。
- 为每个文件提供规范化路径、编码、大小和 SHA-256。
- 拒绝目录穿越、绝对路径和不安全符号链接。
- 只声明 extensions、skills、prompts、themes 等受支持资源。
- 通过现有 secret scan；扩展代码不会在预览阶段执行。

包内部可以有 `package.json` 和 lockfile，但依赖必须精确锁定，安装器不能根据未锁定的范围重新解析版本。

### 5.4 Agent

Agent 资源使用现有 Agent release manifest v1 的结构，至少包含一个 `rootAgentKey`。它可以包含：

- Pi 或受支持的 Hermes runtime 声明。
- system prompt、最大步骤数和模型要求。
- 子 Agent 图，最多 64 个 Agent。
- portable MCP deployment、Skill 和扁平化资源引用，资源总数遵守现有上限。

Agent manifest 不得包含工作区 ID、deployment ID、provider ID、sandbox ID、会话记录、凭据或 runtime 状态。Hermes 的私有 prompt 不能被写进市场包；MCP 只能引用已验证的 portable recipe。安装时 Agent 以 `needs_setup` 状态创建，模型和环境变量必须由目标工作区重新授权。

### 5.5 Assistant

Assistant 资源使用现有 Assistant market manifest v1 的结构：名称、system prompt、最大步骤数、模型要求、模型参数和 MCP requirements。MCP requirement 只能引用包中声明的 MCP 或平台已验证的 catalog MCP，并且必须限制允许的工具名。

Assistant manifest 不得携带对话历史、用户身份、workspace ID、provider secret、MCP credential 或自动发布信息。安装后需要目标工作区绑定模型提供商和环境变量。

## 6. 完整性、隐私和执行安全

导入器必须在资源落库前完成以下检查：

1. JSON schema 和未知字段检查。
2. 所有引用路径位于包根且只解析到包内文件。
3. 文件数量、大小、manifest 大小和资源图大小限制。
4. 每个资源的专用校验器和 checksum 校验。
5. secret scan：token、私钥、连接串、`.env` 内容、凭据编码和疑似 API key 都应阻断或进入人工审核。
6. MCP source pin、命令白名单、远程 URL 和工具 allowlist 检查。
7. GitHub commit 或 ZIP 内容摘要记录。

预览阶段只做读取、解析和扫描；禁止执行包中代码、安装依赖、启动 MCP、创建 Agent runtime 或访问用户凭据。发布和安装也必须通过现有的 workspace owner/admin 授权和市场审核边界。

## 7. 导入状态和用户流程

统一入口建议为 `/market/import`：

1. 用户选择 `GitHub commit` 或 `ZIP`。
2. 输入来源并点击“预览”。
3. ToolPlane 展示包名、版本、来源、内容摘要、资源清单、模型要求、环境变量名称、MCP 工具 allowlist 和风险扫描结果。
4. 只有校验通过且用户确认后，才创建 draft import/release。
5. 市场资源进入现有审核流程；工作区安装资源进入 `needs_setup`，等待模型和凭据授权。

以下旧入口应统一删除或重定向：

| 旧入口 | 处理 |
| --- | --- |
| `/market/compose` | 重定向到 `/market/import`，不再显示本地组合表单。 |
| `/market/publish` 的本地 MCP/Agent/Assistant/Pi 卡片 | 删除；页面只保留已导入 listing 的版本管理。 |
| `/market/import?type=pi` 的 npm source 和 composition | 删除，只保留 GitHub commit/ZIP 包预览。 |
| `/market/import?type=mcp` 的内联 deployment 创建 | 删除，改为包中的 MCP manifest。 |
| Agent `/publish` 和 Assistant 本地 publish 表单 | 删除；改由包导入后的审核/版本管理完成。 |

## 8. 作者最小示例

一个只包含 Assistant 和 MCP 的包至少需要：

```text
toolplane.json
resources/mcp/crm-mcp.json
resources/assistants/crm-assistant.json
```

作者提交 GitHub 时应提供一个不可变 commit；作者提供 ZIP 时应从包根压缩并保留 `toolplane.json`。包作者不需要提供 API key，也不需要在本地启动 MCP。导入后，使用者在目标工作区的设置流程中填写 `CRM_API_TOKEN` 并选择模型提供商。

## 9. 实现验收标准

实现完成后至少应有以下测试：

- GitHub branch、tag、非 GitHub URL、缺少 commit SHA 都被拒绝。
- ZIP 中的 `../x`、绝对路径、符号链接、重复索引、zip bomb 和缺失 `toolplane.json` 都被拒绝。
- 包中出现 `.env`、私钥、API key、MCP secret value 或 Agent workspace ID 都被阻断。
- 未锁定的 npm/PyPI/GitHub/Docker MCP 依赖都被拒绝。
- Pi、Agent、Assistant manifest 的 checksum 不匹配时不能创建 release。
- 预览阶段不创建 deployment、Agent runtime 或执行扩展代码。
- 同一 GitHub commit 或 ZIP 摘要重复导入是幂等的。
- Agent 安装初始状态为 `needs_setup`，环境变量只保存名称，模型和凭据必须重新授权。
- 旧的 composition、inline MCP create、local Agent/Assistant publish UI 不再可达；旧 URL 返回重定向或明确的 410，而不是继续接受旧 payload。

