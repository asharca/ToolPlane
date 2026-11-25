"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import { Download, FileText, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Button } from "@/components/motion/button";
import { Loader } from "@/components/motion/loader";
import { Table, type TableColumn } from "@/components/motion/table";
import {
  AIArtifact,
  type AIArtifactLabels,
} from "@/components/agents/ai-artifacts";
import type { AgentCodeLanguage } from "@/components/agents/agent-code";
import {
  parseDelimitedPreview,
  type DelimitedPreview,
} from "@/lib/csv-preview";
import {
  previewType,
  tableDelimiter,
  type FilePreviewKind,
} from "@/lib/file-preview";
import { AssistantMarkdown } from "./ConversationMessage";

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
const TABLE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const TABLE_PREVIEW_MAX_ROWS = 1000;
const TABLE_PREVIEW_MAX_COLUMNS = 50;

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.split(/[\\/]/).pop() || "file";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  // Text previews are an AIArtifact whose own header carries the close control.
  const textPreview = ["text", "markdown"].includes(
    previewType(props.name, props.mimeType).kind,
  );
  const content = (
    <PreviewContent
      key={props.name}
      {...props}
      requestRef={requestRef}
      ownClose={textPreview}
    />
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
            {textPreview ? null : (
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
            )}
          </div>
        ) : null}
      </dialog>
    );
  return (
    <CenterMorphModal open={props.open} onOpenChange={props.onOpenChange}>
      <CenterMorphModalContent
        ariaLabel={props.name}
        closeButtonLabel={t("close")}
        showCloseButton={!textPreview}
        onExitComplete={restoreFocus}
        className={
          textPreview
            ? "flex max-h-[min(88dvh,900px)] w-full max-w-4xl flex-col"
            : "flex h-[min(88dvh,900px)] w-full max-w-6xl flex-col"
        }
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
  table?: DelimitedPreview;
  url?: string;
};
function PreviewContent({
  name,
  onOpenChange,
  mimeType,
  size,
  load,
  onDownload,
  actions,
  error,
  requestRef,
  ownClose,
}: FilePreviewDialogProps & {
  requestRef: RefObject<AbortController | null>;
  ownClose: boolean;
}) {
  const t = useTranslations("filePreview");
  const [file, setFile] = useState<PreviewState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [downloading, setDownloading] = useState(false);
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
      let table: DelimitedPreview | undefined;
      if (type.kind === "text" || type.kind === "markdown") {
        text = await blob.text();
        if (text.includes("\0")) type = { kind: "unsupported" };
      } else if (type.kind === "table") {
        const sliced = blob.size > TABLE_PREVIEW_MAX_BYTES;
        const raw = await blob.slice(0, TABLE_PREVIEW_MAX_BYTES).text();
        if (raw.includes("\0")) {
          type = { kind: "unsupported" };
        } else {
          const parsed = parseDelimitedPreview(
            raw,
            tableDelimiter(name, mimeType || blob.type),
            {
              maxRows: TABLE_PREVIEW_MAX_ROWS,
              maxColumns: TABLE_PREVIEW_MAX_COLUMNS,
            },
          );
          if (sliced) {
            if (!parsed.truncatedRows && parsed.rows.length > 0) {
              parsed.rows.pop();
            }
            parsed.truncatedRows = true;
          }
          if (parsed.rows.length === 0) {
            type = { kind: "text" };
            text = raw;
          } else {
            table = parsed;
          }
        }
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
      setFile({ blob, text, table, url: objectUrl, kind: type.kind });
    })().catch(() => {
      if (!controller.signal.aborted) setLoadError(unavailable);
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
        saveBlob(blob, name);
      }
    } catch {
      setOperationError(unavailable);
    } finally {
      setDownloading(false);
    }
  }
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const codeLanguage = Object.hasOwn(languages, extension)
    ? languages[extension]
    : "text";
  const labels = useArtifactLabels();
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
  if (
    !loadError &&
    file?.blob?.size &&
    (file.kind === "text" || file.kind === "markdown")
  ) {
    const filename = name.split(/[\\/]/).pop() || "file";
    return (
      <>
        {error || operationError ? (
          <p
            role="alert"
            className="shrink-0 break-words px-4 py-2 text-sm text-destructive"
          >
            {error || operationError}
          </p>
        ) : null}
        <AIArtifact
          kind={file.kind === "markdown" ? "document" : "code"}
          title={
            file.kind === "markdown"
              ? filename
              : codeLanguage === "text"
                ? (labels.component.plainText ?? codeLanguage)
                : codeLanguage
          }
          filename={filename}
          language={codeLanguage}
          versions={[
            { id: "current", label: labels.current, content: file.text ?? "" },
          ]}
          renderDocument={(text) => <AssistantMarkdown text={text} />}
          onDownload={download}
          actions={actions}
          onClose={() => onOpenChange(false)}
          labels={labels.component}
          className="rounded-none border-0 bg-transparent"
        />
      </>
    );
  }
  return (
    <>
      <header
        className={
          ownClose
            ? "flex shrink-0 items-center gap-3 border-b border-border px-4 pt-5 pb-4 sm:pl-6"
            : "flex shrink-0 items-center gap-3 border-b border-border pt-5 pb-4 pl-4 pr-14 sm:pl-6"
        }
      >
        <FileText
          className="size-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" title={name}>
            {name}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
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
            <Loader variant="spinner" size={16} label={t("loading")} />
          ) : (
            <Download className="size-4" />
          )}
        </Button>
        {actions}
        {ownClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("close")}
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </header>
      {error || operationError ? (
        <p
          role="alert"
          className="shrink-0 break-words px-4 py-2 text-sm text-destructive"
        >
          {error || operationError}
        </p>
      ) : null}
      {file?.kind === "image" && !loadError && file.blob?.size ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
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
            <Loader
              variant="spinner"
              size={16}
              label={t("loading")}
              className="text-muted-foreground"
            />
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
        ) : file.kind === "table" && file.table ? (
          <TablePreview preview={file.table} />
        ) : null}
      </div>
    </>
  );
}

