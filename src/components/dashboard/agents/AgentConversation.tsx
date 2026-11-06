"use client";

import { Button } from "@/components/motion/button";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
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
import { StreamingResponse } from "@/components/agents/streaming-response";
import { ToolResult } from "@/components/agents/tool-result";
import { createPortal } from "react-dom";
import {
  AssistantMarkdown,
  ConversationActivity,
  ConversationMessageShell,
  conversationUserBubbleClassName,
  ToolPayload,
  toolOutputText,
  toolResultUnboundedHeight,
} from "@/components/dashboard/ConversationMessage";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
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
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  type AppendMessage,
  type AssistantRuntime,
  type AttachmentAdapter,
  type CompleteAttachment,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import {
  DefaultChatTransport,
  generateId,
  type CreateUIMessage,
  type UIMessage,
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
  TerminalSquare,
} from "lucide-react";

import { ConversationContextUsage } from "@/components/dashboard/ConversationComposer";
import { resolveContextUsage } from "@/lib/context-usage";
import type { ChatBranchNavigation } from "@/lib/chat/branches";
import type { ReasoningEffort } from "@/lib/agents/constants";
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
import {
  SubagentActivity,
  SubagentActivitySchema,
  subagentSourceKey,
} from "./SubagentActivity";
import { HookActivity, HookActivitySchema } from "./HookActivity";

const MAX_ATTACHMENTS = 5;
const ATTACHMENT_ERROR_PART = "data-toolplane-attachment-error";

type AttachmentContentPart = CompleteAttachment["content"][number];
type DraftSnapshot = {
  text: string;
  files: File[];
};

function toChatCreateMessage<UI_MESSAGE extends UIMessage = UIMessage>(
  message: AppendMessage,
): CreateUIMessage<UI_MESSAGE> {
  const inputParts = [
    ...message.content.filter((part) => part.type !== "file"),
    ...(message.attachments?.flatMap((attachment) =>
      attachment.content.map((part) => ({
        ...part,
        filename: attachment.name,
      })),
    ) ?? []),
  ];
  const parts = inputParts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "file",
        url: part.image,
        mediaType: "image/png",
        ...(part.filename ? { filename: part.filename } : {}),
      };
    }
    if (part.type === "file") {
      return {
        type: "file",
        url: part.data,
        mediaType: part.mimeType,
        ...(part.filename ? { filename: part.filename } : {}),
      };
    }
    if (part.type === "data")
      return { type: `data-${part.name}`, data: part.data };
    throw new Error(`Unsupported message part: ${part.type}`);
  });
  return {
    role: message.role,
    parts,
    metadata: message.sourceId
      ? {
          ...(message.metadata && typeof message.metadata === "object"
            ? message.metadata
            : {}),
          toolplaneEditMessageId: message.sourceId,
        }
      : message.metadata,
  } as unknown as CreateUIMessage<UI_MESSAGE>;
}

function mergeDraftText(current: string, restored: string) {
  if (!restored) return current;
  if (!current) return restored;
  if (current === restored || current.startsWith(`${restored}\n`))
    return current;
  return `${restored}\n${current}`;
}

async function restoreDraftSnapshot(
  runtime: AssistantRuntime,
  snapshot: DraftSnapshot,
) {
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, snapshot.text));
  const existingFiles = new Set(
    current.attachments.flatMap((attachment) =>
      attachment.file
        ? [
            `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`,
          ]
        : [],
    ),
  );
  for (const file of snapshot.files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingFiles.has(key)) continue;
    await composer.addAttachment(file);
    existingFiles.add(key);
  }
}

