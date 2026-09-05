'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChat } from '@ai-sdk/react';
import {
  useComposerRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type AttachmentAdapter,
  type CompleteAttachment,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { DefaultChatTransport, generateId, type CreateUIMessage, type UIMessage } from 'ai';
import { Bot, Globe2 } from 'lucide-react';
import {
  ChatThread,
  type ChatThreadLabels,
} from '@asharca/ui';
import { ConversationContextUsage } from '@/components/dashboard/ConversationComposer';
import { McpPromptPickerButton } from '@/components/dashboard/McpPromptPickerButton';
import { resolveContextUsage } from '@/lib/context-usage';
import type { ChatBranchNavigation } from '@/lib/chat/branches';
import type { ReasoningEffort } from '@/lib/agents/constants';
import { ReasoningEffortControl } from '@/components/dashboard/agents/ReasoningEffortControl';
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';

const MAX_ATTACHMENTS = 5;
const ATTACHMENT_ERROR_PART = 'data-toolplane-attachment-error';

type AttachmentContentPart = CompleteAttachment['content'][number];
type DraftSnapshot = {
  text: string;
  files: File[];
};

function displayUserText(text: string) {
  return text.replace(/^\[Messaging source:[^\]]+\]\n\n/, '').trim() || text;
}

function toEditableCreateMessage<UI_MESSAGE extends UIMessage = UIMessage>(
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

function ComposerMcpPromptPickerButton({
  apiPath,
  disabled,
  onError,
}: {
  apiPath?: string;
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const composer = useComposerRuntime();
  return (
    <McpPromptPickerButton
      apiPath={apiPath}
      disabled={disabled}
      onError={onError}
      onInsert={(text) => {
        const current = composer.getState();
        composer.setText(mergeDraftText(current.text, text));
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('[data-ui="chat.composer"] textarea')?.focus();
        });
      }}
    />
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
  onBranchChange,
  onBusyChange,
  onConversationChanged,
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
  onBranchChange?: (messageId: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onConversationChanged?: () => void | Promise<void>;
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
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
  useEffect(() => {
    onBusyChange?.(chatBusy);
    return () => onBusyChange?.(false);
  }, [chatBusy, onBusyChange]);
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
    if (branchBusy) return;
    setSubmitError(null);
    const messageParts = message && typeof message === 'object'
      && 'parts' in message && Array.isArray(message.parts)
      ? message.parts as Array<{ type: string }>
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
  }, [branchBusy, ensureConversation, includeConversationIdInBody, reasoningAvailable, reasoningEffort, sendChatMessage, t, webSearchAvailable, webSearchEnabled, workSessionId]);
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
    isSendDisabled: !ready || branchBusy || creatingConversation || uploadingAttachments,
    joinStrategy: 'none',
    ...(allowEdit ? { toCreateMessage: toEditableCreateMessage } : {}),
  });
  useEffect(() => {
    assistantRuntimeRef.current = runtime;
    return () => {
      if (assistantRuntimeRef.current === runtime) assistantRuntimeRef.current = null;
    };
  }, [runtime]);

  const composerDisabled = branchBusy || creatingConversation || uploadingAttachments;
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
    <ChatThread
      runtime={runtime}
      assistantName={agentName}
      allowAttachments={attachmentsEnabled}
      allowEdit={allowEdit}
      allowRegenerate={allowRegenerate}
      branchNavigation={branchNavigation}
      busy={branchBusy}
      disabled={!ready || composerDisabled}
      error={submitError || chat.error?.message}
      labels={threadLabels}
      transformUserText={displayUserText}
      onBranchSelect={onBranchChange}
      onBranchStart={onStartBranch}
      onRegenerateMessage={!includeConversationIdInBody
        ? (messageId) => void regenerate({ messageId })
        : undefined}
      composerTools={(
        <>
          <ComposerMcpPromptPickerButton
            apiPath={mcpPromptApiPath}
            disabled={!ready || composerDisabled}
            onError={setSubmitError}
          />
          {webSearchAvailable ? (
            <button
              type="button"
              disabled={composerDisabled}
              aria-label={webSearchEnabled ? t('disableWebSearch') : t('enableWebSearch')}
              aria-pressed={webSearchEnabled}
              title={webSearchEnabled ? t('disableWebSearch') : t('enableWebSearch')}
              onClick={() => setWebSearchEnabled((enabled) => !enabled)}
              className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${webSearchEnabled
                ? 'bg-brand/10 text-brand'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <Globe2 className="size-[17px]" />
            </button>
          ) : null}
          {reasoningAvailable ? (
            <ReasoningEffortControl
              value={reasoningEffort}
              disabled={composerDisabled}
              onChange={setReasoningEffort}
            />
          ) : null}
        </>
      )}
      composerStatus={composerStatus}
      composerEnd={<ConversationContextUsage busy={chatBusy} usage={contextUsage} />}
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
  );
}
