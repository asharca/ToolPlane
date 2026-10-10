"use client";

import { ButtonLink } from "@/components/motion/button/base";

import { useId } from "react";

import {
  AlertTriangle,
  ArrowRight,
  Container,
  Cpu,
  KeyRound,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { AgentMarketSetupGuide } from "@/lib/agents/market-setup";

export function AgentMarketSetupBanner({
  slug,
  setup,
}: {
  slug: string;
  setup: AgentMarketSetupGuide;
}) {
  const t = useTranslations("console.agents");
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="mx-5 mt-4 shrink-0 overflow-hidden rounded-md border border-border bg-muted text-muted-foreground text-muted-foreground"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-muted-foreground text-muted-foreground" />
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-semibold">
              {t("marketSetupTitle")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground text-muted-foreground">
              {t("marketSetupDescription")}
            </p>
          </div>
        </div>
      </div>

      <ul className="max-h-52 divide-y divide-border overflow-y-auto">
        {setup.missingProviders.map((provider) => (
          <li
            key={`${provider.agentId}:${provider.format}:${provider.model}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <Cpu className="size-4 text-muted-foreground text-muted-foreground" />
            <span className="text-xs leading-5">
              {t("marketSetupProviderRequirement", {
                format: provider.format,
                model: provider.model,
              })}
            </span>
            <ButtonLink
              href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(provider.agentId)}?settings=agent`}
              variant="ghost"
              size="sm"
            >
              {t("marketSetupOpenAgentSettings")}
              <ArrowRight className="size-3.5" />
            </ButtonLink>
          </li>
        ))}
        {setup.environment.map((environment) => (
          <li
            key={`${environment.deploymentId}:${environment.variable}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <KeyRound className="size-4 text-muted-foreground text-muted-foreground" />
            <span className="min-w-0 text-xs leading-5">
              {t("marketSetupEnvironmentRequirement", {
                variable: environment.variable,
              })}
            </span>
            <ButtonLink
              href={`/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(environment.deploymentId)}`}
              variant="ghost"
              size="sm"
            >
              {t("marketSetupConfigureMcp")}
              <ArrowRight className="size-3.5" />
            </ButtonLink>
          </li>
        ))}
        {setup.runtimes.map((runtime) => (
          <li
            key={`${runtime.agentId}:${runtime.kind}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <Container className="size-4 text-muted-foreground text-muted-foreground" />
            <span className="min-w-0 text-xs leading-5">
              {t("marketSetupRuntimeRequirement", { runtime: runtime.kind })}
            </span>
            <ButtonLink
              href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(runtime.agentId)}?settings=hermes`}
              variant="ghost"
              size="sm"
            >
              {t("marketSetupConfigureRuntime")}
              <ArrowRight className="size-3.5" />
            </ButtonLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
