"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";

export type { ModelSelection, ModelProviderOption };

/** Composer-local choice only: never writes an Agent or Assistant configuration. */
export function ComposerModelSelect({
  providers,
  defaultSelection,
  value,
  onChange,
}: {
  providers: ModelProviderOption[];
  defaultSelection: ModelSelection | null;
  value: ModelSelection | null;
  onChange: (value: ModelSelection | null) => void;
}) {
  const t = useTranslations("console.composerModel");
  const selection = value ?? defaultSelection;
  const overridden = Boolean(
    value &&
      (value.providerId !== defaultSelection?.providerId ||
        value.model !== defaultSelection?.model),
  );
  const provider = providers.find((item) => item.id === selection?.providerId);
  const label = selection
    ? `${provider?.name ?? ""}${provider ? " · " : ""}${selection.model}`
    : t("choose");
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelPicker
        providers={providers}
        value={selection}
        onSelect={onChange}
        size="sm"
        trigger={
          <ModelPickerTrigger
            layout="compact"
            label={label}
            aria-label={selection ? `${t("choose")}: ${label}` : t("choose")}
            icon={
              overridden ? (
                <span className="size-1.5 rounded-full bg-primary" />
              ) : undefined
            }
            note={!overridden && defaultSelection ? t("default") : undefined}
          />
        }
      />
      {overridden && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          title={t("reset")}
          aria-label={t("reset")}
          onClick={() => onChange(null)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
