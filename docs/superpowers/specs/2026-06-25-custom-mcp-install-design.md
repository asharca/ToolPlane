# 设计:从 npm 安装自定义 MCP(真实运行)

> 日期:2026-06-25 · 状态:已批准设计,待实现计划
> 主题:控制台 `/app/[workspace]/mcp` 的 "Deploy custom MCP" —— 让 workspace 安装目录之外的、真实可运行的 MCP server。

## 1. 目标与范围

让用户从 **npm** 安装一个**真实的** MCP server(例如 `@modelcontextprotocol/server-everything`),它作为真实子进程运行,并接入现有网关,使其工具在检查器、ToolPlayground 和 agent 中**立即可用**。

**完成边界(完整纵向切片)**:slide-over 表单 → 真实启动 npm server → 出现在 `/mcp` 列表(运行中,可 start/stop/remove)→ 检查器看到真实 tools 并可在 ToolPlayground 调用 → 可被 agent 使用。

**本次只做 npm。** PyPI(uvx)/GitHub/Docker 留扩展点与 UI 占位。

## 2. 锁定的决策

| 维度 | 决策 |
|---|---|
| 运行时 | 真实执行;npm/npx 优先;通过 **stdio↔HTTP 桥接**复用现有 HTTP JSON-RPC 网关 |
| 桥接方式 | 新增 bridge 脚本(方案 A1),网关/supervisor/mcp-client/tools.ts/ToolPlayground/agent **零改动** |
| 数据模型 | `Deployment.serverId` 改可空 + 加来源字段(方案 B1),自定义安装**不进**公开 `Server` 目录 |
| 配置输入 | 包名 + 显示名 + 环境变量(key/value)+ 命令行参数 |
| 密钥存储 | 明文存 `installCfg`,与现有 `ModelProvider.apiKey` 惯例一致 |
| 来源 UI | 4 个标签全显示;仅 npm 可用,其余置灰 "Coming soon" |

## 3. 关键约束(为何 bridge 不是透明代理)

- 现有 `mcpRpc`(`src/lib/process/mcp-client.ts`)每次是**独立无状态**的单条 HTTP POST(`id: Date.now()`),**从不发送 `initialize`**。网关、ToolPlayground、agent toolset 全部经它。
- 真实 stdio MCP server 是**有状态**的:必须在同一条 stdio 连接上先 `initialize` + `notifications/initialized`,之后才能 `tools/list` / `tools/call`。
- 因此 bridge 必须:**持有一条到子进程的持久 stdio 连接**、在启动时替子进程完成一次握手、再把每个进来的 HTTP JSON-RPC 请求转发到这条长连接上。它需用**自己的单调 id** 重映射转发(避免并发下 `Date.now()` 撞 id),并在内部维护 `pending: Map<childId, {origId, resolve}>`。

## 4. 架构与数据流

```
Slide-over form ──▶ deployCustomServerAction (auth + zod + create Deployment)
                         │  serverId=null, source=npm, sourceRef=<pkg>, installCfg={env,args}
                         ▼
                 supervisor.startProcess(id, spec)   // spec.kind='bridge'
                         ▼  spawn: node scripts/mcp-stdio-bridge.mjs
   ┌────────────────────────────────────────────────────────────┐
   │ bridge: spawn `npx -y <pkg> <args>` with custom env        │
   │   1. initialize + initialized handshake over child stdio   │
   │   2. After handshake, listen HTTP and print LISTENING      │
   │   3. POST /: forward JSON-RPC to persistent stdio link     │
   │   4. GET /health; ppid watchdog exits when parent dies     │
   └────────────────────────────────────────────────────────────┘
                         ▲ Existing path unchanged:
   Gateway /mcp/[id]/rpc ─┤  fetch 127.0.0.1:<port>  (mcpRpc)
   ToolPlayground / agent ┘  tools/list, tools/call
```

对系统其余部分而言,bridge 与老的 `scripts/mcp-server.mjs` **完全同构**(都打印 `LISTENING <port>`、都服务 HTTP JSON-RPC),所以检查器 / ToolPlayground / agent toolset **自动可用**,无需改动。

## 5. 数据模型(Prisma,B1)

`Deployment` 改动:

