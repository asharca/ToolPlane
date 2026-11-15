"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowUp,
  Box,
  Cable,
  LoaderCircle,
  PackageCheck,
  Server,
  Trash2,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { FormSelect } from "@/components/ui/FormSelect";
import { StatusBadge } from "../StatusBadge";
import {
  EXTERNAL_SANDBOX_ACCESS,
  MAX_EXTERNAL_SANDBOXES,
  type ExternalSandboxAccess,
} from "@/lib/sandboxes/external";
import {
  DialogBody,
  DialogCancel,
  DialogField,
  DialogFooter,
  DialogNav,
} from "../dialog";
import { useCloseSettingsModal } from "../SettingsModal";
import { notify } from "../Toaster";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
  type ModelSelection,
} from "@/components/dashboard/models/ModelPicker";
import {
  AgentResourceSelect,
  type AgentResourceOption,
} from "./AgentResourceSelect";
import { AgentBuiltInTools } from "./AgentBuiltInTools";
import {
  AgentStreamRulesEditor,
  useStreamRulesDraft,
} from "./AgentStreamRulesEditor";
import { ToolApprovalSettings } from "./ToolApprovalSettings";
import type { ToolApprovalPolicy } from "@/lib/agents/tool-approval-policy";
import { SystemPromptEditor } from "../SystemPromptEditor";
import type { AgentPluginCapabilityDiff } from "./AgentPluginSyncReview";
import {
  AgentPluginsPanel,
  MAX_AGENT_PLUGINS,
  type AgentPluginCatalogOption,
} from "./AgentPluginsPanel";
import type { PluginBindingDeployment } from "@/lib/plugins/binding-deployments";
import {
  prepareAgentRevisionAction,
  publishAgentRevisionAction,
  updateAgentAction,
} from "@/lib/agents/actions";
import {
  createAgentEnvironmentCredentialAction,
  listAgentEnvironmentCredentialsAction,
  revokeAgentEnvironmentCredentialAction,
} from "@/lib/agents/environment-credential-actions";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import {
  buildAgentRevisionDiff,
  type AgentRevisionDiff,
} from "@/lib/revisions/config-diff";
import { RevisionFileDiff } from "../RevisionFileDiff";
import {
  AGENT_STEP_BOUNDS,
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  normalizeReasoningEffort,
  selectionSupportsReasoning,
  type ReasoningEffort,
  type ReasoningLevel,
} from "@/lib/agents/constants";
import { REASONING_EFFORT_LABELS } from "./ReasoningEffortControl";
import {
  agentPermissionAdditions,
  type AgentPermissionAddition,
} from "@/lib/agents/permission-additions";
import {
  isExecutableAgentRuntimeKind,
  agentRuntimeSupportsProviderFormat,
  type AgentOptionalBuiltinTool,
} from "@/lib/agents/runtime-kind";
import {
  SubagentResources,
  type SubagentDraft,
  type SubagentResourcesSnapshot,
} from "./SubagentResources";
import {
  usePluginAgentFlow,
  type PluginSelectionResult,
} from "../plugins/usePluginAgentFlow";

export type AgentSettingsSection =
  | "general"
  | "instructions"
  | "builtInTools"
  | "streamRules"
  | "toolApproval"
  | "mcp"
  | "skills"
  | "piPackages"
  | "sandboxes"
  | "subAgents"
  | "advanced";
