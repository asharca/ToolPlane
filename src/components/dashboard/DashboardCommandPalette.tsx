"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRightLeft,
  Bot,
  Boxes,
  Briefcase,
  Code2,
  Home,
  MessageSquare,
  Moon,
  PanelLeft,
  Plug,
  Sparkles,
  SquarePen,
  Sun,
  Terminal,
  UserCog,
} from "lucide-react";
import {
  CommandPalette,
  type CommandItem,
} from "@/components/motion/command-palette";
import { useThemeToggle } from "@/components/motion/theme-toggle";
import { apiRequest } from "@/lib/client/api";
import { SITE } from "@/lib/site";
import { workspaceSwitchHref } from "@/lib/workspace/navigation";
import { FEEDBACK_NAV_ITEM, WORKSPACE_NAV_GROUPS } from "./workspace-nav";

type WorkspaceSummary = { id: string; slug: string; name: string };

type QuickJumpPayload = {
  assistants: Array<{
    id: string;
    name: string;
    model: string | null;
    pinned: boolean;
    updatedAt: string;
  }>;
  threads: Array<{
    id: string;
    title: string | null;
    assistantId: string;
    assistantName: string | null;
    updatedAt: string;
  }>;
  agents: Array<{
    id: string;
    name: string;
    model: string | null;
    pinned: boolean;
    ready: boolean;
    updatedAt: string;
  }>;
  sessions: Array<{
    id: string;
    title: string | null;
    task: string | null;
    status: string;
    agentId: string;
    agentName: string | null;
    updatedAt: string;
  }>;
  mcpServers: Array<{
    id: string;
    name: string;
    status: string;
    sandboxName: string | null;
    updatedAt: string;
  }>;
  sandboxes: Array<{
    id: string;
    name: string;
    kind: string;
    updatedAt: string;
  }>;
};

const NAV_SEGMENT_KEYWORDS: Record<string, string[]> = {
  chat: ["chat", "assistant", "conversation", "对话", "助手", "聊天"],
  work: [
    "work",
    "task",
    "session",
    "agent",
    "bot",
    "pi",
    "工作",
    "任务",
    "会话",
    "智能体",
  ],
  agents: ["agent", "bot", "pi", "智能体"],
  mcp: ["mcp", "server", "tool", "工具", "服务"],
  skills: ["skill", "prompt", "技能"],
  plugins: ["plugin", "market", "extension", "插件", "扩展"],
  sandboxes: ["sandbox", "container", "docker", "terminal", "沙箱", "终端"],
  providers: ["model", "provider", "llm", "api", "模型", "供应商", "提供商"],
  knowledge: ["knowledge", "rag", "docs", "知识库", "文档"],
  observability: ["log", "trace", "audit", "observability", "日志", "审计"],
  members: ["member", "team", "user", "invite", "role", "成员", "团队", "邀请"],
  files: ["file", "storage", "upload", "attachment", "文件", "存储", "附件"],
  notifications: [
    "notification",
    "inbox",
    "alert",
    "announcement",
    "通知",
    "消息",
    "公告",
  ],
  settings: ["settings", "workspace", "preferences", "设置", "配置"],
  feedback: ["feedback", "bug", "support", "反馈"],
};

function renderEntityMetaBadge(meta: string | null | undefined, kind: string) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {meta ? (
        <>
          <span className="max-w-36 truncate">{meta}</span>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      <span>{kind}</span>
    </span>
  );
}

function workspaceSlug(pathname: string): string | null {
  const parts = pathname.split("/");
  return parts[1] === "app" && parts[2] ? parts[2] : null;
}

