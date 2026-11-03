"use client";
import { DashboardEmptyState } from "@/components/dashboard/DashboardUI";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
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

import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useActionState,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  ArrowUpDown,
  AudioLines,
  Boxes,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  Eye,
  FlaskConical,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Type,
  Video,
  Wrench,
} from "lucide-react";
import {
  addProviderModelAction,
  createProviderAction,
  deleteProviderModelAction,
  deleteProviderAction,
  testProviderModelAction,
  updateProviderModelAction,
  updateProviderAction,
  type ActionState,
} from "@/lib/agents/actions";
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_PRIMARY_TYPES,
  defaultProviderModel,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ProviderModelAutofill } from "@/components/dashboard/agents/ProviderModelAutofill";

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
  models: string[];
  modelRecords?: Array<
    Omit<
      ProviderModelRow,
      "primaryType" | "capabilities" | "inputModalities"
    > & {
      primaryType: string;
      capabilities: string[];
      inputModalities: string[];
    }
  >;
  modelsFetchedAt: string | null;
};

export type ProviderModelRow = ProviderModelValues & { source: string };

type ProviderPreset = { format: string; name: string; baseUrl: string };

const customProviderPresets: ProviderPreset[] = [
  { format: "openai", name: "OpenAI-compatible", baseUrl: "" },
  {
    format: "openai-responses",
    name: "OpenAI Responses-compatible",
    baseUrl: "",
  },
  { format: "anthropic", name: "Anthropic-compatible", baseUrl: "" },
];

function providerEndpoint(
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

function ActionMessage({ state }: { state: ActionState }) {
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

function ProviderDialog({
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

function ModelTypeIcon({ type }: { type: ModelPrimaryType }) {
  if (type === "image") return <ImageIcon className="size-3.5" />;
  if (type === "embedding") return <Boxes className="size-3.5" />;
  if (type === "rerank") return <ArrowUpDown className="size-3.5" />;
  return <Type className="size-3.5" />;
}

function ModelOptionButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      variant="outline"
      size="sm"
      className={
        pressed
          ? "border-primary/60 bg-primary/10 text-foreground hover:bg-primary/15"
          : "text-muted-foreground"
      }
    >
      {children}
    </Button>
  );
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function ModelClassificationControls({
  initial,
  primaryType,
  capabilities,
  inputModalities,
  onPrimaryTypeChange,
  onCapabilitiesChange,
  onInputModalitiesChange,
}: {
  initial: Pick<
    ProviderModelValues,
    "primaryType" | "capabilities" | "inputModalities"
  >;
  primaryType: ModelPrimaryType;
  capabilities: ModelCapability[];
  inputModalities: ModelInputModality[];
  onPrimaryTypeChange: (value: ModelPrimaryType) => void;
  onCapabilitiesChange: (value: ModelCapability[]) => void;
  onInputModalitiesChange: (value: ModelInputModality[]) => void;
}) {
  const t = useTranslations("console.agents");
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  };
  const toggleCapability = (capability: ModelCapability) =>
    onCapabilitiesChange(
      capabilities.includes(capability)
        ? capabilities.filter((value) => value !== capability)
        : [...capabilities, capability],
    );
  const toggleModality = (modality: ModelInputModality) =>
    onInputModalitiesChange(
      inputModalities.includes(modality)
        ? inputModalities.filter((value) => value !== modality)
        : [...inputModalities, modality],
    );

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <DialogField
        label={t("modelType")}
        dirty={primaryType !== initial.primaryType}
        className="sm:col-span-2"
      >
        <fieldset aria-label={t("modelType")} className="flex flex-wrap gap-2">
          {(Object.keys(typeLabels) as ModelPrimaryType[]).map((type) => (
            <ModelOptionButton
              key={type}
              pressed={primaryType === type}
              onClick={() => onPrimaryTypeChange(type)}
            >
              <ModelTypeIcon type={type} />
              {typeLabels[type]}
            </ModelOptionButton>
          ))}
        </fieldset>
      </DialogField>
      <DialogField
        label={t("modelCapabilities")}
        dirty={!sameSet(capabilities, initial.capabilities)}
      >
        <fieldset
          aria-label={t("modelCapabilities")}
          className="flex flex-wrap gap-2"
        >
          <ModelOptionButton
            pressed={capabilities.includes("reasoning")}
            onClick={() => toggleCapability("reasoning")}
          >
            <BrainCircuit className="size-3.5" />
            {t("capabilityReasoning")}
          </ModelOptionButton>
          <ModelOptionButton
            pressed={capabilities.includes("function_calling")}
            onClick={() => toggleCapability("function_calling")}
          >
            <Wrench className="size-3.5" />
            {t("capabilityTools")}
          </ModelOptionButton>
        </fieldset>
      </DialogField>
      <DialogField
        label={t("inputModalities")}
        dirty={!sameSet(inputModalities, initial.inputModalities)}
      >
        <fieldset
          aria-label={t("inputModalities")}
          className="flex flex-wrap gap-2"
        >
          <ModelOptionButton
            pressed={inputModalities.includes("image")}
            onClick={() => toggleModality("image")}
          >
            <Eye className="size-3.5" />
            {t("modalityVision")}
          </ModelOptionButton>
          <ModelOptionButton
            pressed={inputModalities.includes("audio")}
            onClick={() => toggleModality("audio")}
          >
            <AudioLines className="size-3.5" />
            {t("modalityAudio")}
          </ModelOptionButton>
          <ModelOptionButton
            pressed={inputModalities.includes("video")}
            onClick={() => toggleModality("video")}
          >
            <Video className="size-3.5" />
            {t("modalityVideo")}
          </ModelOptionButton>
        </fieldset>
      </DialogField>
      {capabilities.map((capability) => (
        <input
          key={capability}
          type="hidden"
          name="capabilities"
          value={capability}
        />
      ))}
      {inputModalities.map((modality) => (
        <input
          key={modality}
          type="hidden"
          name="inputModalities"
          value={modality}
        />
      ))}
      <input type="hidden" name="primaryType" value={primaryType} />
    </div>
  );
}

function ModelLimits({
  initial,
  model,
  onChange,
}: {
  initial: ProviderModelValues;
  model: ProviderModelValues;
  onChange: (
    values: Partial<
      Pick<
        ProviderModelValues,
        "contextWindow" | "maxInputTokens" | "maxOutputTokens"
      >
    >,
  ) => void;
}) {
  const t = useTranslations("console.agents");
  const id = useId();
  const fields = [
    ["contextWindow", "128000"],
    ["maxInputTokens", "128000"],
    ["maxOutputTokens", "65536"],
  ] as const;
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      {fields.map(([field, placeholder]) => (
        <DialogField
          key={field}
          label={t(field)}
          htmlFor={`${id}-${field}`}
          dirty={model[field] !== initial[field]}
        >
          <Input
            id={`${id}-${field}`}
            name={field}
            type="number"
            min="1"
            max="100000000"
            placeholder={placeholder}
            value={String(model[field] ?? "")}
            onChange={(value) =>
              onChange({ [field]: value ? Number(value) : null })
            }
            className="w-full"
          />
        </DialogField>
      ))}
    </div>
  );
}

