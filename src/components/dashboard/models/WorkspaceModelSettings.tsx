"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import {
  AdaptiveStepper,
  AdaptiveStepperDecrement,
  AdaptiveStepperIncrement,
  AdaptiveStepperValue,
} from "@/components/motion/adaptive-stepper";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import {
  updateWorkspaceModelPreferenceAction,
  updateWorkspaceModelRetryAction,
} from "@/lib/agents/provider-actions";

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
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
        {error ? (
          <Alert variant="destructive" className="mt-2">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {t("modelPreferenceSaveError")}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 sm:w-96">
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
    <>
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
    </>
  );
}

export function ModelRetrySetting({
  slug,
  initialAttempts,
}: {
  slug: string;
  initialAttempts: number;
}) {
  const t = useTranslations("console.settings");
  const [attempts, setAttempts] = useState(initialAttempts);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  function save(next: number) {
    const previous = attempts;
    setAttempts(next);
    setError(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("workspace", slug);
      formData.set("attempts", String(next));
      const result = await updateWorkspaceModelRetryAction({}, formData);
      if (result.error) {
        setAttempts(previous);
        setError(true);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-foreground">
          {t("modelRetryAttempts")}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {t("modelRetryAttemptsDesc")}
        </p>
        {error ? (
          <Alert variant="destructive" className="mt-2">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {t("modelPreferenceSaveError")}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 sm:w-96 sm:justify-end">
        <span className="text-sm tabular-nums text-muted-foreground">
          {attempts === 0
            ? t("modelRetryOff")
            : t("modelRetryCount", { count: attempts })}
        </span>
        {/* Match AdaptiveStepper's Liquid SVG fill (--background) cleanly inside bg-card rows. */}
        <div className="inline-flex rounded-full border border-border bg-background p-0.5">
          <AdaptiveStepper
            value={attempts}
            min={0}
            max={10}
            step={1}
            disabled={pending}
            aria-label={t("modelRetryAttempts")}
            formatValueText={(count) =>
              count === 0 ? t("modelRetryOff") : t("modelRetryCount", { count })
            }
            onValueChange={save}
          >
            <AdaptiveStepperDecrement aria-label={t("decreaseRetry")} />
            <AdaptiveStepperValue />
            <AdaptiveStepperIncrement aria-label={t("increaseRetry")} />
          </AdaptiveStepper>
        </div>
      </div>
    </div>
  );
}
