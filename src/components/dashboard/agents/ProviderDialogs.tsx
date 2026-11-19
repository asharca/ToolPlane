"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Cpu, KeyRound, Link2, Pencil, Plus, Save, Search } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Tooltip } from "@/components/motion/tooltip";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  createProviderAction,
  updateProviderAction,
  type ActionState,
} from "@/lib/agents/actions";
import type { ProviderRow } from "./ProvidersPanel";

export type ProviderPreset = { format: string; name: string; baseUrl: string };

const customProviderPresets: ProviderPreset[] = [
  { format: "openai", name: "OpenAI-compatible", baseUrl: "" },
  {
    format: "openai-responses",
    name: "OpenAI Responses-compatible",
    baseUrl: "",
  },
  { format: "anthropic", name: "Anthropic-compatible", baseUrl: "" },
];

export function providerEndpoint(
  provider: ProviderRow,
  presets: ProviderPreset[],
  fallback: string,
) {
  return (
    provider.baseUrl ||
    presets.find((preset) => preset.format === provider.format)?.baseUrl ||
    fallback
  );
}

export function ActionMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p className="mt-2 text-sm text-destructive" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.warning) {
    return (
      <p
        className="mt-2 text-sm text-muted-foreground text-muted-foreground"
        role="alert"
      >
        {state.warning}
      </p>
    );
  }
  return null;
}

