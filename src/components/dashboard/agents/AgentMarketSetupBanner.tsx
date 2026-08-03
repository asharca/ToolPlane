'use client';

import { useId } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Cpu, KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AgentMarketSetupGuide } from '@/lib/agents/market-setup';

export function AgentMarketSetupBanner({
  slug,
  setup,
}: {
  slug: string;
  setup: AgentMarketSetupGuide;
}) {
  const t = useTranslations('console.agents');
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="mx-5 mt-4 shrink-0 overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100"
    >
      <div className="border-b border-amber-500/20 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-semibold">
              {t('marketSetupTitle')}
            </h3>
            <p className="mt-1 text-xs leading-5 text-amber-900/75 dark:text-amber-100/70">
              {t('marketSetupDescription')}
            </p>
          </div>
        </div>
      </div>

      <ul className="max-h-52 divide-y divide-amber-500/20 overflow-y-auto">
        {setup.missingProviders.map((provider) => (
          <li
            key={`${provider.agentId}:${provider.format}:${provider.model}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <Cpu className="size-4 text-amber-700 dark:text-amber-300" />
            <span className="text-xs leading-5">
              {t('marketSetupProviderRequirement', {
                format: provider.format,
                model: provider.model,
              })}
            </span>
            <Link
              href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(provider.agentId)}?settings=agent`}
              className="inline-flex min-h-8 items-center gap-1.5 text-xs font-semibold text-foreground hover:underline"
            >
              {t('marketSetupOpenAgentSettings')}
              <ArrowRight className="size-3.5" />
            </Link>
          </li>
        ))}
        {setup.environment.map((environment) => (
          <li
            key={`${environment.deploymentId}:${environment.variable}`}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <KeyRound className="size-4 text-amber-700 dark:text-amber-300" />
            <span className="min-w-0 text-xs leading-5">
              {t('marketSetupEnvironmentRequirement', { variable: environment.variable })}
            </span>
            <Link
              href={`/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(environment.deploymentId)}`}
              className="inline-flex min-h-8 items-center gap-1.5 text-xs font-semibold text-foreground hover:underline"
            >
              {t('marketSetupConfigureMcp')}
              <ArrowRight className="size-3.5" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
