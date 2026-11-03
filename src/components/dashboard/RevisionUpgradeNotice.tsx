"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import type {
  RevisionMcpToolChange,
  RevisionUpgradeDiff,
} from "@/lib/revisions/upgrade-diff";

function toolList(entries: readonly RevisionMcpToolChange[]) {
  return entries
    .flatMap((entry) =>
      entry.tools.map((tool) =>
        entry.name ? `${entry.name} · ${tool}` : tool,
      ),
    )
    .join("、");
}

export function revisionChangeLines(
  diff: RevisionUpgradeDiff,
  t: ReturnType<typeof useTranslations<"console.revisionUpdate">>,
): string[] {
  return [
    ...diff.changedFields.map((field) => t(`fields.${field}`)),
    ...diff.mcpGrantsAdded.map((entry) =>
      t("mcpAdded", { name: entry.name ?? entry.deploymentId }),
    ),
    ...diff.mcpGrantsRemoved.map((entry) =>
      t("mcpRemoved", { name: entry.name ?? entry.deploymentId }),
    ),
    ...(diff.mcpToolsAdded.length
      ? [t("toolsAdded", { tools: toolList(diff.mcpToolsAdded) })]
      : []),
    ...(diff.mcpToolsRemoved.length
      ? [t("toolsRemoved", { tools: toolList(diff.mcpToolsRemoved) })]
      : []),
    ...(diff.skillsAdded.length
      ? [t("skillsAdded", { skills: diff.skillsAdded.join("、") })]
      : []),
    ...(diff.skillsRemoved.length
      ? [t("skillsRemoved", { skills: diff.skillsRemoved.join("、") })]
      : []),
    ...(diff.skillsUpdated.length
      ? [t("skillsUpdated", { skills: diff.skillsUpdated.join("、") })]
      : []),
  ];
}

/**
 * Offers an in-place upgrade from a conversation's pinned revision to the
 * owner's current one. `url` serves GET `?targetVersion=` → `{ diff }` and
 * POST `{ targetVersion }`.
 */
export function RevisionUpgradeNotice({
  url,
  fromVersion,
  targetVersion,
  disabled,
  onUpgraded,
}: {
  url: string;
  fromVersion: number;
  targetVersion: number;
  disabled: boolean;
  onUpgraded: () => void;
}) {
  const t = useTranslations("console.revisionUpdate");
  const [diff, setDiff] = useState<RevisionUpgradeDiff | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleChanges() {
    if (open) return setOpen(false);
    setOpen(true);
    if (diff?.toVersion === targetVersion) return;
    setError(null);
    const response = await fetch(`${url}?targetVersion=${targetVersion}`);
    const body = (await response.json().catch(() => ({}))) as {
      diff?: RevisionUpgradeDiff;
      error?: string;
    };
    if (!response.ok || !body.diff) setError(body.error || t("loadFailed"));
    else setDiff(body.diff);
  }

  async function upgrade() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetVersion }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("upgradeFailed"));
      onUpgraded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("upgradeFailed"));
    } finally {
      setBusy(false);
    }
  }

  const changes = diff ? revisionChangeLines(diff, t) : [];

  return (
    <div
      role="status"
      className="mx-auto my-2 w-[calc(100%-2rem)] max-w-3xl rounded-xl border border-primary/20 bg-primary/5 px-4 py-2 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-foreground">
          {t("title", { from: fromVersion, to: targetVersion })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => void toggleChanges()}
        >
          {open ? t("hideChanges") : t("viewChanges")}
        </Button>
        <Button
          size="sm"
          disabled={busy || disabled}
          onClick={() => void upgrade()}
        >
          {t("upgrade")}
        </Button>
      </div>
      {open && diff ? (
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {changes.length ? (
            changes.map((change) => <li key={change}>{change}</li>)
          ) : (
            <li>{t("noChanges")}</li>
          )}
          {diff.grantsNewPermissions ? (
            <li className="text-warning">{t("newPermissions")}</li>
          ) : null}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error === "AGENT_SHARED_ENVIRONMENT_CONFLICT"
            ? t("sharedEnvironmentConflict")
            : error}
        </p>
      ) : null}
    </div>
  );
}

/** New-conversation hint: the current revision changed MCP tools compared with the previous one. */
export function McpToolsUpdatedNote({
  added,
  removed,
}: {
  added: readonly RevisionMcpToolChange[];
  removed: readonly RevisionMcpToolChange[];
}) {
  const t = useTranslations("console.revisionUpdate");
  if (!added.length && !removed.length) return null;
  return (
    <p
      role="status"
      className="mx-auto max-w-xl rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-center text-xs text-muted-foreground"
    >
      {[
        t("mcpUpdated"),
        added.length ? t("toolsAdded", { tools: toolList(added) }) : null,
        removed.length ? t("toolsRemoved", { tools: toolList(removed) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}
