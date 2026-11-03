"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { CenterMorphModalClose } from "@/components/motion/center-morph-modal";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogField,
} from "@/components/dashboard/dialog";

import { useTranslations } from "next-intl";
import { Fragment, useActionState, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Box,
  Bot,
  CheckCircle2,
  CircleAlert,
  Cpu,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  PackageCheck,
  Plus,
  Server,
  Settings2,
  Wrench,
  Users,
  X,
} from "lucide-react";
import { createAgentAction } from "@/lib/agents/actions";
import {
  DashboardEmptyState,
  DashboardPage,
} from "@/components/dashboard/DashboardUI";
import { AgentResourceSelect } from "@/components/dashboard/agents/AgentResourceSelect";
import type { AgentResourceOption } from "@/components/dashboard/agents/AgentResourceSelect";
import {
  ModelPicker,
  ModelPickerTrigger,
} from "@/components/dashboard/models/ModelPicker";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { CloneAgentButton } from "@/components/dashboard/agents/CloneAgentButton";
import { DeleteAgentButton } from "@/components/dashboard/agents/DeleteAgentButton";
import { ConnectDialog } from "@/components/dashboard/ConnectDialog";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isExecutableAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";
import { AgentBuiltInTools } from "@/components/dashboard/agents/AgentBuiltInTools";
import { FormSelect } from "@/components/ui/FormSelect";
import { SystemPromptEditor } from "@/components/dashboard/SystemPromptEditor";
import { OmpImport } from "@/components/dashboard/agents/OmpImport";

export type AgentRow = {
  id: string;
  name: string;
  providerName: string | null;
  model: string | null;
  toolCount: number;
  subAgentCount: number;
  runtimeKind: string;
  runtimeStatus: string | null;
  sandboxReady: boolean;
};

type CreateOptions = {
  providers: Array<ModelProviderOption & { format: string }>;
  defaultModel?: { providerId: string; model: string } | null;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
};

type CreateStep = "basic" | "instructions" | "builtInTools" | "mcp" | "skills";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function isAgentReady(
  agent: Pick<
    AgentRow,
    "providerName" | "model" | "runtimeKind" | "sandboxReady"
  >,
) {
  if (isExecutableAgentRuntimeKind(agent.runtimeKind)) {
    return Boolean(agent.providerName && agent.model && agent.sandboxReady);
  }
  return false;
}

