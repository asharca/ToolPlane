"use client";

import { AnimatedBadge } from "@/components/motion/animated-badge";

import { Checkbox } from "@/components/motion/checkbox";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useDeferredValue, useMemo, useState } from "react";
import { Brain, Plus, Search, Server, X } from "lucide-react";
import {
  addServersToToolkitAction,
  addSkillsToToolkitAction,
  type ToolkitBatchActionState,
} from "@/lib/toolkits/actions";
import { MAX_TOOLKIT_BATCH_ITEMS } from "@/lib/toolkits/limits";

const TOOLKIT_PICKER_RENDER_LIMIT = 100;

export type ToolkitPickerItem = {
  id: string;
  name: string;
  description: string | null;
  source: string;
  status?: string | null;
  keywords: string[];
};

function sourceLabel(
  source: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const known: Record<string, string> = {
    catalog: t("sourceCatalog"),
    custom: t("sourceCustom"),
    github: "GitHub",
    upload: t("sourceUpload"),
    npm: "npm",
    pypi: "PyPI",
    docker: "Docker",
  };
  return known[source] ?? source;
}

function statusLabel(
  status: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const known: Record<string, string> = {
    running: t("statusRunning"),
    provisioning: t("statusProvisioning"),
    stopped: t("statusStopped"),
    error: t("statusError"),
  };
  return known[status] ?? status;
}

