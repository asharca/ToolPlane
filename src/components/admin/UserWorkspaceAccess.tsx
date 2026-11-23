"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Check,
  ChevronRight,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  UserMinus,
  X,
} from "lucide-react";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { DialogFooter, DialogHeader } from "@/components/dashboard/dialog";
import { notify } from "@/components/dashboard/Toaster";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { Tooltip } from "@/components/motion/tooltip";
import type { AdminActionState } from "@/lib/admin/user-actions";
import type { AdminWorkspaceAccess } from "@/lib/admin/workspace-members";
import {
  addWorkspaceMemberAdminAction,
  removeWorkspaceMemberAdminAction,
  searchJoinableWorkspacesAdminAction,
  setWorkspaceMemberPermissionAdminAction,
  setWorkspaceMemberRoleAdminAction,
} from "@/lib/admin/workspace-member-actions";
import {
  roleHasPermissionByDefault,
  workspacePermissionStates,
  type WorkspacePermission,
  type WorkspacePermissionState,
  type WorkspaceRole,
} from "@/lib/workspace/permissions";
import { cn } from "@/lib/utils";

export type WorkspaceAccessEntry = AdminWorkspaceAccess & {
  href: string;
};

type JoinableWorkspace = {
  id: string;
  slug: string;
  name: string;
};

type MutableRole = "admin" | "member";
type RoleFilter = "all" | WorkspaceRole;

type UserWorkspaceAccessProps = {
  userId: string;
  userSuspended?: boolean;
  entries: WorkspaceAccessEntry[];
  ownedWorkspaces: number;
  maxOwnedWorkspaces: number;
};

