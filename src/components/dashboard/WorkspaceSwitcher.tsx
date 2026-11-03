"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Check, ChevronDown, Plus, Settings } from "lucide-react";
import { ButtonLink } from "@/components/motion/button/base";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { Tooltip } from "@/components/motion/tooltip";
import { CreateWorkspaceForm } from "./WorkspaceForms";
import {
  workspaceInitials,
  workspaceSwitchHref,
  type WorkspaceSummary,
} from "@/lib/workspace/navigation";

export function WorkspaceSwitcher({
  slug,
  workspaceName,
  workspaces,
  compact = false,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: WorkspaceSummary[];
  isAdmin?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("console.workspaceSwitcher");
  const managementT = useTranslations("console.workspaces");
  const pathname = usePathname() ?? "";
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <MorphPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreating(false);
      }}
      className="w-full"
    >
      <Tooltip
        content={`${t("workspaces")}: ${workspaceName}`}
        open={compact ? undefined : false}
        side="right"
        wrapperClassName="flex w-full"
      >
        <MorphPopoverTrigger>
          <button
            type="button"
            aria-label="切换工作区"
            className="group flex h-10 w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl px-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-foreground/20"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-background text-[10px] font-semibold text-foreground">
              {workspaceInitials(workspaceName)}
            </span>
            {!compact && (
              <>
                <span className="min-w-0 flex-1 truncate">{workspaceName}</span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-aria-expanded:rotate-180 motion-reduce:transition-none"
                />
              </>
            )}
          </button>
        </MorphPopoverTrigger>
      </Tooltip>
      <MorphPopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-60 max-w-[calc(100vw-2rem)] border-foreground/15 p-1.5 text-popover-foreground"
      >
        <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
          {t("workspaces")}
        </p>
        <div className="scrollbar-hide max-h-64 overflow-y-auto">
          {workspaces.map((workspace) => (
            <ButtonLink
              key={workspace.id}
              href={workspaceSwitchHref(slug, workspace.slug, pathname)}
              variant="ghost"
              className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground"
              aria-current={workspace.slug === slug ? "page" : undefined}
              onClick={(event) => {
                if (workspace.slug === slug) event.preventDefault();
                setOpen(false);
              }}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
                {workspaceInitials(workspace.name)}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs font-medium">
                  {workspace.name}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {managementT(workspace.role ?? "member")}
                </span>
              </span>
              {workspace.slug === slug && (
                <Check className="size-3.5 shrink-0" />
              )}
            </ButtonLink>
          ))}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <ButtonLink
            href={`/app/${encodeURIComponent(slug)}/settings?returnTo=${encodeURIComponent(pathname)}`}
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground"
            onClick={() => setOpen(false)}
          >
            <Settings className="size-3.5 text-muted-foreground" />
            {managementT("settings")}
          </ButtonLink>
          {creating ? (
            <div className="p-3">
              <CreateWorkspaceForm autoFocus />
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
              onClick={() => setCreating(true)}
            >
              <Plus className="size-3.5 text-muted-foreground" />
              {t("createWorkspace")}
            </button>
          )}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  );
}
