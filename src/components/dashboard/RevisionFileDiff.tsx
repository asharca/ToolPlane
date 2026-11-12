"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileDiff } from "@/components/agents/file-diff";
import { Button } from "@/components/motion/button";
import { notify } from "./Toaster";
import { copyText } from "./CopyButton";
import type { AgentRevisionDiff } from "@/lib/revisions/config-diff";

function binaryBytes(document: string) {
  if (!document.trim()) return 0;
  try {
    const value = JSON.parse(document) as {
      encoding?: unknown;
      content?: unknown;
    };
    if (value?.encoding !== "base64" || typeof value.content !== "string")
      return null;
    return (
      Math.floor((value.content.length * 3) / 4) -
      (value.content.endsWith("==") ? 2 : value.content.endsWith("=") ? 1 : 0)
    );
  } catch {
    // An encoding transition can have plain text on one side.
    return null;
  }
}

/** Application labels stay outside the unmodified beUI source. */
export function RevisionFileDiff({ diff }: { diff: AgentRevisionDiff }) {
  const t = useTranslations("console.revisionDiff");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function copy(patch: string) {
    const copied = await copyText(patch);
    notify(
      t(copied ? "copied" : "copyFailed"),
      copied ? undefined : { severity: "error" },
    );
  }

  return (
    <section
      className="min-w-0 max-w-full space-y-3 overflow-hidden"
      aria-label={t("fileChanges")}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>
          {t("summary", {
            files: diff.files.length,
            additions: diff.additions,
            deletions: diff.deletions,
          })}
        </span>
        {diff.files.length ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setExpanded(
                  Object.fromEntries(
                    diff.files.map((file) => [file.path, true]),
                  ),
                )
              }
            >
              {t("expandAll")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setExpanded(
                  Object.fromEntries(
                    diff.files.map((file) => [file.path, false]),
                  ),
                )
              }
            >
              {t("collapseAll")}
            </Button>
          </>
        ) : (
          <p>{t("noChanges")}</p>
        )}
      </div>
      {diff.files.map((file) => (
        <section
          key={file.path}
          className="min-w-0 max-w-full rounded-lg border border-border p-2"
          aria-label={file.path}
        >
          {file.binary ? (
            <div className="space-y-2 p-2 text-sm">
              <p className="break-all font-mono">{file.path}</p>
              <p className="font-mono text-xs">
                <span className="text-emerald-700 dark:text-emerald-400">
                  +{file.additions}
                </span>{" "}
                /{" "}
                <span className="text-rose-700 dark:text-rose-400">
                  −{file.deletions}
                </span>
              </p>
              <p>{t("binary")}</p>
              <p className="text-xs text-muted-foreground">
                {t("binarySize", {
                  before:
                    binaryBytes(
                      file.lines
                        .filter((line) => line.type !== "added")
                        .map((line) => line.content)
                        .join("\n"),
                    ) ?? t("textContent"),
                  after:
                    binaryBytes(
                      file.lines
                        .filter((line) => line.type !== "removed")
                        .map((line) => line.content)
                        .join("\n"),
                    ) ?? t("textContent"),
                })}
              </p>
            </div>
          ) : (
            <FileDiff
              file={<span title={file.path}>{file.path}</span>}
              lines={file.lines}
              language={file.language}
              status="complete"
              collapseOnComplete={false}
              open={expanded[file.path] ?? true}
              onOpenChange={(open) =>
                setExpanded((previous) => ({ ...previous, [file.path]: open }))
              }
              maxHeight={440}
              className="min-w-0 max-w-full"
            />
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copy(file.patch)}
              aria-label={t("copyFile", { path: file.path })}
            >
              {t("copy")}
            </Button>
          </div>
        </section>
      ))}
    </section>
  );
}

export function RevisionDiffLoader({ url }: { url: string }) {
  const t = useTranslations("console.revisionDiff");
  const [diff, setDiff] = useState<AgentRevisionDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  async function load() {
    if (diff) {
      setOpen(!open);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.files))
        throw new Error(t("loadFailed"));
      setDiff(body);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("loadFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-w-0 space-y-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        aria-expanded={open}
        onClick={() => void load()}
      >
        {busy ? t("loading") : open ? t("hide") : t("view")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {open && diff ? <RevisionFileDiff diff={diff} /> : null}
    </div>
  );
}
