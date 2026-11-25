"use client";

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
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/motion/combobox";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { useUserTimeZone } from "./UserTimeZoneContext";

function groupTimeZonesByRegion(timeZones: string[]) {
  const groups = new Map<string, string[]>();
  for (const timeZone of timeZones) {
    const slash = timeZone.indexOf("/");
    const region = slash === -1 ? "UTC" : timeZone.slice(0, slash);
    const bucket = groups.get(region);
    if (bucket) bucket.push(timeZone);
    else groups.set(region, [timeZone]);
  }
  return Array.from(groups, ([region, zones]) => ({ region, zones }));
}

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
  const [open, setOpen] = useState(false);
  const [trackedSaved, setTrackedSaved] = useState(savedTimeZone);
  if (trackedSaved !== savedTimeZone) {
    // Sync local selection when a new saved timezone arrives from the server.
    setTrackedSaved(savedTimeZone);
    setSelected(savedTimeZone);
  }
  const timeZones = useMemo(
    () => listSupportedTimeZones([timeZoneOverride, detectedTimeZone]),
    [detectedTimeZone, timeZoneOverride],
  );
  const regionGroups = useMemo(
    () => groupTimeZonesByRegion(timeZones),
    [timeZones],
  );
  const autoLabel = detectedTimeZone
    ? t("timezoneAutomatic", { timeZone: detectedTimeZone })
    : t("timezoneDetecting");

  useEffect(() => {
    if (!state.savedAt || refreshedSave.current === state.savedAt) return;
    refreshedSave.current = state.savedAt;
    startTransition(() => router.refresh());
  }, [router, state.savedAt]);

  return (
    <form
      action={formAction}
      onReset={() => setSelected(savedTimeZone)}
      data-unsaved-changes={selected !== savedTimeZone ? "true" : undefined}
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <input
        type="hidden"
        name="detectedTimeZone"
        value={detectedTimeZone ?? ""}
      />
      <input type="hidden" name="timeZone" value={selected} />
      <div className="min-w-0 sm:max-w-md">
        <p className="text-sm font-medium text-foreground">{t("timezone")}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {t("timezoneScheduled")}
        </p>
        {state.error ? (
          <Alert variant="destructive" className="mt-2">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>{t(state.error)}</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:w-96">
        <Combobox
          value={selected}
          onValueChange={setSelected}
          open={open}
          onOpenChange={setOpen}
          className="min-w-0 flex-1"
        >
          <ComboboxTrigger className="min-w-0 border-(--input) bg-(--field)">
            <ComboboxInput
              aria-label={t("timezone")}
              placeholder={t("timezoneSearch")}
              onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.nativeEvent.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          </ComboboxTrigger>
          <ComboboxContent className="rounded-xl">
            <ComboboxList ariaLabel={t("timezone")}>
              <ComboboxEmpty>{t("timezoneEmpty")}</ComboboxEmpty>
              <ComboboxItem
                value={AUTO_TIME_ZONE_VALUE}
                textValue={autoLabel}
                keywords={["auto", "automatic", "自动", detectedTimeZone ?? ""]}
              >
                {autoLabel}
              </ComboboxItem>
              {regionGroups.map(({ region, zones }) => (
                <ComboboxGroup key={region}>
                  <ComboboxSeparator />
                  <ComboboxLabel>{region}</ComboboxLabel>
                  {zones.map((timeZone) => (
                    <ComboboxItem key={timeZone} value={timeZone}>
                      {timeZone}
                    </ComboboxItem>
                  ))}
                </ComboboxGroup>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
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
