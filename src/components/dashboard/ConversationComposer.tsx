"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Download, File as FileIcon, FileX, Loader2, X } from "lucide-react";
import { Button } from "@/components/motion/button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  FilePreviewDialog,
  saveBlob,
} from "@/components/dashboard/FilePreviewDialog";
import { previewType } from "@/lib/file-preview";
import { notify } from "./Toaster";
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type ContextUsageSnapshot,
} from "@/lib/context-usage";
import {
  PromptInput,
  type PromptInputProps,
} from "@/components/agents/prompt-input";
import { cn } from "@/lib/utils";
import { AgentQueueActions, type QueueMode } from "./AgentMessageQueue";

/** Shared card surface for every prompt input; the theme border token is too faint on dark backgrounds. */
export const conversationComposerSurfaceClassName =
  "rounded-3xl border border-foreground/10 bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-foreground/20 focus-within:shadow-md dark:bg-muted/40";
// The vendored PromptInput sets the textarea height to the text height only, so content-box keeps its top padding from clipping the text.
export const conversationComposerClassName = `${conversationComposerSurfaceClassName} px-2 pt-2 pb-0 text-[15px] [&>textarea]:box-content [&>textarea]:leading-6 [&>textarea]:max-h-[40vh] [&>div:last-child]:mt-0 [&>div:last-child]:flex-wrap [&>div:last-child]:px-0.5 [&>div:last-child]:pb-2.5 [&>div:last-child]:pt-1 [&>div:last-child_button]:rounded-full [&>div:last-child>button:last-child]:ml-0 [&>div:last-child>button:last-child]:size-9 [&>div:last-child>button:last-child]:rounded-full`;
export const conversationComposerDockClassName =
  "relative z-10 mx-auto w-full max-w-3xl shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-background before:to-transparent sm:px-4";

/** Presentation-only wrapper around beUI's auto-growing prompt input. */
export function ConversationComposer({
  className,
  attachments,
  hasAttachments,
  onRunningSubmit,
  queuePending = false,
  ...props
}: PromptInputProps & {
  attachments?: ReactNode;
  hasAttachments?: boolean;
  onRunningSubmit?: (mode: QueueMode) => void;
  queuePending?: boolean;
}) {
  const agentUiT = useTranslations("console.agentUi");
  const attachmentsBlocked = Boolean(
    onRunningSubmit && (hasAttachments ?? Boolean(attachments)),
  );
  const input = (
    <PromptInput
      minRows={1}
      maxRows={12}
      className={cn(
        conversationComposerClassName,
        attachments
          ? "border-0 bg-transparent shadow-none focus-within:shadow-none dark:bg-transparent"
          : undefined,
        className,
      )}
      labels={{
        stopGenerating: agentUiT("stopGenerating"),
        sendPrompt: agentUiT("sendPrompt"),
      }}
      {...props}
      leadingAction={
        onRunningSubmit ? (
          <>
            {props.leadingAction}
            <AgentQueueActions
              disabled={Boolean(
                props.disabled ||
                  props.readOnly ||
                  queuePending ||
                  attachmentsBlocked ||
                  !props.value?.trim(),
              )}
              attachmentsBlocked={attachmentsBlocked}
              onSend={onRunningSubmit}
            />
          </>
        ) : (
          props.leadingAction
        )
      }
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          !onRunningSubmit ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        event.preventDefault();
        if (
          !props.disabled &&
          !props.readOnly &&
          !queuePending &&
          !attachmentsBlocked &&
          props.value?.trim()
        )
          onRunningSubmit(event.altKey ? "follow_up" : "steer");
      }}
    />
  );
  return attachments ? (
    <div className={conversationComposerSurfaceClassName}>
      <div className="px-4 pt-3">{attachments}</div>
      {input}
    </div>
  ) : (
    input
  );
}

const CONTEXT_CATEGORY_COLOR: Record<ContextCategory, string> = {
  systemPrompt: "bg-violet",
  systemTools: "bg-primary",
  systemContext: "bg-muted-foreground/50",
  instructionFiles: "bg-warning",
  skills: "bg-success",
  messages: "bg-foreground/80",
};

