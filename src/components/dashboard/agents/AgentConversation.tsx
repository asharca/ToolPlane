"use client";

import { Button } from "@/components/motion/button";
import { ComposerToolbarCustomizer } from "@/components/dashboard/ComposerToolbarCustomizer";
import { ComposerToolsButton } from "@/components/dashboard/ComposerToolsButton";
import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageTyping,
} from "@/components/agents/message";
import { MessageScroller } from "@/components/agents/message-scroller";
import { PromptInput } from "@/components/agents/prompt-input";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { AgentActivity } from "@/components/agents/agent-activity";
import { ToolApproval } from "@/components/agents/tool-approval";
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { AssistantMarkdown } from "@/components/dashboard/ConversationMessage";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import { CopyButton } from "@/components/dashboard/CopyButton";

import {
  useCallback,
  useEffect,
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
  UserRound,
  Database,
  Eraser,
  Globe2,
  Paperclip,
  ScrollText,
  Server,
  SlidersHorizontal,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

import { ConversationContextUsage } from "@/components/dashboard/ConversationComposer";
import { McpPromptPickerButton } from "@/components/dashboard/McpPromptPickerButton";
import { McpResourcePickerButton } from "@/components/dashboard/McpResourcePickerButton";
import { McpServerPickerButton } from "@/components/dashboard/McpServerPickerButton";
import { resolveContextUsage } from "@/lib/context-usage";
import type { ChatBranchNavigation } from "@/lib/chat/branches";
import type { ReasoningEffort } from "@/lib/agents/constants";
import { ReasoningEffortControl } from "@/components/dashboard/agents/ReasoningEffortControl";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from "@/lib/agents/hermes/message-segments";
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
  type RuntimeCommand,
} from "@/lib/agents/runtime-commands";

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

type ComposerToolItem = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  icon: LucideIcon;
  disabled?: boolean;
  pinable?: boolean;
  pressed?: boolean;
  execute: () => void | Promise<void>;
};

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

