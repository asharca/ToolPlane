"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { notify } from "@/components/dashboard/Toaster";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";
import {
  updateUserLimitDefaultsAction,
  updateUserLimitOverridesAction,
} from "@/lib/admin/user-limit-actions";
import {
  GiB,
  USER_LIMIT_RANGES,
  type UserLimits,
} from "@/lib/storage/user-limit-policy";

type Props = {
  defaults: UserLimits & { source: "database" | "default" };
  user?: {
    id: string;
    overrides: { [K in keyof UserLimits]: UserLimits[K] | null };
  };
};

export function UserLimitsSettingsForm({ defaults, user }: Props) {
  const t = useTranslations("admin");
  const baseAction = user
    ? updateUserLimitOverridesAction
    : updateUserLimitDefaultsAction;
  const [state, action, pending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(async (prev, form) => {
    const result = await baseAction(prev, form);
    if (result.error) notify(result.error, { severity: "error" });
    else if (result.ok) notify(t("saved"));
    return result;
  }, {});
  const values = user ? user.overrides : defaults;
  return (
    <AdminPanel
      title={t(user ? "userLimitOverrides" : "userLimitDefaults")}
      description={user ? t("userLimitInherit") : undefined}
      actions={
        !user && (
          <AdminBadge
            tone={defaults.source === "database" ? "info" : "neutral"}
          >
            {t(
              defaults.source === "database"
                ? "settingsSourceAdmin"
                : "settingsSourceDefault",
            )}
          </AdminBadge>
        )
      }
    >
      <form action={action} className="space-y-5">
        {user && <input type="hidden" name="userId" value={user.id} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="storageQuotaGiB"
            label={t("userStorageQuotaGiB")}
            type="number"
            min={USER_LIMIT_RANGES.storageQuotaBytes[0] / GiB}
            max={USER_LIMIT_RANGES.storageQuotaBytes[1] / GiB}
            step={1}
            required={!user}
            disabled={pending}
            defaultValue={
              values.storageQuotaBytes === null
                ? ""
                : String(values.storageQuotaBytes / GiB)
            }
            placeholder={
              user ? String(defaults.storageQuotaBytes / GiB) : undefined
            }
          />
          <Input
            name="maxOwnedWorkspaces"
            label={t("userWorkspaceLimit")}
            type="number"
            min={USER_LIMIT_RANGES.maxOwnedWorkspaces[0]}
            max={USER_LIMIT_RANGES.maxOwnedWorkspaces[1]}
            step={1}
            required={!user}
            disabled={pending}
            defaultValue={String(values.maxOwnedWorkspaces ?? "")}
            placeholder={user ? String(defaults.maxOwnedWorkspaces) : undefined}
          />
        </div>
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
          {!user && defaults.source === "database" && (
            <Button
              type="submit"
              name="intent"
              value="reset"
              formNoValidate
              disabled={pending}
              variant="secondary"
              size="md"
            >
              {t("restoreUserLimitDefaults")}
            </Button>
          )}
        </div>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </form>
    </AdminPanel>
  );
}
