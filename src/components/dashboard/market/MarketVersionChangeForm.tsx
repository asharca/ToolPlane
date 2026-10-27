"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { updateMarketInstallAction } from "@/lib/market/actions";
import type { MarketInstallReleaseDiff } from "@/lib/market/install-release-diff";

export function MarketVersionChangeForm({
  workspace,
  installId,
  currentReleaseId,
  targetReleaseId,
  targetVersion,
  kind,
  modified = false,
}: {
  workspace: string;
  installId: string;
  currentReleaseId: string;
  targetReleaseId: string;
  targetVersion: number;
  kind: string;
  modified?: boolean;
}) {
  const t = useTranslations("console.market");
  const common = useTranslations("common");
  const [comparison, setComparison] = useState<MarketInstallReleaseDiff | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const request = useRef(0);
  const matches =
    comparison?.from.releaseId === currentReleaseId &&
    comparison?.to.releaseId === targetReleaseId;
  async function load(page = 1) {
    const revision = ++request.current;
    setLoading(true);
    setFailed(false);
    setAcknowledged(false);
    try {
      const query = new URLSearchParams({
        targetReleaseId,
        page: String(page),
        pageSize: "50",
      });
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/market/installs/${encodeURIComponent(installId)}/diff?${query}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("comparison_unavailable");
      const value: MarketInstallReleaseDiff = await response.json();
      if (
        value.from.releaseId !== currentReleaseId ||
        value.to.releaseId !== targetReleaseId
      )
        throw new Error("comparison_changed");
      if (request.current === revision) setComparison(value);
    } catch {
      if (request.current === revision) {
        setComparison(null);
        setFailed(true);
      }
    } finally {
      if (request.current === revision) setLoading(false);
    }
  }
  const label = t("switchToVersion", { version: targetVersion });
  return (
    <section className="min-w-0 space-y-3 rounded-md border border-border p-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={loading}
        onClick={() => load()}
      >
        {loading
          ? t("comparingRelease")
          : `${t("compareRelease")} · v${targetVersion}`}
      </Button>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("comparisonFailed")}
        </p>
      ) : null}
      {matches && comparison ? (
        <div className="space-y-3 text-xs">
          <p>
            {t("comparisonBefore")} v{comparison.from.version} →{" "}
            {t("comparisonAfter")} v{comparison.to.version}
          </p>
          <p>{t("comparisonCounts", comparison.files.counts)}</p>
          {comparison.files.items.length ? (
            <ul className="max-h-52 space-y-1 overflow-auto rounded border border-border p-2 [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
              {comparison.files.items.map((file) => (
                <li key={file.path} className="break-all">
                  <span className="font-medium">
                    {t(
                      file.status === "added"
                        ? "comparisonAdded"
                        : file.status === "removed"
                          ? "comparisonRemoved"
                          : "comparisonChanged",
                    )}
                  </span>{" "}
                  · <code>{file.path}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("comparisonNoFiles")}</p>
          )}
          {comparison.files.total > comparison.files.pageSize ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={loading || comparison.files.page <= 1}
                onClick={() => load(comparison.files.page - 1)}
              >
                {common("previous")}
              </Button>
              <span>
                {t("pageOf", {
                  page: comparison.files.page,
                  total: Math.ceil(
                    comparison.files.total / comparison.files.pageSize,
                  ),
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={
                  loading ||
                  comparison.files.page * comparison.files.pageSize >=
                    comparison.files.total
                }
                onClick={() => load(comparison.files.page + 1)}
              >
                {common("next")}
              </Button>
            </div>
          ) : null}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {(["before", "after"] as const).map((side) => {
              const permissions = comparison.permissions[side];
              const compatibility = comparison.compatibility[side];
              return (
                <section
                  key={side}
                  className="min-w-0 space-y-1 rounded border border-border p-2"
                >
                  <h4 className="font-medium">
                    {t(
                      side === "before"
                        ? "comparisonBefore"
                        : "comparisonAfter",
                    )}
                  </h4>
                  {permissions.requirements.map((requirement) => (
                    <p key={requirement.key} className="break-words">
                      {requirement.name}: {requirement.tools.join(", ") || "—"}
                    </p>
                  ))}
                  <p className="break-words">
                    {t("comparisonEnvironment")}:{" "}
                    {permissions.requiredEnvironment.join(", ") ||
                      t("comparisonNoEnvironment")}
                  </p>
                  <p>
                    {compatibility?.runtime === "pi-sdk"
                      ? `Pi SDK ${compatibility.piVersion} · Node ${compatibility.nodeMajor} · ${compatibility.platform}/${compatibility.arch}`
                      : compatibility?.runtime === "mcp"
                        ? t(
                            compatibility.transport === "stdio"
                              ? "runtimeMcpStdio"
                              : compatibility.transport === "sse"
                                ? "runtimeMcpSse"
                                : "runtimeMcpStreamableHttp",
                          )
                        : t("comparisonUnknownCompatibility")}
                  </p>
                </section>
              );
            })}
          </div>
          <p>
            {t(
              comparison.configurationChanged
                ? "comparisonConfigurationChanged"
                : "comparisonConfigurationUnchanged",
            )}
          </p>
          {kind === "pi-package" ? (
            <ButtonLink
              href={`/app/${encodeURIComponent(workspace)}/market/installed/${encodeURIComponent(installId)}/configure?releaseId=${encodeURIComponent(targetReleaseId)}`}
              size="sm"
              variant="ghost"
            >
              {t("setupWizardTitle")}
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
      <form action={updateMarketInstallAction} className="space-y-3">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="installId" value={installId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="currentReleaseId" value={currentReleaseId} />
        <input type="hidden" name="targetReleaseId" value={targetReleaseId} />
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            required
            checked={matches && acknowledged}
            disabled={!matches || loading}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 size-4"
          />
          {t("comparisonAcknowledgement")}
        </label>
        {modified ? (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              required
              name="force"
              value="yes"
              className="mt-0.5 size-4"
            />
            {t("overwriteLocalChangesConfirmation")}
          </label>
        ) : null}
        <ConfirmSubmitButton
          disabled={!matches || !acknowledged || loading}
          triggerLabel={label}
          triggerAriaLabel={label}
          prompt={t(
            kind === "pi-package"
              ? "piVersionImpact"
              : kind === "mcp"
                ? "mcpVersionImpact"
                : "versionUpdateImpact",
          )}
          confirmLabel={label}
          pendingLabel={t("updating")}
          cancelLabel={common("cancel")}
        />
      </form>
    </section>
  );
}
