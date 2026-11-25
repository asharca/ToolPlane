"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Bot,
  CircleAlert,
  Circle,
  Folder,
  MessageSquare,
  MessageSquarePlus,
  Pin,
} from "lucide-react";
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMove,
} from "@/components/agents/ai-sidebar";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarRail,
} from "@/components/motion/animated-sidebar";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Tooltip } from "@/components/motion/tooltip";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
} from "@/components/dashboard/dialog";
import { SidebarGroupDialog } from "@/components/dashboard/SidebarGroupDialog";
import { ConfirmActionDialog } from "@/components/dashboard/ConversationUxPrimitives";
import { SidebarToolbar } from "@/components/dashboard/SidebarToolbar";
import { sidebarHoverActionsClassName } from "@/components/dashboard/sidebarHoverActions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { useSidebarScroll } from "@/components/dashboard/useSidebarScroll";
import { deleteAgentAction, pinAgentAction } from "@/lib/agents/actions";
import {
  workAgentGroupPreferencesCookieName,
  workAgentGroupsCookieName,
} from "@/lib/sidebar-preferences";
import {
  createSidebarGroupId,
  sortSidebarItems,
  reorderSidebarItems,
  type SidebarGroupPreferences,
} from "@/lib/sidebar-groups";
import { usePersistentBooleanRecord } from "@/lib/use-persistent-boolean";
import { usePersistentSidebarGroups } from "@/lib/use-persistent-sidebar-groups";
import {
  a2aStateKey,
  type A2AContextPage,
  type A2AContextSummary,
} from "./A2AContextView";
import {
  ConversationExportDialog,
  type ConversationExportTarget,
} from "./ConversationExportDialog";
import {
  DeleteConversationDialog,
  type DeleteConversationTarget,
} from "./DeleteConversationDialog";
import {
  DELETABLE_STATUSES,
  agentSettingsHref,
  workHref,
  type ConversationSummary,
  type WorkAgent,
  type WorkItem,
  type WorkSidebarAgent,
} from "./work-types";

const UNGROUPED_SIDEBAR_GROUP_ID = "__ungrouped__";
function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function sidebarFolderIds(resources: SidebarResource[]): string[] {
  return resources.flatMap((resource) =>
    resource.kind === "folder" || resource.kind === "project"
      ? [resource.id, ...sidebarFolderIds(resource.children ?? [])]
      : [],
  );
}

function sidebarIssueTone(
  status: string,
): "error" | "warning" | "running" | null {
  if (
    [
      "error",
      "failed",
      "copy_failed",
      "restore_failed",
      "restore_cleanup_required",
    ].includes(status)
  )
    return "error";
  // Sandboxes stop while idle and start on demand; only actionable states warn.
  if (["setup_required", "waiting_user"].includes(status)) return "warning";
  if (status === "running") return "running";
  return null;
}

type AgentSidebarIssue =
  | { kind: "notConfigured" }
  | { kind: "sandboxFailed" | "sandboxSetup"; name: string }
  | {
      kind: "waitingUser";
      sessionId: string;
      title: string;
    };

/** Everything that needs the user's attention, most severe first. */
function agentSidebarStatus(
  agent: WorkAgent | undefined,
  sessions: readonly WorkItem[],
): {
  tone: "error" | "warning" | "running" | null;
  issues: AgentSidebarIssue[];
  running: number;
} {
  if (!agent) return { tone: null, issues: [], running: 0 };
  const issues: AgentSidebarIssue[] = [];
  // Readiness comes from the published Agent revision, not a live sandbox.
  if (agent.supportsWork && !agent.ready)
    issues.push({ kind: "notConfigured" });
  for (const sandbox of agent.sandboxes) {
    const sandboxTone = sidebarIssueTone(sandbox.status ?? "");
    if (sandboxTone === "error")
      issues.unshift({ kind: "sandboxFailed", name: sandbox.name });
    else if (sandboxTone === "warning")
      issues.push({ kind: "sandboxSetup", name: sandbox.name });
  }
  let running = 0;
  for (const session of sessions) {
    if (session.agentId !== agent.id) continue;
    const title = session.title || session.task || session.id;
    if (session.status === "waiting_user")
      issues.push({ kind: "waitingUser", sessionId: session.id, title });
    else if (session.status === "running") running += 1;
  }
  const tone = issues.some((issue) => issue.kind === "sandboxFailed")
    ? "error"
    : issues.length
      ? "warning"
      : running
        ? "running"
        : null;
  return { tone, issues, running };
}
const NO_PIN_OVERRIDES: Record<string, boolean> = {};

export type WorkSidebarPreferences = {
  expandedAgents: Record<string, boolean>;
  setExpandedAgents: Dispatch<SetStateAction<Record<string, boolean>>>;
  groupPreferences: SidebarGroupPreferences;
  setGroupPreferences: Dispatch<SetStateAction<SidebarGroupPreferences>>;
  revealAgent: (agentId: string) => void;
};

/** Expanded Agents and sidebar groups, persisted per workspace. */
export function useWorkSidebarPreferences(
  workspaceId: string,
  initialExpandedAgents: Record<string, boolean>,
  initialGroupPreferences: SidebarGroupPreferences,
): WorkSidebarPreferences {
  const [expandedAgents, setExpandedAgents] = usePersistentBooleanRecord(
    `toolplane:work-agent-groups:${workspaceId}`,
    initialExpandedAgents,
    workAgentGroupsCookieName(workspaceId),
  );
  const [groupPreferences, setGroupPreferences] = usePersistentSidebarGroups(
    `toolplane:work-agent-sidebar-groups:${workspaceId}`,
    initialGroupPreferences,
    workAgentGroupPreferencesCookieName(workspaceId),
  );
  function revealAgent(agentId: string) {
    setExpandedAgents((current) => ({ ...current, [agentId]: true }));
    setGroupPreferences((current) => {
      const groupId = current.assignments[agentId];
      if (!groupId || !current.collapsed[groupId]) return current;
      return {
        ...current,
        collapsed: { ...current.collapsed, [groupId]: false },
      };
    });
  }
  return {
    expandedAgents,
    setExpandedAgents,
    groupPreferences,
    setGroupPreferences,
    revealAgent,
  };
}

