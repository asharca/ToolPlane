"use client";

import type { Dispatch, SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { DialogField } from "../dialog";
import { SettingsSection } from "./SettingsSection";

export type FallbackModelRow = { id: string; selection: ModelSelection };
export type AgentRoleModels = NonNullable<AgentRevisionConfig["roleModels"]>;
type ModelRole = "compaction" | "title";

/** Fallback order and per-role models, reviewed with the next revision. */
export function AgentModelRoutingSettings({
  hidden,
  pending,
  providers,
  modelProviders,
  fallbackModels,
  setFallbackModels,
  fallbackModelsDirty,
  roleModels,
  setRoleModels,
  roleModelDirty,
  onChange,
}: {
  hidden: boolean;
  pending: boolean;
  /** Every provider, for naming a stored selection. */
  providers: ReadonlyArray<{ id: string; name: string }>;
  /** Providers and models this runtime can use. */
  modelProviders: ModelProviderOption[];
  fallbackModels: FallbackModelRow[];
  setFallbackModels: Dispatch<SetStateAction<FallbackModelRow[]>>;
  fallbackModelsDirty: boolean;
  roleModels: AgentRoleModels;
  setRoleModels: Dispatch<SetStateAction<AgentRoleModels>>;
  roleModelDirty: (role: ModelRole) => boolean;
  onChange: () => void;
}) {
  const t = useTranslations("console.agents");
  function modelPicker(
    selection: ModelSelection | null,
    label: string,
    onSelect: (selection: ModelSelection) => void,
    placeholder = label,
  ) {
    const available =
      selection &&
      modelProviders.some(
        (item) =>
          item.id === selection.providerId &&
          item.models.includes(selection.model),
      );
    return (
      <ModelPicker
        className="flex w-72 max-w-full"
        providers={modelProviders}
        value={available ? selection : null}
        pending={pending}
        onSelect={(next) => {
          if (pending) return;
          onSelect(next);
          onChange();
        }}
        trigger={
          <ModelPickerTrigger
            label={selection?.model ?? placeholder}
            provider={
              selection
                ? (providers.find((item) => item.id === selection.providerId)
                    ?.name ?? selection.providerId)
                : undefined
            }
            placeholder={!selection}
            disabled={pending}
            aria-label={label}
          />
        }
      />
    );
  }
  return (
    <SettingsSection
      id="advanced"
      title={t("modelRoutingSection")}
      className="space-y-4"
      hidden={hidden}
    >
      <DialogField
        label={t("modelRouting.fallbackModels")}
        dirty={fallbackModelsDirty}
        layout="row"
      >
        <div className="flex flex-col items-end gap-2">
          <ol className="space-y-2">
            {fallbackModels.map((item, index) => (
              <li
                key={item.id}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span
                  className="w-4 text-xs tabular-nums text-muted-foreground"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                {modelPicker(
                  item.selection,
                  t("modelRouting.fallbackPosition", {
                    position: index + 1,
                  }),
                  (next) =>
                    setFallbackModels((current) =>
                      current.map((entry) =>
                        entry.id === item.id
                          ? { ...entry, selection: next }
                          : entry,
                      ),
                    ),
                )}
                <div className="flex shrink-0 items-center">
                  {([-1, 1] as const).map((direction) => (
                    <Button
                      key={direction}
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={
                        pending ||
                        index + direction < 0 ||
                        index + direction >= fallbackModels.length
                      }
                      aria-label={t(
                        direction < 0
                          ? "modelRouting.moveUp"
                          : "modelRouting.moveDown",
                        { position: index + 1 },
                      )}
                      onClick={() => {
                        setFallbackModels((current) => {
                          const next = [...current];
                          [next[index], next[index + direction]] = [
                            next[index + direction],
                            next[index],
                          ];
                          return next;
                        });
                        onChange();
                      }}
                    >
                      {direction < 0 ? (
                        <ArrowUp className="size-4" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={pending}
                    aria-label={t("modelRouting.removeFallback", {
                      position: index + 1,
                    })}
                    onClick={() => {
                      setFallbackModels((current) =>
                        current.filter((_, position) => position !== index),
                      );
                      onChange();
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          {fallbackModels.length < 3
            ? modelPicker(null, t("modelRouting.addFallback"), (selection) => {
                const item = { id: crypto.randomUUID(), selection };
                setFallbackModels((current) =>
                  current.length < 3 ? [...current, item] : current,
                );
              })
            : null}
        </div>
      </DialogField>
      {(["compaction", "title"] as const).map((role) => (
        <DialogField
          key={role}
          label={t(`modelRouting.${role}`)}
          dirty={roleModelDirty(role)}
          layout="row"
        >
          <div className="flex min-w-0 items-center gap-1">
            {modelPicker(
              roleModels[role] ?? null,
              t(`modelRouting.${role}`),
              (next) =>
                setRoleModels((current) => ({
                  ...current,
                  [role]: next,
                })),
              t("modelRouting.usePrimary"),
            )}
            {roleModels[role] ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={pending}
                aria-label={t("modelRouting.clearRole", {
                  role: t(`modelRouting.${role}`),
                })}
                onClick={() => {
                  setRoleModels((current) => {
                    const next = { ...current };
                    delete next[role];
                    return next;
                  });
                  onChange();
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </DialogField>
      ))}
    </SettingsSection>
  );
}
