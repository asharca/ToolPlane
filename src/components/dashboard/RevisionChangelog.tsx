"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { revisionChangeLines } from "@/components/dashboard/RevisionUpgradeNotice";
import type { RevisionChangelogPage } from "@/lib/revisions/upgrade-diff";

/** `url` serves GET `?beforeVersion=` → `RevisionChangelogPage`, newest first. */
export function RevisionChangelog({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  const t = useTranslations("console.revisionUpdate");
  const locale = useLocale();
  const dates = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const [page, setPage] = useState<RevisionChangelogPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (beforeVersion?: number) => {
      setBusy(true);
      setError(null);
      try {
        const query = beforeVersion ? `?beforeVersion=${beforeVersion}` : "";
        const response = await fetch(`${url}${query}`);
        const body = (await response.json().catch(() => ({}))) as Partial<
          RevisionChangelogPage & { error: string }
        >;
        if (!response.ok || !body.entries) throw new Error(t("loadFailed"));
        const next = body as RevisionChangelogPage;
        setPage((previous) =>
          beforeVersion && previous
            ? { ...next, entries: [...previous.entries, ...next.entries] }
            : next,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("loadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [url, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={className}>
      <header className="border-b border-border/60 pb-5">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      </header>
      {page && !page.entries.length ? (
        <p className="text-sm text-muted-foreground">{t("changelog.empty")}</p>
      ) : null}
      {page?.entries.length ? (
        <ol className="space-y-5">
          {page.entries.map((entry) => {
            const changes = entry.diff
              ? revisionChangeLines(entry.diff, t)
              : [];
            return (
              <li
                key={entry.version}
                className="space-y-2 border-b border-border/60 pb-5 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">
                    v{entry.version}
                  </span>
                  {entry.version === page.currentVersion ? (
                    <AnimatedBadge status="neutral" size="sm" showIcon={false}>
                      {t("changelog.current")}
                    </AnimatedBadge>
                  ) : null}
                  <time
                    dateTime={entry.createdAt}
                    className="ml-auto text-xs text-muted-foreground"
                  >
                    {dates.format(new Date(entry.createdAt))}
                  </time>
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {!entry.diff ? (
                    <li>{t("changelog.initial")}</li>
                  ) : changes.length ? (
                    changes.map((change) => <li key={change}>{change}</li>)
                  ) : (
                    <li>{t("noChanges")}</li>
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {page?.nextBeforeVersion ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void load(page.nextBeforeVersion ?? undefined)}
        >
          {t("changelog.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
