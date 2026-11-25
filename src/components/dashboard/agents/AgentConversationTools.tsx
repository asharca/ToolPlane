"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import {
  Eraser,
  Globe2,
  Paperclip,
  SlidersHorizontal,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/motion/button";
import { ComposerToolbarCustomizer } from "@/components/dashboard/ComposerToolbarCustomizer";
import { ComposerToolsButton } from "@/components/dashboard/ComposerToolsButton";
import {
  ComposerMenu,
  type ComposerMenuItem,
  type ComposerMenuOutcome,
  useComposerMenu,
} from "@/components/dashboard/composer-menu";
import { useMcpComposerMenu } from "@/components/dashboard/composer-mcp-menu";
import { displayErrorText } from "@/components/dashboard/display-error";
import type { RuntimeCommand } from "@/lib/agents/runtime-commands";

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

/** The composer's tool menu and pinned toolbar shortcuts. */
export function ConversationTools({
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
          onError(displayErrorText(cause, agentsT("attachmentUploadFailed")));
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
                onError(displayErrorText(cause, agentsT("clearContextFailed"))),
              );
            }}
            variant="ghost"
            size="icon"
            className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
              item.pressed
                ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                : ""
            }`}
          >
            <Icon className="size-4" />
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
