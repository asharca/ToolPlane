'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useChat } from '@ai-sdk/react';
import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
  useAui,
  type AppendMessage,
  type AssistantRuntime,
  type AttachmentAdapter,
  type CompleteAttachment,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { DefaultChatTransport, generateId, type CreateUIMessage, type UIMessage } from 'ai';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Database,
  Eraser,
  Globe2,
  Paperclip,
  Plus,
  RotateCcw,
  ScrollText,
  Server,
  SlidersHorizontal,
  TerminalSquare,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  ChatThread,
  type ChatThreadLabels,
} from '@asharca/ui';
import { ConversationContextUsage } from '@/components/dashboard/ConversationComposer';
import { McpPromptPickerButton } from '@/components/dashboard/McpPromptPickerButton';
import { McpResourcePickerButton } from '@/components/dashboard/McpResourcePickerButton';
import { McpServerPickerButton } from '@/components/dashboard/McpServerPickerButton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';
import { resolveContextUsage } from '@/lib/context-usage';
import type { ChatBranchNavigation } from '@/lib/chat/branches';
import type { ReasoningEffort } from '@/lib/agents/constants';
import { ReasoningEffortControl } from '@/components/dashboard/agents/ReasoningEffortControl';
import { displayMessagingUserText } from '@/lib/agents/messaging';
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';
import {
  parseRuntimeCommand,
  sessionRuntimeCommands,
  type RuntimeCommand,
} from '@/lib/agents/runtime-commands';

const MAX_ATTACHMENTS = 5;
const ATTACHMENT_ERROR_PART = 'data-toolplane-attachment-error';

type AttachmentContentPart = CompleteAttachment['content'][number];
type DraftSnapshot = {
  text: string;
  files: File[];
};

function toChatCreateMessage<UI_MESSAGE extends UIMessage = UIMessage>(
  message: AppendMessage,
): CreateUIMessage<UI_MESSAGE> {
  const inputParts = [
    ...message.content.filter((part) => part.type !== 'file'),
    ...(message.attachments?.flatMap((attachment) => attachment.content.map((part) => ({
      ...part,
      filename: attachment.name,
    }))) ?? []),
  ];
  const parts = inputParts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') {
      return { type: 'file', url: part.image, mediaType: 'image/png', ...(part.filename ? { filename: part.filename } : {}) };
    }
    if (part.type === 'file') {
      return { type: 'file', url: part.data, mediaType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) };
    }
    if (part.type === 'data') return { type: `data-${part.name}`, data: part.data };
    throw new Error(`Unsupported message part: ${part.type}`);
  });
  return {
    role: message.role,
    parts,
    metadata: message.sourceId
      ? {
          ...(message.metadata && typeof message.metadata === 'object' ? message.metadata : {}),
          toolplaneEditMessageId: message.sourceId,
        }
      : message.metadata,
  } as unknown as CreateUIMessage<UI_MESSAGE>;
}

function mergeDraftText(current: string, restored: string) {
  if (!restored) return current;
  if (!current) return restored;
  if (current === restored || current.startsWith(`${restored}\n`)) return current;
  return `${restored}\n${current}`;
}

async function restoreDraftSnapshot(runtime: AssistantRuntime, snapshot: DraftSnapshot) {
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, snapshot.text));
  const existingFiles = new Set(
    current.attachments.flatMap((attachment) => attachment.file
      ? [`${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`]
      : []),
  );
  for (const file of snapshot.files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingFiles.has(key)) continue;
    await composer.addAttachment(file);
    existingFiles.add(key);
  }
}

