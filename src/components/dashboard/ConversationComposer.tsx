"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { File as FileIcon, X } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { FilePreviewDialog } from "@/components/dashboard/FilePreviewDialog";
import { previewType } from "@/lib/file-preview";
import type { ContextUsageSnapshot } from "@/lib/context-usage";

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
    <Tooltip
      content={
        <div className="space-y-2">
          <p>{t("contextUsage")}</p>
          <p>
            {usage.estimated ? "≈ " : ""}
            {usage.usedTokens.toLocaleString()} /{" "}
            {usage.maxTokens.toLocaleString()} ({percentage}%)
          </p>
          <p>{usage.modelName}</p>
          {usage.estimated ? <p>{t("contextUsageEstimated")}</p> : null}
        </div>
      }
    >
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
    </Tooltip>
  );
}

function allowedAttachmentUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (
    /^data:[\w.+-]+\/[\w.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      url,
    )
  )
    return url;
  if (/^\/api\/v1\/attachments\/[\w-]+$/.test(url)) return url;
  if (typeof window === "undefined") return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.origin === window.location.origin &&
      !parsed.username &&
      !parsed.password &&
      /^\/api\/v1\/attachments\/[\w-]+$/.test(parsed.pathname) &&
      !parsed.search &&
      !parsed.hash
    )
      return parsed.href;
  } catch {
    /* Invalid URLs are unavailable, never navigation targets. */
  }
  return undefined;
}

/** Local thumbnail URLs live only as long as the attachment; content loads on open. */
export function ConversationFilePreview({
  file,
  name,
  url,
  mimeType,
  progress,
  onRemove,
  removeLabel,
}: {
  file?: File;
  name: string;
  url?: string;
  mimeType?: string;
  progress?: number;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const t = useTranslations("filePreview");
  const agents = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [thumbnail, setThumbnail] = useState<{ file: File; url: string }>();
  const type = previewType(name, file?.type || mimeType);
  const image = type.kind === "image";
  const safeUrl = allowedAttachmentUrl(url);
  const unavailable = t("unavailable");
  const size = file
    ? file.size < 1024
      ? `${file.size} B`
      : file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`
    : undefined;
  useEffect(() => {
    if (!file || !image) return;
    const objectUrl = URL.createObjectURL(file);
    // Object URL creation is an external resource synchronization.
    setThumbnail({ file, url: objectUrl });
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, image]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (file) return file;
      if (!safeUrl) throw new Error(unavailable);
      const response = await fetch(safeUrl, { signal, redirect: "error" });
      if (!response.ok) throw new Error(unavailable);
      return response.blob();
    },
    [file, safeUrl, unavailable],
  );
  const source = file
    ? thumbnail?.file === file
      ? thumbnail.url
      : undefined
    : safeUrl;
  return (
    <div className="flex max-w-full items-center gap-2">
      <button
        type="button"
        aria-label={t("open", { name })}
        onClick={() => setOpen(true)}
        className="flex min-w-0 max-w-xs items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {image && source ? (
          <Image
            src={source}
            alt=""
            width={40}
            height={40}
            unoptimized
            className="size-10 shrink-0 rounded-md object-cover"
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
            {type.mimeType || file?.type || mimeType || t("file")}
            {size ? ` · ${size}` : ""}
          </span>
        </span>
      </button>
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
        size={size}
        load={load}
        error={!file && !safeUrl ? unavailable : undefined}
      />
    </div>
  );
}
