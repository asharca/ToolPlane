export type MarketingCapability = "mcp" | "skills" | "agents" | "clients";

export type MarketingLink = {
  label: string;
  href: string;
};

export type TracePreviewSpanData = {
  id: string;
  parentId?: string;
  name: string;
  kind: "agent" | "model" | "tool" | "guardrail";
  startMs: number;
  durationMs: number;
  status: "completed";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  input?: string;
  output?: string;
  attributes: Record<string, string | number>;
};

export type SandboxNodeDetail = {
  id: string;
  path: string;
  kind: "folder" | "file";
  scopeLabel: string;
  summary: string;
  snippet: string;
};

export type GatewayRouteItem = {
  id: string;
  label: string;
  transport: string;
  auth: string;
  policy: string;
  description: string;
};

export type McpServerPreview = {
  id: string;
  name: string;
  source: string;
  endpoint: string;
  tools: Array<{
    id: string;
    name: string;
    description: string;
    latency: string;
    defaultPolicy: "allow" | "approve" | "deny";
    scope: string;
  }>;
};

export type PluginPinPreview = {
  id: string;
  repo: string;
  pluginId: string;
  commit: string;
  schema: string;
  version: string;
  summary: string;
  artifacts: Array<{
    path: string;
    role: string;
  }>;
  reviewNote: string;
};

export type CapabilityHighlight = {
  title: string;
  description: string;
};

export type CapabilityContent = {
  eyebrow: string;
  title: string;
  description: string;
  highlights: CapabilityHighlight[];
};

export type MarketingContent = {
  navigation: {
    menu: string;
    docs: string;
    docsUrl: string;
    sourceCode: string;
    openConsole: string;
    links: MarketingLink[];
  };
  footer: {
    tagline: string;
    product: string;
    resources: string;
    access: string;
    docs: string;
    sourceCode: string;
    mcpProtocol: string;
    mcpGuide: string;
    openConsole: string;
    signIn: string;
    privacy: string;
    terms: string;
    rights: string;
  };
  home: {
    metaTitle: string;
    eyebrow: string;
    headline: string;
    description: string;
    primaryCta: string;
    secondaryCta: string;
    tertiaryCta: string;
    heroPreview: {
      workspacePath: string;
      statusBadge: string;
      illustrativeNote: string;
      stackLabel: string;
      tabs: {
        trace: string;
        sandbox: string;
        gateway: string;
      };
      traceRun: {
        id: string;
        name: string;
        startedAt: string;
        durationMs: number;
        spans: TracePreviewSpanData[];
      };
      traceLabels: {
        traceSuffix: string;
        statusCompleted: string;
        statusFailed: string;
        statusRunning: string;
        statusCancelled: string;
        duration: string;
        spans: string;
        tokens: string;
        cost: string;
        showKinds: string;
        kindAgent: string;
        kindModel: string;
        kindTool: string;
        kindGuardrail: string;
        span: string;
        expandPrefix: string;
        collapsePrefix: string;
        expandAll: string;
        collapseAll: string;
        search: string;
        clearSearch: string;
        errorsOnly: string;
        zoomIn: string;
        zoomOut: string;
        zoomReset: string;
        previousSpan: string;
        nextSpan: string;
        shareOfTotal: string;
        copy: string;
        copied: string;
        expandText: string;
        collapseText: string;
        noSpans: string;
        noMatches: string;
        resetFilters: string;
        clearSelection: string;
        timing: string;
        start: string;
        end: string;
        model: string;
        inputTokens: string;
        outputTokens: string;
        input: string;
        output: string;
        notRecorded: string;
        attributes: string;
      };
      sandboxTreeLabel: string;
      sandboxNodes: Record<string, SandboxNodeDetail>;
      gatewayHubLabel: string;
      gatewayAriaLabel: string;
      gatewayPolicyLabel: string;
      gatewayAuthLabel: string;
      gatewayRoutes: GatewayRouteItem[];
    };
    pipeline: {
      title: string;
      description: string;
      steps: Array<{
        index: string;
        title: string;
        description: string;
      }>;
    };
    mcpPreview: {
      caption: string;
      policyLabels: {
        allow: string;
        approve: string;
        deny: string;
      };
      policyToggleHint: string;
      servers: McpServerPreview[];
    };
    skillsPreview: {
      caption: string;
      reviewBanner: string;
      commitLabel: string;
      artifactsLabel: string;
      plugins: PluginPinPreview[];
    };
    agentsPreview: {
      revisionCard: {
        title: string;
        description: string;
        badge: string;
        tabs: {
          diff: string;
          sessions: string;
        };
        diffLines: Array<{
          id: string;
          type: "add" | "remove" | "context";
          text: string;
        }>;
        sessions: Array<{
          id: string;
          name: string;
          revision: string;
          status: string;
          workspaceDir: string;
        }>;
      };
      sandboxCard: {
        title: string;
        description: string;
        targets: Array<{
          id: string;
          name: string;
          badge: string;
          description: string;
        }>;
      };
      a2aCard: {
        title: string;
        description: string;
        steps: Array<{
          id: string;
          role: string;
          title: string;
          detail: string;
        }>;
        footerNote: string;
      };
    };
    clientsPreview: {
      surfaces: string[];
      sceneLabel: string;
      caption: string;
      nodes: Array<{
        id: string;
        label: string;
        title: string;
        detail: string;
      }>;
    };
    security: {
      title: string;
      description: string;
      items: Array<{
        id: string;
        title: string;
        description: string;
      }>;
    };
    quickstart: {
      title: string;
      description: string;
      runtimeNote: string;
      docsLabel: string;
      opsUrl: string;
      opsLabel: string;
      copy: string;
      copied: string;
      copyFailed: string;
      tabs: {
        docker: {
          label: string;
          note: string;
          command: string;
        };
        local: {
          label: string;
          note: string;
          command: string;
        };
      };
    };
    faq: {
      title: string;
      description: string;
      items: Array<{
        id: string;
        question: string;
        answer: string;
      }>;
    };
    cta: {
      title: string;
      description: string;
      primaryCta: string;
      githubCta: string;
      docsCta: string;
    };
  };
  capabilities: Record<MarketingCapability, CapabilityContent>;
};