function focusComposerInput() {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-ui="chat.composer"] textarea',
    );
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
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
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const [mcpPromptOpen, setMcpPromptOpen] = useState(false);
  const [mcpResourceOpen, setMcpResourceOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const attachmentInputId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarValue = useSyncExternalStore(
    subscribeToolbar,
    readToolbar,
    () => "[]",
  );

  const setCommandText = useCallback(
    (text: string) => {
      aui.composer.setText(text);
      focusComposerInput();
    },
    [aui.composer],
  );
  const insertText = useCallback(
    (text: string) => {
      const current = aui.composer.getState();
      aui.composer.setText(mergeDraftText(current.text, text));
      focusComposerInput();
    },
    [aui.composer],
  );
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
      focusComposerInput();
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
  const clearRuntimeCommand = runtimeCommands.find(
    (command) => command.name === "clear",
  );
  const actions = useMemo<ComposerToolItem[]>(
    () => [
      {
        id: "attachments",
        label: agentsT("addAttachment"),
        description: attachmentsEnabled
          ? undefined
          : agentsT("attachmentRuntimeRequired"),
        disabled: !attachmentsEnabled,
        icon: Paperclip,
        execute: openAttachmentPicker,
      },
      ...(mcpResourceApiPath
        ? [
            {
              id: "mcp",
              label: agentsT("mcp"),
              icon: Server,
              group: agentsT("mcp"),
              execute: () => setMcpOpen(true),
            },
          ]
        : []),
      ...(mcpResourceApiPath
        ? [
            {
              id: "mcp-resources",
              label: agentsT("mcpResources"),
              icon: Database,
              group: agentsT("mcp"),
              execute: () => setMcpResourceOpen(true),
            },
          ]
        : []),
      ...(mcpPromptApiPath
        ? [
            {
              id: "mcp-prompts",
              label: agentsT("mcpPrompts"),
              icon: ScrollText,
              group: agentsT("mcp"),
              execute: () => setMcpPromptOpen(true),
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
              execute: clearRuntimeCommand
                ? () => setCommandText("/clear ")
                : () => onNewConversation?.(),
            },
          ]
        : []),
      ...(webSearchAvailable
        ? [
            {
              id: "web-search",
              label: webSearchEnabled
                ? agentsT("disableWebSearch")
                : agentsT("enableWebSearch"),
              icon: Globe2,
              pressed: webSearchEnabled,
              execute: () => onWebSearchChange(!webSearchEnabled),
            },
          ]
        : []),
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
          execute: () => setCommandText(`/${command.name} `),
        })),
      {
        id: "customize-toolbar",
        label: agentsT("customizeToolbar"),
        icon: SlidersHorizontal,
        pinable: false,
        execute: () => setCustomizing(true),
      },
    ],
    [
      agentsT,
      attachmentsEnabled,
      clearRuntimeCommand,
      mcpPromptApiPath,
      mcpResourceApiPath,
      onNewConversation,
      onWebSearchChange,
      openAttachmentPicker,
      runtimeCommands,
      setCommandText,
      t,
      webSearchAvailable,
      webSearchEnabled,
    ],
  );
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const toolbarIds = useMemo(() => {
    try {
      const stored: unknown = JSON.parse(toolbarValue);
      return Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  }, [toolbarValue]);
  const pinnedIds = [...new Set(toolbarIds)].filter(
    (id) => actionById.get(id)?.pinable !== false,
  );
  const toolbarActions = [
    ...pinnedIds.flatMap((id) => actionById.get(id) ?? []),
    ...actions.filter(
      (action) => action.pressed && !pinnedIds.includes(action.id),
    ),
  ];
  const availableToolbarActions = actions.filter(
    (action) => action.pinable !== false,
  );

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
  const invoke = useCallback(
    (action: ComposerToolItem) => {
      if (action.disabled) return;
      onError(null);
      void Promise.resolve(action.execute()).catch((cause) => {
        onError(
          cause instanceof Error
            ? cause.message
            : agentsT("clearContextFailed"),
        );
      });
    },
    [agentsT, onError],
  );
  const menuItems = actions.filter((action) => !pinnedIds.includes(action.id));
  const slashQuery = /^\/[^\s]*$/.test(composerText)
    ? composerText.slice(1).toLowerCase()
    : null;
  const slashItems = menuItems.filter(
    (item) =>
      !item.disabled &&
      slashQuery !== null &&
      item.label.toLowerCase().includes(slashQuery),
  );
  const slashOpen =
    !disabled && dismissedSlash !== composerText && slashItems.length > 0;
  const selectedSlashIndex = Math.min(
    slashIndex,
    Math.max(0, slashItems.length - 1),
  );
  useEffect(() => {
    if (!slashOpen) return;
    const input = toolsButtonRef.current
      ?.closest('[data-ui="chat.composer"]')
      ?.querySelector("textarea");
    if (!input) return;
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlash(composerText);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : -1) + slashItems.length) %
            slashItems.length,
        );
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        aui.composer.setText("");
        setSlashIndex(0);
        invoke(slashItems[selectedSlashIndex]);
      }
    };
    input.addEventListener("keydown", keyDown, true);
    return () => input.removeEventListener("keydown", keyDown, true);
  }, [
    aui.composer,
    composerText,
    invoke,
    selectedSlashIndex,
    slashItems,
    slashOpen,
  ]);

  return (
    <>
      <MorphPopover
        open={toolsOpen || slashOpen}
        onOpenChange={(open) => {
          setToolsOpen(open);
          if (!open) setDismissedSlash(composerText);
        }}
      >
        <MorphPopoverTrigger>
          <ComposerToolsButton
            ref={toolsButtonRef}
            open={toolsOpen || slashOpen}
            disabled={disabled}
            aria-label={agentsT("openComposerTools")}
            title={agentsT("openComposerTools")}
          />
        </MorphPopoverTrigger>
        <MorphPopoverContent
          side="top"
          align="start"
          sideOffset={8}
          radius={12}
          className="w-56 p-1.5"
        >
          <div role="menu" aria-label={agentsT("tools")}>
            {(slashOpen ? slashItems : menuItems).map((action, index) => {
              const Icon = action.icon;
              const previousGroup = menuItems[index - 1]?.group;
              return (
                <div key={action.id} role="presentation">
                  {action.group && action.group !== previousGroup ? (
                    <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                      {action.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    aria-current={
                      slashOpen && index === selectedSlashIndex
                        ? "true"
                        : undefined
                    }
                    onClick={() => {
                      setToolsOpen(false);
                      if (slashOpen) aui.composer.setText("");
                      invoke(action);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted aria-[current=true]:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      <Icon aria-hidden="true" />
                    </span>
                    <span className="min-w-0 break-words">
                      <span className="block text-sm text-foreground">
                        {action.label}
                      </span>
                      {action.description ? (
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                          {action.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </MorphPopoverContent>
      </MorphPopover>
      <input
        id={attachmentInputId}
        type="file"
        multiple
        hidden
        onChange={(event) => void addAttachments(event)}
      />
      <McpServerPickerButton
        apiPath={mcpResourceApiPath}
        disabled={disabled}
        hideTrigger
        open={mcpOpen}
        onOpenChange={setMcpOpen}
      />
      <McpResourcePickerButton
        apiPath={mcpResourceApiPath}
        disabled={disabled}
        hideTrigger
        onError={onError}
        onInsert={insertText}
        open={mcpResourceOpen}
        onOpenChange={setMcpResourceOpen}
      />
      <McpPromptPickerButton
        apiPath={mcpPromptApiPath}
        disabled={disabled}
        hideTrigger
        onError={onError}
        onInsert={insertText}
        open={mcpPromptOpen}
        onOpenChange={setMcpPromptOpen}
      />
      {toolbarActions.map((action) => {
        const Icon = action.icon;
        return (
          <Button
            key={action.id}
            type="button"
            data-composer-shortcut={action.id}
            disabled={disabled}
            aria-label={action.label}
            aria-pressed={action.pressed}
            title={action.label}
            onClick={() => invoke(action)}
            variant={action.pressed ? "primary" : "ghost"}
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
        options={availableToolbarActions}
        pinnedIds={pinnedIds}
        onChange={saveToolbar}
      />
    </>
  );
}

function useAgentAttachmentAdapter({
  agentId,
  attachmentUploadUrl,
  ensureConversation,
  isHermes,
  onError,
  onUploadingChange,
  runtimeRef,
  sendConversationIdRef,
  draftSnapshotRef,
  recoveryErrorRef,
}: {
  agentId: string;
  attachmentUploadUrl?: string;
  ensureConversation: () => Promise<string>;
  isHermes: boolean;
  onError: (message: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
  runtimeRef: { current: AssistantRuntime | null };
  sendConversationIdRef: { current: string | null };
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
        if (!isHermes && !attachmentUploadUrl) {
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
          let uploadUrl: string;
          if (isHermes) {
            const conversationId =
              sendConversationIdRef.current ?? (await ensureConversation());
            sendConversationIdRef.current = conversationId;
            const query = new URLSearchParams({
              conversationId,
              filename: attachment.file.name,
            });
            uploadUrl = `/api/v1/agents/${agentId}/attachments?${query}`;
          } else {
            if (!attachmentUploadUrl)
              throw new Error(t("attachmentRuntimeRequired"));
            const url = new URL(attachmentUploadUrl, window.location.origin);
            url.searchParams.set("filename", attachment.file.name);
            uploadUrl = `${url.pathname}${url.search}`;
          }
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
            runtimePath?: string;
            size?: number;
            url?: string;
            error?: string;
          };
          const location = isHermes ? result.runtimePath : result.url;
          if (!response.ok || !location) {
            throw new Error(result.error || t("attachmentUploadFailed"));
          }
          const name = result.name || attachment.name;
          const content: AttachmentContentPart[] = isHermes
            ? [
                {
                  type: "text",
                  text: [
                    t("attachmentStoredInHermesWorkspace"),
                    t("attachmentMetadataName", { name }),
                    t("attachmentMetadataPath", { path: location }),
                    t("attachmentMetadataSize", {
                      size: result.size ?? attachment.file.size,
                    }),
                    t("attachmentMetadataType", {
                      type:
                        attachment.contentType || "application/octet-stream",
                    }),
                  ].join("\n"),
                },
              ]
            : [
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
      agentId,
      attachmentUploadUrl,
      draftSnapshotRef,
      ensureConversation,
      isHermes,
      onError,
      onUploadingChange,
      recoveryErrorRef,
      runtimeRef,
      sendConversationIdRef,
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
    <AgentActivity
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
  allowEdit = false,
  allowRegenerate = true,
  apiPath,
  attachmentUploadUrl,
  branchBusy = false,
  branchNavigation = [],
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
  mcpPromptApiPath,
  mcpResourceApiPath,
  onBranchChange,
  onBusyChange,
  onConversationChanged,
  onNewConversation,
  onStartBranch,
  ready,
  reasoningAvailable = false,
  runtimeKind,
  supportsAttachments,
  serverManaged = false,
  webSearchAvailable,
  workSessionId,
}: {
  activeConversationId: string | null;
  agentId: string;
  agentName: string;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  apiPath?: string;
  attachmentUploadUrl?: string;
  branchBusy?: boolean;
  branchNavigation?: ChatBranchNavigation[];
  contextBaseText?: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  creatingConversation: boolean;
  ensureConversation: () => Promise<string>;
  includeConversationIdInBody?: boolean;
  initialReasoningEffort?: ReasoningEffort;
  initialMessages: HermesUIMessage[];
  modelName?: string | null;
  modelPicker?: ReactNode;
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
  supportsAttachments?: boolean;
  serverManaged?: boolean;
  webSearchAvailable?: boolean;
  workSessionId?: string;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const work = useTranslations("console.work");
  const chatAssistants = useTranslations("console.chatAssistants");
  const commandsT = useTranslations("console.runtimeCommands");
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
  const chat = useChat<HermesUIMessage>({
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
  const runtimeErrorCode = (submitError || chat.error?.message)?.match(
    /\bPI_[A-Z_]+\b/,
  )?.[0];
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
    () => expandHermesAssistantMessages(chat.messages),
    [chat.messages],
  );
  const runtimeCommands = useMemo(
    () => sessionRuntimeCommands(runtimeKind ?? "", chat.messages),
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
      if (branchBusy || commandBusy) return;
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
          runtimeKind !== "pi-sdk" &&
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
            sendConversationIdRef.current ?? (await ensureConversation());
          sendConversationIdRef.current = null;
          const response = await fetch(
            `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(nextConversationId)}/commands`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ line: commandLine.trim() }),
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
          sendConversationIdRef.current ?? (await ensureConversation());
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
      branchBusy,
      commandBusy,
      commandsT,
      ensureConversation,
      includeConversationIdInBody,
      onConversationChanged,
      reasoningAvailable,
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
      if (!allowRegenerate || branchBusy) return;
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
      reasoningAvailable,
      reasoningEffort,
      regenerateChat,
      t,
      webSearchAvailable,
      webSearchEnabled,
      workSessionId,
    ],
  );
  const attachmentAdapter = useAgentAttachmentAdapter({
    agentId,
    attachmentUploadUrl,
    ensureConversation,
    isHermes: runtimeKind === "hermes",
    onError: setSubmitError,
    onUploadingChange: setUploadingAttachments,
    runtimeRef: assistantRuntimeRef,
    sendConversationIdRef,
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
    supportsAttachments ??
    (runtimeKind === "hermes" || Boolean(attachmentUploadUrl));
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
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
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
    "size-7 rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex min-h-0 flex-1 flex-col">
        <MessageScroller
          label={agentName}
          busy={chatBusy}
          followOutput={followingOutput}
          onFollowChange={setFollowingOutput}
          navigation="rail"
          className="min-h-0 flex-1"
          contentClassName="mx-auto w-full max-w-3xl p-4"
        >
          {thread.messages.length ? (
            <MessageGroup spacing="default">
              {thread.messages.map((message, messageIndex) => {
                const from = message.role === "user" ? "user" : "assistant";
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
                    {message.content.map((part, index) => {
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
                      const awaiting =
                        part.approval &&
                        part.approval.approved === undefined &&
                        !part.approval.resolution;
                      const tool =
                        /^(?:mcp__)?tp_\d+_[A-Za-z0-9_-]+__(.+)$/.exec(
                          part.toolName,
                        )?.[1] ?? part.toolName;
                      const failed =
                        part.isError ||
                        (partState.status.type === "incomplete" &&
                          partState.status.reason === "error");
                      const cancelled =
                        part.approval?.approved === false ||
                        (partState.status.type === "incomplete" &&
                          partState.status.reason === "cancelled");
                      const runningTool = partState.status.type === "running";
                      if (awaiting) {
                        const decide = (approved: boolean) => {
                          if (approvalBusy) return;
                          setApprovalBusy(part.toolCallId);
                          void runAction(() =>
                            partRuntime.respondToToolApproval({ approved }),
                          ).finally(() => setApprovalBusy(null));
                        };
                        return (
                          <ToolApproval
                            key={part.toolCallId}
                            tool={tool}
                            title={t("toolAwaitingApproval")}
                            description={t("toolApprovalDescription")}
                            status={
                              approvalBusy === part.toolCallId
                                ? "approving"
                                : "pending"
                            }
                            parameters={[
                              {
                                id: "input",
                                label: t("toolInput"),
                                value: (
                                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                                    {part.argsText?.trim() ||
                                      formatToolValue(part.args)}
                                  </pre>
                                ),
                              },
                            ]}
                            onApprove={() => decide(true)}
                            onDeny={() => decide(false)}
                          />
                        );
                      }
                      return (
                        <ToolResult
                          key={part.toolCallId}
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
                          copyText={formatToolValue(part.result)}
                        >
                          <p className="text-xs text-muted-foreground">
                            {t("toolInput")}
                          </p>
                          <ToolResultOutput language="json">
                            {part.argsText?.trim() ||
                              formatToolValue(part.args)}
                          </ToolResultOutput>
                          {part.result !== undefined ? (
                            <>
                              <p className="text-xs text-muted-foreground">
                                {t("toolOutput")}
                              </p>
                              <ToolResultOutput
                                language={
                                  typeof part.result === "string"
                                    ? "text"
                                    : "json"
                                }
                              >
                                {formatToolValue(part.result)}
                              </ToolResultOutput>
                            </>
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
                  <Message
                    key={message.id}
                    id={`chat-message-${message.id}`}
                    from={from}
                    aria-busy={streaming || undefined}
                  >
                    <MessageAvatar>
                      {from === "user" ? <UserRound /> : <Bot />}
                    </MessageAvatar>
                    <MessageContent>
                      <MessageHeader>
                        {from === "user" ? t("user") : agentName}
                      </MessageHeader>
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
                        <MessageBubble variant="soft">
                          <MessageBubbleContent>
                            {messageBody}
                          </MessageBubbleContent>
                        </MessageBubble>
                      )}
                      {from === "user" && editingId !== message.id ? (
                        <MessageFooter
                          className={`gap-0.5 ${actionVisibility}`}
                        >
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
                    </MessageContent>
                  </Message>
                );
              })}
            </MessageGroup>
          ) : (
            <div className="flex min-h-64 items-center justify-center text-center">
              <div className="max-w-md">
                <Bot className="mx-auto mb-4 size-8 text-muted-foreground" />
                <h3 className="text-lg font-medium">
                  {t(
                    workSessionId
                      ? "startWorkConversation"
                      : "startAConversation",
                  )}
                </h3>
                {workSessionId ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("startWorkConversationDescription")}
                  </p>
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
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2">
          {submitError || chat.error?.message ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {runtimeErrorCode
                ? commandsT(
                    commandsT.has(runtimeErrorCode)
                      ? runtimeErrorCode
                      : "sdkExecutionFailed",
                  )
                : submitError || chat.error?.message}
            </p>
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
            {composer.attachments.length ? (
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
            ) : null}
            <PromptInput
              className="bg-transparent"
              value={composer.text}
              onValueChange={runtime.thread.composer.setText}
              onSubmit={() => runtime.thread.composer.send()}
              disabled={!ready || composerDisabled}
              loading={busy}
              onStop={chatBusy ? () => void stop() : undefined}
              aria-label={t("messageThisAgent")}
              placeholder={t("messageThisAgent")}
              minRows={2}
              maxRows={8}
              leadingAction={
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <ConversationTools
                    attachmentsEnabled={attachmentsEnabled}
                    disabled={blocked}
                    mcpPromptApiPath={mcpPromptApiPath}
                    mcpResourceApiPath={mcpResourceApiPath}
                    onError={setSubmitError}
                    onNewConversation={onNewConversation}
                    runtimeCommands={runtimeCommands}
                    webSearchAvailable={Boolean(webSearchAvailable)}
                    webSearchEnabled={webSearchEnabled}
                    onWebSearchChange={setWebSearchEnabled}
                  />
                  {modelPicker}
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
                </div>
              }
            />
          </div>
          {composerStatus ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {composerStatus}
            </p>
          ) : null}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
