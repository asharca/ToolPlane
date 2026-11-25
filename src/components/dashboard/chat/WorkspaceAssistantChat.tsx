"use client";
import { apiRequest } from "@/lib/client/api";
import {
  DisplayError,
  displayErrorText,
} from "@/components/dashboard/display-error";
import { SidebarToolbar } from "@/components/dashboard/SidebarToolbar";
import { useSidebarScroll } from "@/components/dashboard/useSidebarScroll";
import { notify } from "@/components/dashboard/Toaster";
import { ModelProviderNotice } from "@/components/dashboard/ModelProviderNotice";

import { Button } from "@/components/motion/button";

import dynamic from "next/dynamic";
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
import { cn } from "@/lib/utils";

import type { FileUIPart } from "ai";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  Globe,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Pin,
  Pencil,
  PanelLeft,
  Plus,
  Settings2,
  SquarePen,
  Trash2,
  X,
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
import {
  AssistantConversation,
  type AssistantAutoSubmitPayload,
} from "./AssistantConversation";
import { AssistantEditor } from "./AssistantEditor";
import type { ChatBranchState } from "@/components/dashboard/chat/ChatBranchFlow";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import {
  ComposerModelSelect,
  type ModelSelection,
} from "@/components/dashboard/ComposerModelSelect";
import {
  conversationComposerDockClassName,
  conversationComposerSurfaceClassName,
} from "@/components/dashboard/ConversationComposer";
import {
  ComposerDropOverlay,
  ConfirmActionDialog,
  hasOpenDialog,
  uploadWorkspaceAttachments,
  useComposerFileDrop,
} from "@/components/dashboard/ConversationUxPrimitives";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import {
  selectionSupportsReasoning,
  type ReasoningEffort,
  type ReasoningLevel,
} from "@/lib/agents/constants";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { STORAGE_QUOTA_EXCEEDED } from "@/components/dashboard/ManageFilesButton";
import type { ChatBranchNavigation } from "@/lib/chat/branches";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { SidebarGroupDialog } from "@/components/dashboard/SidebarGroupDialog";
import { sidebarHoverActionsClassName } from "@/components/dashboard/sidebarHoverActions";
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
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";
import { McpToolsUpdatedNote } from "@/components/dashboard/RevisionUpgradeNotice";

const ChatBranchPanel = dynamic(
  () =>
    import("@/components/dashboard/chat/ChatBranchFlow").then(
      (mod) => mod.ChatBranchPanel,
    ),
  { ssr: false },
);

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = {
  id: string;
  name: string;
  status: string;
  keywords?: string[];
  available?: boolean;
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

export type ChatAssistantItem = {
  id: string;
  name: string;
  description?: string | null;
  pinned: boolean;
  revision: number;
  mcpGrants?: Array<{
    deploymentId: string;
    allowedToolNames: string[];
  }>;
  mcpToolChanges?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  };
  systemPrompt: string | null;
  modelProviderId: string | null;
  model: string | null;
  reasoningEffort: ReasoningLevel | null;
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
    revisionId?: string | null;
    revision?: number | null;
    legacyRevisionUnresolved?: boolean;
  }>;
};

const EMPTY_EXPANDED_ASSISTANTS: Record<string, boolean> = {};
const EMPTY_RUNNING_THREADS: string[] = [];
const EMPTY_INITIAL_MESSAGES: AgentUIMessage[] = [];
const EMPTY_BRANCH_NAVIGATION: ChatBranchNavigation[] = [];
const UNGROUPED_SIDEBAR_GROUP_ID = "__ungrouped__";

function chatHref(
  slug: string,
  assistantId: string,
  threadId?: string,
  options?: { isNew?: boolean },
) {
  const query = new URLSearchParams({ assistant: assistantId });
  if (threadId) query.set("thread", threadId);
  else if (options?.isNew) query.set("new", "1");
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
}

export { estimatePromptTokens } from "@/lib/prompt-tokens";

const NO_PIN_OVERRIDES: Record<string, boolean> = {};

