'use client';
import { FormSelect } from '@/components/ui/FormSelect';

import { Input } from '@/components/motion/input';
import { FormCheckbox } from '@/components/ui/FormCheckbox';


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

import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

type Initial = {
  source: string;
  ref: string;
  sourceUrl: string;
  startCommand: string;
  env: string;
  envValues: string;
  network: boolean;
  transport?: 'streamable-http' | 'sse';
  authType?: 'none' | 'bearer' | 'headers';
  bearerEnv?: string;
  headerEnv?: string;
};

const LABEL_CLASS = 'block space-y-1.5 text-sm font-medium text-foreground';

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
        <textarea name="testEnv" rows={4} placeholder="FIRECRAWL_API_KEY=fc-..." autoCapitalize="none" spellCheck={false} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      <SubmitButton
        error={state.error}
        flash={false}
        disabled={!hasRecipe || dirty}
        pendingLabel={t('validatingFirstRun1Min')}
        variant="secondary" size="md" className="w-full sm:w-auto"
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
        <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
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
  const [source, setSource] = useState(initial.source || 'npm');
  const [authType, setAuthType] = useState(initial.authType ?? 'none');
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
            <div className={LABEL_CLASS}>
              <span>{t('source')}</span>
              <FormSelect name="recipeSource" defaultValue={initial.source || 'npm'} onValueChange={(value) => { setSource(value); setDirty(true); }} label={t('source')} options={[{ value: "npm", label: t('npm') }, { value: "pypi", label: t('pypi') }, { value: "github", label: t('github') }, { value: "docker", label: t('docker') }, { value: "remote", label: t('connectorRemote') }]} />
            </div>
            <label className={LABEL_CLASS}>
              <span>{source === 'remote' ? t('connectorEndpointUrl') : t('referencePackageImageRepo')}</span>
              <Input name="recipeRef" defaultValue={initial.ref} placeholder={source === 'remote' ? 'https://mcp.example.com/mcp' : 'firecrawl-mcp'} inputMode={source === 'remote' ? 'url' : undefined} autoCapitalize="none" spellCheck={false} />
            </label>
          </div>
          {source === 'remote' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className={LABEL_CLASS}>
                  <span>{t('transport')}</span>
                  <FormSelect onValueChange={() => setDirty(true)} name="recipeTransport" defaultValue={initial.transport ?? 'streamable-http'} label={t('transport')} options={[{ value: "streamable-http", label: t('streamableHttp') }, { value: "sse", label: t('serverSentEvents') }]} />
                </div>
                <div className={LABEL_CLASS}>
                  <span>{t('authentication')}</span>
                  <FormSelect name="recipeAuthType" defaultValue={initial.authType ?? 'none'} onValueChange={(value) => { setAuthType(value as typeof authType); setDirty(true); }} label={t('authentication')} options={[{ value: "none", label: t('authNone') }, { value: "bearer", label: t('authBearerToken') }, { value: "headers", label: t('authCustomHeaders') }]} />
                </div>
              </div>
              {authType === 'bearer' ? (
                <label className={LABEL_CLASS}>
                  <span>{t('bearerTokenEnvKey')}</span>
                  <Input name="recipeBearerEnv" defaultValue={initial.bearerEnv ?? 'MCP_BEARER_TOKEN'} placeholder="MCP_BEARER_TOKEN" autoCapitalize="characters" spellCheck={false} />
                </label>
              ) : null}
              {authType === 'headers' ? (
                <label className={LABEL_CLASS}>
                  <span>{t('customHeaderEnvMappings')}</span>
                  <textarea name="recipeHeaderEnv" defaultValue={initial.headerEnv ?? ''} rows={4} placeholder={'X-API-Key=MCP_API_KEY\nX-Tenant-ID=MCP_TENANT_ID'} autoCapitalize="none" spellCheck={false} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                </label>
              ) : null}
            </>
          ) : (
            <>
              <label className={LABEL_CLASS}>
                <span>{t('startCommandDockerOnly')}</span>
                <Input name="recipeStartCommand" defaultValue={initial.startCommand} placeholder="node dist/index.js" autoCapitalize="none" spellCheck={false} />
              </label>
              <label className={LABEL_CLASS}>
                <span>{t('requiredEnvKeysUserFillsSpaceOrCommaSeparated')}</span>
                <Input name="recipeEnv" defaultValue={initial.env} placeholder="GITHUB_TOKEN" autoCapitalize="characters" spellCheck={false} />
              </label>
              <label className={LABEL_CLASS}>
                <span>{t('presetEnvValuesFixedWiringKeyvaluePerLine')}</span>
                <textarea name="recipeEnvValues" defaultValue={initial.envValues} rows={4} placeholder={'FIRECRAWL_API_URL=http://firecrawl-api:3002\nFIRECRAWL_API_KEY=self-hosted'} autoCapitalize="none" spellCheck={false} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </label>
              <div className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted/60">
                <FormCheckbox onCheckedChange={() => setDirty(true)} name="recipeNetwork" defaultChecked={initial.network} label={t('disconnectFromNetworkNetworkNone')} />
                
              </div>
            </>
          )}
          <label className={LABEL_CLASS}>
            <span>{t('sourceUrl')}</span>
            <Input name="recipeSourceUrl" defaultValue={initial.sourceUrl} placeholder="https://github.com/owner/repository" inputMode="url" autoCapitalize="none" spellCheck={false} />
          </label>
          <div className="flex flex-col items-start gap-3 pt-1 sm:flex-row sm:items-center">
            <SubmitButton
              error={saveState.error}
              pendingLabel={t('saving')}
              savedLabel={t('saved')}
              variant="primary" size="md" className="w-full sm:w-auto"
            >
              <Save className="size-4" />
              {t('saveRecipe')}
            </SubmitButton>
            {saveState.error ? (
              <p className="text-sm text-destructive" role="alert">
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