type TablePreviewRow = {
  index: number;
  cells: string[];
};

function TablePreview({ preview }: { preview: DelimitedPreview }) {
  const t = useTranslations("filePreview");
  const { columns, rows } = useMemo(() => {
    const [headerRow = [], ...bodyRows] = preview.rows;
    const columnCount = preview.rows.reduce(
      (max, row) => Math.max(max, row.length),
      0,
    );
    const cols: TableColumn<TablePreviewRow>[] = Array.from(
      { length: columnCount },
      (_, i) => {
        const label = headerRow[i]?.trim();
        return {
          key: `c${i}`,
          header: label || t("column", { index: i + 1 }),
          width: "160px",
          cell: (row) => row.cells[i] ?? "",
        };
      },
    );
    const data: TablePreviewRow[] = bodyRows.map((cells, index) => ({
      index,
      cells,
    }));
    return { columns: cols, rows: data };
  }, [preview.rows, t]);

  return (
    <div className="flex flex-col gap-3 p-4">
      {preview.truncatedRows || preview.truncatedColumns ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("tableTruncated", {
            rows: preview.rows.length,
            columns: columns.length,
          })}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table
          data={rows}
          columns={columns}
          getRowId={(row) => String(row.index)}
          rowHeight={36}
          height={480}
          emptyState={t("empty")}
        />
      </div>
    </div>
  );
}

/** Read-only previews never pass `onSave`, so editing labels are unreachable. */
function useArtifactLabels(): {
  current: string;
  component: Partial<AIArtifactLabels>;
} {
  const t = useTranslations("filePreview.artifact");
  return {
    current: t("current"),
    component: {
      artifact: (kind) =>
        t(kind === "code" ? "codeArtifact" : "documentArtifact"),
      markdownDocument: t("markdownDocument"),
      copy: () => t("copy"),
      download: () => t("download"),
      versionHistory: t("versionHistory"),
      closeArtifact: t("closeArtifact"),
      closeVersionHistory: t("closeVersionHistory"),
      preview: t("preview"),
      historyHint: t("historyHint"),
      firstDraft: t("firstDraft"),
      lines: (count) => t("lines", { count }),
      words: (count) => t("words", { count }),
      allChangesSaved: t("readOnly"),
      copied: t("copied"),
      downloaded: t("downloaded"),
      clipboardUnavailable: t("clipboardUnavailable"),
      copyFailed: t("copyFailed"),
      copyCode: t("copyCode"),
      codeCopied: t("codeCopied"),
      plainText: t("plainText"),
      taskDone: t("taskDone"),
      taskOpen: t("taskOpen"),
    },
  };
}
