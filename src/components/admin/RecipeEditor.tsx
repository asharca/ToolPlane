'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import {
  setServerRecipeAction,
  removeServerRecipeAction,
  validateServerRecipeAction,
  type RecipeActionState,
} from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

type Initial = {
  source: string;
  ref: string;
  startCommand: string;
  env: string; // space-joined key names
  envValues: string; // preset KEY=value lines
  network: boolean; // network === 'none'
};

const input = 'h-9 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const lbl = 'block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300';

export function RecipeEditor({
  serverId,
  hasRecipe,
  initial,
  verifiedAt,
  verifiedTools,
}: {
  serverId: string;
  hasRecipe: boolean;
  initial: Initial;
  verifiedAt: string | null;
  verifiedTools: number | null;
}) {
  const t = useTranslations('admin');
  const [saveState, saveAction] = useActionState<RecipeActionState, FormData>(setServerRecipeAction, {});
  const [removeState, removeAction] = useActionState<RecipeActionState, FormData>(removeServerRecipeAction, {});
  const [valState, valAction] = useActionState<RecipeActionState, FormData>(validateServerRecipeAction, {});

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('deployRecipe')}</h2>
        {verifiedAt ? (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <CheckCircle2 className="size-3.5" /> {t('verified')} {verifiedTools ?? 0} {t('tools')}
          </span>
        ) : (
          <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {t('unverified')}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t('wireUpTheRealPackageSoThisServerIsDeployableChangingTheRecipeClearsVerificationRevalidateToMakeItDeployableInWorkspaces')}
      </p>

      <form action={saveAction} className="space-y-3">
        <input type="hidden" name="id" value={serverId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>
            {t('source')}
            <select name="recipeSource" defaultValue={initial.source || 'npm'} className={input}>
              <option value="npm">{t('npm')}</option>
              <option value="pypi">{t('pypi')}</option>
              <option value="github">{t('github')}</option>
              <option value="docker">{t('docker')}</option>
            </select>
          </label>
          <label className={lbl}>
            {t('referencePackageImageRepo')}
            <input name="recipeRef" defaultValue={initial.ref} placeholder="firecrawl-mcp" className={`${input} font-mono`} />
          </label>
        </div>
        <label className={lbl}>
          {t('startCommandDockerOnly')}
          <input name="recipeStartCommand" defaultValue={initial.startCommand} placeholder="node dist/index.js" className={`${input} font-mono`} />
        </label>
        <label className={lbl}>
          {t('requiredEnvKeysUserFillsSpaceOrCommaSeparated')}
          <input name="recipeEnv" defaultValue={initial.env} placeholder="GITHUB_TOKEN" className={`${input} font-mono`} />
        </label>
        <label className={lbl}>
          {t('presetEnvValuesFixedWiringKeyvaluePerLine')}
          <textarea
            name="recipeEnvValues"
            defaultValue={initial.envValues}
            rows={2}
            placeholder={'FIRECRAWL_API_URL=http://firecrawl-api:3002\nFIRECRAWL_API_KEY=self-hosted'}
            className="w-full rounded-md border border-zinc-200 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" name="recipeNetwork" defaultChecked={initial.network} className="size-4" />
          {t('disconnectFromNetworkNetworkNone')}
        </label>
        <div className="flex items-center gap-3">
          <SubmitButton
            error={saveState.error}
            pendingLabel={t('saving')}
            savedLabel={t('saved')}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {t('saveRecipe')}
          </SubmitButton>
          {saveState.error ? <span className="text-sm text-red-600" role="alert">{saveState.error}</span> : null}
        </div>
      </form>

      {hasRecipe ? (
        <form action={removeAction}>
          <input type="hidden" name="id" value={serverId} />
          <SubmitButton
            error={removeState.error}
            flash={false}
            pendingLabel={t('removing')}
            className="inline-flex h-8 items-center rounded-md border border-zinc-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            {t('removeRecipe')}
          </SubmitButton>
        </form>
      ) : null}

      <form action={valAction} className="space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <input type="hidden" name="id" value={serverId} />
        <label className={lbl}>
          {t('testEnvForValidationOptionalKeyvaluePerLineNotStored')}
          <textarea
            name="testEnv"
            rows={2}
            placeholder="FIRECRAWL_API_KEY=fc-..."
            className="w-full rounded-md border border-zinc-200 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <SubmitButton
          flash={false}
          pendingLabel={t('validatingFirstRun1Min')}
          className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {t('validate')}
        </SubmitButton>
        {valState.ok ? (
          <p className="flex items-start gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('passed')} {valState.toolCount} {t('tools')}
              {valState.tools && valState.tools.length ? `: ${valState.tools.join(', ')}` : ''}
            </span>
          </p>
        ) : null}
        {valState.error ? (
          <p className="flex items-start gap-1.5 text-sm text-red-600" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{valState.error}</span>
          </p>
        ) : null}
      </form>
    </section>
  );
}