function ModelPrices({
  initial,
  model,
  onChange,
}: {
  initial: ProviderModelValues;
  model: ProviderModelValues;
  onChange: (values: Pick<ProviderModelValues, "cost">) => void;
}) {
  const t = useTranslations("console.agents");
  const numbers = new Intl.NumberFormat(useLocale());
  const id = useId();
  const fields = [
    ["input", "catalogInputPrice"],
    ["output", "catalogOutputPrice"],
    ["cacheRead", "catalogCacheReadPrice"],
    ["cacheWrite", "catalogCacheWritePrice"],
  ] as const;
  const base: NonNullable<ProviderModelValues["cost"]> = model.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const hasTiers = (model.cost?.tiers?.length ?? 0) > 0;
  return (
    <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
      <legend className="mb-3 text-sm font-medium text-foreground">
        {t("modelPricing")}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {t("catalogPriceUnit")}
        </span>
      </legend>
      {[
        { rates: model.cost, label: t("catalogBasePrice"), index: -1 },
        ...(model.cost?.tiers ?? []).map((rates, index) => ({
          rates,
          label: t("catalogTierAbove", {
            tokens: numbers.format(rates.inputTokensAbove),
          }),
          index,
        })),
      ].map(({ rates, label, index }) => (
        <fieldset
          key={index}
          aria-label={label}
          className={
            index < 0
              ? "m-0 min-w-0 space-y-3 border-0 p-0"
              : "m-0 min-w-0 space-y-3 rounded-xl border border-border p-3"
          }
        >
          {hasTiers ? (
            <div className="flex min-h-8 items-center justify-between gap-2 px-1">
              <span className="text-xs font-medium text-muted-foreground">
                {label}
              </span>
              {index >= 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("catalogRemoveTier")}
                  onClick={() => {
                    const { tiers, ...rates } = base;
                    const remaining = (tiers ?? []).filter(
                      (_, tierIndex) => tierIndex !== index,
                    );
                    onChange({
                      cost: {
                        ...rates,
                        ...(remaining.length ? { tiers: remaining } : {}),
                      },
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {index >= 0 && rates && "inputTokensAbove" in rates ? (
            <DialogField
              label={t("catalogTierThreshold")}
              htmlFor={`${id}-${index}-threshold`}
              dirty={
                rates.inputTokensAbove !==
                initial.cost?.tiers?.[index]?.inputTokensAbove
              }
            >
              <Input
                id={`${id}-${index}-threshold`}
                type="number"
                min="0"
                step="1"
                required
                value={String(rates.inputTokensAbove)}
                onChange={(value) => {
                  onChange({
                    cost: {
                      ...base,
                      tiers: (base.tiers ?? []).map((tier, tierIndex) =>
                        tierIndex === index
                          ? { ...tier, inputTokensAbove: Number(value) }
                          : tier,
                      ),
                    },
                  });
                }}
                className="w-full"
              />
            </DialogField>
          ) : null}
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {fields.map(([field, translation]) => (
              <DialogField
                key={field}
                label={t(translation)}
                htmlFor={`${id}-${index}-${field}`}
                dirty={
                  (rates?.[field] ?? null) !==
                  ((index < 0 ? initial.cost : initial.cost?.tiers?.[index])?.[
                    field
                  ] ?? null)
                }
              >
                <Input
                  id={`${id}-${index}-${field}`}
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0"
                  value={String(rates?.[field] ?? "")}
                  onChange={(value) => {
                    const price = value ? Number(value) : 0;
                    onChange({
                      cost:
                        index < 0
                          ? { ...base, [field]: price }
                          : {
                              ...base,
                              tiers: base.tiers?.map((tier, tierIndex) =>
                                tierIndex === index
                                  ? { ...tier, [field]: price }
                                  : tier,
                              ),
                            },
                    });
                  }}
                  className="w-full"
                />
              </DialogField>
            ))}
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          const { tiers = [], ...rates } = base;
          const inputTokensAbove =
            Math.max(0, ...tiers.map((tier) => tier.inputTokensAbove)) + 1;
          onChange({
            cost: {
              ...base,
              tiers: [...tiers, { ...rates, inputTokensAbove }],
            },
          });
        }}
      >
        <Plus aria-hidden="true" className="size-4" />
        {t("catalogAddTier")}
      </Button>
      {hasTiers ? (
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {t("catalogTierHint")}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Model add/edit form. The dialog unmounts its content when closed, so every
 * opening starts from `initialModel` with no manual edits recorded.
 */
function ModelForm({
  slug,
  providerId,
  initialModel,
  modelIdReadOnly = false,
  active,
  state,
  formAction,
  submit,
}: {
  slug: string;
  providerId: string;
  initialModel: ProviderModelValues;
  modelIdReadOnly?: boolean;
  /** False while the dialog animates closed; stops catalog autofill. */
  active: boolean;
  state: ActionState;
  formAction: (formData: FormData) => void;
  submit: {
    icon: ReactNode;
    label: string;
    pendingLabel: string;
    savedLabel: string;
  };
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const settingsId = useId();
  const [showMore, setShowMore] = useState(false);
  const [model, setModel] = useState<ProviderModelValues>(initialModel);
  const manualFields = useRef(new Set<keyof ProviderModelValues>());
  const updateModel = (values: Partial<ProviderModelValues>) => {
    for (const field of Object.keys(values) as Array<keyof ProviderModelValues>)
      manualFields.current.add(field);
    setModel((current) => ({ ...current, ...values }));
  };
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  };
  // Shows catalog-filled settings without expanding the section.
  const summary = [
    typeLabels[model.primaryType],
    model.capabilities.includes("reasoning") && t("capabilityReasoning"),
    model.capabilities.includes("function_calling") && t("capabilityTools"),
    model.inputModalities.includes("image") && t("modalityVision"),
    model.inputModalities.includes("audio") && t("modalityAudio"),
    model.inputModalities.includes("video") && t("modalityVideo"),
    model.contextWindow &&
      `${t("contextWindow")} ${compactTokens.format(model.contextWindow)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const fieldId = useId();
  // Collapsed settings still flag unsaved edits on the toggle.
  const advancedDirty =
    model.primaryType !== initialModel.primaryType ||
    !sameSet(model.capabilities, initialModel.capabilities) ||
    !sameSet(model.inputModalities, initialModel.inputModalities) ||
    model.contextWindow !== initialModel.contextWindow ||
    model.maxInputTokens !== initialModel.maxInputTokens ||
    model.maxOutputTokens !== initialModel.maxOutputTokens ||
    JSON.stringify(model.cost ?? null) !==
      JSON.stringify(initialModel.cost ?? null);

  return (
    <form
      action={formAction}
      // Collapsed settings stay in the form; reveal them if one is invalid.
      onInvalidCapture={() => setShowMore(true)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="providerId" value={providerId} />
      <input
        type="hidden"
        name="cost"
        value={JSON.stringify(model.cost ?? null)}
      />
      <DialogBody>
        <div className="space-y-5">
          <DialogField
            label={t("modelId")}
            htmlFor={`${fieldId}-modelId`}
            dirty={model.modelId !== initialModel.modelId}
            description={modelIdReadOnly ? undefined : t("modelIdBatchHint")}
          >
            <Input
              id={`${fieldId}-modelId`}
              leftIcon={<Cpu />}
              name="modelId"
              required
              readOnly={modelIdReadOnly}
              placeholder="gpt-5.5"
              value={String(model.modelId)}
              onChange={(modelId) =>
                // A new ID reloads defaults but keeps fields the user edited.
                setModel((current) => ({
                  ...defaultProviderModel(modelId),
                  ...Object.fromEntries(
                    [...manualFields.current].map((field) => [
                      field,
                      current[field],
                    ]),
                  ),
                }))
              }
              className="w-full"
              classNames={
                modelIdReadOnly
                  ? { field: "bg-muted/40", input: "text-muted-foreground" }
                  : undefined
              }
            />
          </DialogField>
          <div className="grid gap-5 sm:grid-cols-2">
            <DialogField
              label={t("modelName")}
              htmlFor={`${fieldId}-name`}
              dirty={model.name !== initialModel.name}
            >
              <Input
                id={`${fieldId}-name`}
                leftIcon={<Pencil />}
                name="name"
                placeholder="GPT-5.5"
                value={String(model.name)}
                onChange={(name) => updateModel({ name })}
                className="w-full"
              />
            </DialogField>
            <DialogField
              label={t("modelGroup")}
              htmlFor={`${fieldId}-group`}
              dirty={model.group !== initialModel.group}
            >
              <Input
                id={`${fieldId}-group`}
                leftIcon={<Boxes />}
                name="group"
                placeholder="ChatGPT"
                value={String(model.group)}
                onChange={(group) => updateModel({ group })}
                className="w-full"
              />
            </DialogField>
          </div>
          <ProviderModelAutofill
            slug={slug}
            providerId={providerId}
            modelId={model.modelId}
            name={model.name}
            open={active}
            setModel={setModel}
            manualFields={manualFields}
          />
        </div>
        <div className="border-t border-border pt-3">
          <Button
            type="button"
            onClick={() => setShowMore((value) => !value)}
            aria-expanded={showMore}
            aria-controls={settingsId}
            variant="ghost"
            className="h-10 w-full justify-start gap-3 rounded-lg px-2 text-foreground"
          >
            <span className="shrink-0 text-sm font-medium">
              {t("moreSettings")}
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-normal text-muted-foreground">
              {showMore ? null : summary}
            </span>
            {advancedDirty ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                role="img"
                aria-label={common("modified")}
              />
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${showMore ? "rotate-180" : ""}`}
            />
          </Button>
          <div id={settingsId} hidden={!showMore} className="space-y-6 pt-4">
            <ModelClassificationControls
              initial={initialModel}
              primaryType={model.primaryType}
              capabilities={model.capabilities}
              inputModalities={model.inputModalities}
              onPrimaryTypeChange={(primaryType) =>
                updateModel({ primaryType })
              }
              onCapabilitiesChange={(capabilities) =>
                updateModel({ capabilities })
              }
              onInputModalitiesChange={(inputModalities) =>
                updateModel({ inputModalities })
              }
            />
            <ModelLimits
              initial={initialModel}
              model={model}
              onChange={updateModel}
            />
            <ModelPrices
              initial={initialModel}
              model={model}
              onChange={updateModel}
            />
          </div>
        </div>
        <ActionMessage state={state} />
      </DialogBody>
      <DialogFooter cancel={<DialogCancel />}>
        <SubmitButton
          error={state.error}
          pendingLabel={submit.pendingLabel}
          savedLabel={submit.savedLabel}
          variant="primary"
          size="md"
        >
          {submit.icon}
          {submit.label}
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

function providerFormatLabel(
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

function AddProviderDialog({
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
  const initialPreset = piProviderPresets[0] ?? customProviderPresets[0];
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
    { label: t("builtInProviders"), presets: piProviderPresets },
    { label: t("compatibleProviders"), presets: customProviderPresets },
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

function AddModelDialog({
  slug,
  providerId,
}: {
  slug: string;
  providerId: string;
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const [state, formAction] = useActionState<ActionState, FormData>(
    addProviderModelAction,
    {},
  );
  const visible = open && state.savedAt === savedAtWhenOpened;

  return (
    <ProviderDialog
      open={visible}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setSavedAtWhenOpened(state.savedAt);
        setOpen(nextOpen);
      }}
      title={t("addModel")}
      maxWidth="max-w-2xl"
      labelledTrigger
      trigger={
        <Button size="sm" variant="secondary" type="button">
          <Plus aria-hidden="true" className="size-3.5" />
          {t("addModel")}
        </Button>
      }
    >
      <ModelForm
        slug={slug}
        providerId={providerId}
        initialModel={defaultProviderModel("")}
        active={visible}
        state={state}
        formAction={formAction}
        submit={{
          icon: <Plus aria-hidden="true" className="size-4" />,
          label: t("add"),
          pendingLabel: t("adding"),
          savedLabel: t("added"),
        }}
      />
    </ProviderDialog>
  );
}

function EditModelDialog({
  slug,
  providerId,
  initialModel,
}: {
  slug: string;
  providerId: string;
  initialModel: ProviderModelRow;
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<
    number | undefined
  >();
  const [state, formAction] = useActionState<ActionState, FormData>(
    updateProviderModelAction,
    {},
  );
  const visible = open && state.savedAt === savedAtWhenOpened;

  return (
    <ProviderDialog
      open={visible}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setSavedAtWhenOpened(state.savedAt);
        setOpen(nextOpen);
      }}
      title={t("editModel")}
      maxWidth="max-w-2xl"
      trigger={
        <Button
          size="icon"
          variant="ghost"
          type="button"
          aria-label={t("editModel")}
        >
          <Pencil aria-hidden="true" className="size-4" />
        </Button>
      }
    >
      <ModelForm
        slug={slug}
        providerId={providerId}
        initialModel={initialModel}
        modelIdReadOnly
        active={visible}
        state={state}
        formAction={formAction}
        submit={{
          icon: <Save aria-hidden="true" className="size-4" />,
          label: t("saveChanges"),
          pendingLabel: t("saving"),
          savedLabel: t("saved"),
        }}
      />
    </ProviderDialog>
  );
}

function DeleteModelForm({
  slug,
  providerId,
  modelId,
}: {
  slug: string;
  providerId: string;
  modelId: string;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const [state, action] = useActionState<ActionState, FormData>(
    deleteProviderModelAction,
    {},
  );
  return (
    <form action={action} className="contents">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="modelId" value={modelId} />
      <ConfirmSubmitButton
        triggerLabel={<Trash2 className="size-3.5" />}
        triggerAriaLabel={t("removeModel")}
        confirmLabel={common("confirm")}
        cancelLabel={common("cancel")}
        prompt={t("removeModelPrompt", { model: modelId })}
        pendingLabel={t("removingModel")}
        triggerVariant="ghost"
        triggerSize="icon"
        triggerTooltip={false}
        promptClassName="max-w-52 text-xs text-muted-foreground"
      />
      {state.error ? (
        <span role="alert" className="text-xs text-destructive">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

// Model name | context | max output | input price | output price | actions.
// Below xl the numeric columns fold into a single line under the name.
const MODEL_ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 xl:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5rem_6.5rem]";

const compactTokens = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function ModelPriceDetails({
  cost,
  numbers,
  prices,
}: {
  cost: NonNullable<ProviderModelRow["cost"]>;
  numbers: Intl.NumberFormat;
  prices: Intl.NumberFormat;
}) {
  const t = useTranslations("console.agents");
  const rows = [
    { label: t("catalogBasePrice"), rates: cost },
    ...(cost.tiers ?? []).map((tier) => ({
      label: t("catalogTierAbove", {
        tokens: numbers.format(tier.inputTokensAbove),
      }),
      rates: tier,
    })),
  ];
  return (
    <span className="block space-y-2 text-left text-xs">
      <span className="block text-muted-foreground">
        {t("catalogPriceUnit")}
      </span>
      {rows.map(({ label, rates }) => (
        <span key={label} className="block">
          {rows.length > 1 ? (
            <span className="block font-medium">{label}</span>
          ) : null}
          {(
            [
              ["catalogInputPrice", rates.input],
              ["catalogOutputPrice", rates.output],
              ["catalogCacheReadPrice", rates.cacheRead],
              ["catalogCacheWritePrice", rates.cacheWrite],
            ] as const
          ).map(([field, price]) => (
            <span key={field} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t(field)}</span>
              <span className="tabular-nums">{prices.format(price)}</span>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function ModelTestRow({
  slug,
  providerId,
  model,
  numbers,
  prices,
}: {
  slug: string;
  providerId: string;
  model: ProviderModelRow;
  numbers: Intl.NumberFormat;
  prices: Intl.NumberFormat;
}) {
  const t = useTranslations("console.agents");
  const [state, testAction] = useActionState<ActionState, FormData>(
    testProviderModelAction,
    {},
  );
  const typeLabel = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  }[model.primaryType];
  const tags = [
    model.capabilities.includes("reasoning") && t("capabilityReasoning"),
    model.capabilities.includes("function_calling") && t("capabilityTools"),
    model.inputModalities.includes("image") && t("modalityVision"),
  ].filter((tag): tag is string => Boolean(tag));
  const cost = model.cost ?? null;
  const contextTitle =
    (
      [
        [t("contextWindow"), model.contextWindow],
        [t("maxInputTokens"), model.maxInputTokens],
      ] as const
    )
      .flatMap(([label, value]) =>
        value === null ? [] : [`${label}: ${numbers.format(value)}`],
      )
      .join("\n") || undefined;
  const meta = [
    model.contextWindow !== null &&
      `${t("contextWindow")} ${compactTokens.format(model.contextWindow)}`,
    model.maxOutputTokens !== null &&
      `${t("maxOutputTokens")} ${compactTokens.format(model.maxOutputTokens)}`,
    cost &&
      `${t("catalogInputPrice")} ${prices.format(cost.input)} · ${t("catalogOutputPrice")} ${prices.format(cost.output)}`,
  ].filter(Boolean);
  const priceCells = (
    <>
      <span className="text-right">
        {cost ? prices.format(cost.input) : "—"}
      </span>
      <span className="text-right">
        {cost ? prices.format(cost.output) : "—"}
      </span>
    </>
  );
  const hasPriceDetails = Boolean(
    cost && (cost.cacheRead || cost.cacheWrite || cost.tiers?.length),
  );

  return (
    <article
      aria-label={model.name}
      className={`${MODEL_ROW_GRID} px-4 py-2.5 transition-colors hover:bg-muted/40`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Tooltip content={typeLabel}>
          <span
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: This labeled model icon is a keyboard-focusable tooltip trigger, not an action.
            tabIndex={0}
            aria-label={typeLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground"
          >
            <ModelTypeIcon type={model.primaryType} />
          </span>
        </Tooltip>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            {tags.map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded-lg px-1.5 py-px text-[10px] leading-4 text-muted-foreground ring-1 ring-inset ring-border"
              >
                {tag}
              </span>
            ))}
          </div>
          {model.name !== model.modelId ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {model.modelId}
            </p>
          ) : null}
          {meta.length ? (
            <p className="text-[11px] tabular-nums text-muted-foreground xl:hidden">
              {meta.join(" · ")}
            </p>
          ) : null}
          {state.error ? (
            <ActionMessage state={state} />
          ) : state.savedAt ? (
            <p className="mt-1 text-xs text-muted-foreground" role="status">
              {t("modelAvailable")}
            </p>
          ) : null}
        </div>
      </div>
      <span
        title={contextTitle}
        className="hidden text-right text-xs tabular-nums text-foreground xl:block"
      >
        {model.contextWindow === null
          ? "—"
          : compactTokens.format(model.contextWindow)}
      </span>
      <span
        title={
          model.maxOutputTokens === null
            ? undefined
            : numbers.format(model.maxOutputTokens)
        }
        className="hidden text-right text-xs tabular-nums text-foreground xl:block"
      >
        {model.maxOutputTokens === null
          ? "—"
          : compactTokens.format(model.maxOutputTokens)}
      </span>
      {hasPriceDetails && cost ? (
        <Tooltip
          content={
            <ModelPriceDetails cost={cost} numbers={numbers} prices={prices} />
          }
          wrapperClassName="hidden xl:col-span-2 xl:grid"
        >
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The price cells are a keyboard-focusable trigger for the full price table.
            tabIndex={0}
            className="grid cursor-help grid-cols-2 gap-x-3 text-xs tabular-nums text-foreground underline decoration-border decoration-dotted underline-offset-4"
          >
            {priceCells}
          </span>
        </Tooltip>
      ) : (
        <span className="hidden grid-cols-2 gap-x-3 text-xs tabular-nums text-foreground xl:col-span-2 xl:grid">
          {priceCells}
        </span>
      )}
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {model.primaryType === "text" ? (
          <form action={testAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={providerId} />
            <input type="hidden" name="model" value={model.modelId} />
            <Tooltip content={t("testModel")}>
              <SubmitButton
                error={state.error}
                pendingLabel=""
                savedLabel=""
                ariaLabel={t("testModel")}
                variant="ghost"
                size="icon"
                icon={<FlaskConical className="size-3.5" />}
              >
                {null}
              </SubmitButton>
            </Tooltip>
          </form>
        ) : null}
        <EditModelDialog
          slug={slug}
          providerId={providerId}
          initialModel={model}
        />
        <DeleteModelForm
          slug={slug}
          providerId={providerId}
          modelId={model.modelId}
        />
      </div>
    </article>
  );
}

function EditProviderDialog({
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

const MODEL_TYPE_ORDER: ModelPrimaryType[] = [
  "text",
  "image",
  "embedding",
  "rerank",
];

function endpointHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function ProviderMonogram({
  name,
  large = false,
}: {
  name: string;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-semibold text-muted-foreground ${large ? "size-10 text-sm" : "size-8 text-xs"}`}
    >
      {name.trim().charAt(0).toUpperCase() || "P"}
    </span>
  );
}

function ProviderDetail({
  slug,
  provider,
  piProviderPresets,
  refreshState,
  refreshing,
  onRefresh,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
  refreshState: ActionState;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("console.agents");
  const locale = useLocale();
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const prices = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 8,
      }),
    [locale],
  );
  const common = useTranslations("common");
  const [modelQuery, setModelQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | ModelPrimaryType>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const endpoint = providerEndpoint(
    provider,
    piProviderPresets,
    t("builtInConnection"),
  );
  const modelRecords = useMemo<ProviderModelRow[]>(() => {
    return provider.models.map((modelId) => {
      const defaults = defaultProviderModel(modelId);
      const stored = provider.modelRecords?.find(
        (record) => record.modelId === modelId,
      );
      if (!stored) return { ...defaults, source: "remote" };
      return {
        ...stored,
        primaryType: MODEL_PRIMARY_TYPES.includes(
          stored.primaryType as ModelPrimaryType,
        )
          ? (stored.primaryType as ModelPrimaryType)
          : defaults.primaryType,
        capabilities: stored.capabilities.filter(
          (value): value is ModelCapability =>
            MODEL_CAPABILITIES.includes(value as ModelCapability),
        ),
        inputModalities: stored.inputModalities.filter(
          (value): value is ModelInputModality =>
            MODEL_INPUT_MODALITIES.includes(value as ModelInputModality),
        ),
      };
    });
  }, [provider.modelRecords, provider.models]);
  const searchedModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return query
      ? modelRecords.filter((model) =>
          [
            model.modelId,
            model.name,
            model.group,
            ...model.capabilities,
            ...model.inputModalities,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
        )
      : modelRecords;
  }, [modelQuery, modelRecords]);
  // Offer a type tab only for types this provider actually has, so a
  // text-only provider is not shown three permanently empty filters.
  const filterTypes = useMemo(
    () =>
      MODEL_TYPE_ORDER.filter(
        (type) =>
          type === typeFilter ||
          modelRecords.some((model) => model.primaryType === type),
      ),
    [modelRecords, typeFilter],
  );
  const visibleModels = useMemo(
    () =>
      typeFilter === "all"
        ? searchedModels
        : searchedModels.filter((model) => model.primaryType === typeFilter),
    [searchedModels, typeFilter],
  );
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ProviderModelRow[]>();
    for (const model of visibleModels) {
      const group = model.group.trim();
      groups.set(group, [...(groups.get(group) ?? []), model]);
    }
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [visibleModels]);
  const showGroupHeaders = modelGroups.some(([group]) => group !== "");
  const allGroupsExpanded = modelGroups.every(
    ([group]) => !collapsedGroups.has(group),
  );
  const searching = Boolean(modelQuery.trim());
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t("modelTypeText"),
    image: t("modelTypeImage"),
    embedding: t("modelTypeEmbedding"),
    rerank: t("modelTypeRerank"),
  };
  const hasPrices = visibleModels.some((model) => model.cost);
  const refreshMessage = refreshing
    ? t("modelsFetching")
    : refreshState.savedAt
      ? t("modelsFetchComplete")
      : null;

  return (
    <section
      aria-label={provider.name}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-2">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <ProviderMonogram name={provider.name} large />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {provider.name}
              </h2>
              <span className="shrink-0 rounded-lg bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {providerFormatLabel(provider.format, piProviderPresets)}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {endpoint}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refreshing}
            aria-busy={refreshing || undefined}
            onClick={onRefresh}
            className="mr-1"
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("refreshModels")}
          </Button>
          <EditProviderDialog
            slug={slug}
            provider={provider}
            piProviderPresets={piProviderPresets}
          />
          <form action={deleteProviderAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={provider.id} />
            <ConfirmSubmitButton
              triggerLabel={<Trash2 className="size-4" />}
              triggerAriaLabel={common("remove")}
              confirmLabel={common("confirm")}
              cancelLabel={common("cancel")}
              prompt={t("removeProviderPrompt", { name: provider.name })}
              pendingLabel={t("removingProvider")}
              className="items-center justify-end"
              triggerVariant="ghost"
              triggerSize="icon"
              triggerTooltip={false}
              promptClassName="max-w-sm text-xs text-muted-foreground"
            />
          </form>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-border px-4 py-2.5">
        {filterTypes.length > 1 ? (
          <Tabs
            variant="segment"
            value={typeFilter}
            onValueChange={(value) =>
              setTypeFilter(value as "all" | ModelPrimaryType)
            }
            className="min-w-0"
          >
            <TabsList aria-label={t("filterModels")} className="bg-muted/50">
              <TabsTrigger value="all" className="gap-1.5 px-2.5 py-1 text-xs">
                {t("allModels")}
                <span className="tabular-nums opacity-60">
                  {searchedModels.length}
                </span>
              </TabsTrigger>
              {filterTypes.map((type) => (
                <TabsTrigger
                  key={type}
                  value={type}
                  className="gap-1.5 px-2.5 py-1 text-xs"
                >
                  <ModelTypeIcon type={type} />
                  {typeLabels[type]}
                  <span className="tabular-nums opacity-60">
                    {
                      searchedModels.filter(
                        (model) => model.primaryType === type,
                      ).length
                    }
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <h3 className="px-1 text-sm font-medium text-foreground">
            {t("model")}
            <span className="ml-2 tabular-nums text-muted-foreground">
              {searchedModels.length}
            </span>
          </h3>
        )}
        <div className="ml-auto flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {showGroupHeaders && modelGroups.length > 1 && !searching ? (
            <Tooltip
              content={
                allGroupsExpanded
                  ? t("collapseAllGroups")
                  : t("expandAllGroups")
              }
            >
              <Button
                type="button"
                onClick={() =>
                  setCollapsedGroups(
                    allGroupsExpanded
                      ? new Set(modelGroups.map(([group]) => group))
                      : new Set(),
                  )
                }
                aria-label={
                  allGroupsExpanded
                    ? t("collapseAllGroups")
                    : t("expandAllGroups")
                }
                variant="ghost"
                size="icon"
              >
                {allGroupsExpanded ? (
                  <ChevronsDownUp className="size-4" />
                ) : (
                  <ChevronsUpDown className="size-4" />
                )}
              </Button>
            </Tooltip>
          ) : null}
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Input
              leftIcon={<Search />}
              aria-label={t("searchModels")}
              placeholder={t("searchModels")}
              value={modelQuery}
              onChange={setModelQuery}
              className="w-full"
            />
          </div>
          <AddModelDialog slug={slug} providerId={provider.id} />
        </div>
      </div>

      {refreshMessage || refreshState.error ? (
        <div className="shrink-0 border-b border-border px-5 py-2">
          {refreshMessage ? (
            <p role="status" className="text-xs text-muted-foreground">
              {refreshMessage}
            </p>
          ) : null}
          {refreshState.error ? (
            <p role="alert" className="text-xs text-destructive">
              {`${t("modelsFetchFailedSaved")} ${refreshState.error}`}
            </p>
          ) : refreshState.warning ? (
            <p role="alert" className="text-xs text-muted-foreground">
              {refreshState.warning}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {modelGroups.length > 0 ? (
          <>
            <div
              aria-hidden="true"
              className={`${MODEL_ROW_GRID} sticky top-0 z-10 hidden border-b border-border bg-card px-4 py-2 text-[11px] font-medium text-muted-foreground xl:grid`}
            >
              <span>{t("model")}</span>
              <span className="text-right">{t("modelColumnContext")}</span>
              <span className="text-right">{t("modelColumnMaxOutput")}</span>
              <span className="text-right">{t("catalogInputPrice")}</span>
              <span className="text-right">{t("catalogOutputPrice")}</span>
              <span />
            </div>
            {modelGroups.map(([group, models]) => {
              const expanded = searching || !collapsedGroups.has(group);
              return (
                <section
                  key={group || "__ungrouped"}
                  aria-label={group || t("ungroupedModels")}
                >
                  {showGroupHeaders ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() =>
                        setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {group || t("ungroupedModels")}
                      </span>
                      <span className="tabular-nums">{models.length}</span>
                    </button>
                  ) : null}
                  {expanded ? (
                    <div className="divide-y divide-border/60 border-b border-border/60">
                      {models.map((model) => (
                        <ModelTestRow
                          key={model.modelId}
                          slug={slug}
                          providerId={provider.id}
                          model={model}
                          numbers={numbers}
                          prices={prices}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
              {[
                t("providerModelCount", { count: provider.models.length }),
                provider.modelsFetchedAt &&
                  t("lastRefreshedAt", { date: provider.modelsFetchedAt }),
                hasPrices && t("catalogPriceUnit"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        ) : (
          <DashboardEmptyState
            icon={Boxes}
            title={
              provider.models.length > 0
                ? t("noMatchingModels")
                : t("noModelsCachedYet")
            }
          />
        )}
      </div>
    </section>
  );
}

export function ProvidersPanel({
  slug,
  providers,
  piProviderPresets = [],
}: {
  slug: string;
  providers: ProviderRow[];
  piProviderPresets?: ProviderPreset[];
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const router = useRouter();
  const [providerQuery, setProviderQuery] = useState("");
  const searchParams = useSearchParams();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => searchParams.get("provider") ?? providers[0]?.id ?? null,
  );
  const [refreshes, setRefreshes] = useState<
    Record<string, { pending: boolean; state: ActionState }>
  >({});

  async function refreshProvider(providerId: string) {
    setRefreshes((current) => ({
      ...current,
      [providerId]: { pending: true, state: {} },
    }));
    let state: ActionState;
    try {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(slug)}/providers/${encodeURIComponent(providerId)}/models`,
        { method: "POST" },
      );
      state = (await response.json()) as ActionState;
      if (!response.ok && !state.error)
        state = { error: t("modelsFetchRequestFailed") };
      if (state.savedAt) router.refresh();
    } catch {
      state = { error: t("modelsFetchRequestFailed") };
    }
    setRefreshes((current) => ({
      ...current,
      [providerId]: { pending: false, state },
    }));
  }

  // Keep the selection in the URL so reloads and shared links reopen it.
  function selectProvider(providerId: string) {
    setSelectedProviderId(providerId);
    const url = new URL(window.location.href);
    url.searchParams.set("provider", providerId);
    window.history.replaceState(null, "", url);
  }

  function handleCreated(providerId: string) {
    selectProvider(providerId);
    setProviderQuery("");
    void refreshProvider(providerId);
  }
  const visibleProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      [provider.name, provider.format, ...provider.models].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [providerQuery, providers]);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers[0] ??
    null;
  return selectedProvider ? (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col md:flex-row">
      <aside
        aria-label={t("modelProviders")}
        className="flex max-h-60 shrink-0 flex-col border-b border-border/60 md:max-h-none md:w-64 md:border-b-0 md:border-r"
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-4 pr-2">
          <h1 className="truncate text-sm font-semibold">
            {t("modelProviders")}
          </h1>
          <AddProviderDialog
            slug={slug}
            piProviderPresets={piProviderPresets}
            onCreated={handleCreated}
            iconTrigger
          />
        </div>
        {providers.length > 5 ? (
          <div className="px-2 pb-1">
            <Input
              leftIcon={<Search />}
              aria-label={`${common("search")} ${t("modelProviders")}`}
              placeholder={common("search")}
              value={providerQuery}
              onChange={setProviderQuery}
              className="w-full"
            />
          </div>
        ) : null}
        <nav
          aria-label={t("modelProviders")}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
        >
          {visibleProviders.length > 0 ? (
            visibleProviders.map((provider) => {
              const selected = provider.id === selectedProvider.id;
              const refresh = refreshes[provider.id];
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-label={provider.name}
                  aria-pressed={selected}
                  aria-busy={refresh?.pending || undefined}
                  onClick={() => selectProvider(provider.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${selected ? "bg-foreground/[0.08]" : "hover:bg-foreground/5"}`}
                >
                  <ProviderMonogram name={provider.name} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm text-foreground ${selected ? "font-medium" : ""}`}
                    >
                      {provider.name}
                    </span>
                    <span
                      className={`block truncate text-[11px] ${refresh?.state.error ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {refresh?.pending
                        ? t("modelsFetching")
                        : refresh?.state.error
                          ? t("modelsFetchFailedLabel")
                          : endpointHost(
                              providerEndpoint(
                                provider,
                                piProviderPresets,
                                provider.format,
                              ),
                            )}
                    </span>
                  </span>
                  {refresh?.pending ? (
                    <RefreshCw
                      aria-hidden="true"
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {provider.modelCount}
                    </span>
                  )}
                </button>
              );
            })
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {common("noResults")}
            </p>
          )}
        </nav>
      </aside>

      <ProviderDetail
        key={selectedProvider.id}
        slug={slug}
        provider={selectedProvider}
        piProviderPresets={piProviderPresets}
        refreshState={refreshes[selectedProvider.id]?.state ?? {}}
        refreshing={refreshes[selectedProvider.id]?.pending ?? false}
        onRefresh={() => {
          void refreshProvider(selectedProvider.id);
        }}
      />
    </div>
  ) : (
    <DashboardEmptyState
      icon={Cpu}
      title={t("noProvidersYet")}
      description={t("noProvidersYetAddOneAboveThenRefreshItsModels")}
      actions={
        <AddProviderDialog
          slug={slug}
          piProviderPresets={piProviderPresets}
          onCreated={handleCreated}
        />
      }
      className="flex-1"
    />
  );
}
