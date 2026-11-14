"use client";

import { Button } from "@/components/motion/button";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import { AgentMessageFeedback } from "./AgentMessageFeedback";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RevisionUpgradeNotice,
  McpToolsUpdatedNote,
} from "@/components/dashboard/RevisionUpgradeNotice";
import type { RevisionMcpToolChange } from "@/lib/revisions/upgrade-diff";
import { ComposerToolbarCustomizer } from "@/components/dashboard/ComposerToolbarCustomizer";
import { ComposerToolsButton } from "@/components/dashboard/ComposerToolsButton";
import {
  ComposerMenu,
  type ComposerMenuItem,
  type ComposerMenuOutcome,
  useComposerMenu,
} from "@/components/dashboard/composer-menu";
import { useMcpComposerMenu } from "@/components/dashboard/composer-mcp-menu";
import {
  MessageBubble,
  MessageBubbleContent,
  MessageFooter,
  MessageGroup,
  MessageTyping,
} from "@/components/agents/message";
import { MessageScroller } from "@/components/agents/message-scroller";
import {
  ConversationComposer as PromptInput,
  conversationComposerDockClassName,
} from "@/components/dashboard/ConversationComposer";
import { createPortal } from "react-dom";
import {
  ConversationMessageShell,
  conversationUserBubbleClassName,
} from "@/components/dashboard/ConversationMessage";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import { ConversationContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import { CopyButton } from "@/components/dashboard/CopyButton";

import { AgentPromptProvenance } from "@/components/dashboard/agents/AgentPromptProvenance";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  generateId,
  type CreateUIMessage,
  type FileUIPart,
} from "ai";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Pencil,
  Eraser,
  Globe2,
  Paperclip,
  SlidersHorizontal,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";

import { ConversationContextUsage } from "@/components/dashboard/ConversationComposer";
import { resolveContextUsage } from "@/lib/context-usage";
import type { ChatBranchNavigation } from "@/lib/chat/branches";
import type { ReasoningEffort, ReasoningLevel } from "@/lib/agents/constants";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import {
  expandAssistantMessages,
  type AgentUIMessage,
} from "@/lib/agents/message-segments";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
  type RuntimeCommand,
} from "@/lib/agents/runtime-commands";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { SubagentActivity, SubagentActivitySchema } from "./SubagentActivity";
import { HookActivity, HookActivitySchema } from "./HookActivity";

const MAX_ATTACHMENTS = 5;

type DraftAttachment = {
  id: string;
  file: File;
};
type DraftSnapshot = {
  text: string;
  attachments: DraftAttachment[];
};

function mergeDraftText(current: string, restored: string) {
  if (!restored) return current;
  if (!current) return restored;
  if (current === restored || current.startsWith(`${restored}\n`))
    return current;
  return `${restored}\n${current}`;
}

const TOOLBAR_STORAGE_KEY = "toolplane.conversation.composer.toolbar";
const TOOLBAR_EVENT = "toolplane:conversation-composer-toolbar";

function subscribeToolbar(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(TOOLBAR_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(TOOLBAR_EVENT, listener);
  };
}

