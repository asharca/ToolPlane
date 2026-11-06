"use client";

import { Button } from "@/components/motion/button";
import { ComposerToolbarCustomizer } from "@/components/dashboard/ComposerToolbarCustomizer";
import { ComposerToolsButton } from "@/components/dashboard/ComposerToolsButton";
import {
  ComposerMenu,
  type ComposerMenuItem,
  type ComposerMenuOutcome,
  type ComposerMenuView,
  useComposerMenu,
} from "@/components/dashboard/composer-menu";
import { useMcpComposerMenu } from "@/components/dashboard/composer-mcp-menu";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  Database,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  Paperclip,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  ConversationFilePreview,
  ConversationComposer,
} from "@/components/dashboard/ConversationComposer";
import { ComposerPromptManager } from "./ComposerPromptManager";
import {
  ComposerReferencesSchema,
  type ComposerItem,
  type ComposerReference,
} from "@/lib/work/composer-types";
import type { RuntimeCommand } from "@/lib/agents/runtime-commands";

const referenceIcon = {
  file: FileText,
  folder: Folder,
  session: MessageSquare,
  resource: Database,
  skill: Sparkles,
};
const TOOLBAR_KEY = "toolplane.work.composer.toolbar";
const TOOLBAR_EVENT = "toolplane:work-composer-toolbar";
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
    return localStorage.getItem(TOOLBAR_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function WorkComposer({
  agentId,
  sandboxId,
  workSessionId,
  conversationId,
  draft,
  onDraftChange,
  attachments,
  onAttachmentsChange,
  references,
  onReferencesChange,
  disabled,
  supportsAttachments,
  onSubmit,
  onError,
  onPendingChange,
  waitingQuestion,
  toolbarStart,
  toolbarEnd,
  loading: running = false,
  onStop,
  commands = [],
}: {
  agentId?: string;
  sandboxId?: string;
  workSessionId?: string;
  conversationId?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  attachments: File[];
  onAttachmentsChange: (files: File[]) => void;
  references: ComposerReference[];
  onReferencesChange: (references: ComposerReference[]) => void;
  disabled: boolean;
  supportsAttachments: boolean;
  onSubmit: () => void;
  onError: (text: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  waitingQuestion?: string | null;
  toolbarStart: ReactNode;
  toolbarEnd: ReactNode;
  commands?: readonly RuntimeCommand[];
  loading?: boolean;
  onStop?: () => void;
}) {
  const t = useTranslations("console.workComposer");
  const agentsT = useTranslations("console.agents");
  const workT = useTranslations("console.work");
  const common = useTranslations("common");
  const commandsT = useTranslations("console.runtimeCommands");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [attachmentKeys] = useState(() => new WeakMap<File, string>());
  const toolbarValue = useSyncExternalStore(
    subscribeToolbar,
    readToolbar,
    () => "[]",
  );
  useEffect(() => {
    inputRef.current = formRef.current?.querySelector("textarea") ?? null;
  }, []);
  useEffect(
    () => () => {
      requestRef.current?.abort();
      onPendingChange(false);
    },
    [onPendingChange],
  );
  const endpoint =
    agentId && (conversationId || workSessionId)
      ? `/api/v1/agents/${encodeURIComponent(agentId)}/composer`
      : "";
  const scope = new URLSearchParams({
    ...(conversationId ? { conversationId } : {}),
    ...(workSessionId ? { workSessionId } : {}),
  }).toString();
  const loadFailed = t("loadFailed");

  function focusInput(position?: number) {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (position !== undefined)
        inputRef.current?.setSelectionRange(position, position);
    });
  }

  async function chooseReference(item: ComposerItem) {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setResolving(true);
    onPendingChange(true);
    onError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: item.kind,
          id: item.id,
          ...(item.deploymentId ? { deploymentId: item.deploymentId } : {}),
          ...(sandboxId ? { sandboxId } : {}),
          ...(workSessionId ? { workSessionId } : {}),
          ...(conversationId ? { conversationId } : {}),
        }),
      });
      if (!response.ok) throw new Error(t("referenceFailed"));
      const reference = (await response.json()) as ComposerReference;
      const next = ComposerReferencesSchema.safeParse([
        ...references,
        reference,
      ]);
      if (!next.success) throw new Error(t("referenceLimit"));
      if (!controller.signal.aborted) {
        onReferencesChange(next.data);
        focusInput();
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        onError(cause instanceof Error ? cause.message : t("referenceFailed"));
    } finally {
      if (!controller.signal.aborted) {
        setResolving(false);
        onPendingChange(false);
      }
    }
  }

  const mcp = useMcpComposerMenu({
    composerPath: endpoint ? `${endpoint}?${scope}` : undefined,
    promptsPath:
      agentId && endpoint
        ? `/api/v1/agents/${encodeURIComponent(agentId)}/prompts?${scope}`
        : undefined,
    // Work attaches MCP resources as reference chips, not inline text.
    resources: false,
  });

  /** Pinnable tools; ids are persisted in the toolbar preference. */
  const toolOptions: ComposerMenuItem[] = [
    {
      id: "attachments",
      label: agentsT("addAttachment"),
      icon: Paperclip,
      disabled: !supportsAttachments,
    },
    { id: "prompts", label: t("prompts"), icon: SquarePen, disabled: !agentId },
    {
      id: "resources",
      label: t("resources"),
      icon: Database,
      group: agentsT("mcp"),
      drill: true,
      disabled: !endpoint,
    },
    mcp.rootItems.find((item) => item.id === "mcp-prompts") ?? {
      id: "mcp-prompts",
      label: agentsT("mcpPrompts"),
      icon: ScrollText,
      group: agentsT("mcp"),
      drill: true,
      disabled: true,
    },
    {
      id: "skills",
      label: t("skills"),
      icon: Sparkles,
      drill: true,
      disabled: !endpoint,
    },
  ];
  // Runtime commands only apply to a message that starts with them.
  const commandsAvailable = !draft.replace(/(?:^|\s)\/[^\s]*$/, "").trim();
  const rootItems: ComposerMenuItem[] = [
    // Ungrouped tools first, then the MCP group, then runtime commands.
    ...toolOptions.filter((item) => !item.group),
    ...toolOptions.filter((item) => item.group),
    ...mcp.rootItems.filter((item) => item.id === "mcp-servers"),
    ...(commandsAvailable
      ? commands.map((command) => ({
          id: `command:${command.name}`,
          label: `/${command.name}`,
          icon: TerminalSquare,
          group: commandsT("title"),
          description: commandsT.has(`descriptions.${command.name}`)
            ? commandsT(`descriptions.${command.name}`)
            : command.description,
          data: command.name,
        }))
      : []),
  ];

  const views = useMemo(() => {
    const section =
      (name: "resources" | "skills" | "references") =>
      async (query: string, signal: AbortSignal) => {
        const params = new URLSearchParams({
          section: name,
          query,
          ...(sandboxId ? { sandboxId } : {}),
          ...(workSessionId ? { workSessionId } : {}),
          ...(conversationId
            ? { conversationId, excludeConversationId: conversationId }
            : {}),
        });
        const response = await fetch(`${endpoint}?${params}`, {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(loadFailed);
        const data = (await response.json()) as { items: ComposerItem[] };
        return data.items.map((item) => ({
          id: `${item.kind}:${item.deploymentId ?? ""}:${item.id}`,
          label: item.label,
          description: item.description,
          icon: referenceIcon[item.kind],
          drill: item.kind === "folder",
          group:
            item.kind === "session"
              ? t("sessions")
              : item.kind === "file" || item.kind === "folder"
                ? t("files")
                : undefined,
          disabled: references.some(
            (ref) =>
              ref.kind === item.kind &&
              ref.id === item.id &&
              ref.deploymentId === item.deploymentId,
          ),
          data: item,
        }));
      };
    const result: Record<string, ComposerMenuView> = { ...mcp.views };
    if (endpoint) {
      result.resources = { title: t("resources"), load: section("resources") };
      result.skills = { title: t("skills"), load: section("skills") };
      result.references = {
        title: t("references"),
        load: section("references"),
        remoteQuery: true,
      };
    }
    return result;
  }, [
    conversationId,
    endpoint,
    loadFailed,
    mcp.views,
    references,
    sandboxId,
    t,
    workSessionId,
  ]);

  async function activateItem(
    item: ComposerMenuItem,
    view: string,
    insertText: (text: string) => void,
  ): Promise<ComposerMenuOutcome> {
    const handled = await mcp.activate(item, view, insertText);
    if (handled !== null) return handled;
    if (view !== "root") {
      const reference = item.data as ComposerItem;
      if (reference.kind === "folder")
        return { view: "references", query: `${reference.id}/` };
      void chooseReference(reference);
      return undefined;
    }
    if (typeof item.data === "string") {
      insertText(`/${item.data} `);
      return undefined;
    }
    if (item.id === "resources" || item.id === "skills")
      return { view: item.id };
    if (item.id === "attachments") fileRef.current?.click();
    if (item.id === "prompts") setPromptsOpen(true);
    return undefined;
  }

  const menu = useComposerMenu({
    text: draft,
    setText: onDraftChange,
    textareaRef: inputRef,
    containerRef: formRef,
    disabled: disabled || resolving,
    rootItems,
    views,
    mentionView: endpoint ? "references" : undefined,
    onActivate: activateItem,
    onError,
  });

  function insertPromptText(text: string) {
    const at = inputRef.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, at) + text + draft.slice(at);
    if (next.length > 20_000) {
      onError(t("inputTooLong"));
      return;
    }
    onDraftChange(next);
    focusInput(at + text.length);
  }

  let pinnedIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(toolbarValue);
    if (Array.isArray(parsed))
      pinnedIds = [...new Set(parsed)].filter(
        (id): id is string =>
          typeof id === "string" &&
          toolOptions.some((option) => option.id === id),
      );
  } catch {
    /* Ignore obsolete or invalid browser preferences. */
  }
  const pinnedOptions = pinnedIds.flatMap(
    (id) => toolOptions.find((option) => option.id === id) ?? [],
  );

  function saveToolbar(ids: string[]) {
    try {
      localStorage.setItem(TOOLBAR_KEY, JSON.stringify(ids));
      window.dispatchEvent(new Event(TOOLBAR_EVENT));
    } catch {
      onError(t("toolbarSaveFailed"));
    }
  }

  function activateShortcut(option: ComposerMenuItem) {
    if (option.drill) menu.openView(option.id);
    else if (option.id === "attachments") fileRef.current?.click();
    else if (option.id === "prompts") setPromptsOpen(true);
  }

  return (
    <>
      <div ref={formRef} data-ui="chat.composer" className="relative">
        <ComposerMenu
          menu={menu}
          footer={{
            label: t("customizeToolbar"),
            icon: SlidersHorizontal,
            onSelect: () => setCustomizing(true),
          }}
        />
        <div className="flex w-full flex-col">
          {waitingQuestion ? (
            <p className="mb-2 text-sm font-medium">{waitingQuestion}</p>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [
                ...attachments,
                ...Array.from(event.target.files ?? []),
              ];
              if (files.length > 5)
                onError(agentsT("attachmentLimitReached", { count: 5 }));
              onAttachmentsChange(files.slice(0, 5));
              event.target.value = "";
              focusInput();
            }}
          />
          <ConversationComposer
            attachments={
              attachments.length || references.length || resolving ? (
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  {attachments.map((file, index) => {
                    let key = attachmentKeys.get(file);
                    if (!key) {
                      key = crypto.randomUUID();
                      attachmentKeys.set(file, key);
                    }
                    return (
                      <ConversationFilePreview
                        key={key}
                        file={file}
                        name={file.name}
                        removeLabel={agentsT("removeAttachment", {
                          name: file.name,
                        })}
                        onRemove={() =>
                          onAttachmentsChange(
                            attachments.filter(
                              (_, position) => position !== index,
                            ),
                          )
                        }
                      />
                    );
                  })}
                  {references.map((reference, index) => {
                    const Icon = referenceIcon[reference.kind];
                    return (
                      <div
                        key={`${reference.kind}:${reference.deploymentId ?? ""}:${reference.id}`}
                        className="flex max-w-full items-center gap-2"
                      >
                        <Icon className="size-4 text-muted-foreground" />
                        <span className="truncate text-sm">
                          {reference.label}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("removeReference", {
                            name: reference.label,
                          })}
                          onClick={() =>
                            onReferencesChange(
                              references.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    );
                  })}
                  {resolving ? (
                    <Loader2
                      aria-label={common("loading")}
                      className="size-4 animate-spin text-muted-foreground"
                    />
                  ) : null}
                </div>
              ) : null
            }
            value={draft}
            role="combobox"
            aria-label={workT("taskPlaceholder")}
            {...menu.comboboxProps}
            readOnly={resolving}
            disabled={disabled || resolving}
            loading={running}
            onStop={onStop}
            maxLength={20_000}
            onFocus={(event) => {
              inputRef.current = event.currentTarget;
            }}
            onValueChange={(value) => {
              onDraftChange(value);
              const input = inputRef.current;
              if (input)
                menu.sync(value, input.selectionStart, input.selectionEnd);
            }}
            onKeyDown={(event) => {
              if (menu.onKeyDown(event)) return;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                if (!resolving) event.currentTarget.form?.requestSubmit();
              }
            }}
            onSelect={(event) =>
              menu.sync(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              )
            }
            onSubmit={() => {
              if (!resolving) onSubmit();
            }}
            placeholder={t("hint")}
            minRows={1}
            maxRows={12}
            leadingAction={
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <ComposerToolsButton
                  open={menu.open}
                  disabled={disabled || resolving}
                  aria-label={agentsT("openComposerTools")}
                  title={agentsT("openComposerTools")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={menu.openFromButton}
                />
                {pinnedOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      data-composer-shortcut={option.id}
                      disabled={disabled || resolving || option.disabled}
                      aria-label={option.label}
                      title={option.label}
                      onClick={() => activateShortcut(option)}
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-full"
                    >
                      <Icon className="size-4" />
                    </Button>
                  );
                })}
                <span className="flex-1" />
                {toolbarStart}
                {toolbarEnd}
              </div>
            }
          />
        </div>
      </div>
      {agentId && promptsOpen ? (
        <ComposerPromptManager
          agentId={agentId}
          onClose={() => {
            setPromptsOpen(false);
            focusInput();
          }}
          onInsert={insertPromptText}
        />
      ) : null}
      <ComposerToolbarCustomizer
        open={customizing}
        onOpenChange={(open) => {
          setCustomizing(open);
          if (!open) focusInput();
        }}
        title={t("customizeToolbar")}
        resetLabel={t("resetToolbar")}
        options={toolOptions}
        pinnedIds={pinnedIds}
        onChange={saveToolbar}
      />
    </>
  );
}
