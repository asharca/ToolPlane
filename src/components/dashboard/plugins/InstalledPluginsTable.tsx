"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowUpCircle,
  CircleSlash,
  MoreHorizontal,
  Puzzle,
  Search,
  Store,
  Trash2,
  X,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import {
  DashboardEmptyState,
  DashboardTable,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { notify } from "@/components/dashboard/Toaster";
import {
  pluginBatchAction,
  type PluginBatchOperation,
  type PluginBatchResult,
} from "@/lib/plugins/actions";
import type { PluginResourceKind } from "@/lib/plugins/release-contents";

export type InstalledPluginFilter = "all" | "updates" | "unavailable";

export type InstalledPluginItem = {
  installId: string;
  listingId: string;
  name: string;
  summary: string | null;
  /** Localized source label: official, repository, or workspace-private. */
  source: string;
  status: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  contents: Array<{ kind: PluginResourceKind; count: number }>;
  mcp: number;
  omp: boolean;
  agents: number;
  addedAt: string;
};

type BatchIssue = PluginBatchResult & { name: string; listingId: string };

/** `pluginBatchAction` accepts at most this many installs per call. */
const BATCH_LIMIT = 100;

export function InstalledPluginsTable({
  workspace,
  base,
  canManage,
  initialFilter,
  plugins,
}: {
  workspace: string;
  /** `/app/<workspace>/plugins` */
  base: string;
  canManage: boolean;
  initialFilter: InstalledPluginFilter;
  plugins: InstalledPluginItem[];
}) {
  const t = useTranslations("console.plugins");
  const common = useTranslations("common");
  const router = useRouter();
  const [filter, setFilter] = useState(initialFilter);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [operation, setOperation] = useOptimistic<PluginBatchOperation | null>(
    null,
  );
  const [issues, setIssues] = useState<BatchIssue[]>([]);
  const [refreshing, startRefresh] = useTransition();
  const submitting = useRef(false);
  const pending = operation !== null || refreshing;

  const byId = new Map(plugins.map((plugin) => [plugin.installId, plugin]));
  const updatable = plugins.filter((plugin) => plugin.updateAvailable);
  const unavailableCount = plugins.filter(
    (plugin) => plugin.status !== "published",
  ).length;
  const activeFilter =
    filter === "unavailable" && unavailableCount === 0 ? "all" : filter;
  const term = query.trim().toLocaleLowerCase();
  const visible = plugins.filter(
    (plugin) =>
      (activeFilter === "updates"
        ? plugin.updateAvailable
        : activeFilter === "unavailable"
          ? plugin.status !== "published"
          : true) &&
      (!term ||
        [plugin.name, plugin.summary ?? "", plugin.source].some((value) =>
          value.toLocaleLowerCase().includes(term),
        )),
  );
  const visibleIds = new Set(visible.map((plugin) => plugin.installId));
  // Bulk actions apply only to rows the current filter shows.
  const selection = selectedIds.filter((id) => visibleIds.has(id));
  const detailHref = (listingId: string, hash = "") =>
    `${base}/${encodeURIComponent(listingId)}?from=installed${hash}`;

  async function run(next: PluginBatchOperation, ids: string[]) {
    if (submitting.current || ids.length === 0) return;
    submitting.current = true;
    setOperation(next);
    setIssues([]);
    const results: PluginBatchResult[] = [];
    try {
      for (let index = 0; index < ids.length; index += BATCH_LIMIT) {
        const chunk = ids.slice(index, index + BATCH_LIMIT);
        try {
          results.push(...(await pluginBatchAction(workspace, next, chunk)));
        } catch {
          results.push(
            ...chunk.map((installId) => ({
              installId,
              outcome: "error" as const,
              message: "request_failed",
            })),
          );
        }
      }
      const count = (outcome: PluginBatchResult["outcome"]) =>
        results.filter((result) => result.outcome === outcome).length;
      const failed = count("error");
      setIssues(
        results
          .filter((result) => result.outcome !== "success")
          .map((result) => ({
            ...result,
            name: byId.get(result.installId)?.name ?? result.installId,
            listingId: byId.get(result.installId)?.listingId ?? "",
          })),
      );
      // Keep only failures selected so they can be retried.
      setSelectedIds(
        results
          .filter((result) => result.outcome === "error")
          .map((result) => result.installId),
      );
      notify(
        t("installed.summary", {
          success: count("success"),
          skipped: count("skipped"),
          error: failed,
        }),
        failed ? { severity: "error" } : undefined,
      );
      window.dispatchEvent(new Event("plugins-changed"));
    } finally {
      setOperation(null);
      submitting.current = false;
      startRefresh(() => router.refresh());
    }
  }

  const toolbar = (
    <DashboardToolbar
      actions={
        <>
          <ButtonLink href={base} variant="secondary" size="md">
            <Store className="size-4" />
            {t("installed.browse")}
          </ButtonLink>
          {canManage && updatable.length > 0 ? (
            <form
              action={async () => {
                await run(
                  "update",
                  updatable.map((plugin) => plugin.installId),
                );
              }}
            >
              <ConfirmSubmitButton
                triggerLabel={
                  <>
                    <ArrowUpCircle className="size-4" />
                    {t("installed.updateAll", { count: updatable.length })}
                  </>
                }
                triggerVariant="primary"
                confirmLabel={common("confirm")}
                cancelLabel={common("cancel")}
                prompt={t("installed.updatePrompt", {
                  count: updatable.length,
                })}
                pendingLabel={t("working")}
                disabled={pending}
                promptClassName="text-xs text-muted-foreground"
              />
            </form>
          ) : null}
        </>
      }
    >
      <h1 className="text-xl font-semibold">{t("installed.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("installed.subtitle", { count: plugins.length })}
        {updatable.length > 0
          ? ` · ${t("installed.subtitleUpdates", { count: updatable.length })}`
          : ""}
      </p>
    </DashboardToolbar>
  );

  if (plugins.length === 0) {
    return (
      <>
        {toolbar}
        <DashboardEmptyState
          icon={Puzzle}
          title={t("installed.empty")}
          actions={
            <ButtonLink href={base} variant="secondary" size="sm">
              <Store className="size-4" />
              {t("installed.browse")}
            </ButtonLink>
          }
        />
      </>
    );
  }

  const filters: Array<{
    key: InstalledPluginFilter;
    label: string;
    count: number;
  }> = [
    { key: "all", label: common("all"), count: plugins.length },
    {
      key: "updates",
      label: t("installed.filterUpdates"),
      count: updatable.length,
    },
    ...(unavailableCount > 0
      ? [
          {
            key: "unavailable" as const,
            label: t("installed.filterUnavailable"),
            count: unavailableCount,
          },
        ]
      : []),
  ];

  return (
    <>
      {toolbar}
      <div className="flex flex-wrap items-center gap-3">
        <fieldset
          aria-label={t("installed.filterLabel")}
          className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1"
        >
          {filters.map((item) => (
            <Button
              key={item.key}
              type="button"
              variant={activeFilter === item.key ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={activeFilter === item.key}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
              <span className="text-xs text-muted-foreground tabular-nums">
                {item.count}
              </span>
            </Button>
          ))}
        </fieldset>
        <Input
          value={query}
          onChange={setQuery}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          leftIcon={<Search className="size-4" />}
          className="w-full sm:w-72"
        />
      </div>
      {issues.length > 0 ? (
        <section
          aria-label={t("installed.issues")}
          className="space-y-2 rounded-xl border border-border bg-card px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t("installed.issues")}</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={common("close")}
              onClick={() => setIssues([])}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ul className="space-y-1 text-sm">
            {issues.map((issue) => (
              <li key={issue.installId} className="break-words">
                <span className="font-medium">{issue.name}</span>
                {" — "}
                <span
                  className={
                    issue.outcome === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {t.has(`batchMessage.${issue.message}`)
                    ? t(`batchMessage.${issue.message}`)
                    : t.has(`errors.${issue.message}`)
                      ? t(`errors.${issue.message}`)
                      : issue.message}
                </span>
                {(issue.message === "invalid_bindings" ||
                  issue.message === "tools_unavailable") &&
                issue.listingId ? (
                  <>
                    {" "}
                    <Link
                      href={detailHref(issue.listingId, "#plugin-install")}
                      className="text-primary hover:underline"
                    >
                      {t("installed.bind")}
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {visible.length === 0 ? (
        <DashboardEmptyState
          icon={Search}
          title={t("allEmpty")}
          actions={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              {t("clearFilters")}
            </Button>
          }
        />
      ) : (
        <fieldset disabled={pending} aria-busy={pending} className="min-w-0">
          <legend className="sr-only">{t("installed.title")}</legend>
          <DashboardTable
            ariaLabel={t("installed.title")}
            minWidth="52rem"
            selectable={canManage}
            selectedRowIds={canManage ? selection : undefined}
            onSelectionChange={
              canManage
                ? (ids) => {
                    if (!pending) setSelectedIds(ids);
                  }
                : undefined
            }
            selectionActions={
              canManage
                ? ({ selectedRowIds }) => {
                    const updateIds = selectedRowIds.filter(
                      (id) => byId.get(id)?.updateAvailable,
                    );
                    const agents = selectedRowIds.reduce(
                      (total, id) => total + (byId.get(id)?.agents ?? 0),
                      0,
                    );
                    return (
                      <>
                        <form
                          action={async () => {
                            await run("update", updateIds);
                          }}
                        >
                          <ConfirmSubmitButton
                            triggerLabel={
                              <>
                                <ArrowUpCircle className="size-3.5" />
                                {t("installed.updateSelected", {
                                  count: updateIds.length,
                                })}
                              </>
                            }
                            confirmLabel={common("confirm")}
                            cancelLabel={common("cancel")}
                            prompt={t("installed.updatePrompt", {
                              count: updateIds.length,
                            })}
                            pendingLabel={t("working")}
                            disabled={pending || updateIds.length === 0}
                            triggerSize="sm"
                            promptClassName="text-xs text-muted-foreground"
                          />
                        </form>
                        <form
                          action={async () => {
                            await run("remove", selectedRowIds);
                          }}
                        >
                          <ConfirmSubmitButton
                            triggerLabel={
                              <>
                                <Trash2 className="size-3.5" />
                                {t("installed.removeSelected", {
                                  count: selectedRowIds.length,
                                })}
                              </>
                            }
                            confirmLabel={common("confirm")}
                            cancelLabel={common("cancel")}
                            prompt={t("installed.removePrompt", {
                              count: selectedRowIds.length,
                              agents,
                            })}
                            pendingLabel={t("working")}
                            disabled={pending}
                            triggerSize="sm"
                            promptClassName="text-xs text-muted-foreground"
                          />
                        </form>
                      </>
                    );
                  }
                : undefined
            }
            headers={[
              { label: t("installed.plugin") },
              { label: t("version") },
              { label: t("contents") },
              { label: t("installed.agents"), align: "right" },
              { label: t("installed.addedAt") },
              ...(canManage
                ? [{ label: t("installed.actions"), align: "right" as const }]
                : []),
            ]}
            rows={visible.map((plugin) => {
              const published = plugin.status === "published";
              const detail = detailHref(plugin.listingId);
              return {
                id: plugin.installId,
                cells: [
                  <div key="plugin" className="flex min-w-0 items-center gap-3">
                    <Puzzle className="size-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <Link
                          href={detail}
                          className="truncate font-medium hover:underline"
                        >
                          {plugin.name}
                        </Link>
                        {!published ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            <CircleSlash className="size-3" />
                            {t(
                              plugin.status === "withdrawn"
                                ? "withdrawn"
                                : "removed",
                            )}
                          </span>
                        ) : plugin.updateAvailable ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            <ArrowUpCircle className="size-3" />
                            {t("updateAvailable")}
                          </span>
                        ) : null}
                        {plugin.omp ? (
                          <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                            {t("ompRetired")}
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {plugin.source}
                      </span>
                    </span>
                  </div>,
                  <span key="version" className="font-mono text-xs">
                    v{plugin.currentVersion}
                    {plugin.updateAvailable && plugin.latestVersion
                      ? ` → v${plugin.latestVersion}`
                      : ""}
                  </span>,
                  plugin.contents.length || plugin.mcp ? (
                    <span key="contents" className="flex gap-1 text-xs">
                      {plugin.contents.map(({ kind, count }) => (
                        <span
                          key={kind}
                          className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
                        >
                          {t(kind)} {count}
                        </span>
                      ))}
                      {plugin.mcp ? (
                        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-muted-foreground">
                          MCP {plugin.mcp}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span key="contents" className="text-muted-foreground">
                      —
                    </span>
                  ),
                  <span
                    key="agents"
                    className={
                      plugin.agents
                        ? "tabular-nums"
                        : "tabular-nums text-muted-foreground"
                    }
                  >
                    {plugin.agents || "—"}
                  </span>,
                  <span key="added" className="text-xs text-muted-foreground">
                    {plugin.addedAt}
                  </span>,
                  ...(canManage
                    ? [
                        <div
                          key="actions"
                          className="flex items-center justify-end gap-1"
                        >
                          {plugin.updateAvailable ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={pending}
                              aria-label={`${t("update")}: ${plugin.name}`}
                              onClick={() =>
                                startRefresh(async () => {
                                  await run("update", [plugin.installId]);
                                })
                              }
                            >
                              {t("update")}
                            </Button>
                          ) : null}
                          <Popover align="end">
                            <PopoverTrigger>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`${t("installed.actions")}: ${plugin.name}`}
                              >
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-2">
                              <div className="flex flex-col items-stretch gap-1">
                                <ButtonLink
                                  href={detail}
                                  variant="ghost"
                                  size="sm"
                                  className="justify-start"
                                >
                                  {t("installed.viewDetails")}
                                </ButtonLink>
                                {published ? (
                                  <ButtonLink
                                    href={detailHref(
                                      plugin.listingId,
                                      "#plugin-install",
                                    )}
                                    variant="ghost"
                                    size="sm"
                                    className="justify-start"
                                  >
                                    {t("switchVersion")}
                                  </ButtonLink>
                                ) : null}
                                <form
                                  action={async () => {
                                    await run("remove", [plugin.installId]);
                                  }}
                                >
                                  <ConfirmSubmitButton
                                    triggerLabel={
                                      <>
                                        <Trash2 className="size-3.5" />
                                        {common("remove")}
                                      </>
                                    }
                                    triggerAriaLabel={`${common("remove")}: ${plugin.name}`}
                                    confirmLabel={common("confirm")}
                                    cancelLabel={common("cancel")}
                                    prompt={t("installed.removeOnePrompt", {
                                      name: plugin.name,
                                      agents: plugin.agents,
                                    })}
                                    pendingLabel={t("working")}
                                    disabled={pending}
                                    promptClassName="break-words text-xs text-muted-foreground"
                                    className="flex-wrap"
                                    triggerClassName="w-full justify-start"
                                    triggerVariant="ghost"
                                    triggerSize="sm"
                                  />
                                </form>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>,
                      ]
                    : []),
                ],
              };
            })}
          />
        </fieldset>
      )}
    </>
  );
}
