'use client';

import { useActionState, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Cpu, Loader2, RefreshCw } from 'lucide-react';
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from '@/components/dashboard/models/ModelPicker';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  updateHermesProfileDefaultModelAction,
  type ActionState,
} from '@/lib/agents/actions';

type HermesProfile = {
  name: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  description: string;
};

export function HermesProfilesPanel({ slug, agentId }: { slug: string; agentId: string }) {
  const t = useTranslations('console.agents');
  const profilesUnavailableMessage = t('hermesProfilesUnavailable');
  const modelsUnavailableMessage = t('hermesModelsUnavailable');
  const profileChatRequiresUpgradeMessage = t('hermesProfileChatRequiresUpgrade');
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateHermesProfileDefaultModelAction,
    {},
  );
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [profileChatSupported, setProfileChatSupported] = useState<boolean | null>(null);
  const [profile, setProfile] = useState('default');
  const [providers, setProviders] = useState<ModelProviderOption[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadingModels, setLoadingModels] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => {
    setLoadingProfiles(true);
    setLoadingModels(true);
    setProfileChatSupported(null);
    setError(null);
    setReload((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/hermes/profiles`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json() as {
          profiles?: HermesProfile[];
          profileChatSupported?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || profilesUnavailableMessage);
        const next = Array.isArray(body.profiles) ? body.profiles : [];
        const supported = body.profileChatSupported === true;
        setProfiles(next);
        setProfileChatSupported(supported);
        if (!supported) setLoadingModels(false);
        setProfile((current) => next.some((item) => item.name === current) ? current : next[0]?.name ?? 'default');
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : profilesUnavailableMessage);
          setLoadingModels(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingProfiles(false);
      });
    return () => controller.abort();
  }, [agentId, profilesUnavailableMessage, reload]);

  useEffect(() => {
    if (profileChatSupported !== true) return;
    const controller = new AbortController();
    fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/hermes/models?profile=${encodeURIComponent(profile)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json() as {
          providers?: ModelProviderOption[];
          provider?: string | null;
          model?: string | null;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || modelsUnavailableMessage);
        const next = Array.isArray(body.providers) ? body.providers : [];
        setProviders(next);
        setSelection(body.provider && body.model ? { providerId: body.provider, model: body.model } : null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : modelsUnavailableMessage);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingModels(false);
      });
    return () => controller.abort();
  }, [agentId, modelsUnavailableMessage, profile, profileChatSupported, reload]);

  const current = profiles.find((item) => item.name === profile);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
          <Cpu className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t('hermesProfileModels')}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('hermesProfileModelsDescription')}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loadingProfiles || loadingModels || pending}
          aria-label={t('refreshHermesProfiles')}
          title={t('refreshHermesProfiles')}
          className="ui-button-secondary size-8 shrink-0 px-0"
        >
          <RefreshCw className={`size-3.5 ${loadingProfiles || loadingModels ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="profile" value={profile} />
        <input type="hidden" name="provider" value={selection?.providerId ?? ''} />
        <input type="hidden" name="model" value={selection?.model ?? ''} />

        <label className="block space-y-1.5 text-sm font-medium text-foreground">
          {t('hermesProfile')}
          <NativeSelect
            value={profile}
            disabled={loadingProfiles || pending || profileChatSupported !== true}
            onChange={(event) => {
              setProfile(event.target.value);
              setSelection(null);
              setLoadingModels(true);
              setError(null);
            }}
            className="ui-input h-10 w-full"
          >
            {profiles.length === 0 ? <option value={profile}>{loadingProfiles ? t('loadingHermesProfiles') : profile}</option> : null}
            {profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </NativeSelect>
        </label>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('profileDefaultModel')}</p>
          <ModelPicker
            providers={providers}
            value={selection}
            pending={loadingModels}
            onSelect={setSelection}
            trigger={(
              <button type="button" className="ui-button-secondary flex h-10 w-full justify-between px-3" disabled={loadingModels || pending || profileChatSupported !== true}>
                <span className="truncate">{selection?.model ?? current?.model ?? t('selectModel')}</span>
                {loadingModels ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />}
              </button>
            )}
          />
          {current?.description ? <p className="text-xs text-muted-foreground">{current.description}</p> : null}
        </div>

        {profileChatSupported === false || error || state.error ? (
          <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {profileChatSupported === false ? profileChatRequiresUpgradeMessage : error || state.error}
          </p>
        ) : null}
        {state.savedAt ? <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{t('hermesProfileModelSaved')}</p> : null}

        <div className="flex justify-end border-t border-border pt-4">
          <button type="submit" className="ui-button-primary gap-2" disabled={!selection || loadingModels || pending || profileChatSupported !== true}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}