- `serverId String?`(可空)、`server Server? @relation(..., onDelete: Cascade)`(可空)
- 新增 `name String?` —— 自定义部署的显示名
- 新增 `source String?` —— `npm` | `pypi` | `github` | `docker`
- 新增 `sourceRef String?` —— 包名 / 引用
- 新增 `installCfg Json?` —— `{ env: Record<string,string>, args: string[] }`
- 保留 `@@unique([workspaceId, serverId])`:Postgres 视多个 NULL 互不相同,故一个 workspace 可装多个自定义部署,且与 catalog 部署互不冲突。
- 约定:catalog 部署 → serverId 有值、source 为 null;自定义部署 → serverId=null、source 有值。

迁移:`pnpm db:migrate`。**注意**:加字段后必须重启 dev server(Prisma 7 生成的 client 在磁盘,运行中的 Next 进程仍持旧 client)。

## 6. 进程层

**新 `src/lib/process/spawn-spec.ts`(纯函数,可单测)**

```
type SpawnSpec =
  | { kind: 'builtin'; name: string }
  | { kind: 'bridge'; name: string; command: string; args: string[]; env: Record<string,string> }

buildSpawnSpec(source, ref, args): { command, args }
  // npm -> { command: 'npx', args: ['-y', ref, ...args] }
  // pypi/github/docker -> throw 'not implemented' (blocked by UI)

resolveSpawnSpec(deployment): SpawnSpec
  // has serverId -> { kind:'builtin', name: server.name }
  // custom       -> { kind:'bridge', name, ...buildSpawnSpec(...), env }
```

**`src/lib/process/supervisor.ts`** —— `startProcess(deploymentId, spec: SpawnSpec)`:

- builtin → 跑 `scripts/mcp-server.mjs`,env `{ MCP_PORT:'0', MCP_NAME }`(行为不变)
- bridge → 跑 `scripts/mcp-stdio-bridge.mjs`,env `{ ...spec.env, MCP_PORT:'0', MCP_NAME, MCP_COMMAND:spec.command, MCP_ARGS:JSON.stringify(spec.args) }`
- `LISTENING (\d+)` 解析、退出/错误状态机、ppid 看门狗 —— 全部复用。

**新 `scripts/mcp-stdio-bridge.mjs`**:

- 读 env:`MCP_PORT`、`MCP_NAME`、`MCP_COMMAND`、`MCP_ARGS`(JSON 数组);自定义业务 env 已在进程环境里,转发给子进程时透传(剥离 `MCP_*` 控制变量)。
- `spawn(command, args, { stdio:['pipe','pipe','pipe'] })`;stdout 按换行分隔解析 JSON-RPC,stderr → bridge 日志。
- 启动序列:① spawn 子进程 → ② `initialize` + `notifications/initialized` 握手 → ③ 握手成功后 HTTP 监听,打印 `LISTENING <port>`。
- `POST /`:读 JSON-RPC body,以**自增内部 id** 转发到子进程 stdin,按 id 回填原始 id 后返回;`GET /health`:200。
- ppid 看门狗(父进程消失则杀子进程并退出);子进程退出 / 握手失败 → bridge 以非零码退出 → supervisor 置 `error`(部署失败有真实反馈)。

## 7. 后端 action 与边界校验

**新 `src/lib/workspace/custom-mcp.ts`** —— zod schema 在系统边界校验:

- `source`:枚举(本次仅接受 `npm`)
- `packageRef`:非空且符合 npm 包名字符集(`@scope/name` 或 `name`)
- `name`:非空
- `env`:行数组,key 须为合法环境变量名(`[A-Z_][A-Z0-9_]*`)
- `args`:按空格/换行分词为 `string[]`
- 输出规范化的 `installCfg = { env, args }`

**`src/lib/workspace/actions.ts` 新增 `deployCustomServerAction(formData)`**:授权 workspace → zod 校验 → `db.deployment.create({ serverId:null, source, sourceRef, name, installCfg, status:'provisioning' })` → `startProcess(dep.id, resolveSpawnSpec(dep))` → `revalidatePath('/app/<slug>/mcp')`。

`deployServerAction` / `startDeploymentAction` / `restartDeploymentAction` 改为经 `resolveSpawnSpec(dep)` 传 spec(对 catalog 行为不变)。

## 8. UI

