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

const [minTaskFiles, maxTaskFiles] = A2A_FILE_LIMIT_RANGES.a2aTaskFiles;

export function TransportSettingsForm({
  allowHttp: initialAllowHttp,
  a2aInlineBytes,
  source,
  a2aTaskFiles,
}: Pick<A2AFileLimits, "a2aTaskFiles"> & {
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
        <div className="space-y-1.5">
          <Input
            name="a2aTaskFiles"
            label={t("a2aTaskFiles")}
            type="number"
            min={minTaskFiles}
            max={maxTaskFiles}
            step={1}
            required
            defaultValue={String(a2aTaskFiles)}
            disabled={pending}
            aria-describedby="a2a-task-files-hint"
          />
          <p id="a2a-task-files-hint" className="text-sm text-muted-foreground">
            {t("a2aTaskFilesHint", {
              min: minTaskFiles,
              max: maxTaskFiles,
              default: DEFAULT_A2A_FILE_LIMITS.a2aTaskFiles,
            })}
          </p>
        </div>
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
