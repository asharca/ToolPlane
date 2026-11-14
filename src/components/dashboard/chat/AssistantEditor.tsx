"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogNav,
  useDirtyFields,
} from "@/components/dashboard/dialog";
import { RevisionChangelog } from "@/components/dashboard/RevisionChangelog";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
} from "@/components/dashboard/models/ModelPicker";
import { SystemPromptEditor } from "@/components/dashboard/SystemPromptEditor";
import {
  AGENT_STEP_BOUNDS,
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  normalizeReasoningEffort,
  selectionSupportsReasoning,
  type ReasoningEffort,
} from "@/lib/agents/constants";
import { REASONING_EFFORT_LABELS } from "@/components/dashboard/agents/ReasoningEffortControl";
import { cn as cx } from "@/lib/utils";
import type { ChatAssistantItem } from "./WorkspaceAssistantChat";

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = {
  id: string;
  name: string;
  status: string;
  keywords?: string[];
  available?: boolean;
};
type AssistantCreateStep =
  | "basic"
  | "instructions"
  | "modelParameters"
  | "tools"
  | "changelog";
type AssistantModelParameters = NonNullable<
  ChatAssistantItem["modelParameters"]
>;
type AssistantCustomParameter = NonNullable<
  AssistantModelParameters["customParameters"]
