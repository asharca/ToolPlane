"use client";

import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CustomRendererProps, CustomRenderer } from "streamdown";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { CodeBlock } from "@/components/agents/code-block";
import type { AgentCodeLanguage } from "@/components/agents/agent-code";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/dashboard/CopyButton";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageHeader,
  type MessageProps,
} from "@/components/agents/message";
import { cn } from "@/lib/utils";
import {
  AgentActivity,
  type AgentActivityProps,
} from "@/components/agents/agent-activity";
import { ToolResultOutput } from "@/components/agents/tool-result";

export const conversationUserBubbleClassName =
  "w-auto max-w-[85%] sm:max-w-[80%] [&>div]:max-w-none [&>div]:rounded-3xl [&>div]:px-4 [&>div]:py-2.5";
export const conversationMessageListClassName = "gap-6";
export const conversationActivityClassName =
  "w-full rounded-2xl border border-border/60 bg-muted/20 shadow-none";

/**
 * Process/thinking disclosure without a card. Keep the full list in the
 * transcript flow, including while working: a translated, clipped live window
 * hides nested tool disclosures when the reader opens them. The conversation
 * owns live-output following; only individual tool payloads scroll internally.
 */
export function ConversationActivity({
  className,
  items,
  ...props
}: Omit<AgentActivityProps, "maxHeight">) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  useLayoutEffect(() => {
    const list = rootRef.current?.querySelector<HTMLElement>('[role="list"]');
    if (!list) return;
    const measure = () => setContentHeight(list.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const maxHeight = !items.length
    ? 0
    : (props.status ?? "working") === "working"
      ? contentHeight
      : Number.MAX_SAFE_INTEGER;
  return (
    <div ref={rootRef} className="w-full">
      <AgentActivity
        {...props}
        items={items}
        maxHeight={maxHeight}
        className={cn("w-full", className)}
      />
    </div>
  );
}

/** Lets `ToolResult` grow to its payload boxes; each box scrolls on its own. */
export const toolResultUnboundedHeight = Number.MAX_SAFE_INTEGER;

/**
 * Pi/MCP results wrap plain output as `{content:[{type:"text",text}]}`. Show
 * that text as-is instead of an escaped JSON string; anything else stays JSON.
 */
export function toolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    // Recorded results may arrive JSON-encoded; unwrap them the same way.
    if (!value.trimStart().startsWith("{")) return value;
    try {
      return toolOutputText(JSON.parse(value) as object) ?? value;
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { content, details, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length ||
    (details !== undefined &&
      details !== null &&
      !(typeof details === "object" && !Object.keys(details).length)) ||
    !Array.isArray(content) ||
    !content.length
  )
    return;
  const texts: string[] = [];
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string"
    )
      return;
    texts.push((part as { text: string }).text);
  }
  return texts.join("\n");
}

/**
 * One tool input or output. Long payloads scroll inside this box with a visible
 * scrollbar, and the wheel stays here instead of scrolling the conversation.
 */
export function ToolPayload({
  label,
  language,
  children,
}: {
  label?: ReactNode;
  language: AgentCodeLanguage;
  children: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="max-h-80 overflow-auto overscroll-contain rounded-lg [scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--foreground)_25%,transparent)_transparent]">
        <ToolResultOutput language={language}>{children}</ToolResultOutput>
      </div>
    </div>
  );
}

/** Shared transcript geometry; message actions and runtime state stay with callers. */
export function ConversationMessageShell({
  from,
  name,
  showIdentity = true,
  metadata,
  children,
  className,
  ...props
}: MessageProps & {
  name: string;
  showIdentity?: boolean;
  metadata?: ReactNode;
}) {
  return (
    <Message from={from} className={cn("gap-0", className)} {...props}>
      <MessageContent className="gap-2">
        {from === "assistant" && showIdentity ? (
          <MessageHeader className="mb-1 w-full gap-2 px-0 text-xs">
            <MessageAvatar className="size-6 [&_svg]:size-3.5">
              <Bot />
            </MessageAvatar>
            <span className="font-medium text-foreground">{name}</span>
            {metadata}
          </MessageHeader>
        ) : null}
        {children}
      </MessageContent>
    </Message>
  );
}

const MermaidAssistantMarkdown = lazy(
  () => import("./MermaidAssistantMarkdown"),
);
const codeLanguages: Record<string, AgentCodeLanguage> = {
  bash: "bash",
  sh: "bash",
  diff: "diff",
  json: "json",
  text: "text",
  txt: "text",
  plaintext: "text",
  tsx: "tsx",
  ts: "typescript",
  typescript: "typescript",
};

function AssistantCodeBlock({
  code,
  language,
  isIncomplete,
}: CustomRendererProps) {
  const t = useTranslations("common");
  return (
    <div className="relative">
      <CodeBlock
        code={code}
        language={codeLanguages[language] ?? "text"}
        status={isIncomplete ? "streaming" : "complete"}
        copyable={false}
      />
      <CopyButton
        text={code}
        label={t("copy")}
        iconOnly
        className="absolute top-1 right-2"
      />
    </div>
  );
}

/** Route every actual code-fence language to beUI without changing its contents. */
export function assistantCodeRenderers(text: string): CustomRenderer[] {
  const languages = new Set(["", "text", "plaintext"]);
  for (const match of text.matchAll(
    /^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gm,
  )) {
    if (match[1].toLowerCase() !== "mermaid") languages.add(match[1]);
  }
  return [{ language: [...languages], component: AssistantCodeBlock }];
}

export function AssistantMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const renderers = useMemo(() => assistantCodeRenderers(text), [text]);
  const markdown = (
    <SafeStreamdown
      assistant
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      plugins={{ renderers }}
      preserveSoftBreaks
      linkSafety={{ enabled: true }}
    >
      {text}
    </SafeStreamdown>
  );
  return (
    <StreamingResponse
      status={streaming ? "streaming" : "complete"}
      showActions={false}
      className="w-full text-sm leading-[1.7] [&_p]:leading-[1.7]"
    >
      {/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b/im.test(text) ? (
        <Suspense fallback={markdown}>
          <MermaidAssistantMarkdown text={text} streaming={streaming} />
        </Suspense>
      ) : (
        markdown
      )}
    </StreamingResponse>
  );
}
