"use client";

import {
  cloneElement,
  useId,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import type { EvolutionOverviewDto } from "@/lib/agents/evolution/contracts";

/** Presentation shared by the evolution panel's steps. */
export const inputClass =
  "w-full min-w-0 rounded-lg border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export type Mutation = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<boolean>;

export interface EvolutionFormat {
  date(value: string): string;
  money(micros: string | number): string;
  score(value: number): string;
  version(id: string | null | undefined): string;
  failure(code: string): string;
}

/** Costs are stored in micro-USD; versions are shown by number, never by internal ID. */
export function useEvolutionFormat(
  revisions: EvolutionOverviewDto["revisions"],
): EvolutionFormat {
  const t = useTranslations("console.evolution");
  const locale = useLocale();
  return useMemo<EvolutionFormat>(() => {
    const dates = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const currency = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
    const percent = new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 0,
    });
    const versions = new Map(revisions.map((item) => [item.id, item.version]));
    return {
      date: (value: string) => dates.format(new Date(value)),
      money: (micros: string | number) =>
        currency.format(Number(micros) / 1_000_000),
      score: (value: number) => percent.format(value),
      version: (id: string | null | undefined) => {
        const version = id ? versions.get(id) : undefined;
        return version === undefined ? t("unknownVersion") : `v${version}`;
      },
      failure: (code: string) =>
        t.has(`failures.${code}`)
          ? t(`failures.${code}`)
          : t("failures.unknown", { code }),
    };
  }, [locale, revisions, t]);
}

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {cloneElement(children, { id })}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
export function Empty({ count }: { count: number }) {
  const t = useTranslations("console.evolution");
  return count ? null : (
    <p className="py-3 text-sm text-muted-foreground">{t("empty")}</p>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
      {children}
    </p>
  );
}
export function Failure({ text }: { text: string }) {
  return <p className="break-words text-sm text-destructive">{text}</p>;
}
export function RecordCard({
  title,
  meta,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <div className="space-y-1">
        <h5 className="break-words font-medium">{title}</h5>
        {meta ? (
          <p className="break-words text-xs text-muted-foreground">{meta}</p>
        ) : null}
      </div>
      {children}
    </article>
  );
}
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h4 className="font-medium">{title}</h4>
      {children}
    </section>
  );
}
