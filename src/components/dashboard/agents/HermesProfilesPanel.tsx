"use client";
import { Button } from "@/components/motion/button/base";
import { FormSelect } from "@/components/ui/FormSelect";

import { useActionState, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Cpu, Loader2, RefreshCw } from "lucide-react";
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";

import {
  updateHermesProfileDefaultModelAction,
  type ActionState,
} from "@/lib/agents/actions";

type HermesProfile = {
  name: string;
  isDefault: boolean;
  provider: string | null;
  model: string | null;
  description: string;
};

export function HermesProfilesPanel({
  slug,
  agentId,
}: {
  slug: string;
  agentId: string;
}) {
  const t = useTranslations("console.agents");
  const profilesUnavailableMessage = t("hermesProfilesUnavailable");
  const modelsUnavailableMessage = t("hermesModelsUnavailable");
  const profileChatRequiresUpgradeMessage = t(
    "hermesProfileChatRequiresUpgrade",
  );
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateHermesProfileDefaultModelAction,
    {},
  );
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [profileChatSupported, setProfileChatSupported] = useState<
    boolean | null
  >(null);
  const [profile, setProfile] = useState("default");
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
    void reload; // Manual refresh reloads profiles without changing the agent.
    const controller = new AbortController();
    fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/hermes/profiles`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          profiles?: HermesProfile[];
          profileChatSupported?: boolean;
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || profilesUnavailableMessage);
        const next = Array.isArray(body.profiles) ? body.profiles : [];
        const supported = body.profileChatSupported === true;
        setProfiles(next);
        setProfileChatSupported(supported);
        if (!supported) setLoadingModels(false);
        setProfile((current) =>
          next.some((item) => item.name === current)
            ? current
            : (next[0]?.name ?? "default"),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error
              ? reason.message
              : profilesUnavailableMessage,
          );
          setLoadingModels(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingProfiles(false);
      });
    return () => controller.abort();
  }, [agentId, profilesUnavailableMessage, reload]);

  useEffect(() => {
    void reload; // Manual refresh also reloads the selected profile's models.
    if (profileChatSupported !== true) return;
    const controller = new AbortController();
    fetch(
      `/api/v1/agents/${encodeURIComponent(agentId)}/hermes/models?profile=${encodeURIComponent(profile)}`,
      {
        signal: controller.signal,
        cache: "no-store",
      },
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          providers?: ModelProviderOption[];
          provider?: string | null;
          model?: string | null;
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error || modelsUnavailableMessage);
        const next = Array.isArray(body.providers) ? body.providers : [];
        setProviders(next);
        setSelection(
          body.provider && body.model
            ? { providerId: body.provider, model: body.model }
            : null,
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : modelsUnavailableMessage,
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingModels(false);
      });
    return () => controller.abort();
  }, [
    agentId,
    modelsUnavailableMessage,
    profile,
    profileChatSupported,
    reload,
  ]);

  const current = profiles.find((item) => item.name === profile);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 sm:px-6">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
          <Cpu className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t("hermesProfileModels")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("hermesProfileModelsDescription")}
          </p>
        </div>
        <Button
          type="button"
          onClick={refresh}
          disabled={loadingProfiles || loadingModels || pending}
          aria-label={t("refreshHermesProfiles")}
          title={t("refreshHermesProfiles")}
          variant={"secondary"}
          size={"icon"}
          className="shrink-0"
        >
          <RefreshCw
            className={`size-3.5 ${loadingProfiles || loadingModels ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <form action={action} className="space-y-4">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="profile" value={profile} />
        <input
          type="hidden"
          name="provider"
          value={selection?.providerId ?? ""}
        />
        <input type="hidden" name="model" value={selection?.model ?? ""} />

        <div className="block space-y-1.5 text-sm font-medium text-foreground">
          {t("hermesProfile")}
          <FormSelect
            value={profile}
            disabled={
              loadingProfiles || pending || profileChatSupported !== true
            }
            label={t("hermesProfile")}
            options={[
              profiles.length === 0
                ? {
                    value: profile,
                    label: loadingProfiles
                      ? t("loadingHermesProfiles")
                      : profile,
                  }
                : null,
              profiles.map((item) => ({ value: item.name, label: item.name })),
            ]
              .flat()
              .filter((option) => option != null)}
            onValueChange={(value) => {
              setProfile(value);
              setSelection(null);
              setLoadingModels(true);
              setError(null);
            }}
            className="w-full"
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            {t("profileDefaultModel")}
          </p>
          <ModelPicker
            providers={providers}
            value={selection}
            pending={loadingModels}
            onSelect={setSelection}
            trigger={
              <Button
                variant="secondary"
                type="button"
                className="w-full justify-between"
                disabled={
                  loadingModels || pending || profileChatSupported !== true
                }
              >
                <span className="truncate">
                  {selection?.model ?? current?.model ?? t("selectModel")}
                </span>
                {loadingModels ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Cpu className="size-4" />
                )}
              </Button>
            }
          />
          {current?.description ? (
            <p className="text-xs text-muted-foreground">
              {current.description}
            </p>
          ) : null}
        </div>

        {profileChatSupported === false || error || state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {profileChatSupported === false
              ? profileChatRequiresUpgradeMessage
              : error || state.error}
          </p>
        ) : null}
        {state.savedAt ? (
          <p
            role="status"
            className="text-xs text-muted-foreground text-muted-foreground"
          >
            {t("hermesProfileModelSaved")}
          </p>
        ) : null}

        <div className="flex justify-end border-t border-border pt-4">
          <Button
            type="submit"
            disabled={
              !selection ||
              loadingModels ||
              pending ||
              profileChatSupported !== true
            }
            variant={"primary"}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {t("save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
