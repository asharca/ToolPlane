"use client";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";

import { Button } from "@/components/motion/button";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useTranslations } from "next-intl";

import {
  Bot,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  Folder,
  FolderPlus,
  GitBranch,
  ListFilter,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  PanelLeft,
  Plus,
  Trash2,
} from "lucide-react";
import {
  AISidebar,
  type SidebarResource,
  type SidebarResourceMenuControls,
  type SidebarResourceMove,
} from "@/components/agents/ai-sidebar";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarInset,
  AnimatedSidebarRail,
} from "@/components/motion/animated-sidebar";
import {
  ChatApp,
  ChatAppSidebarTrigger,
} from "@/components/dashboard/chat/ChatApp";
import { AgentConversation } from "@/components/dashboard/agents/AgentConversation";
import { AssistantEditor } from "./AssistantEditor";
import {
  ChatBranchPanel,
  type ChatBranchState,
} from "@/components/dashboard/chat/ChatBranchFlow";
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { SidebarGroupDialog } from "@/components/dashboard/SidebarGroupDialog";
import {
  usePersistentBoolean,
  usePersistentBooleanRecord,
} from "@/lib/use-persistent-boolean";
import {
  assistantChatExpandedCookieName,
  assistantChatGroupPreferencesCookieName,
  assistantChatSidebarCookieName,
} from "@/lib/sidebar-preferences";
import {
  createSidebarGroupId,
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  reorderSidebarItems,
  sortSidebarItems,
  type SidebarGroupPreferences,
} from "@/lib/sidebar-groups";
import { usePersistentSidebarGroups } from "@/lib/use-persistent-sidebar-groups";
import type { HermesUIMessage } from "@/lib/agents/hermes/message-segments";

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = {
  id: string;
  name: string;
  status: string;
  keywords?: string[];
};
type AssistantModelParameters = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  customParameters?: AssistantCustomParameter[];
};
type AssistantCustomParameter = {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  value: string | number | boolean;
};

export type AssistantMarketTemplate = {
  releaseId: string;
  name: string;
  summary: string | null;
  tags: string[];
  systemPrompt: string | null;
  maxSteps: number;
  providerFormat: string | null;
  model: string | null;
  deploymentIds: string[];
  missingMcpNames?: string[];
};

export type ChatAssistantItem = {
  id: string;
  name: string;
  description?: string | null;
  pinned: boolean;
  systemPrompt: string | null;
  modelProviderId: string | null;
  model: string | null;
  modelParameters?: AssistantModelParameters | null;
  maxSteps: number;
  providerName: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  deploymentIds: string[];
  webSearchAvailable?: boolean;
  threads: Array<{
    id: string;
    title: string | null;
    createdAt: string;
    lastMessageAt: string | null;
  }>;
};

const EMPTY_EXPANDED_ASSISTANTS: Record<string, boolean> = {};
const EMPTY_RUNNING_THREADS: string[] = [];
const UNGROUPED_SIDEBAR_GROUP_ID = "__ungrouped__";

function chatHref(slug: string, assistantId: string, threadId?: string) {
  const query = new URLSearchParams({ assistant: assistantId });
  if (threadId) query.set("thread", threadId);
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
}

export { estimatePromptTokens } from "@/lib/prompt-tokens";