function readToolbar() {
  try {
    return window.localStorage.getItem(TOOLBAR_STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function ConversationTools({
  attachmentsEnabled,
  composerText,
  disabled,
  mcpPromptApiPath,
  mcpResourceApiPath,
  onAddAttachment,
  onError,
  onNewConversation,
  runtimeCommands,
  onTextChange,
  webSearchAvailable,
  webSearchEnabled,
  onWebSearchChange,
}: {
  attachmentsEnabled: boolean;
  composerText: string;
  disabled: boolean;
  mcpPromptApiPath?: string;
  mcpResourceApiPath?: string;
  onAddAttachment: (file: File) => void;
  onError: (message: string | null) => void;
  onNewConversation?: () => void | Promise<void>;
  runtimeCommands: readonly RuntimeCommand[];
  onTextChange: (text: string) => void;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  onWebSearchChange: (enabled: boolean) => void;
}) {
  const t = useTranslations("console.runtimeCommands");
  const agentsT = useTranslations("console.agents");
  const [customizing, setCustomizing] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const attachmentInputId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toolbarValue = useSyncExternalStore(
    subscribeToolbar,
    readToolbar,
    () => "[]",
  );
  useEffect(() => {
    const element =
      toolsButtonRef.current?.closest<HTMLElement>(
        '[data-ui="chat.composer"]',
      ) ?? null;
    containerRef.current = element;
    textareaRef.current = element?.querySelector("textarea") ?? null;
    setContainer(element);
  }, []);

  const addAttachments = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      for (const file of files) {
        try {
          onAddAttachment(file);
        } catch (cause) {
          onError(
            cause instanceof Error
              ? cause.message
              : agentsT("attachmentUploadFailed"),
          );
        }
      }
      textareaRef.current?.focus();
    },
    [agentsT, onAddAttachment, onError],
  );
  const openAttachmentPicker = useCallback(() => {
    if (!attachmentsEnabled) {
      onError(agentsT("attachmentRuntimeRequired"));
      return;
    }
    document.getElementById(attachmentInputId)?.click();
  }, [agentsT, attachmentInputId, attachmentsEnabled, onError]);

  const resourceParams = mcpResourceApiPath
    ? new URLSearchParams(mcpResourceApiPath.split("?")[1])
    : undefined;
  const mcp = useMcpComposerMenu({
    composerPath: mcpResourceApiPath,
    promptsPath: mcpPromptApiPath,
    resourceContext: {
      conversationId: resourceParams?.get("conversationId") ?? undefined,
      workSessionId: resourceParams?.get("workSessionId") ?? undefined,
    },
  });
  const clearRuntimeCommand = runtimeCommands.find(
    (command) => command.name === "clear",
  );
  const items: ComposerMenuItem[] = [
    {
      id: "attachments",
      label: agentsT("addAttachment"),
      description: attachmentsEnabled
        ? undefined
        : agentsT("attachmentRuntimeRequired"),
      disabled: !attachmentsEnabled,
      icon: Paperclip,
    },
    ...(webSearchAvailable
      ? [
          {
            id: "web-search",
            label: webSearchEnabled
              ? agentsT("disableWebSearch")
              : agentsT("enableWebSearch"),
            icon: Globe2,
            pressed: webSearchEnabled,
          },
        ]
      : []),
    ...(clearRuntimeCommand || onNewConversation
      ? [
          {
            id: "clear-context",
            label: agentsT("clearContext"),
            description: agentsT("clearContextDescription"),
            icon: Eraser,
          },
        ]
      : []),
    ...mcp.rootItems,
    ...runtimeCommands
      .filter((command) => command.name !== "clear")
      .map((command) => ({
        id: `runtime:${command.name}`,
        label: `/${command.name}`,
        description: t.has(`descriptions.${command.name}`)
          ? t(`descriptions.${command.name}`)
          : command.description,
        icon: TerminalSquare,
        group: t("title"),
        data: command.name,
      })),
  ];

  async function runItem(
    item: ComposerMenuItem,
    view: string,
    insertText: (text: string) => void,
  ): Promise<ComposerMenuOutcome> {
    const handled = await mcp.activate(item, view, insertText);
    if (handled !== null) return handled;
    if (typeof item.data === "string") insertText(`/${item.data} `);
    if (item.id === "attachments") openAttachmentPicker();
    if (item.id === "web-search") onWebSearchChange(!webSearchEnabled);
    if (item.id === "clear-context") {
      if (clearRuntimeCommand) insertText("/clear ");
      else await onNewConversation?.();
    }
    return undefined;
  }

  const menu = useComposerMenu({
    text: composerText,
    setText: onTextChange,
    textareaRef,
    containerRef,
    disabled,
    rootItems: items,
    views: mcp.views,
    onActivate: runItem,
    onError,
  });

  const syncMenu = useEffectEvent((value: string) => {
    const input = textareaRef.current;
    if (input && document.activeElement === input)
      menu.sync(value, input.selectionStart, input.selectionEnd);
  });
  useEffect(() => {
    syncMenu(composerText);
  }, [composerText]);

  // PromptInput submits on Enter; the menu claims navigation keys first.
  const menuKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const input = textareaRef.current;
    if (!input) return;
    const handled = menu.onKeyDown({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      keyCode: event.keyCode,
      nativeEvent: event,
      currentTarget: input,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    });
    if (handled) event.stopPropagation();
  });
  useEffect(() => {
    const input = container?.querySelector("textarea");
    if (!input) return;
    const keyDown = (event: globalThis.KeyboardEvent) => menuKeyDown(event);
    input.addEventListener("keydown", keyDown, true);
    return () => input.removeEventListener("keydown", keyDown, true);
  }, [container]);

  let pinnedIds: string[] = [];
  try {
    const stored: unknown = JSON.parse(toolbarValue);
    if (Array.isArray(stored))
      pinnedIds = [...new Set(stored)].filter(
        (id): id is string =>
          typeof id === "string" && items.some((item) => item.id === id),
      );
  } catch {
    /* Ignore obsolete or invalid browser preferences. */
  }
  const toolbarItems = [
    ...pinnedIds.flatMap((id) => items.find((item) => item.id === id) ?? []),
    ...items.filter((item) => item.pressed && !pinnedIds.includes(item.id)),
  ];

  const saveToolbar = useCallback(
    (ids: string[]) => {
      try {
        window.localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(ids));
        window.dispatchEvent(new Event(TOOLBAR_EVENT));
      } catch {
        onError(agentsT("toolbarSaveFailed"));
      }
    },
    [agentsT, onError],
  );

  return (
    <>
      <ComposerToolsButton
        ref={toolsButtonRef}
        open={menu.open}
        disabled={disabled}
        aria-label={agentsT("openComposerTools")}
        title={agentsT("openComposerTools")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={menu.openFromButton}
      />
      {container
        ? createPortal(
            <ComposerMenu
              menu={menu}
              footer={{
                label: agentsT("customizeToolbar"),
                icon: SlidersHorizontal,
                onSelect: () => setCustomizing(true),
              }}
            />,
            container,
          )
        : null}
      <input
        id={attachmentInputId}
        type="file"
        multiple
        hidden
        disabled={disabled || !attachmentsEnabled}
        onChange={addAttachments}
      />
      {toolbarItems.map((item) => {
        const Icon = item.icon;
        return (
          <Button
            key={item.id}
            type="button"
            data-composer-shortcut={item.id}
            disabled={disabled || item.disabled}
            aria-label={item.label}
            aria-pressed={item.pressed}
            title={item.label}
            onClick={() => {
              if (item.drill) {
                menu.openView(item.id);
                return;
              }
              onError(null);
              void runItem(item, "root", menu.insertText).catch((cause) =>
                onError(
                  cause instanceof Error
                    ? cause.message
                    : agentsT("clearContextFailed"),
                ),
              );
            }}
            variant={item.pressed ? "primary" : "ghost"}
            size="icon"
            className="flex shrink-0 items-center justify-center"
          >
            <Icon className="size-[17px]" />
          </Button>
        );
      })}
      <ComposerToolbarCustomizer
        open={customizing}
        onOpenChange={setCustomizing}
        title={agentsT("customizeToolbar")}
        resetLabel={agentsT("resetToolbar")}
        options={items}
        pinnedIds={pinnedIds}
        onChange={saveToolbar}
      />
    </>
  );
}

