# Agents 功能设计（`/app/[workspace]/agents`）

> 状态：已与用户对齐，待最终评审。分支：`feat/agents`（基于 `feat/p1a-foundation`）。
> 目标：把 `/agents` 从「Coming soon」占位升级为真实可用的 Agent：**配置模型 + 配置 MCP/skill/toolkit + 流式聊天并自动调用工具**。

---

## 1. 背景与目标

现状：`/app/[workspace]/agents` 是占位页；项目**无任何 LLM 集成**。已有能力：MCP 子进程 + JSON-RPC 网关（`tools/list`/`tools/call`）、已安装 Skill（`SKILL.md` 文本）、Toolkit（MCP+skill 组合）。

本功能新增一条**真实 LLM 调用回路**：用户在工作区里维护「模型供应商」，创建 Agent（选模型 + 勾选工具），在聊天界面与之对话；模型可自动 `tools/call` 工作区里运行中的 MCP 工具，最终流式回复并落库。

## 2. 范围

**做（首版）**
- 工作区级 **Model Providers**：OpenAI 格式 + Anthropic 格式，各配 `baseUrl / apiKey / 缓存的 models`，模型列表从 baseUrl 动态拉取。
- **Agent** CRUD：名字、system prompt、provider+model、勾选 MCP/skill/toolkit、maxSteps。
- **流式聊天**：自动多轮工具循环（MCP 工具），skill 注入系统提示，消息持久化、多会话可回看。

**不做（后续增量）**
- API Key 加密（首版明文）、人工确认工具调用、流式 tool-use 的细粒度 UI（首版用 AI SDK 默认渲染）、Agent 定时/事件触发、跨工作区共享 Agent。

## 3. 决策摘要

| 维度 | 决定 |
|---|---|
| 模型后端 | OpenAI 格式 + Anthropic 格式两种兼容接口 |
| Provider 配置 | **工作区级**列表，**明文**存储，**workspace 共享** |
| Provider UI 位置 | Agents 页内 **Model Providers** 标签 |
| 拉模型 | 服务端 action 用存的 key 打 `{baseUrl}/models`，结果缓存进 `ModelProvider.models` |
| 工具挂载 | Agent 多选**单个 MCP + 单个 skill**，可选再加 **toolkit**（运行时并集去重） |
| skill 语义 | 所选 `SKILL.md` 注入 system prompt；MCP 才是可 `tools/call` 的工具 |
| 持久化 | 全量：`ModelProvider` `Agent` `AgentServer` `AgentSkill` `AgentToolkit` `Conversation` `Message` |
| 聊天回路 | 流式（SSE）+ 自动执行工具，`maxSteps` 上限 |
| 实现路线 | **Vercel AI SDK**（`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible` + `@ai-sdk/react`） |
| 聊天端点 | `POST /api/v1/agents/[agentId]/chat`，`resolveRequestUser` 鉴权 |

## 4. 数据模型（新增 Prisma 模型）

```prisma
model ModelProvider {
  id              String    @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name            String                       // 展示名，工作区内唯一
  format          String                       // "openai" | "anthropic"
  baseUrl         String                       // 含版本段的完整根，见 §8
  apiKey          String                       // 明文（个人学习项目）
  models          String[]   @default([])      // 缓存的 model id
  modelsFetchedAt DateTime?
  createdAt       DateTime  @default(now())
  agents          Agent[]
  @@unique([workspaceId, name])
}

model Agent {
  id            String    @id @default(cuid())
  workspaceId   String
  workspace     Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name          String
  slug          String
  systemPrompt  String?
  providerId    String?
  provider      ModelProvider? @relation(fields: [providerId], references: [id], onDelete: SetNull)
  model         String?                        // 选中的 model id
  maxSteps      Int       @default(8)
  createdAt     DateTime  @default(now())
  servers       AgentServer[]
  skills        AgentSkill[]
  toolkits      AgentToolkit[]
  conversations Conversation[]
  @@unique([workspaceId, slug])
}

model AgentServer {
  agentId      String
  deploymentId String
  agent        Agent      @relation(fields: [agentId], references: [id], onDelete: Cascade)
  deployment   Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  @@id([agentId, deploymentId])
}

model AgentSkill {
  agentId          String
  installedSkillId String
  agent            Agent          @relation(fields: [agentId], references: [id], onDelete: Cascade)
  installedSkill   InstalledSkill @relation(fields: [installedSkillId], references: [id], onDelete: Cascade)
  @@id([agentId, installedSkillId])
}

model AgentToolkit {
  agentId   String
  toolkitId String
  agent     Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)
  toolkit   Toolkit @relation(fields: [toolkitId], references: [id], onDelete: Cascade)
  @@id([agentId, toolkitId])
}

model Conversation {
  id        String    @id @default(cuid())
  agentId   String
  agent     Agent     @relation(fields: [agentId], references: [id], onDelete: Cascade)
  title     String?
  createdAt DateTime  @default(now())
  messages  Message[]
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  role           String       // "user" | "assistant"
  parts          Json         // AI SDK UIMessage.parts（text / tool-call / tool-result 分段）
  createdAt      DateTime     @default(now())
}
```