export function WorkspaceAssistantChat({
  assistants: serverAssistants,
  branch = null,
  deployments,
  initialMessages,
  providers,
  hasProviders,
  defaultModelSelection = null,
  defaultReasoningEffort,
  selectedAssistantId,
  selectedThreadId,
  slug,
  startCreating = false,
  startEditing = false,
  startNewThread = false,
  initialExpandedAssistants = EMPTY_EXPANDED_ASSISTANTS,
  initialGroupPreferences = EMPTY_SIDEBAR_GROUP_PREFERENCES,
  initialSidebarOpen = true,
  workspaceId,
  initialRunningThreadIds = EMPTY_RUNNING_THREADS,
}: {
  assistants: ChatAssistantItem[];
  branch?: ChatBranchState | null;
  deployments: McpOption[];
  initialMessages: AgentUIMessage[];
  providers: ProviderOption[];
  hasProviders: boolean;
  defaultModelSelection?: ModelSelection | null;
  defaultReasoningEffort: ReasoningLevel | null;
  selectedAssistantId: string | null;
  selectedThreadId: string | null;
  slug: string;
  startCreating?: boolean;
  startEditing?: boolean;
  startNewThread?: boolean;
  initialExpandedAssistants?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
  workspaceId: string;
  initialRunningThreadIds?: string[];
}) {
  const t = useTranslations("console.chatAssistants");
  const agentsT = useTranslations("console.agents");
  const common = useTranslations("common");
  const workT = useTranslations("console.work");
  const router = useRouter();
  const [composerModels, setComposerModels] = useState<
    Record<string, ModelSelection | null>
  >({});
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>(
    {},
  );
  const [draftMode, setDraftMode] = useState(startNewThread);
  const [draftAssistantId, setDraftAssistantId] = useState<string | null>(null);
  const [selectedClientThreadId, setSelectedClientThreadId] = useState<
    string | null
  >(selectedThreadId);
  const [prevServerThreadId, setPrevServerThreadId] =
    useState(selectedThreadId);
  if (prevServerThreadId !== selectedThreadId) {
    setPrevServerThreadId(selectedThreadId);
    setSelectedClientThreadId(selectedThreadId);
    setDraftMode(Boolean(startNewThread && !selectedThreadId));
    setDraftAssistantId(null);
  }
  const [optimisticThreads, setOptimisticThreads] = useState<
    Record<string, ChatAssistantItem["threads"]>
  >({});
  const [deletedThreadIds, setDeletedThreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletedAssistantIds, setDeletedAssistantIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [renamedThreads, setRenamedThreads] = useState<Record<string, string>>(
    {},
  );
  const [pendingFirstTurn, setPendingFirstTurn] =
    useState<AssistantAutoSubmitPayload | null>(null);
  const [draftFiles, setDraftFiles] = useState<FileUIPart[]>([]);
  const [draftUploading, setDraftUploading] = useState(false);
  const [draftWebSearch, setDraftWebSearch] = useState(false);
  const [draftReasoningEffort, setDraftReasoningEffort] =
    useState<ReasoningEffort>("default");
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const draftAttachmentInputRef = useRef<HTMLInputElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inlineThreadTitle, setInlineThreadTitle] = useState<string | null>(
    null,
  );
  const inlineRenameInputRef = useRef<HTMLInputElement>(null);
  const renamingThread = inlineThreadTitle !== null;
  useEffect(() => {
    if (renamingThread) {
      inlineRenameInputRef.current?.focus();
      inlineRenameInputRef.current?.select();
    }
  }, [renamingThread]);
  const [threadRenameTarget, setThreadRenameTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<
    | { kind: "thread"; threadId: string }
    | { kind: "assistant"; assistantId: string }
    | { kind: "group"; groupId: string; name: string }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Pin toggles apply immediately; overrides drop once refreshed props arrive.
  const [pinState, setPinState] = useState<{
    source: typeof serverAssistants;
    values: Record<string, boolean>;
  }>({ source: serverAssistants, values: {} });
  const pinOverrides =
    pinState.source === serverAssistants ? pinState.values : NO_PIN_OVERRIDES;
  const assistants = useMemo(
    () =>
      serverAssistants
        .filter((assistant) => !deletedAssistantIds.has(assistant.id))
        .map((assistant) => {
          const baseThreads = assistant.threads
            .filter((thread) => !deletedThreadIds.has(thread.id))
            .map((thread) =>
              thread.id in renamedThreads
                ? { ...thread, title: renamedThreads[thread.id] }
                : thread,
            );
          const knownIds = new Set(baseThreads.map((thread) => thread.id));
          const extraThreads = (optimisticThreads[assistant.id] ?? [])
            .filter(
              (thread) =>
                !deletedThreadIds.has(thread.id) && !knownIds.has(thread.id),
            )
            .map((thread) =>
              thread.id in renamedThreads
                ? { ...thread, title: renamedThreads[thread.id] }
                : thread,
            );
          return {
            ...assistant,
            ...(assistant.id in pinOverrides
              ? { pinned: pinOverrides[assistant.id] }
              : {}),
            threads: [...extraThreads, ...baseThreads],
          };
        }),
    [
      serverAssistants,
      pinOverrides,
      deletedAssistantIds,
      deletedThreadIds,
      renamedThreads,
      optimisticThreads,
    ],
  );
  const activeAssistant =
    assistants.find(
      (assistant) => assistant.id === (draftAssistantId ?? selectedAssistantId),
    ) ??
    assistants[0] ??
    null;
  const activeThread = draftMode
    ? null
    : (activeAssistant?.threads.find(
        (thread) => thread.id === (selectedClientThreadId ?? selectedThreadId),
      ) ?? null);
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
        const response = await apiRequest<{ runningThreadIds?: string[] }>(
          `/api/v1/chat/assistants?workspaceId=${encodeURIComponent(workspaceId)}&running=1`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) return;
        const body = response.data;
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
    startCreating ? "new" : startEditing ? activeAssistant : null,
  );
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
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
      const response = await apiRequest(
        `/api/v1/chat/threads/${activeThread.id}`,
        {
          method: "PATCH",
          json: { activeMessageId: messageId },
        },
      );
      if (!response.ok)
        throw new DisplayError(response.message ?? t("branchSwitchError"));

      refreshChat();
    } catch (cause) {
      setError(displayErrorText(cause, t("branchSwitchError")));
    } finally {
      setBranchMutating(false);
    }
  }

  async function startBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await apiRequest<{
        branch?: { activeMessageId?: string | null; activated?: boolean };
      }>(`/api/v1/chat/threads/${activeThread.id}/branches`, {
        method: "POST",
        json: { messageId },
      });
      if (!response.ok)
        throw new DisplayError(response.message ?? t("branchCreateError"));
      const body = response.data;

      if (body.branch?.activated && body.branch.activeMessageId) {
        focusBranchMessageIdRef.current = body.branch.activeMessageId;
      }
      refreshChat();
    } catch (cause) {
      setError(displayErrorText(cause, t("branchCreateError")));
    } finally {
      setBranchMutating(false);
    }
  }

  async function deleteBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await apiRequest(
        `/api/v1/chat/threads/${activeThread.id}/branches`,
        {
          method: "DELETE",
          json: { messageId },
        },
      );
      if (!response.ok)
        throw new DisplayError(response.message ?? t("branchDeleteError"));

      refreshChat();
    } catch (cause) {
      setError(displayErrorText(cause, t("branchDeleteError")));
    } finally {
      setBranchMutating(false);
    }
  }

  const startNewChat = useCallback(
    (assistantId: string) => {
      setDraftAssistantId(assistantId);
      setDraftMode(true);
      setInlineThreadTitle(null);
      setMobilePane("chat");
      setError(null);
      setExpandedAssistants((current) => ({ ...current, [assistantId]: true }));
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
      if (typeof window !== "undefined") {
        window.history.replaceState(
          window.history.state,
          "",
          chatHref(slug, assistantId, undefined, { isNew: true }),
        );
        requestAnimationFrame(() => draftTextareaRef.current?.focus());
      }
    },
    [setExpandedAssistants, setGroupPreferences, slug],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || hasOpenDialog()) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        if (!activeAssistant) return;
        event.preventDefault();
        startNewChat(activeAssistant.id);
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setSidebarOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeAssistant, setSidebarOpen, startNewChat]);

  const draftText = activeAssistant
    ? (composerDrafts[`draft:${activeAssistant.id}`] ?? "")
    : "";
  const setDraftText = (next: string) => {
    if (!activeAssistant) return;
    setComposerDrafts((previous) => ({
      ...previous,
      [`draft:${activeAssistant.id}`]: next,
    }));
  };
  const draftModelSelection = activeAssistant
    ? (composerModels[`draft:${activeAssistant.id}`] ?? null)
    : null;
  const draftDefaultModel: ModelSelection | null =
    activeAssistant?.modelProviderId && activeAssistant.model
      ? {
          providerId: activeAssistant.modelProviderId,
          model: activeAssistant.model,
        }
      : null;
  const draftReasoningAvailable = selectionSupportsReasoning(
    providers,
    draftModelSelection ?? draftDefaultModel,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftText drives auto-growing height.
  useEffect(() => {
    const textarea = draftTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.35)}px`;
  }, [draftText, draftMode, activeAssistant?.id]);

  async function uploadDraftFiles(selected: FileList | File[] | null) {
    if (!selected) return;
    const list = Array.from(selected);
    if (!list.length) return;
    setDraftUploading(true);
    setError(null);
    try {
      const uploaded = await uploadWorkspaceAttachments({
        attachmentUploadUrl: `/api/v1/workspaces/${workspaceId}/attachments`,
        selected: list,
        existingCount: draftFiles.length,
        limitReachedMessage: agentsT("attachmentLimitReached", { count: 5 }),
        uploadFailedMessage: agentsT("attachmentUploadFailed"),
      });
      setDraftFiles((previous) => [...previous, ...uploaded]);
    } catch (cause) {
      setError(displayErrorText(cause, agentsT("attachmentUploadFailed")));
    } finally {
      setDraftUploading(false);
    }
  }

  const draftDrop = useComposerFileDrop({
    enabled: Boolean(
      activeAssistant &&
        (draftMode || !activeThread) &&
        !draftUploading &&
        !busy,
    ),
    onFiles: (selected) => void uploadDraftFiles(selected),
  });

  async function submitDraftStart() {
    if (!activeAssistant || busy || draftUploading) return;
    const trimmed = draftText.trim();
    if (!trimmed && !draftFiles.length) return;
    setBusy(true);
    setError(null);
    const chosenModel =
      composerModels[`draft:${activeAssistant.id}`] ?? undefined;
    const turnKey = crypto.randomUUID();
    const submittedText = draftText;
    const submittedFiles = draftFiles;
    try {
      const response = await apiRequest<{
        thread?: { id?: string; title?: string | null };
        id?: string;
      }>(`/api/v1/chat/assistants/${activeAssistant.id}/threads`, {
        method: "POST",
        json: {},
      });
      if (!response.ok) {
        throw new DisplayError(
          response.message ===
            "Publish an Assistant revision before creating a thread"
            ? t("revisionRequired")
            : (response.message ?? t("threadCreateError")),
        );
      }
      const body = response.data;
      const threadId = body.thread?.id ?? body.id;
      if (!threadId) throw new DisplayError(t("threadCreateError"));
      const todayLabel = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date());
      setOptimisticThreads((previous) => ({
        ...previous,
        [activeAssistant.id]: [
          {
            id: threadId,
            title: trimmed.slice(0, 80) || null,
            createdAt: todayLabel,
            lastMessageAt: null,
            revision: activeAssistant.revision,
            legacyRevisionUnresolved: false,
          },
          ...(previous[activeAssistant.id] ?? []),
        ],
      }));
      if (chosenModel) {
        setComposerModels((previous) => ({
          ...previous,
          [threadId]: chosenModel,
        }));
      }
      setComposerDrafts((previous) => {
        const next = { ...previous };
        delete next[`draft:${activeAssistant.id}`];
        return next;
      });
      setDraftFiles([]);
      setPendingFirstTurn({
        key: turnKey,
        threadId,
        text: submittedText,
        files: submittedFiles,
        modelOverride: chosenModel,
        reasoningEffort: draftReasoningAvailable
          ? draftReasoningEffort
          : undefined,
        webSearchEnabled: draftWebSearch,
      });
      setDraftMode(false);
      setDraftAssistantId(null);
      setSelectedClientThreadId(threadId);
      setExpandedAssistants((current) => ({
        ...current,
        [activeAssistant.id]: true,
      }));
      openAssistantGroup(activeAssistant.id);
      router.push(chatHref(slug, activeAssistant.id, threadId), {
        scroll: false,
      });
      router.refresh();
    } catch (cause) {
      setError(displayErrorText(cause, t("threadCreateError")));
    } finally {
      setBusy(false);
    }
  }

  async function renameThread(threadId: string, nextTitle: string) {
    const trimmed = nextTitle.trim();
    if (!trimmed) return;
    setError(null);
    setRenamedThreads((previous) => ({ ...previous, [threadId]: trimmed }));
    try {
      const response = await apiRequest(`/api/v1/chat/threads/${threadId}`, {
        method: "PATCH",
        json: { title: trimmed },
      });
      if (!response.ok) {
        throw new DisplayError(response.message ?? t("saveError"));
      }
      notify(t("threadRenamed"));
      refreshChat();
    } catch (cause) {
      setRenamedThreads((previous) => {
        const next = { ...previous };
        delete next[threadId];
        return next;
      });
      setError(displayErrorText(cause, t("saveError")));
    }
  }

  function deleteThread(threadId: string) {
    setConfirmDialog({ kind: "thread", threadId });
  }

  function deleteAssistant(assistantId: string) {
    setEditing(null);
    setConfirmDialog({ kind: "assistant", assistantId });
  }

  async function executeConfirmDialog() {
    if (!confirmDialog || confirmBusy) return;
    setConfirmBusy(true);
    setError(null);
    try {
      if (confirmDialog.kind === "thread") {
        const { threadId } = confirmDialog;
        const response = await apiRequest(`/api/v1/chat/threads/${threadId}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          setError(response.message ?? t("deleteError"));
          return;
        }
        setConfirmDialog(null);
        setDeletedThreadIds((previous) => new Set([...previous, threadId]));
        notify(t("threadDeleted"));
        const owner = assistants.find((item) =>
          item.threads.some((thread) => thread.id === threadId),
        );
        const remaining = owner?.threads.filter(
          (thread) => thread.id !== threadId,
        );
        const nextThread = remaining?.[0];
        if (owner && nextThread) {
          setSelectedClientThreadId(nextThread.id);
          setDraftMode(false);
          router.push(chatHref(slug, owner.id, nextThread.id));
        } else if (owner) {
          startNewChat(owner.id);
          router.push(chatHref(slug, owner.id, undefined, { isNew: true }));
        } else {
          router.push(`/app/${encodeURIComponent(slug)}/chat`);
        }
        router.refresh();
        return;
      }
      if (confirmDialog.kind === "assistant") {
        const { assistantId } = confirmDialog;
        const response = await apiRequest(
          `/api/v1/chat/assistants/${assistantId}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          setError(response.message ?? t("deleteError"));
          return;
        }
        setConfirmDialog(null);
        setDeletedAssistantIds(
          (previous) => new Set([...previous, assistantId]),
        );
        const fallback = assistants.find((item) => item.id !== assistantId);
        router.push(
          fallback
            ? chatHref(slug, fallback.id)
            : `/app/${encodeURIComponent(slug)}/chat`,
        );
        router.refresh();
        return;
      }
      if (confirmDialog.kind === "group") {
        const { groupId } = confirmDialog;
        setConfirmDialog(null);
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
    } finally {
      setConfirmBusy(false);
    }
  }

  async function toggleAssistantPin(assistant: ChatAssistantItem) {
    const pinned = !assistant.pinned;
    const setOverride = (value?: boolean) =>
      setPinState((current) => {
        const values = {
          ...(current.source === serverAssistants ? current.values : {}),
        };
        if (value === undefined) delete values[assistant.id];
        else values[assistant.id] = value;
        return { source: serverAssistants, values };
      });
    setOverride(pinned);
    setError(null);
    try {
      const response = await apiRequest(
        `/api/v1/chat/assistants/${assistant.id}`,
        {
          method: "PATCH",
          json: {
            pinned,
            expectedRevision: assistant.revision,
          },
        },
      );
      if (!response.ok)
        throw new DisplayError(response.message ?? t("saveError"));

      refreshChat();
    } catch (cause) {
      setOverride();
      setError(displayErrorText(cause, t("saveError")));
    }
  }

  async function assistantSaved(assistantId: string, created: boolean) {
    setEditing(null);
    if (created) {
      notify(t("created"));
      startNewChat(assistantId);
      router.push(chatHref(slug, assistantId, undefined, { isNew: true }));
      router.refresh();
      return;
    }
    notify(t("savedForNewThreads"));
    router.refresh();
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
    if (!group) return;
    setConfirmDialog({ kind: "group", groupId, name: group.name });
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

  const filteredSidebarResources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sidebarResources;
    function filter(items: SidebarResource[]): SidebarResource[] {
      return items.flatMap((item) => {
        if (item.label.toLocaleLowerCase().includes(query)) return [item];
        const children = item.children ? filter(item.children) : [];
        return children.length ? [{ ...item, children }] : [];
      });
    }
    return filter(sidebarResources);
  }, [search, sidebarResources]);

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
        throw new Error(
          "A conversation cannot change its Assistant or pinned revision",
        );
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
      throw new Error(
        "A conversation cannot change its Assistant or pinned revision",
      );
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
    if (item.id.startsWith("thread:")) {
      void renameThread(item.id.slice(7), label);
      return;
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
    // Second-level threads show only a running dot; `false` suppresses the sidebar default icon.
    if (!assistant)
      return running ? (
        <span
          data-sidebar-dot=""
          title={workT("statusRunning")}
          className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      ) : (
        false
      );
    return <Bot className="size-4" />;
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
              deleteAssistant(assistant.id);
            }}
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
    const thread = owner?.threads.find(
      (candidate) => candidate.id === threadId,
    );
    return owner && thread ? (
      // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: This portaled menu boundary prevents background clicks selecting the owning sidebar row; its button provides keyboard interaction.
      <div onClick={(event) => event.stopPropagation()} className="space-y-0.5">
        <Button
          type="button"
          onClick={() => {
            close();
            setThreadRenameTarget({
              id: threadId,
              name: thread.title || "",
            });
          }}
          variant="ghost"
          size="sm"
          className="flex w-full justify-start gap-2"
        >
          <Pencil className="size-3.5" />
          {t("renameThread")}
        </Button>
        <Button
          type="button"
          onClick={() => {
            close();
            deleteThread(threadId);
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
      setDraftMode(false);
      setDraftAssistantId(null);
      setInlineThreadTitle(null);
      setSelectedClientThreadId(threadId);
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

  const onSidebarScroll = useSidebarScroll();

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
            panelClassName="h-full min-h-0 border-r border-border/50 bg-muted/25"
          >
            <AnimatedSidebarContent className="gap-3 overflow-hidden px-2 py-3">
              <AnimatedSidebarGroup className="min-h-0 flex-1 p-0">
                <SidebarToolbar
                  title={t("assistants")}
                  searchLabel={t("search")}
                  searchPlaceholder={t("search")}
                  search={search}
                  onSearchChange={setSearch}
                  addLabel={t("newAssistant")}
                  onAdd={() => setEditing("new")}
                  moreLabel={t("listOptions")}
                  moreOpen={listOptionsOpen}
                  onMoreOpenChange={setListOptionsOpen}
                  hasItems={assistants.length > 0}
                  expandLabel={t("expandAll")}
                  collapseLabel={t("collapseAll")}
                  newGroupLabel={t("newGroup")}
                  onExpandAll={() => {
                    setAllAssistantSections(false);
                    setListOptionsOpen(false);
                  }}
                  onCollapseAll={() => {
                    setAllAssistantSections(true);
                    setListOptionsOpen(false);
                  }}
                  onNewGroup={() => {
                    setGroupEditor({ id: null, name: "" });
                    setListOptionsOpen(false);
                  }}
                />
                <AnimatedSidebarGroupContent
                  onScroll={onSidebarScroll}
                  className="sidebar-scroll min-h-0 flex-1 !w-auto -mr-2 overflow-y-auto overscroll-contain pr-2 pb-4"
                >
                  {filteredSidebarResources.length ? (
                    <AISidebar
                      key={`${treeResetKey}:${search.trim()}`}
                      ariaLabel={t("assistants")}
                      className={`px-0 [&_[role=treeitem]]:rounded-lg [&_[role=treeitem]]:text-[13px] [&_[role=treeitem]>span[aria-hidden=true]:empty]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:empty]:w-0 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:ml-1 [&_[role=treeitem]>span[aria-hidden=true]:has(>[data-sidebar-dot])]:w-0 ${sidebarHoverActionsClassName}`}
                      items={filteredSidebarResources}
                      activeId={
                        activeThread ? `thread:${activeThread.id}` : null
                      }
                      defaultExpandedIds={[
                        ...(search.trim()
                          ? assistants.map(
                              (assistant) => `assistant:${assistant.id}`,
                            )
                          : []),
                        ...(search.trim()
                          ? groupPreferences.groups.map(
                              (group) => `group:${group.id}`,
                            )
                          : []),
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
                        const assistant = assistants.find(
                          (entry) => entry.id === item.id.slice(10),
                        );
                        return (
                          <>
                            {status}
                            {assistant ? (
                              <button
                                type="button"
                                draggable={false}
                                aria-pressed={assistant.pinned}
                                data-sidebar-reveal={
                                  assistant.pinned ? undefined : ""
                                }
                                aria-label={`${assistant.pinned ? t("unpinAssistant") : t("pinAssistant")} ${item.label}`}
                                title={
                                  assistant.pinned
                                    ? t("unpinAssistant")
                                    : t("pinAssistant")
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleAssistantPin(assistant);
                                }}
                                className={cn(
                                  "grid size-7 shrink-0 place-items-center rounded-lg outline-none transition-opacity hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                                  assistant.pinned
                                    ? "text-foreground opacity-100"
                                    : "text-muted-foreground opacity-0",
                                )}
                              >
                                <Pin
                                  aria-hidden="true"
                                  className={cn(
                                    "size-3.5 rotate-45",
                                    assistant.pinned && "fill-current",
                                  )}
                                />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              draggable={false}
                              data-sidebar-reveal=""
                              disabled={busy}
                              aria-label={`${t("newChat")} ${item.label}`}
                              title={t("newChat")}
                              onClick={(event) => {
                                event.stopPropagation();
                                startNewChat(item.id.slice(10));
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
                      {t(search.trim() ? "empty" : "noAssistants")}
                    </p>
                  )}
                </AnimatedSidebarGroupContent>
              </AnimatedSidebarGroup>
            </AnimatedSidebarContent>
            <AnimatedSidebarRail />
          </AnimatedSidebar>

          <AnimatedSidebarInset className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-background px-3 sm:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <ChatAppSidebarTrigger
                    openLabel={t("showSidebar")}
                    closeLabel={t("hideSidebar")}
                  >
                    <PanelLeft className="size-4" />
                  </ChatAppSidebarTrigger>
                  {activeAssistant ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => startNewChat(activeAssistant.id)}
                        aria-label={t("newChat")}
                        title={t("shortcutNewChat")}
                        className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <SquarePen className="size-4" />
                      </Button>
                      <MorphPopover
                        open={switcherOpen}
                        onOpenChange={setSwitcherOpen}
                      >
                        <MorphPopoverTrigger>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t("switchAssistant")}
                            className="h-8 min-w-0 gap-1.5 rounded-lg px-2 text-foreground hover:bg-muted"
                          >
                            <Bot className="size-4 shrink-0 text-primary" />
                            <span className="max-w-32 truncate text-sm font-medium sm:max-w-48">
                              {activeAssistant.name}
                            </span>
                            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                          </Button>
                        </MorphPopoverTrigger>
                        <MorphPopoverContent
                          side="bottom"
                          align="start"
                          sideOffset={6}
                          className="z-50 w-72 max-w-[calc(100vw-2rem)] p-1.5"
                        >
                          <div className="max-h-72 space-y-0.5 overflow-y-auto overscroll-contain">
                            {sortedAssistants.map((assistant) => {
                              const current =
                                assistant.id === activeAssistant.id;
                              return (
                                <button
                                  key={assistant.id}
                                  type="button"
                                  onClick={() => {
                                    setSwitcherOpen(false);
                                    if (draftMode) {
                                      setDraftAssistantId(assistant.id);
                                      window.history.replaceState(
                                        window.history.state,
                                        "",
                                        chatHref(
                                          slug,
                                          assistant.id,
                                          undefined,
                                          {
                                            isNew: true,
                                          },
                                        ),
                                      );
                                      requestAnimationFrame(() =>
                                        draftTextareaRef.current?.focus(),
                                      );
                                    } else {
                                      setDraftAssistantId(null);
                                      router.push(chatHref(slug, assistant.id));
                                    }
                                  }}
                                  className={cn(
                                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70",
                                    current && "bg-muted/80 font-medium",
                                  )}
                                >
                                  <Bot className="size-4 shrink-0 text-muted-foreground" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-foreground">
                                      {assistant.name}
                                    </div>
                                    {assistant.model ? (
                                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                                        {assistant.model}
                                      </div>
                                    ) : null}
                                  </div>
                                  {current ? (
                                    <Check className="size-4 shrink-0 text-primary" />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                          <div className="my-1 h-px bg-border" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSwitcherOpen(false);
                              setEditing("new");
                            }}
                            className="w-full justify-start gap-2 rounded-lg text-sm"
                          >
                            <Plus className="size-4" />
                            <span>{t("newAssistant")}</span>
                          </Button>
                        </MorphPopoverContent>
                      </MorphPopover>
                      <Button
                        type="button"
                        onClick={() => setEditing(activeAssistant)}
                        aria-label={`${t("settings")}: ${activeAssistant.name}`}
                        title={t("settings")}
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Settings2 className="size-4" />
                      </Button>
                      {activeThread ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="hidden text-muted-foreground/40 sm:inline"
                          >
                            /
                          </span>
                          {inlineThreadTitle !== null ? (
                            <input
                              ref={inlineRenameInputRef}
                              type="text"
                              maxLength={200}
                              aria-label={t("renameThread")}
                              value={inlineThreadTitle}
                              onChange={(event) =>
                                setInlineThreadTitle(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setInlineThreadTitle(null);
                                  return;
                                }
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  const next = inlineThreadTitle;
                                  setInlineThreadTitle(null);
                                  void renameThread(activeThread.id, next);
                                }
                              }}
                              onBlur={() => {
                                const next = inlineThreadTitle;
                                setInlineThreadTitle(null);
                                if (
                                  next &&
                                  next.trim() !== (activeThread.title ?? "")
                                ) {
                                  void renameThread(activeThread.id, next);
                                }
                              }}
                              className="h-7 min-w-0 max-w-56 rounded-md border border-primary/50 bg-background px-2 text-sm text-foreground outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setInlineThreadTitle(activeThread.title || "")
                              }
                              title={t("renameThread")}
                              className="hidden max-w-56 truncate rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground sm:block"
                            >
                              {activeThread.title || t("newChat")}
                            </button>
                          )}
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {activeThread &&
                activeThread.id === selectedThreadId &&
                branch ? (
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
                    variant="ghost"
                    size={branch.branchCount > 1 ? "sm" : "icon"}
                    className={cn(
                      "flex shrink-0 items-center justify-center gap-1.5 rounded-lg",
                      branchOpen &&
                        "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                    )}
                  >
                    <GitBranch className="size-[17px]" />
                    {branch.branchCount > 1 ? (
                      <span className="text-xs font-medium tabular-nums">
                        {branch.branchCount}
                      </span>
                    ) : null}
                  </Button>
                ) : null}
              </header>
              {error ? (
                <p
                  role="alert"
                  className="mx-auto mt-3 w-[calc(100%-2rem)] max-w-3xl rounded-2xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                >
                  {error === STORAGE_QUOTA_EXCEEDED
                    ? agentsT("attachmentStorageQuotaExceeded")
                    : error}
                  {activeAssistant && error === t("revisionRequired") ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2 h-auto px-2 py-1 text-xs underline underline-offset-4"
                      onClick={() => setEditing(activeAssistant)}
                    >
                      {t("settings")}
                    </Button>
                  ) : null}
                </p>
              ) : null}

              {activeAssistant && activeThread ? (
                <AssistantConversation
                  key={`${activeThread.id}:${activeThread.id === selectedThreadId ? (branch?.activeMessageId ?? "root") : "root"}`}
                  threadId={activeThread.id}
                  draftText={composerDrafts[activeThread.id] ?? ""}
                  onDraftTextChange={(text) =>
                    setComposerDrafts((previous) => ({
                      ...previous,
                      [activeThread.id]:
                        typeof text === "function"
                          ? text(previous[activeThread.id] ?? "")
                          : text,
                    }))
                  }
                  revision={activeAssistant.revision}
                  pinnedRevision={activeThread.revision}
                  assistantName={activeAssistant.name}
                  assistantDescription={activeAssistant.description}
                  mcpToolChanges={
                    activeThread.revision === activeAssistant.revision
                      ? activeAssistant.mcpToolChanges
                      : undefined
                  }
                  providers={providers}
                  defaultModelSelection={
                    activeThread.id === selectedThreadId
                      ? defaultModelSelection
                      : draftDefaultModel
                  }
                  modelSelection={composerModels[activeThread.id] ?? null}
                  onModelChange={(selection) =>
                    setComposerModels((previous) => ({
                      ...previous,
                      [activeThread.id]: selection,
                    }))
                  }
                  defaultReasoningEffort={
                    activeThread.id === selectedThreadId
                      ? defaultReasoningEffort
                      : activeAssistant.reasoningEffort
                  }
                  attachmentUploadUrl={`/api/v1/workspaces/${workspaceId}/attachments`}
                  readOnly={activeThread.legacyRevisionUnresolved === true}
                  initialMessages={
                    activeThread.id === selectedThreadId
                      ? initialMessages
                      : EMPTY_INITIAL_MESSAGES
                  }
                  branchNavigation={
                    activeThread.id === selectedThreadId
                      ? (branch?.navigation ?? EMPTY_BRANCH_NAVIGATION)
                      : EMPTY_BRANCH_NAVIGATION
                  }
                  branchBusy={branchBusy}
                  onSwitchBranch={(messageId) => void switchBranch(messageId)}
                  initialAutoSubmit={
                    pendingFirstTurn?.threadId === activeThread.id
                      ? pendingFirstTurn
                      : null
                  }
                  onAutoSubmitConsumed={(key) =>
                    setPendingFirstTurn((current) =>
                      current?.key === key ? null : current,
                    )
                  }
                  onConversationChanged={refreshChat}
                  onStartBranch={(messageId) => void startBranch(messageId)}
                  onThreadUpgraded={refreshChat}
                />
              ) : !assistants.length && !hasProviders ? (
                <div className="m-auto w-full max-w-xl px-6 pb-16">
                  <ModelProviderNotice slug={slug} />
                </div>
              ) : activeAssistant ? (
                <div
                  {...draftDrop.dropProps}
                  className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                  <ComposerDropOverlay
                    dragging={draftDrop.dragging}
                    label={t("dropFilesToAttach")}
                  />
                  <div className="mx-auto mt-auto w-full max-w-3xl px-4 pb-6 pt-10 text-center sm:px-6">
                    <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-muted text-foreground">
                      <Bot className="size-7" strokeWidth={1.5} />
                    </div>
                    <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
                      {activeAssistant.name}
                    </h2>
                    {activeAssistant.description ? (
                      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                        {activeAssistant.description}
                      </p>
                    ) : null}
                    {activeAssistant.model ||
                    activeAssistant.deploymentIds.length > 0 ? (
                      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
                        {activeAssistant.model ? (
                          <span className="rounded-full border border-border bg-muted/50 px-3 py-1 font-mono">
                            {activeAssistant.model}
                          </span>
                        ) : null}
                        {activeAssistant.deploymentIds.length > 0 ? (
                          <span className="rounded-full border border-border bg-muted/50 px-3 py-1">
                            {t("connectedMcps", {
                              count: activeAssistant.deploymentIds.length,
                            })}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {activeAssistant.mcpToolChanges ? (
                      <McpToolsUpdatedNote
                        {...activeAssistant.mcpToolChanges}
                      />
                    ) : null}
                  </div>
                  <div
                    data-ui="chat.composer"
                    className={cn(
                      conversationComposerDockClassName,
                      "mb-[min(18dvh,9rem)] before:hidden",
                    )}
                  >
                    <div
                      className={cn(
                        "grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]",
                        conversationComposerSurfaceClassName,
                      )}
                    >
                      <div className="order-3 flex min-w-0 items-center gap-1 px-2.5 pb-1 pt-1 text-muted-foreground sm:col-start-1 sm:pb-2.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 rounded-full"
                          aria-label={agentsT("addAttachment")}
                          title={agentsT("addAttachment")}
                          disabled={busy || draftUploading}
                          onClick={() =>
                            draftAttachmentInputRef.current?.click()
                          }
                        >
                          {draftUploading ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Paperclip className="size-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "size-8 rounded-full",
                            draftWebSearch &&
                              "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                          )}
                          aria-label={agentsT("enableWebSearch")}
                          aria-pressed={draftWebSearch}
                          title={agentsT("enableWebSearch")}
                          disabled={busy}
                          onClick={() => setDraftWebSearch((value) => !value)}
                        >
                          <Globe className="size-4" />
                        </Button>
                      </div>
                      {draftFiles.map((file) => (
                        <Button
                          key={file.url}
                          size="sm"
                          variant="ghost"
                          className="order-1 col-span-full mx-4 mt-3 max-w-[calc(100%-2rem)] justify-self-start gap-2 rounded-full bg-muted/50 text-xs"
                          aria-label={agentsT("removeAttachment", {
                            name: file.filename ?? file.mediaType,
                          })}
                          onClick={() =>
                            setDraftFiles((previous) =>
                              previous.filter((item) => item.url !== file.url),
                            )
                          }
                        >
                          <span className="truncate">
                            {file.filename ?? file.mediaType}
                          </span>
                          <X className="size-3 shrink-0" aria-hidden="true" />
                        </Button>
                      ))}
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitDraftStart();
                        }}
                        className="contents"
                      >
                        <textarea
                          ref={draftTextareaRef}
                          aria-label={t("sendMessage")}
                          value={draftText}
                          placeholder={t("sendMessage")}
                          onPaste={draftDrop.handlePaste}
                          onChange={(event) => setDraftText(event.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing &&
                              event.keyCode !== 229
                            ) {
                              event.preventDefault();
                              event.currentTarget.form?.requestSubmit();
                            }
                          }}
                          rows={1}
                          className="scrollbar-hide order-2 col-span-full block max-h-[35vh] min-h-12 w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/55 disabled:opacity-60"
                        />
                        <div className="order-4 flex min-h-9 flex-wrap items-center justify-end gap-1 self-end px-2.5 pb-2.5 pt-1 sm:order-3 sm:col-start-2 sm:pl-1">
                          <ComposerModelSelect
                            providers={providers}
                            defaultSelection={draftDefaultModel}
                            value={draftModelSelection}
                            onChange={(selection) =>
                              setComposerModels((previous) => ({
                                ...previous,
                                [`draft:${activeAssistant.id}`]: selection,
                              }))
                            }
                          />
                          {draftReasoningAvailable ? (
                            <ReasoningEffortControl
                              value={draftReasoningEffort}
                              inherited={activeAssistant.reasoningEffort}
                              disabled={busy}
                              onChange={setDraftReasoningEffort}
                            />
                          ) : null}
                          <Button
                            type="submit"
                            size="icon"
                            className="size-9 rounded-full"
                            aria-label={t("sendMessage")}
                            title={t("sendMessage")}
                            disabled={
                              busy ||
                              draftUploading ||
                              (!draftText.trim() && !draftFiles.length)
                            }
                          >
                            {busy ? (
                              <Loader2
                                className="size-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowUp className="size-4" aria-hidden="true" />
                            )}
                          </Button>
                        </div>
                      </form>
                    </div>
                  </div>
                  <input
                    ref={draftAttachmentInputRef}
                    type="file"
                    multiple
                    aria-label={agentsT("addAttachment")}
                    aria-hidden="true"
                    tabIndex={-1}
                    disabled={busy || draftUploading}
                    onChange={(event) => {
                      void uploadDraftFiles(event.target.files);
                      event.target.value = "";
                    }}
                    className="hidden"
                  />
                </div>
              ) : (
                <div className="m-auto w-full max-w-xl px-6 pb-16 text-center">
                  <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-muted text-foreground">
                    <Bot className="size-7" strokeWidth={1.5} />
                  </div>
                  <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
                    {t("emptyTitle")}
                  </h2>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                    {t("emptyDescription")}
                  </p>
                  <Button
                    type="button"
                    onClick={() => setEditing("new")}
                    variant={"primary"}
                    size={"sm"}
                    className="mt-6 gap-2 rounded-full px-5"
                    disabled={busy}
                  >
                    <Plus className="size-4" />
                    {t("newAssistant")}
                  </Button>
                </div>
              )}
            </section>
          </AnimatedSidebarInset>

          {branchOpen && !branchMaximized && activeThread && branch ? (
            <aside className="hidden w-80 shrink-0 min-h-0 flex-col overflow-hidden border-l border-border/60 bg-muted/15 xl:flex">
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

      <SidebarGroupDialog
        initialName={threadRenameTarget?.name ?? ""}
        open={Boolean(threadRenameTarget)}
        title={t("renameThread")}
        nameLabel={t("threadTitlePlaceholder")}
        placeholder={t("threadTitlePlaceholder")}
        cancelLabel={common("cancel")}
        submitLabel={common("save")}
        onClose={() => setThreadRenameTarget(null)}
        onSubmit={(name) => {
          if (!threadRenameTarget) return;
          const id = threadRenameTarget.id;
          setThreadRenameTarget(null);
          void renameThread(id, name);
        }}
      />

      <ConfirmActionDialog
        open={Boolean(confirmDialog)}
        destructive
        busy={confirmBusy}
        title={
          confirmDialog?.kind === "thread"
            ? t("deleteThread")
            : confirmDialog?.kind === "assistant"
              ? common("delete")
              : t("deleteGroup")
        }
        description={
          confirmDialog?.kind === "thread"
            ? t("deleteThreadConfirm")
            : confirmDialog?.kind === "assistant"
              ? t("deleteAssistantConfirm")
              : confirmDialog?.kind === "group"
                ? t("deleteGroupConfirm", { name: confirmDialog.name })
                : ""
        }
        confirmLabel={common("delete")}
        cancelLabel={common("cancel")}
        onClose={() => setConfirmDialog(null)}
        onConfirm={executeConfirmDialog}
      />

      {editing ? (
        <AssistantEditor
          key={editing === "new" ? "new" : editing.id}
          assistant={editing === "new" ? null : editing}
          deployments={deployments}
          onClose={() => setEditing(null)}
          onDelete={deleteAssistant}
          onSaved={assistantSaved}
          open
          providers={providers}
          slug={slug}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}
