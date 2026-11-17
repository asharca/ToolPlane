"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { CenterMorphModalClose } from "@/components/motion/center-morph-modal";
import {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogField,
  DialogNav,
} from "@/components/dashboard/dialog";

import { useTranslations } from "next-intl";
import { Fragment, startTransition, useActionState, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
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
import { StatefulButton } from "@/components/motion/button/stateful";
import { DeleteAgentButton } from "@/components/dashboard/agents/DeleteAgentButton";
import { ConnectDialog } from "@/components/dashboard/ConnectDialog";
import { AGENT_STEP_BOUNDS } from "@/lib/agents/constants";
import {
  agentRuntimeDisplayName,
  agentRuntimeSupportsProviderFormat,
  isExecutableAgentRuntimeKind,
} from "@/lib/agents/runtime-kind";
import {
  AgentBuiltinFeatureInputs,
  AgentBuiltinFeatures,
} from "@/components/dashboard/agents/AgentBuiltinFeatures";
import { SystemPromptEditor } from "@/components/dashboard/SystemPromptEditor";
import { OmpImport } from "@/components/dashboard/agents/OmpImport";
import { ModelProviderNotice } from "@/components/dashboard/ModelProviderNotice";

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
  const runtime = "pi-sdk";
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
  const [desktop, setDesktop] = useState(false);
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [enabledOptionalTools, setEnabledOptionalTools] = useState<Set<string>>(
    () => new Set(),
  );
  const builtinFeatures = useTranslations("console.agents.builtinFeatures");
  const setupCount = agents.filter(
    (agent) =>
      isExecutableAgentRuntimeKind(agent.runtimeKind) && !isAgentReady(agent),
  ).length;
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
  }> = [
    {
      id: "basic",
      label: t("basic"),
    },
    {
      id: "instructions",
      label: t("instructions"),
    },
    {
      id: "builtInTools",
      label: builtinFeatures("title"),
    },
    { id: "mcp", label: t("mcp") },
    {
      id: "skills",
      label: t("skills"),
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
    setDesktop(false);
    setSelectedDeploymentIds(new Set());
    setSelectedSkillIds(new Set());
    setDisabledBuiltinTools(new Set());
    setEnabledOptionalTools(new Set());
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
        <ModelProviderNotice
          slug={slug}
          description={t("modelProviderRequiredDescription")}
        />
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
          onSubmit={(event) => {
            event.preventDefault();
            if (createPending || !createReady) return;
            const formData = new FormData(event.currentTarget);
            startTransition(() => createAction(formData));
          }}
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
          {desktop ? <input type="hidden" name="desktop" value="on" /> : null}
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <DialogNav
              label={t("configurationNavigation")}
              active={activeCreateStep}
              onSelect={(id) => {
                const index = createSteps.findIndex((step) => step.id === id);
                if (index <= createStepIndex) setCreateStep(id as CreateStep);
              }}
              items={createSteps.map((step, index) => {
                const dirty =
                  step.id === "basic"
                    ? agentName !== "" ||
                      agentDescription !== "" ||
                      desktop ||
                      maxSteps !== String(AGENT_STEP_BOUNDS.default) ||
                      providerId !== (defaultNativeModel?.providerId ?? "") ||
                      modelId !== (defaultNativeModel?.model ?? "")
                    : step.id === "instructions"
                      ? systemPrompt !== ""
                      : step.id === "builtInTools"
                        ? disabledBuiltinTools.size > 0 ||
                          enabledOptionalTools.size > 0
                        : step.id === "mcp"
                          ? selectedDeploymentIds.size > 0
                          : selectedSkillIds.size > 0;
                return {
                  id: step.id,
                  label: `${index + 1}. ${step.label}`,
                  dirty,
                  disabled: index > createStepIndex,
                };
              })}
            />

            <DialogBody className="flex min-w-0 flex-col overscroll-contain !p-0 !space-y-0 [scrollbar-width:thin]">
              <section
                hidden={activeCreateStep !== "basic"}
                aria-labelledby="agent-create-basic-title"
                className="space-y-6 px-6 py-5"
              >
                {!hasProviders ? (
                  <ModelProviderNotice
                    slug={slug}
                    description={t("modelProviderRequiredDescription")}
                  />
                ) : null}
                <div>
                  <h3
                    id="agent-create-basic-title"
                    className="text-xl font-semibold tracking-tight text-foreground"
                  >
                    {t("basic")}
                  </h3>
                </div>

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
                <input type="hidden" name="runtime" value={runtime} />
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

                <DialogField
                  label={t("model")}
                  dirty={
                    providerId !== (defaultNativeModel?.providerId ?? "") ||
                    modelId !== (defaultNativeModel?.model ?? "")
                  }
                  layout="row"
                >
                  <input type="hidden" name="providerId" value={providerId} />
                  <input type="hidden" name="model" value={modelId} />

                  <ModelPicker
                    className="flex w-72 max-w-full"
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
                      />
                    }
                  />
                </DialogField>
                <DialogField
                  label={t("desktopAndBrowser")}
                  description={t("desktopAndBrowserHint")}
                  dirty={desktop}
                  layout="row"
                >
                  <Switch
                    checked={desktop}
                    onCheckedChange={setDesktop}
                    disabled={createPending}
                    ariaLabel={t("desktopAndBrowser")}
                  />
                </DialogField>
                <DialogField
                  label={t("maxToolSteps")}
                  htmlFor="agent-create-max-steps"
                  dirty={maxSteps !== String(AGENT_STEP_BOUNDS.default)}
                  layout="row"
                >
                  <Input
                    id="agent-create-max-steps"
                    name="maxSteps"
                    type="number"
                    min={AGENT_STEP_BOUNDS.min}
                    max={AGENT_STEP_BOUNDS.max}
                    value={maxSteps}
                    onChange={setMaxSteps}
                    className="w-24"
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
                <h3
                  id="agent-create-built-in-tools-title"
                  className="text-xl font-semibold tracking-tight text-foreground"
                >
                  {builtinFeatures("title")}
                </h3>
                <AgentBuiltinFeatureInputs
                  runtimeKind={runtime}
                  disabledTools={disabledBuiltinTools}
                  enabledOptionalTools={enabledOptionalTools}
                />
                <AgentBuiltinFeatures
                  runtimeKind={runtime}
                  disabledTools={disabledBuiltinTools}
                  enabledOptionalTools={enabledOptionalTools}
                  onChange={(next) => {
                    setDisabledBuiltinTools(next.disabledTools);
                    setEnabledOptionalTools(next.enabledOptionalTools);
                  }}
                  disabled={createPending}
                />
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
          {createState.error ? (
            <p
              role="alert"
              className="mx-4 mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm leading-relaxed text-destructive sm:mx-6"
            >
              {t("createFailed", {
                reason: t.has(createState.error)
                  ? t(createState.error)
                  : createState.error,
              })}
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
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={createPending}
                  onClick={() => setImportingOmp(true)}
                  className="text-muted-foreground"
                >
                  {t("ompImport.title")}
                </Button>
              )
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
              <StatefulButton
                type="submit"
                size="md"
                state={createPending ? "loading" : "idle"}
                loadingText={t("creatingAgent")}
                aria-busy={createPending || undefined}
                disabled={!createReady || createPending}
                variant="primary"
                className="rounded-full px-3 sm:px-5"
              >
                <Plus className="size-[18px] shrink-0" />
                {t("createAndEnable")}
              </StatefulButton>
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
                const retired = !isExecutableAgentRuntimeKind(
                  agent.runtimeKind,
                );
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
                              status={
                                retired
                                  ? "neutral"
                                  : ready
                                    ? "success"
                                    : "warning"
                              }
                            >
                              {ready ? (
                                <CheckCircle2 className="size-3.5" />
                              ) : (
                                <CircleAlert className="size-3.5" />
                              )}
                              {retired
                                ? t("retiredRuntime")
                                : ready
                                  ? t("ready")
                                  : !agent.sandboxReady
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
                        {ready || retired ? (
                          <ButtonLink
                            href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(agent.id)}`}
                            aria-label={retired ? t("viewHistory") : t("chat")}
                            title={retired ? t("viewHistory") : t("chat")}
                            variant={retired ? "secondary" : "primary"}
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
