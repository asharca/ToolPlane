"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import { Download, FileText, Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Button } from "@/components/motion/button";
import { CodeBlock } from "@/components/agents/code-block";
import type { AgentCodeLanguage } from "@/components/agents/agent-code";
import { AssistantMarkdown } from "./ConversationMessage";
import { previewType, type FilePreviewKind } from "@/lib/file-preview";

export type FilePreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  mimeType?: string;
  size?: string;
  load: (signal: AbortSignal) => Promise<Blob>;
  onDownload?: () => void | Promise<void>;
  actions?: ReactNode;
  error?: string;
};

const languages: Record<string, AgentCodeLanguage> = {
  ts: "typescript",
  js: "typescript",
  mjs: "typescript",
  tsx: "tsx",
  jsx: "tsx",
  json: "json",
  jsonl: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  diff: "diff",
  patch: "diff",
};
const mobileQuery = "(max-width: 639px)";
function subscribeMobile(notify: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

/** Domain adapter: shared desktop modal, native full-viewport mobile dialog. */
export function FilePreviewDialog(props: FilePreviewDialogProps) {
  const t = useTranslations("filePreview");
  const mobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(mobileQuery).matches,
    () => false,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (props.open)
      origin.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    else requestRef.current?.abort();
  }, [props.open]);
  const restoreFocus = () => {
    if (origin.current?.isConnected)
      origin.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!mobile || !props.open) return;
    const element = dialog.current;
    if (!element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (origin.current?.isConnected)
        origin.current.focus({ preventScroll: true });
    };
  }, [mobile, props.open]);
  const content = (
    <PreviewContent key={props.name} {...props} requestRef={requestRef} />
  );
  if (mobile)
    return (
      <dialog
        ref={dialog}
        aria-label={props.name}
        onCancel={(event) => {
          event.preventDefault();
          props.onOpenChange(false);
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-background p-0 text-foreground backdrop:bg-background/80"
      >
        {props.open ? (
          <div className="relative flex h-full min-h-0 flex-col">
            {content}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4"
              aria-label={t("close")}
              onClick={() => props.onOpenChange(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : null}
      </dialog>
    );
  return (
    <CenterMorphModal open={props.open} onOpenChange={props.onOpenChange}>
      <CenterMorphModalContent
        ariaLabel={props.name}
        closeButtonLabel={t("close")}
        onExitComplete={restoreFocus}
        className="flex h-[min(88dvh,900px)] w-full max-w-6xl flex-col"
      >
        {content}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

type PreviewState = {
  kind: FilePreviewKind;
  blob?: Blob;
  text?: string;
  url?: string;
};
function PreviewContent({
  name,
  mimeType,
  size,
  load,
  onDownload,
  actions,
  error,
  requestRef,
}: FilePreviewDialogProps & { requestRef: RefObject<AbortController | null> }) {
  const t = useTranslations("filePreview");
  const [file, setFile] = useState<PreviewState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const unavailable = t("unavailable");
  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    let objectUrl: string | undefined;
    // Synchronize a new external file source, not the surrounding tree's state.
    setFile(null);
    setLoadError("");
    void (async () => {
      let type = previewType(name, mimeType);
      if (type.kind === "unsupported") {
        if (!controller.signal.aborted) setFile({ kind: "unsupported" });
        return;
      }
      const blob = await load(controller.signal);
      if (controller.signal.aborted) return;
      type = previewType(name, mimeType || blob.type);
      let text: string | undefined;
      if (type.kind === "text" || type.kind === "markdown") {
        text = await blob.text();
        if (text.includes("\0")) type = { kind: "unsupported" };
      } else if (
        type.kind === "pdf" &&
        blob.size &&
        (await blob.slice(0, 5).text()) !== "%PDF-"
      ) {
        throw new Error(unavailable);
      }
      if (controller.signal.aborted) return;
      if (blob.size && (type.kind === "image" || type.kind === "pdf")) {
        objectUrl = URL.createObjectURL(
          new Blob([blob], { type: type.mimeType }),
        );
      }
      setFile({ blob, text, url: objectUrl, kind: type.kind });
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted)
        setLoadError(reason instanceof Error ? reason.message : unavailable);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [name, mimeType, load, requestRef, unavailable]);

  async function download() {
    setDownloading(true);
    setOperationError("");
    try {
      if (onDownload) await onDownload();
      else {
        const signal =
          requestRef.current?.signal ?? new AbortController().signal;
        const blob = file?.blob ?? (await load(signal));
        if (signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name.split(/[\\/]/).pop() || "file";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : unavailable);
    } finally {
      setDownloading(false);
    }
  }
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const codeLanguage = Object.hasOwn(languages, extension)
    ? languages[extension]
    : "text";
  const code = file?.kind === "text" || (file?.kind === "markdown" && source);
  const changeZoom = (factor: number) =>
    setZoom(
      Math.min(
        8,
        Math.max(
          0.1,
          (zoom ??
            ((image.current?.width || naturalWidth) / naturalWidth || 1)) *
            factor,
        ),
      ),
    );
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border py-4 pl-4 pr-16 sm:pl-6">
        <FileText
          className="size-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={name}>
            {name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {size ||
              (file?.blob
                ? `${file.blob.size.toLocaleString()} B`
                : mimeType || t("file"))}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("download")}
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
        </Button>
        {actions}
      </header>
      {error || operationError ? (
        <p
          role="alert"
          className="shrink-0 break-words px-4 py-2 text-sm text-destructive"
        >
          {error || operationError}
        </p>
      ) : null}
      {(file?.kind === "markdown" || code || file?.kind === "image") &&
      !loadError &&
      file?.blob?.size ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {file.kind === "markdown" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={!source}
                onClick={() => setSource(false)}
              >
                {t("preview")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={source}
                onClick={() => setSource(true)}
              >
                {t("source")}
              </Button>
            </>
          ) : null}
          {code ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={wrap}
              onClick={() => setWrap(!wrap)}
            >
              {t("wrap")}
            </Button>
          ) : null}
          {file.kind === "image" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("zoomOut")}
                onClick={() => changeZoom(0.8)}
              >
                <ZoomOut className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("zoomIn")}
                onClick={() => changeZoom(1.25)}
              >
                <ZoomIn className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={zoom === null}
                onClick={() => setZoom(null)}
              >
                {t("fit")}
              </Button>
              {zoom !== null ? (
                <span className="text-xs text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
        aria-busy={!file && !loadError}
      >
        {loadError ? (
          loadError !== error && loadError !== operationError ? (
            <p role="alert" className="p-6 text-sm text-destructive">
              {loadError}
            </p>
          ) : null
        ) : !file ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : file.blob?.size === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("empty")}</p>
        ) : file.kind === "unsupported" ? (
          <p className="p-6 text-sm text-muted-foreground">
            {t("unsupported")}
          </p>
        ) : file.kind === "image" && file.url ? (
          <div
            className={
              zoom === null
                ? "flex h-full items-center justify-center p-4"
                : "flex min-h-full w-max min-w-full items-center p-4"
            }
          >
            {/* biome-ignore lint/performance/noImgElement: Private Blob previews require intrinsic sizing and the native image ref for fit/zoom. */}
            <img
              ref={image}
              src={file.url}
              alt={name.split(/[\\/]/).pop() || name}
              className={
                zoom === null
                  ? "max-h-full max-w-full object-contain"
                  : "mx-auto max-w-none"
              }
              style={zoom === null ? undefined : { width: naturalWidth * zoom }}
              onLoad={(event) =>
                setNaturalWidth(event.currentTarget.naturalWidth)
              }
              onError={() => setLoadError(unavailable)}
            />
          </div>
        ) : file.kind === "pdf" && file.url ? (
          navigator.pdfViewerEnabled ? (
            <iframe
              src={file.url}
              title={name}
              referrerPolicy="no-referrer"
              className="h-full min-h-96 w-full border-0"
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {t("pdfFallback")}
            </p>
          )
        ) : code ? (
          <div className="p-4">
            <CodeBlock
              code={file.text ?? ""}
              language={codeLanguage}
              filename={name.split(/[\\/]/).pop()}
              wrap={wrap}
              maxHeight={640}
            />
          </div>
        ) : (
          <div className="mx-auto max-w-4xl break-words p-4 text-sm leading-7 sm:p-8">
            <AssistantMarkdown text={file.text ?? ""} />
          </div>
        )}
      </div>
    </>
  );
}
