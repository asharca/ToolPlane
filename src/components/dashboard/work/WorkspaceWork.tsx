"use client";
import { useAgentUiLabels } from "../agent-ui-labels";
import { ModelProviderNotice } from "@/components/dashboard/ModelProviderNotice";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Bot,
  Boxes,
  Check,
  ChevronDown,
  FileOutput,
  PanelLeft,
  Plus,
  Settings2,
  SquarePen,
} from "lucide-react";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  ScrollToBottomButton,
  hasOpenDialog,
} from "@/components/dashboard/ConversationUxPrimitives";
import { cn } from "@/lib/utils";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import {
  ManageFilesButton,
  STORAGE_QUOTA_EXCEEDED,
} from "@/components/dashboard/ManageFilesButton";
import {
  ChatApp,
  ChatAppSidebarTrigger,
} from "@/components/dashboard/chat/ChatApp";
import { AnimatedSidebarInset } from "@/components/motion/animated-sidebar";
import { AgentConversation } from "@/components/dashboard/agents/AgentConversation";
import {
  RevisionUpgradeNotice,
  McpToolsUpdatedNote,
} from "@/components/dashboard/RevisionUpgradeNotice";
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import {
  ConversationContextUsage,
  conversationComposerDockClassName,
} from "@/components/dashboard/ConversationComposer";
import { WorkComposer } from "./WorkComposer";
import { ConversationExecution } from "./ConversationExecution";
import { useLiveTaskOutput } from "./useLiveTaskOutput";
import { LiveOutputStatus, LiveOutputView } from "./LiveOutputView";
import {
  AgentMessageQueueView,
  useAgentMessageQueue,
} from "@/components/dashboard/AgentMessageQueue";
import { A2AContextView, useA2AContexts } from "./A2AContextView";
import { useWorkCompletionNotification } from "./useWorkCompletionNotification";
import {
  ComposerModelSelect,
  type ModelProviderOption,
} from "@/components/dashboard/ComposerModelSelect";
import { HookActivitySchema } from "../agents/HookActivity";
import { MessageScroller } from "@/components/agents/message-scroller";
import { resolveContextUsage } from "@/lib/context-usage";
import { workFailures, type WorkFailureCode } from "@/lib/work/failures";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";

function resolveWorkFailureCode(
  message: string | null | undefined,
): WorkFailureCode | null {
  if (!message) return null;
  if (workFailures.is(message)) return message;
  return (
    workFailures.codes.find((code) => workFailures.text(code) === message) ??
    null
  );
}
import { SubagentConversationScope } from "../agents/SubagentActivity";
import {
  activeConversationMessages,
  messageCompaction,
} from "@/lib/agents/conversation-context";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
} from "@/lib/agents/runtime-commands";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { usePersistentBoolean } from "@/lib/use-persistent-boolean";
import { workSidebarCookieName } from "@/lib/sidebar-preferences";
import {
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  sortSidebarItems,
  type SidebarGroupPreferences,
} from "@/lib/sidebar-groups";
import { apiRequest } from "@/lib/client/api";
import { WorkTranscript } from "./WorkTranscript";
import { WorkSidebar, useWorkSidebarPreferences } from "./WorkSidebar";
import {
  WorkspacePanels,
  WorkspacePanelToggles,
  useWorkspacePanels,
} from "./WorkspacePanels";
import { useWorkComposer } from "./useWorkComposer";
import { useWorkSessionStream } from "./useWorkSessionStream";
import {
  ACTIVE_STATUSES,
  MESSAGEABLE_STATUSES,
  agentSettingsHref,
  workHref,
  type ConversationDetail,
  type ConversationSummary,
  type WorkAgent,
  type WorkItem,
} from "./work-types";

const EMPTY_EXPANDED_AGENTS: Record<string, boolean> = {};