>[number];
const inputClassNames = { field: "rounded-lg", input: "text-sm" };
function defaultCustomParameterValue(
  type: AssistantCustomParameter["type"],
): AssistantCustomParameter["value"] {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function hasValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function AssistantEditor({
  assistant,
  deployments,
  onClose,
  onDelete,
  onSaved,
  open,
  providers,
  slug,
  workspaceId,
}: {
  assistant: ChatAssistantItem | null;
  deployments: McpOption[];
  onClose: () => void;
  onDelete: (assistantId: string) => Promise<void>;
  onSaved: (assistantId: string, created: boolean) => Promise<void>;
  open: boolean;
  providers: ProviderOption[];
  slug: string;
  workspaceId: string;
}) {
  const t = useTranslations("console.chatAssistants");
  const agentsT = useTranslations("console.agents");
  const common = useTranslations("common");
  const creating = !assistant;
  const [closing, setClosing] = useState(false);
  const [createStep, setCreateStep] = useState<AssistantCreateStep>("basic");
  const [name, setName] = useState(assistant?.name ?? "");
  const [description, setDescription] = useState(assistant?.description ?? "");
  const initialProviderId =
    assistant?.modelProviderId ?? providers[0]?.id ?? "";
  const [providerId, setProviderId] = useState(initialProviderId);
  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ?? null;
  const [model, setModel] = useState(
    assistant?.model ?? selectedProvider?.models[0] ?? "",
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    assistant?.reasoningEffort ?? DEFAULT_REASONING_LEVEL,
  );
  const initialModelParameters = assistant?.modelParameters ?? {};
  const [temperatureEnabled, setTemperatureEnabled] = useState(
    initialModelParameters.temperature !== undefined,
  );
  const [temperature, setTemperature] = useState(
    initialModelParameters.temperature ?? 1,
  );
  const [topPEnabled, setTopPEnabled] = useState(
    initialModelParameters.topP !== undefined,
  );
  const [topP, setTopP] = useState(initialModelParameters.topP ?? 1);
  const [maxOutputTokensEnabled, setMaxOutputTokensEnabled] = useState(
    initialModelParameters.maxOutputTokens !== undefined,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initialModelParameters.maxOutputTokens ?? 4096,
  );
  const [customParameters, setCustomParameters] = useState<
    (AssistantCustomParameter & { key: string })[]
  >(() =>
    (initialModelParameters.customParameters ?? []).map((parameter) => ({
      ...parameter,
      key: crypto.randomUUID(),
    })),
  );
  const initialSystemPrompt = assistant?.systemPrompt ?? "";
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDeployments, setSelectedDeployments] = useState<string[]>(() =>
    (assistant?.mcpGrants ?? []).map((grant) => grant.deploymentId),
  );
  const toolsDirty =
    JSON.stringify([...selectedDeployments].sort()) !==
    JSON.stringify(
      (assistant?.mcpGrants ?? []).map((grant) => grant.deploymentId).sort(),
    );
  const formRef = useRef<HTMLFormElement>(null);
  const { dirtyNames, reset: resetNativeDirty } = useDirtyFields(formRef);
  const nativeDirty = [...dirtyNames].some(
    (fieldName) => fieldName === "maxSteps",
  );
  const initialModel =
    assistant?.model ??
    providers.find((provider) => provider.id === initialProviderId)
      ?.models[0] ??
    "";
  const nameDirty = name !== (assistant?.name ?? "");
  const descriptionDirty = description !== (assistant?.description ?? "");
  const modelDirty = providerId !== initialProviderId || model !== initialModel;
  const reasoningDirty =
    reasoningEffort !== (assistant?.reasoningEffort ?? DEFAULT_REASONING_LEVEL);
  const promptDirty = systemPrompt !== initialSystemPrompt;
  const temperatureDirty =
    temperatureEnabled !== (initialModelParameters.temperature !== undefined) ||
    temperature !== (initialModelParameters.temperature ?? 1);
  const topPDirty =
    topPEnabled !== (initialModelParameters.topP !== undefined) ||
    topP !== (initialModelParameters.topP ?? 1);
  const maxOutputTokensDirty =
    maxOutputTokensEnabled !==
      (initialModelParameters.maxOutputTokens !== undefined) ||
    maxOutputTokens !== (initialModelParameters.maxOutputTokens ?? 4096);
  const customParametersDirty =
    customParameters.length !==
      (initialModelParameters.customParameters?.length ?? 0) ||
    customParameters.some((parameter, index) => {
      const initial = initialModelParameters.customParameters?.[index];
      return (
        !initial ||
        parameter.name !== initial.name ||
        parameter.type !== initial.type ||
        parameter.value !== initial.value
      );
    });
  const basicDirty =
    nameDirty || descriptionDirty || modelDirty || reasoningDirty;
  const parametersDirty =
    temperatureDirty ||
    topPDirty ||
    maxOutputTokensDirty ||
    customParametersDirty;
  const dirty =
    basicDirty || promptDirty || parametersDirty || nativeDirty || toolsDirty;
  const createSteps: Array<{
    id: AssistantCreateStep;
    label: string;
    dirty: boolean;
  }> = [
    { id: "basic", label: t("basic"), dirty: basicDirty },
    { id: "instructions", label: t("systemPrompt"), dirty: promptDirty },
    {
      id: "modelParameters",
      label: t("modelParameters"),
      dirty: parametersDirty,
    },
    { id: "tools", label: t("mcpAccess"), dirty: nativeDirty || toolsDirty },
    ...(assistant
      ? [{ id: "changelog" as const, label: t("changelog"), dirty: false }]
      : []),
  ];
  const createStepIndex = createSteps.findIndex(
    (step) => step.id === createStep,
  );
  const lastCreateStep = createStepIndex === createSteps.length - 1;
  const basicComplete = Boolean(name.trim() && providerId && model);

  async function submit(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const mcpGrants = selectedDeployments.map((deploymentId) => ({
        deploymentId,
      }));
      const selectedCustomParameters = customParameters
        .filter((parameter) => parameter.name.trim())
        .map(({ name, type, value }) => ({ name: name.trim(), type, value }));
      if (
        selectedCustomParameters.some(
          (parameter) =>
            parameter.type === "json" && !hasValidJson(String(parameter.value)),
        )
      ) {
        throw new Error(t("invalidCustomParameter"));
      }
      const modelParameters: AssistantModelParameters = {
        ...(temperatureEnabled ? { temperature } : {}),
        ...(topPEnabled ? { topP } : {}),
        ...(maxOutputTokensEnabled ? { maxOutputTokens } : {}),
        ...(selectedCustomParameters.length
          ? { customParameters: selectedCustomParameters }
          : {}),
      };
      const response = await fetch(
        assistant
          ? `/api/v1/chat/assistants/${assistant.id}`
          : "/api/v1/chat/assistants",
        {
          method: assistant ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(!assistant ? { workspaceId } : {}),
            ...(assistant ? { expectedRevision: assistant.revision } : {}),
            name: String(formData.get("name") ?? "").trim(),
            description: description.trim() || null,
            systemPrompt: systemPrompt.trim() || null,
            modelProviderId: providerId || null,
            model: model || null,
            reasoningEffort:
              reasoningEffort === "default" ? null : reasoningEffort,
            modelParameters: Object.keys(modelParameters).length
              ? modelParameters
              : null,
            maxSteps: Number(
              formData.get("maxSteps") ?? AGENT_STEP_BOUNDS.default,
            ),
            mcpGrants,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        assistant?: { id?: string };
        id?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t("saveError"));
      const assistantId = body.assistant?.id ?? body.id ?? assistant?.id;
      if (!assistantId) throw new Error(t("saveError"));
      await onSaved(assistantId, !assistant);
      resetNativeDirty();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CenterMorphModal
      open={open && !closing}
      onOpenChange={(next) => {
        if (!next) setClosing(true);
      }}
    >
      <CenterMorphModalContent
        ariaLabel={assistant ? t("editAssistant") : t("newAssistant")}
        closeButtonLabel={common("close")}
        onExitComplete={onClose}
        className="z-[51] flex h-[min(48rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
      >
        <DialogHeader
          title={assistant ? t("editAssistant") : t("newAssistant")}
          description={t("boundaryDescription")}
          className="border-b border-border"
        />
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(new FormData(event.currentTarget));
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <DialogNav
              label={t("configurationNavigation")}
              items={createSteps.map((step, index) => ({
                id: step.id,
                label: creating ? `${index + 1}. ${step.label}` : step.label,
                dirty: step.dirty,
              }))}
              active={createStep}
              onSelect={(id) => {
                const index = createSteps.findIndex((step) => step.id === id);
                if (!creating || index < createStepIndex)
                  setCreateStep(id as AssistantCreateStep);
              }}
            />

            <DialogBody className="flex min-w-0 flex-col overscroll-contain">
              <section
                hidden={createStep !== "basic"}
                aria-labelledby="assistant-create-basic-title"
                className="space-y-5"
              >
                <h3
                  id="assistant-create-basic-title"
                  className="text-base font-semibold text-foreground"
                >
                  {t("basic")}
                </h3>

                <DialogField
                  label={t("name")}
                  htmlFor="assistant-settings-name"
                  dirty={nameDirty}
                >
                  <Input
                    name="name"
                    id="assistant-settings-name"
                    aria-label={t("name")}
                    required
                    maxLength={100}
                    autoFocus
                    placeholder={t("namePlaceholder")}
                    value={String(name)}
                    onChange={(value) => setName(value)}
                    className="w-full"
                    classNames={inputClassNames}
                  />
                </DialogField>

                <DialogField
                  label={t("description")}
                  htmlFor="assistant-settings-description"
                  dirty={descriptionDirty}
                >
                  <textarea
                    id="assistant-settings-description"
                    name="description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                    maxLength={500}
                    className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder={t("descriptionPlaceholder")}
                  />
                </DialogField>

                <DialogField label={t("model")} dirty={modelDirty}>
                  <ModelPicker
                    className="flex w-full"
                    providers={providers}
                    value={providerId && model ? { providerId, model } : null}
                    onSelect={(selection) => {
                      setProviderId(selection.providerId);
                      setModel(selection.model);
                    }}
                    onConfigure={() => {
                      window.location.assign(
                        `/app/${encodeURIComponent(slug)}/providers`,
                      );
                    }}
                    trigger={
                      <ModelPickerTrigger
                        aria-label={`${t("model")}: ${model || t("selectModel")}`}
                        label={model || t("selectModel")}
                        placeholder={!model}
                        provider={selectedProvider?.name}
                        note={selectedProvider?.name}
                      />
                    }
                  />
                </DialogField>
                {selectionSupportsReasoning(providers, {
                  providerId,
                  model,
                }) && (
                  <DialogField
                    label={agentsT("defaultReasoningEffort")}
                    htmlFor="assistant-settings-reasoning-effort"
                    dirty={reasoningDirty}
                  >
                    <FormSelect
                      id="assistant-settings-reasoning-effort"
                      label={agentsT("defaultReasoningEffort")}
                      value={reasoningEffort}
                      disabled={saving}
                      options={REASONING_LEVELS.map((value) => ({
                        value,
                        label: agentsT(REASONING_EFFORT_LABELS[value]),
                      }))}
                      onValueChange={(value) =>
                        setReasoningEffort(
                          normalizeReasoningEffort(value) ?? "default",
                        )
                      }
                    />
                  </DialogField>
                )}
              </section>

              <section
                hidden={createStep !== "instructions"}
                aria-labelledby="assistant-create-instructions-title"
                className="flex flex-1 flex-col gap-5"
              >
                <h3
                  id="assistant-create-instructions-title"
                  className="text-base font-semibold text-foreground"
                >
                  {t("systemPrompt")}
                </h3>
                <SystemPromptEditor
                  workspaceId={workspaceId}
                  name={name}
                  description={description}
                  providerId={providerId}
                  model={model}
                  value={systemPrompt}
                  onChange={setSystemPrompt}
                  maxLength={20_000}
                  placeholder={t("systemPromptPlaceholder")}
                  dirty={promptDirty}
                />
              </section>

              <section
                hidden={createStep !== "modelParameters"}
                aria-labelledby="assistant-create-model-parameters-title"
                className="space-y-5"
              >
                <h3
                  id="assistant-create-model-parameters-title"
                  className="text-base font-semibold text-foreground"
                >
                  {t("modelParameters")}
                </h3>
                <DialogField label={t("temperature")} dirty={temperatureDirty}>
                  <div className="flex flex-col items-start gap-3 px-1 py-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <FormCheckbox
                        checked={temperatureEnabled}
                        label={t("useCustomTemperature")}
                        onCheckedChange={(checked) =>
                          setTemperatureEnabled(checked)
                        }
                      />
                    </div>
                    <Input
                      classNames={inputClassNames}
                      min={0}
                      max={2}
                      step={0.1}
                      disabled={!temperatureEnabled}
                      aria-label={t("temperature")}
                      type="number"
                      value={String(temperature)}
                      onChange={(value) => {
                        if (Number.isFinite(Number.parseFloat(value))) {
                          setTemperature(Number.parseFloat(value));
                        }
                      }}
                      className="w-24 shrink-0"
                    />
                  </div>
                </DialogField>
                <DialogField label={t("topP")} dirty={topPDirty}>
                  <div className="flex flex-col items-start gap-3 px-1 py-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <FormCheckbox
                        checked={topPEnabled}
                        label={t("useCustomTopP")}
                        onCheckedChange={(checked) => setTopPEnabled(checked)}
                      />
                    </div>
                    <Input
                      classNames={inputClassNames}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={!topPEnabled}
                      aria-label={t("topP")}
                      type="number"
                      value={String(topP)}
                      onChange={(value) => {
                        if (Number.isFinite(Number.parseFloat(value))) {
                          setTopP(Number.parseFloat(value));
                        }
                      }}
                      className="w-24 shrink-0"
                    />
                  </div>
                </DialogField>
                <DialogField
                  label={t("maxOutputTokens")}
                  dirty={maxOutputTokensDirty}
                >
                  <div className="flex flex-col items-start gap-3 px-1 py-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <FormCheckbox
                        checked={maxOutputTokensEnabled}
                        label={t("useCustomMaxOutputTokens")}
                        onCheckedChange={(checked) =>
                          setMaxOutputTokensEnabled(checked)
                        }
                      />
                    </div>
                    <Input
                      classNames={inputClassNames}
                      min={1}
                      max={1_000_000}
                      step={1}
                      disabled={!maxOutputTokensEnabled}
                      aria-label={t("maxOutputTokens")}
                      type="number"
                      value={String(maxOutputTokens)}
                      onChange={(value) => {
                        if (Number.isFinite(Number.parseFloat(value))) {
                          setMaxOutputTokens(Number.parseFloat(value));
                        }
                      }}
                      className="w-28 shrink-0"
                    />
                  </div>
                </DialogField>
                <DialogField
                  label={t("customParameters")}
                  description={t("customParametersHint")}
                  dirty={customParametersDirty}
                >
                  <div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        onClick={() =>
                          setCustomParameters((current) => [
                            ...current,
                            {
                              name: "",
                              type: "string",
                              value: "",
                              key: crypto.randomUUID(),
                            },
                          ])
                        }
                        variant={"secondary"}
                        size={"sm"}
                        className="shrink-0 gap-1.5"
                      >
                        <Plus className="size-3.5" />
                        {t("addCustomParameter")}
                      </Button>
                    </div>
                    {customParameters.length ? (
                      <div className="mt-3 space-y-3">
                        {customParameters.map((parameter, index) => {
                          const valueLabel = t("customParameterValue", {
                            name: parameter.name.trim() || String(index + 1),
                          });
                          const updateParameter = (
                            patch: Partial<AssistantCustomParameter>,
                          ) => {
                            setCustomParameters((current) =>
                              current.map((currentParameter, currentIndex) => {
                                if (currentIndex !== index)
                                  return currentParameter;
                                if (
                                  patch.type &&
                                  patch.type !== currentParameter.type
                                ) {
                                  return {
                                    ...currentParameter,
                                    ...patch,
                                    value: defaultCustomParameterValue(
                                      patch.type,
                                    ),
                                  };
                                }
                                return { ...currentParameter, ...patch };
                              }),
                            );
                          };
                          return (
                            <div
                              key={parameter.key}
                              className="border-t border-border pt-3"
                            >
                              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_2rem]">
                                <Input
                                  classNames={inputClassNames}
                                  aria-label={t("customParameterName")}
                                  placeholder="top_k"
                                  value={String(parameter.name)}
                                  onChange={(value) =>
                                    updateParameter({ name: value })
                                  }
                                  className="w-full"
                                />
                                <FormSelect
                                  label={t("customParameterType")}
                                  value={parameter.type}
                                  onValueChange={(value) =>
                                    updateParameter({
                                      type: value as AssistantCustomParameter["type"],
                                    })
                                  }
                                  options={[
                                    "string",
                                    "number",
                                    "boolean",
                                    "json",
                                  ].map((value) => ({ value, label: value }))}
                                />
                                {parameter.type === "number" ? (
                                  <Input
                                    classNames={inputClassNames}
                                    aria-label={valueLabel}
                                    type="number"
                                    value={String(
                                      typeof parameter.value === "number"
                                        ? parameter.value
                                        : 0,
                                    )}
                                    onChange={(value) =>
                                      updateParameter({
                                        value: Number.isFinite(
                                          Number.parseFloat(value),
                                        )
                                          ? Number.parseFloat(value)
                                          : 0,
                                      })
                                    }
                                    className="w-full"
                                  />
                                ) : parameter.type === "boolean" ? (
                                  <FormSelect
                                    label={valueLabel}
                                    value={String(parameter.value)}
                                    onValueChange={(value) =>
                                      updateParameter({
                                        value: value === "true",
                                      })
                                    }
                                    options={[
                                      { value: "true", label: "true" },
                                      { value: "false", label: "false" },
                                    ]}
                                  />
                                ) : parameter.type === "json" ? (
                                  <span className="hidden sm:block" />
                                ) : (
                                  <Input
                                    classNames={inputClassNames}
                                    aria-label={valueLabel}
                                    value={String(parameter.value)}
                                    onChange={(value) =>
                                      updateParameter({ value })
                                    }
                                    className="w-full"
                                  />
                                )}
                                <Button
                                  type="button"
                                  onClick={() =>
                                    setCustomParameters((current) =>
                                      current.filter(
                                        (_, currentIndex) =>
                                          currentIndex !== index,
                                      ),
                                    )
                                  }
                                  aria-label={common("delete")}
                                  title={common("delete")}
                                  variant={"ghost"}
                                  size={"icon"}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                              {parameter.type === "json" ? (
                                <textarea
                                  value={String(parameter.value)}
                                  onChange={(event) =>
                                    updateParameter({
                                      value: event.target.value,
                                    })
                                  }
                                  aria-label={valueLabel}
                                  rows={3}
                                  spellCheck={false}
                                  className="mt-1.5 min-h-36 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                                  placeholder={t(
                                    "customParameterJsonPlaceholder",
                                  )}
                                />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </DialogField>
              </section>

              <section
                hidden={createStep !== "tools"}
                aria-labelledby="assistant-create-tools-title"
                className="space-y-5"
              >
                <div>
                  <h3
                    id="assistant-create-tools-title"
                    className="text-base font-semibold text-foreground"
                  >
                    {t("mcpAccess")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("mcpDescription")}
                  </p>
                </div>

                <DialogField
                  label={t("maxToolSteps")}
                  htmlFor="assistant-settings-max-steps"
                  className="max-w-44"
                >
                  <Input
                    classNames={inputClassNames}
                    id="assistant-settings-max-steps"
                    name="maxSteps"
                    min={AGENT_STEP_BOUNDS.min}
                    max={AGENT_STEP_BOUNDS.max}
                    type="number"
                    defaultValue={String(
                      assistant?.maxSteps ?? AGENT_STEP_BOUNDS.default,
                    )}
                    aria-label={t("maxToolSteps")}
                    className="w-full"
                  />
                </DialogField>

                <fieldset className="space-y-3">
                  <legend className="sr-only">{t("mcpAccess")}</legend>
                  <div className="space-y-4">
                    {deployments.length ? (
                      deployments.map((deployment) => (
                        <DialogField
                          key={deployment.id}
                          label={
                            <>
                              {deployment.name}
                              <span
                                className={cx(
                                  "text-xs font-normal",
                                  deployment.status === "running"
                                    ? "text-primary"
                                    : "text-muted-foreground",
                                )}
                              >
                                {deployment.status}
                              </span>
                            </>
                          }
                        >
                          <FormCheckbox
                            checked={selectedDeployments.includes(
                              deployment.id,
                            )}
                            onCheckedChange={(checked) =>
                              setSelectedDeployments((current) =>
                                checked
                                  ? [...current, deployment.id]
                                  : current.filter(
                                      (id) => id !== deployment.id,
                                    ),
                              )
                            }
                            label={t("mcpEnabled")}
                          />
                        </DialogField>
                      ))
                    ) : (
                      <p className="py-4 text-sm text-muted-foreground">
                        {t("noMcp")}
                      </p>
                    )}
                  </div>
                </fieldset>
              </section>

              {assistant && createStep === "changelog" ? (
                <RevisionChangelog
                  url={`/api/v1/chat/assistants/${encodeURIComponent(assistant.id)}/revisions`}
                  title={t("changelog")}
                  className="space-y-5"
                />
              ) : null}

              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </DialogBody>
          </div>
          <DialogFooter
            start={
              assistant ? (
                <>
                  <p
                    role="status"
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span
                      className={cx(
                        "size-1.5 rounded-full",
                        dirty ? "bg-primary" : "bg-muted-foreground/50",
                      )}
                    />
                    {saving
                      ? t("saving")
                      : dirty
                        ? common("unsavedChanges")
                        : common("noChanges")}
                  </p>
                  <Button
                    type="button"
                    onClick={() => void onDelete(assistant.id)}
                    variant={"secondary"}
                    size={"md"}
                  >
                    <Trash2 className="size-4" />
                    {common("delete")}
                  </Button>
                </>
              ) : undefined
            }
            cancel={<DialogCancel />}
          >
            {creating && createStepIndex > 0 ? (
              <Button
                type="button"
                onClick={() => {
                  const previousStep = createSteps[createStepIndex - 1];
                  if (previousStep) setCreateStep(previousStep.id);
                }}
                variant={"secondary"}
                size={"md"}
                className="gap-2"
              >
                <ChevronLeft className="size-4" />
                {t("back")}
              </Button>
            ) : null}
            {creating && !lastCreateStep ? (
              <Button
                type="button"
                disabled={createStep === "basic" && !basicComplete}
                onClick={(event) => {
                  if (!event.currentTarget.form?.reportValidity()) return;
                  const nextStep = createSteps[createStepIndex + 1];
                  if (nextStep) setCreateStep(nextStep.id);
                }}
                variant={"primary"}
                size={"md"}
                className="gap-2"
              >
                {t("next")}
                <ChevronRight className="size-4" />
              </Button>
            ) : null}
            {creating && lastCreateStep ? (
              <Button
                type="submit"
                disabled={saving || !basicComplete}
                variant={"primary"}
                size={"md"}
                className="gap-2"
              >
                <Plus className="size-4" />
                {saving ? t("saving") : t("createAssistant")}
              </Button>
            ) : null}
            {!creating ? (
              <Button
                type="submit"
                disabled={saving}
                variant={"primary"}
                size={"md"}
              >
                {saving ? t("saving") : common("save")}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
