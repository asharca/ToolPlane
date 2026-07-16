'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Save, ShieldCheck } from 'lucide-react';
import {
  setServerRecipeAction,
  removeServerRecipeAction,
  validateServerRecipeAction,
  type RecipeActionState,
} from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

type Initial = {
  source: string;
  ref: string;
  startCommand: string;
  env: string;
  envValues: string;
  network: boolean;
};

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';
const CODE_INPUT_CLASS = 'ui-input h-11 font-mono';
const CODE_TEXTAREA_CLASS = 'ui-input h-auto min-h-24 resize-y py-2.5 font-mono text-xs leading-5';

function RecipeValidation({
  serverId,
  hasRecipe,
  dirty,
}: {
  serverId: string;
  hasRecipe: boolean;
  dirty: boolean;
}) {
  const t = useTranslations('admin');
  const [state, action] = useActionState<RecipeActionState, FormData>(validateServerRecipeAction, {});
  const feedbackIsCurrent = hasRecipe && !dirty;

  return (
    <form action={action} className="space-y-3 border-t border-border pt-5">
      <input type="hidden" name="id" value={serverId} />
      <label className={LABEL_CLASS}>
        <span>{t('testEnvForValidationOptionalKeyvaluePerLineNotStored')}</span>
        <textarea
          name="testEnv"
          rows={4}
          placeholder="FIRECRAWL_API_KEY=fc-..."
          className={CODE_TEXTAREA_CLASS}
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <SubmitButton
        error={state.error}
        flash={false}
        disabled={!hasRecipe || dirty}
        pendingLabel={t('validatingFirstRun1Min')}
        className="ui-button-secondary h-11 w-full sm:w-auto"
      >
        <ShieldCheck className="size-4" />
        {t('validate')}
      </SubmitButton>
      {!hasRecipe || dirty ? (
        <p className="text-xs text-muted-foreground" role="status">
          {dirty ? t('saveChangesBeforeValidate') : t('saveRecipeBeforeValidate')}
        </p>
      ) : null}
      {state.ok && feedbackIsCurrent ? (
        <p className="flex items-start gap-2 text-sm text-accent-foreground" aria-live="polite">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">
            {t('passed')} {state.toolCount} {t('tools')}
            {state.tools && state.tools.length ? `: ${state.tools.join(', ')}` : ''}
          </span>
        </p>
      ) : null}
      {state.error && feedbackIsCurrent ? (
        <p className="flex items-start gap-2 text-sm text-destructive-text" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </p>
      ) : null}
    </form>
  );
}

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
  const [dirty, setDirty] = useState(false);
  const [validationVersion, setValidationVersion] = useState(0);
  const [saveState, saveAction] = useActionState<RecipeActionState, FormData>(setServerRecipeAction, {});

  useEffect(() => {
    if (!saveState.ok) return;
    const frame = requestAnimationFrame(() => {
      setDirty(false);
      setValidationVersion((version) => version + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [saveState]);

  return (
    <AdminPanel
      title={t('deployRecipe')}
      description={t(
        'wireUpTheRealPackageSoThisServerIsDeployableChangingTheRecipeClearsVerificationRevalidateToMakeItDeployableInWorkspaces',
      )}
      actions={verifiedAt ? (
        <AdminBadge tone="success" dot>
          {t('verified')} {verifiedTools ?? 0} {t('tools')}
        </AdminBadge>
      ) : (
        <AdminBadge tone="neutral" dot>
          {t('unverified')}
        </AdminBadge>
      )}
    >
      <div className="space-y-6">
        <form action={saveAction} className="space-y-3" onChange={() => setDirty(true)}>
          <input type="hidden" name="id" value={serverId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              <span>{t('source')}</span>
              <NativeSelect
                name="recipeSource"
                defaultValue={initial.source || 'npm'}
                className="ui-input h-11"
              >
                <option value="npm">{t('npm')}</option>
                <option value="pypi">{t('pypi')}</option>
                <option value="github">{t('github')}</option>
                <option value="docker">{t('docker')}</option>
              </NativeSelect>
            </label>
            <label className={LABEL_CLASS}>
              <span>{t('referencePackageImageRepo')}</span>
              <input
                name="recipeRef"
                defaultValue={initial.ref}
                placeholder="firecrawl-mcp"
                className={CODE_INPUT_CLASS}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>
          <label className={LABEL_CLASS}>
            <span>{t('startCommandDockerOnly')}</span>
            <input
              name="recipeStartCommand"
              defaultValue={initial.startCommand}
              placeholder="node dist/index.js"
              className={CODE_INPUT_CLASS}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className={LABEL_CLASS}>
            <span>{t('requiredEnvKeysUserFillsSpaceOrCommaSeparated')}</span>
            <input
              name="recipeEnv"
              defaultValue={initial.env}
              placeholder="GITHUB_TOKEN"
              className={CODE_INPUT_CLASS}
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <label className={LABEL_CLASS}>
            <span>{t('presetEnvValuesFixedWiringKeyvaluePerLine')}</span>
            <textarea
              name="recipeEnvValues"
              defaultValue={initial.envValues}
              rows={4}
              placeholder={'FIRECRAWL_API_URL=http://firecrawl-api:3002\nFIRECRAWL_API_KEY=self-hosted'}
              className={CODE_TEXTAREA_CLASS}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60">
            <input
              type="checkbox"
              name="recipeNetwork"
              defaultChecked={initial.network}
              className="size-4 shrink-0 accent-brand"
            />
            {t('disconnectFromNetworkNetworkNone')}
          </label>
          <div className="flex flex-col items-start gap-3 pt-1 sm:flex-row sm:items-center">
            <SubmitButton
              error={saveState.error}
              pendingLabel={t('saving')}
              savedLabel={t('saved')}
              className="ui-button-primary h-11 w-full sm:w-auto"
            >
              <Save className="size-4" />
              {t('saveRecipe')}
            </SubmitButton>
            {saveState.error ? (
              <p className="text-sm text-destructive-text" role="alert">
                {saveState.error}
              </p>
            ) : null}
          </div>
        </form>

        <RecipeValidation
          key={validationVersion}
          serverId={serverId}
          hasRecipe={hasRecipe}
          dirty={dirty}
        />

        {hasRecipe ? (
          <div className="border-t border-border pt-5">
            <ConfirmDialog
              label={t('removeRecipe')}
              prompt={t('removeRecipeConfirm')}
              action={removeServerRecipeAction}
              hidden={{ id: serverId }}
              pendingLabel={t('removing')}
              tone="danger"
            />
          </div>
        ) : null}
      </div>
    </AdminPanel>
  );
}