export function WorkspaceWork({
  slug,
  workspaceId,
  agents,
  providers,
  sessions,
  selectedWorkSessionId,
  selectedSession,
  requestedAgentId,
  requestedA2ATaskId,
  conversations = [],
  selectedConversation = null,
  hasChannels = false,
  hasTriggers = false,
  initialExpandedAgents = EMPTY_EXPANDED_AGENTS,
  initialGroupPreferences = EMPTY_SIDEBAR_GROUP_PREFERENCES,
  initialSidebarOpen = true,
}: {
  slug: string;
  workspaceId: string;
  agents: WorkAgent[];
  providers: ModelProviderOption[];
  sessions: WorkItem[];
  selectedWorkSessionId: string | null;
  selectedSession?: WorkItem | null;
  requestedAgentId?: string;
  requestedA2ATaskId?: string;
  conversations?: ConversationSummary[];
  selectedConversation?: ConversationDetail | null;
  hasChannels?: boolean;
  hasTriggers?: boolean;
  initialExpandedAgents?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
}) {
  const t = useTranslations("console.work");
  const agentUi = useAgentUiLabels();
  const tAgents = useTranslations("console.agents");
  const composerT = useTranslations("console.workComposer");
  const tChannels = useTranslations("console.agentMessaging");
  const router = useRouter();
  const { control: completionNotificationControl, notifyCompletion } =
    useWorkCompletionNotification(workspaceId, slug);
  const sidebarPreferences = useWorkSidebarPreferences(
    workspaceId,
    initialExpandedAgents,
    initialGroupPreferences,
  );
  const initialSelected =
    selectedSession ??
    sessions.find((item) => item.id === selectedWorkSessionId) ??
    null;
  const workAgents = agents.filter((item) => item.supportsWork);
  const [items, setItems] = useState(sessions);
  const deletedWorkSessionIds = useRef(new Set<string>());
  // Server lists are authoritative after navigation/refresh; optimistic
  // entries survive until the server returns them.
  const [syncedSessions, setSyncedSessions] = useState(sessions);
  if (syncedSessions !== sessions) {
    setSyncedSessions(sessions);
    setItems((current) => {
      const known = new Set(sessions.map((item) => item.id));
      return [
        ...current.filter((item) => item.optimistic && !known.has(item.id)),
        ...sessions.filter(
          (item) => !deletedWorkSessionIds.current.has(item.id),
        ),
      ];
    });
  }
  const [liveSelected, setLiveSelected] = useState<WorkItem | null>(null);
  const selectionKey = requestedA2ATaskId
    ? `a2a:${requestedAgentId ?? ""}:${requestedA2ATaskId}`
    : (selectedConversation?.id ?? selectedWorkSessionId);
  const [draftSelectionKey, setDraftSelectionKey] = useState<string | null>(
    null,
  );
  if (draftSelectionKey && draftSelectionKey !== selectionKey)
    setDraftSelectionKey(null);
  const creatingMode = !selectionKey || draftSelectionKey === selectionKey;
  const viewingA2A = Boolean(!creatingMode && requestedA2ATaskId);
  const conversation = creatingMode || viewingA2A ? null : selectedConversation;
  const [conversationBusy, setConversationBusy] = useState(false);
  const [mobilePane, setMobilePane] = useState<"sessions" | "work">("work");
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:work-sidebar:${workspaceId}`,
    initialSidebarOpen,
    workSidebarCookieName(workspaceId),
  );
  const selected =
    creatingMode || conversation || viewingA2A
      ? null
      : liveSelected?.id === selectedWorkSessionId
        ? liveSelected
        : initialSelected;
  const initialAgentId =
    selectedConversation?.agentId ??
    initialSelected?.agentId ??
    workAgents.find((item) => item.id === requestedAgentId)?.id ??
    workAgents[0]?.id ??
    "";
  const [agentId, setAgentId] = useState(initialAgentId);
  const [sandboxId, setSandboxId] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState(
    initialSelected?.workingDirectory ?? ".",
  );
  const [belowEditorElement, setBelowEditorElement] =
    useState<HTMLDivElement | null>(null);
  const [followingOutput, setFollowingOutput] = useState(true);
  const agent = useMemo(
    () => agents.find((item) => item.id === agentId) ?? null,
    [agents, agentId],
  );
  const selectedAgent = viewingA2A
    ? (agents.find((item) => item.id === (requestedAgentId ?? agentId)) ?? null)
    : selected || conversation
      ? (agents.find(
          (item) => item.id === (conversation?.agentId ?? selected?.agentId),
        ) ?? null)
      : null;
  const sandboxOptions = agent?.sandboxes ?? [];
  const activeSandboxId =
    sandboxId ||
    sandboxOptions.find((item) => item.isDefault)?.id ||
    sandboxOptions[0]?.id ||
    "";
  const activeSandbox =
    sandboxOptions.find((item) => item.id === activeSandboxId) ?? null;
  const controlAgent = selectedAgent ?? agent;
  const controlSandbox = conversation
    ? (conversation.sandbox ?? null)
    : selected
      ? selected.sandbox
      : null;
  const conversationWorkspace = Boolean(conversation || selected);
  const workspacePending =
    controlSandbox &&
    ["copying", "provisioning"].includes(controlSandbox.status ?? "");
  const workspaceUnavailableLabel =
    conversationWorkspace && !controlSandbox
      ? t("conversationWorkspaceNotCreated")
      : workspacePending
        ? t("conversationWorkspaceProvisioning")
        : t("noSandbox");
  // Turn choices follow the conversation; its sandbox identity arrives after creation.
  const conversationScope = `${controlAgent?.id}:${selected?.id ?? conversation?.id ?? "new"}`;
  const composerScope = `${controlAgent?.id}:${controlSandbox?.id}:${selected?.id ?? conversation?.id ?? "new"}`;
  const commandRuntimeKind = conversation
    ? (conversation.runtimeKind ?? "")
    : selected
      ? selected.runtimeKind
      : (controlAgent?.runtimeKind ?? "");
  const sessionReadOnly = viewingA2A
    ? true
    : conversation
      ? conversation.readOnly ||
        !isExecutableAgentRuntimeKind(conversation.runtimeKind)
      : selected
        ? selected.readOnly !== false ||
          !isExecutableAgentRuntimeKind(selected.runtimeKind)
        : !isExecutableAgentRuntimeKind(controlAgent?.runtimeKind);
  // Channel execution remains read-only here; native dialogs use their own authorization.
  const channelConversation = Boolean(conversation?.source);
  const observingConversation = Boolean(
    conversation &&
      isExecutableAgentRuntimeKind(conversation.runtimeKind) &&
      (channelConversation || sessionReadOnly),
  );
  const approvalConversationBase = conversation
    ? `/api/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversation.id)}`
    : selected?.conversationId
      ? `/api/v1/agents/${encodeURIComponent(selected.agentId)}/conversations/${encodeURIComponent(selected.conversationId)}`
      : null;
  const conversationLive = useLiveTaskOutput({
    // Conversation events currently exclude WorkSession-backed conversations.
    // Work approvals recover from the authenticated Work native UI projection.
    url:
      conversation && approvalConversationBase
        ? `${approvalConversationBase}/events`
        : null,
    onSettled: () => router.refresh(),
    onTranscriptChange: () => router.refresh(),
    onRevoked: () => router.refresh(),
  });
  const approvalParts =
    conversation && conversationLive.connection === "revoked"
      ? []
      : conversation && conversationLive.connection === "live"
        ? conversationLive.dataParts
        : null;
  const approvalEndpoint =
    approvalConversationBase &&
    (!conversation || conversationLive.connection !== "revoked")
      ? `${approvalConversationBase}/tool-approvals`
      : undefined;
  const conversationOutput = observingConversation
    ? conversationLive.output
    : null;
  const conversationOutputPersisted = Boolean(
    conversationOutput &&
      !conversationOutput.active &&
      conversation?.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === "data-agent-task" &&
            part.data &&
            typeof part.data === "object" &&
            "taskId" in part.data &&
            part.data.taskId === conversationOutput.taskId &&
            (conversationOutput.startedAt === undefined ||
              ("startedAt" in part.data &&
                part.data.startedAt === conversationOutput.startedAt)),
        ),
      ),
  );
  const conversationAccessRevoked =
    observingConversation && conversationLive.connection === "revoked";
  const observedTaskId = conversationOutput?.taskId;
  const observedStartedAt = conversationOutput?.startedAt;
  useEffect(() => {
    // Pick up the incoming channel message once per turn, not once per token.
    if (observedTaskId && observedStartedAt !== undefined) router.refresh();
  }, [observedTaskId, observedStartedAt, router]);
  const unappliedDraft = Boolean(
    !viewingA2A &&
      !selected &&
      !conversation &&
      isExecutableAgentRuntimeKind(agent?.runtimeKind) &&
      agent?.currentRevisionVersion === 0,
  );
  const commands = sessionReadOnly
    ? []
    : sessionRuntimeCommands(commandRuntimeKind, selected?.messages ?? []);
  const conversationWorkspaceApiBase = conversation
    ? `/api/v1/agents/${conversation.agentId}/conversations/${conversation.id}/sandbox`
    : undefined;
  const workspaceRpcApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/rpc`
    : conversationWorkspaceApiBase
      ? `${conversationWorkspaceApiBase}/rpc`
      : undefined;
  const workspaceTerminalApiBase = selected
    ? `/api/v1/work-sessions/${selected.id}/sandbox/terminal`
    : conversationWorkspaceApiBase
      ? `${conversationWorkspaceApiBase}/terminal`
      : undefined;
  const activeWorkingDirectory = conversation
    ? "."
    : (selected?.workingDirectory ?? workingDirectory);
  const workReturnTo = viewingA2A
    ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(requestedAgentId ?? agentId)}&a2a=${encodeURIComponent(requestedA2ATaskId ?? "")}`
    : conversation
      ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(conversation.agentId)}&c=${encodeURIComponent(conversation.id)}`
      : selected
        ? workHref(slug, selected.id)
        : `/app/${encodeURIComponent(slug)}/work`;
  const selectedStatus = selected?.status;
  const selectedActive = Boolean(
    selectedStatus && ACTIVE_STATUSES.has(selectedStatus),
  );
  const activeAgentId = viewingA2A
    ? (requestedAgentId ?? agentId)
    : (conversation?.agentId ?? selected?.agentId ?? agentId);
  const a2a = useA2AContexts(
    slug,
    agents
      .filter(
        (item) =>
          item.id === activeAgentId ||
          (sidebarPreferences.expandedAgents[item.id] ??
            conversations.some((entry) => entry.agentId === item.id)),
      )
      .map((item) => item.id),
    viewingA2A ? activeAgentId : undefined,
    viewingA2A ? requestedA2ATaskId : undefined,
  );
  const activeResourceId =
    viewingA2A && a2a.context
      ? `a2a:${a2a.context.contextId}`
      : conversation
        ? `conversation:${conversation.id}`
        : selected
          ? `session:${selected.id}`
          : null;
  const activeResourceIdRef = useRef(activeResourceId);
  activeResourceIdRef.current = activeResourceId;

  const refreshSelected = useCallback(async () => {
    if (!selectedWorkSessionId || creatingMode) return false;
    const result = await apiRequest<WorkItem>(
      `/api/v1/work-sessions/${selectedWorkSessionId}`,
      { cache: "no-store" },
    );
    if (!result.ok || !result.data) return false;
    const next: WorkItem = {
      ...result.data,
      artifacts: Array.isArray(result.data.artifacts)
        ? result.data.artifacts.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    };
    setLiveSelected(next);
    setItems((current) =>
      current.map((item) => (item.id === next.id ? next : item)),
    );
    return true;
  }, [creatingMode, selectedWorkSessionId]);

  const messageQueue = useAgentMessageQueue({
    agentId: selected?.agentId,
    conversationId: selected?.conversationId,
    active: selectedActive,
    onRefresh: () => {
      void refreshSelected();
    },
  });
  const stream = useWorkSessionStream({
    selectedWorkSessionId,
    selectedStatus,
    creatingMode,
    selectedActive,
    refreshSelected,
    notifyCompletion,
    observeMessageQueue: messageQueue.observe,
  });
  const running = Boolean(selected && ACTIVE_STATUSES.has(selected.status));
  const canSend =
    !sessionReadOnly &&
    !unappliedDraft &&
    (selected
      ? MESSAGEABLE_STATUSES.has(selected.status)
      : Boolean(
          agent?.ready && isExecutableAgentRuntimeKind(agent.runtimeKind),
        ));
  const describeRuntimeError = useRuntimeErrorText();
  const composer = useWorkComposer({
    slug,
    workspaceId,
    providers,
    agent,
    agentId,
    controlAgent,
    activeSandboxId,
    workingDirectory,
    selected,
    conversation,
    sessionReadOnly,
    selectedActive,
    running,
    canSend,
    commandRuntimeKind,
    commands,
    conversationScope,
    composerScope,
    messageQueue,
    activeResourceIdRef,
    describeRuntimeError,
    refreshSelected,
    setItems,
    setLiveSelected,
    setFollowingOutput,
    setDraftSelectionKey,
    resetStream: stream.resetStream,
  });
  const panels = useWorkspacePanels({ slug, controlSandbox, composerScope });
  const { busy, composerPending } = composer;
  const localCommand = Boolean(
    parseRuntimeCommand(composer.draft, commandRuntimeKind),
  );
  const errorMessage = composer.error ?? selected?.error;
  const runtimeError = describeRuntimeError(errorMessage);
  const storageQuotaExceeded = errorMessage === STORAGE_QUOTA_EXCEEDED;
  const workFailureCode = resolveWorkFailureCode(errorMessage);
  const visibleError =
    errorMessage === "WORK_AGENT_REFERENCE_FORBIDDEN"
      ? composerT("agentReferenceForbidden")
      : errorMessage === "Invalid references"
        ? composerT("referenceFailed")
        : storageQuotaExceeded
          ? tAgents("attachmentStorageQuotaExceeded")
          : workFailureCode
            ? t(`failures.${workFailureCode}`)
            : errorMessage;
  const configurationError = /no configured model/i.test(visibleError ?? "");
  const lastUserMessage = (
    conversation?.messages ??
    selected?.messages ??
    []
  ).findLast((message) => message.role === "user");
  const retryableMessageId =
    selected &&
    selected.status === "failed" &&
    !sessionReadOnly &&
    selected.runtimeKind === "pi-sdk" &&
    !selectedActive &&
    !busy &&
    !composerPending &&
    !conversationAccessRevoked &&
    lastUserMessage?.piEntryId
      ? lastUserMessage.id
      : null;
  const showConfigurationNotice =
    !viewingA2A &&
    (configurationError ||
      (!selected && !conversation && agent && !agent.ready && !unappliedDraft));

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes reset the existing provisioning poll.
  useEffect(() => {
    if (
      selected ||
      observingConversation ||
      (!conversationBusy &&
        !["copying", "provisioning"].includes(controlSandbox?.status ?? ""))
    )
      return;
    const interval = window.setInterval(() => router.refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [
    controlSandbox?.status,
    conversationBusy,
    router,
    observingConversation,
    selected,
    conversation,
  ]);

  useEffect(() => {
    if ((!hasChannels && !hasTriggers) || conversation || conversationBusy)
      return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [hasChannels, hasTriggers, conversation, conversationBusy, router]);

  const sessionContextWindow =
    conversation?.contextWindow ?? selected?.contextWindow;
  const sessionModelName =
    conversation?.modelOverride?.model ??
    conversation?.modelName ??
    selected?.modelName;
  const sessionContextEstimated =
    conversation?.contextWindowEstimated ?? selected?.contextWindowEstimated;
  const renderedHookIds = useMemo(
    () =>
      (conversation?.messages ?? selected?.messages ?? []).flatMap((message) =>
        message.parts.flatMap((part) => {
          if (
            part.type !== "hook-activity" &&
            part.type !== "data-hook-activity"
          )
            return [];
          const parsed = HookActivitySchema.safeParse(part.data);
          return parsed.success ? [`native-hook:${parsed.data.id}`] : [];
        }),
      ),
    [conversation?.messages, selected?.messages],
  );
  const contextUsage = useMemo(
    () =>
      resolveContextUsage(
        activeConversationMessages(
          conversation?.messages ?? selected?.messages ?? [],
        ).map((message) => ({
          parts: Array.isArray(message.parts) ? message.parts : [],
        })),
        {
          maxTokens: sessionContextWindow,
          modelName: sessionModelName,
          context: stream.streamText,
          estimated: sessionContextEstimated,
        },
      ),
    [
      sessionContextWindow,
      sessionContextEstimated,
      sessionModelName,
      selected?.messages,
      conversation?.messages,
      stream.streamText,
    ],
  );

  useEffect(() => {
    if (!selected?.titlePending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshSelected();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [refreshSelected, selected?.titlePending]);

  function startNewWork(nextAgentId = agentId) {
    sidebarPreferences.revealAgent(nextAgentId);
    setAgentId(nextAgentId);
    setSandboxId("");
    setDraftSelectionKey(selectionKey);
    setMobilePane("work");
    composer.clearDraft();
    setWorkingDirectory(".");
    window.history.replaceState(
      window.history.state,
      "",
      `/app/${encodeURIComponent(slug)}/work`,
    );
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-ui="chat.composer"] textarea',
        )
        ?.focus(),
    );
  }

  const [agentSwitcherOpen, setAgentSwitcherOpen] = useState(false);
  const [sandboxSwitcherOpen, setSandboxSwitcherOpen] = useState(false);
  const sortedWorkAgents = useMemo(
    () =>
      sortSidebarItems(
        workAgents,
        sidebarPreferences.groupPreferences.entityOrder,
      ),
    [workAgents, sidebarPreferences.groupPreferences.entityOrder],
  );
  const switcherAgent = controlAgent ?? agent;
  const hasWorkspacePanel = Boolean(
    !viewingA2A && (controlSandbox || conversationWorkspace),
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || hasOpenDialog()) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        if (!switcherAgent && !workAgents.length) return;
        event.preventDefault();
        sidebarPreferences.revealAgent(
          switcherAgent?.id ?? workAgents[0]?.id ?? "",
        );
        setAgentId(switcherAgent?.id ?? workAgents[0]?.id ?? "");
        setSandboxId("");
        setDraftSelectionKey(selectionKey);
        setMobilePane("work");
        composer.clearDraft();
        setWorkingDirectory(".");
        window.history.replaceState(
          window.history.state,
          "",
          `/app/${encodeURIComponent(slug)}/work`,
        );
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLTextAreaElement>(
              '[data-ui="chat.composer"] textarea',
            )
            ?.focus(),
        );
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
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "j" &&
        hasWorkspacePanel
      ) {
        event.preventDefault();
        panels.togglePanel(panels.desktopPanel ?? "files");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    composer,
    hasWorkspacePanel,
    panels,
    selectionKey,
    setSidebarOpen,
    sidebarPreferences,
    slug,
    switcherAgent,
    workAgents,
  ]);

  /** After deleting the open Work session, show the Agent's next conversation. */
  function removeWorkSession(
    target: ConversationSummary & { workSessionId: string },
  ) {
    deletedWorkSessionIds.current.add(target.workSessionId);
    setItems((current) =>
      current.filter((item) => item.id !== target.workSessionId),
    );
    if (activeResourceIdRef.current !== `session:${target.workSessionId}`)
      return;
    const order =
      sidebarPreferences.groupPreferences.conversationOrder?.[target.agentId];
    const nextSession = sortSidebarItems(
      items.filter(
        (item) =>
          item.agentId === target.agentId && item.id !== target.workSessionId,
      ),
      order,
    )[0];
    const nextConversation = sortSidebarItems(
      conversations.filter((item) => item.agentId === target.agentId),
      order,
    )[0];
    const href = nextSession
      ? workHref(slug, nextSession.id)
      : nextConversation
        ? `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(target.agentId)}&c=${encodeURIComponent(nextConversation.id)}`
        : `/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(target.agentId)}`;
    router.replace(href, { scroll: false });
  }

  const activeFolderKey = channelConversation
    ? `channel:${activeAgentId}`
    : conversation?.triggerId
      ? `trigger:${activeAgentId}`
      : viewingA2A
        ? `a2a:${activeAgentId}`
        : null;

  return (
    <SubagentConversationScope.Provider
      value={{ slug, agentId: controlAgent?.id ?? agentId }}
    >
      <ChatApp
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        openMobile={mobilePane === "sessions"}
        onOpenMobileChange={(open) => setMobilePane(open ? "sessions" : "work")}
        className="relative flex h-full min-w-0"
      >
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <WorkSidebar
            slug={slug}
            agents={agents}
            items={items}
            conversations={conversations}
            a2aPages={a2a.pages}
            a2aContext={a2a.context}
            onLoadMoreA2A={a2a.loadMore}
            preferences={sidebarPreferences}
            activeAgentId={activeAgentId}
            activeResourceId={activeResourceId}
            activeFolderKey={activeFolderKey}
            selectedWorkSessionId={selectedWorkSessionId}
            conversationId={conversation?.id}
            workReturnTo={workReturnTo}
            onNewWork={startNewWork}
            onNavigate={() => {
              setDraftSelectionKey(null);
              setMobilePane("work");
            }}
            onWorkSessionDeleted={removeWorkSession}
          />

          <AnimatedSidebarInset className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <section
              aria-label={t("title")}
              className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
            >
              <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-background px-3 sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <ChatAppSidebarTrigger
                    openLabel={t("showSidebar")}
                    closeLabel={t("hideSidebar")}
                  >
                    <PanelLeft className="size-4" />
                  </ChatAppSidebarTrigger>
                  {switcherAgent || sortedWorkAgents.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        startNewWork(
                          switcherAgent?.id ?? sortedWorkAgents[0]?.id,
                        )
                      }
                      aria-label={t("newWork")}
                      title={t("shortcutNewWork")}
                      className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <SquarePen className="size-4" />
                    </Button>
                  ) : null}
                  {sortedWorkAgents.length > 0 && switcherAgent ? (
                    <MorphPopover
                      open={agentSwitcherOpen}
                      onOpenChange={setAgentSwitcherOpen}
                    >
                      <MorphPopoverTrigger>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t("switchAgent")}
                          className="h-8 min-w-0 gap-1.5 rounded-lg px-2 text-foreground hover:bg-muted"
                        >
                          <Bot className="size-4 shrink-0 text-primary" />
                          <span
                            aria-hidden="true"
                            title={
                              switcherAgent.ready
                                ? t("agentReady")
                                : t("agentNeedsSetup")
                            }
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              switcherAgent.ready
                                ? "bg-emerald-500"
                                : "bg-amber-500",
                            )}
                          />
                          <span className="sr-only">
                            {switcherAgent.ready
                              ? t("agentReady")
                              : t("agentNeedsSetup")}
                          </span>
                          <span className="max-w-32 truncate text-sm font-medium sm:max-w-48">
                            {switcherAgent.name}
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
                          {sortedWorkAgents.map((item) => {
                            const current = item.id === switcherAgent.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                  setAgentSwitcherOpen(false);
                                  startNewWork(item.id);
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70",
                                  current && "bg-muted/80 font-medium",
                                )}
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    item.ready
                                      ? "bg-emerald-500"
                                      : "bg-amber-500",
                                  )}
                                />
                                <span className="sr-only">
                                  {item.ready
                                    ? t("agentReady")
                                    : t("agentNeedsSetup")}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-foreground">
                                    {item.name}
                                  </div>
                                  {item.model ? (
                                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                                      {item.model}
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
                            setAgentSwitcherOpen(false);
                            router.push(
                              agentSettingsHref(
                                slug,
                                switcherAgent.id,
                                workReturnTo,
                              ),
                            );
                          }}
                          className="w-full justify-start gap-2 rounded-lg text-sm"
                        >
                          <Settings2 className="size-4" />
                          <span>{t("agentSettings")}</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setAgentSwitcherOpen(false);
                            router.push(
                              `/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(workReturnTo)}`,
                            );
                          }}
                          className="w-full justify-start gap-2 rounded-lg text-sm"
                        >
                          <Plus className="size-4" />
                          <span>{t("newAgent")}</span>
                        </Button>
                      </MorphPopoverContent>
                    </MorphPopover>
                  ) : switcherAgent ? (
                    <span className="truncate text-sm font-medium text-foreground">
                      {switcherAgent.name}
                    </span>
                  ) : null}
                  {viewingA2A || selected || conversation ? (
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="hidden text-muted-foreground/40 sm:inline"
                      >
                        /
                      </span>
                      <p className="truncate text-sm text-muted-foreground">
                        {viewingA2A
                          ? t("a2a.title")
                          : conversation?.title ||
                            selected?.title ||
                            selected?.task ||
                            t("untitledSession")}
                      </p>
                      {channelConversation && conversation?.modelOverride ? (
                        <span
                          className="max-w-48 truncate rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
                          title={
                            conversation.modelOverride.providerName ?? undefined
                          }
                        >
                          {tChannels("sessionModelOverride", {
                            model: conversation.modelOverride.model,
                          })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(controlSandbox ?? activeSandbox) ? (
                    <span
                      data-ui="work-header-sandbox"
                      className="hidden max-w-40 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground md:inline-flex"
                      title={(controlSandbox ?? activeSandbox)?.name}
                    >
                      <Boxes aria-hidden="true" className="size-3.5 shrink-0" />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          (controlSandbox ?? activeSandbox)?.running
                            ? "bg-emerald-500"
                            : "bg-muted-foreground/50",
                        )}
                      />
                      <span className="truncate">
                        {(controlSandbox ?? activeSandbox)?.name}
                      </span>
                    </span>
                  ) : null}
                  {completionNotificationControl}
                  {controlSandbox || conversationWorkspace ? (
                    <WorkspacePanelToggles
                      panels={panels}
                      readOnly={sessionReadOnly}
                    />
                  ) : null}
                </div>
              </header>
              {(selected || conversation) && sessionReadOnly ? (
                <p
                  role="status"
                  className="border-b border-border px-4 py-3 text-sm text-muted-foreground"
                >
                  {t("sessionHistoryReadOnly")}
                </p>
              ) : null}
              {selected &&
              !sessionReadOnly &&
              controlAgent &&
              selected.agentRevisionVersion &&
              controlAgent.currentRevisionVersion &&
              selected.agentRevisionVersion <
                controlAgent.currentRevisionVersion ? (
                <RevisionUpgradeNotice
                  url={`/api/v1/agents/${controlAgent.id}/conversations/${selected.conversationId}/revision`}
                  fromVersion={selected.agentRevisionVersion}
                  targetVersion={controlAgent.currentRevisionVersion}
                  disabled={selectedActive || Boolean(busy) || composerPending}
                  onUpgraded={() => {
                    void refreshSelected();
                    router.refresh();
                  }}
                />
              ) : null}
              {conversation &&
              channelConversation &&
              !sessionReadOnly &&
              controlAgent &&
              conversation.agentRevisionVersion &&
              controlAgent.currentRevisionVersion &&
              conversation.agentRevisionVersion <
                controlAgent.currentRevisionVersion ? (
                <RevisionUpgradeNotice
                  url={`/api/v1/agents/${conversation.agentId}/conversations/${conversation.id}/revision`}
                  fromVersion={conversation.agentRevisionVersion}
                  targetVersion={controlAgent.currentRevisionVersion}
                  disabled={
                    conversationBusy || Boolean(busy) || composerPending
                  }
                  onUpgraded={() => router.refresh()}
                />
              ) : null}

              {observingConversation ? (
                <div className="mx-auto w-full max-w-3xl px-4 py-2 sm:px-6">
                  <LiveOutputStatus connection={conversationLive.connection} />
                </div>
              ) : null}
              {viewingA2A ? (
                a2a.context ? (
                  <A2AContextView
                    key={`${slug}:${a2a.context.contextId}`}
                    slug={slug}
                    context={a2a.context}
                  />
                ) : (
                  <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 px-4 py-6 sm:px-6">
                    <p
                      role={
                        a2a.selectionStatus === "loading" ? "status" : "alert"
                      }
                      className="text-sm text-muted-foreground"
                    >
                      {t(
                        a2a.selectionStatus === "loading"
                          ? "a2a.loading"
                          : a2a.selectionStatus === "missing"
                            ? "a2a.unavailable"
                            : "a2a.loadFailed",
                      )}
                    </p>
                    {a2a.selectionStatus !== "loading" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={a2a.refreshSelection}
                      >
                        {t("executionRefresh")}
                      </Button>
                    ) : null}
                  </div>
                )
              ) : conversation &&
                !sessionReadOnly &&
                !channelConversation &&
                controlAgent ? (
                <AgentConversation
                  key={conversation.id}
                  activeConversationId={conversation.id}
                  agentId={controlAgent.id}
                  agentName={controlAgent.name}
                  settingsHref={agentSettingsHref(
                    slug,
                    controlAgent.id,
                    workReturnTo,
                  )}
                  composerNotice={(
                    setEditorText,
                    widgetTarget,
                    renderedActivityIds,
                  ) => (
                    <ConversationExecution
                      key={`${controlAgent.id}:${conversation.id}`}
                      endpoint={`/api/v1/agents/${encodeURIComponent(controlAgent.id)}/conversations/${encodeURIComponent(conversation.id)}/execution`}
                      toolApprovalEndpoint={approvalEndpoint}
                      toolApprovalParts={approvalParts}
                      showStatus={false}
                      showActivities={false}
                      active={conversationBusy}
                      onSetEditorText={setEditorText}
                      belowEditorElement={widgetTarget}
                      renderedActivityIds={renderedActivityIds}
                      className="mb-3"
                      onChange={() => router.refresh()}
                      onOpenScreen={
                        panels.hasScreen ? panels.openScreen : undefined
                      }
                      onTakeoverRequest={panels.openTakeoverScreen}
                      onTakeoverAnswered={panels.releaseScreenControl}
                    />
                  )}
                  ready={!sessionReadOnly}
                  runtimeKind={conversation.runtimeKind ?? null}
                  agentRevisionVersion={conversation.agentRevisionVersion}
                  currentRevisionVersion={controlAgent.currentRevisionVersion}
                  mcpToolsUpdated={controlAgent.mcpToolsUpdated}
                  modelName={conversation.modelName}
                  modelOverride={composer.modelChoice}
                  modelPicker={
                    <ComposerModelSelect
                      providers={providers}
                      defaultSelection={composer.defaultModelSelection}
                      value={composer.modelChoice}
                      onChange={composer.setModelChoice}
                    />
                  }
                  initialMessages={
                    conversation.messages.filter(
                      (message) => !messageCompaction(message),
                    ) as AgentUIMessage[]
                  }
                  initialReasoningEffort={
                    conversation.reasoningEffort ?? "default"
                  }
                  reasoningAvailable={composer.reasoningAvailable}
                  inheritedReasoningEffort={
                    controlAgent.reasoningEffort ?? null
                  }
                  creatingConversation={false}
                  ensureConversation={async () => conversation.id}
                  attachmentUploadUrl={`/api/v1/workspaces/${workspaceId}/attachments`}
                  mcpPromptApiPath={`/api/v1/agents/${controlAgent.id}/prompts`}
                  mcpResourceApiPath={`/api/v1/agents/${controlAgent.id}/composer`}
                  onBusyChange={setConversationBusy}
                  onConversationChanged={() => router.refresh()}
                />
              ) : (
                <MessageScroller
                  key={selected?.id ?? conversation?.id ?? "new"}
                  label={t("title")}
                  data-ui="work.transcript"
                  busy={selectedActive || Boolean(conversationOutput?.active)}
                  followOutput={followingOutput}
                  onFollowChange={setFollowingOutput}
                  navigation="rail"
                  labels={agentUi.scroller}
                  className={
                    selected || conversation
                      ? "min-h-0 flex-1"
                      : "mt-auto min-h-0 flex-none"
                  }
                >
                  {selected || conversation ? (
                    <>
                      <WorkTranscript
                        workspaceSlug={slug}
                        submitterName={selected?.a2aActor?.name ?? undefined}
                        treeActionsEnabled={Boolean(
                          selected &&
                            !sessionReadOnly &&
                            selected.runtimeKind === "pi-sdk",
                        )}
                        treeActionsDisabled={
                          selectedActive ||
                          Boolean(busy) ||
                          composerPending ||
                          !MESSAGEABLE_STATUSES.has(selected?.status ?? "")
                        }
                        treeActionPending={busy === "tree"}
                        onTreeAction={composer.mutateConversationTree}
                        agentName={controlAgent?.name ?? t("agent")}
                        agentId={conversation?.agentId ?? selected?.agentId}
                        conversationId={
                          conversation?.id ?? selected?.conversationId
                        }
                        modelName={
                          conversation?.modelOverride?.model ??
                          conversation?.modelName ??
                          selected?.modelName ??
                          null
                        }
                        messages={
                          conversationAccessRevoked
                            ? []
                            : (conversation?.messages ??
                              selected?.messages ??
                              [])
                        }
                        streamText={stream.streamText}
                        streamActivities={stream.streamActivities}
                        streamBudgetWarning={stream.streamBudgetWarning}
                        streamRuleTriggers={stream.streamRuleTriggers}
                        streamStartedAt={stream.streamStartedAt}
                        streamRuntimeKind={stream.streamRuntimeKind}
                        streamModelName={stream.streamModelName}
                        executionStage={stream.executionStage}
                        sessionStartedAt={selected?.startedAt}
                        sessionCompletedAt={selected?.completedAt}
                        streaming={selectedActive}
                      />
                      {observingConversation &&
                      !conversationAccessRevoked &&
                      conversationOutput &&
                      !conversationOutputPersisted ? (
                        <div className="mx-auto w-full max-w-3xl px-4 pb-8 sm:px-6">
                          <LiveOutputView output={conversationOutput} />
                        </div>
                      ) : null}
                      {selected?.artifacts.length ? (
                        <section className="mx-auto w-full max-w-3xl px-4 py-5">
                          <p className="flex items-center gap-2 text-xs font-semibold">
                            <FileOutput className="size-4" />
                            {t("artifacts")}
                          </p>
                          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                            {selected.artifacts.map((artifact) => (
                              <li key={artifact}>{artifact}</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex items-center justify-center px-6 pb-7 pt-10 text-center">
                      <div className="max-w-lg">
                        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground ring-1 ring-border/50">
                          <Bot className="size-6" />
                        </span>
                        {agent ? (
                          <p className="mt-4 text-sm font-medium text-muted-foreground">
                            {agent.name}
                          </p>
                        ) : null}
                        <h2 className="mt-2 text-2xl font-medium tracking-tight sm:text-3xl">
                          {t("emptyTitle")}
                        </h2>
                        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                          {agent?.description &&
                          agent.description.trim() !== agent.name.trim()
                            ? agent.description
                            : t("emptyDescription")}
                        </p>
                        {agent?.mcpToolsUpdated ? (
                          <McpToolsUpdatedNote {...agent.mcpToolsUpdated} />
                        ) : null}
                        {agent ? (
                          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
                            {sandboxOptions.length > 1 ? (
                              <MorphPopover
                                open={sandboxSwitcherOpen}
                                onOpenChange={setSandboxSwitcherOpen}
                              >
                                <MorphPopoverTrigger>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5 rounded-full px-3 text-xs font-normal"
                                  >
                                    <Boxes className="size-3.5 text-muted-foreground" />
                                    <span>
                                      {activeSandbox?.name ?? t("sandbox")}
                                    </span>
                                    <ChevronDown className="size-3 text-muted-foreground" />
                                  </Button>
                                </MorphPopoverTrigger>
                                <MorphPopoverContent
                                  side="bottom"
                                  align="start"
                                  sideOffset={4}
                                  className="z-50 w-60 p-1"
                                >
                                  {sandboxOptions.map((sb) => (
                                    <button
                                      key={sb.id}
                                      type="button"
                                      onClick={() => {
                                        setSandboxId(sb.id);
                                        setSandboxSwitcherOpen(false);
                                      }}
                                      className={cn(
                                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-muted/70",
                                        sb.id === activeSandboxId &&
                                          "bg-muted font-medium",
                                      )}
                                    >
                                      <span
                                        aria-hidden="true"
                                        className={cn(
                                          "size-1.5 shrink-0 rounded-full",
                                          sb.running
                                            ? "bg-emerald-500"
                                            : "bg-muted-foreground/50",
                                        )}
                                      />
                                      <span className="sr-only">
                                        {t(
                                          sb.running
                                            ? "statusRunning"
                                            : "statusWaiting",
                                        )}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-foreground">
                                        {sb.name}
                                      </span>
                                      {sb.id === activeSandboxId ? (
                                        <Check className="size-3.5 shrink-0 text-primary" />
                                      ) : null}
                                    </button>
                                  ))}
                                </MorphPopoverContent>
                              </MorphPopover>
                            ) : activeSandbox ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1">
                                <Boxes className="size-3.5" />
                                <span>{activeSandbox.name}</span>
                              </span>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                router.push(
                                  agentSettingsHref(
                                    slug,
                                    agent.id,
                                    workReturnTo,
                                  ),
                                )
                              }
                              className="h-7 gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
                            >
                              <Settings2 className="size-3.5" />
                              <span>{t("agentSettings")}</span>
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {visibleError && !configurationError ? (
                    <Alert
                      variant="destructive"
                      className="mx-auto my-4 w-[calc(100%_-_2rem)] max-w-[736px]"
                    >
                      <AlertIcon />
                      <AlertContent>
                        <AlertDescription>
                          {runtimeError ? runtimeError.text : visibleError}
                        </AlertDescription>
                      </AlertContent>
                      <AlertAction>
                        {runtimeError?.code === "PI_MCP_TOOLS_UNAVAILABLE" &&
                        controlAgent ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full"
                            onClick={() =>
                              router.push(
                                agentSettingsHref(
                                  slug,
                                  controlAgent.id,
                                  workReturnTo,
                                  "mcp",
                                ),
                              )
                            }
                          >
                            {tAgents("configureAgent")}
                          </Button>
                        ) : null}
                        {storageQuotaExceeded ? <ManageFilesButton /> : null}
                        {retryableMessageId ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full"
                            onClick={() =>
                              void composer.mutateConversationTree({
                                kind: "retry",
                                messageId: retryableMessageId,
                              })
                            }
                          >
                            {t("tree.retry")}
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full"
                          onClick={() => {
                            const params = new URLSearchParams({
                              category: "failure",
                            });
                            if (runtimeError?.code) {
                              params.set("failureCode", runtimeError.code);
                            }
                            if (selected?.id) {
                              params.set("workSessionId", selected.id);
                            }
                            if (conversation?.id) {
                              params.set("conversationId", conversation.id);
                            }
                            const targetAgentId = controlAgent?.id ?? agent?.id;
                            if (targetAgentId) {
                              params.set("agentId", targetAgentId);
                            }
                            router.push(
                              `/app/${encodeURIComponent(slug)}/feedback?${params.toString()}`,
                            );
                          }}
                        >
                          {t("reportThisIssue")}
                        </Button>
                      </AlertAction>
                    </Alert>
                  ) : null}
                </MessageScroller>
              )}
              {conversation &&
              channelConversation &&
              !conversationAccessRevoked ? (
                <ConversationExecution
                  key={`${conversation.agentId}:${conversation.id}`}
                  endpoint={`/api/v1/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversation.id)}/execution`}
                  toolApprovalEndpoint={approvalEndpoint}
                  toolApprovalParts={approvalParts}
                  showStatus
                  showActivities={false}
                  onBusyChange={setConversationBusy}
                  renderedActivityIds={renderedHookIds}
                  feedbackContext={{
                    workspaceSlug: slug,
                    conversationId: conversation.id,
                    agentId: conversation.agentId,
                  }}
                  settingsHref={agentSettingsHref(
                    slug,
                    conversation.agentId,
                    workReturnTo,
                    "mcp",
                  )}
                  className={conversationComposerDockClassName}
                  onChange={() => router.refresh()}
                  onOpenScreen={
                    panels.hasScreen ? panels.openScreen : undefined
                  }
                  onTakeoverRequest={panels.openTakeoverScreen}
                  onTakeoverAnswered={panels.releaseScreenControl}
                />
              ) : null}
              {providers.length > 0 && unappliedDraft && agent ? (
                <div
                  role="status"
                  className="mx-auto mb-2 flex w-[calc(100%_-_2rem)] max-w-[736px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm"
                >
                  <p className="text-muted-foreground">
                    {t("agentDraftUnapplied")}
                  </p>
                  <Button
                    onClick={() =>
                      router.push(
                        agentSettingsHref(slug, agent.id, workReturnTo),
                      )
                    }
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                  >
                    {t("agentDraftReview")}
                  </Button>
                </div>
              ) : null}
              {!providers.length ? (
                <ModelProviderNotice
                  slug={slug}
                  className="mx-auto mb-2 w-[calc(100%_-_2rem)] max-w-[736px]"
                />
              ) : showConfigurationNotice && controlAgent ? (
                <Alert
                  variant="warning"
                  className="mx-auto mb-2 w-[calc(100%_-_2rem)] max-w-[736px]"
                >
                  <AlertIcon />
                  <AlertContent>
                    <AlertDescription>{t("configureAgent")}</AlertDescription>
                  </AlertContent>
                  <AlertAction>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() =>
                        router.push(
                          agentSettingsHref(
                            slug,
                            controlAgent.id,
                            workReturnTo,
                          ),
                        )
                      }
                    >
                      {tAgents("configureAgent")}
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}

              {!viewingA2A &&
                !conversation &&
                (!sessionReadOnly || selectedActive) && (
                  <div
                    className={`${conversationComposerDockClassName} ${!selected ? "mb-auto before:hidden" : ""} ${showConfigurationNotice || unappliedDraft ? "before:hidden" : ""}`}
                  >
                    <ScrollToBottomButton
                      visible={
                        !followingOutput && Boolean(selected || conversation)
                      }
                      onClick={() => setFollowingOutput(true)}
                      label={t("scrollToBottom")}
                    />
                    <div>
                      <div className="mb-2 max-h-[42dvh] space-y-2 overflow-y-auto overscroll-contain empty:hidden">
                        {selected && !sessionReadOnly ? (
                          <ConversationExecution
                            key={selected.id}
                            endpoint={`/api/v1/workspaces/${encodeURIComponent(slug)}/work-sessions/${encodeURIComponent(selected.id)}/ui`}
                            toolApprovalEndpoint={approvalEndpoint}
                            toolApprovalParts={approvalParts}
                            showStatus={false}
                            showActivities={false}
                            active={selectedActive}
                            onSetEditorText={composer.setDraft}
                            belowEditorElement={belowEditorElement}
                            renderedActivityIds={renderedHookIds}
                            onChange={() => void refreshSelected()}
                            onOpenScreen={
                              panels.hasScreen ? panels.openScreen : undefined
                            }
                            onTakeoverRequest={panels.openTakeoverScreen}
                            onTakeoverAnswered={panels.releaseScreenControl}
                            className="mb-3"
                          />
                        ) : null}
                        <AgentMessageQueueView
                          queue={messageQueue.queue}
                          onClear={() => void messageQueue.clear()}
                          disabled={
                            messageQueue.pending ||
                            messageQueue.forbidden ||
                            sessionReadOnly
                          }
                        />
                      </div>
                      <WorkComposer
                        key={composerScope}
                        agentId={controlAgent?.id}
                        sandboxId={controlSandbox?.id}
                        workSessionId={selected?.id}
                        conversationId={selected?.conversationId}
                        commands={commands}
                        draft={composer.draft}
                        onDraftChange={composer.setDraft}
                        attachments={composer.attachments}
                        onAttachmentsChange={composer.setAttachments}
                        references={composer.references}
                        onReferencesChange={composer.setReferences}
                        supportsAttachments={
                          !sessionReadOnly &&
                          (selected
                            ? controlSandbox?.kind
                            : activeSandbox?.kind) === "docker"
                        }
                        onError={composer.setError}
                        onPendingChange={composer.setComposerPending}
                        waitingQuestion={selected?.waitingQuestion}
                        toolbarStart={null}
                        disabled={
                          sessionReadOnly ||
                          unappliedDraft ||
                          Boolean(busy) ||
                          messageQueue.forbidden ||
                          (!canSend && !selectedActive && !localCommand) ||
                          composerPending
                        }
                        loading={running && !messageQueue.fallback}
                        onRunningSubmit={
                          selectedActive && !messageQueue.fallback
                            ? (mode) => void composer.sendQueuedMessage(mode)
                            : undefined
                        }
                        queuePending={messageQueue.pending}
                        onStop={
                          selected && busy !== "cancel"
                            ? () => void composer.postAction("cancel")
                            : undefined
                        }
                        onSubmit={() => void composer.sendMessage()}
                        toolbarEnd={
                          <>
                            <ConversationContextUsage
                              busy={running}
                              usage={contextUsage}
                            />
                            <ComposerModelSelect
                              providers={providers}
                              defaultSelection={composer.defaultModelSelection}
                              value={composer.modelChoice}
                              onChange={composer.setModelChoice}
                            />
                            {composer.reasoningAvailable && (
                              <ReasoningEffortControl
                                value={composer.reasoningEffort}
                                inherited={
                                  controlAgent?.reasoningEffort ?? null
                                }
                                disabled={
                                  sessionReadOnly ||
                                  unappliedDraft ||
                                  Boolean(busy) ||
                                  running ||
                                  composerPending
                                }
                                onChange={composer.setReasoningEffort}
                              />
                            )}
                          </>
                        }
                      />
                      <div
                        ref={setBelowEditorElement}
                        className="space-y-3 empty:hidden"
                      />
                      {!selected && agent?.ready && !sandboxOptions.length ? (
                        <p className="px-3 pt-3 text-center text-[11px] text-muted-foreground">
                          {t("attachSandbox")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}
            </section>
          </AnimatedSidebarInset>
          <WorkspacePanels
            panels={panels}
            hidden={viewingA2A}
            workspace={{
              slug,
              sessionKey: conversation?.id ?? selected?.id ?? "new",
              sandbox: controlSandbox,
              pending: Boolean(workspacePending),
              readOnly: sessionReadOnly,
              initialPath: activeWorkingDirectory,
              rpcApiBase: workspaceRpcApiBase,
              terminalApiBase: workspaceTerminalApiBase,
              unavailableLabel: workspaceUnavailableLabel,
            }}
          />
        </div>
      </ChatApp>
    </SubagentConversationScope.Provider>
  );
}