**新 `src/components/dashboard/DeployCustomMcpSheet.tsx`(client slide-over,贴合截图)**:

- 信任警告条(保留截图文案:"MCP servers can access your data and execute arbitrary code. Only install servers from sources you trust.")
- SOURCE 分段标签:npm 可用;PyPI / GitHub / Docker 置灰 "Coming soon"
- 包名输入(标签随来源变:"NPM PACKAGE")+ 服务器名称输入
- env 动态行(可增删的 key/value)+ args 字段
- slug / endpoint 预览行(`/<ws>/mcp/<slug>`)
- Cancel / Deploy 按钮

**`src/app/app/[workspace]/mcp/page.tsx`**:

- 加 "Deploy custom MCP" 入口触发 Sheet
- 行渲染改用 `deploymentLabel(dep)`(null-server 时回退到 `dep.name` + source 徽章)
- **provisioning 轮询**:只要有行处于 `provisioning`,每 ~2.5s `router.refresh()`,覆盖 npx 首次下载延迟(轻量 client 包装)

**新 `deploymentLabel(dep)` 小工具**:收敛 null-server 分支,返回 `{ name, source, ref }`;检查器页 `mcp/[deploymentId]/page.tsx` 同样用它显示标题 / 来源 / endpoint。

## 9. 错误处理

- **npx 首次下载慢(数十秒)**:supervisor 3s 就绪超时先返回 `provisioning`,bridge 就绪后打印 `LISTENING` → persist `running`,列表轮询刷新出来。
- **包不存在 / 子进程崩溃**:bridge 非零退出 → `error` 状态(列表可见,可 Remove / 重试)。
- **真实工具耗时 > 现有 2.5s/3s 超时**:`mcpRpc` 加可选 `timeoutMs` —— `listMcpTools` 用 ~5s;`tools/call`(agent execute)与网关代理放宽到 ~30s(真实工具会做网络 I/O)。这是必要的小幅共享改动。
- **无 shell 注入**:command / args / env 全部以数组传 `spawn`,不经 shell。

## 10. 测试

- 单测(Vitest,`fileParallelism:false`):
  - `tests/unit/spawn-spec.test.ts` —— npm 映射、非 npm 抛错、`resolveSpawnSpec` 两分支
  - `tests/unit/custom-mcp-validate.test.ts` —— zod 边界:坏包名 / 坏 env 名 / 空名 / args 分词
  - `tests/unit/deployment-label.test.ts` —— null-server 回退
- e2e(可选,联网):扩展 `e2e/dashboard.e2e.mjs`,部署真实 `@modelcontextprotocol/server-everything` → 等 running → `tools/list` 非空 → 调用一个工具。

## 11. 文件清单

**新增**
- `scripts/mcp-stdio-bridge.mjs`
- `src/lib/process/spawn-spec.ts`
- `src/lib/workspace/custom-mcp.ts`
- `src/components/dashboard/DeployCustomMcpSheet.tsx`
- `deploymentLabel` 工具(`src/lib/process/deployment-label.ts` 或就近)
- 3 个单测文件

**修改**
- `prisma/schema.prisma`
- `src/lib/process/supervisor.ts`
- `src/lib/workspace/actions.ts`
- `src/lib/workspace/queries.ts`(`getDeployments` select 含新字段 + 可空 server)
- `src/lib/process/mcp-client.ts`(可选 `timeoutMs`)
- `src/app/app/[workspace]/mcp/page.tsx`
- `src/app/app/[workspace]/mcp/[deploymentId]/page.tsx`
- `src/app/api/v1/mcp/[deploymentId]/rpc/route.ts`(代理超时放宽)

## 12. 非目标 / 已知风险

- 本次只做 **npm**;PyPI(uvx)/GitHub/Docker 留 `buildSpawnSpec` 扩展点 + UI 占位。
- env 值**明文**存库(与 `ModelProvider.apiKey` 一致)。
- **任意代码执行**:`npx -y <任意包>` 按设计执行第三方代码,**不做沙箱**——仅在本地开发或受信任环境中可接受。截图的信任警告予以保留作为唯一提示。
- 多级进程(supervisor → bridge → npx → 真 server)多一跳本地 HTTP;ppid 看门狗确保不留孤儿。
