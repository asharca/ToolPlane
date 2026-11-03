"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  getMcpConnectionImpactAction,
  type McpConnectionImpact,
} from "@/lib/workspace/actions";

export function McpSharedChangeConfirmation({
  workspace,
  deploymentId,
  impactedObjects,
}: {
  workspace: string;
  deploymentId: string;
  impactedObjects?: McpConnectionImpact;
}) {
  const t = useTranslations("console.mcp");
  const [loaded, setLoaded] = useState<McpConnectionImpact | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    getMcpConnectionImpactAction(workspace, deploymentId).then(
      (impact) => {
        if (!active) return;
        setLoaded(impact);
        setFailed(impact === null);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [workspace, deploymentId]);
  const impact = impactedObjects ?? loaded;
  if (!impact)
    return failed ? <p role="alert">{t("impactLoadFailed")}</p> : null;
  const sorted = {
    agentIds: [...impact.agentIds].sort(),
    assistantIds: [...impact.assistantIds].sort(),
  };
  if (!sorted.agentIds.length && !sorted.assistantIds.length) return null;
  return (
    <Confirmation
      key={JSON.stringify(sorted)}
      workspace={workspace}
      impact={sorted}
    />
  );
}

function Confirmation({
  workspace,
  impact,
}: {
  workspace: string;
  impact: McpConnectionImpact;
}) {
  const t = useTranslations("console.mcp");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">
        {t("sharedConnectionImpact")}
      </legend>
      <ul className="space-y-1 break-all text-sm">
        {impact.agentIds.map((id) => (
          <li key={`agent-${id}`}>
            <Link
              className="underline"
              href={`/app/${workspace}/agents/${encodeURIComponent(id)}`}
            >
              Agent · {id}
            </Link>
          </li>
        ))}
        {impact.assistantIds.map((id) => (
          <li key={`assistant-${id}`}>
            <Link
              className="underline"
              href={`/app/${workspace}/chat?assistant=${encodeURIComponent(id)}&settings=1`}
            >
              Assistant · {id}
            </Link>
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1 size-4 shrink-0"
        />
        <span>{t("confirmSharedConnectionChange")}</span>
      </label>
      {confirmed ? (
        <input
          type="hidden"
          name="confirmedImpactedObjects"
          value={JSON.stringify(impact)}
        />
      ) : null}
    </fieldset>
  );
}
