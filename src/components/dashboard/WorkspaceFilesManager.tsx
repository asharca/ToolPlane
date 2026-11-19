"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Trash2,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Tooltip } from "@/components/motion/tooltip";
import { StorageUsage, useFormatBytes } from "@/components/ui/StorageUsage";
import { apiRequest } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { DashboardEmptyState } from "./DashboardUI";
import { DashboardTable } from "./DashboardTable";
import { DialogCancel, DialogFooter, DialogHeader } from "./dialog";
import { notify } from "./Toaster";

type FileKind = "attachment" | "a2a";
type KindFilter = "all" | FileKind;
type SortKey = "createdAt" | "size";
type DeleteFailureCode = "forbidden" | "not_found" | "in_use" | "storage_error";

type WorkspaceFile = {
  id: string;
  kind: FileKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  uploader: { id: string; name: string | null } | null;
  source: {
    type: "conversation" | "chatThread" | "a2aTask" | "draft";
    id: string | null;
    label: string | null;
    href: string | null;
  };
  downloadUrl: string | null;
  canDelete: boolean;
  deleteBlockedReason: "forbidden" | "in_use" | null;
};

export type WorkspaceStorageUsage = {
  workspaceBytes: number;
  owner: { usedBytes: number; storageQuotaBytes: number } | null;
};

type FilesPage = {
  files: WorkspaceFile[];
  nextCursor: string | null;
  usage: WorkspaceStorageUsage;
};

type DeleteResult = {
  deleted: Array<{ kind: FileKind; id: string }>;
  failed: Array<{ kind: FileKind; id: string; code: DeleteFailureCode }>;
};

const DELETE_BATCH = 100;
// Column widths in px. Name and source share what the measured area leaves;
// the table's filler column absorbs the scrollbar allowance.
const CHECKBOX_COLUMN = 48;
const SIZE_COLUMN = 96;
const DATE_COLUMN = 176;
const ACTIONS_COLUMN = 112;
const SCROLLBAR_ALLOWANCE = 16;
const COMPACT_BELOW = 680;

const rowId = (file: { kind: FileKind; id: string }) =>
  `${file.kind}:${file.id}`;

