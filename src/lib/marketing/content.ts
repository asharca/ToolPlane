export type MarketingCapability = 'mcp' | 'skills' | 'agents' | 'clients';

type MarketingLink = {
  label: string;
  href: string;
};

type CapabilityContent = {
  eyebrow: string;
  title: string;
  description: string;
  summary: string;
  highlights: Array<{
    title: string;
    description: string;
  }>;
  flowTitle: string;
  flow: string[];
  principleTitle: string;
  principle: string;
};

export type MarketingContent = {
  navigation: {
    menu: string;
    sourceCode: string;
    openConsole: string;
    links: MarketingLink[];
  };
  footer: {
    tagline: string;
    product: string;
    resources: string;
    access: string;
    sourceCode: string;
    mcpProtocol: string;
    documentation: string;
    openConsole: string;
    signIn: string;
    privacy: string;
    terms: string;
    rights: string;
  };
  home: {
    eyebrow: string;
    title: string;
    description: string;
    primaryAction: string;
    secondaryAction: string;
    trustPoints: string[];
    valueEyebrow: string;
    valueTitle: string;
    values: Array<{
      title: string;
      description: string;
    }>;
    capabilityEyebrow: string;
    capabilityTitle: string;
    architectureEyebrow: string;
    architectureTitle: string;
    architectureDescription: string;
    architecturePoints: string[];
    closingTitle: string;
    closingDescription: string;
    closingAction: string;
  };
  capabilityCommon: {
    overview: string;
    openConsole: string;
    consoleNote: string;
    howItWorks: string;
  };
  capabilities: Record<MarketingCapability, CapabilityContent>;
};

