"use client";

import { useActionState, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import { updateTransportSettingsAction } from "@/lib/admin/transport-settings-actions";
import {
  A2A_FILE_LIMIT_RANGES,
  DEFAULT_A2A_FILE_LIMITS,
  DEFAULT_A2A_INLINE_BYTES,
  MAX_A2A_INLINE_BYTES,
  MIN_A2A_INLINE_BYTES,
  type A2AFileLimits,
} from "@/lib/transport-policy";

const FILE_LIMIT_FIELDS = [
  { key: "a2aFileBytes", name: "a2aFileMiB", unit: 1024 ** 2 },
  { key: "a2aTaskInputBytes", name: "a2aTaskInputMiB", unit: 1024 ** 2 },
  { key: "a2aTaskFiles", name: "a2aTaskFiles", unit: 1 },
  {
    key: "a2aWorkspaceFileBytes",
    name: "a2aWorkspaceFileGiB",
    unit: 1024 ** 3,
  },
] as const;

export function TransportSettingsForm({
  allowHttp: initialAllowHttp,
  a2aInlineBytes,
  source,
  ...limits
}: A2AFileLimits & {
  allowHttp: boolean;
  a2aInlineBytes: number;
  source: "database" | "default";
}) {
  const t = useTranslations("admin");
  const [allowHttp, setAllowHttp] = useState(initialAllowHttp);
  const checkbox = useRef<HTMLInputElement>(null);
  const [state, action, pending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(updateTransportSettingsAction, {});

  return (
    <AdminPanel
      title={t("transportSettings")}
      description={t("transportSettingsDescription")}
      actions={
        <AdminBadge tone={source === "database" ? "info" : "neutral"}>
          {t(
            source === "database"
              ? "settingsSourceAdmin"
              : "settingsSourceDefault",
          )}
        </AdminBadge>
      }
    >
      <form action={action} className="space-y-5">
        <div className="space-y-2">
          <input type="hidden" name="allowHttp" value={String(allowHttp)} />
          {/* Native change events include the switch in SettingsChanges tracking. */}
          <input
            ref={checkbox}
            type="checkbox"
            hidden
            checked={allowHttp}
            disabled={pending}
            onChange={(event) => setAllowHttp(event.target.checked)}
          />
          <Switch
            checked={allowHttp}
            onCheckedChange={() => checkbox.current?.click()}
            disabled={pending}
            label={t("allowHttpDebug")}
          />
          <p className="text-sm text-muted-foreground">
            {t("allowHttpDebugDescription")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("allowHttpDebugWarning")}
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="a2a-inline-kib" className="block text-sm font-medium">
            {t("a2aInlineKiB")}
          </label>
          <Input
            id="a2a-inline-kib"
            name="a2aInlineKiB"
            type="number"
            min={MIN_A2A_INLINE_BYTES / 1024}
            max={MAX_A2A_INLINE_BYTES / 1024}
            step={1}
            required
            defaultValue={String(a2aInlineBytes / 1024)}
            disabled={pending}
            aria-describedby="a2a-inline-kib-hint"
          />
          <p id="a2a-inline-kib-hint" className="text-sm text-muted-foreground">
            {t("a2aInlineKiBHint", {
              min: MIN_A2A_INLINE_BYTES / 1024,
              max: MAX_A2A_INLINE_BYTES / 1024,
              default: DEFAULT_A2A_INLINE_BYTES / 1024,
            })}
          </p>
        </div>
        {FILE_LIMIT_FIELDS.map(({ key, name, unit }) => {
          const [min, max] = A2A_FILE_LIMIT_RANGES[key];
          return (
            <div key={key} className="space-y-1.5">
              <label htmlFor={name} className="block text-sm font-medium">
                {t(name)}
              </label>
              <Input
                id={name}
                name={name}
                type="number"
                min={min / unit}
                max={max / unit}
                step={1}
                required
                defaultValue={String(limits[key] / unit)}
                disabled={pending}
                aria-describedby={`${name}-hint`}
              />
              <p id={`${name}-hint`} className="text-sm text-muted-foreground">
                {t(`${name}Hint`, {
                  min: min / unit,
                  max: max / unit,
                  default: DEFAULT_A2A_FILE_LIMITS[key] / unit,
                })}
              </p>
            </div>
          );
        })}
        <p className="text-sm text-muted-foreground">
          {t("transportSettingsSafety")}
        </p>
        <div className="flex flex-wrap gap-2">
          <SubmitButton
            pendingLabel={t("saving")}
            savedLabel={t("saved")}
            error={state.error}
            variant="primary"
            size="md"
          >
            {t("saveChanges")}
          </SubmitButton>
          {source === "database" ? (
            <Button
              type="submit"
              name="intent"
              value="reset"
              formNoValidate
              disabled={pending}
              variant="secondary"
              size="md"
            >
              {t("restoreTransportDefaults")}
            </Button>
          ) : null}
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p aria-live="polite" className="text-sm text-accent-foreground">
            {t("transportSettingsSaved")}
          </p>
        ) : null}
      </form>
    </AdminPanel>
  );
}