export function WorkspaceAssistantChat({
  assistants,
  branch = null,
  deployments,
  initialMessages,
  marketTemplate = null,
  marketTemplates = [],
  providers,
  reasoningAvailable,
  selectedAssistantId,
  selectedThreadId,
  slug,
  startCreating = false,
  initialExpandedAssistants = EMPTY_EXPANDED_ASSISTANTS,
  initialGroupPreferences = EMPTY_SIDEBAR_GROUP_PREFERENCES,
  initialSidebarOpen = true,
  workspaceId,
  initialRunningThreadIds = EMPTY_RUNNING_THREADS,
}: {
  assistants: ChatAssistantItem[];
  branch?: ChatBranchState | null;
  deployments: McpOption[];
  initialMessages: HermesUIMessage[];
  marketTemplate?: AssistantMarketTemplate | null;
  marketTemplates?: AssistantMarketTemplate[];
  providers: ProviderOption[];
  reasoningAvailable: boolean;
  selectedAssistantId: string | null;
  selectedThreadId: string | null;
  slug: string;
  startCreating?: boolean;
  initialExpandedAssistants?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
  workspaceId: string;
  initialRunningThreadIds?: string[];
}) {
  const t = useTranslations("console.chatAssistants");
  const common = useTranslations("common");
  const workT = useTranslations("console.work");
  const router = useRouter();
  const activeAssistant =
    assistants.find((assistant) => assistant.id === selectedAssistantId) ??
    assistants[0] ??
    null;
  const activeThread =
    activeAssistant?.threads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const [liveRunningThreadIds, setLiveRunningThreadIds] = useState(
    initialRunningThreadIds,
  );
  const runningThreadIds = useMemo(
    () => new Set(liveRunningThreadIds),
    [liveRunningThreadIds],
  );
  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    async function refreshRunning() {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const response = await fetch(
          `/api/v1/chat/assistants?workspaceId=${encodeURIComponent(workspaceId)}&running=1`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { runningThreadIds?: string[] };
        if (
          !controller.signal.aborted &&
          Array.isArray(body.runningThreadIds)
        ) {
          const ids = body.runningThreadIds.sort();
          setLiveRunningThreadIds((previous) =>
            previous.join(",") === ids.join(",") ? previous : ids,
          );
        }
      } catch {
        /* Keep the last server state while disconnected. */
      } finally {
        checking = false;
      }
    }
    void refreshRunning();
    const timer = setInterval(() => {
      void refreshRunning();
    }, 2000);
    document.addEventListener("visibilitychange", refreshRunning);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshRunning);
    };
  }, [workspaceId]);
  const [expandedAssistants, setExpandedAssistants] =
    usePersistentBooleanRecord(
      `toolplane:assistant-chat-expanded:${workspaceId}`,
      initialExpandedAssistants,
      assistantChatExpandedCookieName(workspaceId),
    );
  const [groupPreferences, setGroupPreferences] = usePersistentSidebarGroups(
    `toolplane:assistant-chat-groups:${workspaceId}`,
    initialGroupPreferences,
    assistantChatGroupPreferencesCookieName(workspaceId),
  );
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:assistant-chat-sidebar:${workspaceId}`,
    initialSidebarOpen,
    assistantChatSidebarCookieName(workspaceId),
  );
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchMaximized, setBranchMaximized] = useState(false);
  const [desktopBranches, setDesktopBranches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setDesktopBranches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [branchMutating, setBranchMutating] = useState(false);
  const focusBranchMessageIdRef = useRef<string | null>(null);
  const [branchRefreshPending, startBranchRefresh] = useTransition();
  const [listOptionsOpen, setListOptionsOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"sidebar" | "chat">(
    activeThread ? "chat" : "sidebar",
  );
  const [editing, setEditing] = useState<ChatAssistantItem | null | "new">(
    startCreating ? "new" : null,
  );
  const [selectedMarketTemplate, setSelectedMarketTemplate] =
    useState(marketTemplate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeResetKey, setTreeResetKey] = useState(0);
  const [groupEditor, setGroupEditor] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const branchBusy = branchMutating || branchRefreshPending;
  const refreshChat = useCallback(() => {
    startBranchRefresh(() => router.refresh());
  }, [router]);
  const sortedAssistants = useMemo(
    () =>
      sortSidebarItems(assistants, groupPreferences.entityOrder).map(
        (assistant) => ({
          ...assistant,
          threads: sortSidebarItems(
            assistant.threads,
            groupPreferences.conversationOrder?.[assistant.id],
          ),
        }),
      ),
    [
      assistants,
      groupPreferences.entityOrder,
      groupPreferences.conversationOrder,
    ],
  );
  const groupedAssistants = useMemo(() => {
    const assistantsByGroup = new Map<string, ChatAssistantItem[]>(
      groupPreferences.groups.map((group) => [group.id, []]),
    );
    const ungrouped: ChatAssistantItem[] = [];
    for (const assistant of sortedAssistants) {
      const group = assistantsByGroup.get(
        groupPreferences.assignments[assistant.id] ?? "",
      );
      if (group) group.push(assistant);
      else ungrouped.push(assistant);
    }
    return {
      groups: groupPreferences.groups.map((group) => ({
        group,
        assistants: assistantsByGroup.get(group.id) ?? [],
      })),
      ungrouped,
    };
  }, [groupPreferences.assignments, groupPreferences.groups, sortedAssistants]);

  useEffect(() => {
    if (
      !focusBranchMessageIdRef.current ||
      branch?.activeMessageId !== focusBranchMessageIdRef.current
    )
      return;
    document
      .querySelector<HTMLTextAreaElement>('[data-ui="chat.composer"] textarea')
      ?.focus();
    focusBranchMessageIdRef.current = null;
  }, [branch?.activeMessageId]);

  async function switchBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    const node = branch?.nodes.find((candidate) => candidate.id === messageId);
    if (node?.active) {
      document
        .getElementById(`chat-message-${messageId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${activeThread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activeMessageId: messageId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("branchSwitchError"));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("branchSwitchError"));
    } finally {
      setBranchMutating(false);
    }
  }

  async function startBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/chat/threads/${activeThread.id}/branches`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        branch?: { activeMessageId?: string | null; activated?: boolean };
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("branchCreateError"));
      if (body.branch?.activated && body.branch.activeMessageId) {
        focusBranchMessageIdRef.current = body.branch.activeMessageId;
      }
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("branchCreateError"));
    } finally {
      setBranchMutating(false);
    }
  }

  async function deleteBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/chat/threads/${activeThread.id}/branches`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("branchDeleteError"));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("branchDeleteError"));
    } finally {
      setBranchMutating(false);
    }
  }

  async function createThread(assistantId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/chat/assistants/${assistantId}/threads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        thread?: { id?: string };
        id?: string;
        error?: string;
      };
      const threadId = body.thread?.id ?? body.id;
      if (!response.ok || !threadId)
        throw new Error(body.error || t("threadCreateError"));
      setExpandedAssistants((current) => ({ ...current, [assistantId]: true }));
      openAssistantGroup(assistantId);
      window.location.assign(chatHref(slug, assistantId, threadId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("threadCreateError"));
      setBusy(false);
    }
  }

  async function moveThread(
    threadId: string,
    targetAssistantId: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId: targetAssistantId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("moveThreadError"));
      setExpandedAssistants((current) => ({
        ...current,
        [targetAssistantId]: true,
      }));
      openAssistantGroup(targetAssistantId);
      router.push(chatHref(slug, targetAssistantId, threadId));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("moveThreadError"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteThread(threadId: string) {
    if (!window.confirm(t("deleteThreadConfirm"))) return;
    const response = await fetch(`/api/v1/chat/threads/${threadId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError(t("deleteError"));
      return;
    }
    window.location.assign(
      activeAssistant
        ? chatHref(slug, activeAssistant.id)
        : `/app/${encodeURIComponent(slug)}/chat`,
    );
  }

  async function deleteAssistant(assistantId: string) {
    if (!window.confirm(t("deleteAssistantConfirm"))) return;
    const response = await fetch(`/api/v1/chat/assistants/${assistantId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError(t("deleteError"));
      return;
    }
    window.location.assign(`/app/${encodeURIComponent(slug)}/chat`);
  }

  async function toggleAssistantPin(assistant: ChatAssistantItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/assistants/${assistant.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !assistant.pinned }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("saveError"));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function assistantSaved(assistantId: string, created: boolean) {
    setEditing(null);
    if (created) {
      await createThread(assistantId);
      return;
    }
    window.location.assign(chatHref(slug, assistantId, activeThread?.id));
  }

  async function updateAssistantModel(selection: ModelSelection) {
    if (!activeAssistant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/chat/assistants/${activeAssistant.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelProviderId: selection.providerId,
            model: selection.model,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("saveError"));
      window.location.assign(
        chatHref(slug, activeAssistant.id, activeThread?.id),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("saveError"));
      setBusy(false);
    }
  }

  function openAssistantGroup(assistantId: string) {
    setGroupPreferences((current) => {
      const groupId =
        current.assignments[assistantId] ?? UNGROUPED_SIDEBAR_GROUP_ID;
      if (!current.collapsed[groupId]) return current;
      return {
        ...current,
        collapsed: { ...current.collapsed, [groupId]: false },
      };
    });
    setTreeResetKey((key) => key + 1);
  }

  function saveAssistantGroup(name: string) {
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

  function deleteAssistantGroup(groupId: string) {
    const group = groupPreferences.groups.find((item) => item.id === groupId);
    if (
      !group ||
      !window.confirm(t("deleteGroupConfirm", { name: group.name }))
    )
      return;
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

  function assignAssistantToGroup(assistantId: string, groupId: string | null) {
    setGroupPreferences((current) => {
      const assignments = { ...current.assignments };
      if (groupId) assignments[assistantId] = groupId;
      else delete assignments[assistantId];
      return {
        ...current,
        assignments,
        collapsed: {
          ...current.collapsed,
          [groupId ?? UNGROUPED_SIDEBAR_GROUP_ID]: false,
        },
      };
    });
    setTreeResetKey((key) => key + 1);
  }

  const sidebarResources = useMemo<SidebarResource[]>(() => {
    const assistantResources = (
      items: ChatAssistantItem[],
    ): SidebarResource[] =>
      items.map((assistant) => ({
        id: `assistant:${assistant.id}`,
        label: assistant.name,
        kind: "project",
        children: assistant.threads.map((thread) => ({
          id: `thread:${thread.id}`,
          label: thread.title || t("newChat"),
          kind: "file",
        })),
      }));
    if (!groupPreferences.groups.length)
      return assistantResources(sortedAssistants);
    return [
      ...groupedAssistants.groups.map(({ group, assistants: groupItems }) => ({
        id: `group:${group.id}`,
        label: group.name,
        kind: "folder" as const,
        children: assistantResources(groupItems),
      })),
      {
        id: `group:${UNGROUPED_SIDEBAR_GROUP_ID}`,
        label: t("ungrouped"),
        kind: "folder" as const,
        children: assistantResources(groupedAssistants.ungrouped),
      },
    ];
  }, [groupPreferences.groups, groupedAssistants, t, sortedAssistants]);

  async function handleResourceMove(move: SidebarResourceMove) {
    const sourceAssistantId = move.itemId.startsWith("assistant:")
      ? move.itemId.slice(10)
      : null;
    const sourceThreadId = move.itemId.startsWith("thread:")
      ? move.itemId.slice(7)
      : null;
    const targetAssistantId = move.targetId?.startsWith("assistant:")
      ? move.targetId.slice(10)
      : null;
    const targetThreadId = move.targetId?.startsWith("thread:")
      ? move.targetId.slice(7)
      : null;
    const targetGroupId = move.targetId?.startsWith("group:")
      ? move.targetId.slice(6)
      : null;

    const sourceGroupId = move.itemId.startsWith("group:")
      ? move.itemId.slice(6)
      : null;
    if (sourceGroupId) {
      if (
        !targetGroupId ||
        targetGroupId === UNGROUPED_SIDEBAR_GROUP_ID ||
        move.position === "inside"
      ) {
        throw new Error("Unsupported group move");
      }
      setGroupPreferences((current) => ({
        ...current,
        groups: sortSidebarItems(
          current.groups,
          reorderSidebarItems(
            current.groups,
            sourceGroupId,
            targetGroupId,
            move.position === "before" ? "before" : "after",
          ),
        ),
      }));
      return;
    }
    if (sourceAssistantId) {
      if (move.position === "inside" && targetAssistantId)
        throw new Error("Assistants cannot contain assistants");
      const groupId =
        move.position === "inside" && targetGroupId
          ? targetGroupId === UNGROUPED_SIDEBAR_GROUP_ID
            ? null
            : targetGroupId
          : targetAssistantId
            ? (groupPreferences.assignments[targetAssistantId] ?? null)
            : null;
      if (targetThreadId)
        throw new Error("Assistants cannot be moved relative to threads");
      assignAssistantToGroup(sourceAssistantId, groupId);
      if (targetAssistantId) {
        setGroupPreferences((current) => ({
          ...current,
          entityOrder: reorderSidebarItems(
            sortSidebarItems(assistants, current.entityOrder),
            sourceAssistantId,
            targetAssistantId,
            move.position === "before" ? "before" : "after",
          ),
        }));
      }
      return;
    }

    if (!sourceThreadId) return;
    const sourceOwner = assistants.find((assistant) =>
      assistant.threads.some((thread) => thread.id === sourceThreadId),
    );
    if (!sourceOwner) return;
    if (move.position === "inside" && targetAssistantId) {
      if (sourceOwner.id !== targetAssistantId) {
        if (!(await moveThread(sourceThreadId, targetAssistantId)))
          throw new Error(t("moveThreadError"));
        return;
      }
      const lastThread = sourceOwner.threads.at(-1);
      if (lastThread && lastThread.id !== sourceThreadId) {
        setGroupPreferences((current) => ({
          ...current,
          conversationOrder: {
            ...current.conversationOrder,
            [sourceOwner.id]: reorderSidebarItems(
              sortSidebarItems(
                sourceOwner.threads,
                current.conversationOrder?.[sourceOwner.id],
              ),
              sourceThreadId,
              lastThread.id,
              "after",
            ),
          },
        }));
      }
      return;
    }
    const edge =
      move.position === "before"
        ? "before"
        : move.position === "after"
          ? "after"
          : null;
    if (!edge || !targetThreadId)
      throw new Error(
        "Threads can only move relative to other threads or assistants",
      );
    const targetOwner = assistants.find((assistant) =>
      assistant.threads.some((thread) => thread.id === targetThreadId),
    );
    if (targetOwner && sourceOwner.id !== targetOwner.id) {
      if (!(await moveThread(sourceThreadId, targetOwner.id)))
        throw new Error(t("moveThreadError"));
      return;
    }
    if (sourceOwner.threads.some((thread) => thread.id === targetThreadId)) {
      setGroupPreferences((current) => ({
        ...current,
        conversationOrder: {
          ...current.conversationOrder,
          [sourceOwner.id]: reorderSidebarItems(
            sortSidebarItems(
              sourceOwner.threads,
              current.conversationOrder?.[sourceOwner.id],
            ),
            sourceThreadId,
            targetThreadId,
            edge,
          ),
        },
      }));
    }
  }

  function renameSidebarResource(item: SidebarResource, label: string) {
    if (item.id.startsWith("group:")) {
      const groupId = item.id.slice(6);
      if (groupId !== UNGROUPED_SIDEBAR_GROUP_ID) {
        setGroupPreferences((current) => ({
          ...current,
          groups: current.groups.map((group) =>
            group.id === groupId ? { ...group, name: label } : group,
          ),
        }));
        return;
      }
    }
    setTreeResetKey((key) => key + 1);
  }

  function isResourceRunning(item: SidebarResource) {
    if (item.id.startsWith("assistant:")) {
      return assistants
        .find((entry) => entry.id === item.id.slice(10))
        ?.threads.some((thread) => runningThreadIds.has(thread.id));
    }
    return (
      item.id.startsWith("thread:") && runningThreadIds.has(item.id.slice(7))
    );
  }

  function renderResourceIcon(item: SidebarResource) {
    if (item.id.startsWith("group:")) return <Folder className="size-4" />;
    const assistant = item.id.startsWith("assistant:");
    const running = isResourceRunning(item);
    const Icon = assistant ? Bot : MessageSquare;
    return (
      <span className="relative grid size-5 place-items-center">
        <Icon className="size-4" />
        {running ? (
          <span
            title={workT("statusRunning")}
            className="absolute right-0 top-0 size-2 animate-pulse rounded-full bg-green-500 ring-1 ring-background motion-reduce:animate-none"
          />
        ) : null}
      </span>
    );
  }

  function renderResourceMenu(
    item: SidebarResource,
    controls: SidebarResourceMenuControls,
  ) {
    const close = controls.close;
    if (item.id.startsWith("group:")) {
      const groupId = item.id.slice(6);
      if (groupId === UNGROUPED_SIDEBAR_GROUP_ID) return null;
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: This portaled menu boundary prevents background clicks selecting the owning sidebar row; buttons provide keyboard interaction.
        <div
          onClick={(event) => event.stopPropagation()}
          className="space-y-0.5"
        >
          <Button
            type="button"
            onClick={() => {
              close();
              setGroupEditor({ id: groupId, name: item.label });
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            <Pencil className="size-3.5" />
            {t("renameGroup")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              close();
              deleteAssistantGroup(groupId);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            <Trash2 className="size-3.5" />
            {t("deleteGroup")}
          </Button>
        </div>
      );
    }
    if (item.id.startsWith("assistant:")) {
      const assistant = assistants.find(
        (candidate) => candidate.id === item.id.slice(10),
      );
      if (!assistant) return null;
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: This portaled menu boundary prevents background clicks selecting the owning sidebar row; buttons provide keyboard interaction.
        <div
          onClick={(event) => event.stopPropagation()}
          className="space-y-0.5"
        >
          <Button
            type="button"
            onClick={() => {
              close();
              setEditing(assistant);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            <Pencil className="size-3.5" />
            {common("edit")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              close();
              void toggleAssistantPin(assistant);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            {assistant.pinned ? t("unpinAssistant") : t("pinAssistant")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              close();
              void createThread(assistant.id);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            <Plus className="size-3.5" />
            {t("newChat")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              close();
              void deleteAssistant(assistant.id);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2"
          >
            <Trash2 className="size-3.5" />
            {common("delete")}
          </Button>
        </div>
      );
    }
    const threadId = item.id.slice(7);
    const owner = assistants.find((assistant) =>
      assistant.threads.some((thread) => thread.id === threadId),
    );
    return owner ? (
      // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: This portaled menu boundary prevents background clicks selecting the owning sidebar row; its button provides keyboard interaction.
      <div onClick={(event) => event.stopPropagation()} className="space-y-0.5">
        <Button
          type="button"
          onClick={() => {
            close();
            void deleteThread(threadId);
          }}
          variant="ghost"
          size="sm"
          className="flex w-full justify-start gap-2"
        >
          <Trash2 className="size-3.5" />
          {t("deleteThread")}
        </Button>
      </div>
    ) : null;
  }

  function selectSidebarResource(id: string) {
    if (!id.startsWith("thread:")) return;
    const threadId = id.slice(7);
    const owner = assistants.find((assistant) =>
      assistant.threads.some((thread) => thread.id === threadId),
    );
    if (owner) {
      setMobilePane("chat");
      router.push(chatHref(slug, owner.id, threadId));
    }
  }

  function setAllAssistantSections(collapsed: boolean) {
    setExpandedAssistants(
      Object.fromEntries(
        assistants.map((assistant) => [assistant.id, !collapsed]),
      ),
    );
    setGroupPreferences((current) => ({
      ...current,
      collapsed: Object.fromEntries([
        ...current.groups.map((group) => [group.id, collapsed]),
        [UNGROUPED_SIDEBAR_GROUP_ID, collapsed],
      ]),
    }));
    setTreeResetKey((key) => key + 1);
  }

  return (
    <>
      <ChatApp
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        openMobile={mobilePane === "sidebar"}
        onOpenMobileChange={(open) => setMobilePane(open ? "sidebar" : "chat")}
        className="relative flex h-full min-w-0"
      >
        <div className="flex min-h-0 min-w-0 flex-1">
          <AnimatedSidebar
            ariaLabel={t("assistants")}
            collapsible="offcanvas"
            className="h-full shrink-0"
            panelClassName="h-full min-h-0"
          >
            <AnimatedSidebarContent className="gap-3 overflow-hidden px-2 py-3">
              <AnimatedSidebarGroup className="min-h-0 flex-1 p-0">
                <div className="flex h-9 shrink-0 items-center justify-between px-1">
                  <Button
                    type="button"
                    aria-label={t("newAssistant")}
                    title={t("newAssistant")}
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => {
                      setSelectedMarketTemplate(null);
                      setEditing("new");
                    }}
                  >
                    <Plus className="size-4" />
                  </Button>
                  <MorphPopover
                    open={listOptionsOpen}
                    onOpenChange={setListOptionsOpen}
                  >
                    <MorphPopoverTrigger>
                      <Button
                        type="button"
                        aria-label={t("listOptions")}
                        title={t("listOptions")}
                        variant={"ghost"}
                        size={"icon"}
                        className="flex shrink-0 items-center justify-center"
                      >
                        <ListFilter className="size-3.5" />
                      </Button>
                    </MorphPopoverTrigger>
                    <MorphPopoverContent
                      side="bottom"
                      align="end"
                      sideOffset={4}
                      className="z-50 w-52 p-1.5"
                    >
                      {assistants.length ? (
                        <>
                          <Button
                            type="button"
                            onClick={() => {
                              setAllAssistantSections(false);
                              setListOptionsOpen(false);
                            }}
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2"
                          >
                            <ChevronsUpDown className="size-4 shrink-0" />
                            <span>{t("expandAll")}</span>
                          </Button>
                          <Button
                            type="button"
                            onClick={() => {
                              setAllAssistantSections(true);
                              setListOptionsOpen(false);
                            }}
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2"
                          >
                            <ChevronsDownUp className="size-4 shrink-0" />
                            <span>{t("collapseAll")}</span>
                          </Button>
                        </>
                      ) : null}
                      <div className="my-1 h-px bg-border" />
                      <Button
                        type="button"
                        onClick={() => {
                          setGroupEditor({ id: null, name: "" });
                          setListOptionsOpen(false);
                        }}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start rounded-md px-2.5 text-left text-sm gap-2"
                      >
                        <FolderPlus className="size-4 shrink-0" />
                        <span>{t("newGroup")}</span>
                      </Button>
                    </MorphPopoverContent>
                  </MorphPopover>
                </div>
                <AnimatedSidebarGroupContent className="min-h-0 flex-1 overflow-y-auto">
                  {sortedAssistants.length ? (
                    <AISidebar
                      key={treeResetKey}
                      ariaLabel={t("assistants")}
                      className="px-1"
                      items={sidebarResources}
                      activeId={
                        activeThread ? `thread:${activeThread.id}` : null
                      }
                      defaultExpandedIds={[
                        ...assistants
                          .filter(
                            (assistant) =>
                              expandedAssistants[assistant.id] ?? true,
                          )
                          .map((assistant) => `assistant:${assistant.id}`),
                        ...groupPreferences.groups
                          .filter(
                            (group) => !groupPreferences.collapsed[group.id],
                          )
                          .map((group) => `group:${group.id}`),
                        ...(!groupPreferences.collapsed[
                          UNGROUPED_SIDEBAR_GROUP_ID
                        ]
                          ? [`group:${UNGROUPED_SIDEBAR_GROUP_ID}`]
                          : []),
                      ]}
                      renderIcon={renderResourceIcon}
                      renderActions={(item) => {
                        const status = isResourceRunning(item) ? (
                          <span
                            role="status"
                            aria-label={`${item.label}: ${workT("statusRunning")}`}
                            className="sr-only"
                          >
                            {workT("statusRunning")}
                          </span>
                        ) : null;
                        if (!item.id.startsWith("assistant:")) return status;
                        return (
                          <>
                            {status}
                            <button
                              type="button"
                              draggable={false}
                              disabled={busy}
                              aria-label={`${t("newChat")} ${item.label}`}
                              title={t("newChat")}
                              onClick={(event) => {
                                event.stopPropagation();
                                void createThread(item.id.slice(10));
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
                      renderMenu={renderResourceMenu}
                      onMove={handleResourceMove}
                      onRename={renameSidebarResource}
                      onActiveChange={selectSidebarResource}
                    />
                  ) : (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {t("empty")}
                    </p>
                  )}
                </AnimatedSidebarGroupContent>
              </AnimatedSidebarGroup>
            </AnimatedSidebarContent>
            <AnimatedSidebarRail />
          </AnimatedSidebar>

          <AnimatedSidebarInset className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 sm:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <ChatAppSidebarTrigger
                    openLabel={t("showSidebar")}
                    closeLabel={t("hideSidebar")}
                  >
                    <PanelLeft className="size-4" />
                  </ChatAppSidebarTrigger>
                  {activeAssistant ? (
                    <Button
                      type="button"
                      onClick={() => setEditing(activeAssistant)}
                      aria-label={`${t("settings")}: ${activeAssistant.name}`}
                      title={t("settings")}
                      variant="ghost"
                      size="sm"
                      className="min-w-0 gap-2"
                    >
                      <Bot className="size-4 shrink-0" />
                      <span className="min-w-0 text-left">
                        <span className="block max-w-32 truncate text-xs font-medium sm:max-w-44">
                          {activeAssistant.name}
                        </span>
                        {activeThread ? (
                          <span className="block max-w-32 truncate text-[11px] font-normal text-muted-foreground sm:max-w-44">
                            {activeThread.title || t("newChat")}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  ) : null}
                </div>
                {activeThread && branch ? (
                  <Button
                    type="button"
                    onClick={() =>
                      setBranchOpen((value) => {
                        if (value) setBranchMaximized(false);
                        return !value;
                      })
                    }
                    aria-label={
                      branchOpen ? t("hideBranches") : t("showBranches")
                    }
                    aria-pressed={branchOpen}
                    title={t("conversationBranches")}
                    variant={"ghost"}
                    size={"icon"}
                    className="flex shrink-0 items-center justify-center"
                  >
                    <GitBranch className="size-[17px]" />
                  </Button>
                ) : null}
              </header>
              {error ? (
                <p
                  role="alert"
                  className="mx-4 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
              {activeAssistant && activeThread ? (
                <AgentConversation
                  key={activeThread.id}
                  activeConversationId={activeThread.id}
                  agentId={activeAssistant.id}
                  agentName={activeAssistant.name}
                  allowEdit
                  allowRegenerate
                  apiPath={`/api/v1/chat/threads/${activeThread.id}/turns`}
                  attachmentUploadUrl={`/api/v1/workspaces/${workspaceId}/attachments`}
                  contextBaseText={activeAssistant.systemPrompt}
                  contextWindow={activeAssistant.contextWindow}
                  contextWindowEstimated={
                    activeAssistant.contextWindowEstimated
                  }
                  creatingConversation={false}
                  ensureConversation={async () => activeThread.id}
                  includeConversationIdInBody={false}
                  initialMessages={initialMessages}
                  initialReasoningEffort="default"
                  mcpPromptApiPath={`/api/v1/chat/threads/${activeThread.id}/prompts`}
                  mcpResourceApiPath={`/api/v1/chat/threads/${activeThread.id}/composer`}
                  modelName={activeAssistant.model}
                  modelPicker={
                    <ModelPicker
                      providers={providers}
                      value={
                        activeAssistant.modelProviderId && activeAssistant.model
                          ? {
                              providerId: activeAssistant.modelProviderId,
                              model: activeAssistant.model,
                            }
                          : null
                      }
                      pending={busy}
                      onSelect={(selection) =>
                        void updateAssistantModel(selection)
                      }
                      onConfigure={() => {
                        window.location.assign(
                          `/app/${encodeURIComponent(slug)}/providers`,
                        );
                      }}
                      trigger={
                        <Button
                          type="button"
                          disabled={busy}
                          aria-label={`${t("model")}: ${activeAssistant.model ?? t("modelMissing")}`}
                          title={activeAssistant.model ?? t("modelMissing")}
                          variant="ghost"
                          size="sm"
                          className="h-8 min-w-0 max-w-52 gap-1.5 rounded-xl px-2 text-xs text-muted-foreground"
                        >
                          <Cpu className="size-3.5 shrink-0" />
                          <span className="min-w-0 truncate">
                            {activeAssistant.model ?? t("modelMissing")}
                          </span>
                          <ChevronDown className="size-3 shrink-0" />
                        </Button>
                      }
                    />
                  }
                  ready={Boolean(
                    activeAssistant.modelProviderId && activeAssistant.model,
                  )}
                  reasoningAvailable={reasoningAvailable}
                  runtimeKind={null}
                  serverManaged
                  supportsAttachments
                  webSearchAvailable={activeAssistant.webSearchAvailable}
                  branchBusy={branchBusy}
                  branchNavigation={branch?.navigation ?? []}
                  onBranchChange={(messageId) => void switchBranch(messageId)}
                  onConversationChanged={refreshChat}
                  onNewConversation={() => createThread(activeAssistant.id)}
                  onStartBranch={(messageId) => void startBranch(messageId)}
                />
              ) : (
                <div className="m-auto max-w-md px-6 text-center">
                  <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Bot className="size-5" />
                  </div>
                  <h2 className="text-base font-medium">
                    {activeAssistant ? t("noThreadTitle") : t("emptyTitle")}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {activeAssistant
                      ? t("noThreadDescription")
                      : t("emptyDescription")}
                  </p>
                  <Button
                    type="button"
                    onClick={() =>
                      activeAssistant
                        ? void createThread(activeAssistant.id)
                        : setEditing("new")
                    }
                    variant={"primary"}
                    size={"sm"}
                    className="mt-4"
                  >
                    <Plus className="size-4" />
                    {activeAssistant ? t("newChat") : t("newAssistant")}
                  </Button>
                </div>
              )}
            </section>
          </AnimatedSidebarInset>

          {branchOpen && !branchMaximized && activeThread && branch ? (
            <aside className="hidden w-80 shrink-0 min-h-0 flex-col overflow-hidden border-l border-border bg-background xl:flex">
              <ChatBranchPanel
                branch={branch}
                busy={branchBusy}
                canMaximize
                onClose={() => setBranchOpen(false)}
                onDelete={(messageId) => void deleteBranch(messageId)}
                onMaximize={() => setBranchMaximized(true)}
                onSelect={(messageId) => void switchBranch(messageId)}
                onStart={(messageId) => void startBranch(messageId)}
              />
            </aside>
          ) : null}
        </div>
      </ChatApp>

      {branchOpen && !branchMaximized && activeThread && branch ? (
        <CenterMorphModal
          open={branchOpen && !branchMaximized && !desktopBranches}
          onOpenChange={(open) => {
            if (!open) setBranchOpen(false);
          }}
        >
          <CenterMorphModalContent
            ariaLabel={t("conversationBranches")}
            closeButtonLabel={common("close")}
            className="flex h-[min(48rem,calc(100dvh-2rem))] w-full max-w-4xl flex-col"
          >
            <ChatBranchPanel
              branch={branch}
              busy={branchBusy}
              onDelete={(messageId) => void deleteBranch(messageId)}
              onSelect={(messageId) => void switchBranch(messageId)}
              onStart={(messageId) => void startBranch(messageId)}
            />
          </CenterMorphModalContent>
        </CenterMorphModal>
      ) : null}

      {branchOpen && branchMaximized && activeThread && branch ? (
        <div className="fixed inset-0 z-[70] flex bg-background">
          <ChatBranchPanel
            branch={branch}
            busy={branchBusy}
            canMaximize
            maximized
            onClose={() => {
              setBranchOpen(false);
              setBranchMaximized(false);
            }}
            onDelete={(messageId) => void deleteBranch(messageId)}
            onMaximize={() => setBranchMaximized(false)}
            onSelect={(messageId) => void switchBranch(messageId)}
            onStart={(messageId) => void startBranch(messageId)}
          />
        </div>
      ) : null}

      <SidebarGroupDialog
        initialName={groupEditor?.name ?? ""}
        open={Boolean(groupEditor)}
        title={t(groupEditor?.id ? "renameGroup" : "newGroup")}
        nameLabel={t("groupName")}
        placeholder={t("groupNamePlaceholder")}
        cancelLabel={common("cancel")}
        submitLabel={groupEditor?.id ? common("save") : common("create")}
        onClose={() => setGroupEditor(null)}
        onSubmit={saveAssistantGroup}
      />

      {editing ? (
        <AssistantEditor
          key={
            editing === "new"
              ? `new:${selectedMarketTemplate?.releaseId ?? "blank"}`
              : editing.id
          }
          assistant={editing === "new" ? null : editing}
          deployments={deployments}
          marketTemplate={editing === "new" ? selectedMarketTemplate : null}
          marketTemplates={marketTemplates}
          onClose={() => setEditing(null)}
          onDelete={deleteAssistant}
          onSaved={assistantSaved}
          onTemplateSelect={setSelectedMarketTemplate}
          open
          providers={providers}
          slug={slug}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}