function MimeIcon({ mimeType }: { mimeType: string }) {
  const mime = mimeType.toLowerCase();
  const Icon = mime.startsWith("image/")
    ? FileImage
    : mime.startsWith("audio/")
      ? FileAudio
      : mime.startsWith("video/")
        ? FileVideo
        : mime.startsWith("text/") ||
            mime === "application/pdf" ||
            mime === "application/json"
          ? FileText
          : /zip|tar|gzip|compressed|archive/.test(mime)
            ? FileArchive
            : FileIcon;
  return (
    <Icon
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}

export function WorkspaceFilesManager({
  workspaceId,
  initialUsage,
}: {
  workspaceId: string;
  initialUsage: WorkspaceStorageUsage;
}) {
  const t = useTranslations("console.workspaceFiles");
  const settingsT = useTranslations("console.settings");
  const common = useTranslations("common");
  const format = useFormatter();
  const formatBytes = useFormatBytes();
  const router = useRouter();
  const promptId = useId();
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<FilesPage | null>(null);
  const [usage, setUsage] = useState(initialUsage);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string | null }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTargets, setConfirmTargets] = useState<WorkspaceFile[]>([]);
  const [areaWidth, setAreaWidth] = useState(0);
  const tableArea = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const deletingRef = useRef(false);
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files`;
  const deleting = pendingIds.size > 0;

  function listUrl(cursor: string | null) {
    const query = new URLSearchParams({ kind, sort });
    if (cursor) query.set("cursor", cursor);
    return `${endpoint}?${query}`;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: The list URL is derived from these inputs; `reload` requests a fresh first page.
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setLoading(true);
    apiRequest<FilesPage>(listUrl(null), { signal: controller.signal }).then(
      (result) => {
        if (current !== generation.current) return;
        if (result.ok) {
          setPage(result.data);
          setUsage(result.data.usage);
          setLoadError(undefined);
        } else {
          setLoadError({ message: result.message });
        }
        setLoading(false);
        setLoadingMore(false);
      },
    );
    return () => controller.abort();
  }, [endpoint, kind, sort, reload]);

  useEffect(() => {
    const area = tableArea.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) =>
      setAreaWidth(Math.floor(entry.contentRect.width)),
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  async function loadMore() {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore || loading) return;
    const current = generation.current;
    setLoadingMore(true);
    const result = await apiRequest<FilesPage>(listUrl(cursor));
    if (current !== generation.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      notify(result.message ?? t("loadError"), { severity: "error" });
      return;
    }
    setPage((previous) => {
      const loaded = new Set(previous?.files.map(rowId));
      return {
        files: [
          ...(previous?.files ?? []),
          ...result.data.files.filter((file) => !loaded.has(rowId(file))),
        ],
        nextCursor: result.data.nextCursor,
        usage: result.data.usage,
      };
    });
    setUsage(result.data.usage);
  }

  function openConfirm(targets: WorkspaceFile[], trigger: HTMLElement) {
    if (deleting || targets.length === 0) return;
    returnFocus.current = trigger;
    setConfirmTargets(targets);
    setConfirmOpen(true);
  }

  async function remove(targets: WorkspaceFile[]) {
    if (deletingRef.current || targets.length === 0) return;
    deletingRef.current = true;
    setPendingIds(new Set(targets.map(rowId)));
    const deleted: DeleteResult["deleted"] = [];
    const failed: DeleteResult["failed"] = [];
    let requestError: string | null = null;
    try {
      for (let start = 0; start < targets.length; start += DELETE_BATCH) {
        const result = await apiRequest<DeleteResult>(endpoint, {
          method: "DELETE",
          json: {
            files: targets
              .slice(start, start + DELETE_BATCH)
              .map(({ kind, id }) => ({ kind, id })),
          },
        });
        if (!result.ok) {
          requestError = result.message ?? t("deleteError");
          break;
        }
        deleted.push(...result.data.deleted);
        failed.push(...result.data.failed);
      }
    } finally {
      deletingRef.current = false;
      setPendingIds(new Set());
    }
    const removed = new Set(deleted.map(rowId));
    setPage(
      (previous) =>
        previous && {
          ...previous,
          files: previous.files.filter((file) => !removed.has(rowId(file))),
        },
    );
    setSelectedIds((current) => current.filter((id) => !removed.has(id)));
    if (deleted.length) notify(t("deletedCount", { count: deleted.length }));
    const failures = new Map<string, number>();
    for (const failure of failed)
      failures.set(failure.code, (failures.get(failure.code) ?? 0) + 1);
    for (const [code, count] of failures)
      notify(
        t("notDeleted", {
          count,
          reason: t.has(`failure.${code}`)
            ? t(`failure.${code}`)
            : t("failure.storage_error"),
        }),
        { severity: "error" },
      );
    if (requestError) notify(requestError, { severity: "error" });
    if (deleted.length || failed.length) {
      setReload((value) => value + 1);
      router.refresh();
    }
  }

  const files = page?.files ?? [];
  const deletable = new Set(
    files
      .filter((file) => file.canDelete && !pendingIds.has(rowId(file)))
      .map((file) => rowId(file)),
  );
  const visibleSelection = selectedIds.filter((id) => deletable.has(id));
  const selectable = files.some((file) => file.canDelete);
  const compact = areaWidth > 0 && areaWidth < COMPACT_BELOW;
  const flexibleWidth = Math.max(
    160,
    areaWidth -
      SCROLLBAR_ALLOWANCE -
      ACTIONS_COLUMN -
      (selectable ? CHECKBOX_COLUMN : 0) -
      (compact ? 0 : SIZE_COLUMN + DATE_COLUMN),
  );
  const nameWidth = compact ? flexibleWidth : Math.floor(flexibleWidth * 0.6);
  const sourceWidth = flexibleWidth - nameWidth;
  const date = (value: string) =>
    format.dateTime(new Date(value), { dateStyle: "medium" });
  const destructive =
    "bg-destructive text-destructive-foreground hover:bg-destructive/90";

  function sourceCell(file: WorkspaceFile) {
    const label = file.source.label ?? t(`sources.${file.source.type}`);
    return file.source.href ? (
      <Link
        href={file.source.href}
        className="block truncate hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {label}
      </Link>
    ) : (
      <span className="block truncate text-muted-foreground">{label}</span>
    );
  }

  function row(file: WorkspaceFile) {
    const pending = pendingIds.has(rowId(file));
    const dim = pending ? "opacity-50" : undefined;
    const secondary = compact
      ? `${formatBytes(file.size)} · ${date(file.createdAt)}`
      : file.uploader?.name
        ? t("uploadedBy", { name: file.uploader.name })
        : null;
    const name = (
      <span
        key="name"
        className={cn("flex min-w-0 items-center gap-2", dim)}
        title={file.name}
      >
        <MimeIcon mimeType={file.mimeType} />
        <span className="min-w-0">
          <span className="block truncate">{file.name}</span>
          {secondary ? (
            <span className="block truncate text-xs text-muted-foreground">
              {secondary}
            </span>
          ) : null}
        </span>
      </span>
    );
    const actions = (
      <div key="actions" className="flex items-center justify-end gap-1">
        {pending ? (
          <Loader2
            role="status"
            aria-label={t("deleting")}
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : (
          <>
            {file.downloadUrl ? (
              <Tooltip side="left" content={t("download")}>
                <ButtonLink
                  href={file.downloadUrl}
                  download={file.name}
                  variant="ghost"
                  size="icon"
                  aria-label={t("downloadFile", { name: file.name })}
                >
                  <Download className="size-4" aria-hidden="true" />
                </ButtonLink>
              </Tooltip>
            ) : null}
            {file.canDelete ? (
              <Tooltip side="left" content={common("delete")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={deleting}
                  aria-label={t("deleteFile", { name: file.name })}
                  onClick={(event) => openConfirm([file], event.currentTarget)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </Tooltip>
            ) : file.deleteBlockedReason === "in_use" ? (
              <span className="px-1 text-xs text-muted-foreground">
                {t("inUse")}
              </span>
            ) : null}
          </>
        )}
      </div>
    );
    const cells: ReactNode[] = compact
      ? [name, actions]
      : [
          name,
          <span key="size" className={cn("tabular-nums", dim)}>
            {formatBytes(file.size)}
          </span>,
          <span key="source" className={cn("block min-w-0", dim)}>
            {sourceCell(file)}
          </span>,
          <span key="date" className={cn("block text-xs", dim)}>
            <time dateTime={file.createdAt} className="block truncate">
              {date(file.createdAt)}
            </time>
            {file.expiresAt ? (
              <time
                dateTime={file.expiresAt}
                className="block truncate text-muted-foreground"
              >
                {t("expiresOn", { date: date(file.expiresAt) })}
              </time>
            ) : null}
          </span>,
          actions,
        ];
    return { id: rowId(file), cells };
  }

  const nameHeader = { label: t("name"), width: `${nameWidth}px` };
  const actionsHeader = {
    label: <span className="sr-only">{t("actions")}</span>,
    width: `${ACTIONS_COLUMN}px`,
    align: "right" as const,
  };
  const prompt =
    confirmTargets.length === 1
      ? t("deletePrompt", { name: confirmTargets[0].name })
      : t("deleteManyPrompt", { count: confirmTargets.length });

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {usage.owner ? (
          <StorageUsage
            label={settingsT("ownedWorkspaceStorage")}
            usedBytes={usage.owner.usedBytes}
            quotaBytes={usage.owner.storageQuotaBytes}
          />
        ) : null}
        <StorageUsage
          label={settingsT("thisWorkspaceStorage")}
          usedBytes={usage.workspaceBytes}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          variant="segment"
          value={kind}
          onValueChange={(value) => {
            setKind(value as KindFilter);
            setSelectedIds([]);
          }}
        >
          <TabsList aria-label={t("kind")} className="bg-muted/60">
            {(["all", "attachment", "a2a"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="px-3 py-1 text-xs"
              >
                {t(`kinds.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs
          variant="segment"
          value={sort}
          onValueChange={(value) => setSort(value as SortKey)}
        >
          <TabsList aria-label={t("sort")} className="bg-muted/60">
            {(["createdAt", "size"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="px-3 py-1 text-xs"
              >
                {t(value === "size" ? "sortSize" : "sortCreatedAt")}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div
        ref={tableArea}
        aria-busy={loading || deleting}
        className="min-w-0 space-y-3"
      >
        {loadError ? (
          <DashboardEmptyState
            title={loadError.message ?? t("loadError")}
            actions={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setReload((value) => value + 1)}
              >
                {t("retry")}
              </Button>
            }
          />
        ) : !page ? (
          <p role="status" className="text-sm text-muted-foreground">
            {common("loading")}
          </p>
        ) : files.length === 0 ? (
          <DashboardEmptyState title={t("empty")} />
        ) : (
          <DashboardTable
            ariaLabel={settingsT("files")}
            minWidth="0px"
            adjustableColumns={false}
            selectionPlacement="above"
            selectable={selectable}
            selectedRowIds={visibleSelection}
            onSelectionChange={(ids) =>
              setSelectedIds(ids.filter((id) => deletable.has(id)))
            }
            selectionActions={({ selectedRowIds }) => (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={deleting}
                onClick={(event) => {
                  const selected = new Set(selectedRowIds);
                  openConfirm(
                    files.filter((file) => selected.has(rowId(file))),
                    event.currentTarget,
                  );
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t("deleteSelected", { count: selectedRowIds.length })}
              </Button>
            )}
            headers={
              compact
                ? [nameHeader, actionsHeader]
                : [
                    nameHeader,
                    {
                      label: t("size"),
                      width: `${SIZE_COLUMN}px`,
                    },
                    { label: t("source"), width: `${sourceWidth}px` },
                    { label: t("created"), width: `${DATE_COLUMN}px` },
                    actionsHeader,
                  ]
            }
            rows={files.map(row)}
          />
        )}
        {!loadError && page?.nextCursor ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={loading || loadingMore}
              aria-busy={loadingMore || undefined}
              onClick={loadMore}
            >
              {loadingMore ? common("loading") : t("loadMore")}
            </Button>
          </div>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape inside the nested confirmation must stop here, before the settings dialog's window listener closes it too. */}
      <div
        className="contents"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !confirmOpen) return;
          event.preventDefault();
          event.stopPropagation();
          setConfirmOpen(false);
        }}
      >
        <CenterMorphModal open={confirmOpen} onOpenChange={setConfirmOpen}>
          <CenterMorphModalContent
            ariaLabel={t("deleteTitle")}
            ariaDescribedBy={promptId}
            closeButtonLabel={common("close")}
            onExitComplete={() => {
              if (returnFocus.current?.isConnected)
                returnFocus.current.focus({ preventScroll: true });
              returnFocus.current = null;
            }}
          >
            <DialogHeader
              title={t("deleteTitle")}
              description={
                <span id={promptId} className="break-words">
                  {prompt}
                </span>
              }
            />
            <DialogFooter cancel={<DialogCancel />}>
              <Button
                type="button"
                variant="primary"
                size="md"
                className={destructive}
                onClick={() => {
                  const targets = confirmTargets;
                  setConfirmOpen(false);
                  void remove(targets);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {common("delete")}
              </Button>
            </DialogFooter>
          </CenterMorphModalContent>
        </CenterMorphModal>
      </div>
    </div>
  );
}
