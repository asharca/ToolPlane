"use client";
import { FormSelect } from "@/components/ui/FormSelect";

import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  const common = useTranslations("common");
  const router = useRouter();
  const { detectedTimeZone } = useUserTimeZone();
  const [state, formAction] = useActionState(updateTimeZonePreference, {});
  const refreshedSave = useRef<number | null>(null);
  const savedTimeZone = timeZoneOverride ?? AUTO_TIME_ZONE_VALUE;
  const [selected, setSelected] = useState(savedTimeZone);
  const [trackedSaved, setTrackedSaved] = useState(savedTimeZone);
  if (trackedSaved !== savedTimeZone) {
    // The select remounts on a new saved value; mirror its reset.
    setTrackedSaved(savedTimeZone);
    setSelected(savedTimeZone);
  }
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
      onReset={() => setSelected(savedTimeZone)}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <input
        type="hidden"
        name="detectedTimeZone"
        value={detectedTimeZone ?? ""}
      />
      <div className="min-w-0 sm:max-w-md">
        <label
          htmlFor="user-time-zone"
          className="block text-sm font-medium text-foreground"
        >
          {t("timezone")}
        </label>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {t("timezoneScheduled")}
        </p>
        {state.error ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {t(state.error)}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:w-96">
        <FormSelect
          key={savedTimeZone}
          id="user-time-zone"
          name="timeZone"
          defaultValue={savedTimeZone}
          onValueChange={setSelected}
          label={t("timezone")}
          className="min-w-0 flex-1"
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
        <SubmitButton
          pendingLabel={t("savingTimezone")}
          savedLabel={t("timezoneSaved")}
          error={state.error}
          disabled={selected === savedTimeZone}
          variant="primary"
          size="md"
          className="shrink-0"
        >
          {common("save")}
        </SubmitButton>
      </div>
    </form>
  );
}
