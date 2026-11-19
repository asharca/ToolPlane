"use client";

import { useActionState, useId, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowUpDown,
  AudioLines,
  Boxes,
  BrainCircuit,
  ChevronDown,
  Cpu,
  Eye,
  Image as ImageIcon,
  Pencil,
  Plus,
  Save,
  Trash2,
  Type,
  Video,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
} from "@/components/dashboard/dialog";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  addProviderModelAction,
  deleteProviderModelAction,
  updateProviderModelAction,
  type ActionState,
} from "@/lib/agents/actions";
import {
  defaultProviderModel,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
  type ProviderModelValues,
} from "@/lib/agents/model-catalog";
import { ProviderModelAutofill } from "./ProviderModelAutofill";
import { ActionMessage, ProviderDialog } from "./ProviderDialogs";
import type { ProviderModelRow } from "./ProvidersPanel";

export const compactTokens = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function ModelTypeIcon({ type }: { type: ModelPrimaryType }) {
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

export function AddModelDialog({
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

export function EditModelDialog({
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

export function DeleteModelForm({
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