function CountPill({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 text-[11px] text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function AgentsBrowser({
  slug,
  workspaceId = "",
  agentControlEndpoint,
  agents,
  createOptions,
}: {
  slug: string;
  workspaceId?: string;
  agentControlEndpoint?: string;
  agents: AgentRow[];
  createOptions: CreateOptions;
}) {
  const t = useTranslations("console.agents");
  const pathname = usePathname() ?? `/app/${encodeURIComponent(slug)}/agents`;
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ""}`;
  const requestedReturnTo = searchParams.get("returnTo") ?? "";
  const createOnly = searchParams.get("create") === "1";
  const CancelContainer = createOnly ? CenterMorphModalClose : Fragment;
  const [createState, createAction, createPending] = useActionState(
    createAgentAction,
    {},
  );
  const [runtime, setRuntime] = useState<"pi-sdk" | "omp">("pi-sdk");
  const configuredDefaultNativeModel =
    createOptions.defaultModel &&
    createOptions.providers.some(
      (provider) =>
        provider.id === createOptions.defaultModel?.providerId &&
        provider.models.includes(createOptions.defaultModel.model) &&
        agentRuntimeSupportsProviderFormat(runtime, provider.format),
    )
      ? createOptions.defaultModel
      : null;
  const defaultNativeModel =
    configuredDefaultNativeModel ??
    (() => {
      const provider = createOptions.providers.find(
        (option) =>
          agentRuntimeSupportsProviderFormat(runtime, option.format) &&
          option.models.length > 0,
      );
      const model = provider?.models[0];
      return provider && model ? { providerId: provider.id, model } : null;
    })();
  const [creating, setCreating] = useState(createOnly);
  const [importingOmp, setImportingOmp] = useState(false);
  const [createStep, setCreateStep] = useState<CreateStep>("basic");
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxSteps, setMaxSteps] = useState(String(AGENT_STEP_BOUNDS.default));
  const [providerId, setProviderId] = useState(
    defaultNativeModel?.providerId ?? "",
  );
  const [modelId, setModelId] = useState(defaultNativeModel?.model ?? "");
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<Set<string>>(
    () => new Set(),
  );
  const setupCount = agents.filter((agent) => !isAgentReady(agent)).length;
  const hasProviders = createOptions.providers.length > 0;
  const compatibleProviders = createOptions.providers.filter((provider) =>
    agentRuntimeSupportsProviderFormat(runtime, provider.format),
  );
  const selectedProvider =
    compatibleProviders.find((provider) => provider.id === providerId) ?? null;
  const createReady =
    Boolean(agentName.trim()) &&
    Boolean(
      selectedProvider && modelId && selectedProvider.models.includes(modelId),
    );
  const createSteps: Array<{
    id: CreateStep;
    label: string;
    description: string;
  }> = [
    {
      id: "basic",
      label: t("basic"),
      description: t("generalSettingsDescription"),
    },
    {
      id: "instructions",
      label: t("instructions"),
      description: t("instructionsSettingsDescription"),
    },
    {
      id: "builtInTools",
      label: t("builtInTools"),
      description: t("builtInToolsDescription", {
        runtime: agentRuntimeDisplayName(runtime),
      }),
    },
    { id: "mcp", label: t("mcp"), description: t("mcpSettingsDescription") },
    {
      id: "skills",
      label: t("skills"),
      description: t("skillsSettingsDescription"),
    },
  ];
  const createStepIndex = Math.max(
    0,
    createSteps.findIndex((step) => step.id === createStep),
  );
  const activeCreateStep = createSteps[createStepIndex]?.id ?? "basic";
  const lastCreateStep = createStepIndex === createSteps.length - 1;

  function closeCreateForm() {
    setCreating(false);
    setImportingOmp(false);
    setCreateStep("basic");
    setAgentName("");
    setAgentDescription("");
    setSystemPrompt("");
    setMaxSteps(String(AGENT_STEP_BOUNDS.default));
    setProviderId(defaultNativeModel?.providerId ?? "");
    setModelId(defaultNativeModel?.model ?? "");
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setDisabledBuiltinTools(new Set());
  }

  return (
    <DashboardPage
      className={createOnly ? "h-full max-w-none p-0" : "space-y-5"}
    >
      {!createOnly ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-foreground">
              {t("agent")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("agentDescription")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!createOnly && agentControlEndpoint ? (
              <ConnectDialog
                endpoint={agentControlEndpoint}
                name={`${slug}-agent-control`}
                label={t("connectAi")}
                variant="outline"
              />
            ) : null}
            <Button
              type="button"
              disabled={importingOmp}
              onClick={() => {
                if (creating) closeCreateForm();
                else {
                  setCreating(true);
                }
              }}
              aria-controls="agent-create-form"
              aria-expanded={creating}
              variant={"primary"}
            >
              {creating ? (
                <X className="size-[18px] shrink-0" />
              ) : (
                <Plus className="size-[18px] shrink-0" />
              )}
              {creating ? t("cancel") : t("newAgent")}
            </Button>
          </div>
        </div>
      ) : null}

      {!hasProviders && !creating ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground text-muted-foreground" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t("modelProviderRequired")}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("modelProviderRequiredDescription")}
              </p>
            </div>
          </div>
          <ButtonLink
            href={`/app/${encodeURIComponent(slug)}/providers`}
            variant="secondary"
            className="shrink-0"
          >
            <Cpu className="size-4" />
            {t("addModelProvider")}
          </ButtonLink>
        </div>
      ) : null}

      {creating && importingOmp ? (
        <OmpImport
          slug={slug}
          providers={createOptions.providers}
          defaultModel={createOptions.defaultModel}
          createOnly={createOnly}
          onBack={() => setImportingOmp(false)}
          onCancel={closeCreateForm}
        />
      ) : creating ? (
        <form
          id="agent-create-form"
          action={createAction}
          className={cx(
            "flex min-h-0 flex-col overflow-hidden bg-background text-foreground",
            createOnly
              ? "h-full"
              : "min-h-[38rem] max-h-[calc(100dvh-10rem)] rounded-3xl border border-border bg-card shadow-sm",
          )}
        >
          {!createOnly ? <DialogHeader title={t("createAgent")} /> : null}
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="returnTo" value={requestedReturnTo} />
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav
              aria-label={t("configurationNavigation")}
              className="shrink-0 border-b border-border/60 bg-muted/25 sm:w-44 sm:border-b-0 sm:border-r"
            >
              <div className="hidden px-5 pb-3 pt-6 text-xs font-medium text-muted-foreground sm:block">
                {createStepIndex + 1} / {createSteps.length}
                <span className="mx-2 text-border">·</span>
                {agentRuntimeDisplayName(runtime)}
              </div>
              <ol className="grid grid-cols-5 gap-1 p-3 sm:flex sm:flex-col sm:gap-1.5 sm:px-3 sm:pb-6 sm:pt-0">
                {createSteps.map((step, index) => {
                  const active = index === createStepIndex;
                  const dirty =
                    step.id === "basic"
                      ? agentName !== "" ||
                        agentDescription !== "" ||
                        maxSteps !== String(AGENT_STEP_BOUNDS.default) ||
                        providerId !== (defaultNativeModel?.providerId ?? "") ||
                        modelId !== (defaultNativeModel?.model ?? "")
                      : step.id === "instructions"
                        ? systemPrompt !== ""
                        : step.id === "builtInTools"
                          ? disabledBuiltinTools.size > 0
                          : step.id === "mcp"
                            ? selectedDeploymentIds.size > 0
                            : selectedSkillIds.size > 0;
                  const done = index < createStepIndex;
                  return (
                    <li key={step.id} className="min-w-0">
                      <Button
                        type="button"
                        aria-current={active ? "step" : undefined}
                        aria-label={step.label}
                        disabled={index > createStepIndex}
                        onClick={() => {
                          if (done) setCreateStep(step.id);
                        }}
                        variant={active ? "secondary" : "ghost"}
                        className={cx(
                          "h-auto w-full flex-col gap-1.5 rounded-xl px-1 py-2 text-sm sm:flex-row sm:justify-start sm:gap-3 sm:px-3 sm:py-2.5",
                          active &&
                            "bg-background font-medium shadow-sm ring-1 ring-border/60",
                        )}
                      >
                        <span
                          className={cx(
                            "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
                            active || done
                              ? "bg-foreground text-background"
                              : "border border-border text-muted-foreground",
                          )}
                        >
                          {done ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <span className="max-w-full truncate">
                          {step.label}
                        </span>
                        {dirty ? (
                          <span
                            aria-hidden="true"
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                      </Button>
                    </li>
                  );
                })}
              </ol>
            </nav>

            <DialogBody className="flex min-w-0 flex-col overscroll-contain !p-0 !space-y-0 [scrollbar-width:thin]">
              <section
                hidden={activeCreateStep !== "basic"}
                aria-labelledby="agent-create-basic-title"
                className="space-y-6 px-6 py-5"
              >
                <div>
                  <h3
                    id="agent-create-basic-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("basic")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("generalSettingsDescription")}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4">
                  <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
                    {t("ompImport.entryHelp")}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={createPending}
                    onClick={() => setImportingOmp(true)}
                  >
                    {t("ompImport.title")}
                  </Button>
                </div>

                {!hasProviders ? (
                  <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
                    <CircleAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-40 flex-1">
                      <p className="text-sm font-semibold text-foreground">
                        {t("modelProviderRequired")}
                      </p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {t("modelProviderRequiredDescription")}
                      </p>
                    </div>
                    <ButtonLink
                      href={`/app/${encodeURIComponent(slug)}/providers`}
                      variant="secondary"
                      className="shrink-0"
                    >
                      <Cpu className="size-4" />
                      {t("addModelProvider")}
                    </ButtonLink>
                  </div>
                ) : null}

                <DialogField
                  label={t("name")}
                  htmlFor="agent-create-name"
                  dirty={agentName !== ""}
                >
                  <Input
                    id="agent-create-name"
                    name="name"
                    autoFocus
                    required
                    maxLength={60}
                    placeholder={t("egResearchAssistant")}
                    value={String(agentName)}
                    onChange={(value) => setAgentName(value)}
                    className="w-full"
                    classNames={{
                      label: "px-0 text-xs font-semibold",
                      field: "rounded-xl bg-muted/20",
                      input: "text-sm",
                    }}
                  />
                </DialogField>
                <DialogField label={t("runtime")}>
                  <FormSelect
                    label={t("runtime")}
                    name="runtime"
                    value={runtime}
                    disabled={createPending}
                    options={[
                      { value: "pi-sdk", label: "Pi" },
                      { value: "omp", label: "OMP" },
                    ]}
                    onValueChange={(value) => {
                      const next = value === "omp" ? "omp" : "pi-sdk";
                      setRuntime(next);
                      setDisabledBuiltinTools(new Set());
                      const compatible = createOptions.providers.filter(
                        (item) =>
                          agentRuntimeSupportsProviderFormat(next, item.format),
                      );
                      if (
                        !compatible.some(
                          (item) =>
                            item.id === providerId &&
                            item.models.includes(modelId),
                        )
                      ) {
                        setProviderId(compatible[0]?.id ?? "");
                        setModelId(compatible[0]?.models[0] ?? "");
                      }
                    }}
                  />
                </DialogField>
                <DialogField
                  label={t("model")}
                  dirty={
                    providerId !== (defaultNativeModel?.providerId ?? "") ||
                    modelId !== (defaultNativeModel?.model ?? "")
                  }
                >
                  <input type="hidden" name="providerId" value={providerId} />
                  <input type="hidden" name="model" value={modelId} />

                  <ModelPicker
                    className="flex w-full"
                    providers={compatibleProviders}
                    value={
                      providerId && modelId
                        ? { providerId, model: modelId }
                        : null
                    }
                    onSelect={(selection) => {
                      setProviderId(selection.providerId);
                      setModelId(selection.model);
                    }}
                    onConfigure={() => {
                      window.location.assign(
                        `/app/${encodeURIComponent(slug)}/providers`,
                      );
                    }}
                    trigger={
                      <ModelPickerTrigger
                        aria-label={`${t("model")}: ${modelId || t("selectModel")}`}
                        label={modelId || t("selectModel")}
                        placeholder={!modelId}
                        provider={selectedProvider?.name}
                        note={selectedProvider?.name}
                      />
                    }
                  />
                </DialogField>
                <DialogField
                  label={t("description")}
                  htmlFor="agent-create-description"
                  dirty={agentDescription !== ""}
                >
                  <textarea
                    id="agent-create-description"
                    name="description"
                    value={agentDescription}
                    onChange={(event) =>
                      setAgentDescription(event.target.value)
                    }
                    maxLength={500}
                    rows={3}
                    placeholder={t("agentDescriptionPlaceholder")}
                    className="min-h-24 w-full resize-y rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 text-sm leading-6 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
                  />
                </DialogField>

                <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <Box className="mt-0.5 size-4 shrink-0" />
                  <p>{t("automaticSandboxHelp")}</p>
                </div>
                {runtime !== "omp" ? (
                  <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
                    <p>{t("piPackageSecurity")}</p>
                    <p>{t("piPackageHeadless")}</p>
                    <p>{t("piSdkCreateHelp")}</p>
                  </div>
                ) : null}
                <DialogField
                  label={t("maxToolSteps")}
                  htmlFor="agent-create-max-steps"
                  dirty={maxSteps !== String(AGENT_STEP_BOUNDS.default)}
                >
                  <Input
                    id="agent-create-max-steps"
                    name="maxSteps"
                    type="number"
                    min={AGENT_STEP_BOUNDS.min}
                    max={AGENT_STEP_BOUNDS.max}
                    value={maxSteps}
                    onChange={setMaxSteps}
                    className="mt-1.5 w-full"
                    classNames={{
                      label: "px-0 text-xs font-semibold",
                      field: "rounded-xl bg-muted/20",
                      input: "text-sm",
                    }}
                  />
                </DialogField>
              </section>

              <section
                hidden={activeCreateStep !== "instructions"}
                aria-labelledby="agent-create-instructions-title"
                className="flex flex-1 flex-col gap-6 px-6 py-5"
              >
                <div>
                  <h3
                    id="agent-create-instructions-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("instructions")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("instructionsSettingsDescription")}
                  </p>
                </div>
                <SystemPromptEditor
                  workspaceId={workspaceId}
                  name={agentName}
                  description={agentDescription}
                  providerId={providerId}
                  model={modelId}
                  value={systemPrompt}
                  onChange={setSystemPrompt}
                  maxLength={100_000}
                  placeholder={t("youAreAHelpfulAssistant")}
                  dirty={systemPrompt !== ""}
                />
              </section>

              <section
                hidden={activeCreateStep !== "builtInTools"}
                aria-labelledby="agent-create-built-in-tools-title"
                className="space-y-6 px-6 py-5"
              >
                <div>
                  <h3
                    id="agent-create-built-in-tools-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("builtInTools")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("builtInToolsDescription", {
                      runtime: agentRuntimeDisplayName(runtime),
                    })}
                  </p>
                </div>
                <DialogField
                  label={t("builtInTools")}
                  dirty={disabledBuiltinTools.size > 0}
                >
                  <AgentBuiltInTools
                    runtimeKind={runtime}
                    disabledTools={disabledBuiltinTools}
                    onDisabledToolsChange={setDisabledBuiltinTools}
                  />
                </DialogField>
              </section>

              <section
                hidden={activeCreateStep !== "mcp"}
                aria-labelledby="agent-create-mcp-title"
                className="space-y-6 px-6 py-5"
              >
                <div>
                  <h3
                    id="agent-create-mcp-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("mcp")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("mcpSettingsDescription")}
                  </p>
                </div>
                <DialogField
                  label={t("mcp")}
                  dirty={selectedDeploymentIds.size > 0}
                >
                  <AgentResourceSelect
                    icon={Server}
                    label={t("mcp")}
                    name="deploymentId"
                    options={createOptions.deployments}
                    selectedIds={selectedDeploymentIds}
                    onSelectionChange={setSelectedDeploymentIds}
                  />
                </DialogField>
              </section>

              <section
                hidden={activeCreateStep !== "skills"}
                aria-labelledby="agent-create-skills-title"
                className="space-y-6 px-6 py-5"
              >
                <div>
                  <h3
                    id="agent-create-skills-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("skills")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("skillsSettingsDescription")}
                  </p>
                </div>
                <DialogField
                  label={t("skills")}
                  dirty={selectedSkillIds.size > 0}
                >
                  <AgentResourceSelect
                    icon={PackageCheck}
                    label={t("skills")}
                    name="installedSkillId"
                    options={createOptions.skills}
                    selectedIds={selectedSkillIds}
                    onSelectionChange={setSelectedSkillIds}
                  />
                </DialogField>
              </section>
            </DialogBody>
          </div>
          {lastCreateStep ? (
            <p className="mx-4 mb-3 rounded-xl bg-muted/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:mx-6">
              {t("createReadyHelp")}
            </p>
          ) : null}
          {createState.error ? (
            <p
              role="alert"
              className="mx-4 mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm leading-relaxed text-destructive sm:mx-6"
            >
              {t("createFailed", { reason: createState.error })}
            </p>
          ) : null}

          <DialogFooter
            start={
              createStepIndex > 0 ? (
                <Button
                  type="button"
                  size="md"
                  onClick={() => {
                    const previous = createSteps[createStepIndex - 1];
                    if (previous) setCreateStep(previous.id);
                  }}
                  variant="secondary"
                >
                  <ChevronLeft className="size-4 shrink-0" />
                  {t("back")}
                </Button>
              ) : undefined
            }
            cancel={
              <CancelContainer>
                <Button
                  type="button"
                  size="md"
                  onClick={createOnly ? undefined : closeCreateForm}
                  variant="ghost"
                >
                  {t("cancel")}
                </Button>
              </CancelContainer>
            }
          >
            {lastCreateStep ? (
              <SubmitButton
                size="md"
                pendingLabel={t("creatingAgent")}
                savedLabel={t("agentCreated")}
                disabled={!createReady || createPending}
                variant="primary"
                className="rounded-full px-3 sm:px-5"
              >
                <Plus className="size-[18px] shrink-0" />
                {t("createAndEnable")}
              </SubmitButton>
            ) : (
              <Button
                type="button"
                size="md"
                disabled={activeCreateStep === "basic" && !createReady}
                onClick={() => {
                  const form = document.getElementById(
                    "agent-create-form",
                  ) as HTMLFormElement | null;
                  if (
                    activeCreateStep === "basic" &&
                    form &&
                    !form.reportValidity()
                  )
                    return;
                  const next = createSteps[createStepIndex + 1];
                  if (next) setCreateStep(next.id);
                }}
                variant={"primary"}
                className="rounded-full px-3 sm:px-5"
              >
                {t("next")}
                <ChevronRight className="size-4 shrink-0" />
              </Button>
            )}
          </DialogFooter>
        </form>
      ) : null}

      {!creating &&
        (agents.length === 0 ? (
          <DashboardEmptyState
            icon={Bot}
            title={t("noAgentsYet")}
            description={
              hasProviders
                ? t(
                    "createAnAgentThenConnectItToToolsAndExternalMessagingAdapters",
                  )
                : t(
                    "addAModelProviderCreateAnAgentThenConnectItToToolsAndExternalMessagingAdapters",
                  )
            }
            actions={
              !hasProviders ? (
                <ButtonLink
                  href={`/app/${encodeURIComponent(slug)}/providers`}
                  variant="secondary"
                >
                  <Cpu className="size-4" />
                  {t("addModelProvider")}
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <section className="overflow-hidden border-y border-border bg-background lg:border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t("agents")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {setupCount > 0
                    ? t("agentsNeedConfiguration", { count: setupCount })
                    : t("allAgentsConfigured")}
                </p>
              </div>
            </div>

            <ul className="divide-y divide-border">
              {agents.map((agent) => {
                const ready = isAgentReady(agent);
                const agentsHref = `/app/${encodeURIComponent(slug)}/agents`;
                const detailsHref = `${agentsHref}/${encodeURIComponent(agent.id)}?returnTo=${encodeURIComponent(returnTo)}`;
                const model = agent.providerName
                  ? `${agent.providerName} / ${agent.model ?? t("noModelSelected")}`
                  : t("noProviderSelected");

                return (
                  <li
                    key={agent.id}
                    className="transition-colors hover:bg-muted/40"
                  >
                    <div className="grid gap-4 px-4 py-3.5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                      <div className="flex min-w-0 items-start gap-3">
                        <div
                          className={cx(
                            "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted",
                            ready
                              ? "text-muted-foreground"
                              : "text-muted-foreground text-muted-foreground",
                          )}
                        >
                          {ready ? (
                            <Bot className="size-[18px]" />
                          ) : (
                            <CircleAlert className="size-[18px]" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <Link
                              href={detailsHref}
                              className="truncate text-base font-semibold text-foreground hover:underline"
                            >
                              {agent.name}
                            </Link>
                            <AnimatedBadge
                              status={ready ? "success" : "warning"}
                            >
                              {ready ? (
                                <CheckCircle2 className="size-3.5" />
                              ) : (
                                <CircleAlert className="size-3.5" />
                              )}
                              {ready
                                ? t("ready")
                                : isExecutableAgentRuntimeKind(
                                      agent.runtimeKind,
                                    ) && !agent.sandboxReady
                                  ? t("needsSandbox")
                                  : !agent.providerName
                                    ? t("needsProvider")
                                    : t("needsModel")}
                            </AnimatedBadge>
                            <AnimatedBadge status="neutral">
                              <Bot className="size-3.5" />
                              {agentRuntimeDisplayName(agent.runtimeKind)}
                              {agent.runtimeStatus
                                ? ` · ${agent.runtimeStatus}`
                                : ""}
                            </AnimatedBadge>
                          </div>
                          <p className="mt-1 truncate text-sm text-muted-foreground">
                            {t("model")}: {model}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-3">
                            <CountPill
                              icon={Wrench}
                              label={t("tools")}
                              value={agent.toolCount}
                            />
                            <CountPill
                              icon={Users}
                              label={t("subagents")}
                              value={agent.subAgentCount}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2.5 lg:justify-end">
                        {ready ? (
                          <ButtonLink
                            href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(agent.id)}`}
                            aria-label={t("chat")}
                            title={t("chat")}
                            variant="primary"
                            size="icon"
                            className="shrink-0"
                          >
                            <MessageSquare className="size-[18px] shrink-0" />
                          </ButtonLink>
                        ) : null}
                        <ButtonLink
                          href={detailsHref}
                          aria-label={t("settings")}
                          title={t("settings")}
                          variant="secondary"
                          size="icon"
                          className="shrink-0"
                        >
                          <Settings2 className="size-[18px] shrink-0" />
                        </ButtonLink>
                        <CloneAgentButton
                          slug={slug}
                          agentId={agent.id}
                          agentName={agent.name}
                        />
                        <DeleteAgentButton slug={slug} agentId={agent.id} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </DashboardPage>
  );
}
