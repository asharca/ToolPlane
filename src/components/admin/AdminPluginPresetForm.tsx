"use client";

import { useActionState, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { notify } from "@/components/dashboard/Toaster";
import {
  clearOfficialPluginEnvPresetAction,
  saveOfficialPluginEnvPresetAction,
  type AdminPluginPresetActionState,
} from "@/lib/admin/plugin-actions";
import {
  envValueKind,
  isEnvRequired,
  isEnvSecret,
  type PluginEnvStatus,
} from "@/lib/plugins/env-schema";
import { AdminBadge } from "./AdminUI";

const fieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono";

export function AdminPluginPresetForm({
  listingId,
  status,
  nonSecretValues: initialNonSecretValues,
}: {
  listingId: string;
  status: PluginEnvStatus;
  nonSecretValues: Record<string, string>;
}) {
  const t = useTranslations("admin");
  const fieldId = useId();
  const router = useRouter();

  const [nonSecretValues, setNonSecretValues] = useState<
    Record<string, string>
  >(() => ({ ...initialNonSecretValues }));
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [clearKeys, setClearKeys] = useState<string[]>([]);

  const [, saveAction, savePending] = useActionState<
    AdminPluginPresetActionState,
    FormData
  >(async (prev, form) => {
    const result = await saveOfficialPluginEnvPresetAction(prev, form);
    if (result.success) {
      setSecretValues({});
      setClearKeys([]);
      notify(t("pluginPresetSaved"));
      router.refresh();
    } else {
      notify(t("pluginPresetError"), { severity: "error" });
    }
    return result;
  }, {});

  const [, clearAction, clearPending] = useActionState<
    AdminPluginPresetActionState,
    FormData
  >(async (prev, form) => {
    const result = await clearOfficialPluginEnvPresetAction(prev, form);
    if (result.success) {
      setNonSecretValues({});
      setSecretValues({});
      setClearKeys([]);
      notify(t("pluginPresetCleared"));
      router.refresh();
    } else {
      notify(t("pluginPresetError"), { severity: "error" });
    }
    return result;
  }, {});

  const pending = savePending || clearPending;
  const configuredSet = new Set(status.presetConfiguredKeys);

  const payloadValues: Record<string, string> = {};
  for (const item of status.requirements) {
    if (clearKeys.includes(item.name)) continue;
    if (isEnvSecret(item)) {
      const value = secretValues[item.name] ?? "";
      if (value.trim()) payloadValues[item.name] = value;
    } else {
      payloadValues[item.name] = nonSecretValues[item.name] ?? "";
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("pluginPresetTitle")}</span>
        <AdminBadge tone={status.presetComplete ? "success" : "warning"}>
          {t(
            status.presetComplete
              ? "pluginPresetReady"
              : "pluginPresetIncomplete",
          )}
        </AdminBadge>
      </div>
      {!status.presetComplete && status.presetMissingRequiredKeys.length ? (
        <p className="text-xs text-destructive">
          {t("pluginPresetMissing", {
            keys: status.presetMissingRequiredKeys.join(", "),
          })}
        </p>
      ) : null}
      <form action={saveAction} className="space-y-3">
        <input type="hidden" name="listingId" value={listingId} />
        <input
          type="hidden"
          name="values"
          value={JSON.stringify(payloadValues)}
        />
        <input
          type="hidden"
          name="clearKeys"
          value={JSON.stringify(clearKeys)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {status.requirements.map((item) => {
            const secret = isEnvSecret(item);
            const required = isEnvRequired(item);
            const configured = configuredSet.has(item.name);
            const markedClear = clearKeys.includes(item.name);
            const defaultUpstreamUrl = status.httpProxies.find(
              (proxy) => proxy.baseUrlEnv === item.name,
            )?.defaultUpstreamUrl;
            const inputId = `${fieldId}-${item.name}`;

            return (
              <div key={item.name} className="grid gap-1 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={inputId}
                    className="font-mono text-xs font-medium"
                  >
                    {item.name}
                    <span className="ml-1.5 font-sans font-normal text-muted-foreground">
                      ·{" "}
                      {t(
                        required
                          ? "pluginPresetRequired"
                          : "pluginPresetOptional",
                      )}
                    </span>
                  </label>
                  {configured && !markedClear ? (
                    <span className="text-xs text-muted-foreground">
                      {t("pluginPresetConfigured")}
                    </span>
                  ) : null}
                </div>
                {secret ? (
                  <input
                    id={inputId}
                    type="password"
                    autoComplete="new-password"
                    className={fieldClass}
                    disabled={pending || markedClear}
                    value={secretValues[item.name] ?? ""}
                    placeholder={
                      configured ? t("pluginPresetSecretPlaceholder") : ""
                    }
                    onChange={(event) => {
                      const val = event.target.value;
                      setSecretValues((prev) => ({
                        ...prev,
                        [item.name]: val,
                      }));
                    }}
                  />
                ) : (
                  <input
                    id={inputId}
                    type={envValueKind(item) === "url" ? "url" : "text"}
                    className={fieldClass}
                    disabled={pending || markedClear}
                    value={nonSecretValues[item.name] ?? ""}
                    placeholder={defaultUpstreamUrl ?? ""}
                    onChange={(event) => {
                      const val = event.target.value;
                      setNonSecretValues((prev) => ({
                        ...prev,
                        [item.name]: val,
                      }));
                    }}
                  />
                )}
                {item.description ? (
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                ) : null}
                {configured ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={markedClear}
                      disabled={pending}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setClearKeys((prev) =>
                          checked
                            ? [...prev, item.name]
                            : prev.filter((k) => k !== item.name),
                        );
                      }}
                    />
                    {t("pluginPresetClearKey")}
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {t("pluginPresetSave")}
          </Button>
        </div>
      </form>
      {status.presetConfiguredKeys.length ? (
        <form action={clearAction}>
          <input type="hidden" name="listingId" value={listingId} />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={pending}
          >
            {t("pluginPresetClear")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