const CONTENT = {
  en: {
    navigation: {
      menu: 'Menu',
      sourceCode: 'Source',
      openConsole: 'Open console',
      links: [
        { label: 'Overview', href: '/' },
        { label: 'MCP runtime', href: '/server' },
        { label: 'Skills', href: '/tools/skills' },
        { label: 'Agents', href: '/agents' },
        { label: 'Integrations', href: '/client' },
      ],
    },
    footer: {
      tagline: 'A self-hosted control plane for agent tools, runtimes, and reusable intelligence.',
      product: 'Product',
      resources: 'Resources',
      access: 'Workspace',
      sourceCode: 'Source code',
      mcpProtocol: 'MCP protocol',
      documentation: 'Why MCP matters',
      openConsole: 'Open console',
      signIn: 'Sign in',
      privacy: 'Privacy',
      terms: 'Terms',
      rights: 'All rights reserved.',
    },
    home: {
      eyebrow: 'Self-hosted agent infrastructure',
      title: 'One control plane for every tool your agents depend on.',
      description:
        'Deploy MCP runtimes, package durable skills, compose production agents, and observe every call from a workspace your team controls.',
      primaryAction: 'Open your workspace',
      secondaryAction: 'Explore the architecture',
      trustPoints: ['Your infrastructure', 'Real MCP processes', 'Workspace isolation'],
      valueEyebrow: 'Built for operational clarity',
      valueTitle: 'Move from scattered integrations to one governed system.',
      values: [
        {
          title: 'Own the runtime',
          description:
            'Run the control plane and its tool processes on infrastructure you choose, with secrets kept inside your workspace.',
        },
        {
          title: 'Compose without lock-in',
          description:
            'Combine MCP servers, skills, toolkits, and model providers into agents without coupling everything to one vendor.',
        },
        {
          title: 'See every request',
          description:
            'Trace tool traffic, latency, errors, and deployment health from the same place your team manages resources.',
        },
        {
          title: 'Govern as a team',
          description:
            'Use workspaces, membership, scoped tokens, and managed catalogs to keep access intentional as adoption grows.',
        },
      ],
      capabilityEyebrow: 'A complete agent toolchain',
      capabilityTitle: 'Each layer works alone. Together, they become an operating plane.',
      architectureEyebrow: 'Designed for real workloads',
      architectureTitle: 'The console is the source of truth.',
      architectureDescription:
        'Public pages explain the product. Your authenticated workspace contains the live catalog, configuration, versions, and actions that belong to your team.',
      architecturePoints: [
        'Live Node subprocesses for deployed MCP servers',
        'JSON-RPC gateway with token and workspace authorization',
        'Versioned skills and reusable toolkit manifests',
        'Streaming agents backed by your chosen model providers',
      ],
      closingTitle: 'Give your agents an infrastructure layer you can operate.',
      closingDescription:
        'Sign in to see the real workspace catalog, inspect resources, and deploy what your team needs.',
      closingAction: 'Go to console',
    },
    capabilityCommon: {
      overview: 'Back to overview',
      openConsole: 'Open console',
      consoleNote: 'Live catalog and actions are available after sign-in.',
      howItWorks: 'How it works',
    },
    capabilities: {
      mcp: {
        eyebrow: 'MCP runtime',
        title: 'Deploy tools as live, observable MCP services.',
        description:
          'ToolPlane turns MCP definitions into managed processes with a stable JSON-RPC gateway, health state, and request telemetry.',
        summary: 'Managed MCP runtimes with a secure workspace gateway.',
        highlights: [
          {
            title: 'Real processes',
            description: 'Each deployment runs as an actual isolated Node process instead of a UI-only mock.',
          },
          {
            title: 'One gateway',
            description: 'Connect through a consistent JSON-RPC endpoint protected by workspace-aware authentication.',
          },
          {
            title: 'Operational signals',
            description: 'Inspect availability, request volume, latency, and failures without stitching together another dashboard.',
          },
        ],
        flowTitle: 'From definition to callable tool',
        flow: ['Choose or define an MCP server', 'Deploy it into a workspace', 'Call tools through the authenticated gateway'],
        principleTitle: 'Control stays with the workspace',
        principle:
          'Credentials and runtime configuration remain in the authenticated console. This public page never exposes your catalog or deployment state.',
      },
      skills: {
        eyebrow: 'Agent skills',
        title: 'Turn repeatable expertise into versioned building blocks.',
        description:
          'Package instructions and supporting files once, then attach that knowledge consistently to agents and toolkits across a workspace.',
        summary: 'Reusable, versionable knowledge for consistent agent behavior.',
        highlights: [
          {
            title: 'Portable instructions',
            description: 'Keep specialized workflows in structured skill artifacts instead of duplicating prompts across agents.',
          },
          {
            title: 'Workspace reuse',
            description: 'Install a skill once and compose it into agents or larger toolkits whenever it is needed.',
          },
          {
            title: 'Predictable context',
            description: 'Resolve skill content into the agent system prompt using a transparent, inspectable pipeline.',
          },
        ],
        flowTitle: 'From expertise to reusable context',
        flow: ['Create or install a skill', 'Review its instructions and files', 'Attach it to agents or toolkits'],
        principleTitle: 'Knowledge remains inspectable',
        principle:
          'Skills are explicit artifacts rather than hidden behavior. Workspace members can inspect what an agent will receive before running it.',
      },
      agents: {
        eyebrow: 'Agent operations',
        title: 'Compose agents from models, tools, skills, and teams.',
        description:
          'Build streaming agents on top of the resources already governed by your workspace, including nested agents and reusable toolkits.',
        summary: 'Production agents composed from governed workspace resources.',
        highlights: [
          {
            title: 'Provider choice',
            description: 'Connect compatible model providers and select the right model for each agent instead of hard-coding one stack.',
          },
          {
            title: 'Unified resources',
            description: 'Attach direct MCP deployments, skills, toolkits, and sub-agents through one clear configuration model.',
          },
          {
            title: 'Streaming execution',
            description: 'Run multi-step conversations with real tool calls while keeping histories scoped to the correct agent.',
          },
        ],
        flowTitle: 'From resources to a working agent',
        flow: ['Choose a model and instructions', 'Attach workspace resources', 'Test, observe, and refine in the console'],
        principleTitle: 'The real market is private to signed-in users',
        principle:
          'Listings, details, review state, and install actions live only in the authenticated console. The public site describes the capability without mirroring market data.',
      },
      clients: {
        eyebrow: 'Client integrations',
        title: 'Connect the clients your team already uses.',
        description:
          'Expose workspace tools through stable manifests and authenticated endpoints so compatible clients can consume the same governed resources.',
        summary: 'Stable connection surfaces for MCP-compatible clients.',
        highlights: [
          {
            title: 'Consistent manifests',
            description: 'Export workspace and toolkit definitions through predictable endpoints designed for automation.',
          },
          {
            title: 'Scoped access',
            description: 'Use hashed API tokens and workspace authorization for machine-to-machine connections.',
          },
          {
            title: 'Shared control',
            description: 'Let multiple clients rely on the same managed deployments without duplicating configuration everywhere.',
          },
        ],
        flowTitle: 'From workspace to client',
        flow: ['Organize resources in a workspace or toolkit', 'Create a scoped API token', 'Connect through the exported manifest and gateway'],
        principleTitle: 'Configuration is never published here',
        principle:
          'Connection details, tokens, and live resources stay behind authentication. This page is a product overview, not a public client directory.',
      },
    },
  },
  zh: {
    navigation: {
      menu: '菜单',
      sourceCode: '源代码',
      openConsole: '进入控制台',
      links: [
        { label: '产品概览', href: '/' },
        { label: 'MCP 运行时', href: '/server' },
        { label: '技能', href: '/tools/skills' },
        { label: '智能体', href: '/agents' },
        { label: '客户端集成', href: '/client' },
      ],
    },
    footer: {
      tagline: '面向智能体工具、运行时与可复用知识的自托管控制平面。',
      product: '产品能力',
      resources: '项目资源',
      access: '工作空间',
      sourceCode: '源代码',
      mcpProtocol: 'MCP 协议',
      documentation: '为什么需要 MCP',
      openConsole: '进入控制台',
      signIn: '登录',
      privacy: '隐私',
      terms: '条款',
      rights: '保留所有权利。',
    },
    home: {
      eyebrow: '自托管智能体基础设施',
      title: '用一个控制平面，管理智能体依赖的所有工具。',
      description:
        '部署 MCP 运行时、沉淀可复用技能、编排生产级智能体，并在团队自主掌控的工作空间中观测每一次调用。',
      primaryAction: '进入工作空间',
      secondaryAction: '了解产品架构',
      trustPoints: ['部署在你的基础设施', '真实 MCP 进程', '工作空间隔离'],
      valueEyebrow: '为清晰运维而构建',
      valueTitle: '把分散的智能体集成，收敛成一个可治理的系统。',
      values: [
        {
          title: '掌控运行环境',
          description: '在你选择的基础设施上运行控制平面和工具进程，密钥始终保留在工作空间内。',
        },
        {
          title: '自由组合能力',
          description: '将 MCP、技能、工具包和模型供应商组合成智能体，不必把整个技术栈绑定到单一厂商。',
        },
        {
          title: '看见每次调用',
          description: '在管理资源的同一处查看工具流量、延迟、错误和部署健康度。',
        },
        {
          title: '面向团队治理',
          description: '通过工作空间、成员、受限令牌和受管目录，让权限随着团队规模增长仍然清晰。',
        },
      ],
      capabilityEyebrow: '完整的智能体工具链',
      capabilityTitle: '每一层都可以独立使用，组合后成为统一的智能体操作平面。',
      architectureEyebrow: '为真实工作负载设计',
      architectureTitle: '控制台才是真实数据源。',
      architectureDescription:
        '公开页面只介绍产品。登录后的工作空间才包含属于团队的实时市场、配置、版本和操作，二者不会同步数据。',
      architecturePoints: [
        '每个 MCP 部署都运行真实 Node 子进程',
        '带令牌与工作空间鉴权的 JSON-RPC 网关',
        '版本化技能和可复用工具包清单',
        '由团队自选模型供应商驱动的流式智能体',
      ],
      closingTitle: '为智能体提供一个真正可运营的基础设施层。',
      closingDescription: '登录后查看真实工作空间市场、检查资源，并部署团队需要的能力。',
      closingAction: '进入控制台',
    },
    capabilityCommon: {
      overview: '返回产品概览',
      openConsole: '进入控制台',
      consoleNote: '登录后可查看真实市场、资源详情和操作入口。',
      howItWorks: '工作方式',
    },
    capabilities: {
      mcp: {
        eyebrow: 'MCP 运行时',
        title: '把工具部署为真实、可观测的 MCP 服务。',
        description: 'ToolPlane 将 MCP 定义变成受管进程，并提供稳定的 JSON-RPC 网关、健康状态和请求观测。',
        summary: '通过安全工作空间网关管理真实 MCP 运行时。',
        highlights: [
          { title: '真实进程', description: '每个部署都运行实际隔离的 Node 进程，而不是只在界面中模拟状态。' },
          { title: '统一网关', description: '通过一致的 JSON-RPC 入口连接，并使用工作空间级鉴权保护调用。' },
          { title: '运维信号', description: '无需拼接其他看板，即可检查可用性、请求量、延迟和失败。' },
        ],
        flowTitle: '从定义到可调用工具',
        flow: ['选择或定义 MCP 服务', '部署到工作空间', '通过鉴权网关调用工具'],
        principleTitle: '控制权留在工作空间',
        principle: '凭据和运行配置始终位于登录后的控制台；公开页面不会暴露你的市场、目录或部署状态。',
      },
      skills: {
        eyebrow: '智能体技能',
        title: '把可重复的专业经验沉淀为版本化能力。',
        description: '一次打包指令和配套文件，即可在工作空间中的智能体和工具包之间稳定复用。',
        summary: '通过可复用、可版本化的知识，让智能体行为保持一致。',
        highlights: [
          { title: '可移植指令', description: '把专业工作流保存在结构化技能中，无需在多个智能体间复制提示词。' },
          { title: '工作空间复用', description: '技能只需安装一次，即可按需组合到智能体或更大的工具包中。' },
          { title: '可预期上下文', description: '通过透明、可检查的流程，将技能内容解析到智能体系统提示词。' },
        ],
        flowTitle: '从专业经验到可复用上下文',
        flow: ['创建或安装技能', '检查技能指令和文件', '绑定到智能体或工具包'],
        principleTitle: '知识始终可检查',
        principle: '技能是显式资源而不是隐藏行为，工作空间成员可在运行前确认智能体将获得哪些内容。',
      },
      agents: {
        eyebrow: '智能体运营',
        title: '用模型、工具、技能与智能体团队完成编排。',
        description: '基于工作空间已经治理的资源构建流式智能体，并支持嵌套智能体与可复用工具包。',
        summary: '使用受治理的工作空间资源编排生产级智能体。',
        highlights: [
          { title: '自由选择模型', description: '连接兼容的模型供应商，为不同智能体选择合适模型，而不是写死单一技术栈。' },
          { title: '统一资源模型', description: '通过清晰配置绑定 MCP 部署、技能、工具包和子智能体。' },
          { title: '流式执行', description: '运行包含真实工具调用的多步对话，同时确保会话历史严格归属于对应智能体。' },
        ],
        flowTitle: '从工作空间资源到可运行智能体',
        flow: ['选择模型并编写指令', '绑定工作空间资源', '在控制台测试、观测和迭代'],
        principleTitle: '真实市场只对登录用户开放',
        principle: '市场条目、详情、审核状态和添加操作只存在于登录后的控制台；公开站仅介绍能力，不同步市场数据。',
      },
      clients: {
        eyebrow: '客户端集成',
        title: '连接团队已经使用的客户端。',
        description: '通过稳定清单和鉴权端点暴露工作空间工具，让兼容客户端使用同一组受治理资源。',
        summary: '为 MCP 兼容客户端提供稳定的连接界面。',
        highlights: [
          { title: '一致的清单', description: '通过可预测端点导出工作空间和工具包定义，便于自动化接入。' },
          { title: '受限访问', description: '使用哈希 API 令牌与工作空间授权保护机器间连接。' },
          { title: '共享治理', description: '让多个客户端复用相同受管部署，不必在各处重复维护配置。' },
        ],
        flowTitle: '从工作空间连接到客户端',
        flow: ['在工作空间或工具包中组织资源', '创建受限 API 令牌', '通过导出清单和网关完成连接'],
        principleTitle: '配置永远不会发布到这里',
        principle: '连接信息、令牌和实时资源都保留在鉴权之后；本页面是产品介绍，不是公开客户端目录。',
      },
    },
  },
} satisfies Record<'en' | 'zh', MarketingContent>;

export function getMarketingContent(locale: string): MarketingContent {
  return locale.toLowerCase().startsWith('zh') ? CONTENT.zh : CONTENT.en;
}
