"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronRight, Plus, RotateCcw, Search, X } from "lucide-react";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { notify } from "@/components/dashboard/Toaster";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Switch } from "@/components/motion/switch";
import type { AdminActionState } from "@/lib/admin/user-actions";
import type { AdminWorkspaceAccess } from "@/lib/admin/workspace-members";
import {
  addWorkspaceMemberAdminAction,
  removeWorkspaceMemberAdminAction,
  searchJoinableWorkspacesAdminAction,
  setWorkspaceMemberPermissionAdminAction,
  setWorkspaceMemberRoleAdminAction,
} from "@/lib/admin/workspace-member-actions";
import type { WorkspacePermission } from "@/lib/workspace/permissions";

export type WorkspaceAccessEntry = AdminWorkspaceAccess & {
  href: string;
};

type JoinableWorkspace = {
  id: string;
  slug: string;
  name: string;
};

type UserWorkspaceAccessProps = {
  userId: string;
  entries: WorkspaceAccessEntry[];
  ownedWorkspaces: number;
  maxOwnedWorkspaces: number;
};

export function UserWorkspaceAccess({
  userId,
  entries,
  ownedWorkspaces,
  maxOwnedWorkspaces,
}: UserWorkspaceAccessProps) {
  const t = useTranslations("adminWorkspaceAccess");

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
      <AddWorkspaceBar userId={userId} />
      {entries.length > 0 ? (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <WorkspaceAccessRow
              key={entry.workspace.id}
              userId={userId}
              entry={entry}
            />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      )}
    </AdminPanel>
  );
}

