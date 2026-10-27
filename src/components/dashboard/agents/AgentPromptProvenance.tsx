"use client";

import { useTranslations } from "next-intl";
import type { AgentPromptInvocationPart } from "@/lib/agents/prompt-invocation";

export function AgentPromptProvenance({
  parts,
}: {
  parts: readonly unknown[];
}) {
  const t = useTranslations("console.agents");
  const part = parts.find((value): value is AgentPromptInvocationPart => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<AgentPromptInvocationPart>;
    return (
      candidate.type === "data-agent-prompt-invocation" &&
      Boolean(candidate.data?.source)
    );
  });
  if (!part) return null;
  const invocation = part.data;
  return (
    <details
      data-ui="agent-prompt-provenance"
      className="mt-2 text-xs text-muted-foreground"
    >
      <summary className="cursor-pointer">
        /{invocation.name} · {t("promptInvocationDetails")}
      </summary>
      <dl className="mt-2 space-y-1 break-all">
        <dt>{t("promptInvocationSource")}</dt>
        <dd className="font-mono">
          {invocation.source.path} · {invocation.version}
        </dd>
        <dd className="font-mono">
          {invocation.source.marketInstallId} / {invocation.source.releaseId}
        </dd>
        <dd className="font-mono">{invocation.source.checksum}</dd>
        <dt>{t("promptInvocationArguments")}</dt>
        <dd className="whitespace-pre-wrap font-mono">
          {invocation.rawArguments}
        </dd>
        <dd className="whitespace-pre-wrap font-mono">
          {JSON.stringify(invocation.arguments)}
        </dd>
      </dl>
    </details>
  );
}