const CONTENT: Record<"en" | "zh", MarketingContent> = {
  zh: {
    navigation: {
      menu: "导航菜单",
      docs: "开发文档",
      docsUrl: "https://asharca.github.io/toolplane-docs/docs/zh",
      sourceCode: "GitHub",
      openConsole: "打开控制台",
      links: [
        { label: "MCP 网关", href: "/#mcp" },
        { label: "插件中心", href: "/#skills" },
        { label: "Agent 运行时", href: "/#agents" },
        { label: "集成与观测", href: "/#clients" },
        { label: "快速部署", href: "/#quickstart" },
      ],
    },
    footer: {
      tagline:
        "面向团队的自托管控制平面，统一管理 MCP 服务、GitHub 固定提交插件、持久沙箱与 Pi SDK Agent。",
      product: "核心能力",
      resources: "文档与源码",
      access: "控制台",
      docs: "开发文档",
      sourceCode: "GitHub 仓库",
      mcpProtocol: "MCP 协议规范",
      mcpGuide: "什么是 MCP 服务",
      openConsole: "打开控制台",
      signIn: "登录工作区",
      privacy: "隐私说明",
      terms: "使用条款",
      rights: "保留所有权利。",
    },
    home: {
      metaTitle: "自托管控制平面 · MCP、插件与 Agent 运行时",
      eyebrow: "自托管控制平面 · Pi SDK · MCP",
      headline: "把工具、技能与沙箱，收归团队自己的控制平面",
      description:
        "在一个团队自主托管的工作区中管理 MCP 服务、GitHub 固定提交的 Pi 插件与持久沙箱，并通过不可变修订与调用追踪运行生产级 Agent。",
      primaryCta: "打开控制台",
      secondaryCta: "快速部署",
      tertiaryCta: "查看源码",
      heroPreview: {
        workspacePath: "workspace / platform-ops",
        statusBadge: "rev.4 · 已固定",
        illustrativeNote:
          "示例回放 · 展示真实控制平面机制，公开页不读取实时工作区数据",
        stackLabel: "Pi SDK · 持久沙箱 · JSON-RPC",
        tabs: {
          trace: "执行追踪",
          sandbox: "持久沙箱",
          gateway: "MCP 网关",
        },
        traceRun: {
          id: "run-pr-audit-04",
          name: "pi-ops-agent · rev.4",
          startedAt: "2026-11-20T12:30:00Z",
          durationMs: 2480,
          spans: [
            {
              id: "span-root",
              name: "session.admit",
              kind: "agent",
              startMs: 0,
              durationMs: 2480,
              status: "completed",
              input: "检查 PR #418 的权限变更并运行静态检查",
              output: "校验通过：0 个高危越权，已附带可复现差异与日志摘要。",
              attributes: {
                workspace: "platform-ops",
                revision: "rev.4",
                sandbox: "docker-persistent",
              },
            },
            {
              id: "span-plan",
              parentId: "span-root",
              name: "pi.plan",
              kind: "model",
              startMs: 90,
              durationMs: 460,
              status: "completed",
              model: "workspace-default-llm",
              inputTokens: 1840,
              outputTokens: 215,
              input: "装载固定插件 code-review@7d4e2a1 与已授权 MCP 工具列表",
              output:
                "计划步骤：1) 拉取 PR diff 2) 在会话沙箱执行检查 3) 委派安全复核",
              attributes: {
                plugin: "code-review@7d4e2a1",
                session: "conv-01",
              },
            },
            {
              id: "span-mcp",
              parentId: "span-root",
              name: "mcp.github.get_pr",
              kind: "tool",
              startMs: 580,
              durationMs: 420,
              status: "completed",
              input: '{"repo":"asharca/ToolPlane","pr":418,"files":true}',
              output: '{"changedFiles":6,"additions":184,"deletions":42}',
              attributes: {
                grant: "explicit-allow",
                transport: "json-rpc",
                server: "github-mcp",
              },
            },
            {
              id: "span-sandbox",
              parentId: "span-root",
              name: "sandbox.bash",
              kind: "tool",
              startMs: 1040,
              durationMs: 640,
              status: "completed",
              input: "cd /sessions/conv-01/workspace && pnpm check",
              output: "Biome & TypeScript check passed (0 errors)",
              attributes: {
                isolation: "per-session-dir",
                network: "restricted",
                exitCode: 0,
              },
            },
            {
              id: "span-a2a",
              parentId: "span-root",
              name: "a2a.delegate",
              kind: "guardrail",
              startMs: 1360,
              durationMs: 620,
              status: "completed",
              input: "委派给 audit-subagent 复核密钥与权限边界",
              output: "复核完成：未发现凭据泄漏，深度检查 1/3 通过",
              attributes: {
                target: "audit-subagent",
                depth: "1/3",
                approval: "policy-matched",
              },
            },
            {
              id: "span-stream",
              parentId: "span-root",
              name: "response.stream",
              kind: "model",
              startMs: 2020,
              durationMs: 440,
              status: "completed",
              model: "workspace-default-llm",
              inputTokens: 2620,
              outputTokens: 380,
              input: "汇总工具结果与脱敏后的审计结论",
              output: "已流式输出 PR #418 审核报告并写入持久化会话历史。",
              attributes: {
                redaction: "active",
                history: "persisted",
              },
            },
          ],
        },
        traceLabels: {
          traceSuffix: "调用瀑布图",
          statusCompleted: "已完成",
          statusFailed: "失败",
          statusRunning: "运行中",
          statusCancelled: "已取消",
          duration: "总耗时",
          spans: "Span 数",
          tokens: "Token",
          cost: "成本",
          showKinds: "按类型筛选 Span",
          kindAgent: "Agent",
          kindModel: "模型",
          kindTool: "工具",
          kindGuardrail: "护栏 / A2A",
          span: "阶段",
          expandPrefix: "展开",
          collapsePrefix: "折叠",
          expandAll: "全部展开",
          collapseAll: "全部折叠",
          search: "搜索 Span…",
          clearSearch: "清除搜索",
          errorsOnly: "仅错误",
          zoomIn: "放大时间轴",
          zoomOut: "缩小时间轴",
          zoomReset: "重置缩放",
          previousSpan: "上一个 Span",
          nextSpan: "下一个 Span",
          shareOfTotal: "占总耗时",
          copy: "复制",
          copied: "已复制",
          expandText: "展开全文",
          collapseText: "收起",
          noSpans: "当前没有可显示的 Span。",
          noMatches: "没有匹配的 Span。",
          resetFilters: "重置筛选",
          clearSelection: "清除选中",
          timing: "耗时明细",
          start: "开始",
          end: "结束",
          model: "模型",
          inputTokens: "输入 Token",
          outputTokens: "输出 Token",
          input: "输入",
          output: "输出",
          notRecorded: "未记录",
          attributes: "属性",
        },
        sandboxTreeLabel: "Agent 持久沙箱目录结构",
        sandboxNodes: {
          ".toolplane": {
            id: ".toolplane",
            path: ".toolplane/",
            kind: "folder",
            scopeLabel: "修订元数据",
            summary:
              "保存当前 Agent 已审阅并应用的不可变修订锁文件，防止运行时漂移。",
            snippet:
              "revision: rev.4\nruntime: pi-sdk\npolicy: immutable-session-pin",
          },
          "revision-lock": {
            id: "revision-lock",
            path: ".toolplane/revision-v4.lock",
            kind: "file",
            scopeLabel: "不可变修订锁",
            summary:
              "记录模型、显式授权的 MCP 工具以及固定提交的 Pi 插件校验摘要。",
            snippet:
              '{\n  "revision": 4,\n  "plugins": ["code-review@7d4e2a1"],\n  "mcpGrants": ["github:get_pr", "postgres-ro:query"]\n}',
          },
          plugins: {
            id: "plugins",
            path: "plugins/",
            kind: "folder",
            scopeLabel: "只读插件层",
            summary:
              "从 GitHub 固定提交捕获的 Pi 插件制品，以只读方式挂载进沙箱。",
            snippet:
              "code-review@7d4e2a1/  (verified v3 artifact)\nread-only mount · no runtime network install",
          },
          "skill-md": {
            id: "skill-md",
            path: "plugins/code-review@7d4e2a1/SKILL.md",
            kind: "file",
            scopeLabel: "固定插件技能",
            summary:
              "声明式技能指令与配套工具约束，仅在审阅并应用修订后对 Agent 生效。",
            snippet:
              "# code-review\n- 检查鉴权与工作区隔离边界\n- 输出可复现的验证命令与风险项",
          },
          "plugin-pkg": {
            id: "plugin-pkg",
            path: "plugins/code-review@7d4e2a1/package.json",
            kind: "file",
            scopeLabel: "Pi 插件清单",
            summary:
              "符合 v3 插件索引规范的包清单，包含版本号、Skill、prompt 与扩展入口。",
            snippet:
              '{\n  "name": "@toolplane/code-review",\n  "version": "1.4.0",\n  "pi": { "skills": ["SKILL.md"] }\n}',
          },
          sessions: {
            id: "sessions",
            path: "sessions/",
            kind: "folder",
            scopeLabel: "会话隔离目录",
            summary:
              "同一 Agent 复用持久沙箱，但不同会话拥有彼此隔离的工作目录与原生历史。",
            snippet:
              "conv-01/  -> pinned rev.4\nconv-02/  -> pinned rev.3 (升级前保持原版本)",
          },
          "conv-01": {
            id: "conv-01",
            path: "sessions/conv-01/workspace/patch.diff",
            kind: "file",
            scopeLabel: "会话 conv-01 · rev.4",
            summary:
              "该会话产生的代码补丁与中间文件仅存放在自身工作目录，不污染其它对话。",
            snippet:
              "diff --git a/src/auth/guard.ts b/src/auth/guard.ts\n+ assertWorkspaceRole(ctx, 'admin');",
          },
          "conv-02": {
            id: "conv-02",
            path: "sessions/conv-02/workspace/notes.md",
            kind: "file",
            scopeLabel: "会话 conv-02 · rev.3",
            summary: "旧会话持续固定在原修订 rev.3，直到人工显式触发升级。",
            snippet:
              "## 运行记录\n- 固定修订: rev.3\n- 历史归档: 原生 JSONL 持久保存",
          },
        },
        gatewayHubLabel: "ToolPlane",
        gatewayAriaLabel: "ToolPlane 统一网关路由示意",
        gatewayPolicyLabel: "授权策略",
        gatewayAuthLabel: "鉴权边界",
        gatewayRoutes: [
          {
            id: "managed-mcp",
            label: "托管 MCP 服务",
            transport: "JSON-RPC · npm / PyPI / GitHub",
            auth: "工作区级凭据托管",
            policy: "按工具显式授权与健康探测",
            description:
              "通过托管进程或容器运行 MCP 服务，按工具粒度放行并记录延迟与错误。",
          },
          {
            id: "docker-remote",
            label: "Docker 与远端 HTTP",
            transport: "Streamable HTTP / Container",
            auth: "密钥集中加密，不暴露给公开页",
            policy: "超时控制、限流与结构化脱敏",
            description:
              "统一接入容器化工具和自建远端 MCP 端点，客户端只面对一致网关。",
          },
          {
            id: "device-bridge",
            label: "沙箱与设备连接器",
            transport: "Docker Sandbox · Connector · ADB",
            auth: "单次配对令牌与显式会话边界",
            policy: "容器隔离 / 本地连接器显式权限提示",
            description:
              "按任务需要路由到持久 Docker 沙箱、本机 Connector 或 ADB Android 设备。",
          },
        ],
      },
      pipeline: {
        title: "从代码提交到可控执行，每一步都有清晰边界",
        description:
          "工具与插件不会在后台静默变更线上 Agent。所有能力遵循「捕获 → 授权 → 审阅应用 → 隔离运行」的确定性链路。",
        steps: [
          {
            index: "01",
            title: "GitHub 固定提交",
            description:
              "按精确 Commit SHA 捕获不可变 Pi 插件制品，拒绝漂移分支。",
          },
          {
            index: "02",
            title: "MCP 工具显式授权",
            description:
              "托管服务进入工作区后，逐项决定哪些工具允许、需审批或禁用。",
          },
          {
            index: "03",
            title: "Agent 不可变修订",
            description:
              "变更生成新修订并展示差异；审阅应用前不影响正在运行的会话。",
          },
          {
            index: "04",
            title: "持久沙箱与会话隔离",
            description:
              "每个 Agent 复用持久沙箱，各会话保持独立工作目录、历史与修订版本。",
          },
        ],
      },
      mcpPreview: {
        caption: "点击任意工具策略徽章，体验按工具粒度的显式授权控制（示例）",
        policyLabels: {
          allow: "自动放行",
          approve: "需人工审批",
          deny: "默认拒绝",
        },
        policyToggleHint: "点击切换策略",
        servers: [
          {
            id: "github-mcp",
            name: "github-mcp",
            source: "npm · 托管进程",
            endpoint: "/gateway/ws-ops/github-mcp",
            tools: [
              {
                id: "get-pr",
                name: "get_pull_request",
                description: "读取 PR 变更文件与评审状态",
                latency: "42ms",
                defaultPolicy: "allow",
                scope: "read:repo",
              },
              {
                id: "create-comment",
                name: "create_review_comment",
                description: "向代码行提交审阅评论",
                latency: "68ms",
                defaultPolicy: "approve",
                scope: "write:pr",
              },
              {
                id: "delete-branch",
                name: "delete_branch",
                description: "删除远端分支（高风险操作）",
                latency: "—",
                defaultPolicy: "deny",
                scope: "admin:repo",
              },
            ],
          },
          {
            id: "postgres-ro",
            name: "postgres-ro",
            source: "Docker · 容器运行",
            endpoint: "/gateway/ws-ops/postgres-ro",
            tools: [
              {
                id: "list-schemas",
                name: "list_schemas",
                description: "查询数据库 Schema 与表结构",
                latency: "19ms",
                defaultPolicy: "allow",
                scope: "read:schema",
              },
              {
                id: "explain-query",
                name: "explain_select",
                description: "对只读查询执行 EXPLAIN 分析",
                latency: "54ms",
                defaultPolicy: "allow",
                scope: "read:rows",
              },
              {
                id: "export-csv",
                name: "export_table_snapshot",
                description: "导出批量数据快照到会话目录",
                latency: "185ms",
                defaultPolicy: "approve",
                scope: "export:data",
              },
            ],
          },
          {
            id: "internal-ops",
            name: "internal-ops",
            source: "Remote HTTP · 鉴权端点",
            endpoint: "/gateway/ws-ops/internal-ops",
            tools: [
              {
                id: "service-health",
                name: "get_service_health",
                description: "获取内部集群健康与版本状态",
                latency: "31ms",
                defaultPolicy: "allow",
                scope: "read:status",
              },
              {
                id: "trigger-rollback",
                name: "trigger_release_rollback",
                description: "触发发布回滚流水线",
                latency: "—",
                defaultPolicy: "approve",
                scope: "ops:deploy",
              },
            ],
          },
        ],
      },
      skillsPreview: {
        caption: "示例制品卡片 · 对应真实 GitHub 插件中心 v3 索引机制",
        reviewBanner:
          "添加到工作区不自动授予执行权，须在 Agent 修订中审阅并应用",
        commitLabel: "固定提交",
        artifactsLabel: "包含制品",
        plugins: [
          {
            id: "code-review",
            repo: "asharca/toolplane-plugins",
            pluginId: "code-review",
            commit: "7d4e2a1",
            schema: "v3 多插件索引",
            version: "1.4.0",
            summary:
              "面向代码审查与权限核查的 Pi 插件，封装 Skill 指令、审阅模板与安全检查扩展。",
            artifacts: [
              { path: "SKILL.md", role: "Skill 指令" },
              { path: "prompts/pr-audit.md", role: "Prompt 模板" },
              { path: "extensions/lint-guard.ts", role: "Pi 扩展" },
              { path: "package.json", role: "版本清单" },
            ],
            reviewNote: "SHA-256 已锁定 · 仅限只读挂载",
          },
          {
            id: "release-ops",
            repo: "team-infra/release-skill",
            pluginId: "release-ops",
            commit: "c91b40e",
            schema: "v3 单插件仓库",
            version: "0.9.2",
            summary:
              "根目录直接作为 Pi 包同步的运维发布技能，包含变更日志校验与回滚检查清单。",
            artifacts: [
              { path: "SKILL.md", role: "Skill 指令" },
              { path: "prompts/rollback-check.md", role: "Prompt 模板" },
              { path: "themes/ops-console.json", role: "Theme 定义" },
              { path: "package.json", role: "版本清单" },
            ],
            reviewNote: "新增能力需重新审阅后方可应用",
          },
        ],
      },
      agentsPreview: {
        revisionCard: {
          title: "不可变修订与会话版本固定",
          description:
            "修改模型、MCP 授权或插件版本会生成待审阅修订；已开启的会话保持原修订不变，升级完全可控。",
          badge: "rev.3 → rev.4",
          tabs: {
            diff: "修订差异",
            sessions: "活跃会话",
          },
          diffLines: [
            {
              id: "d1",
              type: "context",
              text: "runtime: pi-sdk (persistent-sandbox)",
            },
            {
              id: "d2",
              type: "add",
              text: "+ plugin: code-review@7d4e2a1 (v1.4.0)",
            },
            {
              id: "d3",
              type: "add",
              text: "+ mcp.github: get_pull_request [allow]",
            },
            {
              id: "d4",
              type: "add",
              text: "+ mcp.github: create_review_comment [approve]",
            },
            {
              id: "d5",
              type: "remove",
              text: "- mcp.github: push_files [revoked]",
            },
            {
              id: "d6",
              type: "context",
              text: "a2a.delegate: depth <= 3 · cycle-guard on",
            },
          ],
          sessions: [
            {
              id: "sess-1",
              name: "conv-01 · PR #418 审核",
              revision: "rev.4",
              status: "已应用最新修订",
              workspaceDir: "/sessions/conv-01/workspace",
            },
            {
              id: "sess-2",
              name: "conv-02 · 线上排障长会话",
              revision: "rev.3",
              status: "固定旧修订 · 不受新发布影响",
              workspaceDir: "/sessions/conv-02/workspace",
            },
          ],
        },
        sandboxCard: {
          title: "持久沙箱与真实设备桥接",
          description:
            "按安全等级和执行环境选择目标，明确区分隔离容器与本机权限。",
          targets: [
            {
              id: "docker",
              name: "Docker 持久沙箱",
              badge: "容器隔离",
              description:
                "每个 Agent 复用持久容器，会话独占工作目录；依赖镜像预置，沙箱内不联网装包。",
            },
            {
              id: "connector",
              name: "本地 Connector",
              badge: "本机权限",
              description:
                "通过配对命令连接自己的电脑；以本地用户权限运行，不等同于隔离容器。",
            },
            {
              id: "adb",
              name: "ADB Android 桥接",
              badge: "移动设备",
              description:
                "桥接已授权 Android 设备，支持界面检查与自动化调试。",
            },
          ],
        },
        a2aCard: {
          title: "平台原生 A2A 子智能体委派",
          description:
            "主智能体通过平台内置 A2A 协议把专项任务委派给子智能体，内置深度限制、环路防护与工具审批门禁。",
          steps: [
            {
              id: "coord",
              role: "发起者",
              title: "Coordinator Agent",
              detail: "拆分任务并附带原始文件名（完整支持 UTF-8 / 中文）",
            },
            {
              id: "gate",
              role: "平台护栏",
              title: "Depth & Approval Gate",
              detail: "校验递归深度、防循环调用并按策略挂起高风险审批",
            },
            {
              id: "sub",
              role: "子智能体",
              title: "Audit Sub-Agent",
              detail: "在独立修订与沙箱内执行，持久化保存工具调用过程",
            },
          ],
          footerNote:
            "任务结束后刷新会话仍可展开完整工具调用与脱敏结果，同工作区成员可按规则只读协查。",
        },
      },
      clientsPreview: {
        surfaces: [
          "Agent Control MCP",
          "OpenAPI · /docs-api",
          "Telegram · 飞书 · Discord · 微信",
          "LogEvent & 调用瀑布图",
        ],
        sceneLabel: "ToolPlane 接入层与观测栈示意图",
        caption: "点击下方层级切换查看各接入与观测面说明（示例）",
        nodes: [
          {
            id: "mcp",
            label: "MCP",
            title: "Control MCP",
            detail:
              "外部 AI 客户端使用账户级个人 API Token 接入受治理的工作区能力。",
          },
          {
            id: "api",
            label: "API",
            title: "OpenAPI 参考",
            detail:
              "运行实例自带 /docs-api 与 /api/v1/openapi.json，提供交互式接口参考与模式定义。",
          },
          {
            id: "im",
            label: "IM",
            title: "多平台消息渠道",
            detail:
              "将 Agent 直接接入 Telegram、飞书、Discord 与微信会话，独立归组可追溯。",
          },
          {
            id: "trace",
            label: "TRACE",
            title: "LogEvent 追踪",
            detail:
              "统一查看工具调用、延迟、失败原因与有界脱敏记录，无需另拼监控面板。",
          },
        ],
      },
      security: {
        title: "默认收紧边界，而不是事后补丁",
        description:
          "ToolPlane 将权限隔离、凭据保护与修订可控性内建在核心数据模型中。",
        items: [
          {
            id: "workspace-auth",
            title: "工作区权限边界",
            description:
              "工具配置、密钥、运行进程与私有会话严格归属工作区及角色；匿名与跨工作区请求一律拒绝。",
          },
          {
            id: "sandbox-isolation",
            title: "最小权限沙箱与预检",
            description:
              "默认沙箱、LSP 与 debugpy 使用独立预置镜像，沙箱内不自动联网装包，不因预拉镜像而自动启用工具。",
          },
          {
            id: "immutable-pin",
            title: "不可变修订固定",
            description:
              "插件捕获仅锁定固定 Commit，新增权限或代码变化须显式审阅应用，存量会话继续固定原版本。",
          },
          {
            id: "redaction",
            title: "结构化错误与密钥脱敏",
            description:
              "API Token 与凭据安全存储，过程回放与日志输出沿用有界记录和脱敏规则，避免敏感内容外泄。",
          },
        ],
      },
      quickstart: {
        title: "几分钟内完成自托管部署",
        description:
          "获取仓库、生成随机 AUTH_SECRET 并启动容器即可体验完整控制台。公网部署前请配合 HTTPS、访问控制与工具镜像运维指南完成配置。",
        runtimeNote:
          "架构提示：ToolPlane 需要单个持续运行的应用进程，不适合 Serverless，也不要让多个实例同时操作同一运行域。",
        docsLabel: "阅读完整文档",
        opsUrl:
          "https://asharca.github.io/toolplane-docs/docs/zh/developers/docs/RUNTIME_OPERATIONS",
        opsLabel: "运行与维护指南",
        copy: "复制命令",
        copied: "已复制",
        copyFailed: "复制失败",
        tabs: {
          docker: {
            label: "Docker Compose",
            note: "默认监听 http://localhost:10030；启动前请将 .env 中的 AUTH_SECRET 替换为 openssl rand -base64 32 生成的随机密钥。",
            command: `git clone https://github.com/asharca/ToolPlane.git
cd ToolPlane
test -f .env || cp .env.example .env
# 在 .env 中设置 AUTH_SECRET（可用 openssl rand -base64 32 生成）
docker compose pull app lsp-tools-image
docker compose up -d`,
          },
          local: {
            label: "本地开发 (pnpm)",
            note: "需要 Node.js >= 26.12.1、pnpm 与 Docker，并在 .env 中配置本地 DATABASE_URL 与 NEXT_PUBLIC_APP_URL。",
            command: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev`,
          },
        },
      },
      faq: {
        title: "常见问题",
        description: "关于架构选型、插件治理与部署边界的直接回答。",
        items: [
          {
            id: "what-is-toolplane",
            question: "ToolPlane 实际管理哪些资源？",
            answer:
              "ToolPlane 是一个以工作区为核心的自托管 AI 工具与 Agent 控制平面，统一管理 MCP 服务（npm、PyPI、GitHub、Docker、Remote HTTP）、从 GitHub 固定提交同步的 Pi 插件与技能、基于 Pi SDK 的不可变修订 Agent，以及 Docker 持久沙箱、本地 Connector 和 ADB 设备桥接。",
          },
          {
            id: "how-plugins-work",
            question: "GitHub 插件中心如何防止上游更新破坏线上 Agent？",
            answer:
              "插件中心支持 v3 多插件索引（registry.json）和单插件仓库，同步时只捕获固定 Commit SHA 生成不可变 Pi 插件制品。将插件添加到工作区并不会自动授予执行权，必须由 Agent 审阅差异并显式应用修订；即使应用了新修订，既有活跃会话仍固定在原修订版本，直到手动升级。",
          },
          {
            id: "serverless-scaling",
            question:
              "可以把 ToolPlane 部署到 Serverless 或多实例无状态集群吗？",
            answer:
              "不可以。ToolPlane 托管真实 MCP 进程、长连接通道、持久沙箱会话和本地运行态，需要单个持续运行的应用进程，不适合 Serverless，也不应让多个应用实例同时操作同一运行域。",
          },
          {
            id: "docker-vs-connector",
            question: "Docker 持久沙箱与本地 Connector 的安全边界有什么区别？",
            answer:
              "Docker 持久沙箱运行在隔离容器中，按 Agent 复用并按会话分配独立工作目录，且不自动联网安装依赖；而本地 Connector 旨在连接你自己的电脑以访问本地环境，它以本机用户权限运行，不等同于隔离容器。",
          },
          {
            id: "external-clients",
            question: "外部客户端与团队聊天工具如何接入工作区 Agent？",
            answer:
              "外部 AI 客户端可通过控制台获取 Agent Control MCP 配置并配合账户级个人 API Token 接入；业务系统可直接使用运行实例提供的 /docs-api 与 /api/v1/openapi.json；团队协作还支持将 Agent 绑定至 Telegram、飞书、Discord 和微信等消息渠道。",
          },
        ],
      },
      cta: {
        title: "把 Agent 基础设施掌握在自己手里",
        description:
          "开源、自托管、边界清晰。立即进入控制台或按文档部署你的第一个工作区。",
        primaryCta: "打开控制台",
        githubCta: "浏览 GitHub",
        docsCta: "查看开发文档",
      },
    },
    capabilities: {
      mcp: {
        eyebrow: "MCP 运行时与网关",
        title: "把 MCP 服务纳入托管进程与显式工具授权",
        description:
          "从 npm、PyPI、GitHub、Docker 或远端 HTTP 接入 MCP 服务，经由统一鉴权的 JSON-RPC 网关对外提供受控能力，并实时掌握健康状态与调用遥测。",
        highlights: [
          {
            title: "多来源托管运行",
            description:
              "支持 npm、PyPI、GitHub、Docker 容器与远端 HTTP 端点，进程生命周期与凭据由工作区统一管理。",
          },
          {
            title: "按工具粒度显式授权",
            description:
              "每个 MCP 工具都可独立配置放行、审批或拒绝，避免给 Agent 暴露过宽的默认权限。",
          },
          {
            title: "统一网关与调用遥测",
            description:
              "所有调用经过同一鉴权 JSON-RPC 网关，自动沉淀延迟、成功率与结构化错误信号。",
          },
        ],
      },
      skills: {
        eyebrow: "GitHub 插件中心",
        title: "从固定提交捕获不可变 Pi 插件与技能",
        description:
          "直接对接团队或官方 GitHub 仓库，按精确 Commit SHA 固化 Skill、prompt、extension 与 theme；先入工作区，再由 Agent 审阅差异并显式应用。",
        highlights: [
          {
            title: "锁定固定 Commit SHA",
            description:
              "每次同步生成不可变 Pi 插件制品，不跟随浮动分支静默变化，随时可审计与回溯。",
          },
          {
            title: "v3 多插件与单插件仓库",
            description:
              "原生支持 schemaVersion 3 多插件索引（registry.json）以及根目录单插件仓库，开箱兼容官方插件源。",
          },
          {
            title: "先入库、后审阅应用",
            description:
              "添加到工作区不等于立即执行；任何代码或能力变化在生效前都须经过清晰审阅。",
          },
        ],
      },
      agents: {
        eyebrow: "Pi SDK Agent 编排",
        title: "不可变修订、持久沙箱与原生 A2A 协作",
        description:
          "基于 Pi SDK 运行可审计的生产 Agent：修订变更先对比再应用，会话共享持久沙箱但隔离工作目录，并支持带深度护栏与审批门禁的子智能体委派。",
        highlights: [
          {
            title: "修订可审阅、会话可固定",
            description:
              "新修订上线不会破坏正在进行的长会话，现有对话继续固定原版本，直到主动升级。",
          },
          {
            title: "沙箱与设备按需桥接",
            description:
              "统一管理 Docker 持久沙箱、本机 Connector 与 ADB Android 设备，权限边界透明可见。",
          },
          {
            title: "原生 A2A 子智能体委派",
            description:
              "主从智能体通过平台协议协作，内置递归深度限制、防循环校验与持久化工具调用历史。",
          },
        ],
      },
      clients: {
        eyebrow: "集成表面与全链路观测",
        title: "一次治理，对接客户端、API 与消息渠道",
        description:
          "在同一个控制平面下，通过 Agent Control MCP、OpenAPI 接口与多平台消息渠道触达团队工作流，并借助 LogEvent 与调用瀑布图完整复盘每一步执行。",
        highlights: [
          {
            title: "Agent Control MCP 与 OpenAPI",
            description:
              "支持外部 AI 客户端通过个人 API Token 接入，同时由实例直接提供 /docs-api 与 OpenAPI 定义。",
          },
          {
            title: "多平台消息渠道",
            description:
              "原生集成 Telegram、飞书、Discord 与微信，频道对话与 A2A 任务分组归档、边界清晰。",
          },
          {
            title: "持久化 Trace 与脱敏日志",
            description:
              "调用耗时、工具输入输出与错误事件持久化保存，沿用有界记录与脱敏策略，刷新不丢失。",
          },
        ],
      },
    },
  },
  en: {
    navigation: {
      menu: "Navigation menu",
      docs: "Docs",
      docsUrl: "https://asharca.github.io/toolplane-docs/docs/en",
      sourceCode: "GitHub",
      openConsole: "Open console",
      links: [
        { label: "MCP", href: "/#mcp" },
        { label: "Plugins", href: "/#skills" },
        { label: "Agents", href: "/#agents" },
        { label: "Integrations", href: "/#clients" },
        { label: "Quick start", href: "/#quickstart" },
      ],
    },
    footer: {
      tagline:
        "A self-hosted control plane for MCP servers, GitHub-pinned Pi plugins, persistent sandboxes, and Pi SDK agents.",
      product: "Platform",
      resources: "Resources",
      access: "Console",
      docs: "Documentation",
      sourceCode: "GitHub repository",
      mcpProtocol: "MCP specification",
      mcpGuide: "What is an MCP server",
      openConsole: "Open console",
      signIn: "Sign in",
      privacy: "Privacy",
      terms: "Terms",
      rights: "All rights reserved.",
    },
    home: {
      metaTitle: "Self-hosted control plane for MCP, plugins, and agents",
      eyebrow: "Self-hosted control plane · Pi SDK · MCP",
      headline:
        "One self-hosted control plane for MCP tools, skills, and agents.",
      description:
        "Manage MCP servers, GitHub-pinned Pi plugins, and persistent sandboxes inside a workspace your team owns—with immutable revisions and full trace visibility.",
      primaryCta: "Open console",
      secondaryCta: "Quick start",
      tertiaryCta: "View source",
      heroPreview: {
        workspacePath: "workspace / platform-ops",
        statusBadge: "rev.4 · pinned",
        illustrativeNote:
          "Illustrative preview · Shows real control-plane mechanics; this public page never reads live workspace data",
        stackLabel: "Pi SDK · Persistent Sandbox · JSON-RPC",
        tabs: {
          trace: "Trace",
          sandbox: "Sandbox",
          gateway: "Gateway",
        },
        traceRun: {
          id: "run-pr-audit-04",
          name: "pi-ops-agent · rev.4",
          startedAt: "2026-11-20T12:30:00Z",
          durationMs: 2480,
          spans: [
            {
              id: "span-root",
              name: "session.admit",
              kind: "agent",
              startMs: 0,
              durationMs: 2480,
              status: "completed",
              input: "Review permission diff on PR #418 and run static checks",
              output:
                "Verified: 0 privilege regressions; reproducible diff and log summary attached.",
              attributes: {
                workspace: "platform-ops",
                revision: "rev.4",
                sandbox: "docker-persistent",
              },
            },
            {
              id: "span-plan",
              parentId: "span-root",
              name: "pi.plan",
              kind: "model",
              startMs: 90,
              durationMs: 460,
              status: "completed",
              model: "workspace-default-llm",
              inputTokens: 1840,
              outputTokens: 215,
              input:
                "Loaded pinned plugin code-review@7d4e2a1 and granted MCP tool manifest",
              output:
                "Plan: 1) Fetch PR diff 2) Run checks in session sandbox 3) Delegate audit review",
              attributes: {
                plugin: "code-review@7d4e2a1",
                session: "conv-01",
              },
            },
            {
              id: "span-mcp",
              parentId: "span-root",
              name: "mcp.github.get_pr",
              kind: "tool",
              startMs: 580,
              durationMs: 420,
              status: "completed",
              input: '{"repo":"asharca/ToolPlane","pr":418,"files":true}',
              output: '{"changedFiles":6,"additions":184,"deletions":42}',
              attributes: {
                grant: "explicit-allow",
                transport: "json-rpc",
                server: "github-mcp",
              },
            },
            {
              id: "span-sandbox",
              parentId: "span-root",
              name: "sandbox.bash",
              kind: "tool",
              startMs: 1040,
              durationMs: 640,
              status: "completed",
              input: "cd /sessions/conv-01/workspace && pnpm check",
              output: "Biome & TypeScript check passed (0 errors)",
              attributes: {
                isolation: "per-session-dir",
                network: "restricted",
                exitCode: 0,
              },
            },
            {
              id: "span-a2a",
              parentId: "span-root",
              name: "a2a.delegate",
              kind: "guardrail",
              startMs: 1360,
              durationMs: 620,
              status: "completed",
              input:
                "Delegate secret & boundary audit to audit-subagent (depth 1/3)",
              output:
                "Audit passed: no secret exposure detected; cycle & depth guard verified",
              attributes: {
                target: "audit-subagent",
                depth: "1/3",
                approval: "policy-matched",
              },
            },
            {
              id: "span-stream",
              parentId: "span-root",
              name: "response.stream",
              kind: "model",
              startMs: 2020,
              durationMs: 440,
              status: "completed",
              model: "workspace-default-llm",
              inputTokens: 2620,
              outputTokens: 380,
              input: "Synthesize tool output with redacted audit summary",
              output:
                "Streamed verified PR #418 report and persisted native session history.",
              attributes: {
                redaction: "active",
                history: "persisted",
              },
            },
          ],
        },
        traceLabels: {
          traceSuffix: "trace waterfall",
          statusCompleted: "Completed",
          statusFailed: "Failed",
          statusRunning: "Running",
          statusCancelled: "Cancelled",
          duration: "Duration",
          spans: "Spans",
          tokens: "Tokens",
          cost: "Cost",
          showKinds: "Show span kinds",
          kindAgent: "Agent",
          kindModel: "LLM",
          kindTool: "Tool",
          kindGuardrail: "Guardrail / A2A",
          span: "Span",
          expandPrefix: "Expand",
          collapsePrefix: "Collapse",
          expandAll: "Expand all",
          collapseAll: "Collapse all",
          search: "Search spans…",
          clearSearch: "Clear search",
          errorsOnly: "Errors only",
          zoomIn: "Zoom in",
          zoomOut: "Zoom out",
          zoomReset: "Reset zoom",
          previousSpan: "Previous span",
          nextSpan: "Next span",
          shareOfTotal: "of total",
          copy: "Copy",
          copied: "Copied",
          expandText: "Expand",
          collapseText: "Collapse",
          noSpans: "No spans recorded.",
          noMatches: "No spans match these filters.",
          resetFilters: "Reset filters",
          clearSelection: "Clear selection",
          timing: "Timing",
          start: "Start",
          end: "End",
          model: "Model",
          inputTokens: "Input tokens",
          outputTokens: "Output tokens",
          input: "Input",
          output: "Output",
          notRecorded: "Not recorded",
          attributes: "Attributes",
        },
        sandboxTreeLabel: "Agent persistent sandbox layout",
        sandboxNodes: {
          ".toolplane": {
            id: ".toolplane",
            path: ".toolplane/",
            kind: "folder",
            scopeLabel: "Revision metadata",
            summary:
              "Stores the reviewed, immutable revision lockfile so runtime behavior never drifts.",
            snippet:
              "revision: rev.4\nruntime: pi-sdk\npolicy: immutable-session-pin",
          },
          "revision-lock": {
            id: "revision-lock",
            path: ".toolplane/revision-v4.lock",
            kind: "file",
            scopeLabel: "Immutable lockfile",
            summary:
              "Pins the exact model binding, explicit MCP grants, and captured Pi plugin digests.",
            snippet:
              '{\n  "revision": 4,\n  "plugins": ["code-review@7d4e2a1"],\n  "mcpGrants": ["github:get_pr", "postgres-ro:query"]\n}',
          },
          plugins: {
            id: "plugins",
            path: "plugins/",
            kind: "folder",
            scopeLabel: "Read-only plugin layer",
            summary:
              "Immutable Pi plugin artifacts captured from fixed GitHub commits and mounted read-only.",
            snippet:
              "code-review@7d4e2a1/  (verified v3 artifact)\nread-only mount · no runtime network install",
          },
          "skill-md": {
            id: "skill-md",
            path: "plugins/code-review@7d4e2a1/SKILL.md",
            kind: "file",
            scopeLabel: "Pinned skill",
            summary:
              "Declarative instructions and constraints activated only after explicit revision review.",
            snippet:
              "# code-review\n- Verify workspace & auth boundaries\n- Output reproducible check commands and risks",
          },
          "plugin-pkg": {
            id: "plugin-pkg",
            path: "plugins/code-review@7d4e2a1/package.json",
            kind: "file",
            scopeLabel: "Pi manifest",
            summary:
              "Schema v3 compatible Pi package manifest declaring version, skills, prompts, and extensions.",
            snippet:
              '{\n  "name": "@toolplane/code-review",\n  "version": "1.4.0",\n  "pi": { "skills": ["SKILL.md"] }\n}',
          },
          sessions: {
            id: "sessions",
            path: "sessions/",
            kind: "folder",
            scopeLabel: "Session isolation",
            summary:
              "One persistent sandbox per agent, while each conversation gets an isolated workspace dir and native history.",
            snippet:
              "conv-01/  -> pinned rev.4\nconv-02/  -> pinned rev.3 (stays pinned until upgraded)",
          },
          "conv-01": {
            id: "conv-01",
            path: "sessions/conv-01/workspace/patch.diff",
            kind: "file",
            scopeLabel: "Session conv-01 · rev.4",
            summary:
              "Working files and generated diffs stay scoped to conv-01 without leaking into sibling chats.",
            snippet:
              "diff --git a/src/auth/guard.ts b/src/auth/guard.ts\n+ assertWorkspaceRole(ctx, 'admin');",
          },
          "conv-02": {
            id: "conv-02",
            path: "sessions/conv-02/workspace/notes.md",
            kind: "file",
            scopeLabel: "Session conv-02 · rev.3",
            summary:
              "Existing sessions stay pinned to rev.3 so new rollouts never break in-flight conversations.",
            snippet:
              "## Session log\n- Pinned revision: rev.3\n- History: native JSONL persisted",
          },
        },
        gatewayHubLabel: "ToolPlane",
        gatewayAriaLabel: "ToolPlane unified gateway routing",
        gatewayPolicyLabel: "Policy",
        gatewayAuthLabel: "Auth boundary",
        gatewayRoutes: [
          {
            id: "managed-mcp",
            label: "Managed MCP runtimes",
            transport: "JSON-RPC · npm / PyPI / GitHub",
            auth: "Workspace-scoped credentials",
            policy: "Explicit per-tool grants & health probes",
            description:
              "Run MCP servers as managed processes with explicit tool authorization and request telemetry.",
          },
          {
            id: "docker-remote",
            label: "Docker & Remote HTTP",
            transport: "Streamable HTTP / Container",
            auth: "Secrets stay encrypted in console",
            policy: "Timeouts, bounds & structured redaction",
            description:
              "Route containerized tools and remote HTTP endpoints through a single authenticated JSON-RPC gateway.",
          },
          {
            id: "device-bridge",
            label: "Sandboxes & device bridges",
            transport: "Docker Sandbox · Connector · ADB",
            auth: "Scoped pairing & explicit session boundary",
            policy: "Container isolation or explicit local-user mode",
            description:
              "Dispatch execution to persistent Docker sandboxes, local machine Connectors, or ADB Android devices.",
          },
        ],
      },
      pipeline: {
        title: "Deterministic control from commit to sandbox",
        description:
          "Nothing silently mutates live agents. Every capability moves through capture, explicit grant, reviewed revision, and isolated execution.",
        steps: [
          {
            index: "01",
            title: "Pinned GitHub commit",
            description:
              "Capture immutable Pi plugin artifacts from exact commit SHAs—never floating branches.",
          },
          {
            index: "02",
            title: "Explicit MCP grants",
            description:
              "Deploy managed MCP servers and authorize tools individually as allow, approve, or deny.",
          },
          {
            index: "03",
            title: "Immutable agent revision",
            description:
              "Review diffs before applying; active sessions stay pinned until explicitly upgraded.",
          },
          {
            index: "04",
            title: "Persistent sandbox isolation",
            description:
              "Reuse one persistent sandbox per agent while isolating every session directory and history.",
          },
        ],
      },
      mcpPreview: {
        caption:
          "Click any policy badge to cycle per-tool authorization states (illustrative)",
        policyLabels: {
          allow: "Allow",
          approve: "Approval",
          deny: "Deny",
        },
        policyToggleHint: "Cycle policy",
        servers: [
          {
            id: "github-mcp",
            name: "github-mcp",
            source: "npm · Managed process",
            endpoint: "/gateway/ws-ops/github-mcp",
            tools: [
              {
                id: "get-pr",
                name: "get_pull_request",
                description: "Read PR files and review metadata",
                latency: "42ms",
                defaultPolicy: "allow",
                scope: "read:repo",
              },
              {
                id: "create-comment",
                name: "create_review_comment",
                description: "Post an inline review comment on a diff",
                latency: "68ms",
                defaultPolicy: "approve",
                scope: "write:pr",
              },
              {
                id: "delete-branch",
                name: "delete_branch",
                description: "Delete a remote git branch (high risk)",
                latency: "—",
                defaultPolicy: "deny",
                scope: "admin:repo",
              },
            ],
          },
          {
            id: "postgres-ro",
            name: "postgres-ro",
            source: "Docker · Container",
            endpoint: "/gateway/ws-ops/postgres-ro",
            tools: [
              {
                id: "list-schemas",
                name: "list_schemas",
                description: "Inspect database schemas and tables",
                latency: "19ms",
                defaultPolicy: "allow",
                scope: "read:schema",
              },
              {
                id: "explain-query",
                name: "explain_select",
                description: "Run read-only EXPLAIN plans",
                latency: "54ms",
                defaultPolicy: "allow",
                scope: "read:rows",
              },
              {
                id: "export-csv",
                name: "export_table_snapshot",
                description: "Export bounded snapshot into session workspace",
                latency: "185ms",
                defaultPolicy: "approve",
                scope: "export:data",
              },
            ],
          },
          {
            id: "internal-ops",
            name: "internal-ops",
            source: "Remote HTTP · Authenticated",
            endpoint: "/gateway/ws-ops/internal-ops",
            tools: [
              {
                id: "service-health",
                name: "get_service_health",
                description: "Query internal cluster health & versions",
                latency: "31ms",
                defaultPolicy: "allow",
                scope: "read:status",
              },
              {
                id: "trigger-rollback",
                name: "trigger_release_rollback",
                description: "Trigger a release rollback workflow",
                latency: "—",
                defaultPolicy: "approve",
                scope: "ops:deploy",
              },
            ],
          },
        ],
      },
      skillsPreview: {
        caption:
          "Illustrative artifact card · Reflects real GitHub Plugin Center v3 indexing",
        reviewBanner:
          "Adding a plugin to a workspace grants zero execution rights until reviewed and applied to an agent",
        commitLabel: "Pinned commit",
        artifactsLabel: "Captured files",
        plugins: [
          {
            id: "code-review",
            repo: "asharca/toolplane-plugins",
            pluginId: "code-review",
            commit: "7d4e2a1",
            schema: "v3 multi-plugin index",
            version: "1.4.0",
            summary:
              "A Pi plugin for code and permission review bundling Skill instructions, audit prompts, and lint guards.",
            artifacts: [
              { path: "SKILL.md", role: "Skill" },
              { path: "prompts/pr-audit.md", role: "Prompt" },
              { path: "extensions/lint-guard.ts", role: "Extension" },
              { path: "package.json", role: "Manifest" },
            ],
            reviewNote: "SHA-256 locked · Read-only mount",
          },
          {
            id: "release-ops",
            repo: "team-infra/release-skill",
            pluginId: "release-ops",
            commit: "c91b40e",
            schema: "v3 single-plugin repo",
            version: "0.9.2",
            summary:
              "Root-level Pi package synced directly from a single-plugin repo with release and rollback playbooks.",
            artifacts: [
              { path: "SKILL.md", role: "Skill" },
              { path: "prompts/rollback-check.md", role: "Prompt" },
              { path: "themes/ops-console.json", role: "Theme" },
              { path: "package.json", role: "Manifest" },
            ],
            reviewNote: "Code or permission changes require re-review",
          },
        ],
      },
      agentsPreview: {
        revisionCard: {
          title: "Immutable revisions & pinned sessions",
          description:
            "Every model, MCP grant, or plugin edit creates a reviewable diff. Existing sessions stay pinned to their revision until explicitly upgraded.",
          badge: "rev.3 → rev.4",
          tabs: {
            diff: "Revision diff",
            sessions: "Active sessions",
          },
          diffLines: [
            {
              id: "d1",
              type: "context",
              text: "runtime: pi-sdk (persistent-sandbox)",
            },
            {
              id: "d2",
              type: "add",
              text: "+ plugin: code-review@7d4e2a1 (v1.4.0)",
            },
            {
              id: "d3",
              type: "add",
              text: "+ mcp.github: get_pull_request [allow]",
            },
            {
              id: "d4",
              type: "add",
              text: "+ mcp.github: create_review_comment [approve]",
            },
            {
              id: "d5",
              type: "remove",
              text: "- mcp.github: push_files [revoked]",
            },
            {
              id: "d6",
              type: "context",
              text: "a2a.delegate: depth <= 3 · cycle-guard on",
            },
          ],
          sessions: [
            {
              id: "sess-1",
              name: "conv-01 · PR #418 review",
              revision: "rev.4",
              status: "Running latest revision",
              workspaceDir: "/sessions/conv-01/workspace",
            },
            {
              id: "sess-2",
              name: "conv-02 · Incident triage",
              revision: "rev.3",
              status: "Pinned · unaffected by new rollout",
              workspaceDir: "/sessions/conv-02/workspace",
            },
          ],
        },
        sandboxCard: {
          title: "Persistent sandboxes & device bridges",
          description:
            "Match execution targets to the right trust boundary—container isolation vs. explicit local-machine access.",
          targets: [
            {
              id: "docker",
              name: "Docker persistent sandbox",
              badge: "Container isolated",
              description:
                "Reused per agent with per-conversation workspace directories and pre-baked tool images.",
            },
            {
              id: "connector",
              name: "Local Connector",
              badge: "Local user perms",
              description:
                "Bridges your workstation via pairing command. Runs with local user permissions, not container isolation.",
            },
            {
              id: "adb",
              name: "ADB Android bridge",
              badge: "Mobile device",
              description:
                "Connects authorized Android devices for inspection and automated workflows.",
            },
          ],
        },
        a2aCard: {
          title: "Native A2A sub-agent delegation",
          description:
            "Delegate specialized work across agents over ToolPlane's native A2A protocol with depth limits, cycle guards, and tool approval gates.",
          steps: [
            {
              id: "coord",
              role: "Coordinator",
              title: "Coordinator Agent",
              detail:
                "Dispatches sub-tasks while preserving original UTF-8 filenames",
            },
            {
              id: "gate",
              role: "Guardrail",
              title: "Depth & Approval Gate",
              detail:
                "Enforces recursion limits, cycle protection, and approval checkpoints",
            },
            {
              id: "sub",
              role: "Specialist",
              title: "Audit Sub-Agent",
              detail:
                "Executes in its own pinned revision with persisted tool history",
            },
          ],
          footerNote:
            "Persisted tool calls remain expandable after refresh with bounded, redacted logs and workspace-scoped read-only visibility.",
        },
      },
      clientsPreview: {
        surfaces: [
          "Agent Control MCP",
          "OpenAPI · /docs-api",
          "Telegram · Feishu · Discord · WeChat",
          "LogEvent & Trace Waterfall",
        ],
        sceneLabel: "ToolPlane integration and observability layers",
        caption:
          "Select a layer below to inspect each integration surface (illustrative)",
        nodes: [
          {
            id: "mcp",
            label: "MCP",
            title: "Control MCP",
            detail:
              "Connect external AI clients via account-scoped personal API tokens to workspace-governed agents.",
          },
          {
            id: "api",
            label: "API",
            title: "OpenAPI & Docs",
            detail:
              "Every running instance serves interactive /docs-api and /api/v1/openapi.json definitions.",
          },
          {
            id: "im",
            label: "IM",
            title: "Chat channels",
            detail:
              "Connect agents to Telegram, Feishu, Discord, and WeChat with separate channel thread grouping.",
          },
          {
            id: "trace",
            label: "TRACE",
            title: "LogEvent Traces",
            detail:
              "Inspect tool calls, latencies, failures, and bounded redacted records without stitching another stack.",
          },
        ],
      },
      security: {
        title: "Security boundaries built into the control plane",
        description:
          "Workspace isolation, least-privilege sandboxes, and secret redaction are enforced by default.",
        items: [
          {
            id: "workspace-auth",
            title: "Workspace authority",
            description:
              "Credentials, runtimes, and private threads stay strictly scoped to authenticated workspace roles; anonymous and cross-workspace access is denied.",
          },
          {
            id: "sandbox-isolation",
            title: "Least-privilege sandboxes",
            description:
              "Sandbox, LSP, and debugpy run from dedicated pre-pulled images with no ad-hoc internet installs—prepping an image never auto-enables tools.",
          },
          {
            id: "immutable-pin",
            title: "Immutable revision pinning",
            description:
              "GitHub plugins lock to exact commits, capability changes require explicit review, and active sessions stay pinned to their original revision.",
          },
          {
            id: "redaction",
            title: "Structured errors & secret redaction",
            description:
              "Hashed API tokens, encrypted workspace credentials, and bounded redacted logs keep sensitive payloads out of traces and UI playback.",
          },
        ],
      },
      quickstart: {
        title: "Self-host in minutes",
        description:
          "Clone the repository, set a random AUTH_SECRET in .env, and launch with Docker Compose. Before exposing publicly, configure HTTPS, access controls, and agent tool images.",
        runtimeNote:
          "Architecture note: ToolPlane requires a single persistent application process—it is not built for serverless or multi-instance shared runtime domains.",
        docsLabel: "Read full docs",
        opsUrl:
          "https://asharca.github.io/toolplane-docs/docs/en/developers/docs/RUNTIME_OPERATIONS",
        opsLabel: "Runtime operations guide",
        copy: "Copy",
        copied: "Copied",
        copyFailed: "Copy failed",
        tabs: {
          docker: {
            label: "Docker Compose",
            note: "Listens on http://localhost:10030 by default. Replace AUTH_SECRET in .env using openssl rand -base64 32 before starting.",
            command: `git clone https://github.com/asharca/ToolPlane.git
cd ToolPlane
test -f .env || cp .env.example .env
# Set AUTH_SECRET in .env (e.g. openssl rand -base64 32)
docker compose pull app lsp-tools-image
docker compose up -d`,
          },
          local: {
            label: "Local dev (pnpm)",
            note: "Requires Node.js >= 26.12.1, pnpm, and Docker. Configure local DATABASE_URL and NEXT_PUBLIC_APP_URL in .env.",
            command: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev`,
          },
        },
      },
      faq: {
        title: "Frequently asked questions",
        description:
          "Direct answers on architecture, governance, and deployment boundaries.",
        items: [
          {
            id: "what-is-toolplane",
            question: "What does ToolPlane actually manage?",
            answer:
              "ToolPlane is a self-hosted control plane organized by workspace. It manages MCP servers (npm, PyPI, GitHub, Docker, Remote HTTP), GitHub-pinned Pi plugins and skills, Pi SDK agents with immutable revisions, and execution environments across Docker persistent sandboxes, local Connectors, and ADB Android bridges.",
          },
          {
            id: "how-plugins-work",
            question:
              "How does the GitHub Plugin Center prevent upstream drift?",
            answer:
              "It supports v3 multi-plugin registries (registry.json) and single-plugin repositories, capturing immutable Pi plugin artifacts from exact commit SHAs. Adding a plugin to a workspace grants no execution rights until reviewed and applied to an agent revision, and existing conversations remain pinned to their original revision.",
          },
          {
            id: "serverless-scaling",
            question:
              "Can I deploy ToolPlane on serverless or multiple stateless replicas?",
            answer:
              "No. ToolPlane supervises real MCP processes, persistent sandboxes, and long-lived runtime connections. It requires a single persistent application process and should not have multiple instances operating against the same runtime domain.",
          },
          {
            id: "docker-vs-connector",
            question:
              "How does Local Connector differ from a Docker persistent sandbox?",
            answer:
              "A Docker persistent sandbox runs inside an isolated container with per-conversation workspace directories and pre-baked images. Local Connector bridges your own workstation and runs with your local user permissions—it is intentionally not equivalent to container isolation.",
          },
          {
            id: "external-clients",
            question: "How do external AI clients and messaging apps connect?",
            answer:
              "External AI clients connect via Agent Control MCP using account-scoped personal API tokens. Programmatic integrations can use each instance's /docs-api and /api/v1/openapi.json, while teams can connect agents to Telegram, Feishu, Discord, and WeChat.",
          },
        ],
      },
      cta: {
        title: "Keep your agent control plane in your own hands",
        description:
          "Open-source, self-hosted, and built with explicit boundaries. Open the console or follow the docs to deploy your first workspace.",
        primaryCta: "Open console",
        githubCta: "View on GitHub",
        docsCta: "Read docs",
      },
    },
    capabilities: {
      mcp: {
        eyebrow: "MCP runtime & gateway",
        title: "Run MCP servers as managed processes with explicit tool grants",
        description:
          "Deploy MCP servers from npm, PyPI, GitHub, Docker, or Remote HTTP behind one authenticated JSON-RPC gateway with per-tool policies and operational telemetry.",
        highlights: [
          {
            title: "Managed multi-source runtimes",
            description:
              "Run npm, PyPI, GitHub, Docker containers, or remote HTTP endpoints with credentials kept safely inside the workspace.",
          },
          {
            title: "Explicit per-tool authorization",
            description:
              "Approve, gate, or deny individual tools so agents only receive the exact capabilities they need.",
          },
          {
            title: "Unified gateway & telemetry",
            description:
              "Expose one consistent JSON-RPC interface with built-in health state, latency, and structured error tracking.",
          },
        ],
      },
      skills: {
        eyebrow: "GitHub Plugin Center",
        title: "Capture immutable Pi plugins from pinned GitHub commits",
        description:
          "Sync skills, prompts, extensions, and themes directly from GitHub at fixed commit SHAs. Add to a workspace first, then review diffs before applying to an agent.",
        highlights: [
          {
            title: "Fixed commit capture",
            description:
              "Pin every artifact to an exact commit SHA so floating branches never silently alter production agent behavior.",
          },
          {
            title: "v3 multi-plugin & single-plugin repos",
            description:
              "Supports schemaVersion 3 registry.json indexes and root-level single-plugin repositories out of the box.",
          },
          {
            title: "Explicit review before apply",
            description:
              "Syncing to a workspace never auto-enables execution; every new permission or code update is reviewed first.",
          },
        ],
      },
      agents: {
        eyebrow: "Pi SDK agent runtime",
        title: "Immutable revisions, persistent sandboxes, and native A2A",
        description:
          "Run auditable Pi SDK agents where revisions are reviewed before rollout, persistent sandboxes isolate per-conversation workspaces, and sub-agents delegate safely.",
        highlights: [
          {
            title: "Reviewable revisions, pinned sessions",
            description:
              "Roll out changes with clear diffs while existing sessions stay pinned to their applied revision until upgraded.",
          },
          {
            title: "Sandboxes & device bridges",
            description:
              "Orchestrate Docker persistent sandboxes, local machine Connectors, and ADB Android devices with clear trust boundaries.",
          },
          {
            title: "Native A2A delegation",
            description:
              "Delegate tasks to specialist sub-agents with depth limits, cycle guards, approval gates, and persisted tool traces.",
          },
        ],
      },
      clients: {
        eyebrow: "Integrations & observability",
        title: "Govern once, connect across clients, APIs, and chat channels",
        description:
          "Connect external AI clients via Agent Control MCP, integrate via OpenAPI (/docs-api), chat over messaging platforms, and inspect every execution in Trace Waterfall.",
        highlights: [
          {
            title: "Agent Control MCP & OpenAPI",
            description:
              "Authenticate external clients with personal API tokens and explore live endpoints via /docs-api and OpenAPI.",
          },
          {
            title: "Messaging channels",
            description:
              "Bring workspace agents into Telegram, Feishu, Discord, and WeChat with clean thread grouping and read-only review.",
          },
          {
            title: "LogEvent & Trace Waterfall",
            description:
              "Audit spans, tool payloads, latencies, and errors with bounded, redacted history that survives page refreshes.",
          },
        ],
      },
    },
  },
};

export function getMarketingContent(locale: string): MarketingContent {
  return locale.toLowerCase().startsWith("zh") ? CONTENT.zh : CONTENT.en;
}