/** Workspace quick navigation and command center; the sidebar owns open state. */
export function DashboardCommandPalette({
  open,
  onOpenChange,
  pluginUpdateCount = 0,
  workspaces = [],
  currentSlug,
  onToggleSidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginUpdateCount?: number;
  workspaces?: WorkspaceSummary[];
  currentSlug?: string;
  onToggleSidebar?: () => void;
}) {
  const t = useTranslations("console.header");
  const sidebarT = useTranslations("console.sidebar");
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { isDark, toggle: toggleTheme } = useThemeToggle();
  const slug = currentSlug ?? workspaceSlug(pathname);
  const [quickJumpBySlug, setQuickJumpBySlug] = useState<
    Record<string, QuickJumpPayload>
  >({});

  useEffect(() => {
    if (!open || !slug) return;
    let active = true;
    void apiRequest<QuickJumpPayload>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/quick-jump`,
    ).then((result) => {
      if (!active || !result.ok) return;
      setQuickJumpBySlug((previous) => ({
        ...previous,
        [slug]: result.data,
      }));
    });
    return () => {
      active = false;
    };
  }, [open, slug]);

  const closePalette = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const quickJump = slug ? quickJumpBySlug[slug] : undefined;

  const commands = useMemo<CommandItem[]>(() => {
    const go = (href: string) => () => {
      closePalette();
      router.push(href);
    };
    const openExternal = (href: string) => () => {
      closePalette();
      window.open(href, "_blank", "noopener,noreferrer");
    };

    const items: CommandItem[] = [];
    const actionsGroup = t("groupActions");
    const base = slug ? `/app/${slug}` : null;

    if (base) {
      items.push(
        {
          id: "quick:new-chat",
          label: t("newChatAction"),
          group: actionsGroup,
          icon: SquarePen,
          hint: "⌘⇧O",
          keywords: ["new chat", "assistant", "thread", "新建对话", "助手"],
          onSelect: go(`${base}/chat?new=1`),
        },
        {
          id: "quick:new-work",
          label: t("newWorkAction"),
          group: actionsGroup,
          icon: Briefcase,
          keywords: ["new work", "agent", "task", "新建任务", "智能体"],
          onSelect: go(`${base}/work`),
        },
      );
      if (onToggleSidebar) {
        items.push({
          id: "quick:toggle-sidebar",
          label: t("toggleSidebarAction"),
          group: actionsGroup,
          icon: PanelLeft,
          hint: "⌘\\",
          keywords: ["sidebar", "collapse", "expand", "侧边栏", "收起"],
          onSelect: () => {
            closePalette();
            onToggleSidebar();
          },
        });
      }
      items.push({
        id: "quick:personal-settings",
        label: t("personalSettingsAction"),
        group: actionsGroup,
        icon: UserCog,
        keywords: [
          "account",
          "profile",
          "theme",
          "language",
          "个人设置",
          "账号",
        ],
        onSelect: go(
          `${base}/settings/account?returnTo=${encodeURIComponent(pathname || `${base}/chat`)}`,
        ),
      });
    }

    if (base && quickJump) {
      const recentGroup = t("groupRecent");
      const assistantKind = t("kindAssistant");
      const agentKind = t("kindAgent");
      const threadKind = t("kindThread");
      const workKind = t("kindWorkSession");
      const mcpKind = t("kindMcp");
      const sandboxKind = t("kindSandbox");

      const recentEntries = [
        ...quickJump.threads.map((thread) => ({
          sortAt: Date.parse(thread.updatedAt) || 0,
          item: {
            id: `thread:${thread.id}`,
            label: thread.title?.trim() || thread.assistantName || threadKind,
            group: recentGroup,
            icon: MessageSquare,
            badge: renderEntityMetaBadge(thread.assistantName, threadKind),
            keywords: [
              thread.title ?? "",
              thread.assistantName ?? "",
              "chat",
              "thread",
              "对话",
            ],
            onSelect: go(
              `${base}/chat?assistant=${encodeURIComponent(thread.assistantId)}&thread=${encodeURIComponent(thread.id)}`,
            ),
          } satisfies CommandItem,
        })),
        ...quickJump.sessions.map((session) => ({
          sortAt: Date.parse(session.updatedAt) || 0,
          item: {
            id: `work:${session.id}`,
            label:
              session.title?.trim() ||
              session.task?.trim() ||
              session.agentName ||
              workKind,
            group: recentGroup,
            icon: Terminal,
            badge: renderEntityMetaBadge(session.agentName, workKind),
            keywords: [
              session.title ?? "",
              session.task ?? "",
              session.agentName ?? "",
              session.status,
              "work",
              "session",
              "任务",
            ],
            onSelect: go(`${base}/work?w=${encodeURIComponent(session.id)}`),
          } satisfies CommandItem,
        })),
      ]
        .sort((a, b) => b.sortAt - a.sortAt)
        .slice(0, 10);

      for (const entry of recentEntries) {
        items.push(entry.item);
      }

      const assistantsAndAgentsGroup = t("groupAssistantsAndAgents");
      for (const assistant of quickJump.assistants) {
        items.push({
          id: `assistant:${assistant.id}`,
          label: assistant.name,
          group: assistantsAndAgentsGroup,
          icon: Sparkles,
          badge: renderEntityMetaBadge(assistant.model, assistantKind),
          keywords: [
            assistant.name,
            assistant.model ?? "",
            "assistant",
            "助手",
          ],
          onSelect: go(
            `${base}/chat?assistant=${encodeURIComponent(assistant.id)}`,
          ),
        });
      }
      for (const agent of quickJump.agents) {
        items.push({
          id: `agent:${agent.id}`,
          label: agent.name,
          group: assistantsAndAgentsGroup,
          icon: Bot,
          badge: renderEntityMetaBadge(agent.model, agentKind),
          keywords: [agent.name, agent.model ?? "", "agent", "智能体"],
          onSelect: go(`${base}/work?agent=${encodeURIComponent(agent.id)}`),
        });
      }

      const resourcesGroup = t("groupWorkspaceResources");
      for (const server of quickJump.mcpServers) {
        items.push({
          id: `mcp:${server.id}`,
          label: server.name,
          group: resourcesGroup,
          icon: Plug,
          badge: renderEntityMetaBadge(
            server.sandboxName ?? server.status,
            mcpKind,
          ),
          keywords: [
            server.name,
            server.sandboxName ?? "",
            server.status,
            "mcp",
          ],
          onSelect: go(`${base}/mcp/${encodeURIComponent(server.id)}`),
        });
      }
      for (const sandbox of quickJump.sandboxes) {
        items.push({
          id: `sandbox:${sandbox.id}`,
          label: sandbox.name,
          group: resourcesGroup,
          icon: Boxes,
          badge: renderEntityMetaBadge(sandbox.kind, sandboxKind),
          keywords: [sandbox.name, sandbox.kind, "sandbox", "沙箱"],
          onSelect: go(`${base}/sandboxes/${encodeURIComponent(sandbox.id)}`),
        });
      }
    }

    if (base) {
      for (const group of WORKSPACE_NAV_GROUPS) {
        const groupLabel = sidebarT(group.labelKey);
        for (const item of group.items) {
          const baseKeywords = NAV_SEGMENT_KEYWORDS[item.segment] ?? [
            item.segment,
          ];
          items.push({
            id: item.segment,
            label: sidebarT(item.labelKey),
            group: groupLabel,
            icon: item.icon,
            keywords: [item.segment, ...baseKeywords],
            badge: item.badgeKey
              ? sidebarT(item.badgeKey)
              : item.segment === "plugins" && pluginUpdateCount > 0
                ? pluginUpdateCount
                : undefined,
            onSelect: go(`${base}/${item.segment}`),
          });
        }
      }
      items.push({
        id: FEEDBACK_NAV_ITEM.segment,
        label: sidebarT(FEEDBACK_NAV_ITEM.labelKey),
        group: actionsGroup,
        icon: FEEDBACK_NAV_ITEM.icon,
        keywords: NAV_SEGMENT_KEYWORDS[FEEDBACK_NAV_ITEM.segment] ?? [],
        onSelect: go(`${base}/${FEEDBACK_NAV_ITEM.segment}`),
      });
    }

    const otherWorkspaces = workspaces.filter((ws) => ws.slug !== slug);
    if (otherWorkspaces.length > 0) {
      const workspacesGroup = t("groupWorkspaces");
      for (const workspace of otherWorkspaces) {
        items.push({
          id: `ws:${workspace.id}`,
          label: workspace.name,
          group: workspacesGroup,
          icon: ArrowRightLeft,
          badge: (
            <span className="font-mono text-xs text-muted-foreground">
              /{workspace.slug}
            </span>
          ),
          keywords: [
            workspace.name,
            workspace.slug,
            "workspace",
            "switch",
            "工作区",
          ],
          onSelect: go(
            slug
              ? workspaceSwitchHref(slug, workspace.slug, pathname)
              : `/app/${encodeURIComponent(workspace.slug)}/chat`,
          ),
        });
      }
    }

    items.push(
      {
        id: "home",
        label: t("backToToolPlane"),
        group: actionsGroup,
        icon: Home,
        keywords: ["home", "marketing", "首页"],
        onSelect: go("/"),
      },
      {
        id: "source",
        label: t("sourceCode"),
        group: t("groupProject"),
        icon: Code2,
        keywords: ["github", "source", "repo", "源码"],
        onSelect: openExternal(SITE.sourceUrl),
      },
      {
        id: "theme",
        label: isDark ? t("switchToLightMode") : t("switchToDarkMode"),
        group: actionsGroup,
        icon: isDark ? Sun : Moon,
        keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
        onSelect: () => {
          closePalette();
          toggleTheme();
        },
      },
    );

    return items;
  }, [
    closePalette,
    isDark,
    onToggleSidebar,
    pathname,
    pluginUpdateCount,
    quickJump,
    router,
    sidebarT,
    slug,
    t,
    toggleTheme,
    workspaces,
  ]);

  return (
    <CommandPalette
      items={commands}
      open={open}
      onOpenChange={onOpenChange}
      placeholder={t("searchNavigation")}
      emptyMessage={t("noResults")}
    />
  );
}
