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
import {
  DialogCancel,
  DialogField,
  DialogFooter,
} from "@/components/dashboard/dialog";
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
      className="space-y-3"
    >
      <input
        type="hidden"
        name="detectedTimeZone"
        value={detectedTimeZone ?? ""}
      />
      <div className="min-w-0">
        <DialogField
          label={t("timezone")}
          htmlFor="user-time-zone"
          dirty={selected !== savedTimeZone}
        >
          <FormSelect
            key={savedTimeZone}
            id="user-time-zone"
            name="timeZone"
            defaultValue={savedTimeZone}
            onValueChange={setSelected}
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
        </DialogField>
        {state.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t(state.error)}
          </p>
        ) : null}
      </div>
      <DialogFooter
        cancel={<DialogCancel />}
        className="static -mx-5 -mb-4 mt-5 bg-transparent px-5"
      >
        <SubmitButton
          pendingLabel={t("savingTimezone")}
          savedLabel={t("timezoneSaved")}
          error={state.error}
          variant="primary"
          size="md"
        >
          {t("saveTimezone")}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
