"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  LogIn,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  RotateCcw,
  Search,
  Store,
  Trash2,
  X,
} from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import { Checkbox } from "@/components/motion/checkbox";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  removeDeploymentAction,
  removeDeploymentsAction,
  restartDeploymentAction,
  startDeploymentAction,
  startDeploymentsAction,
  stopDeploymentAction,
  stopDeploymentsAction,
} from "@/lib/workspace/actions";
import { cn } from "@/lib/utils";
import { DashboardEmptyState, DashboardTable } from "./DashboardUI";
import { AddMcpDialog } from "./AddMcpDialog";

export type McpDeploymentListItem = {
  id: string;
  name: string;
  source: string;
  reference: string | null;
  status: string;
  createdAt: string;
  iconUrl: string | null;
  /** Present for OAuth deployments; setup means signing in, not variables. */
  signInUrl: string | null;
};

type FilterStatus =
  | "all"
  | "running"
  | "setup_required"
  | "provisioning"
  | "error"
  | "stopped";

const PAGE_SIZE = 20;

const KNOWN_SOURCES: Record<string, true> = {
  catalog: true,
  custom: true,
  config: true,
  docker: true,
  remote: true,
  npm: true,
  pypi: true,
  github: true,
};

const FILTER_DOT: Record<Exclude<FilterStatus, "all">, string> = {
  running: "bg-emerald-500",
  setup_required: "bg-amber-500",
  provisioning: "bg-primary",
  error: "bg-destructive",
  stopped: "bg-muted-foreground/50",
};

function McpSourceBadge({ source }: { source: string }) {
  const t = useTranslations("console.mcp");
  const label = KNOWN_SOURCES[source] ? t(`source.${source}`) : source;
  return (
    <AnimatedBadge status="neutral" size="sm" showIcon={false}>
      {label}
    </AnimatedBadge>
  );
}