function ContextBreakdown({
  breakdown,
  maxTokens,
}: {
  breakdown: Record<ContextCategory, number>;
  maxTokens: number;
}) {
  const t = useTranslations("console.agents.contextCategories");
  return (
    <div className="min-w-56 space-y-2">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {CONTEXT_CATEGORIES.map((category) => (
          <span
            key={category}
            className={CONTEXT_CATEGORY_COLOR[category]}
            style={{
              width: `${Math.min(100, (breakdown[category] / maxTokens) * 100)}%`,
            }}
          />
        ))}
      </div>
      <dl className="space-y-1">
        {CONTEXT_CATEGORIES.filter((category) => breakdown[category] > 0).map(
          (category) => (
            <div key={category} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  CONTEXT_CATEGORY_COLOR[category],
                )}
              />
              <dt className="flex-1">{t(category)}</dt>
              <dd className="tabular-nums">
                {breakdown[category].toLocaleString()}
              </dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}

export function ConversationContextUsage({
  busy = false,
  usage,
}: {
  busy?: boolean;
  usage: ContextUsageSnapshot | null;
}) {
  const t = useTranslations("console.agents");
  if (!usage) return null;
  const percentage = Math.round(
    Math.min(100, Math.max(0, (usage.usedTokens / usage.maxTokens) * 100)),
  );
  return (
    <MorphPopover>
      <MorphPopoverTrigger>
        <button
          type="button"
          aria-label={`${t("contextUsage")} ${percentage}%`}
          aria-busy={busy || undefined}
        >
          <meter
            min={0}
            max={100}
            value={percentage}
            aria-label={t("contextUsage")}
            className="sr-only"
          />
          <AnimatedBadge
            status={
              busy
                ? "loading"
                : percentage >= 90
                  ? "danger"
                  : percentage >= 75
                    ? "warning"
                    : "neutral"
            }
          >
            {percentage}%
          </AnimatedBadge>
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="z-50 w-64 max-w-[calc(100vw-2rem)] space-y-2 p-3 text-xs"
      >
        <p className="font-medium text-foreground">{t("contextUsage")}</p>
        <p className="tabular-nums text-muted-foreground">
          {usage.estimated ? "≈ " : ""}
          {usage.usedTokens.toLocaleString()} /{" "}
          {usage.maxTokens.toLocaleString()} ({percentage}%)
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {usage.modelName}
        </p>
        {usage.breakdown ? (
          <ContextBreakdown
            breakdown={usage.breakdown}
            maxTokens={usage.maxTokens}
          />
        ) : null}
        {usage.estimated ? (
          <p className="text-muted-foreground">{t("contextUsageEstimated")}</p>
        ) : null}
      </MorphPopoverContent>
    </MorphPopover>
  );
}

const DATA_BASE64_URL =
  /^data:[\w.+-]+\/[\w.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ATTACHMENT_PATH = /^\/api\/v1\/attachments\/[\w-]+$/;
const TASK_FILE_URL =
  /^\/api\/v1\/a2a\/files\/[A-Za-z0-9_-]{1,200}\/download\?task=[A-Za-z0-9_-]{1,200}$/;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

type FileUrlKind = "data" | "attachment" | "task-file";
type FileUnavailableReason = "deleted" | "expired" | "forbidden";

class FileUnavailableError extends Error {}

function fetchConversationFile(
  url: string,
  init: { method?: "GET" | "HEAD"; signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

export function allowedFileUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (DATA_BASE64_URL.test(url)) return url;
  if (ATTACHMENT_PATH.test(url) || TASK_FILE_URL.test(url)) return url;
  if (typeof window === "undefined") return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.origin === window.location.origin &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      ((ATTACHMENT_PATH.test(parsed.pathname) && !parsed.search) ||
        TASK_FILE_URL.test(`${parsed.pathname}${parsed.search}`))
    )
      return parsed.href;
  } catch {
    /* Invalid URLs are unavailable, never navigation targets. */
  }
  return undefined;
}

function fileUrlKind(safeUrl?: string): FileUrlKind | null {
  if (!safeUrl) return null;
  if (safeUrl.startsWith("data:")) return "data";
  if (ATTACHMENT_PATH.test(safeUrl)) return "attachment";
  if (TASK_FILE_URL.test(safeUrl)) return "task-file";
  try {
    const parsed = new URL(safeUrl);
    if (ATTACHMENT_PATH.test(parsed.pathname) && !parsed.search)
      return "attachment";
    if (TASK_FILE_URL.test(`${parsed.pathname}${parsed.search}`))
      return "task-file";
  } catch {
    return null;
  }
  return null;
}

function unavailableForStatus(
  status: number,
  kind: FileUrlKind | null,
): FileUnavailableReason | null {
  if (status === 403) return "forbidden";
  if (status === 404) {
    if (kind === "attachment") return "deleted";
    if (kind === "task-file") return "expired";
  }
  return null;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local thumbnail URLs live only as long as the attachment; content loads on open. */
export function ConversationFilePreview({
  file,
  name,
  url,
  mimeType,
  producer,
  size: byteSizeProp,
  display = "chip",
  progress,
  onRemove,
  removeLabel,
}: {
  file?: File;
  name: string;
  url?: string;
  mimeType?: string;
  producer?: string;
  size?: number;
  display?: "chip" | "inline";
  progress?: number;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const t = useTranslations("filePreview");
  const agents = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [unavailableState, setUnavailableState] = useState<{
    url: string;
    reason: FileUnavailableReason;
  }>();
  const [thumbnail, setThumbnail] = useState<{ file: File; url: string }>();
  const [taskPreview, setTaskPreview] = useState<{
    url: string;
    objectUrl: string;
  }>();
  const [imageErrorUrl, setImageErrorUrl] = useState<string>();
  const downloadAbortRef = useRef<AbortController | null>(null);

  const inline = display === "inline";
  const type = previewType(name, file?.type || mimeType);
  const image = type.kind === "image";
  const safeUrl = allowedFileUrl(url);
  const urlKind = fileUrlKind(safeUrl);
  const unavailable = t("unavailable");
  const byteSize =
    file?.size ??
    (typeof byteSizeProp === "number" &&
    Number.isFinite(byteSizeProp) &&
    byteSizeProp >= 0
      ? byteSizeProp
      : undefined);
  const sizeLabel =
    byteSize !== undefined ? formatByteSize(byteSize) : undefined;
  const canInlineImage =
    image && (byteSize === undefined || byteSize <= MAX_INLINE_IMAGE_BYTES);
  const unavailableReason =
    safeUrl && unavailableState?.url === safeUrl
      ? unavailableState.reason
      : null;

  const unavailableNotice = useCallback(
    (reason: FileUnavailableReason) => {
      if (reason === "forbidden") return t("forbidden");
      if (reason === "expired") return t("expired");
      return t("deletedNotice");
    },
    [t],
  );

  useEffect(() => () => downloadAbortRef.current?.abort(), []);

  // Unlike inline images, persisted document cards do not issue a GET until opened.
  useEffect(() => {
    if (
      !inline ||
      !producer ||
      canInlineImage ||
      !safeUrl ||
      urlKind !== "attachment"
    )
      return;
    const controller = new AbortController();
    void fetchConversationFile(safeUrl, {
      method: "HEAD",
      signal: controller.signal,
    })
      .then((response) => {
        const reason = unavailableForStatus(response.status, urlKind);
        if (reason && !controller.signal.aborted)
          setUnavailableState({ url: safeUrl, reason });
      })
      .catch(() => {}); // Transient network failures can still be retried by opening the card.
    return () => controller.abort();
  }, [inline, producer, canInlineImage, safeUrl, urlKind]);

  useEffect(() => {
    if (!file || !canInlineImage) return;
    const objectUrl = URL.createObjectURL(file);
    // Object URL creation is an external resource synchronization.
    setThumbnail({ file, url: objectUrl });
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, canInlineImage]);

  useEffect(() => {
    if (
      file ||
      !canInlineImage ||
      !safeUrl ||
      urlKind !== "task-file" ||
      unavailableReason
    )
      return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetchConversationFile(safeUrl, { signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        const reason = unavailableForStatus(response.status, urlKind);
        if (reason) {
          setUnavailableState({ url: safeUrl, reason });
          return;
        }
        if (!response.ok) return;
        if (
          Number(response.headers.get("content-length")) >
          MAX_INLINE_IMAGE_BYTES
        ) {
          await response.body?.cancel();
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.size || blob.size > MAX_INLINE_IMAGE_BYTES) return;
        const resolvedType = type.mimeType || mimeType || blob.type;
        const typedBlob =
          resolvedType && blob.type !== resolvedType
            ? new Blob([blob], { type: resolvedType })
            : blob;
        objectUrl = URL.createObjectURL(typedBlob);
        setTaskPreview({ url: safeUrl, objectUrl });
      })
      .catch(() => {
        /* Network errors leave the icon fallback; clicking preview/download surfaces the error. */
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    file,
    canInlineImage,
    safeUrl,
    urlKind,
    unavailableReason,
    type.mimeType,
    mimeType,
  ]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (file) return file;
      if (!safeUrl) throw new Error(unavailable);
      const response = await fetchConversationFile(safeUrl, { signal });
      const reason = unavailableForStatus(response.status, urlKind);
      if (reason) {
        const message = unavailableNotice(reason);
        setUnavailableState({ url: safeUrl, reason });
        setOpen(false);
        notify(message, { severity: "warning" });
        throw new FileUnavailableError(message);
      }
      if (!response.ok) throw new Error(unavailable);
      return response.blob();
    },
    [file, safeUrl, urlKind, unavailable, unavailableNotice],
  );

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const blob = await load(controller.signal);
      if (controller.signal.aborted) return;
      saveBlob(blob, name);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !(error instanceof FileUnavailableError)
      )
        notify(unavailable, { severity: "warning" });
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }, [downloading, load, name, unavailable]);

  const rawSource = file
    ? thumbnail?.file === file
      ? thumbnail.url
      : undefined
    : urlKind === "task-file"
      ? taskPreview && taskPreview.url === safeUrl
        ? taskPreview.objectUrl
        : undefined
      : safeUrl;
  const source =
    rawSource && imageErrorUrl !== rawSource ? rawSource : undefined;

  const handleImageError = useCallback(() => {
    if (!rawSource) return;
    if (!file && safeUrl && urlKind === "attachment") {
      void fetchConversationFile(safeUrl, { method: "HEAD" })
        .then((response) => {
          const reason = unavailableForStatus(response.status, urlKind);
          if (reason) setUnavailableState({ url: safeUrl, reason });
          else setImageErrorUrl(rawSource);
        })
        .catch(() => {
          setImageErrorUrl(rawSource);
        });
      return;
    }
    setImageErrorUrl(rawSource);
  }, [file, rawSource, safeUrl, urlKind]);

  const typeLabel = type.mimeType || file?.type || mimeType || t("file");
  const unavailableLabel =
    unavailableReason === "forbidden"
      ? t("forbidden")
      : unavailableReason === "expired"
        ? t("expired")
        : unavailableReason === "deleted"
          ? t("deleted")
          : null;
  const showInlineImage = inline && canInlineImage && Boolean(source);

  return (
    <div
      className={cn(
        "flex max-w-full gap-2",
        showInlineImage ? "items-end" : "items-center",
      )}
    >
      {unavailableReason ? (
        <span className="flex min-w-0 max-w-xs items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-muted-foreground">
          <FileX aria-hidden="true" className="size-8 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium line-through">
              {name}
            </span>
            <span className="block truncate text-xs">{unavailableLabel}</span>
            {producer ? (
              <span className="block truncate text-xs">
                {t("producedBy", { name: producer })}
              </span>
            ) : null}
          </span>
        </span>
      ) : showInlineImage ? (
        <button
          type="button"
          aria-label={t("open", { name })}
          onClick={() => setOpen(true)}
          className="flex min-w-0 max-w-full flex-col overflow-hidden rounded-lg border border-border bg-background text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex max-h-60 w-full items-center justify-center bg-muted/20">
            {/* biome-ignore lint/performance/noImgElement: Authorized attachment, data, and Blob previews need intrinsic aspect ratio at max-h-60 without the Next image optimizer. */}
            <img
              src={source}
              alt=""
              className="max-h-60 max-w-full object-contain"
              onError={handleImageError}
            />
          </span>
          <span className="w-full min-w-0 border-t border-border/60 px-3 py-2">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {typeLabel}
              {sizeLabel ? ` · ${sizeLabel}` : ""}
            </span>
            {producer ? (
              <span className="block truncate text-xs text-muted-foreground">
                {t("producedBy", { name: producer })}
              </span>
            ) : null}
          </span>
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("open", { name })}
          onClick={() => setOpen(true)}
          className="flex min-w-0 max-w-xs items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {!inline && canInlineImage && source ? (
            <Image
              src={source}
              alt=""
              width={40}
              height={40}
              unoptimized
              className="size-10 shrink-0 rounded-md object-cover"
              onError={handleImageError}
            />
          ) : (
            <FileIcon
              aria-hidden="true"
              className="size-8 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {typeLabel}
              {sizeLabel ? ` · ${sizeLabel}` : ""}
            </span>
            {producer ? (
              <span className="block truncate text-xs text-muted-foreground">
                {t("producedBy", { name: producer })}
              </span>
            ) : null}
          </span>
        </button>
      )}
      {inline && !unavailableReason && (file || safeUrl) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("download")}
          title={t("download")}
          disabled={downloading}
          onClick={() => void handleDownload()}
          className="shrink-0"
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-4" aria-hidden="true" />
          )}
        </Button>
      ) : null}
      {progress !== undefined ? (
        <span role="status" className="text-xs text-muted-foreground">
          {Math.round(progress * 100)}%
        </span>
      ) : null}
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={removeLabel || agents("removeAttachment", { name })}
          onClick={onRemove}
        >
          <X className="size-4" />
        </Button>
      ) : null}
      <FilePreviewDialog
        open={open}
        onOpenChange={setOpen}
        name={name}
        mimeType={file?.type || mimeType}
        size={sizeLabel}
        load={load}
        error={!file && !safeUrl ? unavailable : undefined}
      />
    </div>
  );
}