export function UserWorkspaceAccess({
  userId,
  userSuspended = false,
  entries,
  ownedWorkspaces,
  maxOwnedWorkspaces,
}: UserWorkspaceAccessProps) {
  const t = useTranslations("adminWorkspaceAccess");
  const [filterQuery, setFilterQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const showFilterBar = entries.length >= 6;

  const filteredEntries = useMemo(() => {
    if (!showFilterBar) return entries;
    const q = filterQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (roleFilter !== "all" && entry.role !== roleFilter) return false;
      if (!q) return true;
      return (
        entry.workspace.name.toLowerCase().includes(q) ||
        entry.workspace.slug.toLowerCase().includes(q)
      );
    });
  }, [entries, filterQuery, roleFilter, showFilterBar]);

  return (
    <AdminPanel
      title={t("title")}
      actions={
        <AdminBadge tone="neutral">
          {t("ownedQuota", { used: ownedWorkspaces, max: maxOwnedWorkspaces })}
        </AdminBadge>
      }
      padded={false}
    >
      <AddWorkspaceBar userId={userId} disabled={userSuspended} />

      {showFilterBar ? (
        <div className="flex flex-col gap-2 border-b border-border bg-muted/15 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <Input
            value={filterQuery}
            onChange={setFilterQuery}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filterPlaceholder")}
            leftIcon={<Search className="size-3.5" aria-hidden="true" />}
            rightIcon={
              filterQuery ? (
                <button
                  type="button"
                  onClick={() => setFilterQuery("")}
                  aria-label={t("clearSelection")}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : undefined
            }
            className="sm:max-w-xs"
          />
          <fieldset
            aria-label={t("filterPlaceholder")}
            className="inline-flex items-center gap-0.5 self-start rounded-lg border border-border bg-muted/40 p-0.5 sm:self-auto"
          >
            {(["all", "owner", "admin", "member"] as const).map((value) => {
              const active = roleFilter === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRoleFilter(value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "all" ? t("filterAll") : t(`roles.${value}`)}
                </button>
              );
            })}
          </fieldset>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : filteredEntries.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          {t("noFilteredWorkspaces")}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {filteredEntries.map((entry) => (
            <WorkspaceAccessRow
              key={entry.workspace.id}
              userId={userId}
              entry={entry}
            />
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}

function RoleSegmentedControl({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: MutableRole;
  onChange: (next: MutableRole) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const t = useTranslations("adminWorkspaceAccess");
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-9 items-center rounded-lg border border-border bg-muted/40 p-0.5",
        disabled && "opacity-60",
      )}
    >
      {(["member", "admin"] as const).map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => {
              if (!disabled && option !== value) onChange(option);
            }}
            className={cn(
              "inline-flex h-full items-center rounded-md px-3 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`roles.${option}`)}
          </button>
        );
      })}
    </fieldset>
  );
}

function AddWorkspaceBar({
  userId,
  disabled,
}: {
  userId: string;
  disabled: boolean;
}) {
  const t = useTranslations("adminWorkspaceAccess");
  const listboxId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchSeqRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<JoinableWorkspace | null>(null);
  const [results, setResults] = useState<JoinableWorkspace[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [role, setRole] = useState<MutableRole>("member");
  const [adding, startAdding] = useTransition();

  useEffect(() => {
    if (disabled || !dropdownOpen || selected) return;
    const seq = ++searchSeqRef.current;
    const delay = query.trim() ? 180 : 0;
    const timer = setTimeout(() => {
      searchJoinableWorkspacesAdminAction(userId, query)
        .then((list) => {
          if (searchSeqRef.current === seq) {
            setResults(list);
            setActiveIndex(0);
            setHasLoaded(true);
          }
        })
        .catch(() => {
          if (searchSeqRef.current === seq) {
            setResults([]);
            setActiveIndex(0);
            setHasLoaded(true);
          }
        })
        .finally(() => {
          if (searchSeqRef.current === seq) {
            setSearching(false);
          }
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [disabled, dropdownOpen, query, selected, userId]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        pickerRef.current &&
        !pickerRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen || results.length === 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, dropdownOpen, results.length]);

  const openSearch = () => {
    if (disabled || selected) return;
    if (!dropdownOpen) {
      setSearching(true);
      setDropdownOpen(true);
    }
  };

  const selectWorkspace = (ws: JoinableWorkspace) => {
    setSelected(ws);
    setQuery(ws.name);
    setDropdownOpen(false);
  };

  const clearSelection = () => {
    setSelected(null);
    setQuery("");
    setHasLoaded(false);
    setSearching(true);
    setDropdownOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleAdd = () => {
    if (disabled || !selected || adding) return;
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", selected.id);
    form.set("role", role);
    startAdding(async () => {
      const res = await addWorkspaceMemberAdminAction({}, form);
      if (res.error) {
        notify(res.error, { severity: "error" });
        return;
      }
      notify(t("added"));
      setSelected(null);
      setQuery("");
      setResults([]);
      setHasLoaded(false);
      setRole("member");
      setDropdownOpen(false);
    });
  };

  if (disabled) {
    return (
      <div className="border-b border-border bg-muted/15 px-4 py-3 text-xs text-muted-foreground sm:px-5">
        {t("suspendedCannotAdd")}
      </div>
    );
  }

  const activeOptionId =
    dropdownOpen && !selected && results[activeIndex]
      ? `${listboxId}-opt-${results[activeIndex].id}`
      : undefined;

  return (
    <div className="border-b border-border px-4 py-3.5 sm:px-5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div ref={pickerRef} className="relative min-w-0 flex-1">
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={dropdownOpen && !selected}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            value={selected ? `${selected.name} (/${selected.slug})` : query}
            onChange={(next) => {
              setQuery(next);
              setSelected(null);
              setSearching(true);
              setDropdownOpen(true);
            }}
            onFocus={openSearch}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (!dropdownOpen && !selected) {
                  openSearch();
                } else if (results.length > 0) {
                  setActiveIndex((prev) => (prev + 1) % results.length);
                }
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (dropdownOpen && results.length > 0) {
                  setActiveIndex(
                    (prev) => (prev - 1 + results.length) % results.length,
                  );
                }
              } else if (event.key === "Enter") {
                if (selected) {
                  event.preventDefault();
                  handleAdd();
                } else if (dropdownOpen && results[activeIndex]) {
                  event.preventDefault();
                  selectWorkspace(results[activeIndex]);
                }
              } else if (event.key === "Escape") {
                if (dropdownOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropdownOpen(false);
                } else if (selected) {
                  event.preventDefault();
                  clearSelection();
                }
              }
            }}
            placeholder={t("addSearchPlaceholder")}
            aria-label={t("addSearchAriaLabel")}
            autoComplete="off"
            disabled={adding}
            leftIcon={<Search className="size-4" aria-hidden="true" />}
            rightIcon={
              searching && dropdownOpen && !selected ? (
                <Loader2
                  className="size-3.5 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : selected ? (
                <button
                  type="button"
                  onClick={clearSelection}
                  aria-label={t("clearSelection")}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : undefined
            }
          />
          {dropdownOpen && !selected ? (
            <div
              id={listboxId}
              role="listbox"
              aria-label={t("addSearchAriaLabel")}
              className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
            >
              {searching && !hasLoaded ? (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  {t("searching")}
                </p>
              ) : results.length > 0 ? (
                results.map((ws, index) => {
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={ws.id}
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      id={`${listboxId}-opt-${ws.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectWorkspace(ws)}
                      className={cn(
                        "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none",
                        isActive ? "bg-muted" : "hover:bg-muted/70",
                      )}
                    >
                      <span className="truncate font-medium text-foreground">
                        {ws.name}
                      </span>
                      <code className="shrink-0 font-mono text-xs text-muted-foreground">
                        /{ws.slug}
                      </code>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t("noMatchingWorkspaces")}
                </p>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 sm:shrink-0">
          <RoleSegmentedControl
            value={role}
            onChange={setRole}
            disabled={adding}
            ariaLabel={t("addRoleAriaLabel")}
          />

          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={!selected || adding}
            onClick={handleAdd}
            className="h-9 shrink-0 px-4"
          >
            {adding ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="size-4" aria-hidden="true" />
            )}
            {adding ? t("adding") : t("addButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}

type RowOptimisticState = {
  role: WorkspaceRole;
  permissions: WorkspacePermissionState[];
};

type RowOptimisticAction =
  | { type: "role"; role: MutableRole }
  | { type: "permission"; permission: WorkspacePermission; enabled: boolean }
  | { type: "reset" };

function applyRowOptimisticAction(
  state: RowOptimisticState,
  action: RowOptimisticAction,
): RowOptimisticState {
  if (action.type === "role") {
    return {
      role: action.role,
      permissions: workspacePermissionStates(action.role, [], []),
    };
  }
  if (action.type === "reset") {
    return {
      role: state.role,
      permissions: workspacePermissionStates(state.role, [], []),
    };
  }
  const byDefault = roleHasPermissionByDefault(state.role);
  return {
    role: state.role,
    permissions: state.permissions.map((item) => {
      if (item.permission !== action.permission) return item;
      const adjustment =
        state.role === "owner" || action.enabled === byDefault
          ? null
          : action.enabled
            ? "granted"
            : "revoked";
      return {
        ...item,
        byDefault,
        adjustment,
        effective: action.enabled,
      };
    }),
  };
}

function WorkspaceAccessRow({
  userId,
  entry,
}: {
  userId: string;
  entry: WorkspaceAccessEntry;
}) {
  const t = useTranslations("adminWorkspaceAccess");
  const isOwner = entry.role === "owner";
  const [optimistic, addOptimistic] = useOptimistic<
    RowOptimisticState,
    RowOptimisticAction
  >(
    { role: entry.role, permissions: entry.permissions },
    applyRowOptimisticAction,
  );
  const [pendingRole, startRoleTransition] = useTransition();
  const [pendingReset, startResetTransition] = useTransition();
  const [, startPermissionTransition] = useTransition();
  const [confirmRoleTarget, setConfirmRoleTarget] =
    useState<MutableRole | null>(null);
  const rolePromptId = useId();

  const adjustedPermissions = optimistic.permissions.filter(
    (perm) => perm.adjustment !== null,
  );
  const adjustedCount = adjustedPermissions.length;

  const commitRoleChange = (nextRole: MutableRole) => {
    if (isOwner || pendingRole || nextRole === optimistic.role) return;
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", entry.workspace.id);
    form.set("role", nextRole);
    startRoleTransition(async () => {
      addOptimistic({ type: "role", role: nextRole });
      const res = await setWorkspaceMemberRoleAdminAction({}, form);
      if (res.error) {
        notify(res.error, { severity: "error" });
        return;
      }
      notify(t("roleUpdated"));
    });
  };

  const handleRoleRequest = (nextRole: MutableRole) => {
    if (isOwner || pendingRole || nextRole === optimistic.role) return;
    if (adjustedCount > 0) {
      setConfirmRoleTarget(nextRole);
      return;
    }
    commitRoleChange(nextRole);
  };

  const handlePermissionChange = (
    permission: WorkspacePermission,
    enabled: boolean,
  ) => {
    if (isOwner || pendingRole || pendingReset) return;
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", entry.workspace.id);
    form.set("permission", permission);
    form.set("enabled", String(enabled));
    startPermissionTransition(async () => {
      addOptimistic({ type: "permission", permission, enabled });
      const res = await setWorkspaceMemberPermissionAdminAction({}, form);
      if (res.error) {
        notify(res.error, { severity: "error" });
        return;
      }
      notify(t("permissionUpdated"));
    });
  };

  const handleResetAll = () => {
    if (isOwner || pendingRole || pendingReset || adjustedCount === 0) return;
    const toReset = entry.permissions.filter(
      (perm) => perm.adjustment !== null,
    );
    if (toReset.length === 0) return;
    startResetTransition(async () => {
      addOptimistic({ type: "reset" });
      const results = await Promise.all(
        toReset.map((perm) => {
          const form = new FormData();
          form.set("userId", userId);
          form.set("workspaceId", entry.workspace.id);
          form.set("permission", perm.permission);
          form.set("enabled", String(perm.byDefault));
          return setWorkspaceMemberPermissionAdminAction({}, form);
        }),
      );
      const firstError = results.find((res) => res.error)?.error;
      if (firstError) {
        notify(firstError, { severity: "error" });
        return;
      }
      notify(t("permissionsReset"));
    });
  };

  const handleRemove = useCallback(
    async (prev: AdminActionState, form: FormData) => {
      const res = await removeWorkspaceMemberAdminAction(prev, form);
      if (res.ok) {
        notify(t("removed"));
      } else if (res.error) {
        notify(res.error, { severity: "error" });
      }
      return res;
    },
    [t],
  );

  if (isOwner) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <Link
          href={entry.href}
          className="group flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground group-hover:underline">
              {entry.workspace.name}
            </span>
            <code className="block truncate font-mono text-xs text-muted-foreground">
              /{entry.workspace.slug}
            </code>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>

        <div className="flex items-center gap-2.5 sm:shrink-0">
          <Tooltip content={t("ownerAllPermissions")} side="top">
            <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t("allPermissions")}
            </span>
          </Tooltip>
          <AdminBadge tone="info">{t("roles.owner")}</AdminBadge>
        </div>
      </li>
    );
  }

  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href={entry.href}
          className="group flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground group-hover:underline">
              {entry.workspace.name}
            </span>
            <code className="block truncate font-mono text-xs text-muted-foreground">
              /{entry.workspace.slug}
            </code>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {adjustedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pendingRole || pendingReset}
              onClick={handleResetAll}
              aria-label={t("resetDefaultsAriaLabel", {
                workspace: entry.workspace.name,
              })}
              className="h-9 px-2.5 text-xs"
            >
              {pendingReset ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-3.5" aria-hidden="true" />
              )}
              {t("resetDefaults")}
            </Button>
          ) : null}

          <RoleSegmentedControl
            value={optimistic.role as MutableRole}
            onChange={handleRoleRequest}
            disabled={pendingRole || pendingReset}
            ariaLabel={t("roleAriaLabel", { workspace: entry.workspace.name })}
          />

          <ConfirmDialog
            label={t("remove")}
            ariaLabel={`${t("remove")} ${entry.workspace.name}`}
            prompt={t("removePrompt", { workspace: entry.workspace.name })}
            action={handleRemove}
            hidden={{ userId, workspaceId: entry.workspace.id }}
            pendingLabel={t("removing")}
            tone="danger"
            showStatusMessage={false}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={t("remove")}
                aria-label={`${t("remove")} ${entry.workspace.name}`}
                className="size-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <UserMinus className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {optimistic.permissions.map((perm) => {
          const label = t(`permissions.${perm.permission}.label`);
          const description = t(`permissions.${perm.permission}.description`);
          const isBusy = pendingRole || pendingReset;

          return (
            <div
              key={perm.permission}
              className={cn(
                "flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors",
                perm.adjustment === "granted"
                  ? "border-emerald-500/35 bg-emerald-500/[0.06] hover:border-emerald-500/50"
                  : perm.adjustment === "revoked"
                    ? "border-amber-500/35 bg-amber-500/[0.06] hover:border-amber-500/50"
                    : "border-border/70 bg-muted/20 hover:border-border hover:bg-muted/35",
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {label}
                </span>
                <Tooltip content={description} side="top">
                  <button
                    type="button"
                    aria-label={t("permissionInfoAriaLabel", {
                      permission: label,
                    })}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Info className="size-3.5" aria-hidden="true" />
                  </button>
                </Tooltip>
                {perm.adjustment ? (
                  <AdminBadge
                    tone={perm.adjustment === "granted" ? "success" : "warning"}
                  >
                    {perm.adjustment === "granted"
                      ? t("adjustmentGranted")
                      : t("adjustmentRevoked")}
                  </AdminBadge>
                ) : null}
              </div>

              <Switch
                checked={perm.effective}
                disabled={isBusy}
                onCheckedChange={(next) =>
                  handlePermissionChange(perm.permission, next)
                }
                ariaLabel={t("permissionSwitchAriaLabel", {
                  permission: label,
                  workspace: entry.workspace.name,
                })}
                className="shrink-0"
              />
            </div>
          );
        })}
      </div>

      <CenterMorphModal
        open={confirmRoleTarget !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRole) setConfirmRoleTarget(null);
        }}
      >
        <CenterMorphModalContent
          ariaLabel={t("changeRoleTitle")}
          ariaDescribedBy={rolePromptId}
          dismissible={!pendingRole}
          showCloseButton={!pendingRole}
          closeButtonLabel={t("cancel")}
        >
          <div className="flex min-h-0 flex-col">
            <DialogHeader
              title={t("changeRoleTitle")}
              description={
                <span id={rolePromptId}>
                  {confirmRoleTarget
                    ? t("changeRoleClearPrompt", {
                        workspace: entry.workspace.name,
                        role: t(`roles.${confirmRoleTarget}`),
                        count: adjustedCount,
                      })
                    : null}
                </span>
              }
            />
            <DialogFooter
              cancel={
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  disabled={pendingRole}
                  onClick={() => setConfirmRoleTarget(null)}
                >
                  {t("cancel")}
                </Button>
              }
            >
              <Button
                type="button"
                variant="primary"
                size="md"
                disabled={pendingRole}
                onClick={() => {
                  const next = confirmRoleTarget;
                  setConfirmRoleTarget(null);
                  if (next) commitRoleChange(next);
                }}
              >
                <Check className="size-4" aria-hidden="true" />
                {t("changeRoleConfirm")}
              </Button>
            </DialogFooter>
          </div>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </li>
  );
}
