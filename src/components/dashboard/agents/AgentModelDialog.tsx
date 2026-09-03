'use client';

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Check, Cpu, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  updateAgentModelAction,
  updateHermesConversationSelectionAction,
  type ActionState,
} from '@/lib/agents/actions';
import { agentRuntimeSupportsProviderFormat } from '@/lib/agents/runtime-kind';
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from '@/components/dashboard/models/ModelPicker';

type Provider = ModelProviderOption & { format: string };

type ModelAgent = {
  id: string;
  name: string;
  runtimeKind: string | null;
  providerId: string | null;
  providerIds: string[];
  model: string | null;
};

type HermesProfile = {
  name: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  description: string;
};

type HermesConversationSelection = {
  id: string | null;
  profile: string;
  provider: string | null;
  model: string | null;
  hasMessages: boolean;
  editable: boolean;
  forkOnProfileChange?: boolean;
};

type HermesSelectionValue = Pick<HermesConversationSelection, 'profile' | 'provider' | 'model'>;

export function AgentModelDialog({
  open,
  onOpenChange,
  slug,
  agent,
  providers,
  trigger,
  confirmationMessage,
  hermesConversation,
  onHermesDraftChange,
  onHermesSelectionSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  agent: ModelAgent;
  providers: Provider[];
  trigger: ReactNode;
  confirmationMessage?: string;
  hermesConversation?: HermesConversationSelection;
  onHermesDraftChange?: (selection: HermesSelectionValue) => void;
  onHermesSelectionSaved?: () => void;
}) {
  const t = useTranslations('console.agents');
  const profilesUnavailableMessage = t('hermesProfilesUnavailable');
  const modelsUnavailableMessage = t('hermesModelsUnavailable');
  const profileChatRequiresUpgradeMessage = t('hermesProfileChatRequiresUpgrade');
  const router = useRouter();
  const isHermes = agent.runtimeKind === 'hermes';
  const [pendingSelection, setPendingSelection] = useState<ModelSelection | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(updateAgentModelAction, {});
  const [hermesState, hermesAction, hermesPending] = useActionState<ActionState, FormData>(
    updateHermesConversationSelectionAction,
    {},
  );
  const processedHermesSave = useRef<number | undefined>(undefined);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [profileChatSupported, setProfileChatSupported] = useState<boolean | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profile, setProfile] = useState(hermesConversation?.profile ?? 'default');
  const [useProfileDefault, setUseProfileDefault] = useState(!hermesConversation?.provider);
  const [profileModels, setProfileModels] = useState<ModelProviderOption[]>([]);
  const [profileModelsLoading, setProfileModelsLoading] = useState(true);
  const [hermesModel, setHermesModel] = useState<ModelSelection | null>(() => (
    hermesConversation?.provider && hermesConversation.model
      ? { providerId: hermesConversation.provider, model: hermesConversation.model }
      : null
  ));
  const compatibleProviders = providers.filter((provider) => (
    agentRuntimeSupportsProviderFormat(agent.runtimeKind ?? '', provider.format)
  ));

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setPendingSelection(null);
    if (nextOpen && isHermes) {
      setProfilesLoading(true);
      setProfileChatSupported(null);
      setProfileError(null);
      setProfile(hermesConversation?.profile ?? 'default');
      setUseProfileDefault(!hermesConversation?.provider);
      setProfileModelsLoading(Boolean(hermesConversation?.provider));
      setHermesModel(hermesConversation?.provider && hermesConversation.model
        ? { providerId: hermesConversation.provider, model: hermesConversation.model }
        : null);
    }
    onOpenChange(nextOpen);
  }, [hermesConversation, isHermes, onOpenChange]);

  useEffect(() => {
    if (!state.savedAt) return;
    onOpenChange(false);
    router.refresh();
  }, [onOpenChange, router, state.savedAt]);

  useEffect(() => {
    if (!open || !isHermes) return;
    const controller = new AbortController();
    fetch(`/api/v1/agents/${encodeURIComponent(agent.id)}/hermes/profiles`, {
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
        setProfiles(Array.isArray(body.profiles) ? body.profiles : []);
        setProfileChatSupported(body.profileChatSupported === true);
        if (body.profileChatSupported !== true) setProfileModelsLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProfileError(error instanceof Error ? error.message : profilesUnavailableMessage);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProfilesLoading(false);
      });
    return () => controller.abort();
  }, [agent.id, isHermes, open, profilesUnavailableMessage]);

  useEffect(() => {
    if (!open || !isHermes || profileChatSupported !== true || useProfileDefault || !profile) return;
    const controller = new AbortController();
    fetch(`/api/v1/agents/${encodeURIComponent(agent.id)}/hermes/models?profile=${encodeURIComponent(profile)}`, {
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
        const nextProviders = Array.isArray(body.providers) ? body.providers : [];
        const defaultProvider = body.provider;
        const defaultModel = body.model;
        setProfileModels(nextProviders);
        setHermesModel((current) => {
          if (current && nextProviders.some((row) => row.id === current.providerId && row.models.includes(current.model))) {
            return current;
          }
          if (defaultProvider && defaultModel && nextProviders.some((row) => row.id === defaultProvider && row.models.includes(defaultModel))) {
            return { providerId: defaultProvider, model: defaultModel };
          }
          const first = nextProviders.find((row) => row.models[0]);
          return first ? { providerId: first.id, model: first.models[0] } : null;
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProfileError(error instanceof Error ? error.message : modelsUnavailableMessage);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProfileModelsLoading(false);
      });
    return () => controller.abort();
  }, [agent.id, isHermes, modelsUnavailableMessage, open, profile, profileChatSupported, useProfileDefault]);

  useEffect(() => {
    if (
      !hermesState.savedAt
      || !hermesState.conversationId
      || processedHermesSave.current === hermesState.savedAt
    ) return;
    processedHermesSave.current = hermesState.savedAt;
    onOpenChange(false);
    if (hermesState.conversationId !== hermesConversation?.id) {
      const query = new URLSearchParams({ agent: agent.id, c: hermesState.conversationId });
      router.push(`/app/${encodeURIComponent(slug)}/chat?${query}`);
    } else {
      void onHermesSelectionSaved?.();
      router.refresh();
    }
  }, [agent.id, hermesConversation?.id, hermesState.conversationId, hermesState.savedAt, onHermesSelectionSaved, onOpenChange, router, slug]);

  const selectModel = useCallback(({ providerId, model }: ModelSelection) => {
    if (confirmationMessage && !window.confirm(confirmationMessage)) return;
    const data = new FormData();
    data.set('workspace', slug);
    data.set('agentId', agent.id);
    data.set('providerId', providerId);
    data.set('model', model);
    setPendingSelection({ providerId, model });
    startTransition(() => formAction(data));
  }, [agent.id, confirmationMessage, formAction, slug]);

  const saveHermesSelection = useCallback(() => {
    if (!hermesConversation?.editable || profileChatSupported !== true) return;
    if (hermesConversation.hasMessages && profile !== hermesConversation.profile) {
      const message = hermesConversation.forkOnProfileChange === false
        ? confirmationMessage
        : t('hermesProfileSwitchStartsNewConversation');
      if (message && !window.confirm(message)) return;
    }
    const selection = {
      profile,
      provider: useProfileDefault ? null : hermesModel?.providerId ?? null,
      model: useProfileDefault ? null : hermesModel?.model ?? null,
    };
    if (!hermesConversation.id && onHermesDraftChange) {
      if (!useProfileDefault && !hermesModel) return;
      onHermesDraftChange(selection);
      handleOpenChange(false);
      return;
    }
    const data = new FormData();
    data.set('workspace', slug);
    data.set('agentId', agent.id);
    if (hermesConversation.id) data.set('conversationId', hermesConversation.id);
    data.set('profile', profile);
    if (selection.provider === null) {
      data.set('useDefault', '1');
    } else {
      data.set('provider', selection.provider);
      data.set('model', selection.model!);
    }
    startTransition(() => hermesAction(data));
  }, [agent.id, confirmationMessage, handleOpenChange, hermesAction, hermesConversation, hermesModel, onHermesDraftChange, profile, profileChatSupported, slug, t, useProfileDefault]);

  const hermesError = profileChatSupported === false
    ? profileChatRequiresUpgradeMessage
    : profileError || hermesState.error;

  if (!isHermes) {
    return (
      <ModelPicker
        open={open}
        onOpenChange={handleOpenChange}
        providers={compatibleProviders}
        value={agent.providerId && agent.model ? { providerId: agent.providerId, model: agent.model } : null}
        pending={isPending}
        pendingValue={pendingSelection}
        error={state.error}
        closeOnSelect={false}
        onSelect={selectModel}
        onConfigure={() => {
          router.push(`/app/${encodeURIComponent(slug)}/providers`);
        }}
        trigger={trigger}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogPortal>
        <DialogOverlay className="!bg-black/45 backdrop-blur-[1px]" />
        <DialogContent className="max-w-xl">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <Cpu className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t('modelConfiguration')}</DialogTitle>
              <DialogDescription className="mt-1">{t('modelConfigurationDescription', { agent: agent.name })}</DialogDescription>
            </div>
          </div>

          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium text-foreground">
              {t('hermesProfile')}
              <NativeSelect
                value={profile}
                disabled={profilesLoading || hermesPending || profileChatSupported !== true || !hermesConversation?.editable}
                onChange={(event) => {
                  setProfile(event.target.value);
                  setUseProfileDefault(true);
                  setHermesModel(null);
                  setProfileError(null);
                }}
                className="ui-input h-10 w-full"
              >
                {profiles.length === 0 ? <option value={profile}>{profilesLoading ? t('loadingHermesProfiles') : profile}</option> : null}
                {profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </NativeSelect>
            </label>

            <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={useProfileDefault}
                disabled={hermesPending || profileChatSupported !== true || !hermesConversation?.editable}
                onChange={(event) => {
                  setUseProfileDefault(event.target.checked);
                  setProfileError(null);
                  if (!event.target.checked) setProfileModelsLoading(true);
                }}
                className="size-4 rounded border-input"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t('useHermesProfileDefault')}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {profiles.find((item) => item.name === profile)?.model ?? t('noModelSelected')}
                </span>
              </span>
            </label>

            {!useProfileDefault ? (
              <ModelPicker
                providers={profileModels}
                value={hermesModel}
                pending={profileModelsLoading}
                onSelect={setHermesModel}
                trigger={(
                  <button type="button" className="ui-button-secondary flex h-10 w-full justify-between px-3" disabled={profileModelsLoading || hermesPending || profileChatSupported !== true}>
                    <span className="truncate">{hermesModel?.model ?? t('selectModel')}</span>
                    {profileModelsLoading ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />}
                  </button>
                )}
              />
            ) : null}

            {hermesError ? (
              <p role="alert" className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {hermesError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <DialogClose asChild><button type="button" className="ui-button-secondary" disabled={hermesPending}>{t('cancel')}</button></DialogClose>
              <button
                type="button"
                onClick={saveHermesSelection}
                className="ui-button-primary gap-2"
                disabled={hermesPending || profilesLoading || profileChatSupported !== true || !hermesConversation?.editable || (!useProfileDefault && !hermesModel)}
              >
                {hermesPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                {t('save')}
              </button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