function AddWorkspaceBar({ userId }: { userId: string }) {
  const t = useTranslations("adminWorkspaceAccess");
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchSeqRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<JoinableWorkspace | null>(null);
  const [results, setResults] = useState<JoinableWorkspace[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState<string | null>(null);
  const [adding, startAdding] = useTransition();

  useEffect(() => {
    if (!dropdownOpen || selected) return;
    const seq = ++searchSeqRef.current;
    const delay = query.trim() ? 220 : 0;
    const timer = setTimeout(() => {
      setSearching(true);
      searchJoinableWorkspacesAdminAction(userId, query)
        .then((list) => {
          if (searchSeqRef.current === seq) {
            setResults(list);
          }
        })
        .catch(() => {
          if (searchSeqRef.current === seq) {
            setResults([]);
          }
        })
        .finally(() => {
          if (searchSeqRef.current === seq) {
            setSearching(false);
          }
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [dropdownOpen, query, selected, userId]);

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

  const handleAdd = () => {
    if (!selected || adding) return;
    setError(null);
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", selected.id);
    form.set("role", role);
    startAdding(async () => {
      const res = await addWorkspaceMemberAdminAction({}, form);
      if (res.error) {
        setError(res.error);
        notify(res.error, { severity: "error" });
        return;
      }
      notify(t("added"));
      setSelected(null);
      setQuery("");
      setResults([]);
      setRole("member");
      setDropdownOpen(false);
    });
  };

  return (
    <div className="border-b border-border px-4 py-3.5 sm:px-5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div ref={pickerRef} className="relative min-w-0 flex-1">
          <Input
            value={selected ? `${selected.name} (/${selected.slug})` : query}
            onChange={(next) => {
              setQuery(next);
              setSelected(null);
              setError(null);
              setDropdownOpen(true);
            }}
            onFocus={() => {
              if (!selected) setDropdownOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && dropdownOpen) {
                event.preventDefault();
                event.stopPropagation();
                setDropdownOpen(false);
              }
            }}
            placeholder={t("addSearchPlaceholder")}
            aria-label={t("addSearchAriaLabel")}
            autoComplete="off"
            leftIcon={<Search className="size-4" aria-hidden="true" />}
            rightIcon={
              selected ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setQuery("");
                    setError(null);
                    setDropdownOpen(true);
                  }}
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
              role="listbox"
              aria-label={t("addSearchAriaLabel")}
              className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
            >
              {searching ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t("searching")}
                </p>
              ) : results.length > 0 ? (
                results.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      setSelected(ws);
                      setQuery(ws.name);
                      setError(null);
                      setDropdownOpen(false);
                    }}
                    className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <span className="truncate font-medium text-foreground">
                      {ws.name}
                    </span>
                    <code className="shrink-0 font-mono text-xs text-muted-foreground">
                      /{ws.slug}
                    </code>
                  </button>
                ))
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t("noMatchingWorkspaces")}
                </p>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 sm:shrink-0">
          <Select
            value={role}
            onValueChange={(value) => {
              if (value === "admin" || value === "member") setRole(value);
            }}
            disabled={adding}
            className="flex-1 sm:w-32 sm:flex-none"
          >
            <SelectTrigger aria-label={t("addRoleAriaLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">{t("roles.member")}</SelectItem>
              <SelectItem value="admin">{t("roles.admin")}</SelectItem>
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={!selected || adding}
            onClick={handleAdd}
            className="shrink-0"
          >
            <Plus className="size-4" aria-hidden="true" />
            {adding ? t("adding") : t("addButton")}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
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
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingRole, startRoleTransition] = useTransition();
  const [pendingPermission, setPendingPermission] =
    useState<WorkspacePermission | null>(null);
  const [, startPermissionTransition] = useTransition();

  const handleRoleChange = (nextRole: string) => {
    if (
      isOwner ||
      pendingRole ||
      (nextRole !== "admin" && nextRole !== "member") ||
      nextRole === entry.role
    ) {
      return;
    }
    setRowError(null);
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", entry.workspace.id);
    form.set("role", nextRole);
    startRoleTransition(async () => {
      const res = await setWorkspaceMemberRoleAdminAction({}, form);
      if (res.error) {
        setRowError(res.error);
        notify(res.error, { severity: "error" });
        return;
      }
      notify(t("roleUpdated"));
    });
  };

  const handlePermissionChange = (
    permission: WorkspacePermission,
    enabled: boolean,
  ) => {
    if (isOwner || pendingRole || pendingPermission !== null) return;
    setRowError(null);
    setPendingPermission(permission);
    const form = new FormData();
    form.set("userId", userId);
    form.set("workspaceId", entry.workspace.id);
    form.set("permission", permission);
    form.set("enabled", String(enabled));
    startPermissionTransition(async () => {
      try {
        const res = await setWorkspaceMemberPermissionAdminAction({}, form);
        if (res.error) {
          setRowError(res.error);
          notify(res.error, { severity: "error" });
          return;
        }
        notify(t("permissionUpdated"));
      } finally {
        setPendingPermission(null);
      }
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
          {isOwner ? (
            <AdminBadge tone="info">{t("roles.owner")}</AdminBadge>
          ) : (
            <>
              <Select
                value={entry.role}
                onValueChange={handleRoleChange}
                disabled={pendingRole || pendingPermission !== null}
                className="w-32"
              >
                <SelectTrigger
                  aria-label={t("roleAriaLabel", {
                    workspace: entry.workspace.name,
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  <SelectItem value="member">{t("roles.member")}</SelectItem>
                </SelectContent>
              </Select>
              <ConfirmDialog
                label={t("remove")}
                prompt={t("removePrompt", { workspace: entry.workspace.name })}
                action={handleRemove}
                hidden={{ userId, workspaceId: entry.workspace.id }}
                pendingLabel={t("removing")}
                tone="danger"
              />
            </>
          )}
        </div>
      </div>

      {isOwner ? (
        <p className="text-xs text-muted-foreground">
          {t("ownerAllPermissions")}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entry.permissions.map((perm) => {
          const label = t(`permissions.${perm.permission}.label`);
          const description = t(`permissions.${perm.permission}.description`);
          const isPermBusy =
            pendingRole || pendingPermission === perm.permission;

          return (
            <div
              key={perm.permission}
              className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {label}
                  </span>
                  {perm.adjustment ? (
                    <AdminBadge
                      tone={
                        perm.adjustment === "granted" ? "success" : "warning"
                      }
                    >
                      {perm.adjustment === "granted"
                        ? t("adjustmentGranted")
                        : t("adjustmentRevoked")}
                    </AdminBadge>
                  ) : null}
                  {perm.adjustment && !isOwner ? (
                    <button
                      type="button"
                      disabled={isPermBusy}
                      onClick={() =>
                        handlePermissionChange(perm.permission, perm.byDefault)
                      }
                      aria-label={t("resetAriaLabel", { permission: label })}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    >
                      <RotateCcw className="size-3" aria-hidden="true" />
                      {t("resetToDefault")}
                    </button>
                  ) : null}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {description}
                </p>
              </div>
              <Switch
                checked={perm.effective}
                disabled={isOwner || isPermBusy}
                onCheckedChange={(next) =>
                  handlePermissionChange(perm.permission, next)
                }
                ariaLabel={t("permissionSwitchAriaLabel", {
                  permission: label,
                  workspace: entry.workspace.name,
                })}
                className="mt-0.5 shrink-0"
              />
            </div>
          );
        })}
      </div>

      {rowError ? (
        <p className="text-xs text-destructive" role="alert">
          {rowError}
        </p>
      ) : null}
    </li>
  );
}