function McpDeploymentActions({
  slug,
  deployment,
  compact = false,
}: {
  slug: string;
  deployment: McpDeploymentListItem;
  compact?: boolean;
}) {
  const [t, common] = [
    useTranslations("console.mcp"),
    useTranslations("common"),
  ];
  const [actionSide, setActionSide] = useState<"top" | "bottom">("bottom");
  const isRunning = deployment.status === "running";
  const isProvisioning = deployment.status === "provisioning";
  const needsSetup = deployment.status === "setup_required";
  const base = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;

  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1.5",
        compact && "w-full",
      )}
    >
      {isRunning || isProvisioning ? (
        <form action={stopDeploymentAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="deploymentId" value={deployment.id} />
          <SubmitButton
            flash={false}
            pendingLabel={t("stopping")}
            variant="secondary"
            size="sm"
          >
            <Pause className="size-3.5" />
            {t("stop")}
          </SubmitButton>
        </form>
      ) : needsSetup ? (
        <ButtonLink
          href={deployment.signInUrl ?? `${base}?tab=variables`}
          variant={deployment.signInUrl ? "primary" : "secondary"}
          size="sm"
        >
          {deployment.signInUrl ? (
            <LogIn className="size-3.5" aria-hidden="true" />
          ) : null}
          {deployment.signInUrl ? t("oauth.signIn") : t("variables")}
        </ButtonLink>
      ) : (
        <form action={startDeploymentAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="deploymentId" value={deployment.id} />
          <SubmitButton
            flash={false}
            pendingLabel={t("starting")}
            variant="secondary"
            size="sm"
          >
            <Play className="size-3.5" />
            {t("start")}
          </SubmitButton>
        </form>
      )}
      <Popover align="end" side={actionSide}>
        <PopoverTrigger>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${t("actions")}: ${deployment.name}`}
            title={t("actions")}
            onClick={(event) =>
              setActionSide(
                event.currentTarget.getBoundingClientRect().bottom >
                  window.innerHeight / 2
                  ? "top"
                  : "bottom",
              )
            }
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 max-w-[calc(100vw-2rem)] space-y-1 p-2">
          {isRunning ? (
            <form action={restartDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deployment.id} />
              <SubmitButton
                flash={false}
                pendingLabel={t("restarting")}
                variant="ghost"
                size="sm"
                className="w-full justify-start"
              >
                <RotateCcw className="size-3.5" />
                {t("restart")}
              </SubmitButton>
            </form>
          ) : null}
          <form
            action={removeDeploymentAction}
            className={isRunning ? "border-t border-border pt-1" : undefined}
          >
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="deploymentId" value={deployment.id} />
            <ConfirmSubmitButton
              triggerLabel={
                <>
                  <Trash2 className="size-3.5" />
                  {t("remove")}
                </>
              }
              confirmLabel={common("confirm")}
              cancelLabel={common("cancel")}
              prompt={`${t("remove")} ${deployment.name}?`}
              pendingLabel={`${t("remove")}…`}
              promptClassName="w-full break-words text-xs text-muted-foreground"
              className="flex-wrap"
              triggerClassName="w-full justify-start text-destructive hover:text-destructive"
              triggerVariant="ghost"
              triggerSize="sm"
              confirmVariant="secondary"
              confirmSize="sm"
              cancelVariant="ghost"
              cancelSize="sm"
            />
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function McpBulkDeploymentActions({
  slug,
  deploymentIds,
  className,
}: {
  slug: string;
  deploymentIds: Set<string>;
  className: string;
}) {
  const [t, common] = [
    useTranslations("console.mcp"),
    useTranslations("common"),
  ];
  const selection = useTranslations("console.agents");
  const selectedIds = [...deploymentIds];

  return (
    <fieldset aria-label={t("actions")} className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <form action={startDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input
              key={deploymentId}
              type="hidden"
              name="deploymentId"
              value={deploymentId}
            />
          ))}
          <SubmitButton
            flash={false}
            pendingLabel={t("starting")}
            variant="secondary"
            size="sm"
          >
            <Play className="size-3.5" />
            {common("start")}
          </SubmitButton>
        </form>
        <form action={stopDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input
              key={deploymentId}
              type="hidden"
              name="deploymentId"
              value={deploymentId}
            />
          ))}
          <SubmitButton
            flash={false}
            pendingLabel={t("stopping")}
            variant="secondary"
            size="sm"
          >
            <Pause className="size-3.5" />
            {common("stop")}
          </SubmitButton>
        </form>
        <form action={removeDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input
              key={deploymentId}
              type="hidden"
              name="deploymentId"
              value={deploymentId}
            />
          ))}
          <ConfirmSubmitButton
            triggerLabel={
              <>
                <Trash2 className="size-3.5" />
                {common("delete")}
              </>
            }
            confirmLabel={common("confirm")}
            cancelLabel={common("cancel")}
            prompt={`${common("delete")} ${selection("selectedResources", { count: selectedIds.length })}?`}
            pendingLabel={`${common("delete")}…`}
            promptClassName="text-xs text-muted-foreground"
            className="items-center"
            triggerVariant="secondary"
            triggerSize="sm"
            confirmVariant="secondary"
            confirmSize="sm"
            cancelVariant="ghost"
            cancelSize="sm"
          />
        </form>
      </div>
    </fieldset>
  );
}

function DeploymentIdentity({
  deployment,
  showSourceInline = false,
}: {
  deployment: McpDeploymentListItem;
  showSourceInline?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {deployment.iconUrl ? (
        <Image
          unoptimized
          loading="eager"
          decoding="auto"
          src={deployment.iconUrl}
          alt=""
          width={34}
          height={34}
          className="size-8.5 shrink-0 rounded-lg border border-border bg-card object-cover"
        />
      ) : (
        <span className="flex size-8.5 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60 text-muted-foreground">
          <Plug className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {deployment.name}
          </span>
          {showSourceInline ? (
            <McpSourceBadge source={deployment.source} />
          ) : null}
        </div>
        {deployment.reference ? (
          <p
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={deployment.reference}
          >
            {deployment.reference}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function McpDeploymentsBrowser({
  slug,
  deployments,
  allowHttp,
  defaultCreateOpen,
}: {
  slug: string;
  deployments: McpDeploymentListItem[];
  allowHttp: boolean;
  defaultCreateOpen?: boolean;
}) {
  const [t, common, selection] = [
    useTranslations("console.mcp"),
    useTranslations("common"),
    useTranslations("console.agents"),
  ];
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<FilterStatus>("all");
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<
    Set<string>
  >(() => new Set());
  const [page, setPage] = useState(1);
  const tableAreaRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState(0);
  const hasDeployments = deployments.length > 0;

  useEffect(() => {
    const area = hasDeployments ? tableAreaRef.current : null;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) =>
      setTableHeight(Math.max(0, entry.contentRect.height - 2)),
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, [hasDeployments]);

  const counts = useMemo(
    () => ({
      all: deployments.length,
      running: deployments.filter(
        (deployment) => deployment.status === "running",
      ).length,
      setup_required: deployments.filter(
        (deployment) => deployment.status === "setup_required",
      ).length,
      provisioning: deployments.filter(
        (deployment) => deployment.status === "provisioning",
      ).length,
      error: deployments.filter((deployment) => deployment.status === "error")
        .length,
      stopped: deployments.filter(
        (deployment) => deployment.status === "stopped",
      ).length,
    }),
    [deployments],
  );

  const filteredDeployments = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return deployments.filter((deployment) => {
      const matchesStatus = status === "all" || deployment.status === status;
      if (!matchesStatus) return false;
      if (!term) return true;
      return [deployment.name, deployment.reference, deployment.source]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(term));
    });
  }, [deployments, query, status]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredDeployments.length / PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const pageDeployments = filteredDeployments.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const availableDeploymentIds = useMemo(
    () => new Set(deployments.map((deployment) => deployment.id)),
    [deployments],
  );
  const activeSelectedDeploymentIds = useMemo(
    () =>
      new Set(
        [...selectedDeploymentIds].filter((id) =>
          availableDeploymentIds.has(id),
        ),
      ),
    [availableDeploymentIds, selectedDeploymentIds],
  );

  const visibleFilters = useMemo(() => {
    const allFilters: Array<{
      key: FilterStatus;
      label: string;
      count: number;
    }> = [
      { key: "all", label: common("all"), count: counts.all },
      { key: "running", label: t("running"), count: counts.running },
      {
        key: "setup_required",
        label: t("setupRequiredFilter"),
        count: counts.setup_required,
      },
      {
        key: "provisioning",
        label: t("deploying"),
        count: counts.provisioning,
      },
      { key: "error", label: t("error"), count: counts.error },
      { key: "stopped", label: t("stopped"), count: counts.stopped },
    ];
    return allFilters.filter(
      (filter) =>
        filter.key === "all" || filter.count > 0 || filter.key === status,
    );
  }, [common, counts, status, t]);

  const toggleMobileSelection = (deploymentId: string, checked: boolean) => {
    setSelectedDeploymentIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(deploymentId);
      else next.delete(deploymentId);
      return next;
    });
  };

  const marketHref = `/app/${encodeURIComponent(slug)}/plugins`;

  if (deployments.length === 0) {
    return (
      <DashboardEmptyState
        icon={Plug}
        title={t("noServersDeployedYet")}
        className="rounded-xl border border-dashed border-border bg-card/50 py-14"
        actions={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <AddMcpDialog
              slug={slug}
              allowHttp={allowHttp}
              defaultOpen={defaultCreateOpen}
            />
            <ButtonLink href={marketHref} variant="secondary" size="md">
              <Store className="size-4" />
              {t("pluginCenter")}
            </ButtonLink>
          </div>
        }
      />
    );
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4"
      aria-label={t("allMcps")}
    >
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 w-full flex-col gap-2.5 sm:w-auto sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="w-full sm:w-64 lg:w-72">
            <Input
              value={query}
              onChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
              placeholder={t("searchMcp")}
              leftIcon={<Search className="size-4" />}
              aria-label={t("searchMcp")}
              rightIcon={
                query ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setQuery("");
                      setPage(1);
                    }}
                    aria-label={t("clearSearch")}
                  >
                    <X className="size-4" />
                  </Button>
                ) : undefined
              }
            />
          </div>
          <fieldset
            aria-label={t("status")}
            className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
          >
            {visibleFilters.map((filter) => {
              const active = status === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setStatus(filter.key);
                    setPage(1);
                  }}
                  className={cn(
                    "inline-flex min-h-8 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-border bg-card text-foreground shadow-xs"
                      : "border-transparent bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {filter.key !== "all" ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        FILTER_DOT[filter.key],
                      )}
                    />
                  ) : null}
                  <span>{filter.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {filter.count}
                  </span>
                </button>
              );
            })}
          </fieldset>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ButtonLink href={marketHref} variant="secondary" size="md">
            <Store className="size-4" />
            {t("pluginCenter")}
          </ButtonLink>
          <AddMcpDialog
            slug={slug}
            allowHttp={allowHttp}
            defaultOpen={defaultCreateOpen}
          />
        </div>
      </div>

      {filteredDeployments.length === 0 ? (
        <DashboardEmptyState
          icon={Search}
          title={t("noMcpFound")}
          className="rounded-xl border border-dashed border-border"
          actions={
            query || status !== "all" ? (
              <Button
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setPage(1);
                }}
                variant="secondary"
                size="sm"
              >
                {common("all")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Mobile card list: zero horizontal scroll at 390px */}
          <div className="space-y-3 md:hidden">
            {activeSelectedDeploymentIds.size > 0 ? (
              <div
                role="toolbar"
                aria-label={selection("selectedResources", {
                  count: activeSelectedDeploymentIds.size,
                })}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium tabular-nums">
                    {selection("selectedResources", {
                      count: activeSelectedDeploymentIds.size,
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={selection("clearSelection")}
                    onClick={() => setSelectedDeploymentIds(new Set())}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
                <McpBulkDeploymentActions
                  slug={slug}
                  deploymentIds={activeSelectedDeploymentIds}
                  className="flex flex-wrap items-center gap-1.5"
                />
              </div>
            ) : null}

            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {pageDeployments.map((deployment) => {
                const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
                const checked = activeSelectedDeploymentIds.has(deployment.id);
                return (
                  <li key={deployment.id} className="space-y-3 p-3.5">
                    <div className="flex items-start gap-2.5">
                      <div className="pt-1">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            toggleMobileSelection(deployment.id, Boolean(next))
                          }
                          aria-label={t("selectServer", {
                            name: deployment.name,
                          })}
                        />
                      </div>
                      <Link
                        href={href}
                        className="min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <DeploymentIdentity
                          deployment={deployment}
                          showSourceInline
                        />
                      </Link>
                    </div>
                    <div className="flex items-center justify-between gap-2 pl-7">
                      <StatusBadge status={deployment.status} />
                      <McpDeploymentActions
                        slug={slug}
                        deployment={deployment}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Desktop table: clean fixed columns, no drag/resize grip clutter */}
          <div
            ref={tableAreaRef}
            className="hidden min-h-0 flex-1 overflow-auto md:block"
          >
            <DashboardTable
              minWidth="40rem"
              ariaLabel={t("allMcps")}
              adjustableColumns={false}
              selectionPlacement="above"
              height={tableHeight || undefined}
              selectedRowIds={[...activeSelectedDeploymentIds]}
              onSelectionChange={(ids) =>
                setSelectedDeploymentIds(new Set(ids))
              }
              selectionActions={({ selectedRowIds }) => (
                <McpBulkDeploymentActions
                  slug={slug}
                  deploymentIds={new Set(selectedRowIds)}
                  className="flex flex-wrap items-center gap-1.5"
                />
              )}
              headers={[
                { label: t("serverColumn") },
                { label: t("sourceColumn"), width: "7.5rem" },
                { label: t("status"), width: "8.5rem" },
                { label: t("actions"), align: "right", width: "10rem" },
              ]}
              rows={pageDeployments.map((deployment) => {
                const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
                return {
                  id: deployment.id,
                  cells: [
                    <Link
                      key="identity"
                      href={href}
                      className="block rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <DeploymentIdentity deployment={deployment} />
                    </Link>,
                    <McpSourceBadge key="source" source={deployment.source} />,
                    <StatusBadge key="status" status={deployment.status} />,
                    <McpDeploymentActions
                      key="actions"
                      slug={slug}
                      deployment={deployment}
                    />,
                  ],
                };
              })}
            />
          </div>
        </>
      )}

      {totalPages > 1 ? (
        <nav
          aria-label={common("pagination")}
          className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3"
        >
          <p
            className="text-sm tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {currentPage} / {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              {common("previous")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              {common("next")}
            </Button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}
