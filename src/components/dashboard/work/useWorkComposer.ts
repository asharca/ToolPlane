"use client";

import {
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { notify } from "@/components/dashboard/Toaster";
import type {
  ModelProviderOption,
  ModelSelection,
} from "@/components/dashboard/ComposerModelSelect";
import type { QueueMode } from "@/components/dashboard/AgentMessageQueue";
import {
  DisplayError,
  displayErrorText,
} from "@/components/dashboard/display-error";
import {
  selectionSupportsReasoning,
  type ReasoningEffort,
} from "@/lib/agents/constants";
import { conversationTitleFromParts } from "@/lib/agents/conversation-title";
import {
  parseRuntimeCommand,
  type RuntimeCommand,
} from "@/lib/agents/runtime-commands";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { apiRequest } from "@/lib/client/api";
import type { ComposerReference } from "@/lib/work/composer-types";
import {
  workHref,
  type ConversationDetail,
  type WorkAgent,
  type WorkItem,
  type WorkTreeAction,
} from "./work-types";

/**
 * The Work composer's draft and its actions: create a Work session, send a
 * follow-up or runtime command, queue a message while running, and rewrite the
 * conversation tree. Model and thinking choices are keyed by
 * `conversationScope` (Agent and session only): the sandbox identity arrives
 * after creation and must not move the user's choice (TP-L055).
 */
export function useWorkComposer({
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
  resetStream,
}: {
  slug: string;
  workspaceId: string;
  providers: ModelProviderOption[];
  agent: WorkAgent | null;
  agentId: string;
  controlAgent: WorkAgent | null;
  activeSandboxId: string;
  workingDirectory: string;
  selected: WorkItem | null;
  conversation: ConversationDetail | null;
  sessionReadOnly: boolean;
  selectedActive: boolean;
  running: boolean;
  canSend: boolean;
  commandRuntimeKind: string;
  commands: readonly RuntimeCommand[];
  conversationScope: string;
  composerScope: string;
  messageQueue: {
    pending: boolean;
    forbidden: boolean;
    fallback: boolean;
    send: (mode: QueueMode, text: string) => Promise<boolean>;
  };
  activeResourceIdRef: RefObject<string | null>;
  describeRuntimeError: (
    message: string | null | undefined,
  ) => { text: string } | null | undefined;
  refreshSelected: () => Promise<boolean>;
  setItems: Dispatch<SetStateAction<WorkItem[]>>;
  setLiveSelected: Dispatch<SetStateAction<WorkItem | null>>;
  setFollowingOutput: Dispatch<SetStateAction<boolean>>;
  setDraftSelectionKey: Dispatch<SetStateAction<string | null>>;
  resetStream: (workSessionId: string) => void;
}) {
  const t = useTranslations("console.work");
  const tAgents = useTranslations("console.agents");
  const operationsT = useTranslations("console.conversationOperations");
  const queueT = useTranslations("console.messageQueue");
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [modelChoices, setModelChoices] = useState<
    Record<string, ModelSelection | null>
  >({});
  const [reasoningChoices, setReasoningChoices] = useState<
    Record<string, ReasoningEffort>
  >({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [referenceSelection, setReferenceSelection] = useState<{
    scope: string;
    items: ComposerReference[];
  }>({ scope: "", items: [] });
  const [composerPending, setComposerPending] = useState(false);
  const commandsT = useTranslations("console.runtimeCommands");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const treeActionInFlight = useRef(false);
  const defaultModelSelection =
    controlAgent?.providerId && controlAgent.model
      ? { providerId: controlAgent.providerId, model: controlAgent.model }
      : null;
  const reasoningAvailable = selectionSupportsReasoning(
    providers,
    modelChoices[conversationScope] ?? defaultModelSelection,
  );
  const reasoningEffort =
    reasoningChoices[conversationScope] ??
    conversation?.reasoningEffort ??
    selected?.reasoningEffort ??
    "default";
  const references =
    referenceSelection.scope === composerScope ? referenceSelection.items : [];
  async function sendQueuedMessage(mode: QueueMode) {
    if (
      sessionReadOnly ||
      busy ||
      composerPending ||
      messageQueue.pending ||
      messageQueue.forbidden ||
      !draft.trim()
    )
      return;
    if (attachments.length || references.length) {
      notify(queueT("textOnly"), { severity: "error" });
      return;
    }
    const text = draft;
    const resource = activeResourceIdRef.current;
    if (await messageQueue.send(mode, text)) {
      if (activeResourceIdRef.current === resource)
        setDraft((current) => (current === text ? "" : current));
    }
  }

  async function discardUploaded(ids: string[]) {
    await Promise.all(
      ids.map((id) =>
        apiRequest(`/api/v1/attachments/${id}`, { method: "DELETE" }),
      ),
    );
  }

  /** Uploads every attachment, or none: a rejected file discards the earlier ones. */
  async function uploadAttachments(): Promise<string[]> {
    const uploaded: string[] = [];
    for (const file of attachments) {
      const query = new URLSearchParams({ filename: file.name });
      const result = await apiRequest<{ id?: string }>(
        `/api/v1/workspaces/${workspaceId}/attachments?${query}`,
        {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        },
      );
      if (!result.ok || !result.data?.id) {
        await discardUploaded(uploaded);
        throw new DisplayError(
          !result.ok && result.code === "STORAGE_QUOTA_EXCEEDED"
            ? tAgents("attachmentStorageQuotaExceeded")
            : (!result.ok && result.message) ||
                tAgents("attachmentUploadFailed"),
        );
      }
      uploaded.push(result.data.id);
    }
    return uploaded;
  }

  async function createWork() {
    if (
      !agent ||
      !isExecutableAgentRuntimeKind(agent?.runtimeKind) ||
      !agentId ||
      !activeSandboxId ||
      !draft.trim()
    )
      return;
    const runtimeKind = agent.runtimeKind;
    setBusy("create");
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
      const result = await apiRequest<{ workSessionId?: string }>(
        "/api/v1/work-sessions",
        {
          method: "POST",
          json: {
            agentId,
            sandboxId: activeSandboxId,
            task: draft.trim(),
            ...(modelChoices[conversationScope]
              ? { modelOverride: modelChoices[conversationScope] }
              : {}),
            ...(reasoningAvailable ? { reasoningEffort } : {}),
            ...(references.length ? { references } : {}),
            workingDirectory,
            attachmentIds,
          },
        },
      );
      const workSessionId = result.ok ? result.data?.workSessionId : undefined;
      if (!workSessionId)
        throw new DisplayError(
          (!result.ok && result.message) || t("createError"),
        );
      const nextScope = `${agentId}:${workSessionId}`;
      setModelChoices((choices) => ({
        ...choices,
        [nextScope]: choices[conversationScope] ?? null,
      }));
      setReasoningChoices((choices) => ({
        ...choices,
        [nextScope]: reasoningEffort,
      }));
      setItems((current) => [
        {
          id: workSessionId,
          agentId,
          title: conversationTitleFromParts([{ type: "text", text: draft }]),
          titlePending: true,
          optimistic: true,
          task: draft.trim(),
          acceptanceCriteria: null,
          runtimeKind,
          status: "queued",
          waitingQuestion: null,
          result: null,
          error: null,
          artifacts: [],
          conversationId: "",
          sandbox: null,
          messages: [],
        },
        ...current,
      ]);
      setDraft("");
      setAttachments([]);
      setReferenceSelection({ scope: "", items: [] });
      setDraftSelectionKey(null);
      setBusy(null);
      router.push(workHref(slug, workSessionId));
    } catch (cause) {
      await discardUploaded(attachmentIds);
      setError(displayErrorText(cause, t("createError")));
      setBusy(null);
    }
  }

  async function postAction(path: string, body?: Record<string, unknown>) {
    if (!selected) return false;
    setBusy(path);
    setError(null);
    const result = await apiRequest(
      `/api/v1/work-sessions/${selected.id}/${path}`,
      { method: "POST", ...(body ? { json: body } : {}) },
    );
    try {
      if (!result.ok) {
        setError(result.message ?? t("createError"));
        return false;
      }
      await refreshSelected();
      return true;
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function mutateConversationTree(action: WorkTreeAction) {
    if (
      !selected ||
      sessionReadOnly ||
      selectedActive ||
      busy ||
      composerPending ||
      treeActionInFlight.current
    )
      return false;
    treeActionInFlight.current = true;
    setBusy("tree");
    const target = selected;
    try {
      const path =
        action.kind === "retry"
          ? "retry"
          : `messages/${encodeURIComponent(action.messageId)}/${action.kind}`;
      const result = await apiRequest<{
        kind?: string;
        workSessionId?: string;
        contextOnly?: boolean;
        filesRewound?: boolean;
        externalEffectsRewound?: boolean;
      }>(
        `/api/v1/agents/${encodeURIComponent(target.agentId)}/conversations/${encodeURIComponent(target.conversationId)}/${path}`,
        {
          method: "POST",
          ...(action.kind === "edit" ? { json: { text: action.text } } : {}),
        },
      );
      if (!result.ok) {
        // The route answers with a tree or runtime failure code.
        const code = result.message ?? "conversationTreeFailed";
        notify(
          t.has(`tree.errors.${code}`)
            ? t(`tree.errors.${code}`)
            : (describeRuntimeError(code)?.text ??
                t("tree.errors.conversationTreeFailed")),
          { severity: "error" },
        );
        return false;
      }
      const outcome = result.data;
      if (
        !outcome?.workSessionId ||
        outcome.kind !== (action.kind === "branch" ? "branched" : "queued")
      ) {
        notify(t("tree.errors.conversationTreeFailed"), { severity: "error" });
        return false;
      }
      const contextOnly =
        outcome.contextOnly === true &&
        outcome.filesRewound === false &&
        outcome.externalEffectsRewound === false;
      notify(
        `${t(action.kind === "branch" ? "tree.branched" : "tree.queued")}${contextOnly ? ` ${t("tree.contextOnly")}` : ""}`,
      );
      if (action.kind === "branch") {
        if (activeResourceIdRef.current === `session:${target.id}`)
          router.push(workHref(slug, outcome.workSessionId));
      } else {
        if (activeResourceIdRef.current === `session:${target.id}`) {
          setError(null);
          setFollowingOutput(true);
          resetStream(target.id);
          setLiveSelected({
            ...target,
            status: "queued",
            error: null,
            result: null,
            artifacts: [],
            completedAt: null,
            waitingQuestion: null,
          });
        }
        await refreshSelected();
      }
      router.refresh();
      return true;
    } catch {
      notify(t("tree.errors.conversationTreeFailed"), { severity: "error" });
      return false;
    } finally {
      treeActionInFlight.current = false;
      setBusy(null);
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    if (
      sessionReadOnly ||
      conversation ||
      busy ||
      messageQueue.pending ||
      (running && !messageQueue.fallback) ||
      composerPending
    )
      return;
    const input = draft.trim();
    if (!input) return;
    // Opening a disclosure pauses following; a new turn returns to the live edge.
    setFollowingOutput(true);
    const command = parseRuntimeCommand(input, commandRuntimeKind);
    if (command && command.name !== "new") {
      if (
        !isExecutableAgentRuntimeKind(commandRuntimeKind) &&
        !commands.some((item) => item.name === command.name)
      ) {
        setError(commandsT("unsupportedCommand"));
        return;
      }
      if (attachments.length || references.length) {
        setError(commandsT("noAttachments"));
        return;
      }
      if (input.length > 2000) {
        setError(commandsT("invalidCommand"));
        return;
      }
      if (!selected) {
        if (isExecutableAgentRuntimeKind(commandRuntimeKind) && canSend)
          return createWork();
        setError(commandsT("needsConversation"));
        return;
      }
      setBusy("command");
      setError(null);
      try {
        const result = await apiRequest(
          `/api/v1/agents/${encodeURIComponent(selected.agentId)}/conversations/${encodeURIComponent(selected.conversationId)}/commands`,
          {
            method: "POST",
            json: {
              line: input,
              ...(modelChoices[conversationScope]
                ? { modelOverride: modelChoices[conversationScope] }
                : {}),
            },
          },
        );
        if (!result.ok) {
          setError(
            result.message && commandsT.has(result.message)
              ? commandsT(result.message)
              : result.message || commandsT("failed"),
          );
          return;
        }
        setDraft("");
        await refreshSelected();
      } finally {
        setBusy(null);
      }
      return;
    }
    if (/^\/new(?:\s|$)/i.test(input)) {
      setError(operationsT("channelCommandOnly"));
      return;
    }
    if (!canSend && !messageQueue.fallback) return;
    if (!selected) return createWork();
    setBusy("input");
    setError(null);
    let attachmentIds: string[] = [];
    try {
      attachmentIds = await uploadAttachments();
    } catch (cause) {
      setError(displayErrorText(cause, tAgents("attachmentUploadFailed")));
      setBusy(null);
      return;
    }
    if (
      await postAction("input", {
        input,
        ...(modelChoices[conversationScope]
          ? { modelOverride: modelChoices[conversationScope] }
          : {}),
        ...(reasoningAvailable ? { reasoningEffort } : {}),
        ...(references.length ? { references } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      })
    ) {
      setDraft("");
      setAttachments([]);
      setReferenceSelection({ scope: "", items: [] });
    } else {
      await discardUploaded(attachmentIds);
    }
  }

  /** Starting a new Work clears the draft and anything attached to it. */
  function clearDraft() {
    setDraft("");
    setAttachments([]);
    setReferenceSelection({ scope: "", items: [] });
    setError(null);
  }
  return {
    draft,
    setDraft,
    clearDraft,
    attachments,
    setAttachments,
    references,
    setReferences: (items: ComposerReference[]) =>
      setReferenceSelection({ scope: composerScope, items }),
    composerPending,
    setComposerPending,
    error,
    setError,
    busy,
    defaultModelSelection,
    modelChoice: modelChoices[conversationScope] ?? null,
    setModelChoice: (value: ModelSelection | null) =>
      setModelChoices((choices) => ({
        ...choices,
        [conversationScope]: value,
      })),
    reasoningAvailable,
    reasoningEffort,
    setReasoningEffort: (value: ReasoningEffort) =>
      setReasoningChoices((choices) => ({
        ...choices,
        [conversationScope]: value,
      })),
    sendMessage,
    sendQueuedMessage,
    postAction,
    mutateConversationTree,
  };
}
