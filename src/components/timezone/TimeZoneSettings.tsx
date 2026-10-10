"use client";
import { FormSelect } from "@/components/ui/FormSelect";

import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { updateTimeZonePreference } from "@/lib/auth/timezone-actions";
import { AUTO_TIME_ZONE_VALUE, listSupportedTimeZones } from "@/lib/timezone";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { useUserTimeZone } from "./UserTimeZoneContext";

export function TimeZoneSettings({
  timeZoneOverride,
}: {
  timeZoneOverride: string | null;
}) {
  const t = useTranslations("console.settings");
  const router = useRouter();
  const { detectedTimeZone } = useUserTimeZone();
  const [state, formAction] = useActionState(updateTimeZonePreference, {});
  const refreshedSave = useRef<number | null>(null);
  const timeZones = useMemo(
    () => listSupportedTimeZones([timeZoneOverride, detectedTimeZone]),
    [detectedTimeZone, timeZoneOverride],
  );

  useEffect(() => {
    if (!state.savedAt || refreshedSave.current === state.savedAt) return;
    refreshedSave.current = state.savedAt;
    startTransition(() => router.refresh());
  }, [router, state.savedAt]);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <input
        type="hidden"
        name="detectedTimeZone"
        value={detectedTimeZone ?? ""}
      />
      <div className="min-w-0 flex-1">
        <label htmlFor="user-time-zone" className="sr-only">
          {t("timezone")}
        </label>
        <FormSelect
          key={timeZoneOverride ?? AUTO_TIME_ZONE_VALUE}
          id="user-time-zone"
          name="timeZone"
          defaultValue={timeZoneOverride ?? AUTO_TIME_ZONE_VALUE}
          label={t("timezone")}
          options={[
            {
              value: AUTO_TIME_ZONE_VALUE,
              label: detectedTimeZone
                ? t("timezoneAutomatic", { timeZone: detectedTimeZone })
                : t("timezoneDetecting"),
            },
            ...timeZones.map((timeZone) => ({
              value: timeZone,
              label: timeZone,
            })),
          ]}
        />
        {state.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t(state.error)}
          </p>
        ) : null}
      </div>
      <SubmitButton
        pendingLabel={t("savingTimezone")}
        savedLabel={t("timezoneSaved")}
        error={state.error}
        variant="primary"
        size="sm"
        className="shrink-0"
      >
        {t("saveTimezone")}
      </SubmitButton>
    </form>
  );
}
