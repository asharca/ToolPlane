'use client';

import { useActionState, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Eye, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import {
  revealMcpJsonConfigAction,
  updateMcpJsonConfigAction,
  type McpJsonConfigActionState,
} from '@/lib/workspace/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  McpNetworkModeControl,
  type McpNetworkMode,
} from '@/components/dashboard/McpNetworkModeControl';

function errorMessage(
  error: McpJsonConfigActionState['error'],
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!error) return null;
  return t(error);
}

export function McpJsonConfigEditor({
  slug,
  deploymentId,
  maskedConfig,
  requiresReveal,
  initialNetwork,
  warnAboutPackageInstall,
  variablesHref,
  configuredVariables = 0,
}: {
  slug: string;
  deploymentId: string;
  maskedConfig: string;
  requiresReveal: boolean;
  initialNetwork: McpNetworkMode;
  warnAboutPackageInstall: boolean;
  variablesHref?: string;
  configuredVariables?: number;
}) {
  const t = useTranslations('console.mcp');
  const [state, formAction, isPending] = useActionState<McpJsonConfigActionState, FormData>(
    updateMcpJsonConfigAction,
    {},
  );
  const [config, setConfig] = useState(maskedConfig);
  const [revealed, setRevealed] = useState(!requiresReveal);
  const [isRevealPending, startReveal] = useTransition();
  const [revealError, setRevealError] = useState<string | null>(null);
  const [lastEditAt, setLastEditAt] = useState(0);
  const [network, setNetwork] = useState<McpNetworkMode>(initialNetwork);
  const error = errorMessage(state.error, t) ?? revealError;

  const revealConfig = () => {
    setRevealError(null);
    startReveal(async () => {
      try {
        const result = await revealMcpJsonConfigAction({ workspace: slug, deploymentId });
        if (result.config !== undefined) {
          setConfig(result.config);
          setRevealed(true);
          return;
        }
        setRevealError(t(result.error ?? 'revealSensitiveConfigFailed'));
      } catch {
        setRevealError(t('revealSensitiveConfigFailed'));
      }
    });
  };

  return (
    <form action={formAction} className="ui-panel max-w-4xl overflow-hidden">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('configuration')}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('configurationDescription')}</p>
      </header>
      <div className="space-y-5 px-5 py-5">
        {variablesHref ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/25 px-3 py-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">{t('variablesManagedSeparately')}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t('configuredVariableCount', { count: configuredVariables })}
                </p>
              </div>
            </div>
            <Link href={variablesHref} className="ui-button-secondary ui-button-sm shrink-0">
              {t('manageVariables')}
            </Link>
          </div>
        ) : null}
        <McpNetworkModeControl
          value={network}
          onChange={(value) => {
            setNetwork(value);
            setLastEditAt(Date.now());
          }}
          disabled={isPending}
          warnAboutPackageInstall={warnAboutPackageInstall}
        />
        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">
            {t('jsonConfig')}
          </p>
        {revealed ? (
          <textarea
            id="mcp-json-config"
            name="config"
            required
            disabled={isPending}
            value={config}
            onChange={(event) => {
              setConfig(event.target.value);
              setLastEditAt(Date.now());
            }}
            spellCheck={false}
            aria-label={t('jsonConfig')}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'mcp-json-config-error' : undefined}
            className="min-h-[28rem] w-full resize-y rounded-md border border-border bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <>
            <pre
              aria-label={t('jsonConfig')}
              className="min-h-[28rem] w-full overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-4 font-mono text-xs leading-5 text-foreground"
            >
              {maskedConfig}
            </pre>
            <button
              type="button"
              onClick={revealConfig}
              disabled={isRevealPending}
              aria-busy={isRevealPending}
              className="mt-2 inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-70"
            >
              {isRevealPending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
              {isRevealPending ? t('revealingSensitiveConfig') : t('revealSensitiveConfigAndEdit')}
            </button>
          </>
        )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-h-5">
            {error ? (
              <p id="mcp-json-config-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : state.savedAt && state.savedAt > lastEditAt ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
                {state.requiresSetup
                  ? t('configurationSavedVariablesRequired')
                  : t('configurationSavedAndRebuildSubmitted')}
              </p>
            ) : null}
          </div>
          {revealed ? (
            <SubmitButton
              error={error}
              flash={false}
              pendingLabel={t('savingAndRebuilding')}
              className="ui-button-primary h-9"
            >
              <RefreshCw className="size-4" />
              {t('saveAndRebuild')}
            </SubmitButton>
          ) : null}
        </div>
      </div>
    </form>
  );
}