async function restoreCreateMessageDraft(
  runtime: AssistantRuntime | null,
  message: unknown,
) {
  if (!runtime || !message || typeof message !== "object") return;
  const candidate = message as {
    text?: unknown;
    parts?: Array<{
      type?: unknown;
      text?: unknown;
      url?: unknown;
      mediaType?: unknown;
      filename?: unknown;
    }>;
  };
  const parts = Array.isArray(candidate.parts) ? candidate.parts : [];
  const text = [
    typeof candidate.text === "string" ? candidate.text : "",
    ...parts.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    ),
  ]
    .filter(Boolean)
    .join("\n");
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, text));

  for (const part of parts) {
    if (
      part.type !== "file" ||
      typeof part.url !== "string" ||
      typeof part.mediaType !== "string"
    )
      continue;
    const name =
      typeof part.filename === "string" ? part.filename : "attachment";
    await composer.addAttachment({
      name,
      type: part.mediaType.startsWith("image/") ? "image" : "file",
      contentType: part.mediaType,
      content: [
        {
          type: "file",
          data: part.url,
          mimeType: part.mediaType,
          filename: name,
        },
      ],
    });
  }
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
  disabled,
  mcpPromptApiPath,
  mcpResourceApiPath,
  onError,
  onNewConversation,
  runtimeCommands,
  webSearchAvailable,
  webSearchEnabled,
  onWebSearchChange,
}: {
  attachmentsEnabled: boolean;
  disabled: boolean;
  mcpPromptApiPath?: string;
  mcpResourceApiPath?: string;
  onError: (message: string | null) => void;
  onNewConversation?: () => void | Promise<void>;
  runtimeCommands: readonly RuntimeCommand[];
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  onWebSearchChange: (enabled: boolean) => void;
}) {
  const t = useTranslations("console.runtimeCommands");
  const agentsT = useTranslations("console.agents");
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
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
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      for (const file of files) {
        try {
          await aui.composer.addAttachment(file);
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
    [agentsT, aui.composer, onError],
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
    setText: (value) => aui.composer.setText(value),
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
        onChange={(event) => void addAttachments(event)}
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

function useAgentAttachmentAdapter({
  attachmentUploadUrl,
  onError,
  onUploadingChange,
  runtimeRef,
  draftSnapshotRef,
  recoveryErrorRef,
}: {
  attachmentUploadUrl?: string;
  onError: (message: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
  runtimeRef: { current: AssistantRuntime | null };
  draftSnapshotRef: { current: DraftSnapshot | null };
  recoveryErrorRef: { current: string | null };
}) {
  const t = useTranslations("console.agents");
  const activeAttachmentIds = useRef(new Set<string>());
  const activeSends = useRef(0);

  return useMemo<AttachmentAdapter>(
    () => ({
      accept: "*",
      async add({ file }) {
        if (!attachmentUploadUrl) {
          const message = t("attachmentRuntimeRequired");
          onError(message);
          throw new Error(message);
        }
        if (activeAttachmentIds.current.size >= MAX_ATTACHMENTS) {
          const message = t("attachmentLimitReached", {
            count: MAX_ATTACHMENTS,
          });
          onError(message);
          throw new Error(message);
        }

        const id = generateId();
        activeAttachmentIds.current.add(id);
        return {
          id,
          type: file.type.startsWith("image/") ? "image" : "file",
          name: file.name,
          file,
          contentType: file.type || "application/octet-stream",
          content: [],
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      async remove(attachment) {
        activeAttachmentIds.current.delete(attachment.id);
      },
      async send(attachment) {
        if (!draftSnapshotRef.current) {
          const state = runtimeRef.current?.thread.composer.getState();
          if (state) {
            draftSnapshotRef.current = {
              text: state.text,
              files: state.attachments.flatMap((item) =>
                item.file ? [item.file] : [],
              ),
            };
          }
        }
        activeSends.current += 1;
        onUploadingChange(true);
        onError(null);
        try {
          if (!attachmentUploadUrl)
            throw new Error(t("attachmentRuntimeRequired"));
          const url = new URL(attachmentUploadUrl, window.location.origin);
          url.searchParams.set("filename", attachment.file.name);
          const uploadUrl = `${url.pathname}${url.search}`;
          const response = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              "content-type":
                attachment.contentType || "application/octet-stream",
            },
            body: attachment.file,
          });
          const result = (await response.json().catch(() => ({}))) as {
            name?: string;
            mimeType?: string;
            url?: string;
            error?: string;
          };
          const location = result.url;
          if (!response.ok || !location) {
            throw new Error(result.error || t("attachmentUploadFailed"));
          }
          const name = result.name || attachment.name;
          const content: AttachmentContentPart[] = [
            {
              type: "file",
              data: location,
              mimeType:
                result.mimeType ||
                attachment.contentType ||
                "application/octet-stream",
              filename: name,
            },
          ];

          return {
            ...attachment,
            status: { type: "complete" },
            content,
          };
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message === "conversation"
                ? t("couldNotCreateConversation")
                : error.message
              : t("attachmentUploadFailed");
          recoveryErrorRef.current = message;
          onError(message);
          return {
            ...attachment,
            status: { type: "complete" },
            content: [
              {
                type: "data",
                name: ATTACHMENT_ERROR_PART.slice(5),
                data: { message },
              },
            ],
          };
        } finally {
          activeAttachmentIds.current.delete(attachment.id);
          activeSends.current = Math.max(0, activeSends.current - 1);
          onUploadingChange(activeSends.current > 0);
          if (activeSends.current === 0 && !recoveryErrorRef.current) {
            draftSnapshotRef.current = null;
          }
        }
      },
    }),
    [
      attachmentUploadUrl,
      draftSnapshotRef,
      onError,
      onUploadingChange,
      recoveryErrorRef,
      runtimeRef,
      t,
    ],
  );
}

function ConversationReasoning({
  text,
  working,
}: {
  text: string;
  working: boolean;
}) {
  const work = useTranslations("console.work");
  const startedAt = useRef<number | null>(null);
  const [duration, setDuration] = useState<number>();
  useEffect(() => {
    if (working) {
      startedAt.current = performance.now();
      return;
    }
    if (startedAt.current === null) return;
    const elapsed = (performance.now() - startedAt.current) / 1000;
    const frame = requestAnimationFrame(() => setDuration(elapsed));
    return () => cancelAnimationFrame(frame);
  }, [working]);
  return (
    <ConversationActivity
      contentType="text"
      status={working ? "working" : "complete"}
      duration={duration}
      summary={!working && duration === undefined ? work("thought") : undefined}
      items={text
        .split("\n")
        .map((content, line) => ({
          id: String(line),
          type: "text" as const,
          content,
        }))
        .filter((item) => item.content.length > 0)}
    />
  );
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
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    initialReasoningEffort,
  );
  const assistantRuntimeRef = useRef<AssistantRuntime | null>(null);
  const sendConversationIdRef = useRef<string | null>(null);
  const attachmentDraftSnapshotRef = useRef<DraftSnapshot | null>(null);
  const attachmentRecoveryErrorRef = useRef<string | null>(null);
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
              }) => {
                const editMessageId = (
                  messages.at(-1)?.metadata as
                    | { toolplaneEditMessageId?: unknown }
                    | undefined
                )?.toolplaneEditMessageId;
                return {
                  body: {
                    ...body,
                    messageId:
                      messageId ??
                      (typeof editMessageId === "string"
                        ? editMessageId
                        : undefined),
                    messages: messages.slice(-1),
                    trigger,
                  },
                };
              },
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
  const busy = chatBusy || commandBusy;
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

  const displayMessages = useMemo(
    () => expandAssistantMessages(chat.messages),
    [chat.messages],
  );
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
  const sendMessage = useCallback<typeof chat.sendMessage>(
    async (message, options) => {
      if (!ready || branchBusy || commandBusy) return;
      setSubmitError(null);
      const messageParts =
        message &&
        typeof message === "object" &&
        "parts" in message &&
        Array.isArray(message.parts)
          ? (message.parts as Array<{ type: string; text?: unknown }>)
          : [];
      const attachmentFailed = messageParts.some(
        (part) => part.type === ATTACHMENT_ERROR_PART,
      );
      if (attachmentFailed) {
        const snapshot = attachmentDraftSnapshotRef.current;
        const errorMessage =
          attachmentRecoveryErrorRef.current ?? t("attachmentUploadFailed");
        attachmentDraftSnapshotRef.current = null;
        attachmentRecoveryErrorRef.current = null;
        sendConversationIdRef.current = null;
        if (snapshot && assistantRuntimeRef.current) {
          await restoreDraftSnapshot(assistantRuntimeRef.current, snapshot);
        } else {
          await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
        }
        setSubmitError(errorMessage);
        return;
      }
      const commandLine = messageParts
        .filter(
          (part): part is { type: string; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("");
      const command = runtimeCommands.length
        ? parseRuntimeCommand(commandLine, runtimeKind ?? "")
        : null;
      if (command) {
        if (
          !isExecutableAgentRuntimeKind(runtimeKind) &&
          !runtimeCommands.some((item) => item.name === command.name)
        ) {
          setSubmitError(commandsT("unsupportedCommand"));
          await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
          return;
        }
        if (messageParts.some((part) => part.type !== "text")) {
          setSubmitError(commandsT("noAttachments"));
          await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
          return;
        }
        setCommandBusy(true);
        try {
          const nextConversationId =
            activeConversationId ??
            sendConversationIdRef.current ??
            (await ensureConversation());
          sendConversationIdRef.current = null;
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
        } catch (cause) {
          sendConversationIdRef.current = null;
          setSubmitError(
            cause instanceof Error ? cause.message : commandsT("failed"),
          );
          await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
        } finally {
          setCommandBusy(false);
        }
        return;
      }
      let nextConversationId: string;
      try {
        nextConversationId =
          activeConversationId ??
          sendConversationIdRef.current ??
          (await ensureConversation());
        sendConversationIdRef.current = null;
      } catch {
        sendConversationIdRef.current = null;
        setSubmitError(t("couldNotCreateConversation"));
        await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
        return;
      }
      setFollowingOutput(true);
      await sendChatMessage(message, {
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
      if (!ready || !allowRegenerate || branchBusy) return;
      setSubmitError(null);
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
    },
    [
      activeConversationId,
      allowRegenerate,
      branchBusy,
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
  const attachmentAdapter = useAgentAttachmentAdapter({
    attachmentUploadUrl,
    onError: setSubmitError,
    onUploadingChange: setUploadingAttachments,
    runtimeRef: assistantRuntimeRef,
    draftSnapshotRef: attachmentDraftSnapshotRef,
    recoveryErrorRef: attachmentRecoveryErrorRef,
  });
  const assistantChat = useMemo(
    () => ({
      ...chat,
      messages: displayMessages,
      sendMessage,
      regenerate,
      stop,
    }),
    [chat, displayMessages, regenerate, sendMessage, stop],
  );
  const runtime = useAISDKRuntime(assistantChat, {
    adapters: { attachments: attachmentAdapter },
    isSendDisabled:
      !ready ||
      branchBusy ||
      commandBusy ||
      creatingConversation ||
      uploadingAttachments,
    joinStrategy: "none",
    // Preserve internal attachment URLs; the default converter treats relative paths as base64.
    toCreateMessage: toChatCreateMessage,
  });
  useEffect(() => {
    assistantRuntimeRef.current = runtime;
    return () => {
      if (assistantRuntimeRef.current === runtime)
        assistantRuntimeRef.current = null;
    };
  }, [runtime]);

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
  const composer = useSyncExternalStore(
    runtime.thread.composer.subscribe,
    runtime.thread.composer.getState,
    runtime.thread.composer.getState,
  );
  const thread = useSyncExternalStore(
    runtime.thread.subscribe,
    runtime.thread.getState,
    runtime.thread.getState,
  );
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
  const formatToolValue = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  const safeAttachmentUrl = (url: string) =>
    url.startsWith("/api/v1/attachments/") ||
    /^data:[\w.+-]+\/[\w.+-]+;base64,/.test(url);
  const messageActionClassName =
    "size-7 rounded-lg border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
            thread.messages.length
              ? "min-h-0 flex-1"
              : "mt-auto min-h-0 flex-none"
          }
          contentClassName="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6"
        >
          {thread.messages.length ? (
            <MessageGroup spacing="default" className="gap-6">
              {thread.messages.map((message, messageIndex) => {
                const from = message.role === "user" ? "user" : "assistant";
                const turnModelPart = chat.messages
                  .find((entry) => entry.id === message.id)
                  ?.parts.find((part) => part.type === "data-agent-turn-model");
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
                const messageRuntime = runtime.thread.getMessageById(
                  message.id,
                );
                const streaming =
                  message.role === "assistant" &&
                  message.status.type === "running";
                const text = message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
                const branch = branchNavigation.find(
                  (item) => item.messageId === message.id,
                );
                const actionVisibility =
                  messageIndex === thread.messages.length - 1
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
                      <AgentPromptProvenance
                        parts={
                          chat.messages.find((entry) => entry.id === message.id)
                            ?.parts ?? []
                        }
                      />
                    ) : null}
                    {message.content.map((part, index) => {
                      if (
                        part.type === "data" &&
                        part.name === "hook-activity"
                      ) {
                        const hook = HookActivitySchema.safeParse(part.data);
                        return hook.success ? (
                          <HookActivity key={hook.data.id} value={hook.data} />
                        ) : null;
                      }
                      if (
                        part.type === "data" &&
                        part.name === "subagent-activity"
                      ) {
                        const activity = SubagentActivitySchema.safeParse(
                          part.data,
                        );
                        if (!activity.success) return null;
                        const activityPart = displayMessages
                          .find((entry) => entry.id === message.id)
                          ?.parts.find(
                            (candidate) =>
                              candidate.type === "data-subagent-activity" &&
                              candidate.data === part.data,
                          );
                        const activityId =
                          activityPart && "id" in activityPart
                            ? activityPart.id
                            : undefined;
                        return (
                          <SubagentActivity
                            key={
                              activityId ??
                              JSON.stringify([
                                message.id,
                                subagentSourceKey(activity.data.source),
                                activity.data.type,
                                activity.data.toolCallId,
                              ])
                            }
                            value={part.data}
                          />
                        );
                      }
                      if (part.type === "text")
                        return from === "user" ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: ID-less message parts occupy persistent stream slots; text changes and duplicates are valid.
                          <span key={index} className="whitespace-pre-wrap">
                            {displayMessagingUserText(part.text)}
                          </span>
                        ) : (
                          <AssistantMarkdown
                            // biome-ignore lint/suspicious/noArrayIndexKey: Stable stream slots preserve markdown state while text grows; content-derived keys remount it.
                            key={index}
                            text={part.text}
                            streaming={streaming}
                          />
                        );
                      if (part.type === "reasoning")
                        return (
                          <ConversationReasoning
                            // biome-ignore lint/suspicious/noArrayIndexKey: Reasoning stream slots have no IDs and must retain their disclosure state as text grows.
                            key={`${message.id}:${index}`}
                            text={part.text}
                            working={
                              messageRuntime
                                .getMessagePartByIndex(index)
                                .getState().status.type === "running"
                            }
                          />
                        );
                      if (part.type === "file" && safeAttachmentUrl(part.data))
                        return (
                          <ConversationFilePreview
                            // biome-ignore lint/suspicious/noArrayIndexKey: ID-less attachment slots can repeat URLs and must retain preview state.
                            key={index}
                            name={part.filename ?? t("attachment")}
                            url={part.data}
                            mimeType={part.mimeType}
                          />
                        );
                      if (
                        part.type === "image" &&
                        safeAttachmentUrl(part.image)
                      )
                        return (
                          <ConversationFilePreview
                            // biome-ignore lint/suspicious/noArrayIndexKey: ID-less image slots can repeat URLs and must retain preview state.
                            key={index}
                            name={t("attachment")}
                            url={part.image}
                            mimeType="image/png"
                          />
                        );
                      if (part.type !== "tool-call") return null;
                      const partRuntime =
                        messageRuntime.getMessagePartByIndex(index);
                      const partState = partRuntime.getState();
                      const tool =
                        /^(?:mcp__)?tp_\d+_[A-Za-z0-9_-]+__(.+)$/.exec(
                          part.toolName,
                        )?.[1] ?? part.toolName;
                      const failed =
                        part.isError ||
                        (partState.status.type === "incomplete" &&
                          partState.status.reason === "error");
                      const cancelled =
                        partState.status.type === "incomplete" &&
                        partState.status.reason === "cancelled";
                      const runningTool = partState.status.type === "running";
                      return (
                        <ToolResult
                          key={part.toolCallId}
                          className="w-full rounded-2xl border border-border/60 bg-muted/20 shadow-none"
                          tool={tool}
                          title={
                            runningTool
                              ? t("toolRunning")
                              : failed
                                ? t("toolFailed")
                                : t("toolCompleted")
                          }
                          status={
                            failed
                              ? "error"
                              : cancelled
                                ? "cancelled"
                                : runningTool
                                  ? "running"
                                  : "success"
                          }
                          defaultOpen={runningTool || failed}
                          copyText={
                            toolOutputText(part.result) ??
                            formatToolValue(part.result)
                          }
                          maxHeight={toolResultUnboundedHeight}
                        >
                          <ToolPayload label={t("toolInput")} language="json">
                            {part.argsText?.trim() ||
                              formatToolValue(part.args)}
                          </ToolPayload>
                          {part.result !== undefined ? (
                            <ToolPayload
                              label={t("toolOutput")}
                              language={
                                toolOutputText(part.result) !== undefined
                                  ? "text"
                                  : "json"
                              }
                            >
                              {toolOutputText(part.result) ??
                                formatToolValue(part.result)}
                            </ToolPayload>
                          ) : null}
                        </ToolResult>
                      );
                    })}
                    {message.attachments?.map((attachment) => {
                      const content = attachment.content.find(
                        (part) => part.type === "file" || part.type === "image",
                      );
                      const url =
                        content?.type === "file"
                          ? content.data
                          : content?.type === "image"
                            ? content.image
                            : undefined;
                      return (
                        <ConversationFilePreview
                          key={attachment.id}
                          name={attachment.name}
                          url={url && safeAttachmentUrl(url) ? url : undefined}
                          mimeType={attachment.contentType}
                        />
                      );
                    })}
                    {streaming &&
                    !message.content.some(
                      (part) => part.type !== "text" || part.text.length > 0,
                    ) ? (
                      <MessageTyping label={work("generatingReply")} />
                    ) : null}
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
                      thread.messages[messageIndex - 1]?.role !== "assistant"
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
                          onValueChange={(value) => {
                            setEditText(value);
                            messageRuntime.composer.setText(value);
                          }}
                          onSubmit={() => {
                            messageRuntime.composer.send();
                            setEditingId(null);
                          }}
                          leadingAction={
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                messageRuntime.composer.cancel();
                                setEditingId(null);
                              }}
                            >
                              {common("cancel")}
                            </Button>
                          }
                        />
                      </div>
                    ) : from === "assistant" ? (
                      <StreamingResponse
                        status={
                          streaming
                            ? "streaming"
                            : message.status?.type === "incomplete" &&
                                message.status.reason === "error"
                              ? "error"
                              : "complete"
                        }
                        copyText={text}
                        onRetry={
                          allowRegenerate && !blocked
                            ? () =>
                                void runAction(() =>
                                  includeConversationIdInBody
                                    ? messageRuntime.reload()
                                    : regenerate({ messageId: message.id }),
                                )
                            : undefined
                        }
                        announce={false}
                        actionsClassName={actionVisibility}
                        actions={
                          <>
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
                                    onStartBranch(message.id),
                                  )
                                }
                              >
                                <GitBranch className="size-3.5" />
                              </Button>
                            ) : null}
                          </>
                        }
                      >
                        {messageBody}
                      </StreamingResponse>
                    ) : (
                      <MessageBubble
                        variant="soft"
                        className={conversationUserBubbleClassName}
                      >
                        <MessageBubbleContent>
                          {messageBody}
                        </MessageBubbleContent>
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
                              messageRuntime.composer.beginEdit();
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
          {chat.status === "submitted" &&
          !thread.messages.some(
            (message) =>
              message.role === "assistant" && message.status.type === "running",
          ) ? (
            <MessageTyping label={work("preparingReply")} />
          ) : null}
        </MessageScroller>
        <div
          className={`${conversationComposerDockClassName} ${!thread.messages.length ? "mb-auto" : ""}`}
        >
          {typeof composerNotice === "function"
            ? composerNotice(
                runtime.thread.composer.setText,
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
                void runAction(() =>
                  runtime.thread.composer.addAttachment(file),
                );
            }}
          >
            <PromptInput
              attachments={
                composer.attachments.length ? (
                  <div className="mb-2 flex flex-wrap gap-3">
                    {composer.attachments.map((attachment, index) => (
                      <ConversationFilePreview
                        key={attachment.id}
                        file={attachment.file}
                        name={attachment.name}
                        mimeType={attachment.contentType}
                        progress={
                          attachment.status.type === "running"
                            ? attachment.status.progress
                            : undefined
                        }
                        removeLabel={t("removeAttachment", {
                          name: attachment.name,
                        })}
                        onRemove={() =>
                          void runAction(() =>
                            runtime.thread.composer
                              .getAttachmentByIndex(index)
                              .remove(),
                          )
                        }
                      />
                    ))}
                  </div>
                ) : null
              }
              value={composer.text}
              onValueChange={runtime.thread.composer.setText}
              onSubmit={() => runtime.thread.composer.send()}
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
                    disabled={blocked}
                    mcpPromptApiPath={scopeApiPath(mcpPromptApiPath)}
                    mcpResourceApiPath={scopeApiPath(mcpResourceApiPath)}
                    onError={setSubmitError}
                    onNewConversation={onNewConversation}
                    runtimeCommands={runtimeCommands}
                    webSearchAvailable={Boolean(webSearchAvailable)}
                    webSearchEnabled={webSearchEnabled}
                    onWebSearchChange={setWebSearchEnabled}
                  />
                  <span className="flex-1" />
                  <ConversationContextUsage busy={busy} usage={contextUsage} />
                  {reasoningAvailable ? (
                    <ReasoningEffortControl
                      value={reasoningEffort}
                      disabled={blocked}
                      onChange={setReasoningEffort}
                    />
                  ) : null}
                  {!composer.text.trim() && composer.attachments.length ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={blocked}
                      onClick={() => runtime.thread.composer.send()}
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
    </AssistantRuntimeProvider>
  );
}