export function ProviderDialog({
  open,
  onOpenChange,
  trigger,
  title,
  labelledTrigger = false,
  maxWidth = "max-w-xl",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  /** Render the trigger without a tooltip. */
  labelledTrigger?: boolean;
  maxWidth?: "max-w-xl" | "max-w-2xl" | "max-w-3xl";
  children: ReactNode;
}) {
  const t = useTranslations("console.agents");
  const triggerElement = (
    <CenterMorphModalTrigger>{trigger}</CenterMorphModalTrigger>
  );

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      {labelledTrigger ? (
        triggerElement
      ) : (
        <Tooltip content={title}>{triggerElement}</Tooltip>
      )}
      <CenterMorphModalContent
        ariaLabel={title}
        closeButtonLabel={t("close")}
        className={`flex max-h-[calc(100dvh-4rem)] w-full flex-col ${maxWidth}`}
      >
        <DialogHeader title={title} className="border-b border-border" />
        {children}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

export function providerFormatLabel(
  format: string,
  piProviderPresets: ProviderPreset[],
) {
  return (
    [...piProviderPresets, ...customProviderPresets].find(
      (preset) => preset.format === format,
    )?.name ?? format
  );
}

function providerFormatOptions(piProviderPresets: ProviderPreset[]) {
  return [...piProviderPresets, ...customProviderPresets].map((preset) => ({
    value: preset.format,
    label: preset.name,
  }));
}

export function AddProviderDialog({
  slug,
  piProviderPresets,
  onCreated,
  iconTrigger = false,
}: {
  slug: string;
  piProviderPresets: ProviderPreset[];
  onCreated: (providerId: string) => void;
  /** Compact icon trigger for the provider list; the empty state keeps the labelled button. */
  iconTrigger?: boolean;
}) {
  const commonPresets = [
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "openrouter",
  ].flatMap((id) =>
    piProviderPresets.filter((preset) => preset.format === `pi:${id}`),
  );
  const otherPresets = piProviderPresets
    .filter((preset) => !commonPresets.includes(preset))
    .sort((a, b) => a.name.localeCompare(b.name));
  const initialPreset = commonPresets[0] ?? customProviderPresets[0];
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const processedProviderId = useRef<string | null>(null);
  const [format, setFormat] = useState(initialPreset.format);
  const [name, setName] = useState(initialPreset.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [query, setQuery] = useState("");
  const selectedPreset = [...piProviderPresets, ...customProviderPresets].find(
    (preset) => preset.format === format,
  );
  const isCustomProvider = !format.startsWith("pi:");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const presetGroups = [
    { label: t("commonProviders"), presets: commonPresets },
    { label: t("compatibleProviders"), presets: customProviderPresets },
    { label: t("otherProviders"), presets: otherPresets },
  ]
    .map((group) => ({
      ...group,
      presets: normalizedQuery
        ? group.presets.filter((preset) =>
            [preset.name, preset.format, preset.baseUrl].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            ),
          )
        : group.presets,
    }))
    .filter((group) => group.presets.length > 0);
  const [state, formAction] = useActionState<ActionState, FormData>(
    createProviderAction,
    {},
  );
  const [apiKey, setApiKey] = useState("");
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  useEffect(() => {
    void state; // Every result, including failure, clears the secret.
    setApiKey("");
  }, [state]);
  useEffect(() => {
    if (!state.providerId || processedProviderId.current === state.providerId)
      return;
    processedProviderId.current = state.providerId;
    onCreated(state.providerId);
  }, [state.providerId, onCreated]);

  function selectPreset(preset: ProviderPreset) {
    // Keep a name the user typed; replace only the untouched preset name.
    if (!name.trim() || name === selectedPreset?.name) setName(preset.name);
    setFormat(preset.format);
    setBaseUrl("");
  }

  const fieldId = useId();

  return (
    <ProviderDialog
      open={open && (!state.savedAt || state.savedAt === savedAtWhenOpened)}
      onOpenChange={(next) => {
        if (next) {
          // A provider was created since the last opening: start a fresh form.
          if (state.savedAt && state.savedAt !== savedAtWhenOpened) {
            setFormat(initialPreset.format);
            setName(initialPreset.name);
            setBaseUrl("");
            setQuery("");
          }
          setSavedAtWhenOpened(state.savedAt);
        } else setApiKey("");
        setOpen(next);
      }}
      title={t("addModelProvider")}
      maxWidth="max-w-3xl"
      labelledTrigger={!iconTrigger}
      trigger={
        iconTrigger ? (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={t("addModelProvider")}
          >
            <Plus aria-hidden="true" className="size-4" />
          </Button>
        ) : (
          <Button variant="primary" size="md" type="button">
            <Plus aria-hidden="true" className="size-4" />
            {t("addProvider")}
          </Button>
        )
      }
    >
      <form
        action={formAction}
        className="flex min-h-0 flex-1 flex-col md:h-[30rem] md:flex-none md:flex-row"
      >
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="format" value={format} />
        <div className="flex max-h-56 shrink-0 flex-col border-b border-border md:max-h-none md:w-56 md:border-b-0 md:border-r">
          <div className="p-3 pb-1">
            <Input
              leftIcon={<Search />}
              aria-label={`${common("search")} ${t("format")}`}
              placeholder={common("search")}
              value={query}
              onChange={setQuery}
              className="w-full"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {presetGroups.length > 0 ? (
              presetGroups.map((group) => (
                <fieldset
                  key={group.label}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <legend className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </legend>
                  <div className="space-y-1">
                    {group.presets.map((preset) => {
                      const selected = preset.format === format;
                      return (
                        <Button
                          key={preset.format}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => selectPreset(preset)}
                          variant="ghost"
                          size="md"
                          className={`h-9 w-full justify-start rounded-lg px-3 text-left text-sm ${selected ? "bg-muted font-medium text-foreground" : "font-normal"}`}
                        >
                          <span className="min-w-0 truncate">
                            {preset.name}
                          </span>
                          {selected && format !== initialPreset.format ? (
                            <span
                              className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                              role="img"
                              aria-label={common("modified")}
                            />
                          ) : null}
                        </Button>
                      );
                    })}
                  </div>
                </fieldset>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {common("noResults")}
              </p>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DialogBody>
            <DialogField
              label={t("name")}
              htmlFor={`${fieldId}-name`}
              dirty={name !== initialPreset.name}
            >
              <Input
                id={`${fieldId}-name`}
                leftIcon={<Cpu />}
                name="name"
                required
                value={name}
                onChange={setName}
                className="w-full"
              />
            </DialogField>
            {/* The placeholder shows the endpoint used when this stays blank. */}
            <DialogField
              label={t("baseUrl")}
              htmlFor={`${fieldId}-baseUrl`}
              dirty={baseUrl !== ""}
            >
              <Input
                id={`${fieldId}-baseUrl`}
                leftIcon={<Link2 />}
                name="baseUrl"
                required={isCustomProvider}
                placeholder={
                  isCustomProvider
                    ? "https://api.example.com/v1"
                    : selectedPreset?.baseUrl
                }
                value={baseUrl}
                onChange={setBaseUrl}
                className="w-full"
              />
            </DialogField>
            <DialogField
              label={t("apiKey")}
              htmlFor={`${fieldId}-apiKey`}
              dirty={apiKey !== ""}
            >
              <Input
                id={`${fieldId}-apiKey`}
                leftIcon={<KeyRound />}
                name="apiKey"
                type="password"
                autoComplete="off"
                required={isCustomProvider}
                value={apiKey}
                onChange={setApiKey}
                className="w-full"
              />
            </DialogField>
            <ActionMessage state={state} />
          </DialogBody>
          <DialogFooter cancel={<DialogCancel />}>
            <SubmitButton
              error={state.error}
              pendingLabel={t("adding")}
              savedLabel={t("added")}
              variant="primary"
              size="md"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("add")}
            </SubmitButton>
          </DialogFooter>
        </div>
      </form>
    </ProviderDialog>
  );
}

export function EditProviderDialog({
  slug,
  provider,
  piProviderPresets,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const [format, setFormat] = useState(provider.format);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [name, setName] = useState(provider.name);
  const fieldId = useId();
  const selectedPreset = piProviderPresets.find(
    (preset) => preset.format === format,
  );
  const isCustomProvider = !format.startsWith("pi:");
  const [updateState, updateAction] = useActionState<ActionState, FormData>(
    updateProviderAction,
    {},
  );
  const [apiKey, setApiKey] = useState("");
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  useEffect(() => {
    void updateState; // Every result, including failure, clears the secret.
    setApiKey("");
  }, [updateState]);

  return (
    <ProviderDialog
      // Close after a clean save; keep a refresh warning visible.
      open={
        open &&
        (updateState.savedAt === savedAtWhenOpened ||
          Boolean(updateState.warning))
      }
      onOpenChange={(next) => {
        if (next) {
          // Discard edits abandoned in a previous opening.
          setFormat(provider.format);
          setBaseUrl(provider.baseUrl);
          setName(provider.name);
          setSavedAtWhenOpened(updateState.savedAt);
        } else setApiKey("");
        setOpen(next);
      }}
      title={t("editProvider")}
      maxWidth="max-w-2xl"
      labelledTrigger
      trigger={
        <Button
          size="icon"
          variant="ghost"
          type="button"
          aria-label={t("editProvider")}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Button>
      }
    >
      <form action={updateAction} className="flex min-h-0 flex-1 flex-col">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="providerId" value={provider.id} />
        <DialogBody>
          <div className="grid gap-5 sm:grid-cols-2">
            <DialogField
              label={t("name")}
              htmlFor={`${fieldId}-name`}
              dirty={name !== provider.name}
            >
              <Input
                id={`${fieldId}-name`}
                leftIcon={<Cpu />}
                name="name"
                required
                defaultValue={String(provider.name)}
                onChange={setName}
                className="w-full"
              />
            </DialogField>
            <DialogField label={t("format")} dirty={format !== provider.format}>
              <FormSelect
                name="format"
                value={format}
                label={t("format")}
                options={providerFormatOptions(piProviderPresets)}
                onValueChange={(value) => {
                  setFormat(value);
                  setBaseUrl("");
                }}
                className="w-full"
              />
            </DialogField>
          </div>
          <DialogField
            label={t("baseUrl")}
            htmlFor={`${fieldId}-baseUrl`}
            dirty={baseUrl !== provider.baseUrl}
            description={
              !isCustomProvider && selectedPreset?.baseUrl
                ? t("leaveBlankToUseDefaultEndpoint", {
                    endpoint: selectedPreset.baseUrl,
                  })
                : undefined
            }
          >
            <Input
              id={`${fieldId}-baseUrl`}
              leftIcon={<Link2 />}
              name="baseUrl"
              required={isCustomProvider}
              placeholder={
                isCustomProvider
                  ? "https://api.example.com/v1"
                  : selectedPreset?.baseUrl
              }
              value={String(baseUrl)}
              onChange={(value) => setBaseUrl(value)}
              className="w-full"
            />
          </DialogField>
          <DialogField
            label={t("apiKey")}
            htmlFor={`${fieldId}-apiKey`}
            dirty={apiKey !== ""}
          >
            <Input
              id={`${fieldId}-apiKey`}
              leftIcon={<KeyRound />}
              name="apiKey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={setApiKey}
              placeholder={t("leaveBlankToKeepCurrentKey")}
              className="w-full"
            />
          </DialogField>
          <ActionMessage state={updateState} />
        </DialogBody>
        <DialogFooter cancel={<DialogCancel />}>
          <SubmitButton
            error={updateState.error}
            pendingLabel={t("saving")}
            savedLabel={t("saved")}
            variant="primary"
            size="md"
          >
            <Save aria-hidden="true" className="size-4" />
            {t("saveChanges")}
          </SubmitButton>
        </DialogFooter>
      </form>
    </ProviderDialog>
  );
}
