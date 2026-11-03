import { isNativeFieldDirty } from "@/lib/forms/dirty-fields";

export const WORKSPACE_MANAGER_HREF = "/app?view=workspaces";
export const ACCOUNT_SETTINGS_HREF = "/app?view=account";

export type WorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
  role?: "owner" | "admin" | "member";
  status?: string;
  memberCount?: number;
};

const WORKSPACE_SECTIONS = new Set([
  "agents",
  "chat",
  "knowledge",
  "plugins",
  "mcp",
  "members",
  "observability",
  "providers",
  "sandboxes",
  "settings",
  "skills",
  "toolkits",
  "work",
]);

export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/u);
  return (
    words.length > 1
      ? words.map((word) => Array.from(word)[0])
      : Array.from(words[0] || "W")
  )
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();
}

export function workspaceSwitchHref(
  currentSlug: string,
  targetSlug: string,
  pathname: string,
): string {
  if (currentSlug === targetSlug) return pathname;
  const prefix = `/app/${currentSlug}/`;
  const section = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length).split("/")[0]
    : "";
  return `/app/${targetSlug}/${WORKSPACE_SECTIONS.has(section) ? section : "chat"}`;
}

export function lastWorkspaceCookieName(userId: string): string {
  return `toolplane:last-workspace:${encodeURIComponent(userId)}`;
}

export function hasUnsavedWorkspaceChanges(
  root: Document = document,
  except?: HTMLFormElement,
): boolean {
  // ponytail: native fields use their saved defaults; custom/auto-saving editors
  // opt in with data-unsaved-changes while a change is uncommitted.
  const fields = root.querySelectorAll<HTMLElement>(
    '[data-unsaved-changes="true"], form input, form textarea, form select',
  );
  for (const field of fields) {
    if (!field.getClientRects().length || except?.contains(field)) continue;
    if (field.closest('[aria-hidden="true"], [inert]')) continue;
    if (
      field
        .closest("[data-unsaved-changes]")
        ?.getAttribute("data-unsaved-changes") === "false"
    )
      continue;
    if (field.dataset.unsavedChanges === "true") return true;
    if (
      (field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement) &&
      isNativeFieldDirty(field)
    )
      return true;
  }
  return false;
}
