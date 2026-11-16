"use client";

import type { ReactNode } from "react";
import { CircleAlert, Cpu } from "lucide-react";
import { useTranslations } from "next-intl";
import { ButtonLink } from "@/components/motion/button";
import { cn } from "@/lib/utils";

/**
 * The one "this workspace has no model provider yet" prompt. Every surface that
 * needs a model (assistant and Agent creation, chat, Work, knowledge) renders
 * this instead of its own wording, so the first step always looks the same.
 */
export function ModelProviderNotice({
  slug,
  description,
  className,
}: {
  slug: string;
  /** Replaces the default one-line reason with surface-specific context. */
  description?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("console.modelProviderNotice");
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-2xl border border-border/60 bg-muted/30 px-4 py-3",
        className,
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-40 flex-1">
        <p className="text-sm font-semibold text-foreground">{t("title")}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description ?? t("description")}
        </p>
      </div>
      <ButtonLink
        href={`/app/${encodeURIComponent(slug)}/providers`}
        variant="secondary"
        className="shrink-0"
      >
        <Cpu aria-hidden="true" className="size-4" />
        {t("action")}
      </ButtonLink>
    </div>
  );
}