反向关系需在现有模型上补：`Workspace.modelProviders`/`agents`、`Deployment.agentServers`、`InstalledSkill.agentSkills`、`Toolkit.agentToolkits`。
迁移：`prisma migrate dev --name add_agents`。**改 schema 后必须重启 dev server**（见 ARCHITECTURE §13）。

## 5. 目录与路由

| 路径 | 作用 |
|---|---|
| `src/app/app/[workspace]/agents/page.tsx` | Agents 列表 + New agent；顶部 tab 切 **Model Providers**（`?tab=providers`） |
| `src/app/app/[workspace]/agents/[agentId]/page.tsx` | Agent 详情，tab **Chat**(默认)/**Settings**（`?tab=`） |
| `src/app/api/v1/agents/[agentId]/chat/route.ts` | 流式聊天端点（`runtime='nodejs'`，`maxDuration=60`） |
| `src/lib/agents/queries.ts` | `listAgents` `getAgent`(含关系) `listProviders` `getConversation`(含 messages) `listConversations` |
| `src/lib/agents/actions.ts` | Agent/Provider/Conversation CRUD、`refreshModels`、消息落库 helper（全部工作区鉴权） |
| `src/lib/agents/model.ts` | `buildModel(provider, modelId)` → AI SDK 模型实例 |
| `src/lib/agents/tools.ts` | `buildToolSet(agent)` → AI SDK `ToolSet`（MCP→tool） |
| `src/lib/agents/system-prompt.ts` | `assembleSystemPrompt(agent)` → 拼 systemPrompt + 所选 skills 的 `SKILL.md` |
| `src/components/dashboard/agents/*` | `AgentsBrowser`、`ProvidersPanel`、`AgentSettingsForm`、`AgentChat`（客户端组件） |

**Settings tab**：名字 / system prompt / provider 下拉 / model 下拉（来自该 provider 缓存的 `models` + 「Refresh models」按钮）/ MCP·skill·toolkit 勾选框 / maxSteps。
**收尾**：去掉 `DashboardSidebar` 中 Agents 的 `badge: 'Coming soon'`。

## 6. Provider 与动态拉模型（§8 细节集中处）

约定：**`baseUrl` 存「含版本段的完整根」**，使两种格式的拉模型路径统一为 `${baseUrl}/models`：
- openai 占位示例：`https://api.openai.com/v1` → 拉 `https://api.openai.com/v1/models`
- anthropic 占位示例：`https://api.anthropic.com/v1` → 拉 `https://api.anthropic.com/v1/models`

`refreshModels(providerId)`（server action）：
1. 工作区鉴权 → 取 provider。
2. `GET ${baseUrl}/models`，按 format 设鉴权头：
   - openai：`Authorization: Bearer ${apiKey}`
   - anthropic：`x-api-key: ${apiKey}` + `anthropic-version: 2023-06-01`
3. 解析 `{ data: [{ id }] }` → 取 `id[]`，写回 `models` + `modelsFetchedAt`。
4. 失败（网络/鉴权/格式）→ 返回 `{ error: string }`，UI 红字显示，不抛。

`buildModel(provider, modelId)`：
- `format==='anthropic'` → `createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId)`
- 否则 → `createOpenAICompatible({ name: provider.name, baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId)`

## 7. 工具构建（MCP → ToolSet）+ skill 注入

`buildToolSet(agent)`：
1. 计算 Agent 的有效 deployment 集 = 直选 `servers` ∪ 各 `toolkits` 展开的 servers，去重。
2. 仅保留**运行中**的 deployment（`liveStatus`）；停掉的跳过（UI 在 Settings 标注「未运行，已跳过」）。
3. 对每个 deployment `listMcpTools(deploymentId)`，每个工具生成：
   ```ts
   tool({
     description: t.description,
     inputSchema: jsonSchema(t.inputSchema),      // MCP 即 JSON Schema，无需转 Zod
     execute: async (args) =>
       mcpRpc(deploymentId, 'tools/call', { name: t.name, arguments: args }),
   })
   ```
   ToolSet key = `${sanitize(deployment)}__${sanitize(t.name)}`，保证唯一且匹配 `^[A-Za-z0-9_-]+$`；execute 闭包已绑定 `deploymentId`+真实 `t.name`，无需额外映射表。
4. MCP 不可达/报错 → `execute` 返回错误结果（不抛），让模型自行恢复，UI 显示该工具失败。

`assembleSystemPrompt(agent)` = `agent.systemPrompt`（若有）+ 每个所选 skill 经 `buildSkillMarkdown(skill)` 的 `SKILL.md`，以分隔标题串接。

## 8. 聊天回路时序

```
[Client] AgentChat: useChat({ api:'/api/v1/agents/[id]/chat', body:{ conversationId } })
   │  initialMessages 来自 getConversation(conversationId).messages → UIMessage[]
   ▼
[POST /chat]
   1. resolveRequestUser(req) → 校验 agent 属于该用户工作区（否则 401/403）
   2. 取 body.messages 的最后一条 user message → 落库（role=user）
   3. provider/model 缺失 → 返回 400 + 友好错误（聊天框显示）
   4. model = buildModel(provider, agent.model)
   5. tools = await buildToolSet(agent)
   6. system = assembleSystemPrompt(agent)
   7. streamText({ model, system,
        messages: convertToModelMessages(body.messages),
        tools, stopWhen: stepCountIs(agent.maxSteps) })   // v5 step-count 停止条件
   8. return result.toUIMessageStreamResponse({
        originalMessages: body.messages,
        onFinish: ({ responseMessage }) => 落库(role=assistant, parts)
      })
```

**会话创建**：Chat tab 加载时取该 Agent 最近一条会话；无则「New chat」按钮调 `createConversation(agentId)` 显式建。聊天 POST 始终带真实 `conversationId`（避免经流返回新 id 的复杂度）。
**持久化策略**：每次只写「最后的 user 消息」+「assistant 响应消息」，不重存历史（历史由 client 从 DB 初始化后随 useChat 携带）。

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| Agent 未配 provider/model | `/chat` 返回 400 + 文案，聊天框红字 |
| refreshModels 失败 | action 返回 `{error}`，Providers 面板红字，不抛 |
| 选中的 MCP 未运行 | `buildToolSet` 跳过 + Settings 标注；不阻断聊天 |
| 工具执行失败 | `execute` 返回错误结果，模型可恢复，UI 显示工具错误 |
| 流/上游错误 | AI SDK `onError` → 聊天框提示 |
| 死循环 | `stopWhen: stepCountIs(maxSteps)` 上限（默认 8） |
| 鉴权失败 | `resolveRequestUser` 无果或跨工作区 → 401/403 |

## 10. 测试策略

- **单元**：`assembleSystemPrompt`（skill 注入顺序/分隔）、ToolSet key 生成与防撞/非法字符、`buildModel` 的 format→工厂选择、双格式 model-list 解析、消息 parts→DB 映射。
- **集成**：Agent/Provider/Conversation CRUD + 工作区鉴权；`refreshModels`（mock `fetch`，两种 format 头部断言）；`buildToolSet`（mock `listMcpTools`/`liveStatus`/`mcpRpc`）。
- **手动 E2E**：对 smoke 工作区配真 key → 建 Agent → 勾运行中的 MCP → 聊天触发一次工具调用 → 验证流式回复 + 落库可回看。
- 纯逻辑全部覆盖；流式 + 真 LLM 不进自动化（需真实凭据）。沿用 `tests/stubs` 对 `server-only` 的替身。

## 11. 依赖与兼容性风险

新增依赖：`ai`、`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible`、`@ai-sdk/react`、`zod`（peer）。

> **实装第 1 步（前置验证）**：安装后先在一个临时最小路由跑通「流式 + 一个假工具」的 demo，确认 **Next 16.2.9 + React 19.2 + AI SDK v5** 兼容、`useChat` 在 App Router 正常。通过再继续；若不兼容，回退到锁定 AI SDK 兼容版本或评估路线 2。
> AI SDK v5 的精确导出名（`stepCountIs` vs `isStepCount`、`jsonSchema`、`convertToModelMessages`、`toUIMessageStreamResponse`）以安装版本为准，本设计以行为为契约。

## 12. 实施顺序（概览，详细计划见 writing-plans）

1. 装依赖 + 最小流式 demo 验兼容。
2. Prisma 模型 + 迁移 + 重启 dev。
3. `lib/agents/*`（queries/actions/model/tools/system-prompt）+ 单元/集成测试（TDD）。
4. Providers 面板（CRUD + refreshModels）。
5. Agents 列表 + 新建 + Settings 表单。
6. `/chat` 路由 + `AgentChat` 客户端 + 持久化。
7. 去 sidebar「Coming soon」徽章；手动 E2E；收尾。
