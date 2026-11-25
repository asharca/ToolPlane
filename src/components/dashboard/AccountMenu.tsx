"use client";

import { useState } from "react";
import { Languages, LogOut, Settings, Shield } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Tooltip } from "@/components/motion/tooltip";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { workspaceInitials } from "@/lib/workspace/navigation";
import { logoutAction } from "@/lib/auth/actions";
import { setLocale } from "@/lib/i18n/actions";
import type { Locale } from "@/i18n/routing";

export function AccountMenu({
  userLabel,
  workspaceSlug,
  returnTo,
  compact = false,
  isAdmin = false,
}: {
  userLabel: string;
  workspaceSlug?: string;
  returnTo?: string;
  compact?: boolean;
  isAdmin?: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const sidebar = useTranslations("console.sidebar");
  const switcher = useTranslations("console.workspaceSwitcher");
  const common = useTranslations("common");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  return (
    <MorphPopover open={open} onOpenChange={setOpen} className="w-full">
      <Tooltip
        content={`${t("account")}: ${userLabel}`}
        open={compact ? undefined : false}
        side="right"
        wrapperClassName="flex w-full"
      >
        <MorphPopoverTrigger>
          <button
            type="button"
            aria-label={sidebar("accountMenu")}
            className="flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg px-2 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              {workspaceInitials(userLabel)}
            </span>
            {!compact && (
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {userLabel}
              </span>
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
        <p className="truncate px-2.5 pb-1 pt-2 text-xs font-medium text-foreground">
          {userLabel}
        </p>
        <ButtonLink
          href={
            workspaceSlug
              ? `/app/${encodeURIComponent(workspaceSlug)}/settings/account?returnTo=${encodeURIComponent(returnTo ?? `/app/${encodeURIComponent(workspaceSlug)}/chat`)}`
              : "/app?view=account"
          }
          variant="ghost"
          className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground"
          onClick={() => setOpen(false)}
        >
          <Settings className="size-3.5 text-muted-foreground" />
          {t("account")}
        </ButtonLink>
        {isAdmin ? (
          <ButtonLink
            href="/admin"
            variant="ghost"
            className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-2 text-xs text-foreground"
            onClick={() => setOpen(false)}
          >
            <Shield className="size-3.5 text-muted-foreground" />
            {sidebar("adminConsole")}
          </ButtonLink>
        ) : null}
        <div className="mt-1 space-y-1 border-t border-border pt-1.5">
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">{t("appearance")}</span>
            <ThemeToggle showLabel />
          </div>
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-xs">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Languages className="size-3.5" aria-hidden="true" />
              {common("language")}
            </span>
            <fieldset
              aria-label={common("language")}
              className="m-0 inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
            >
              {(["en", "zh"] as const).map((nextLocale) => (
                <Button
                  key={nextLocale}
                  type="button"
                  size="sm"
                  variant={locale === nextLocale ? "secondary" : "ghost"}
                  aria-pressed={locale === nextLocale}
                  className="h-6 rounded px-2 text-[11px]"
                  onClick={() => {
                    if (nextLocale !== locale) setLocale(nextLocale);
                  }}
                >
                  {common(nextLocale)}
                </Button>
              ))}
            </fieldset>
          </div>
        </div>
        <form
          action={logoutAction}
          className="mt-1 border-t border-border pt-1"
        >
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
          >
            <LogOut className="size-3.5 text-muted-foreground" />
            {switcher("signOut")}
          </button>
        </form>
      </MorphPopoverContent>
    </MorphPopover>
  );
}