async function restoreCreateMessageDraft(runtime: AssistantRuntime | null, message: unknown) {
  if (!runtime || !message || typeof message !== 'object') return;
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
    typeof candidate.text === 'string' ? candidate.text : '',
    ...parts.flatMap((part) => part.type === 'text' && typeof part.text === 'string'
      ? [part.text]
      : []),
  ].filter(Boolean).join('\n');
  const composer = runtime.thread.composer;
  const current = composer.getState();
  composer.setText(mergeDraftText(current.text, text));

  for (const part of parts) {
    if (
      part.type !== 'file'
      || typeof part.url !== 'string'
      || typeof part.mediaType !== 'string'
    ) continue;
    const name = typeof part.filename === 'string' ? part.filename : 'attachment';
    await composer.addAttachment({
      name,
      type: part.mediaType.startsWith('image/') ? 'image' : 'file',
      contentType: part.mediaType,
      content: [{
        type: 'file',
        data: part.url,
        mimeType: part.mediaType,
        filename: name,
      }],
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

const TOOLBAR_STORAGE_KEY = 'toolplane.conversation.composer.toolbar';
const TOOLBAR_EVENT = 'toolplane:conversation-composer-toolbar';

function subscribeToolbar(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(TOOLBAR_EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(TOOLBAR_EVENT, listener);
  };
}

function readToolbar() {
  try {
    return window.localStorage.getItem(TOOLBAR_STORAGE_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

function focusComposerInput() {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-ui="chat.composer"] textarea');
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
  const t = useTranslations('console.runtimeCommands');
  const agentsT = useTranslations('console.agents');
  const common = useTranslations('common');
  const aui = useAui();
  const [mcpPromptOpen, setMcpPromptOpen] = useState(false);
  const [mcpResourceOpen, setMcpResourceOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const attachmentInputId = useId();
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarValue = useSyncExternalStore(subscribeToolbar, readToolbar, () => '[]');

  useLayoutEffect(() => {
    const legacyTrigger = toolsButtonRef.current?.previousElementSibling;
    if (!(legacyTrigger instanceof HTMLButtonElement)) return;
    const wasHidden = legacyTrigger.hidden;
    const previousTabIndex = legacyTrigger.getAttribute('tabindex');
    legacyTrigger.hidden = true;
    legacyTrigger.tabIndex = -1;
    return () => {
      legacyTrigger.hidden = wasHidden;
      if (previousTabIndex === null) legacyTrigger.removeAttribute('tabindex');
      else legacyTrigger.setAttribute('tabindex', previousTabIndex);
    };
  }, []);

  const setCommandText = useCallback((text: string) => {
    aui.composer.setText(text);
    focusComposerInput();
  }, [aui.composer]);
  const insertText = useCallback((text: string) => {
    const current = aui.composer.getState();
    aui.composer.setText(mergeDraftText(current.text, text));
    focusComposerInput();
  }, [aui.composer]);
  const addAttachments = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    for (const file of files) {
      try {
        await aui.composer.addAttachment(file);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : agentsT('attachmentUploadFailed'));
      }
    }
    focusComposerInput();
  }, [agentsT, aui.composer, onError]);
  const openAttachmentPicker = useCallback(() => {
    if (!attachmentsEnabled) {
      onError(agentsT('attachmentRuntimeRequired'));
      return;
    }
    document.getElementById(attachmentInputId)?.click();
  }, [agentsT, attachmentInputId, attachmentsEnabled, onError]);
  const clearRuntimeCommand = runtimeCommands.find((command) => command.name === 'clear');
  const actions = useMemo<ComposerToolItem[]>(() => [
    {
      id: 'attachments',
      label: agentsT('addAttachment'),
      description: attachmentsEnabled ? undefined : agentsT('attachmentRuntimeRequired'),
      disabled: !attachmentsEnabled,
      icon: Paperclip,
      execute: openAttachmentPicker,
    },
    ...(mcpResourceApiPath ? [{
      id: 'mcp',
      label: agentsT('mcp'),
      icon: Server,
      group: agentsT('mcp'),
      execute: () => setMcpOpen(true),
    }] : []),
    ...(mcpResourceApiPath ? [{
      id: 'mcp-resources',
      label: agentsT('mcpResources'),
      icon: Database,
      group: agentsT('mcp'),
      execute: () => setMcpResourceOpen(true),
    }] : []),
    ...(mcpPromptApiPath ? [{
      id: 'mcp-prompts',
      label: agentsT('mcpPrompts'),
      icon: ScrollText,
      group: agentsT('mcp'),
      execute: () => setMcpPromptOpen(true),
    }] : []),
    ...(clearRuntimeCommand || onNewConversation ? [{
      id: 'clear-context',
      label: agentsT('clearContext'),
      description: agentsT('clearContextDescription'),
      icon: Eraser,
      execute: clearRuntimeCommand
        ? () => setCommandText('/clear ')
        : () => onNewConversation?.(),
    }] : []),
    ...(webSearchAvailable ? [{
      id: 'web-search',
      label: webSearchEnabled ? agentsT('disableWebSearch') : agentsT('enableWebSearch'),
      icon: Globe2,
      pressed: webSearchEnabled,
      execute: () => onWebSearchChange(!webSearchEnabled),
    }] : []),
    ...runtimeCommands.filter((command) => command.name !== 'clear').map((command) => ({
      id: `runtime:${command.name}`,
      label: `/${command.name}`,
      description: t.has(`descriptions.${command.name}`)
        ? t(`descriptions.${command.name}`)
        : command.description,
      icon: TerminalSquare,
      group: t('title'),
      execute: () => setCommandText(`/${command.name} `),
    })),
    {
      id: 'customize-toolbar',
      label: agentsT('customizeToolbar'),
      icon: SlidersHorizontal,
      pinable: false,
      execute: () => setCustomizing(true),
    },
  ], [agentsT, attachmentsEnabled, clearRuntimeCommand, mcpPromptApiPath, mcpResourceApiPath, onNewConversation, onWebSearchChange, openAttachmentPicker, runtimeCommands, setCommandText, t, webSearchAvailable, webSearchEnabled]);
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const toolbarIds = useMemo(() => {
    try {
      const stored: unknown = JSON.parse(toolbarValue);
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }, [toolbarValue]);
  const pinnedIds = [...new Set(toolbarIds)].filter((id) => actionById.get(id)?.pinable !== false);
  const pinnedActions = pinnedIds.flatMap((id) => actionById.get(id) ?? []);
  const availableToolbarActions = actions.filter((action) => action.pinable !== false);

  const saveToolbar = useCallback((ids: string[]) => {
    try {
      window.localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(ids));
      window.dispatchEvent(new Event(TOOLBAR_EVENT));
    } catch {
      onError(agentsT('toolbarSaveFailed'));
    }
  }, [agentsT, onError]);
  const moveShortcut = useCallback((index: number, offset: number) => {
    const next = [...pinnedIds];
    const [id] = next.splice(index, 1);
    next.splice(index + offset, 0, id);
    saveToolbar(next);
  }, [pinnedIds, saveToolbar]);
  const invoke = useCallback((action: ComposerToolItem) => {
    if (action.disabled) return;
    onError(null);
    void Promise.resolve(action.execute()).catch((cause) => {
      onError(cause instanceof Error ? cause.message : agentsT('clearContextFailed'));
    });
  }, [agentsT, onError]);
  const menuItems = actions.filter((action) => !pinnedIds.includes(action.id));
  const slashItems = menuItems.filter((item) => !item.disabled);
  const slashItemsById = new Map(slashItems.map((item) => [item.id, item]));
  const slash = unstable_useSlashCommandAdapter({
    commands: slashItems.map(({ id, label, description }) => ({
      id,
      label,
      description,
      execute: () => invoke(slashItemsById.get(id)!),
    })),
    removeOnExecute: true,
  });

  return (
    <>
      <Popover.Root open={toolsOpen} onOpenChange={setToolsOpen}>
        <Popover.Trigger asChild>
          <button
            ref={toolsButtonRef}
            type="button"
            disabled={disabled}
            aria-label={agentsT('openComposerTools')}
            aria-expanded={toolsOpen}
            aria-haspopup="menu"
            title={agentsT('openComposerTools')}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-[18px]" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            role="menu"
            aria-label={agentsT('composerTools')}
            className="z-50 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {menuItems.map((action, index) => {
              const Icon = action.icon;
              const previousGroup = menuItems[index - 1]?.group;
              return (
                <div key={action.id} role="presentation">
                  {action.group && action.group !== previousGroup ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{action.group}</p> : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    onClick={() => {
                      setToolsOpen(false);
                      invoke(action);
                    }}
                    className={`flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${action.pressed ? 'bg-brand/10 text-brand' : ''}`}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{action.label}</span>
                      {action.description ? <span className="block truncate text-xs text-muted-foreground">{action.description}</span> : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <input id={attachmentInputId} type="file" multiple hidden onChange={(event) => void addAttachments(event)} />
      {!disabled && slashItems.length ? (
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slash.adapter}
          aria-label={agentsT('composerTools')}
          matcher={(text, triggerChar, cursorPosition) => {
            if (cursorPosition < triggerChar.length || !text.startsWith(triggerChar)) return null;
            const query = text.slice(triggerChar.length, cursorPosition);
            if (/\s/.test(query)) return null;
            const normalized = query.toLowerCase();
            if (normalized && !slashItems.some((item) => item.label.toLowerCase().includes(normalized))) return null;
            return { query, offset: 0, endOffset: cursorPosition };
          }}
          className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[min(24rem,50dvh)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => items.map((item, index) => {
              const action = slashItemsById.get(item.id);
              if (!action) return null;
              const Icon = action.icon;
              const previousGroup = slashItemsById.get(items[index - 1]?.id)?.group;
              return (
                <div key={item.id} role="presentation">
                  {action.group && action.group !== previousGroup ? <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{action.group}</p> : null}
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    item={item}
                    className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted data-[highlighted]:bg-muted"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{item.label}</span>
                      {item.description ? <span className="block truncate text-xs text-muted-foreground">{item.description}</span> : null}
                    </span>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                </div>
              );
            })}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
      ) : null}
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
      {pinnedActions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            data-composer-shortcut={action.id}
            disabled={disabled}
            aria-label={action.label}
            aria-pressed={action.pressed}
            title={action.label}
            onClick={() => invoke(action)}
            className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${action.pressed
              ? 'bg-brand/10 text-brand'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            <Icon className="size-[17px]" />
          </button>
        );
      })}
      <Dialog open={customizing} onOpenChange={setCustomizing}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent aria-describedby={undefined} className="!z-[51] !max-h-[calc(100dvh-2rem)] !max-w-md !overflow-y-auto !rounded-lg">
            <header className="flex items-center justify-between gap-3">
              <DialogTitle className="!text-base !tracking-normal">{agentsT('customizeToolbar')}</DialogTitle>
              <DialogClose asChild>
                <button type="button" aria-label={common('close')} title={common('close')} className="ui-button-ghost ui-icon-button">
                  <X className="size-4" />
                </button>
              </DialogClose>
            </header>
            <div className="mt-3 divide-y divide-border">
              {[...pinnedActions, ...availableToolbarActions.filter((action) => !pinnedIds.includes(action.id))].map((action) => {
                const index = pinnedIds.indexOf(action.id);
                const Icon = action.icon;
                return (
                  <div key={action.id} className="flex min-h-11 items-center gap-2 py-1">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={index >= 0}
                        onChange={(event) => saveToolbar(event.target.checked
                          ? [...pinnedIds, action.id]
                          : pinnedIds.filter((id) => id !== action.id))}
                        className="accent-brand"
                      />
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 break-words">{action.label}</span>
                    </label>
                    {index >= 0 ? (
                      <>
                        <button type="button" disabled={index === 0} aria-label={agentsT('moveShortcutUp', { name: action.label })} title={agentsT('moveShortcutUp', { name: action.label })} onClick={() => moveShortcut(index, -1)} className="ui-button-ghost ui-icon-button">
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button type="button" disabled={index === pinnedIds.length - 1} aria-label={agentsT('moveShortcutDown', { name: action.label })} title={agentsT('moveShortcutDown', { name: action.label })} onClick={() => moveShortcut(index, 1)} className="ui-button-ghost ui-icon-button">
                          <ArrowDown className="size-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <footer className="mt-3 flex justify-end border-t border-border pt-3">
              <button type="button" disabled={!pinnedIds.length} onClick={() => saveToolbar([])} className="ui-button-secondary text-xs">
                <RotateCcw className="size-3.5" />
                {agentsT('resetToolbar')}
              </button>
            </footer>
          </DialogContent>
        </DialogPortal>
      </Dialog>
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
  const t = useTranslations('console.agents');
  const activeAttachmentIds = useRef(new Set<string>());
  const activeSends = useRef(0);

  return useMemo<AttachmentAdapter>(() => ({
    accept: '*',
    async add({ file }) {
      if (!isHermes && !attachmentUploadUrl) {
        const message = t('attachmentRuntimeRequired');
        onError(message);
        throw new Error(message);
      }
      if (activeAttachmentIds.current.size >= MAX_ATTACHMENTS) {
        const message = t('attachmentLimitReached', { count: MAX_ATTACHMENTS });
        onError(message);
        throw new Error(message);
      }

      const id = generateId();
      activeAttachmentIds.current.add(id);
      return {
        id,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name,
        file,
        contentType: file.type || 'application/octet-stream',
        content: [],
        status: { type: 'requires-action', reason: 'composer-send' },
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
            files: state.attachments.flatMap((item) => item.file ? [item.file] : []),
          };
        }
      }
      activeSends.current += 1;
      onUploadingChange(true);
      onError(null);
      try {
        let uploadUrl: string;
        if (isHermes) {
          const conversationId = sendConversationIdRef.current ?? await ensureConversation();
          sendConversationIdRef.current = conversationId;
          const query = new URLSearchParams({
            conversationId,
            filename: attachment.file.name,
          });
          uploadUrl = `/api/v1/agents/${agentId}/attachments?${query}`;
        } else {
          if (!attachmentUploadUrl) throw new Error(t('attachmentRuntimeRequired'));
          const url = new URL(attachmentUploadUrl, window.location.origin);
          url.searchParams.set('filename', attachment.file.name);
          uploadUrl = `${url.pathname}${url.search}`;
        }
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'content-type': attachment.contentType || 'application/octet-stream',
          },
          body: attachment.file,
        });
        const result = await response.json().catch(() => ({})) as {
          name?: string;
          mimeType?: string;
          runtimePath?: string;
          size?: number;
          url?: string;
          error?: string;
        };
        if (!response.ok || (isHermes ? !result.runtimePath : !result.url)) {
          throw new Error(result.error || t('attachmentUploadFailed'));
        }
        const name = result.name || attachment.name;
        const content: AttachmentContentPart[] = isHermes
          ? [{
              type: 'text',
              text: [
                t('attachmentStoredInHermesWorkspace'),
                t('attachmentMetadataName', { name }),
                t('attachmentMetadataPath', { path: result.runtimePath! }),
                t('attachmentMetadataSize', { size: result.size ?? attachment.file.size }),
                t('attachmentMetadataType', { type: attachment.contentType || 'application/octet-stream' }),
              ].join('\n'),
            }]
          : [{
              type: 'file',
              data: result.url!,
              mimeType: result.mimeType || attachment.contentType || 'application/octet-stream',
              filename: name,
            }];

        return {
          ...attachment,
          status: { type: 'complete' },
          content,
        };
      } catch (error) {
        const message = error instanceof Error
          ? error.message === 'conversation'
            ? t('couldNotCreateConversation')
            : error.message
          : t('attachmentUploadFailed');
        recoveryErrorRef.current = message;
        onError(message);
        return {
          ...attachment,
          status: { type: 'complete' },
          content: [{
            type: 'data',
            name: ATTACHMENT_ERROR_PART.slice(5),
            data: { message },
          }],
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
  }), [agentId, attachmentUploadUrl, draftSnapshotRef, ensureConversation, isHermes, onError, onUploadingChange, recoveryErrorRef, runtimeRef, sendConversationIdRef, t]);
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
  initialReasoningEffort = 'default',
  initialMessages,
  modelName,
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
  webSearchAvailable?: boolean;
  workSessionId?: string;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const work = useTranslations('console.work');
  const chatAssistants = useTranslations('console.chatAssistants');
  const commandsT = useTranslations('console.runtimeCommands');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initialReasoningEffort);
  const assistantRuntimeRef = useRef<AssistantRuntime | null>(null);
  const sendConversationIdRef = useRef<string | null>(null);
  const attachmentDraftSnapshotRef = useRef<DraftSnapshot | null>(null);
  const attachmentRecoveryErrorRef = useRef<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: apiPath ?? `/api/v1/agents/${agentId}/chat`,
    ...(!includeConversationIdInBody ? {
      prepareSendMessagesRequest: ({ body, messageId, messages, trigger }) => {
        const editMessageId = (messages.at(-1)?.metadata as { toolplaneEditMessageId?: unknown } | undefined)
          ?.toolplaneEditMessageId;
        return {
          body: {
            ...body,
            messageId: messageId ?? (typeof editMessageId === 'string' ? editMessageId : undefined),
            messages: messages.slice(-1),
            trigger,
          },
        };
      },
    } : {}),
  }), [agentId, apiPath, includeConversationIdInBody]);
  const chat = useChat<HermesUIMessage>({
    transport,
    messages: initialMessages,
    onFinish: () => { void onConversationChanged?.(); },
  });
  const chatBusy = chat.status === 'submitted' || chat.status === 'streaming';
  const busy = chatBusy || commandBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const contextUsage = useMemo(() => resolveContextUsage(chat.messages, {
    maxTokens: contextWindow,
    modelName,
    context: contextBaseText,
    estimated: contextWindowEstimated,
  }), [chat.messages, contextBaseText, contextWindow, contextWindowEstimated, modelName]);

  const displayMessages = useMemo(
    () => expandHermesAssistantMessages(chat.messages),
    [chat.messages],
  );
  const runtimeCommands = useMemo(
    () => sessionRuntimeCommands(runtimeKind ?? '', chat.messages),
    [chat.messages, runtimeKind],
  );
  const initialMessagesSignature = useMemo(
    () => JSON.stringify(initialMessages),
    [initialMessages],
  );
  const setChatMessages = chat.setMessages;
  const lastInitialMessagesSignatureRef = useRef(initialMessagesSignature);
  useEffect(() => {
    if (lastInitialMessagesSignatureRef.current === initialMessagesSignature) return;
    lastInitialMessagesSignatureRef.current = initialMessagesSignature;
    setChatMessages(initialMessages);
  }, [initialMessages, initialMessagesSignature, setChatMessages]);
  const sendChatMessage = chat.sendMessage;
  const regenerateChat = chat.regenerate;
  const sendMessage = useCallback<typeof chat.sendMessage>(async (message, options) => {
    if (branchBusy || commandBusy) return;
    setSubmitError(null);
    const messageParts = message && typeof message === 'object'
      && 'parts' in message && Array.isArray(message.parts)
      ? message.parts as Array<{ type: string; text?: unknown }>
      : [];
    const attachmentFailed = messageParts.some((part) => part.type === ATTACHMENT_ERROR_PART);
    if (attachmentFailed) {
      const snapshot = attachmentDraftSnapshotRef.current;
      const errorMessage = attachmentRecoveryErrorRef.current ?? t('attachmentUploadFailed');
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
      .filter((part): part is { type: string; text: string } => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const command = runtimeCommands.length ? parseRuntimeCommand(commandLine) : null;
    if (command) {
      if (!runtimeCommands.some((item) => item.name === command.name)) {
        setSubmitError(commandsT('unsupportedCommand'));
        await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
        return;
      }
      if (messageParts.some((part) => part.type !== 'text')) {
        setSubmitError(commandsT('noAttachments'));
        await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
        return;
      }
      setCommandBusy(true);
      try {
        const nextConversationId = sendConversationIdRef.current ?? await ensureConversation();
        sendConversationIdRef.current = null;
        const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(nextConversationId)}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ line: commandLine.trim() }),
        });
        const result = await response.json().catch(() => ({})) as { error?: unknown };
        if (!response.ok) {
          const error = typeof result.error === 'string' ? result.error : '';
          throw new Error(error && commandsT.has(error) ? commandsT(error) : error || commandsT('failed'));
        }
        void onConversationChanged?.();
      } catch (cause) {
        sendConversationIdRef.current = null;
        setSubmitError(cause instanceof Error ? cause.message : commandsT('failed'));
        await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
      } finally {
        setCommandBusy(false);
      }
      return;
    }
    let nextConversationId: string;
    try {
      nextConversationId = sendConversationIdRef.current ?? await ensureConversation();
      sendConversationIdRef.current = null;
    } catch {
      sendConversationIdRef.current = null;
      setSubmitError(t('couldNotCreateConversation'));
      await restoreCreateMessageDraft(assistantRuntimeRef.current, message);
      return;
    }
    await sendChatMessage(message, {
      ...options,
      body: {
        ...options?.body,
        ...(includeConversationIdInBody ? { conversationId: nextConversationId } : {}),
        ...(workSessionId ? { workSessionId } : {}),
        ...(webSearchAvailable !== undefined
          ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
          : {}),
        ...(reasoningAvailable ? { reasoningEffort } : {}),
      },
    });
  }, [agentId, branchBusy, commandBusy, commandsT, ensureConversation, includeConversationIdInBody, onConversationChanged, reasoningAvailable, reasoningEffort, runtimeCommands, sendChatMessage, t, webSearchAvailable, webSearchEnabled, workSessionId]);
  const regenerate = useCallback<typeof chat.regenerate>(async (options) => {
    if (!allowRegenerate || branchBusy) return;
    setSubmitError(null);
    let nextConversationId: string;
    try {
      nextConversationId = activeConversationId ?? await ensureConversation();
    } catch {
      setSubmitError(t('couldNotCreateConversation'));
      return;
    }
    await regenerateChat({
      ...options,
      body: {
        ...options?.body,
        ...(includeConversationIdInBody ? { conversationId: nextConversationId } : {}),
        ...(workSessionId ? { workSessionId } : {}),
        ...(webSearchAvailable !== undefined
          ? { webSearchEnabled: webSearchAvailable && webSearchEnabled }
          : {}),
        ...(reasoningAvailable ? { reasoningEffort } : {}),
      },
    });
  }, [activeConversationId, allowRegenerate, branchBusy, ensureConversation, includeConversationIdInBody, reasoningAvailable, reasoningEffort, regenerateChat, t, webSearchAvailable, webSearchEnabled, workSessionId]);
  const attachmentAdapter = useAgentAttachmentAdapter({
    agentId,
    attachmentUploadUrl,
    ensureConversation,
    isHermes: runtimeKind === 'hermes',
    onError: setSubmitError,
    onUploadingChange: setUploadingAttachments,
    runtimeRef: assistantRuntimeRef,
    sendConversationIdRef,
    draftSnapshotRef: attachmentDraftSnapshotRef,
    recoveryErrorRef: attachmentRecoveryErrorRef,
  });
  const assistantChat = useMemo(() => ({
    ...chat,
    messages: displayMessages,
    sendMessage,
    regenerate,
  }), [chat, displayMessages, regenerate, sendMessage]);
  const runtime = useAISDKRuntime(assistantChat, {
    adapters: { attachments: attachmentAdapter },
    isSendDisabled: !ready || branchBusy || commandBusy || creatingConversation || uploadingAttachments,
    joinStrategy: 'none',
    // Preserve internal attachment URLs; the default converter treats relative paths as base64.
    toCreateMessage: toChatCreateMessage,
  });
  useEffect(() => {
    assistantRuntimeRef.current = runtime;
    return () => {
      if (assistantRuntimeRef.current === runtime) assistantRuntimeRef.current = null;
    };
  }, [runtime]);

  const composerDisabled = branchBusy || commandBusy || creatingConversation || uploadingAttachments;
  const attachmentsEnabled = supportsAttachments
    ?? (runtimeKind === 'hermes' || Boolean(attachmentUploadUrl));
  const composerStatus = !ready
    ? t('chooseAModelBeforeSending')
    : uploadingAttachments
      ? t('uploadingAttachments')
      : !activeConversationId
        ? t('conversationWillBeCreated')
        : null;
  const threadLabels = useMemo<ChatThreadLabels>(() => ({
    addAttachment: t('addAttachment'),
    allowTool: t('toolAllow'),
    attachment: t('attachment'),
    attachmentsUnavailable: t('attachmentRuntimeRequired'),
    cancel: common('cancel'),
    composerTools: t('composerTools'),
    conversationBranch: t('conversationBranch'),
    copy: common('copy'),
    edit: common('edit'),
    expandComposer: t('expandComposer'),
    generatingReply: work('generatingReply'),
    messagePlaceholder: t('messageThisAgent'),
    next: common('next'),
    openComposerTools: t('openComposerTools'),
    preparingReply: work('preparingReply'),
    previous: common('previous'),
    processFailed: work('processFailed'),
    processed: work('processed'),
    processing: work('processing'),
    regenerate: common('regenerate'),
    rejectTool: t('toolReject'),
    removeAttachment: (name) => t('removeAttachment', { name }),
    restoreComposer: t('restoreComposer'),
    save: common('save'),
    scrollToLatestMessage: t('scrollToLatestMessage'),
    send: t('send'),
    startBranch: chatAssistants('newBranch'),
    startConversation: workSessionId ? t('startWorkConversation') : t('startAConversation'),
    stop: t('stop'),
    thinking: work('thinking'),
    thought: work('thought'),
    toolApprovalDescription: t('toolApprovalDescription'),
    toolAwaitingApproval: t('toolAwaitingApproval'),
    toolCompleted: t('toolCompleted'),
    toolFailed: t('toolFailed'),
    toolInput: t('toolInput'),
    toolKindMcp: t('toolKindMcp'),
    toolKindSandbox: t('toolKindSandbox'),
    toolKindSkill: t('toolKindSkill'),
    toolKindSubagent: t('toolKindSubagent'),
    toolKindTool: t('toolKindTool'),
    toolKindWeb: t('toolKindWeb'),
    toolOutput: t('toolOutput'),
    toolRunning: t('toolRunning'),
    user: t('user'),
    usingTool: (toolName) => work('usingTool', { tool: toolName }),
  }), [chatAssistants, common, t, work, workSessionId]);

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ChatThread
        runtime={runtime}
        assistantName={agentName}
        className="toolplane-unified-composer-tools"
        allowAttachments={attachmentsEnabled}
        allowEdit={allowEdit}
        allowRegenerate={allowRegenerate}
        branchNavigation={branchNavigation}
        busy={branchBusy || commandBusy}
        disabled={!ready || composerDisabled}
        error={submitError || chat.error?.message}
        labels={threadLabels}
        transformUserText={displayMessagingUserText}
        onBranchSelect={onBranchChange}
        onBranchStart={onStartBranch}
        onRegenerateMessage={!includeConversationIdInBody
          ? (messageId) => void regenerate({ messageId })
          : undefined}
        composerTools={(
          <ConversationTools
            attachmentsEnabled={attachmentsEnabled}
            disabled={!ready || composerDisabled}
            mcpPromptApiPath={mcpPromptApiPath}
            mcpResourceApiPath={mcpResourceApiPath}
            onError={setSubmitError}
            onNewConversation={onNewConversation}
            runtimeCommands={runtimeCommands}
            webSearchAvailable={Boolean(webSearchAvailable)}
            webSearchEnabled={webSearchEnabled}
            onWebSearchChange={setWebSearchEnabled}
          />
        )}
        composerStatus={composerStatus}
        composerEnd={<>
          <ConversationContextUsage busy={busy} usage={contextUsage} />
          {reasoningAvailable ? (
            <ReasoningEffortControl
              value={reasoningEffort}
              disabled={composerDisabled}
              onChange={setReasoningEffort}
            />
          ) : null}
        </>}
        emptyState={workSessionId ? (
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Bot className="size-6" />
            </div>
            <h3 className="text-lg font-medium text-foreground">{t('startWorkConversation')}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('startWorkConversationDescription')}</p>
          </div>
        ) : undefined}
      />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