export type AgentPiPackageOption = {
  marketInstallId: string;
  listingId: string;
  name: string;
  summary?: string | null;
  skillCount?: number;
  extensionCount?: number;
  mcpRequirementCount?: number;
  currentReleaseId: string | null;
  currentVersion: string | null;
  currentAvailable: boolean;
  enabledReleaseId: string | null;
  enabledVersion: string | null;
  syncStatus: string;
  syncError: string | null;
  targetVersion: string | null;
  targetReleaseId: string | null;
  capabilityDiff: AgentPluginCapabilityDiff | null;
  capabilities: {
    runtimeKind: string;
    hooks: string[];
    extensions: string[];
    tools: string[];
    commands: string[];
  } | null;
};
export type AgentOwnSandbox = {
  id: string;
  name: string;
  kind: string;
  image: string | null;
  network: string;
  status: string;
};
export type AgentExternalSandbox = {
  id: string;
  name: string;
  kind: string;
  status: string;
  access: ExternalSandboxAccess | null;
};
type Props = {
  slug: string;
  workspaceId?: string;
  agentId: string;
  runtimeKind: string;
  name: string;
  description?: string;
  systemPrompt: string;
  contextFiles: boolean;
  disabledBuiltinTools?: string[];
  optionalBuiltinTools: string[];
  optionalBuiltinToolOptions: readonly AgentOptionalBuiltinTool[];
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningLevel | null;
  toolApproval?: ToolApprovalPolicy;
  secretObfuscation: boolean;
  maxSteps: number;
  providers: Array<ModelProviderOption & { format: string }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  piPackages?: AgentPiPackageOption[];
  pluginCatalog?: AgentPluginCatalogOption[];
  pluginDeployments?: PluginBindingDeployment[];
  ownSandbox: AgentOwnSandbox | null;
  externalSandboxes: AgentExternalSandbox[];
  publishedRevision?: {
    id: string;
    version: number;
    config: AgentRevisionConfig;
  } | null;
  canManageCredentials?: boolean;
  canApprovePluginSync?: boolean;
  className?: string;
  activeSection?: AgentSettingsSection;
  onSectionChange?: (section: AgentSettingsSection) => void;
  onDirtySectionsChange?: (sections: AgentSettingsSection[]) => void;
  showNavigation?: boolean;
};
function selected(options: AgentResourceOption[]) {
  return new Set(
    options.filter((option) => option.checked).map((option) => option.id),
  );
}
export function AgentSettingsForm(props: Props) {
  const {
    slug,
    agentId,
    workspaceId = "",
    runtimeKind,
    providers,
    deployments,
    skills,
    ownSandbox,
    externalSandboxes,
    piPackages: initialPiPackages = [],
    pluginCatalog = [],
    pluginDeployments = [],
    publishedRevision = null,
    canManageCredentials = false,
    canApprovePluginSync = false,
  } = props;
  const t = useTranslations("console.agents");
  const r = useTranslations("console.agents.revisions");
  const streamRules = useStreamRulesDraft(
    slug,
    agentId,
    runtimeKind === "pi-sdk",
  );
  const approvalT = useTranslations("console.toolApproval");
  const s = useTranslations("console.sandboxes");
  const diffT = useTranslations("console.revisionDiff");
  const router = useRouter();
  const closeModal = useCloseSettingsModal();
  const formId = useId();
  const settingsState = useTranslations("common");
  const [section, setSection] = useState<AgentSettingsSection>("general");
  const active = props.activeSection ?? section;
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState(props.description ?? "");
  const [prompt, setPrompt] = useState(props.systemPrompt);
  const [contextFiles, setContextFiles] = useState(props.contextFiles);
  const [provider, setProvider] = useState(props.providerId ?? "");
  const [model, setModel] = useState(props.model ?? "");
  const [fallbackModels, setFallbackModels] = useState(() =>
    (publishedRevision?.config.fallbackModels ?? []).map((selection) => ({
      id: crypto.randomUUID(),
      selection,
    })),
  );
  const [roleModels, setRoleModels] = useState<
    NonNullable<AgentRevisionConfig["roleModels"]>
  >(publishedRevision?.config.roleModels ?? {});
  const modelProviders = providers
    .filter((item) =>
      agentRuntimeSupportsProviderFormat(runtimeKind, item.format),
    )
    .map((item) => ({
      ...item,
      models: item.models.filter((id) =>
        /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(id),
      ),
    }));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    props.reasoningEffort ?? DEFAULT_REASONING_LEVEL,
  );
  const [toolApproval, setToolApproval] = useState<ToolApprovalPolicy>(
    props.toolApproval ?? { mode: "off" },
  );
  const [secretObfuscation, setSecretObfuscation] = useState(
    props.secretObfuscation,
  );
  const [steps, setSteps] = useState(String(props.maxSteps));
  const [disabledTools, setDisabledTools] = useState(
    new Set(props.disabledBuiltinTools ?? []),
  );
  const [enabledOptionalTools, setEnabledOptionalTools] = useState(
    () => new Set(props.optionalBuiltinTools),
  );
  const [deploymentIds, setDeploymentIds] = useState(() =>
    selected(deployments),
  );
  const [skillIds, setSkillIds] = useState(() => selected(skills));
  const initialAttachments = externalSandboxes.flatMap((sandbox) =>
    sandbox.access ? [{ sandboxId: sandbox.id, access: sandbox.access }] : [],
  );
  const [attachments, setAttachments] = useState(initialAttachments);
  const attachmentsDirty =
    JSON.stringify(attachments) !== JSON.stringify(initialAttachments);
  const [subagentSnapshot, setSubagentSnapshot] =
    useState<SubagentResourcesSnapshot | null>(null);
  const [subagentDraft, setSubagentDraft] = useState<SubagentDraft | null>(
    null,
  );
  const initialSubagentIds = new Set(
    subagentSnapshot?.agents
      .filter((agent) => agent.checked)
      .map((agent) => agent.id),
  );
  const subagentsDirty = Boolean(
    subagentDraft &&
      subagentSnapshot &&
      (subagentDraft.native !== subagentSnapshot.native ||
        subagentDraft.agentIds.length !== initialSubagentIds.size ||
        subagentDraft.agentIds.some((id) => !initialSubagentIds.has(id)) ||
        (subagentDraft.native &&
          (subagentDraft.nativePolicy.maxConcurrency !==
            subagentSnapshot.nativePolicy.maxConcurrency ||
            subagentDraft.nativePolicy.maxDepth !==
              subagentSnapshot.nativePolicy.maxDepth))),
  );
  const [piPackages, setPiPackages] = useState(initialPiPackages);
  const [packages, setPackages] = useState(() =>
    piPackages.flatMap((pkg) =>
      pkg.enabledReleaseId
        ? [
            {
              marketInstallId: pkg.marketInstallId,
              releaseId: pkg.enabledReleaseId,
            },
          ]
        : [],
    ),
  );
  const [environment, setEnvironment] = useState(() =>
    publishedRevision
      ? JSON.stringify(publishedRevision.config.environment, null, 2)
      : "",
  );
  const [review, setReview] = useState<{
    expectedRevisionId: string | null;
    config: AgentRevisionConfig;
    additions: AgentPermissionAddition[];
    diff: AgentRevisionDiff;
    fallbackRows: Record<"before" | "after", typeof fallbackModels>;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(publishedRevision?.id ?? "");
  const [appliedConfig, setAppliedConfig] = useState(
    publishedRevision?.config ?? null,
  );
  const fallbackSelections = fallbackModels.map((item) => item.selection);
  const fallbackModelsDirty =
    JSON.stringify(fallbackSelections) !==
    JSON.stringify(appliedConfig?.fallbackModels ?? []);
  const roleModelDirty = (role: "compaction" | "title") =>
    roleModels[role]?.providerId !==
      appliedConfig?.roleModels?.[role]?.providerId ||
    roleModels[role]?.model !== appliedConfig?.roleModels?.[role]?.model;
  const hasUnsavedChanges =
    dirty ||
    subagentsDirty ||
    streamRules.dirty ||
    fallbackModelsDirty ||
    roleModelDirty("compaction") ||
    roleModelDirty("title") ||
    environment !==
      (appliedConfig ? JSON.stringify(appliedConfig.environment, null, 2) : "");
  const sameSet = (left: Set<string>, right: Set<string>) =>
    left.size === right.size && [...left].every((id) => right.has(id));
  const fieldDirty = {
    name: name !== props.name,
    description: description !== (props.description ?? ""),
    model:
      provider !== (props.providerId ?? "") ||
      model !== (props.model ?? "") ||
      fallbackModelsDirty ||
      roleModelDirty("compaction") ||
      roleModelDirty("title"),
    reasoningEffort:
      reasoningEffort !== (props.reasoningEffort ?? DEFAULT_REASONING_LEVEL),
    instructions:
      prompt !== props.systemPrompt || contextFiles !== props.contextFiles,
    streamRules: streamRules.dirty,
    builtInTools:
      !sameSet(disabledTools, new Set(props.disabledBuiltinTools ?? [])) ||
      !sameSet(enabledOptionalTools, new Set(props.optionalBuiltinTools)),
    toolApproval:
      JSON.stringify(toolApproval) !==
      JSON.stringify(props.toolApproval ?? { mode: "off" }),
    secretObfuscation: secretObfuscation !== props.secretObfuscation,
    mcp: !sameSet(deploymentIds, selected(deployments)),
    skills: !sameSet(skillIds, selected(skills)),
    sandboxes:
      attachmentsDirty ||
      environment !==
        (appliedConfig
          ? JSON.stringify(appliedConfig.environment, null, 2)
          : ""),
    subAgents: subagentsDirty,
    piPackages:
      JSON.stringify(packages) !==
      JSON.stringify(
        initialPiPackages.flatMap((pkg) =>
          pkg.enabledReleaseId
            ? [
                {
                  marketInstallId: pkg.marketInstallId,
                  releaseId: pkg.enabledReleaseId,
                },
              ]
            : [],
        ),
      ),
    advanced: steps !== String(props.maxSteps),
  };
  const dirtySections: AgentSettingsSection[] = [
    ...(fieldDirty.name ||
    fieldDirty.description ||
    fieldDirty.model ||
    fieldDirty.reasoningEffort ||
    fieldDirty.secretObfuscation
      ? ["general" as const]
      : []),
    ...(
      [
        "instructions",
        "builtInTools",
        "streamRules",
        "toolApproval",
        "mcp",
        "skills",
        "sandboxes",
        "subAgents",
        "piPackages",
        "advanced",
      ] as const
    ).filter((id) => fieldDirty[id]),
  ];
  const dirtySectionKey = dirtySections.join(",");
  useEffect(() => {
    props.onDirtySectionsChange?.(
      dirtySectionKey
        ? (dirtySectionKey.split(",") as AgentSettingsSection[])
        : [],
    );
  }, [dirtySectionKey, props.onDirtySectionsChange]);
  const [credentials, setCredentials] = useState<
    Array<{ id: string; name: string; revokedAt: Date | null }>
  >([]);
  const [credentialName, setCredentialName] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  function changed() {
    setDirty(true);
    setReview(null);
    setMessage("");
  }
  function modelLabel(selection: ModelSelection | null | undefined) {
    if (!selection) return t("modelRouting.usePrimary");
    const providerName = providers.find(
      (item) => item.id === selection.providerId,
    )?.name;
    return `${providerName ?? selection.providerId} / ${selection.model}`;
  }
  function modelPicker(
    selection: ModelSelection | null,
    label: string,
    onSelect: (selection: ModelSelection) => void,
    placeholder = label,
  ) {
    const available =
      selection &&
      modelProviders.some(
        (item) =>
          item.id === selection.providerId &&
          item.models.includes(selection.model),
      );
    return (
      <ModelPicker
        className="flex min-w-0 flex-1"
        providers={modelProviders}
        value={available ? selection : null}
        pending={pending}
        onSelect={(next) => {
          if (pending) return;
          onSelect(next);
          changed();
        }}
        trigger={
          <ModelPickerTrigger
            label={selection?.model ?? placeholder}
            provider={
              selection
                ? (providers.find((item) => item.id === selection.providerId)
                    ?.name ?? selection.providerId)
                : undefined
            }
            placeholder={!selection}
            disabled={pending}
            aria-label={label}
          />
        }
      />
    );
  }
  function selectPlugin(
    listingId: string,
    options: AgentPiPackageOption[],
  ): PluginSelectionResult {
    if (pending) return "busy";
    if (runtimeKind !== "pi-sdk") return "incompatible";
    // Refresh catalog metadata without replacing local selections or other fields.
    setPiPackages((previous) => [
      ...options,
      ...previous
        .filter(
          (option) =>
            packages.some(
              (entry) => entry.marketInstallId === option.marketInstallId,
            ) &&
            !options.some(
              (next) => next.marketInstallId === option.marketInstallId,
            ),
        )
        .map((option) => ({ ...option, currentAvailable: false })),
    ]);
    const option = options.find((item) => item.listingId === listingId);
    if (!option) return "unavailable";
    if (
      packages.some((entry) => entry.marketInstallId === option.marketInstallId)
    )
      return "duplicate";
    if (option.capabilities && option.capabilities.runtimeKind !== "pi-sdk")
      return "incompatible";
    if (!option.currentAvailable || !option.currentReleaseId)
      return "unavailable";
    if (packages.length >= MAX_AGENT_PLUGINS) return "limit";
    setPackages([
      ...packages,
      {
        marketInstallId: option.marketInstallId,
        releaseId: option.currentReleaseId,
      },
    ]);
    changed();
    setSection("piPackages");
    props.onSectionChange?.("piPackages");
    return "selected";
  }
  const pluginFlow = usePluginAgentFlow({
    slug,
    agentId,
    onSelect: selectPlugin,
  });
  function identity() {
    const data = new FormData();
    data.set("workspace", slug);
    data.set("agentId", agentId);
    return data;
  }
  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : String(failure);
      const text = t.has(`modelRouting.errors.${code}`)
        ? t(`modelRouting.errors.${code}`)
        : code;
      if (code === "AGENT_REVISION_CONFLICT") setReview(null);
      setError(text);
      notify(text, { severity: "error" });
    } finally {
      setPending(false);
    }
  }
  async function publish(prepared: {
    expectedRevisionId: string | null;
    config: AgentRevisionConfig;
  }) {
    const data = identity();
    data.set("expectedRevisionId", prepared.expectedRevisionId ?? "");
    data.set("config", JSON.stringify(prepared.config));
    const result = await publishAgentRevisionAction(data);
    if ("error" in result) {
      if (result.error !== "PI_CAPABILITY_CONFLICT")
        throw new Error(result.error);
      throw new Error(
        "conflict" in result && result.conflict
          ? r("capabilityConflict", {
              kind: r(`capabilityKinds.${result.conflict.kind}`),
              name: result.conflict.name,
            })
          : r("capabilityConflictUnknown"),
      );
    }
    setRevision(result.revisionId);
    setAppliedConfig(prepared.config);
    setReview(null);
    setMessage("");
    notify(r("publishedSuccess"));
    router.refresh();
    closeModal?.();
  }
  async function save(data: FormData) {
    await perform(async () => {
      setReview(null);
      await streamRules.save();
      const result = await updateAgentAction({}, data);
      if (result.error)
        throw new Error(t.has(result.error) ? t(result.error) : result.error);
      if (subagentsDirty && subagentDraft) {
        const response = await fetch(
          `/api/v1/agents/${encodeURIComponent(agentId)}/subagents`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspace: slug,
              ...subagentDraft,
            }),
          },
        );
        const result = (await response.json()) as SubagentResourcesSnapshot & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(
            result.error && t.has(`subagentResources.errors.${result.error}`)
              ? t(`subagentResources.errors.${result.error}`)
              : t("subagentResources.saveFailed"),
          );
        }
        setSubagentSnapshot(result);
        setSubagentDraft(null);
      }
      setDirty(false);
      const preparation = identity();
      if (environment.trim()) preparation.set("environment", environment);
      const preview = await prepareAgentRevisionAction(preparation);
      const prepared = {
        expectedRevisionId: preview.expectedRevisionId,
        config: JSON.parse(preview.configJson) as AgentRevisionConfig,
      };
      // Never classify against a different tab's newly applied configuration.
      if ((prepared.expectedRevisionId ?? "") !== revision)
        throw new Error(r("stale"));
      // Routing belongs to the reviewed revision, not the mutable Agent row.
      if (fallbackModelsDirty)
        prepared.config.fallbackModels = fallbackSelections;
      if (roleModelDirty("compaction") || roleModelDirty("title"))
        prepared.config.roleModels = roleModels;
      const routingProviderIds = [
        ...(prepared.config.fallbackModels ?? []).map(
          (target) => target.providerId,
        ),
        ...Object.values(prepared.config.roleModels ?? {}).flatMap((target) =>
          target ? [target.providerId] : [],
        ),
      ];
      const selectedProviderIds = new Set([
        prepared.config.providerId,
        ...routingProviderIds,
      ]);
      prepared.config.modelProviderIds = [
        ...new Set([
          ...prepared.config.modelProviderIds.filter((id) =>
            selectedProviderIds.has(id),
          ),
          ...routingProviderIds,
        ]),
      ];
      const additions = agentPermissionAdditions(
        appliedConfig,
        prepared.config,
      );
      setEnvironment(JSON.stringify(prepared.config.environment, null, 2));
      const diff = buildAgentRevisionDiff(appliedConfig, prepared.config);
      if (!diff.files.length) {
        notify(diffT("noChanges"));
        router.refresh();
        return;
      }
      setReview({
        ...prepared,
        additions,
        diff,
        fallbackRows: {
          before: (appliedConfig?.fallbackModels ?? []).map((selection) => ({
            id: crypto.randomUUID(),
            selection,
          })),
          after: fallbackModels,
        },
      });
      setMessage("");
    });
  }
  async function apply() {
    if (!review || dirty || subagentsDirty || streamRules.dirty) return;
    await perform(() => publish(review));
  }
  async function loadCredentials() {
    const result = await listAgentEnvironmentCredentialsAction(identity());
    if (result.error) throw new Error(result.error);
    setCredentials(result.credentials ?? []);
  }
  const sections: Array<[AgentSettingsSection, string]> = [
    ["general", t("basic")],
    ["instructions", t("instructions")],
    ["builtInTools", t("builtInTools")],
    ["streamRules", t("streamRules.title")],
    ["toolApproval", approvalT("title")],
    ["mcp", t("mcp")],
    ["skills", t("skills")],
    ["piPackages", t("piPackages")],
    ["sandboxes", t("sandboxes")],
    ...(isExecutableAgentRuntimeKind(runtimeKind)
      ? [["subAgents", t("subAgents")] as [AgentSettingsSection, string]]
      : []),
    ["advanced", t("advanced")],
  ];
  const textareaClass =
    "w-full rounded-lg border border-border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  // The instructions editor fills the dialog body, so its ancestors stretch.
  const fillBody =
    active === "instructions" && !review ? " flex flex-1 flex-col" : "";
  if (!isExecutableAgentRuntimeKind(runtimeKind))
    return (
      <div className={props.className}>
        <DialogBody>
          <p role="status">{r("legacy")}</p>
          <ButtonLink
            href={`/app/${encodeURIComponent(slug)}/agents?create=1`}
            variant="secondary"
          >
            {t("createAgent")}
          </ButtonLink>
          {error ? <p role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFooter cancel={<DialogCancel />} />
      </div>
    );
  return (
    <div className={props.className ?? "flex h-full min-h-0 flex-col"}>
      <DialogBody className="flex flex-col overscroll-contain">
        <div className={`space-y-6${fillBody}`}>
          <div hidden={Boolean(review)} className={`space-y-6${fillBody}`}>
            <header className="space-y-2 border-b border-border/60 pb-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-semibold tracking-tight">
                  {sections.find(([id]) => id === active)?.[1]}
                </h3>
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  {active === "piPackages"
                    ? t("piPackageAppliedCount", {
                        count: appliedConfig?.packages.length ?? 0,
                      })
                    : revision
                      ? r("published")
                      : r("unpublished")}
                </span>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                {r("explanation")}
              </p>
            </header>
            {props.showNavigation !== false ? (
              <DialogNav
                label={t("configurationNavigation")}
                items={sections.map(([id, label]) => ({
                  id,
                  label,
                  dirty: dirtySections.includes(id),
                }))}
                active={active}
                onSelect={(id) => {
                  setSection(id as AgentSettingsSection);
                  props.onSectionChange?.(id as AgentSettingsSection);
                }}
              />
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                // React action resets also reset Radix selects and invalidate review.
                if (!pending) void save(new FormData(event.currentTarget));
              }}
              id={formId}
              onChange={changed}
              data-unsaved-changes={hasUnsavedChanges ? "true" : "false"}
              className={`space-y-6${fillBody}`}
            >
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="providerId" value={provider} />
              <input type="hidden" name="model" value={model} />
              <input
                type="hidden"
                name="contextFiles"
                value={String(contextFiles)}
              />
              <input
                type="hidden"
                name="toolApproval"
                value={JSON.stringify(toolApproval)}
              />
              <input
                type="hidden"
                name="reasoningEffort"
                value={reasoningEffort}
              />
              <input
                type="hidden"
                name="secretObfuscation"
                value={String(secretObfuscation)}
              />
              <input
                type="hidden"
                name="piPackages"
                value={JSON.stringify(packages)}
              />
              <input
                type="hidden"
                name="externalSandboxes"
                value={JSON.stringify(attachments)}
              />
              <fieldset
                disabled={pending}
                className={`min-w-0 space-y-6${fillBody}`}
              >
                <section hidden={active !== "general"} className="space-y-5">
                  <DialogField
                    label={t("name")}
                    htmlFor={`${formId}-name`}
                    dirty={fieldDirty.name}
                  >
                    <Input
                      id={`${formId}-name`}
                      aria-label={t("name")}
                      name="name"
                      required
                      value={name}
                      onChange={setName}
                      className="w-full"
                    />
                  </DialogField>
                  <DialogField
                    label={t("description")}
                    htmlFor={`${formId}-description`}
                    dirty={fieldDirty.description}
                  >
                    <textarea
                      id={`${formId}-description`}
                      name="description"
                      value={description}
                      maxLength={500}
                      rows={3}
                      onChange={(event) => setDescription(event.target.value)}
                      className={textareaClass}
                    />
                  </DialogField>
                  <DialogField label={t("model")} dirty={fieldDirty.model}>
                    <ModelPicker
                      className="flex w-full"
                      providers={providers.filter((item) =>
                        agentRuntimeSupportsProviderFormat(
                          runtimeKind,
                          item.format,
                        ),
                      )}
                      value={
                        provider && model
                          ? { providerId: provider, model }
                          : null
                      }
                      onSelect={(selection) => {
                        setProvider(selection.providerId);
                        setModel(selection.model);
                        changed();
                      }}
                      onConfigure={() =>
                        window.location.assign(
                          `/app/${encodeURIComponent(slug)}/providers`,
                        )
                      }
                      trigger={
                        <ModelPickerTrigger
                          label={model || t("selectModel")}
                          placeholder={!model}
                          provider={
                            providers.find((item) => item.id === provider)?.name
                          }
                          aria-label={t("model")}
                        />
                      }
                    />
                  </DialogField>
                  <DialogField
                    label={t("modelRouting.fallbackModels")}
                    dirty={fallbackModelsDirty}
                  >
                    <ol className="space-y-2">
                      {fallbackModels.map((item, index) => (
                        <li
                          key={item.id}
                          className="flex min-w-0 flex-wrap items-center gap-2"
                        >
                          <span
                            className="w-4 text-xs tabular-nums text-muted-foreground"
                            aria-hidden="true"
                          >
                            {index + 1}
                          </span>
                          {modelPicker(
                            item.selection,
                            t("modelRouting.fallbackPosition", {
                              position: index + 1,
                            }),
                            (next) =>
                              setFallbackModels((current) =>
                                current.map((entry) =>
                                  entry.id === item.id
                                    ? { ...entry, selection: next }
                                    : entry,
                                ),
                              ),
                          )}
                          <div className="flex shrink-0 items-center">
                            {([-1, 1] as const).map((direction) => (
                              <Button
                                key={direction}
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={
                                  pending ||
                                  index + direction < 0 ||
                                  index + direction >= fallbackModels.length
                                }
                                aria-label={t(
                                  direction < 0
                                    ? "modelRouting.moveUp"
                                    : "modelRouting.moveDown",
                                  { position: index + 1 },
                                )}
                                onClick={() => {
                                  setFallbackModels((current) => {
                                    const next = [...current];
                                    [next[index], next[index + direction]] = [
                                      next[index + direction],
                                      next[index],
                                    ];
                                    return next;
                                  });
                                  changed();
                                }}
                              >
                                {direction < 0 ? (
                                  <ArrowUp
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ArrowDown
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                )}
                              </Button>
                            ))}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={pending}
                              aria-label={t("modelRouting.removeFallback", {
                                position: index + 1,
                              })}
                              onClick={() => {
                                setFallbackModels((current) =>
                                  current.filter(
                                    (_, position) => position !== index,
                                  ),
                                );
                                changed();
                              }}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {fallbackModels.length < 3
                      ? modelPicker(
                          null,
                          t("modelRouting.addFallback"),
                          (selection) => {
                            const item = { id: crypto.randomUUID(), selection };
                            setFallbackModels((current) =>
                              current.length < 3 ? [...current, item] : current,
                            );
                          },
                        )
                      : null}
                  </DialogField>
                  {(["compaction", "title"] as const).map((role) => (
                    <DialogField
                      key={role}
                      label={t(`modelRouting.${role}`)}
                      dirty={roleModelDirty(role)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {modelPicker(
                          roleModels[role] ?? null,
                          t(`modelRouting.${role}`),
                          (next) =>
                            setRoleModels((current) => ({
                              ...current,
                              [role]: next,
                            })),
                          t("modelRouting.usePrimary"),
                        )}
                        {roleModels[role] ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            aria-label={t("modelRouting.clearRole", {
                              role: t(`modelRouting.${role}`),
                            })}
                            onClick={() => {
                              setRoleModels((current) => {
                                const next = { ...current };
                                delete next[role];
                                return next;
                              });
                              changed();
                            }}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </DialogField>
                  ))}
                  {selectionSupportsReasoning(providers, {
                    providerId: provider,
                    model,
                  }) && (
                    <DialogField
                      label={t("defaultReasoningEffort")}
                      htmlFor={`${formId}-reasoning-effort`}
                      dirty={fieldDirty.reasoningEffort}
                    >
                      <FormSelect
                        id={`${formId}-reasoning-effort`}
                        label={t("defaultReasoningEffort")}
                        value={reasoningEffort}
                        disabled={pending}
                        options={REASONING_LEVELS.map((value) => ({
                          value,
                          label: t(REASONING_EFFORT_LABELS[value]),
                        }))}
                        onValueChange={(value) => {
                          setReasoningEffort(
                            normalizeReasoningEffort(value) ?? "default",
                          );
                          changed();
                        }}
                      />
                    </DialogField>
                  )}
                  <DialogField
                    label={t("secretObfuscation")}
                    dirty={fieldDirty.secretObfuscation}
                  >
                    <Switch
                      checked={secretObfuscation}
                      ariaLabel={t("secretObfuscation")}
                      disabled={pending}
                      onCheckedChange={(checked) => {
                        setSecretObfuscation(checked);
                        changed();
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("secretObfuscationDescription")}
                    </p>
                  </DialogField>
                </section>
                <section
                  hidden={active !== "instructions"}
                  className="flex flex-1 flex-col gap-6"
                >
                  <DialogField
                    label={t("contextFiles")}
                    dirty={contextFiles !== props.contextFiles}
                  >
                    <Switch
                      checked={contextFiles}
                      disabled={pending}
                      ariaLabel={t("contextFiles")}
                      onCheckedChange={(checked) => {
                        setContextFiles(checked);
                        changed();
                      }}
                    />
                  </DialogField>
                  <SystemPromptEditor
                    workspaceId={workspaceId}
                    name={name}
                    description={description}
                    providerId={provider}
                    model={model}
                    value={prompt}
                    onChange={(value) => {
                      setPrompt(value);
                      changed();
                    }}
                    maxLength={100_000}
                    placeholder={t("youAreAHelpfulAssistant")}
                    dirty={prompt !== props.systemPrompt}
                  />
                </section>
                <section hidden={active !== "streamRules"}>
                  <AgentStreamRulesEditor
                    draft={streamRules}
                    disabled={pending}
                    onChange={changed}
                  />
                </section>
                <section hidden={active !== "builtInTools"}>
                  <DialogField
                    label={t("builtInTools")}
                    dirty={fieldDirty.builtInTools}
                  >
                    <AgentBuiltInTools
                      runtimeKind={runtimeKind}
                      disabledTools={disabledTools}
                      onDisabledToolsChange={(next) => {
                        setDisabledTools(next);
                        changed();
                      }}
                      optionalToolOptions={props.optionalBuiltinToolOptions}
                      enabledOptionalTools={enabledOptionalTools}
                      onEnabledOptionalToolsChange={(next) => {
                        setEnabledOptionalTools(next);
                        changed();
                      }}
                      disabled={pending}
                    />
                  </DialogField>
                </section>
                <section hidden={active !== "toolApproval"}>
                  <ToolApprovalSettings
                    value={toolApproval}
                    disabled={pending}
                    dirty={fieldDirty.toolApproval}
                    onChange={(value) => {
                      setToolApproval(value);
                      changed();
                    }}
                  />
                </section>
                <section hidden={active !== "mcp"}>
                  <DialogField label={t("mcp")} dirty={fieldDirty.mcp}>
                    <AgentResourceSelect
                      icon={Server}
                      label={t("mcp")}
                      name="deploymentId"
                      options={deployments}
                      selectedIds={deploymentIds}
                      onSelectionChange={(next) => {
                        setDeploymentIds(next);
                        changed();
                      }}
                    />
                  </DialogField>
                </section>
                <section hidden={active !== "skills"}>
                  <DialogField label={t("skills")} dirty={fieldDirty.skills}>
                    <AgentResourceSelect
                      icon={PackageCheck}
                      label={t("skills")}
                      name="installedSkillId"
                      options={skills}
                      selectedIds={skillIds}
                      onSelectionChange={(next) => {
                        setSkillIds(next);
                        changed();
                      }}
                    />
                  </DialogField>
                </section>
                <section hidden={active !== "piPackages"}>
                  <DialogField
                    label={t("piPackages")}
                    dirty={fieldDirty.piPackages}
                  >
                    <AgentPluginsPanel
                      slug={slug}
                      agentId={agentId}
                      runtimeKind={runtimeKind}
                      options={piPackages}
                      catalog={pluginCatalog}
                      deployments={pluginDeployments}
                      packages={packages}
                      applied={appliedConfig?.packages ?? []}
                      canManage={canApprovePluginSync}
                      locked={dirty || pending}
                      flowContext={pluginFlow.context}
                      flowResult={pluginFlow.result}
                      clearFlowResult={pluginFlow.clearResult}
                      onAdd={(listingId) => selectPlugin(listingId, piPackages)}
                      onInstalled={pluginFlow.add}
                      onChange={(next) => {
                        setPackages(next);
                        changed();
                      }}
                    />
                  </DialogField>
                </section>
                <section hidden={active !== "sandboxes"} className="space-y-4">
                  <DialogField label={t("ownSandbox")}>
                    {ownSandbox ? (
                      <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <ButtonLink
                            href={`/app/${slug}/sandboxes/${ownSandbox.id}`}
                            variant="ghost"
                            size="sm"
                          >
                            <Box className="size-4" />
                            {ownSandbox.name}
                          </ButtonLink>
                          <StatusBadge status={ownSandbox.status} />
                        </div>
                        <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                          <dt className="text-muted-foreground">
                            {s("image")}
                          </dt>
                          <dd
                            title={ownSandbox.image ?? ""}
                            className="min-w-0 truncate font-mono"
                          >
                            {ownSandbox.image?.replace(
                              /(@sha256:[a-f0-9]{12})[a-f0-9]+/gi,
                              "$1…",
                            ) ?? "—"}
                          </dd>
                          <dt className="text-muted-foreground">
                            {s("network")}
                          </dt>
                          <dd>
                            {ownSandbox.network === "none"
                              ? s("networkNone")
                              : s("networkIsolated")}
                          </dd>
                        </dl>
                        <p className="text-xs text-muted-foreground">
                          {t("ownSandboxFixed")}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("ownSandboxMissing")}
                      </p>
                    )}
                  </DialogField>
                  <DialogField
                    label={t("externalSandboxes")}
                    dirty={attachmentsDirty}
                  >
                    <div className="space-y-3">
                      {attachments.map((attachment) => {
                        const sandbox = externalSandboxes.find(
                          (item) => item.id === attachment.sandboxId,
                        );
                        if (!sandbox) return null;
                        const KindIcon =
                          sandbox.kind === "connector"
                            ? Cable
                            : sandbox.kind === "ssh"
                              ? Server
                              : Box;
                        return (
                          <div
                            key={sandbox.id}
                            className="space-y-2 rounded-xl border border-border p-3"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <KindIcon className="size-4 shrink-0 text-muted-foreground" />
                              <ButtonLink
                                href={`/app/${slug}/sandboxes/${sandbox.id}`}
                                variant="ghost"
                                size="sm"
                                className="min-w-0 max-w-full"
                              >
                                <span className="truncate">{sandbox.name}</span>
                              </ButtonLink>
                              <span className="text-xs text-muted-foreground">
                                {s(
                                  sandbox.kind === "ssh"
                                    ? "sshMode"
                                    : sandbox.kind === "connector"
                                      ? "connectorMode"
                                      : "docker",
                                )}
                              </span>
                              <StatusBadge status={sandbox.status} />
                              <div className="ml-auto flex items-center gap-2">
                                <FormSelect
                                  label={t("sandboxAccessFor", {
                                    name: sandbox.name,
                                  })}
                                  value={attachment.access}
                                  options={EXTERNAL_SANDBOX_ACCESS.map(
                                    (access) => ({
                                      value: access,
                                      label: s(`access.${access}`),
                                    }),
                                  )}
                                  onValueChange={(access) => {
                                    setAttachments((current) =>
                                      current.map((item) =>
                                        item.sandboxId === sandbox.id
                                          ? {
                                              ...item,
                                              access:
                                                access as ExternalSandboxAccess,
                                            }
                                          : item,
                                      ),
                                    );
                                    changed();
                                  }}
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={t("removeExternalSandbox", {
                                    name: sandbox.name,
                                  })}
                                  onClick={() => {
                                    setAttachments((current) =>
                                      current.filter(
                                        (item) => item.sandboxId !== sandbox.id,
                                      ),
                                    );
                                    changed();
                                  }}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </div>
                            {attachment.access === "full" ? (
                              <p className="text-xs text-amber-700 dark:text-amber-400">
                                {t("externalSandboxFullWarning")}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                      {attachments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t("noExternalSandboxes")}
                        </p>
                      ) : null}
                      {attachments.length >= MAX_EXTERNAL_SANDBOXES ? (
                        <p className="text-xs text-muted-foreground">
                          {t("externalSandboxLimit", {
                            count: MAX_EXTERNAL_SANDBOXES,
                          })}
                        </p>
                      ) : externalSandboxes.some(
                          (sandbox) =>
                            !attachments.some(
                              (item) => item.sandboxId === sandbox.id,
                            ),
                        ) ? (
                        <FormSelect
                          label={t("addExternalSandbox")}
                          value=""
                          options={[
                            {
                              value: "",
                              label: t("addExternalSandbox"),
                              disabled: true,
                            },
                            ...externalSandboxes
                              .filter(
                                (sandbox) =>
                                  !attachments.some(
                                    (item) => item.sandboxId === sandbox.id,
                                  ),
                              )
                              .map((sandbox) => ({
                                value: sandbox.id,
                                label: `${sandbox.name} · ${s(sandbox.kind === "ssh" ? "sshMode" : sandbox.kind === "connector" ? "connectorMode" : "docker")}`,
                              })),
                          ]}
                          onValueChange={(sandboxId) => {
                            setAttachments((current) =>
                              current.length < MAX_EXTERNAL_SANDBOXES &&
                              !current.some(
                                (item) => item.sandboxId === sandboxId,
                              )
                                ? [...current, { sandboxId, access: "read" }]
                                : current,
                            );
                            changed();
                          }}
                        />
                      ) : null}
                      <ButtonLink
                        href={`/app/${slug}/sandboxes?scope=external`}
                        variant="secondary"
                        size="sm"
                      >
                        {t("manageExternalSandboxes")}
                      </ButtonLink>
                    </div>
                  </DialogField>
                </section>
                <section
                  hidden={active !== "subAgents"}
                  onChange={(event) => event.stopPropagation()}
                >
                  <DialogField
                    label={t("subAgents")}
                    dirty={fieldDirty.subAgents}
                  >
                    <SubagentResources
                      slug={slug}
                      agentId={agentId}
                      snapshot={subagentSnapshot}
                      draft={subagentDraft}
                      disabled={pending || !canApprovePluginSync}
                      onLoad={setSubagentSnapshot}
                      onChange={(draft) => {
                        setSubagentDraft(draft);
                        setReview(null);
                        setMessage("");
                      }}
                    />
                  </DialogField>
                </section>
                <section hidden={active !== "advanced"}>
                  <DialogField
                    label={t("maxToolSteps")}
                    htmlFor={`${formId}-steps`}
                    dirty={fieldDirty.advanced}
                  >
                    <Input
                      id={`${formId}-steps`}
                      aria-label={t("maxToolSteps")}
                      name="maxSteps"
                      type="number"
                      min={AGENT_STEP_BOUNDS.min}
                      max={AGENT_STEP_BOUNDS.max}
                      value={steps}
                      onChange={setSteps}
                    />
                  </DialogField>
                </section>
              </fieldset>
            </form>
            {active === "sandboxes" ? (
              <section className="space-y-4">
                <DialogField
                  label={r("environment")}
                  description={r("environmentHelp")}
                  dirty={
                    environment !==
                    (appliedConfig
                      ? JSON.stringify(appliedConfig.environment, null, 2)
                      : "")
                  }
                >
                  <textarea
                    aria-label={r("environment")}
                    rows={14}
                    value={environment}
                    onChange={(event) => {
                      setEnvironment(event.target.value);
                      setReview(null);
                    }}
                    className={`${textareaClass} font-mono`}
                  />
                </DialogField>
                <h4 className="font-medium">{r("credentials")}</h4>
                {canManageCredentials ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => void perform(loadCredentials)}
                    >
                      {r("loadCredentials")}
                    </Button>
                    <DialogField
                      label={r("credentialName")}
                      dirty={credentialName !== ""}
                    >
                      <Input
                        aria-label={r("credentialName")}
                        value={credentialName}
                        onChange={setCredentialName}
                      />
                    </DialogField>
                    <DialogField
                      label={r("credentialValue")}
                      dirty={credentialValue !== ""}
                    >
                      <Input
                        aria-label={r("credentialValue")}
                        type="password"
                        value={credentialValue}
                        onChange={setCredentialValue}
                      />
                    </DialogField>
                    <Button
                      type="button"
                      disabled={pending || !credentialName || !credentialValue}
                      onClick={() =>
                        void perform(async () => {
                          const data = identity();
                          data.set("name", credentialName);
                          data.set("value", credentialValue);
                          const result =
                            await createAgentEnvironmentCredentialAction(data);
                          if (result.error) throw new Error(result.error);
                          setCredentialValue("");
                          await loadCredentials();
                        })
                      }
                    >
                      {r("createCredential")}
                    </Button>
                    {credentials.length ? (
                      credentials.map((credential) => (
                        <div
                          key={credential.id}
                          className="space-y-2 rounded-lg border border-border p-3"
                        >
                          <p>{credential.name}</p>
                          <code className="block break-all text-xs">
                            {JSON.stringify({
                              name: credential.name,
                              credentialId: credential.id,
                            })}
                          </code>
                          {credential.revokedAt ? (
                            <p>{String(credential.revokedAt)}</p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={pending || !environment.trim()}
                                onClick={() =>
                                  void perform(async () => {
                                    const definition = JSON.parse(
                                      environment,
                                    ) as AgentRevisionConfig["environment"];
                                    definition.credentialReferences = [
                                      ...definition.credentialReferences.filter(
                                        (reference) =>
                                          reference.name !== credential.name,
                                      ),
                                      {
                                        name: credential.name,
                                        credentialId: credential.id,
                                      },
                                    ];
                                    setEnvironment(
                                      JSON.stringify(definition, null, 2),
                                    );
                                    setReview(null);
                                  })
                                }
                              >
                                {r("credentialRef")}
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={pending}
                                onClick={() =>
                                  void perform(async () => {
                                    const data = identity();
                                    data.set("credentialId", credential.id);
                                    const result =
                                      await revokeAgentEnvironmentCredentialAction(
                                        data,
                                      );
                                    if ("error" in result)
                                      throw new Error(result.error);
                                    await loadCredentials();
                                    setReview(null);
                                  })
                                }
                              >
                                {r("revokeCredential")}
                              </Button>
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {r("noCredentials")}
                      </p>
                    )}
                  </>
                ) : (
                  <p>{r("credentialOwner")}</p>
                )}
              </section>
            ) : null}
          </div>
          {review ? (
            <section
              aria-label={r("review")}
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <h4 className="font-semibold">{r("review")}</h4>
              <p className="text-sm text-muted-foreground">
                {diffT("reviewHelp")}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th scope="col" className="p-2">
                        {t("model")}
                      </th>
                      <th scope="col" className="p-2">
                        {t("modelRouting.before")}
                      </th>
                      <th scope="col" className="p-2">
                        {t("modelRouting.after")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row" className="p-2 font-medium">
                        {t("model")}
                      </th>
                      {[appliedConfig, review.config].map((config, index) => (
                        <td
                          key={index === 0 ? "before" : "after"}
                          className="break-words p-2"
                        >
                          {config?.providerId && config.model
                            ? modelLabel({
                                providerId: config.providerId,
                                model: config.model,
                              })
                            : t("none")}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row" className="p-2 align-top font-medium">
                        {t("modelRouting.fallbackModels")}
                      </th>
                      {[appliedConfig, review.config].map((config, index) => (
                        <td
                          key={index === 0 ? "before" : "after"}
                          className="break-words p-2 align-top"
                        >
                          {config?.fallbackModels?.length ? (
                            <ol className="list-inside list-decimal space-y-1">
                              {review.fallbackRows[
                                index === 0 ? "before" : "after"
                              ].map((item) => (
                                <li key={item.id}>
                                  {modelLabel(item.selection)}
                                </li>
                              ))}
                            </ol>
                          ) : (
                            t("none")
                          )}
                        </td>
                      ))}
                    </tr>
                    {(["compaction", "title"] as const).map((role) => (
                      <tr key={role}>
                        <th scope="row" className="p-2 font-medium">
                          {t(`modelRouting.${role}`)}
                        </th>
                        <td className="break-words p-2">
                          {modelLabel(appliedConfig?.roleModels?.[role])}
                        </td>
                        <td className="break-words p-2">
                          {modelLabel(review.config.roleModels?.[role])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <RevisionFileDiff diff={review.diff} />
              {review.additions.length ? (
                <p className="text-sm text-muted-foreground">
                  {r("reviewHelp")}
                </p>
              ) : null}
              <ul className="space-y-3 text-sm">
                {review.additions.map((addition) => {
                  const nativeDelegation =
                    addition.kind === "delegation" &&
                    addition.resourceId === "native";
                  const nativeValues = nativeDelegation
                    ? addition.values.map((value) => {
                        if (value === "native")
                          return t("subagentResources.nativeMode");
                        if (value.startsWith("maxConcurrency:"))
                          return t("subagentResources.reviewConcurrency", {
                            value: value.split(":")[1],
                          });
                        if (value.startsWith("maxDepth:"))
                          return t("subagentResources.reviewDepth", {
                            value: value.split(":")[1],
                          });
                        return value;
                      })
                    : [];
                  const resource =
                    addition.kind === "package"
                      ? piPackages.find(
                          (option) =>
                            option.marketInstallId === addition.resourceId,
                        )?.name
                      : null;
                  return (
                    <li key={`${addition.kind}:${addition.resourceId}`}>
                      <span className="font-medium">
                        {nativeDelegation
                          ? t("subagentResources.nativeMode")
                          : addition.kind === "delegation" &&
                              review.config.subagents?.some(
                                (pin) => pin.subagentId === addition.resourceId,
                              )
                            ? r("permissionKinds.subagent")
                            : r(`permissionKinds.${addition.kind}`)}
                      </span>
                      <p className="break-words text-muted-foreground">
                        {resource ? `${resource}: ` : ""}
                        {nativeDelegation
                          ? nativeValues.join(", ")
                          : addition.kind === "environment"
                            ? addition.values
                                .map((value) =>
                                  r(`environmentChanges.${value}`),
                                )
                                .join("、")
                            : addition.kind === "package" && resource
                              ? r("packageCode")
                              : addition.kind === "delegation" &&
                                  ["inbound", "outbound"].includes(
                                    addition.resourceId,
                                  )
                                ? r(`delegationChanges.${addition.resourceId}`)
                                : addition.values.join(", ")}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {message ? (
            <p role="status" className="text-sm">
              {message}
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter
        cancel={<DialogCancel />}
        start={
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${hasUnsavedChanges ? "bg-primary" : "bg-muted-foreground/50"}`}
            />
            {pending
              ? t("saving")
              : review
                ? r("review")
                : hasUnsavedChanges
                  ? settingsState("unsavedChanges")
                  : settingsState("noChanges")}
          </p>
        }
      >
        {review ? (
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setReview(null)}
            >
              {r("discard")}
            </Button>
            <Button
              type="button"
              disabled={pending || dirty || subagentsDirty || streamRules.dirty}
              onClick={() => void apply()}
              className="gap-2"
            >
              {pending ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
              ) : null}
              {r("apply")}
            </Button>
          </div>
        ) : (
          <Button
            form={formId}
            type="submit"
            disabled={
              pending ||
              (active === "streamRules" && streamRules.rules === null)
            }
            aria-busy={pending}
            className="min-w-24 gap-2 rounded-xl"
          >
            {pending ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : null}
            {pending ? t("saving") : r("saveDraft")}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