function useAgentAttachments(attachmentUploadUrl?: string) {
  const t = useTranslations("console.agents");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const attachmentsRef = useRef(attachments);
  const updateAttachments = useCallback((next: DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const addAttachment = useCallback(
    (file: File) => {
      if (!attachmentUploadUrl) throw new Error(t("attachmentRuntimeRequired"));
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS)
        throw new Error(
          t("attachmentLimitReached", { count: MAX_ATTACHMENTS }),
        );
      updateAttachments([
        ...attachmentsRef.current,
        { id: generateId(), file },
      ]);
    },
    [attachmentUploadUrl, t, updateAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      updateAttachments(
        attachmentsRef.current.filter((item) => item.id !== id),
      );
    },
    [updateAttachments],
  );
  const takeAttachments = useCallback(() => {
    const snapshot = attachmentsRef.current;
    updateAttachments([]);
    return snapshot;
  }, [updateAttachments]);
  const restoreAttachments = useCallback(
    (snapshot: DraftAttachment[]) => {
      const fileKey = ({ file }: DraftAttachment) =>
        `${file.name}:${file.size}:${file.lastModified}`;
      const existingFiles = new Set(attachmentsRef.current.map(fileKey));
      const restored = snapshot.filter((attachment) => {
        const key = fileKey(attachment);
        if (existingFiles.has(key)) return false;
        existingFiles.add(key);
        return true;
      });
      updateAttachments([...restored, ...attachmentsRef.current]);
    },
    [updateAttachments],
  );
  const uploadAttachments = useCallback(
    async (snapshot: DraftAttachment[]): Promise<FileUIPart[]> => {
      if (!snapshot.length) return [];
      setUploading(true);
      try {
        if (!attachmentUploadUrl)
          throw new Error(t("attachmentRuntimeRequired"));
        const parts: FileUIPart[] = [];
        for (const { file } of snapshot) {
          const url = new URL(attachmentUploadUrl, window.location.origin);
          url.searchParams.set("filename", file.name);
          const response = await fetch(`${url.pathname}${url.search}`, {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          });
          const result = (await response.json().catch(() => ({}))) as {
            name?: string;
            mimeType?: string;
            url?: string;
            error?: string;
          };
          if (!response.ok || !result.url)
            throw new Error(result.error || t("attachmentUploadFailed"));
          parts.push({
            type: "file",
            url: result.url,
            filename: result.name || file.name,
            mediaType:
              result.mimeType || file.type || "application/octet-stream",
          });
        }
        return parts;
      } catch (cause) {
        throw new Error(
          cause instanceof Error
            ? cause.message === "conversation"
              ? t("couldNotCreateConversation")
              : cause.message
            : t("attachmentUploadFailed"),
        );
      } finally {
        setUploading(false);
      }
    },
    [attachmentUploadUrl, t],
  );
  return {
    attachments,
    addAttachment,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    uploadAttachments,
    uploading,
  };
}

export function AgentConversation({
  activeConversationId,
  agentId,
  agentName,
  settingsHref,
  allowEdit = false,
  allowRegenerate = true,
  apiPath,
  attachmentUploadUrl,
  branchBusy = false,
  branchNavigation = [],
  composerNotice,
  contextBaseText,
  contextWindow,
  contextWindowEstimated = true,
  creatingConversation,
  ensureConversation,
  includeConversationIdInBody = true,
  initialReasoningEffort = "default",
  initialMessages,
  modelName,
  modelPicker,
  modelOverride,
  mcpPromptApiPath,
  mcpResourceApiPath,
  onBranchChange,
  onBusyChange,
  onConversationChanged,
  onNewConversation,
  onStartBranch,
  ready: configuredReady,
  reasoningAvailable = false,
  inheritedReasoningEffort = null,
  runtimeKind,
  readOnly: configuredReadOnly = false,
  agentRevisionVersion,
  currentRevisionVersion,
  mcpToolsUpdated,
  supportsAttachments,
  serverManaged = false,
  webSearchAvailable,
  workSessionId,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  settingsHref?: string;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  apiPath?: string;
  attachmentUploadUrl?: string;
  branchBusy?: boolean;
  branchNavigation?: ChatBranchNavigation[];
  /** Rendered above the composer; native editor events can update its draft. */
  composerNotice?:
    | ReactNode
    | ((
        setEditorText: (text: string) => void,
        belowEditorElement: HTMLDivElement | null,
        renderedActivityIds: readonly string[],
      ) => ReactNode);
  contextBaseText?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  includeConversationIdInBody?: boolean;
  initialReasoningEffort?: ReasoningEffort;
  initialMessages: AgentUIMessage[];
  modelName?: string | null;
  modelPicker?: ReactNode;
  modelOverride?: { providerId: string; model: string } | null;
  mcpPromptApiPath?: string;
  mcpResourceApiPath?: string;
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onConversationChanged?: () => void | Promise<void>;
  onNewConversation?: () => void | Promise<void>;
  onStartBranch?: (messageId: string) => void | Promise<void>;
  ready: boolean;
  reasoningAvailable?: boolean;
  inheritedReasoningEffort?: ReasoningLevel | null;
  runtimeKind: string | null;
  readOnly?: boolean;
  agentRevisionVersion?: number | null;
  currentRevisionVersion?: number;
  mcpToolsUpdated?: {
    added: RevisionMcpToolChange[];
    removed: RevisionMcpToolChange[];
  } | null;
  supportsAttachments?: boolean;
  serverManaged?: boolean;
  webSearchAvailable?: boolean;
  workSessionId?: string;
}) {
  const router = useRouter();
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const work = useTranslations("console.work");
  const chatAssistants = useTranslations("console.chatAssistants");
  const commandsT = useTranslations("console.runtimeCommands");
  const readOnly = configuredReadOnly || runtimeKind === "omp";
  const ready =
    configuredReady &&
    !readOnly &&
    (serverManaged || isExecutableAgentRuntimeKind(runtimeKind));
  const sessionQuery = new URLSearchParams({
    ...(activeConversationId ? { conversationId: activeConversationId } : {}),
    ...(workSessionId ? { workSessionId } : {}),
  });
  const scopeApiPath = (path?: string) => {
    if (!path || (!activeConversationId && !workSessionId)) return undefined;
    const [pathname, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    for (const [key, value] of sessionQuery) params.set(key, value);
    return `${pathname}?${params}`;
  };
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const {
    attachments,
    addAttachment,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    uploadAttachments,
    uploading: uploadingAttachments,
  } = useAgentAttachments(attachmentUploadUrl);
  const [commandBusy, setCommandBusy] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialReasoningEffort,
  );
  const { transport, getServerResponse } = useMemo(() => {
    let serverResponse: Promise<Response> | null = null;
    return {
      getServerResponse: () => serverResponse,
      transport: new DefaultChatTransport({
        api: apiPath ?? `/api/v1/agents/${agentId}/chat`,
        ...(serverManaged
          ? {
              fetch: (...args: Parameters<typeof fetch>) => {
                serverResponse = fetch(...args);
                return serverResponse;
              },
              prepareReconnectToStreamRequest: () => ({
                api: `${apiPath}/stream`,
              }),
            }
          : {}),
        ...(!includeConversationIdInBody
          ? {
              prepareSendMessagesRequest: ({
                body,
                messageId,
                messages,
                trigger,
              }) => ({
                body: {
                  ...body,
                  messageId,
                  messages: messages.slice(-1),
                  trigger,
                },
              }),
            }
          : {}),
      }),
    };
  }, [agentId, apiPath, includeConversationIdInBody, serverManaged]);
  const chat = useChat<AgentUIMessage>({
    transport,
    resume: serverManaged,
    messages: initialMessages,
    onFinish: () => {
      void onConversationChanged?.();
    },
  });
  const stopLocalChat = chat.stop;
  const stop = useCallback(async () => {
    if (!serverManaged) {
      await stopLocalChat();
      return;
    }
    if (!apiPath) return;
    try {
      const response = await getServerResponse();
      const turnId = response?.headers.get("X-Chat-Turn-Id");
      if (!turnId) {
        await stopLocalChat();
        return;
      }
      const stopped = await fetch(apiPath, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      if (!stopped.ok)
        throw new Error((await stopped.json()).error || work("processFailed"));
      // Keep observing until the server settles and persists the stopped turn.
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : work("processFailed"),
      );
    }
  }, [apiPath, getServerResponse, serverManaged, stopLocalChat, work]);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming";
  const describeRuntimeError = useRuntimeErrorText();
  const runtimeError = describeRuntimeError(submitError || chat.error?.message);
  const configurationError = /no configured model/i.test(
    submitError || chat.error?.message || "",
  );
  const busy = chatBusy || commandBusy || submitting;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const contextUsage = useMemo(
    () =>
      resolveContextUsage(chat.messages, {
        maxTokens: contextWindow,
        modelName,
        context: contextBaseText,
        estimated: contextWindowEstimated,
      }),
    [
      chat.messages,
      contextBaseText,
      contextWindow,
      contextWindowEstimated,
      modelName,
    ],
  );

  const { displayMessages, sourceMessagesById } = useMemo(() => {
    const sources = new Map<string, AgentUIMessage>();
    const messages = chat.messages.flatMap((message) => {
      const expanded = expandAssistantMessages([message]);
      for (const displayed of expanded) sources.set(displayed.id, message);
      return expanded;
    });
    return { displayMessages: messages, sourceMessagesById: sources };
  }, [chat.messages]);
  const renderedActivityIds = useMemo(
    () =>
      chat.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          (part.type === "data-subagent-activity" ||
            part.type === "data-hook-activity") &&
          "id" in part &&
          typeof part.id === "string"
            ? [part.id]
            : [],
        ),
      ),
    [chat.messages],
  );
  const runtimeCommands = useMemo(
    () =>
      isExecutableAgentRuntimeKind(runtimeKind)
        ? sessionRuntimeCommands(runtimeKind, chat.messages)
        : [],
    [chat.messages, runtimeKind],
  );
  const initialMessagesSignature = useMemo(
    () => JSON.stringify(initialMessages),
    [initialMessages],
  );
  const setChatMessages = chat.setMessages;
  const lastInitialMessagesSignatureRef = useRef(initialMessagesSignature);
  useEffect(() => {
    if (chatBusy) return;
    if (lastInitialMessagesSignatureRef.current === initialMessagesSignature)
      return;
    lastInitialMessagesSignatureRef.current = initialMessagesSignature;
    setChatMessages(initialMessages);
  }, [chatBusy, initialMessages, initialMessagesSignature, setChatMessages]);
  const sendChatMessage = chat.sendMessage;
  const regenerateChat = chat.regenerate;
  const sendMessage = useCallback(
    async (
      message: CreateUIMessage<AgentUIMessage>,
      editMessageId?: string,
    ) => {
      if (!ready || branchBusy || commandBusy) return;
      setSubmitError(null);
      const commandLine = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const command = runtimeCommands.length
        ? parseRuntimeCommand(commandLine, runtimeKind ?? "")
        : null;
      if (command) {
        if (
          !isExecutableAgentRuntimeKind(runtimeKind) &&
          !runtimeCommands.some((item) => item.name === command.name)
        )
          throw new Error(commandsT("unsupportedCommand"));
        if (message.parts.some((part) => part.type !== "text"))
          throw new Error(commandsT("noAttachments"));
      }
      let nextConversationId: string;
      try {
        nextConversationId =
          activeConversationId ?? (await ensureConversation());
      } catch {
        throw new Error(t("couldNotCreateConversation"));
      }
      if (command) {
        setCommandBusy(true);
        try {
          const response = await fetch(
            `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(nextConversationId)}/commands`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                line: commandLine.trim(),
                ...(modelOverride ? { modelOverride } : {}),
              }),
            },
          );
          const result = (await response.json().catch(() => ({}))) as {
            error?: unknown;
          };
          if (!response.ok) {
            const error = typeof result.error === "string" ? result.error : "";
            throw new Error(
              error && commandsT.has(error)
                ? commandsT(error)
                : error || commandsT("failed"),
            );
          }
          void onConversationChanged?.();
        } finally {
          setCommandBusy(false);
        }
        return;
      }
      setFollowingOutput(true);
      // AI SDK replaces this user turn and truncates its descendants atomically.
      await sendChatMessage(
        { ...message, ...(editMessageId ? { messageId: editMessageId } : {}) },
        {
          body: {
            ...(modelOverride ? { modelOverride } : {}),
            ...(includeConversationIdInBody
              ? { conversationId: nextConversationId }
              : {}),
            ...(workSessionId ? { workSessionId } : {}),
            ...(webSearchAvailable !== undefined
              ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
              : {}),
            ...(reasoningAvailable ? { reasoningEffort } : {}),
          },
        },
      );
    },
    [
      agentId,
      activeConversationId,
      branchBusy,
      commandBusy,
      commandsT,
      ensureConversation,
      includeConversationIdInBody,
      modelOverride,
      onConversationChanged,
      reasoningAvailable,
      ready,
      reasoningEffort,
      runtimeCommands,
      runtimeKind,
      sendChatMessage,
      t,
      webSearchAvailable,
      webSearchEnabled,
      workSessionId,
    ],
  );
  const regenerate = useCallback<typeof chat.regenerate>(
    async (options) => {
      if (
        !ready ||
        !allowRegenerate ||
        branchBusy ||
        chatBusy ||
        commandBusy ||
        submissionInFlight.current
      )
        return;
      submissionInFlight.current = true;
      setSubmitting(true);
      setSubmitError(null);
      try {
        let nextConversationId: string;
        try {
          nextConversationId =
            activeConversationId ?? (await ensureConversation());
        } catch {
          setSubmitError(t("couldNotCreateConversation"));
          return;
        }
        setFollowingOutput(true);
        await regenerateChat({
          ...options,
          body: {
            ...options?.body,
            ...(modelOverride ? { modelOverride } : {}),
            ...(includeConversationIdInBody
              ? { conversationId: nextConversationId }
              : {}),
            ...(workSessionId ? { workSessionId } : {}),
            ...(webSearchAvailable !== undefined
              ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
              : {}),
            ...(reasoningAvailable ? { reasoningEffort } : {}),
          },
        });
      } finally {
        submissionInFlight.current = false;
        setSubmitting(false);
      }
    },
    [
      activeConversationId,
      allowRegenerate,
      branchBusy,
      chatBusy,
      commandBusy,
      ensureConversation,
      includeConversationIdInBody,
      modelOverride,
      reasoningAvailable,
      ready,
      reasoningEffort,
      regenerateChat,
      t,
      webSearchAvailable,
      webSearchEnabled,
      workSessionId,
    ],
  );

  const composerDisabled =
    branchBusy || commandBusy || creatingConversation || uploadingAttachments;
  const attachmentsEnabled =
    (serverManaged || isExecutableAgentRuntimeKind(runtimeKind)) &&
    (supportsAttachments ?? Boolean(attachmentUploadUrl));
  const composerStatus = !ready
    ? t("chooseAModelBeforeSending")
    : uploadingAttachments
      ? t("uploadingAttachments")
      : !activeConversationId
        ? t("conversationWillBeCreated")
        : null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [belowEditorElement, setBelowEditorElement] =
    useState<HTMLDivElement | null>(null);
  const blocked = !ready || composerDisabled || busy;
  const runAction = async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      setSubmitError(
        cause instanceof Error ? cause.message : work("processFailed"),
      );
    }
  };
  const submitDraft = async () => {
    if (
      blocked ||
      submissionInFlight.current ||
      (!composerText.trim() && !attachments.length)
    )
      return;
    const snapshot: DraftSnapshot = {
      text: composerText,
      attachments: takeAttachments(),
    };
    submissionInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setComposerText("");
    try {
      if (
        snapshot.attachments.length &&
        runtimeCommands.length &&
        parseRuntimeCommand(snapshot.text, runtimeKind ?? "")
      )
        throw new Error(commandsT("noAttachments"));
      const files = await uploadAttachments(snapshot.attachments);
      await sendMessage({
        role: "user",
        parts: [
          ...(snapshot.text.trim()
            ? [{ type: "text" as const, text: snapshot.text }]
            : []),
          ...files,
        ],
      });
    } catch (cause) {
      setComposerText((current) => mergeDraftText(current, snapshot.text));
      restoreAttachments(snapshot.attachments);
      setSubmitError(
        cause instanceof Error ? cause.message : work("processFailed"),
      );
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };
  const submitEdit = async (message: AgentUIMessage) => {
    if (blocked || submissionInFlight.current || !editText.trim()) return;
    const submittedText = editText;
    submissionInFlight.current = true;
    setSubmitting(true);
    setEditingId(null);
    setEditText("");
    try {
      await sendMessage(
        {
          role: "user",
          metadata: message.metadata,
          parts: [
            { type: "text", text: submittedText },
            ...message.parts.filter((part) => part.type !== "text"),
          ],
        },
        message.id,
      );
    } catch (cause) {
      setEditingId(message.id);
      setEditText(submittedText);
      setSubmitError(
        cause instanceof Error ? cause.message : work("processFailed"),
      );
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!readOnly &&
      activeConversationId &&
      agentRevisionVersion &&
      currentRevisionVersion &&
      agentRevisionVersion < currentRevisionVersion ? (
        <RevisionUpgradeNotice
          url={`/api/v1/agents/${agentId}/conversations/${activeConversationId}/revision`}
          fromVersion={agentRevisionVersion}
          targetVersion={currentRevisionVersion}
          disabled={busy || branchBusy}
          onUpgraded={() => {
            router.refresh();
            void onConversationChanged?.();
          }}
        />
      ) : null}
      <MessageScroller
        label={agentName}
        busy={chatBusy}
        followOutput={followingOutput}
        onFollowChange={setFollowingOutput}
        navigation="rail"
        className={
          displayMessages.length
            ? "min-h-0 flex-1"
            : "mt-auto min-h-0 flex-none"
        }
        contentClassName="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6"
      >
        {displayMessages.length ? (
          <MessageGroup spacing="default" className="gap-6">
            {displayMessages.map((message, messageIndex) => {
              const from = message.role === "user" ? "user" : "assistant";
              const sourceMessage =
                sourceMessagesById.get(message.id) ?? message;
              const turnModelPart = sourceMessage.parts.find(
                (part) => part.type === "data-agent-turn-model",
              );
              const turnModelData =
                turnModelPart && "data" in turnModelPart
                  ? turnModelPart.data
                  : null;
              const turnModel =
                turnModelData &&
                typeof turnModelData === "object" &&
                "model" in turnModelData &&
                typeof turnModelData.model === "string"
                  ? turnModelData.model
                  : null;
              const streaming =
                message.role === "assistant" &&
                chat.status === "streaming" &&
                messageIndex === displayMessages.length - 1;
              const text = message.parts
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
              const branch = branchNavigation.find(
                (item) => item.messageId === sourceMessage.id,
              );
              const actionVisibility =
                messageIndex === displayMessages.length - 1
                  ? ""
                  : "opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto motion-reduce:transition-none";
              const branchActions =
                branch && onBranchChange ? (
                  <fieldset
                    aria-label={t("conversationBranch")}
                    className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0 text-xs text-muted-foreground"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={messageActionClassName}
                      disabled={blocked}
                      aria-label={common("previous")}
                      onClick={() =>
                        void runAction(() =>
                          onBranchChange(branch.previousMessageId),
                        )
                      }
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span>
                      {branch.position}/{branch.total}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={messageActionClassName}
                      disabled={blocked}
                      aria-label={common("next")}
                      onClick={() =>
                        void runAction(() =>
                          onBranchChange(branch.nextMessageId),
                        )
                      }
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </fieldset>
                ) : null;
              const messageBody = (
                <>
                  {from === "assistant" && turnModel ? (
                    <div className="mb-1 text-[11px] text-muted-foreground">
                      {turnModel}
                    </div>
                  ) : null}
                  {from === "user" ? (
                    <>
                      <AgentPromptProvenance parts={sourceMessage.parts} />
                      {message.parts.map((part, index) => {
                        if (part.type === "text")
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Message parts occupy stable stream slots, including duplicate text.
                            <span key={index} className="whitespace-pre-wrap">
                              {displayMessagingUserText(part.text)}
                            </span>
                          );
                        if (part.type === "file")
                          return (
                            <ConversationFilePreview
                              // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate attachment URLs occupy independent persistent part slots.
                              key={index}
                              name={part.filename ?? t("attachment")}
                              url={part.url}
                              mimeType={part.mediaType}
                            />
                          );
                        return null;
                      })}
                    </>
                  ) : (
                    <ConversationContentBlocks
                      messageId={message.id}
                      parts={message.parts}
                      streaming={streaming}
                      processDataTypes={[
                        "data-subagent-activity",
                        "data-hook-activity",
                      ]}
                      renderDataStep={(step) => {
                        if (step.type === "data-hook-activity") {
                          const hook = HookActivitySchema.safeParse(step.data);
                          return hook.success ? (
                            <HookActivity value={hook.data} />
                          ) : null;
                        }
                        if (step.type === "data-subagent-activity") {
                          const activity = SubagentActivitySchema.safeParse(
                            step.data,
                          );
                          return activity.success ? (
                            <SubagentActivity value={activity.data} />
                          ) : null;
                        }
                        return null;
                      }}
                    />
                  )}
                </>
              );
              return (
                <ConversationMessageShell
                  key={message.id}
                  id={`chat-message-${message.id}`}
                  from={from}
                  name={agentName}
                  showIdentity={
                    messageIndex === 0 ||
                    displayMessages[messageIndex - 1]?.role !== "assistant"
                  }
                  aria-busy={streaming || undefined}
                >
                  {editingId === message.id ? (
                    <div className="w-full">
                      <PromptInput
                        value={editText}
                        autoFocus
                        disabled={blocked}
                        aria-label={t("messageThisAgent")}
                        onValueChange={setEditText}
                        onSubmit={() => void submitEdit(sourceMessage)}
                        leadingAction={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditingId(null);
                              setEditText("");
                            }}
                          >
                            {common("cancel")}
                          </Button>
                        }
                      />
                    </div>
                  ) : from === "assistant" ? (
                    <>
                      {messageBody}
                      {!streaming ? (
                        <MessageFooter
                          className={`gap-0.5 ${actionVisibility}`}
                        >
                          {activeConversationId ? (
                            <AgentMessageFeedback
                              agentId={agentId}
                              conversationId={activeConversationId}
                              messageId={sourceMessage.id}
                            />
                          ) : null}
                          {text ? (
                            <CopyButton
                              text={text}
                              label={common("copy")}
                              className={messageActionClassName}
                              iconOnly
                            />
                          ) : null}
                          {allowRegenerate ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={messageActionClassName}
                              disabled={blocked}
                              aria-label={t("retryResponse")}
                              onClick={() =>
                                void runAction(() =>
                                  regenerate({ messageId: sourceMessage.id }),
                                )
                              }
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          ) : null}
                          {branchActions}
                          {onStartBranch ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={messageActionClassName}
                              disabled={blocked}
                              aria-label={chatAssistants("newBranch")}
                              onClick={() =>
                                void runAction(() =>
                                  onStartBranch(sourceMessage.id),
                                )
                              }
                            >
                              <GitBranch className="size-3.5" />
                            </Button>
                          ) : null}
                        </MessageFooter>
                      ) : null}
                    </>
                  ) : (
                    <MessageBubble
                      variant="soft"
                      className={conversationUserBubbleClassName}
                    >
                      <MessageBubbleContent>{messageBody}</MessageBubbleContent>
                    </MessageBubble>
                  )}
                  {from === "user" && editingId !== message.id ? (
                    <MessageFooter className={`gap-0.5 ${actionVisibility}`}>
                      {branchActions}
                      {text ? (
                        <CopyButton
                          text={displayMessagingUserText(text)}
                          label={common("copy")}
                          className={messageActionClassName}
                          iconOnly
                        />
                      ) : null}
                      {allowEdit ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={messageActionClassName}
                          disabled={blocked}
                          aria-label={common("edit")}
                          onClick={() => {
                            setEditText(text);
                            setEditingId(message.id);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      ) : null}
                    </MessageFooter>
                  ) : null}
                </ConversationMessageShell>
              );
            })}
          </MessageGroup>
        ) : (
          <div className="flex items-center justify-center pb-2 pt-8 text-center">
            <div className="max-w-lg">
              <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-muted ring-1 ring-border/50">
                <Bot className="size-6" />
              </span>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                {agentName}
              </p>
              <h3 className="text-2xl font-medium tracking-tight sm:text-3xl">
                {work("emptyTitle")}
              </h3>
              {workSessionId ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("startWorkConversationDescription")}
                </p>
              ) : null}
              {mcpToolsUpdated ? (
                <McpToolsUpdatedNote {...mcpToolsUpdated} />
              ) : null}
            </div>
          </div>
        )}
        {chat.status === "submitted" ? (
          <MessageTyping label={work("preparingReply")} />
        ) : null}
      </MessageScroller>
      <div
        className={`${conversationComposerDockClassName} ${!displayMessages.length ? "mb-auto" : ""}`}
      >
        {typeof composerNotice === "function"
          ? composerNotice(
              setComposerText,
              belowEditorElement,
              renderedActivityIds,
            )
          : composerNotice}
        {submitError || chat.error?.message ? (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            <span>
              {configurationError
                ? work("configureAgent")
                : runtimeError
                  ? runtimeError.text
                  : submitError || chat.error?.message}
            </span>
            {(configurationError ||
              runtimeError?.code === "PI_MCP_TOOLS_UNAVAILABLE") &&
            settingsHref ? (
              <Link
                href={settingsHref}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t("configureAgent")}
              </Link>
            ) : null}
          </div>
        ) : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Non-focusable drop zone wraps the accessible composer; keyboard attachments use its upload control. */}
        <div
          data-ui="chat.composer"
          className="relative"
          onDragOver={(event) => {
            if (
              attachmentsEnabled &&
              !blocked &&
              event.dataTransfer.types.includes("Files")
            )
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (
              !attachmentsEnabled ||
              blocked ||
              !event.dataTransfer.files.length
            )
              return;
            event.preventDefault();
            for (const file of event.dataTransfer.files)
              void runAction(() => addAttachment(file));
          }}
        >
          <PromptInput
            attachments={
              attachments.length ? (
                <div className="mb-2 flex flex-wrap gap-3">
                  {attachments.map((attachment) => (
                    <ConversationFilePreview
                      key={attachment.id}
                      file={attachment.file}
                      name={attachment.file.name}
                      mimeType={attachment.file.type}
                      removeLabel={t("removeAttachment", {
                        name: attachment.file.name,
                      })}
                      onRemove={() => removeAttachment(attachment.id)}
                    />
                  ))}
                </div>
              ) : null
            }
            value={composerText}
            onValueChange={setComposerText}
            onSubmit={() => void submitDraft()}
            disabled={!ready || composerDisabled}
            loading={busy}
            onStop={chatBusy ? () => void stop() : undefined}
            aria-label={t("messageThisAgent")}
            placeholder={t("messageThisAgent")}
            minRows={1}
            maxRows={12}
            leadingAction={
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <ConversationTools
                  attachmentsEnabled={attachmentsEnabled}
                  composerText={composerText}
                  disabled={blocked}
                  mcpPromptApiPath={scopeApiPath(mcpPromptApiPath)}
                  mcpResourceApiPath={scopeApiPath(mcpResourceApiPath)}
                  onAddAttachment={addAttachment}
                  onError={setSubmitError}
                  onNewConversation={onNewConversation}
                  runtimeCommands={runtimeCommands}
                  onTextChange={setComposerText}
                  webSearchAvailable={Boolean(webSearchAvailable)}
                  webSearchEnabled={webSearchEnabled}
                  onWebSearchChange={setWebSearchEnabled}
                />
                <span className="flex-1" />
                <ConversationContextUsage busy={busy} usage={contextUsage} />
                {reasoningAvailable ? (
                  <ReasoningEffortControl
                    value={reasoningEffort}
                    inherited={inheritedReasoningEffort}
                    disabled={blocked}
                    onChange={setReasoningEffort}
                  />
                ) : null}
                {!composerText.trim() && attachments.length ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={blocked}
                    onClick={() => void submitDraft()}
                  >
                    {t("send")}
                  </Button>
                ) : null}
                {modelPicker}
              </div>
            }
          />
        </div>
        {composerStatus ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {composerStatus}
          </p>
        ) : null}
        <div ref={setBelowEditorElement} className="space-y-3 empty:hidden" />
      </div>
    </div>
  );
}
