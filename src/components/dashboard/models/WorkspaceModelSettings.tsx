"use client";

import { Button } from "@/components/motion/button";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import { updateWorkspaceModelPreferenceAction } from "@/lib/agents/actions";

function ModelPreferenceRow({
  slug,
  preference,
  providers,
  initialValue,
}: {
  slug: string;
  preference: "default" | "title";
  providers: ModelProviderOption[];
  initialValue: ModelSelection | null;
}) {
  const t = useTranslations("console.settings");
  const [value, setValue] = useState(initialValue);
  const [pendingValue, setPendingValue] = useState<ModelSelection | null>(null);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const provider = providers.find((item) => item.id === value?.providerId);
  const title = preference === "default" ? t("defaultModel") : t("titleModel");
  const description =
    preference === "default" ? t("defaultModelDesc") : t("titleModelDesc");
  const emptyLabel =
    preference === "title" ? t("useDefaultModel") : t("selectModel");

  function save(next: ModelSelection | null) {
    const previous = value;
    setValue(next);
    setPendingValue(next);
    setError(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("workspace", slug);
      formData.set("preference", preference);
      if (next) {
        formData.set("providerId", next.providerId);
        formData.set("model", next.model);
      }
      const result = await updateWorkspaceModelPreferenceAction({}, formData);
      if (result.error) {
        setValue(previous);
        setError(true);
      }
      setPendingValue(null);
    });
  }

  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("modelPreferenceSaveError")}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 sm:w-80">
        <ModelPicker
          className="flex-1"
          providers={providers}
          value={value}
          pending={pending}
          pendingValue={pendingValue}
          onSelect={save}
          onConfigure={() =>
            window.location.assign(`/app/${encodeURIComponent(slug)}/providers`)
          }
          trigger={
            <ModelPickerTrigger
              disabled={pending}
              pending={pending}
              aria-label={`${title}: ${value?.model ?? emptyLabel}`}
              label={value?.model ?? emptyLabel}
              placeholder={!value}
              provider={provider?.name}
            />
          }
        />
        {value ? (
          <Button
            type="button"
            disabled={pending}
            onClick={() => save(null)}
            aria-label={
              preference === "title"
                ? t("useDefaultModel")
                : t("clearDefaultModel")
            }
            title={
              preference === "title"
                ? t("useDefaultModel")
                : t("clearDefaultModel")
            }
            variant="ghost"
            size="icon"
            className="shrink-0"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceModelSettings({
  slug,
  providers,
  defaultModel,
  titleModel,
}: {
  slug: string;
  providers: ModelProviderOption[];
  defaultModel: ModelSelection | null;
  titleModel: ModelSelection | null;
}) {
  return (
    <div className="divide-y divide-border">
      <ModelPreferenceRow
        slug={slug}
        preference="default"
        providers={providers}
        initialValue={defaultModel}
      />
      <ModelPreferenceRow
        slug={slug}
        preference="title"
        providers={providers}
        initialValue={titleModel}
      />
    </div>
  );
}