export function ToolkitResourcePicker({
  kind,
  workspaceSlug,
  toolkitSlug,
  items,
  emptyHref,
}: {
  kind: "mcp" | "skill";
  workspaceSlug: string;
  toolkitSlug: string;
  items: ToolkitPickerItem[];
  emptyHref: string;
}) {
  const t = useTranslations("console.toolkits");
  const action =
    kind === "mcp" ? addServersToToolkitAction : addSkillsToToolkitAction;
  const [state, formAction, isPending] = useActionState<
    ToolkitBatchActionState,
    FormData
  >(action, {});
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const sourceOptions = useMemo(
    () => [...new Set(items.map((item) => item.source))].sort(),
    [items],
  );
  const statusOptions = useMemo(
    () =>
      [
        ...new Set(
          items
            .map((item) => item.status)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
    [items],
  );
  const availableIds = useMemo(
    () => new Set(items.map((item) => item.id)),
    [items],
  );
  const activeSelected = useMemo(
    () => new Set([...selected].filter((id) => availableIds.has(id))),
    [availableIds, selected],
  );
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (source !== "all" && item.source !== source) return false;
      if (status !== "all" && item.status !== status) return false;
      if (!deferredQuery) return true;
      const haystack = [
        item.name,
        item.description ?? "",
        item.source,
        item.status ?? "",
        ...item.keywords,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(deferredQuery);
    });
  }, [deferredQuery, items, source, status]);
  const renderedItems = filteredItems.slice(0, TOOLKIT_PICKER_RENDER_LIMIT);

  const allFilteredSelected =
    filteredItems.length > 0 &&
    filteredItems.every((item) => activeSelected.has(item.id));
  const someFilteredSelected = filteredItems.some((item) =>
    activeSelected.has(item.id),
  );
  const selectingAllWouldExceedLimit =
    activeSelected.size +
      filteredItems.filter((item) => !activeSelected.has(item.id)).length >
    MAX_TOOLKIT_BATCH_ITEMS;

  const title = kind === "mcp" ? t("availableMcp") : t("availableSkills");
  const hasFilters = Boolean(query || source !== "all" || status !== "all");

  function toggleItem(id: string) {
    if (
      !activeSelected.has(id) &&
      activeSelected.size >= MAX_TOOLKIT_BATCH_ITEMS
    )
      return;
    setSelected((current) => {
      const next = new Set(
        [...current].filter((selectedId) => availableIds.has(selectedId)),
      );
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFiltered() {
    if (!allFilteredSelected && selectingAllWouldExceedLimit) return;
    setSelected((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      for (const item of filteredItems) {
        if (allFilteredSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setSource("all");
    setStatus("all");
  }

  if (items.length === 0) {
    return (
      <section className="rounded-3xl border border-border bg-card overflow-hidden">
        <header className="flex items-center gap-2 border-b border-border bg-muted/25 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span className="text-sm text-muted-foreground">0</span>
        </header>
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {kind === "mcp"
            ? t("everyDeployedServerIsAlreadyInThisToolkit")
            : t("everyInstalledSkillIsAlreadyInThisToolkit")}{" "}
          <Link
            href={emptyHref}
            className="font-medium text-foreground underline"
          >
            {kind === "mcp" ? t("deployMore") : t("installMore")}
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-border bg-card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span className="text-sm text-muted-foreground">{items.length}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("matchingResources", { count: filteredItems.length })}
        </span>
      </header>

      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Input
            leftIcon={<Search />}
            value={query}
            onChange={(value) => setQuery(value)}
            placeholder={
              kind === "mcp"
                ? t("searchAvailableMcp")
                : t("searchAvailableSkills")
            }
            aria-label={
              kind === "mcp"
                ? t("searchAvailableMcp")
                : t("searchAvailableSkills")
            }
            className="w-full"
          />
        </div>
        <div className="w-full shrink-0 sm:w-40">
          <FormSelect
            value={source}
            onValueChange={(value) => setSource(value)}
            label={t("filterBySource")}
            options={[
              { value: "all", label: t("allSources") },
              ...sourceOptions.map((value) => ({
                value: value,
                label: sourceLabel(value, t),
              })),
            ]}
          />
        </div>
        {kind === "mcp" ? (
          <div className="w-full shrink-0 sm:w-40">
            <FormSelect
              value={status}
              onValueChange={(value) => setStatus(value)}
              label={t("filterByStatus")}
              options={[
                { value: "all", label: t("allStatuses") },
                ...statusOptions.map((value) => ({
                  value: value,
                  label: statusLabel(value, t),
                })),
              ]}
            />
          </div>
        ) : null}
        {hasFilters ? (
          <Button
            type="button"
            onClick={clearFilters}
            variant="ghost"
            size="sm"
            className="shrink-0"
          >
            <X className="size-4" />
            {t("clearFilters")}
          </Button>
        ) : null}
      </div>

      <form action={formAction}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
        {[...activeSelected].map((id) => (
          <input key={id} type="hidden" name="resourceId" value={id} />
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border bg-muted/35 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              checked={allFilteredSelected}
              disabled={!allFilteredSelected && selectingAllWouldExceedLimit}
              onCheckedChange={toggleFiltered}
              indeterminate={someFilteredSelected && !allFilteredSelected}
              label={t("selectVisible", { count: filteredItems.length })}
            />
            <span className="text-xs text-muted-foreground">
              {t("selectedResources", { count: activeSelected.size })}
            </span>
            {activeSelected.size > 0 ? (
              <Button
                type="button"
                onClick={() => setSelected(new Set())}
                variant="ghost"
                size="sm"
              >
                {t("clearSelection")}
              </Button>
            ) : null}
            {!allFilteredSelected && selectingAllWouldExceedLimit ? (
              <span className="text-xs text-(--color-warning) dark:text-(--color-warning)">
                {t("narrowFiltersToSelectAll", {
                  count: MAX_TOOLKIT_BATCH_ITEMS,
                })}
              </span>
            ) : null}
          </div>
          <Button
            type="submit"
            disabled={activeSelected.size === 0 || isPending}
            variant="primary"
            size="sm"
          >
            <Plus className="size-3.5" />
            {isPending
              ? t("addingSelected")
              : t("addSelected", { count: activeSelected.size })}
          </Button>
        </div>

        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
        {!state.error && typeof state.added === "number" ? (
          <p
            className="border-b border-(--color-success) bg-muted/35 px-4 py-2 text-sm text-(--color-success) dark:border-(--color-success) dark:bg-muted/35 dark:text-(--color-success)"
            role="status"
          >
            {t("addedResources", { count: state.added })}
          </p>
        ) : null}
      </form>

      {filteredItems.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t("noResourcesMatchFilters")}
          </p>
          <Button
            type="button"
            onClick={clearFilters}
            variant="ghost"
            size="sm"
            className="mt-2"
          >
            {t("clearFilters")}
          </Button>
        </div>
      ) : (
        <>
          {filteredItems.length > renderedItems.length ? (
            <p className="border-b border-border bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
              {t("showingFirstResources", {
                shown: renderedItems.length,
                count: filteredItems.length,
              })}
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {renderedItems.map((item) => {
              const isSelected = activeSelected.has(item.id);
              const Icon = kind === "mcp" ? Server : Brain;
              return (
                <li key={item.id}>
                  <div
                    className={`relative flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 ${isSelected ? "bg-muted" : ""}`}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggleItem(item.id)}
                      className="absolute inset-0"
                    />
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleItem(item.id)}
                      aria-label={t("selectResource", { name: item.name })}
                      className="relative z-10 shrink-0"
                    />
                    <span className="pointer-events-none relative flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Icon className="size-4 text-muted-foreground" />
                    </span>
                    <span className="pointer-events-none relative min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.name}
                      </span>
                      {item.description ? (
                        <span className="mt-0.5 block line-clamp-1 text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="pointer-events-none relative flex shrink-0 flex-wrap justify-end gap-1.5">
                      <AnimatedBadge status="neutral" size="sm">
                        {sourceLabel(item.source, t)}
                      </AnimatedBadge>
                      {item.status ? (
                        <AnimatedBadge status="neutral" size="sm">
                          {statusLabel(item.status, t)}
                        </AnimatedBadge>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