type A2APage = A2AContextPage & { loading: boolean; failed: boolean };

/** Agents with their Work sessions, conversations, channels, triggers and A2A contexts. */
export function WorkSidebar({
  slug,
  agents: serverAgents,
  items,
  conversations,
  a2aPages,
  a2aContext,
  onLoadMoreA2A,
  preferences,
  activeAgentId,
  activeResourceId,
  activeFolderKey,
  selectedWorkSessionId,
  conversationId,
  workReturnTo,
  onNewWork,
  onNavigate,
  onWorkSessionDeleted,
}: {
  slug: string;
  agents: WorkAgent[];
  items: WorkItem[];
  conversations: ConversationSummary[];
  a2aPages: Record<string, A2APage | undefined>;
  a2aContext: A2AContextSummary | null;
  onLoadMoreA2A: (agentId: string) => void;
  preferences: WorkSidebarPreferences;
  activeAgentId: string;
  activeResourceId: string | null;
  /** Channel, trigger or A2A folder that holds the active resource. */
  activeFolderKey: string | null;
  selectedWorkSessionId: string | null;
  conversationId: string | undefined;
  workReturnTo: string;
  onNewWork: (agentId: string) => void;
  /** A sidebar selection leaves any unsent draft view. */
  onNavigate: () => void;
  onWorkSessionDeleted: (
    target: ConversationSummary & { workSessionId: string },
  ) => void;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const tChannels = useTranslations("console.agentMessaging");
  const common = useTranslations("common");
  const taskStates = useTranslations("console.observability.viewer");
  const router = useRouter();
  const {
    expandedAgents,
    setExpandedAgents,
    groupPreferences,
    setGroupPreferences,
  } = preferences;
  // Pin toggles apply immediately; overrides drop once refreshed props arrive.
  const [pinState, setPinState] = useState<{
    source: WorkAgent[];
    values: Record<string, boolean>;
  }>({ source: serverAgents, values: {} });
  const pinOverrides =
    pinState.source === serverAgents ? pinState.values : NO_PIN_OVERRIDES;
  const agents = useMemo(
    () =>
      serverAgents.map((item) =>
        item.id in pinOverrides
          ? { ...item, pinned: pinOverrides[item.id] }
          : item,
      ),
    [serverAgents, pinOverrides],
  );
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [fullConversationLists, setFullConversationLists] = useState<
    Record<string, boolean>
  >({});
  const [searchExpandedResources, setSearchExpandedResources] = useState<{
    query: string;
    ids: string[];
  } | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<WorkAgent | null>(
    null,
  );
  const [deleteConversationTarget, setDeleteConversationTarget] =
    useState<DeleteConversationTarget | null>(null);
  const [exportConversationTarget, setExportConversationTarget] =
    useState<ConversationExportTarget | null>(null);
  const [groupEditor, setGroupEditor] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const visibleAgents = useMemo<WorkSidebarAgent[]>(
    () =>
      sortSidebarItems(agents, groupPreferences.entityOrder).map((item) => {
        const order = groupPreferences.conversationOrder?.[item.id];
        const agentSessions = sortSidebarItems(
          items.filter((session) => session.agentId === item.id),
          order,
        );
        const agentConversations = sortSidebarItems(
          conversations.filter((entry) => entry.agentId === item.id),
          order,
        ).map((entry) => {
          if (!entry.source)
            return { ...entry, label: entry.title || t("untitledSession") };
          const { platform, chatId } = entry.source;
          const platformLabel = tChannels.has(`platforms.${platform}`)
            ? tChannels(`platforms.${platform}`)
            : platform;
          return { ...entry, label: `${platformLabel} · ${chatId}` };
        });
        const receivedContexts = a2aPages[item.id]?.items ?? [];
        const a2aContexts =
          a2aContext &&
          item.id === activeAgentId &&
          !receivedContexts.some(
            (entry) => entry.contextId === a2aContext.contextId,
          )
            ? [...receivedContexts, a2aContext].sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
              )
            : receivedContexts;
        return {
          agent: item,
          sessions: agentSessions,
          chats: agentConversations.filter(
            (entry) => !entry.source && !entry.triggerId,
          ),
          channels: agentConversations.filter((entry) => entry.source),
          triggers: agentConversations.filter(
            (entry) => !entry.source && entry.triggerId,
          ),
          a2aContexts,
        };
      }),
    [
      agents,
      items,
      conversations,
      a2aPages,
      a2aContext,
      activeAgentId,
      groupPreferences.entityOrder,
      groupPreferences.conversationOrder,
      tChannels,
      t,
    ],
  );
  const groupedAgents = useMemo(() => {
    const agentsByGroup = new Map<string, WorkSidebarAgent[]>(
      groupPreferences.groups.map((group) => [group.id, []]),
    );
    const ungrouped: WorkSidebarAgent[] = [];
    for (const item of visibleAgents) {
      const group = agentsByGroup.get(
        groupPreferences.assignments[item.agent.id] ?? "",
      );
      if (group) group.push(item);
      else ungrouped.push(item);
    }
    return {
      groups: groupPreferences.groups.map((group) => ({
        group,
        agents: agentsByGroup.get(group.id) ?? [],
      })),
      ungrouped,
    };
  }, [groupPreferences.assignments, groupPreferences.groups, visibleAgents]);
  const sidebarResources = useMemo<SidebarResource[]>(() => {
    const agentResources = (entries: WorkSidebarAgent[]): SidebarResource[] =>
      entries.map(
        ({
          agent: itemAgent,
          sessions: agentSessions,
          chats,
          channels,
          triggers,
          a2aContexts,
        }) => ({
          id: `agent:${itemAgent.id}`,
          label: itemAgent.name,
          kind: "project",
          children: [
            ...agentSessions.map((item) => ({
              id: `session:${item.id}`,
              label: item.title || item.task || t("untitled"),
              kind: "file" as const,
            })),
            ...chats.map((item) => ({
              id: `conversation:${item.id}`,
              label: item.label,
              kind: "bookmark" as const,
            })),
            ...(channels.length
              ? [
                  {
                    id: `channel-group:${itemAgent.id}`,
                    label: t("channelGroup"),
                    kind: "folder" as const,
                    children: channels
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`channel:${itemAgent.id}`] ||
                          index < 5 ||
                          item.id === conversationId,
                      )
                      .map((item) => ({
                        id: `conversation:${item.id}`,
                        label: item.label,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
            ...(triggers.length
              ? [
                  {
                    id: `trigger-group:${itemAgent.id}`,
                    label: t("triggerGroup"),
                    kind: "folder" as const,
                    children: triggers
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`trigger:${itemAgent.id}`] ||
                          index < 5 ||
                          item.id === conversationId,
                      )
                      .map((item) => ({
                        id: `conversation:${item.id}`,
                        label: item.label,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
            ...(a2aContexts.length
              ? [
                  {
                    id: `a2a-group:${itemAgent.id}`,
                    label: t("a2a.group"),
                    kind: "folder" as const,
                    children: a2aContexts
                      .filter(
                        (item, index) =>
                          sidebarSearch.trim() ||
                          fullConversationLists[`a2a:${itemAgent.id}`] ||
                          index < 5 ||
                          item.contextId === a2aContext?.contextId,
                      )
                      .map((item) => ({
                        id: `a2a:${item.contextId}`,
                        label: item.title
                          ? `${item.peer.name} · ${item.title}`
                          : item.peer.name,
                        kind: "bookmark" as const,
                      })),
                  },
                ]
              : []),
          ].filter(
            (item, index) =>
              item.kind === "folder" ||
              sidebarSearch.trim() ||
              fullConversationLists[itemAgent.id] ||
              index < 5 ||
              item.id === `session:${selectedWorkSessionId}` ||
              item.id === `conversation:${conversationId}`,
          ),
        }),
      );
    if (!groupPreferences.groups.length) return agentResources(visibleAgents);
    return [
      ...groupedAgents.groups.map(({ group, agents: groupAgents }) => ({
        id: `group:${group.id}`,
        label: group.name,
        kind: "folder" as const,
        children: agentResources(groupAgents),
      })),
      {
        id: "group:ungrouped",
        label: t("ungrouped"),
        kind: "folder" as const,
        children: agentResources(groupedAgents.ungrouped),
      },
    ];
  }, [
    groupPreferences.groups.length,
    groupedAgents,
    t,
    visibleAgents,
    sidebarSearch,
    fullConversationLists,
    selectedWorkSessionId,
    conversationId,
    a2aContext?.contextId,
  ]);
  const filteredSidebarResources = useMemo(() => {
    const query = sidebarSearch.trim().toLocaleLowerCase();
    if (!query) return sidebarResources;
    const filter = (resources: SidebarResource[]): SidebarResource[] =>
      resources.flatMap((resource) => {
        if (resource.label.toLocaleLowerCase().includes(query))
          return [resource];
        const children = resource.children ? filter(resource.children) : [];
        return children.length ? [{ ...resource, children }] : [];
      });
    return filter(sidebarResources);
  }, [sidebarResources, sidebarSearch]);
  const revealedResourceId = useRef<string | null>(null);
  useEffect(() => {
    if (revealedResourceId.current === activeResourceId) return;
    revealedResourceId.current = activeResourceId;
    if (!activeResourceId) return;
    setExpandedAgents((current) => {
      if (
        current[activeAgentId] &&
        (!activeFolderKey || current[activeFolderKey])
      )
        return current;
      return {
        ...current,
        [activeAgentId]: true,
        ...(activeFolderKey ? { [activeFolderKey]: true } : {}),
      };
    });
    setGroupPreferences((current) => {
      const groupId =
        current.assignments[activeAgentId] ?? UNGROUPED_SIDEBAR_GROUP_ID;
      if (!current.collapsed[groupId]) return current;
      return {
        ...current,
        collapsed: { ...current.collapsed, [groupId]: false },
      };
    });
  }, [
    activeResourceId,
    activeAgentId,
    activeFolderKey,
    setExpandedAgents,
    setGroupPreferences,
  ]);
  const expandedResourceIds = useMemo(
    () =>
      sidebarSearch.trim() &&
      searchExpandedResources?.query === sidebarSearch.trim()
        ? searchExpandedResources.ids
        : [
            ...(sidebarSearch.trim()
              ? sidebarFolderIds(filteredSidebarResources)
              : []),
            ...groupPreferences.groups
              .filter((group) => !groupPreferences.collapsed[group.id])
              .map((group) => `group:${group.id}`),
            ...(groupPreferences.collapsed[UNGROUPED_SIDEBAR_GROUP_ID]
              ? []
              : ["group:ungrouped"]),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent, chats, channels, triggers }) =>
                  expandedAgents[itemAgent.id] ??
                  (itemAgent.id === activeAgentId ||
                    chats.length > 0 ||
                    channels.length > 0 ||
                    triggers.length > 0),
              )
              .map(({ agent: itemAgent }) => `agent:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`a2a:${itemAgent.id}`] ?? true,
              )
              .map(({ agent: itemAgent }) => `a2a-group:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`channel:${itemAgent.id}`] ?? false,
              )
              .map(({ agent: itemAgent }) => `channel-group:${itemAgent.id}`),
            ...visibleAgents
              .filter(
                ({ agent: itemAgent }) =>
                  expandedAgents[`trigger:${itemAgent.id}`] ?? false,
              )
              .map(({ agent: itemAgent }) => `trigger-group:${itemAgent.id}`),
          ],
    [
      activeAgentId,
      expandedAgents,
      filteredSidebarResources,
      groupPreferences.collapsed,
      groupPreferences.groups,
      searchExpandedResources,
      sidebarSearch,
      visibleAgents,
    ],
  );

  function persistExpandedResources(ids: string[]) {
    if (sidebarSearch.trim()) {
      setSearchExpandedResources({ query: sidebarSearch.trim(), ids });
      return;
    }
    const expanded = new Set(ids);
    setExpandedAgents(
      Object.fromEntries(
        agents.flatMap((item) => [
          [item.id, expanded.has(`agent:${item.id}`)],
          [`a2a:${item.id}`, expanded.has(`a2a-group:${item.id}`)],
          [`channel:${item.id}`, expanded.has(`channel-group:${item.id}`)],
          [`trigger:${item.id}`, expanded.has(`trigger-group:${item.id}`)],
        ]),
      ),
    );
    setGroupPreferences((current) => ({
      ...current,
      collapsed: Object.fromEntries([
        ...current.groups.map((group) => [
          group.id,
          !expanded.has(`group:${group.id}`),
        ]),
        [UNGROUPED_SIDEBAR_GROUP_ID, !expanded.has("group:ungrouped")],
      ]),
    }));
  }

  async function moveSidebarResource(move: SidebarResourceMove) {
    const [sourceKind, sourceId] = move.itemId.split(":", 2);
    const [targetKind, targetId] = move.targetId?.split(":", 2) ?? [];
    if (sourceKind === "agent") {
      const targetAgent =
        targetKind === "agent"
          ? agents.find((item) => item.id === targetId)
          : null;
      const targetGroupId =
        targetKind === "group" && move.position === "inside"
          ? targetId === "ungrouped"
            ? null
            : targetId
          : targetAgent &&
              (move.position === "before" || move.position === "after")
            ? (groupPreferences.assignments[targetAgent.id] ?? null)
            : undefined;
      if (
        targetGroupId === undefined ||
        !agents.some((item) => item.id === sourceId)
      )
        throw new Error("Unsupported agent move");
      setGroupPreferences((current) => {
        const assignments = { ...current.assignments };
        if (targetGroupId) assignments[sourceId] = targetGroupId;
        else delete assignments[sourceId];
        const next = {
          ...current,
          assignments,
          collapsed: {
            ...current.collapsed,
            [targetGroupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false,
          },
        };
        return targetAgent &&
          (move.position === "before" || move.position === "after")
          ? {
              ...next,
              entityOrder: reorderSidebarItems(
                sortSidebarItems(agents, current.entityOrder),
                sourceId,
                targetId,
                move.position,
              ),
            }
          : next;
      });
      return;
    }
    const edge =
      move.position === "before"
        ? "before"
        : move.position === "after"
          ? "after"
          : null;
    if (
      (sourceKind !== "session" && sourceKind !== "conversation") ||
      targetKind !== sourceKind ||
      !targetId ||
      !edge
    ) {
      throw new Error("Unsupported resource move");
    }
    const source = (sourceKind === "session" ? items : conversations).find(
      (item) => item.id === sourceId,
    );
    const target = (sourceKind === "session" ? items : conversations).find(
      (item) => item.id === targetId,
    );
    if (!source || !target || source.agentId !== target.agentId)
      throw new Error("Resources must stay with their agent");
    if (
      ("source" in source && Boolean(source.source)) !==
      ("source" in target && Boolean(target.source))
    )
      throw new Error("Conversations must stay in their folder");
    const agentItems = [...items, ...conversations].filter(
      (item) => item.agentId === source.agentId,
    );
    setGroupPreferences((current) => ({
      ...current,
      conversationOrder: {
        ...current.conversationOrder,
        [source.agentId]: reorderSidebarItems(
          sortSidebarItems(
            agentItems,
            current.conversationOrder?.[source.agentId],
          ),
          sourceId,
          targetId,
          edge,
        ),
      },
    }));
  }
  async function toggleAgentPin(item: WorkAgent) {
    const pinned = !item.pinned;
    const setOverride = (value?: boolean) =>
      setPinState((current) => {
        const values = {
          ...(current.source === serverAgents ? current.values : {}),
        };
        if (value === undefined) delete values[item.id];
        else values[item.id] = value;
        return { source: serverAgents, values };
      });
    setOverride(pinned);
    const formData = new FormData();
    formData.set("workspace", slug);
    formData.set("agentId", item.id);
    formData.set("pinned", String(pinned));
    try {
      await pinAgentAction(formData);
      router.refresh();
    } catch {
      setOverride();
    }
  }

  function agentIssueLabel(issue: AgentSidebarIssue) {
    switch (issue.kind) {
      case "notConfigured":
        return t("agentIssueNotConfigured");
      case "sandboxFailed":
        return t("agentIssueSandboxFailed", { name: issue.name });
      case "sandboxSetup":
        return t("agentIssueSandboxSetup", { name: issue.name });
      case "waitingUser":
        return t("agentIssueWaitingUser", { title: issue.title });
    }
  }

  /** Opens the place where the issue is fixed: a waiting session or the relevant settings section. */
  function resolveAgentIssue(item: WorkAgent, issue: AgentSidebarIssue) {
    if (issue.kind === "waitingUser") {
      router.push(workHref(slug, issue.sessionId));
      return;
    }
    router.push(agentSettingsHref(slug, item.id, workReturnTo, "general"));
  }

  function sessionStatusLabel(status: string): string {
    switch (status) {
      case "running":
        return t("statusRunning");
      case "waiting_user":
        return t("statusWaitingUser");
      case "setup_required":
        return t("statusWaiting");
      case "error":
      case "failed":
      case "copy_failed":
      case "restore_failed":
      case "restore_cleanup_required":
        return t("statusFailed");
      default:
        return status;
    }
  }

  function agentStatusTooltip(status: ReturnType<typeof agentSidebarStatus>) {
    return (
      <div className="max-w-64 space-y-1 text-left">
        {status.issues.length ? (
          <>
            <p className="font-medium">
              {t("agentIssuesTitle", { count: status.issues.length })}
            </p>
            <ul className="space-y-0.5">
              {status.issues.map((issue) => (
                <li
                  key={`${issue.kind}:${"sessionId" in issue ? issue.sessionId : "name" in issue ? issue.name : ""}`}
                >
                  · {agentIssueLabel(issue)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {status.running ? (
          <p>{t("agentRunningCount", { count: status.running })}</p>
        ) : null}
      </div>
    );
  }

  function setAllAgentSections(collapsed: boolean) {
    if (sidebarSearch.trim()) {
      setSearchExpandedResources({
        query: sidebarSearch.trim(),
        ids: collapsed ? [] : sidebarFolderIds(filteredSidebarResources),
      });
      return;
    }
    setExpandedAgents(
      Object.fromEntries(
        agents.flatMap((item) => [
          [item.id, !collapsed],
          [`a2a:${item.id}`, !collapsed],
          [`channel:${item.id}`, !collapsed],
          [`trigger:${item.id}`, !collapsed],
        ]),
      ),
    );
    setGroupPreferences((current) => {
      if (!current.groups.length) return current;
      return {
        ...current,
        collapsed: Object.fromEntries([
          ...current.groups.map((group) => [group.id, collapsed]),
          [UNGROUPED_SIDEBAR_GROUP_ID, collapsed],
        ]),
      };
    });
  }

  function saveAgentGroup(name: string) {
    if (!groupEditor) return;
    setGroupPreferences((current) => {
      if (groupEditor.id) {
        return {
          ...current,
          groups: current.groups.map((group) =>
            group.id === groupEditor.id ? { ...group, name } : group,
          ),
        };
      }
      const id = createSidebarGroupId();
      return {
        ...current,
        groups: [...current.groups, { id, name }],
        collapsed: { ...current.collapsed, [id]: false },
      };
    });
    setGroupEditor(null);
  }

  function deleteAgentGroup(groupId: string) {
    const group = groupPreferences.groups.find((item) => item.id === groupId);
    if (!group) return;
    setDeleteGroupTarget({ id: groupId, name: group.name });
  }

  function confirmDeleteAgentGroup() {
    if (!deleteGroupTarget) return;
    const groupId = deleteGroupTarget.id;
    setDeleteGroupTarget(null);
    setGroupPreferences((current) => {
      const assignments = Object.fromEntries(
        Object.entries(current.assignments).filter(
          ([, assignedGroupId]) => assignedGroupId !== groupId,
        ),
      );
      const collapsed = { ...current.collapsed };
      delete collapsed[groupId];
      return {
        ...current,
        groups: current.groups.filter((item) => item.id !== groupId),
        assignments,
        collapsed,
      };
    });
  }

  const onSidebarScroll = useSidebarScroll();
  return (
    <>
      <AnimatedSidebar
        ariaLabel={tAgents("agents")}
        collapsible="offcanvas"
        className="h-full shrink-0"
        panelClassName="h-full min-h-0 bg-muted/30"
      >
        <AnimatedSidebarContent className="gap-3 overflow-hidden px-3 py-4">
          <AnimatedSidebarGroup className="min-h-0 flex-1 p-0">
            <SidebarToolbar
              title={tAgents("agents")}
              searchLabel={t("search")}
              searchPlaceholder={common("search")}
              search={sidebarSearch}
              onSearchChange={setSidebarSearch}
              addLabel={tAgents("newAgent")}
              onAdd={() =>
                router.push(
                  `/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`,
                )
              }
              moreLabel={t("listOptions")}
              moreOpen={listOptionsOpen}
              onMoreOpenChange={setListOptionsOpen}
              hasItems={agents.length > 0}
              expandLabel={t("expandAll")}
              collapseLabel={t("collapseAll")}
              newGroupLabel={t("newGroup")}
              onExpandAll={() => setAllAgentSections(false)}
              onCollapseAll={() => setAllAgentSections(true)}
              onNewGroup={() => setGroupEditor({ id: null, name: "" })}
            />
            <AnimatedSidebarGroupContent
              onScroll={onSidebarScroll}
              className="sidebar-scroll min-h-0 flex-1 !w-auto -mr-3 overflow-y-auto overscroll-contain pr-3"
            >
              {filteredSidebarResources.length ? (
                <AISidebar
                  items={filteredSidebarResources}
                  activeId={activeResourceId}
                  renderAfterRow={(resource) => {
                    if (sidebarSearch.trim()) return null;
                    const roots = sidebarResources.flatMap((item) =>
                      item.id.startsWith("group:")
                        ? (item.children ?? [])
                        : [item],
                    );
                    const conversationGroup = roots
                      .flatMap((item) => item.children ?? [])
                      .find(
                        (item) =>
                          (item.id.startsWith("channel-group:") ||
                            item.id.startsWith("trigger-group:")) &&
                          item.children?.at(-1)?.id === resource.id,
                      );
                    if (conversationGroup) {
                      const isTriggerGroup =
                        conversationGroup.id.startsWith("trigger-group:");
                      const kind = isTriggerGroup ? "trigger" : "channel";
                      const id = conversationGroup.id.slice(
                        `${kind}-group:`.length,
                      );
                      const entry = visibleAgents.find(
                        ({ agent }) => agent.id === id,
                      );
                      const count = isTriggerGroup
                        ? entry?.triggers.length
                        : entry?.channels.length;
                      if (!entry || !count || count <= 5) return null;
                      const key = `${kind}:${id}`;
                      const expanded = Boolean(fullConversationLists[key]);
                      return (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? t("collapseAll") : t("expandAll")} ${entry.agent.name} · ${t(isTriggerGroup ? "triggerGroup" : "channelGroup")}`}
                          onClick={() =>
                            setFullConversationLists((current) => ({
                              ...current,
                              [key]: !current[key],
                            }))
                          }
                          className="ml-14 self-start rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {expanded ? t("collapseAll") : t("expandAll")}
                        </button>
                      );
                    }
                    if (resource.id.startsWith("a2a:")) {
                      const entry = visibleAgents.find((item) =>
                        item.a2aContexts.some(
                          (context) =>
                            `a2a:${context.contextId}` === resource.id,
                        ),
                      );
                      if (!entry) return null;
                      const id = entry.agent.id;
                      const group = roots
                        .find((item) => item.id === `agent:${id}`)
                        ?.children?.find(
                          (item) => item.id === `a2a-group:${id}`,
                        );
                      if (group?.children?.at(-1)?.id !== resource.id)
                        return null;
                      const expanded = fullConversationLists[`a2a:${id}`];
                      const page = a2aPages[id];
                      return (
                        <div className="ml-14 flex flex-wrap gap-1">
                          {entry.a2aContexts.length > 5 ? (
                            <button
                              type="button"
                              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={`${expanded ? t("collapseAll") : t("expandAll")} ${t("a2a.group")}`}
                              onClick={() =>
                                setFullConversationLists((current) => ({
                                  ...current,
                                  [`a2a:${id}`]: !current[`a2a:${id}`],
                                }))
                              }
                            >
                              {expanded ? t("collapseAll") : t("expandAll")}
                            </button>
                          ) : null}
                          {(expanded || entry.a2aContexts.length <= 5) &&
                          page?.nextCursor ? (
                            <button
                              type="button"
                              disabled={page.loading}
                              aria-busy={page.loading}
                              onClick={() => onLoadMoreA2A(id)}
                              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                              {t("a2a.loadMore")}
                            </button>
                          ) : null}
                          {page?.failed ? (
                            <span
                              role="alert"
                              className="px-2 py-1.5 text-xs text-destructive"
                            >
                              {t("a2a.loadFailed")}
                            </span>
                          ) : null}
                        </div>
                      );
                    }
                    const parent = roots.find(
                      (item) =>
                        item.children
                          ?.filter((child) => child.kind !== "folder")
                          .at(-1)?.id === resource.id,
                    );
                    if (!parent) return null;
                    const id = parent.id.slice("agent:".length);
                    const entry = visibleAgents.find(
                      ({ agent }) => agent.id === id,
                    );
                    if (
                      !entry ||
                      entry.sessions.length + entry.chats.length <= 5
                    )
                      return null;
                    return (
                      <button
                        type="button"
                        aria-label={`${fullConversationLists[id] ? t("collapseAll") : t("expandAll")} ${entry.agent.name}`}
                        onClick={() =>
                          setFullConversationLists((current) => ({
                            ...current,
                            [id]: !current[id],
                          }))
                        }
                        className="ml-10 self-start rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {fullConversationLists[id]
                          ? t("collapseAll")
                          : t("expandAll")}
                      </button>
                    );
                  }}
                  ariaLabel={tAgents("agents")}
                  className={`px-0 [&_[role=treeitem]]:rounded-lg [&_[role=treeitem]]:min-h-10 [&_[aria-selected=true]]:bg-muted [&_[role=treeitem]>span[aria-hidden=true]:empty]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:empty]:w-0 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:w-0 ${sidebarHoverActionsClassName}`}
                  expandedIds={expandedResourceIds}
                  onExpandedIdsChange={persistExpandedResources}
                  onActiveChange={(id) => {
                    onNavigate();
                    const [kind, resourceId] = id.split(":", 2);
                    if (kind === "session")
                      router.push(workHref(slug, resourceId));
                    if (kind === "conversation")
                      router.push(
                        `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversations.find((item) => item.id === resourceId)?.agentId ?? activeAgentId)}&c=${encodeURIComponent(resourceId)}`,
                      );
                    if (kind === "a2a") {
                      const entry = visibleAgents.find((item) =>
                        item.a2aContexts.some(
                          (context) => context.contextId === resourceId,
                        ),
                      );
                      const context = entry?.a2aContexts.find(
                        (item) => item.contextId === resourceId,
                      );
                      const taskId = context?.tasks.at(-1)?.taskId;
                      if (entry && taskId)
                        router.push(
                          `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(entry.agent.id)}&a2a=${encodeURIComponent(taskId)}`,
                        );
                    }
                  }}
                  onMove={moveSidebarResource}
                  onRename={(resource, label) => {
                    if (
                      !resource.id.startsWith("group:") ||
                      resource.id === "group:ungrouped"
                    )
                      return;
                    const id = resource.id.slice("group:".length);
                    setGroupPreferences((current) => ({
                      ...current,
                      groups: current.groups.map((group) =>
                        group.id === id ? { ...group, name: label } : group,
                      ),
                    }));
                  }}
                  renderActions={(resource) => {
                    const [kind, id] = resource.id.split(":", 2);
                    if (kind === "a2a") {
                      const context = visibleAgents
                        .flatMap((entry) => entry.a2aContexts)
                        .find((item) => item.contextId === id);
                      const state = a2aStateKey(
                        context?.state ?? "TASK_STATE_UNSPECIFIED",
                      );
                      return (
                        <span className="sr-only">
                          {taskStates.has(`states.${state}`)
                            ? taskStates(`states.${state}`)
                            : state}
                        </span>
                      );
                    }
                    const itemAgent =
                      kind === "agent"
                        ? agents.find((item) => item.id === id)
                        : null;
                    if (!itemAgent) return null;
                    const pinButton = (
                      <button
                        type="button"
                        draggable={false}
                        aria-pressed={itemAgent.pinned}
                        data-sidebar-reveal={itemAgent.pinned ? undefined : ""}
                        aria-label={`${itemAgent.pinned ? tAgents("unpinAgent") : tAgents("pinAgent")} ${itemAgent.name}`}
                        title={
                          itemAgent.pinned
                            ? tAgents("unpinAgent")
                            : tAgents("pinAgent")
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleAgentPin(itemAgent);
                        }}
                        className={cx(
                          "grid size-7 shrink-0 place-items-center rounded-lg outline-none transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                          itemAgent.pinned
                            ? "text-foreground opacity-100"
                            : "text-muted-foreground opacity-0",
                        )}
                      >
                        <Pin
                          aria-hidden="true"
                          className={cx(
                            "size-3.5 rotate-45",
                            itemAgent.pinned && "fill-current",
                          )}
                        />
                      </button>
                    );
                    const status = agentSidebarStatus(itemAgent, items);
                    const firstIssue = status.issues[0];
                    const resolveButton = firstIssue ? (
                      <Tooltip
                        content={
                          <div className="space-y-1">
                            {agentStatusTooltip(status)}
                            <p className="text-muted-foreground">
                              {t("agentResolveIssue", {
                                issue: agentIssueLabel(firstIssue),
                              })}
                            </p>
                          </div>
                        }
                        side="right"
                      >
                        <button
                          type="button"
                          draggable={false}
                          aria-label={`${t("agentIssuesTitle", { count: status.issues.length })}: ${agentIssueLabel(firstIssue)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            resolveAgentIssue(itemAgent, firstIssue);
                          }}
                          className={cx(
                            "grid size-7 shrink-0 place-items-center rounded-lg outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
                            status.tone === "error"
                              ? "text-destructive"
                              : "text-warning",
                          )}
                        >
                          <CircleAlert
                            aria-hidden="true"
                            className="size-3.5"
                          />
                        </button>
                      </Tooltip>
                    ) : null;
                    if (!itemAgent.supportsWork)
                      return (
                        <>
                          {resolveButton}
                          {pinButton}
                        </>
                      );
                    return (
                      <>
                        {resolveButton}
                        {pinButton}
                        <button
                          type="button"
                          draggable={false}
                          data-sidebar-reveal=""
                          aria-label={`${t("newWork")} ${itemAgent.name}`}
                          title={t("newWork")}
                          onClick={(event) => {
                            event.stopPropagation();
                            onNewWork(itemAgent.id);
                          }}
                          className="grid size-7 shrink-0 place-items-center rounded-lg outline-none opacity-0 transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
                        >
                          <MessageSquarePlus
                            aria-hidden="true"
                            className="size-3.5"
                          />
                        </button>
                      </>
                    );
                  }}
                  renderIcon={(resource) => {
                    const [kind, id] = resource.id.split(":", 2);
                    if (kind === "a2a") {
                      const context = visibleAgents
                        .flatMap((entry) => entry.a2aContexts)
                        .find((item) => item.contextId === id);
                      const state = a2aStateKey(
                        context?.state ?? "TASK_STATE_UNSPECIFIED",
                      );
                      return (
                        <Tooltip
                          content={
                            taskStates.has(`states.${state}`)
                              ? taskStates(`states.${state}`)
                              : state
                          }
                          side="right"
                        >
                          <Circle
                            data-sidebar-dot=""
                            className={cx(
                              "size-2 fill-current",
                              ["failed", "rejected", "canceled"].includes(state)
                                ? "text-destructive"
                                : ["input-required", "auth-required"].includes(
                                      state,
                                    )
                                  ? "text-warning"
                                  : state === "completed"
                                    ? "text-emerald-500"
                                    : "text-primary",
                            )}
                          />
                        </Tooltip>
                      );
                    }
                    if (kind === "agent") {
                      const itemAgent = agents.find((item) => item.id === id);
                      const status = agentSidebarStatus(itemAgent, items);
                      const { tone } = status;
                      const avatar = (
                        <span className="relative grid size-5 place-items-center rounded-md bg-muted text-[10px] font-semibold text-foreground ring-1 ring-border">
                          {itemAgent?.name.slice(0, 1).toLocaleUpperCase() || (
                            <Bot className="size-3.5" />
                          )}
                          {tone ? (
                            <>
                              <span
                                aria-hidden="true"
                                className={cx(
                                  "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-background",
                                  tone === "error"
                                    ? "bg-destructive"
                                    : tone === "warning"
                                      ? "bg-warning"
                                      : "bg-primary",
                                )}
                              />
                              <span className="sr-only">
                                {status.issues[0]
                                  ? agentIssueLabel(status.issues[0])
                                  : status.running
                                    ? t("agentRunningCount", {
                                        count: status.running,
                                      })
                                    : ""}
                              </span>
                            </>
                          ) : null}
                        </span>
                      );
                      return tone ? (
                        <Tooltip
                          content={agentStatusTooltip(status)}
                          side="right"
                        >
                          {avatar}
                        </Tooltip>
                      ) : (
                        avatar
                      );
                    }
                    if (kind === "session") {
                      const item = items.find((session) => session.id === id);
                      const status = item?.status ?? "";
                      const tone = sidebarIssueTone(status);
                      return tone ? (
                        <Tooltip
                          content={sessionStatusLabel(status)}
                          side="right"
                        >
                          <span className="inline-flex items-center">
                            <Circle
                              data-sidebar-dot=""
                              aria-hidden="true"
                              className={cx(
                                "size-2 fill-current",
                                tone === "error"
                                  ? "text-destructive"
                                  : tone === "warning"
                                    ? "text-warning"
                                    : "text-primary",
                              )}
                            />
                            <span className="sr-only">
                              {sessionStatusLabel(status)}
                            </span>
                          </span>
                        </Tooltip>
                      ) : (
                        false
                      );
                    }
                    if (kind === "conversation")
                      return (
                        <MessageSquare
                          aria-hidden="true"
                          className="size-3.5 text-muted-foreground/70"
                        />
                      );
                    return <Folder className="size-4" />;
                  }}
                  renderMenu={(resource, controls) => {
                    const [kind, id] = resource.id.split(":", 2);
                    const action = (
                      label: string,
                      run: () => void,
                      destructive = false,
                    ) => (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          controls.close();
                          run();
                        }}
                        className={cx(
                          "flex h-8 w-full items-center rounded-lg px-2.5 text-left text-xs",
                          destructive
                            ? "text-destructive hover:bg-destructive/10"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        {label}
                      </button>
                    );
                    if (kind === "group" && id !== "ungrouped")
                      return (
                        <>
                          {action(t("renameGroup"), controls.rename)}
                          {action(
                            t("deleteGroup"),
                            () => deleteAgentGroup(id),
                            true,
                          )}
                        </>
                      );
                    if (kind === "agent") {
                      const itemAgent = agents.find((item) => item.id === id);
                      if (!itemAgent) return null;
                      return (
                        <>
                          {action(tAgents("configureAgent"), () =>
                            router.push(
                              agentSettingsHref(
                                slug,
                                itemAgent.id,
                                workReturnTo,
                              ),
                            ),
                          )}
                          {action(
                            tAgents("deleteAgent"),
                            () => setDeleteAgentTarget(itemAgent),
                            true,
                          )}
                        </>
                      );
                    }
                    if (kind === "session") {
                      const item = items.find((session) => session.id === id);
                      if (!item) return null;
                      return (
                        <>
                          {item.agentId && item.conversationId
                            ? action(t("exportConversation"), () =>
                                setExportConversationTarget({
                                  id: item.conversationId,
                                  agentId: item.agentId,
                                  nativeAvailable:
                                    item.readOnly === false &&
                                    item.runtimeKind === "pi-sdk" &&
                                    Boolean(item.agentRevisionId) &&
                                    !item.legacyRevisionUnresolved,
                                }),
                              )
                            : null}
                          {DELETABLE_STATUSES.has(item.status)
                            ? action(
                                t("deleteConversation"),
                                () =>
                                  setDeleteConversationTarget({
                                    id: item.conversationId,
                                    agentId: item.agentId,
                                    title: item.title,
                                    source: null,
                                    triggerId: null,
                                    workSessionId: item.id,
                                  }),
                                true,
                              )
                            : null}
                        </>
                      );
                    }
                    if (kind === "conversation") {
                      const target = conversations.find(
                        (item) => item.id === id,
                      );
                      if (!target) return null;
                      return (
                        <>
                          {target.agentId &&
                          target.id &&
                          target.exportable !== false
                            ? action(t("exportConversation"), () =>
                                setExportConversationTarget({
                                  id: target.id,
                                  agentId: target.agentId,
                                  nativeAvailable: target.readOnly === false,
                                }),
                              )
                            : null}
                          {!target.source && !target.title?.startsWith("msg:")
                            ? action(
                                tAgents("deleteConversation"),
                                () => setDeleteConversationTarget(target),
                                true,
                              )
                            : null}
                        </>
                      );
                    }
                    return null;
                  }}
                />
              ) : (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {sidebarSearch.trim()
                    ? t("noSearchResults")
                    : tAgents("noAgentsYet")}
                </p>
              )}
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        </AnimatedSidebarContent>
        <AnimatedSidebarRail />
      </AnimatedSidebar>
      <SidebarGroupDialog
        initialName={groupEditor?.name ?? ""}
        open={Boolean(groupEditor)}
        title={t(groupEditor?.id ? "renameGroup" : "newGroup")}
        nameLabel={t("groupName")}
        placeholder={t("groupNamePlaceholder")}
        cancelLabel={common("cancel")}
        submitLabel={groupEditor?.id ? common("save") : common("create")}
        onClose={() => setGroupEditor(null)}
        onSubmit={saveAgentGroup}
      />

      <ConfirmActionDialog
        open={Boolean(deleteGroupTarget)}
        destructive
        title={t("deleteGroup")}
        description={
          deleteGroupTarget
            ? t("deleteGroupConfirm", { name: deleteGroupTarget.name })
            : ""
        }
        confirmLabel={common("delete")}
        cancelLabel={common("cancel")}
        onClose={() => setDeleteGroupTarget(null)}
        onConfirm={confirmDeleteAgentGroup}
      />

      <ConversationExportDialog
        key={`export:${exportConversationTarget?.id ?? "closed"}`}
        target={exportConversationTarget}
        onClose={() => setExportConversationTarget(null)}
      />
      <DeleteConversationDialog
        key={`delete:${deleteConversationTarget?.id ?? "closed"}`}
        slug={slug}
        target={deleteConversationTarget}
        onClose={() => setDeleteConversationTarget(null)}
        onWorkSessionDeleted={onWorkSessionDeleted}
      />
      <CenterMorphModal
        open={Boolean(deleteAgentTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteAgentTarget(null);
        }}
      >
        <CenterMorphModalContent
          ariaLabel={tAgents("deleteAgent")}
          closeButtonLabel={tAgents("close")}
          className="max-w-md"
        >
          <DialogHeader title={tAgents("deleteAgent")} />
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {tAgents("deleteThisAgentAndItsSandboxesAndAllItsConversations")}
            </p>
          </DialogBody>
          <form action={deleteAgentAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input
              type="hidden"
              name="agentId"
              value={deleteAgentTarget?.id ?? ""}
            />
            <input type="hidden" name="returnTo" value={`/app/${slug}/work`} />
            <DialogFooter cancel={<DialogCancel />}>
              <SubmitButton
                size="md"
                variant="primary"
                className="bg-destructive text-white hover:bg-destructive/90"
                pendingLabel={tAgents("deleting")}
              >
                {tAgents("confirmDelete")}
              </SubmitButton>
            </DialogFooter>
          </form>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </>
  );
}
