"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoaderCircle, PackageCheck, Server } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { FormSelect } from "@/components/ui/FormSelect";
import type { ExternalSandboxAccess } from "@/lib/sandboxes/external";
import { DialogBody, DialogCancel, DialogField, DialogFooter } from "../dialog";
import { DisplayError } from "../display-error";
import { useCloseSettingsModal } from "../SettingsModal";
import { notify } from "../Toaster";
import {
  ModelPicker,
  ModelPickerTrigger,
  type ModelProviderOption,
} from "@/components/dashboard/models/ModelPicker";
import {
  AgentResourceList,
  type AgentResourceOption,
} from "./AgentResourceSelect";
import {
  AgentBuiltinFeatureInputs,
  AgentBuiltinFeatures,
} from "./AgentBuiltinFeatures";
import { AgentMemoriesPanel } from "./AgentMemoriesPanel";
import { SettingsSection, settingsTextareaClass } from "./SettingsSection";
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
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { buildAgentRevisionDiff } from "@/lib/revisions/config-diff";
import {
  AGENT_MCP_TOOL_TIMEOUT_BOUNDS,
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  normalizeReasoningEffort,
  selectionSupportsReasoning,
  type ReasoningEffort,
  type ReasoningLevel,
} from "@/lib/agents/constants";
import { REASONING_EFFORT_LABELS } from "./ReasoningEffortControl";
import { agentPermissionAdditions } from "@/lib/agents/permission-additions";
import {
  isExecutableAgentRuntimeKind,
  agentRuntimeSupportsProviderFormat,
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
import { apiRequest } from "@/lib/client/api";
import {
  AgentModelRoutingSettings,
  type AgentRoleModels,
  type FallbackModelRow,
} from "./AgentModelRoutingSettings";
import { AgentExecutionSettings } from "./AgentExecutionSettings";
import { AgentSandboxSettings } from "./AgentSandboxSettings";
import { AgentEnvironmentSettings } from "./AgentEnvironmentSettings";
import {
  AgentRevisionReview,
  type AgentRevisionReviewDraft,
} from "./AgentRevisionReview";

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
export type AgentSettingsPage = "basic" | "capabilities" | "execution";
export const AGENT_SETTINGS_SECTION_PAGE: Record<
  AgentSettingsSection,
  AgentSettingsPage
> = {
  general: "basic",
  instructions: "basic",
  builtInTools: "capabilities",
  mcp: "capabilities",
  skills: "capabilities",
  piPackages: "capabilities",
  subAgents: "capabilities",
  toolApproval: "execution",
  streamRules: "execution",
  advanced: "execution",
  sandboxes: "execution",
};
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
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningLevel | null;
  toolApproval?: ToolApprovalPolicy;
  secretObfuscation: boolean;
  advisor?: AgentRevisionConfig["advisor"] | null;
  maxSteps: number;
  /** Seconds; null uses the system default. */
  taskTimeoutSeconds: number | null;
  defaultTaskTimeoutSeconds: number;
  /** Seconds for each MCP tool call; null uses the system default. */
  mcpToolTimeoutSeconds: number | null;
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
  activePage?: AgentSettingsPage;
  /** When set, only this section is visible. Others stay mounted so one save covers them. */
  activeSection?: AgentSettingsSection;
  initialMemoryManagerOpen?: boolean;
  /** Asks the container to show a section, e.g. after a validation error. */
  onSectionChange?: (section: AgentSettingsSection) => void;
  onDirtySectionsChange?: (sections: AgentSettingsSection[]) => void;
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
  const approvalT = useTranslations("console.toolApproval");
  const streamRules = useStreamRulesDraft(
    slug,
    agentId,
    runtimeKind === "pi-sdk",
  );
  const diffT = useTranslations("console.revisionDiff");
  const router = useRouter();
  const closeModal = useCloseSettingsModal();
  const formId = useId();
  const settingsState = useTranslations("common");
  const [localPage, setLocalPage] = useState<AgentSettingsPage>("basic");
  const page = props.activePage ?? localPage;
  function showSection(id: AgentSettingsSection) {
    return !props.activeSection || props.activeSection === id;
  }
  function reveal(section: AgentSettingsSection) {
    setLocalPage(AGENT_SETTINGS_SECTION_PAGE[section]);
    props.onSectionChange?.(section);
  }
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState(props.description ?? "");
  const [prompt, setPrompt] = useState(props.systemPrompt);
  const [contextFiles, setContextFiles] = useState(props.contextFiles);
  const [provider, setProvider] = useState(props.providerId ?? "");
  const [model, setModel] = useState(props.model ?? "");
  const [fallbackModels, setFallbackModels] = useState<FallbackModelRow[]>(() =>
    (publishedRevision?.config.fallbackModels ?? []).map((selection) => ({
      id: crypto.randomUUID(),
      selection,
    })),
  );
  const [roleModels, setRoleModels] = useState<AgentRoleModels>(
    publishedRevision?.config.roleModels ?? {},
  );
  const compatibleProviders = isExecutableAgentRuntimeKind(runtimeKind)
    ? providers.filter((item) =>
        agentRuntimeSupportsProviderFormat(runtimeKind, item.format),
      )
    : [];
  const modelProviders = compatibleProviders.map((item) => ({
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
  const [advisor, setAdvisor] = useState(props.advisor ?? null);
  const [steps, setSteps] = useState(String(props.maxSteps));
  const initialTimeoutMinutes =
    props.taskTimeoutSeconds === null
      ? ""
      : String(Math.round(props.taskTimeoutSeconds / 60));
  const [timeoutMinutes, setTimeoutMinutes] = useState(initialTimeoutMinutes);
  const [disabledTools, setDisabledTools] = useState(
    new Set(props.disabledBuiltinTools ?? []),
  );
  const [enabledOptionalTools, setEnabledOptionalTools] = useState(
    () => new Set(props.optionalBuiltinTools),
  );
  const [deploymentIds, setDeploymentIds] = useState(() =>
    selected(deployments),
  );
  const initialMcpToolTimeout =
    props.mcpToolTimeoutSeconds === null
      ? ""
      : String(props.mcpToolTimeoutSeconds);
  const [mcpToolTimeout, setMcpToolTimeout] = useState(initialMcpToolTimeout);
  const initialMcpToolTimeoutOverride = (deploymentId: string) => {
    const seconds = deployments.find(
      (option) => option.id === deploymentId,
    )?.toolTimeoutSeconds;
    return seconds == null ? "" : String(seconds);
  };
  const [mcpToolTimeoutOverrides, setMcpToolTimeoutOverrides] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      deployments.flatMap((option) =>
        option.toolTimeoutSeconds == null
          ? []
          : [[option.id, String(option.toolTimeoutSeconds)]],
      ),
    ),
  );
  const mcpToolTimeoutOverride = (deploymentId: string) =>
    (mcpToolTimeoutOverrides[deploymentId] ?? "").trim();
  const mcpToolTimeoutDefaultDirty =
    mcpToolTimeout.trim() !== initialMcpToolTimeout;
  const mcpToolTimeoutDirty =
    mcpToolTimeoutDefaultDirty ||
    [...deploymentIds].some(
      (deploymentId) =>
        mcpToolTimeoutOverride(deploymentId) !==
        initialMcpToolTimeoutOverride(deploymentId),
    );
  const mcpToolTimeoutPlaceholder =
    mcpToolTimeout.trim() || String(AGENT_MCP_TOOL_TIMEOUT_BOUNDS.default);
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
  const [review, setReview] = useState<AgentRevisionReviewDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
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
      provider !== (props.providerId ?? "") || model !== (props.model ?? ""),
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
    advisor: JSON.stringify(advisor) !== JSON.stringify(props.advisor ?? null),
    mcp: !sameSet(deploymentIds, selected(deployments)) || mcpToolTimeoutDirty,
    skills: !sameSet(skillIds, selected(skills)),
    sandboxes:
      attachmentsDirty ||
      secretObfuscation !== props.secretObfuscation ||
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
    maxSteps: steps !== String(props.maxSteps),
    taskTimeout: timeoutMinutes.trim() !== initialTimeoutMinutes,
    advanced:
      steps !== String(props.maxSteps) ||
      timeoutMinutes.trim() !== initialTimeoutMinutes ||
      fallbackModelsDirty ||
      roleModelDirty("compaction") ||
      roleModelDirty("title") ||
      JSON.stringify(advisor) !== JSON.stringify(props.advisor ?? null),
  };
  const dirtySections: AgentSettingsSection[] = [
    ...(fieldDirty.name ||
    fieldDirty.description ||
    fieldDirty.model ||
    fieldDirty.reasoningEffort
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
  // Saved Agent-row fields may still differ from the published revision.
  // Emphasize saving while independently loaded settings are unknown.
  const savedDraftDiffers =
    !appliedConfig ||
    props.systemPrompt !== (appliedConfig.systemPrompt ?? "") ||
    props.contextFiles !== (appliedConfig.contextFiles ?? true) ||
    props.providerId !== appliedConfig.providerId ||
    props.model !== appliedConfig.model ||
    (props.reasoningEffort ?? DEFAULT_REASONING_LEVEL) !==
      (appliedConfig.reasoningEffort ?? DEFAULT_REASONING_LEVEL) ||
    props.maxSteps !== appliedConfig.maxSteps ||
    props.taskTimeoutSeconds !== (appliedConfig.taskTimeoutSeconds ?? null) ||
    props.mcpToolTimeoutSeconds !==
      (appliedConfig.mcpToolTimeoutSeconds ?? null) ||
    appliedConfig.mcpGrants.some(
      (grant) =>
        (grant.toolTimeoutSeconds ?? null) !==
        (deployments.find((option) => option.id === grant.deploymentId)
          ?.toolTimeoutSeconds ?? null),
    ) ||
    props.secretObfuscation !== (appliedConfig.secretObfuscation ?? true) ||
    JSON.stringify(props.advisor ?? null) !==
      JSON.stringify(appliedConfig.advisor ?? null) ||
    JSON.stringify(props.toolApproval ?? { mode: "off" }) !==
      JSON.stringify(appliedConfig.toolApproval ?? { mode: "off" }) ||
    !sameSet(
      new Set(props.disabledBuiltinTools ?? []),
      new Set(appliedConfig.disabledBuiltinTools),
    ) ||
    !sameSet(
      new Set(props.optionalBuiltinTools),
      new Set(appliedConfig.optionalBuiltinTools ?? []),
    ) ||
    !sameSet(
      selected(deployments),
      new Set(appliedConfig.mcpGrants.map((grant) => grant.deploymentId)),
    ) ||
    !sameSet(
      selected(skills),
      new Set(appliedConfig.skills.map((skill) => skill.installedSkillId)),
    ) ||
    !sameSet(
      new Set(
        initialPiPackages
          .filter((pkg) => pkg.enabledReleaseId)
          .map((pkg) => `${pkg.marketInstallId}:${pkg.enabledReleaseId}`),
      ),
      new Set(
        appliedConfig.packages.map(
          (pkg) => `${pkg.marketInstallId}:${pkg.releaseId}`,
        ),
      ),
    ) ||
    !sameSet(
      new Set(
        initialAttachments.map((item) => `${item.sandboxId}:${item.access}`),
      ),
      new Set(
        appliedConfig.externalSandboxes.map(
          (item) => `${item.sandboxId}:${item.access}`,
        ),
      ),
    ) ||
    (runtimeKind === "pi-sdk" &&
      (streamRules.rules === null ||
        JSON.stringify(streamRules.rules) !==
          JSON.stringify(appliedConfig.streamRules ?? []))) ||
    subagentSnapshot === null ||
    JSON.stringify(subagentSnapshot.nativePolicy) !==
      JSON.stringify(
        appliedConfig.nativeSubagentPolicy ?? {
          maxConcurrency: 1,
          maxDepth: 1,
        },
      );
  const saveNeedsAttention =
    !revision ||
    hasUnsavedChanges ||
    dirtySections.length > 0 ||
    savedDraftDiffers ||
    review !== null ||
    pending;
  useEffect(() => {
    props.onDirtySectionsChange?.(
      dirtySectionKey
        ? (dirtySectionKey.split(",") as AgentSettingsSection[])
        : [],
    );
  }, [dirtySectionKey, props.onDirtySectionsChange]);
  function changed() {
    setDirty(true);
    setReview(null);
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
    reveal("piPackages");
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
    try {
      await operation();
    } catch (failure) {
      const code = failure instanceof DisplayError ? failure.message : null;
      if (
        code === "AGENT_FALLBACK_MODELS_INVALID" ||
        code === "AGENT_ROLE_MODELS_INVALID" ||
        code === t("advisorInvalid")
      ) {
        reveal("advanced");
      }
      const text =
        code === null
          ? settingsState("operationFailed")
          : t.has(`modelRouting.errors.${code}`)
            ? t(`modelRouting.errors.${code}`)
            : r.has(`credentialErrors.${code}`)
              ? r(`credentialErrors.${code}`)
              : t.has(code)
                ? t(code)
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
        throw new DisplayError(result.error);
      throw new DisplayError(
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
        throw new DisplayError(
          result.error === "AGENT_ADVISOR_INVALID"
            ? t("advisorInvalid")
            : t.has(result.error)
              ? t(result.error)
              : result.error,
        );
      if (subagentsDirty && subagentDraft) {
        const saved = await apiRequest<SubagentResourcesSnapshot>(
          `/api/v1/agents/${encodeURIComponent(agentId)}/subagents`,
          { method: "PUT", json: { workspace: slug, ...subagentDraft } },
        );
        if (!saved.ok) {
          throw new DisplayError(
            saved.message && t.has(`subagentResources.errors.${saved.message}`)
              ? t(`subagentResources.errors.${saved.message}`)
              : t("subagentResources.saveFailed"),
          );
        }
        setSubagentSnapshot(saved.data);
        setSubagentDraft(null);
      }
      setDirty(false);
      const preparation = identity();
      if (environment.trim()) preparation.set("environment", environment);
      const preview = await prepareAgentRevisionAction(preparation);
      if ("error" in preview) throw new DisplayError(preview.error);
      const prepared = {
        expectedRevisionId: preview.expectedRevisionId,
        config: JSON.parse(preview.configJson) as AgentRevisionConfig,
      };
      // Never classify against a different tab's newly applied configuration.
      if ((prepared.expectedRevisionId ?? "") !== revision)
        throw new DisplayError(r("stale"));
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
    });
  }
  async function apply() {
    if (!review || dirty || subagentsDirty || streamRules.dirty) return;
    await perform(() => publish(review));
  }
  const showBasics = page === "basic";
  // Long free text (description, instructions) takes the whole content height when shown alone.
  const fillBody =
    !review &&
    showBasics &&
    (props.activeSection === "general" ||
      props.activeSection === "instructions");
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
        <div className={fillBody ? "flex flex-1 flex-col gap-5" : "space-y-5"}>
          <div
            hidden={Boolean(review)}
            className={fillBody ? "flex flex-1 flex-col gap-8" : "space-y-8"}
          >
            {/* Outside the form: the memory manager has forms of its own. */}
            {page === "capabilities" && showSection("builtInTools") ? (
              <SettingsSection
                id="builtInTools"
                title={t("builtinFeatures.title")}
              >
                <AgentBuiltinFeatures
                  runtimeKind={runtimeKind}
                  disabledTools={disabledTools}
                  enabledOptionalTools={enabledOptionalTools}
                  disabled={pending}
                  onChange={(next) => {
                    setDisabledTools(next.disabledTools);
                    setEnabledOptionalTools(next.enabledOptionalTools);
                    changed();
                  }}
                  memoryManagerOpen={props.initialMemoryManagerOpen}
                  memoryManager={
                    <AgentMemoriesPanel slug={slug} agentId={agentId} />
                  }
                />
              </SettingsSection>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                // React action resets also reset Radix selects and invalidate review.
                if (!pending) void save(new FormData(event.currentTarget));
              }}
              id={formId}
              onChange={changed}
              onInvalidCapture={(event) => {
                const target = event.target as HTMLInputElement;
                const invalidSection =
                  target.name === "name"
                    ? "general"
                    : target.name === "maxSteps" ||
                        target.name === "taskTimeoutMinutes"
                      ? "advanced"
                      : target.name === "mcpToolTimeoutSeconds" ||
                          "mcpToolTimeout" in target.dataset
                        ? "mcp"
                        : null;
                if (invalidSection) reveal(invalidSection);
              }}
              data-unsaved-changes={hasUnsavedChanges ? "true" : "false"}
              className={fillBody ? "flex flex-1 flex-col gap-5" : "space-y-5"}
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
                name="advisor"
                value={JSON.stringify(advisor)}
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
                name="taskTimeoutSeconds"
                value={
                  timeoutMinutes.trim()
                    ? String(Math.round(Number(timeoutMinutes) * 60))
                    : ""
                }
              />
              {/* Overrides follow the binding, even while the selector replaces the rows. */}
              {[...deploymentIds].map((deploymentId) => (
                <input
                  key={deploymentId}
                  type="hidden"
                  name={`mcpToolTimeoutSeconds:${deploymentId}`}
                  value={mcpToolTimeoutOverride(deploymentId)}
                />
              ))}
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
              <AgentBuiltinFeatureInputs
                runtimeKind={runtimeKind}
                disabledTools={disabledTools}
                enabledOptionalTools={enabledOptionalTools}
              />
              <fieldset
                disabled={pending}
                className={`min-w-0 ${fillBody ? "flex flex-1 flex-col gap-8" : "space-y-8"}`}
              >
                <section
                  hidden={!showBasics || !showSection("general")}
                  data-settings-section="general"
                  className={`scroll-mt-4 ${fillBody ? "flex flex-1 flex-col gap-5" : "space-y-5"}`}
                >
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
                  <div className="space-y-4">
                    <DialogField
                      label={t("model")}
                      dirty={fieldDirty.model}
                      layout="row"
                    >
                      <ModelPicker
                        className="flex w-72 max-w-full"
                        providers={compatibleProviders}
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
                              providers.find((item) => item.id === provider)
                                ?.name
                            }
                            aria-label={t("model")}
                          />
                        }
                      />
                    </DialogField>
                    {selectionSupportsReasoning(providers, {
                      providerId: provider,
                      model,
                    }) && (
                      <DialogField
                        label={t("defaultReasoningEffort")}
                        htmlFor={`${formId}-reasoning-effort`}
                        dirty={fieldDirty.reasoningEffort}
                        layout="row"
                      >
                        <FormSelect
                          className="w-40"
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
                  </div>
                  <DialogField
                    label={t("description")}
                    htmlFor={`${formId}-description`}
                    dirty={fieldDirty.description}
                    fill={fillBody}
                  >
                    <textarea
                      id={`${formId}-description`}
                      name="description"
                      value={description}
                      maxLength={500}
                      rows={4}
                      onChange={(event) => setDescription(event.target.value)}
                      className={`${settingsTextareaClass} ${fillBody ? "min-h-32 flex-1 resize-none" : ""}`}
                    />
                  </DialogField>
                </section>
                <section
                  hidden={!showBasics || !showSection("instructions")}
                  data-settings-section="instructions"
                  className={`scroll-mt-4 ${fillBody ? "flex flex-1 flex-col gap-5" : "space-y-5"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {t("instructions")}
                    </span>
                    <Switch
                      checked={contextFiles}
                      disabled={pending}
                      label={t("contextFiles")}
                      onCheckedChange={(checked) => {
                        setContextFiles(checked);
                        changed();
                      }}
                    />
                  </div>
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
                    className="min-h-64"
                  />
                </section>
                <div hidden={page !== "capabilities"} className="space-y-8">
                  <div hidden={!showSection("mcp")}>
                    <AgentResourceList
                      id="mcp"
                      icon={Server}
                      label={t("mcp")}
                      name="deploymentId"
                      options={deployments}
                      selectedIds={deploymentIds}
                      disabled={pending}
                      empty={{
                        title: t("resourceList.empty.mcp.title"),
                        description: t("resourceList.empty.mcp.description"),
                      }}
                      onSelectionChange={(next) => {
                        setDeploymentIds(next);
                        changed();
                      }}
                      itemControl={(option) => (
                        <Input
                          type="number"
                          step={1}
                          min={AGENT_MCP_TOOL_TIMEOUT_BOUNDS.min}
                          max={AGENT_MCP_TOOL_TIMEOUT_BOUNDS.max}
                          data-mcp-tool-timeout=""
                          aria-label={t("mcpToolTimeoutOverride", {
                            name: option.label,
                          })}
                          title={t("mcpToolTimeoutOverride", {
                            name: option.label,
                          })}
                          placeholder={mcpToolTimeoutPlaceholder}
                          value={mcpToolTimeoutOverrides[option.id] ?? ""}
                          onChange={(value) =>
                            setMcpToolTimeoutOverrides((previous) => ({
                              ...previous,
                              [option.id]: value,
                            }))
                          }
                          className="w-20 shrink-0"
                        />
                      )}
                      footer={
                        <DialogField
                          label={t("mcpToolTimeout")}
                          description={t("mcpToolTimeoutDescription")}
                          htmlFor={`${formId}-mcp-tool-timeout`}
                          dirty={mcpToolTimeoutDefaultDirty}
                          layout="row"
                        >
                          <Input
                            id={`${formId}-mcp-tool-timeout`}
                            aria-label={t("mcpToolTimeout")}
                            name="mcpToolTimeoutSeconds"
                            type="number"
                            step={1}
                            min={AGENT_MCP_TOOL_TIMEOUT_BOUNDS.min}
                            max={AGENT_MCP_TOOL_TIMEOUT_BOUNDS.max}
                            placeholder={String(
                              AGENT_MCP_TOOL_TIMEOUT_BOUNDS.default,
                            )}
                            value={mcpToolTimeout}
                            onChange={setMcpToolTimeout}
                            className="w-24"
                          />
                        </DialogField>
                      }
                    />
                  </div>
                  <div hidden={!showSection("skills")}>
                    <AgentResourceList
                      id="skills"
                      icon={PackageCheck}
                      label={t("skills")}
                      name="installedSkillId"
                      options={skills}
                      selectedIds={skillIds}
                      disabled={pending}
                      empty={{
                        title: t("resourceList.empty.skills.title"),
                        description: t("resourceList.empty.skills.description"),
                      }}
                      onSelectionChange={(next) => {
                        setSkillIds(next);
                        changed();
                      }}
                    />
                  </div>
                  <div hidden={!showSection("piPackages")}>
                    <AgentPluginsPanel
                      title={t("piPackages")}
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
                  </div>
                  {/* Subagents save through their own request, not the form. */}
                  <div
                    hidden={!showSection("subAgents")}
                    onChange={(event) => event.stopPropagation()}
                  >
                    <SubagentResources
                      title={t("subAgents")}
                      slug={slug}
                      agentId={agentId}
                      snapshot={subagentSnapshot}
                      draft={subagentDraft}
                      disabled={pending || !canApprovePluginSync}
                      onLoad={setSubagentSnapshot}
                      onChange={(draft) => {
                        setSubagentDraft(draft);
                        setReview(null);
                      }}
                    />
                  </div>
                </div>
                <div hidden={page !== "execution"} className="space-y-8">
                  <SettingsSection
                    id="toolApproval"
                    title={approvalT("title")}
                    hidden={!showSection("toolApproval")}
                  >
                    <ToolApprovalSettings
                      value={toolApproval}
                      disabled={pending}
                      dirty={fieldDirty.toolApproval}
                      onChange={(value) => {
                        setToolApproval(value);
                        changed();
                      }}
                    />
                  </SettingsSection>
                  <SettingsSection
                    id="streamRules"
                    title={t("streamRules.title")}
                    hidden={!showSection("streamRules")}
                  >
                    <AgentStreamRulesEditor
                      draft={streamRules}
                      disabled={pending}
                      onChange={changed}
                    />
                  </SettingsSection>
                  <AgentModelRoutingSettings
                    hidden={!showSection("advanced")}
                    pending={pending}
                    providers={providers}
                    modelProviders={modelProviders}
                    fallbackModels={fallbackModels}
                    setFallbackModels={setFallbackModels}
                    fallbackModelsDirty={fallbackModelsDirty}
                    roleModels={roleModels}
                    setRoleModels={setRoleModels}
                    roleModelDirty={roleModelDirty}
                    onChange={changed}
                  />
                  <AgentExecutionSettings
                    hidden={!showSection("advanced")}
                    formId={formId}
                    slug={slug}
                    pending={pending}
                    providers={providers}
                    compatibleProviders={compatibleProviders}
                    primary={{ providerId: provider, model }}
                    steps={steps}
                    setSteps={setSteps}
                    timeoutMinutes={timeoutMinutes}
                    setTimeoutMinutes={setTimeoutMinutes}
                    defaultTaskTimeoutSeconds={props.defaultTaskTimeoutSeconds}
                    advisor={advisor}
                    setAdvisor={setAdvisor}
                    dirty={fieldDirty}
                    onChange={changed}
                  />
                  <AgentSandboxSettings
                    hidden={!showSection("sandboxes")}
                    slug={slug}
                    ownSandbox={ownSandbox}
                    externalSandboxes={externalSandboxes}
                    attachments={attachments}
                    setAttachments={setAttachments}
                    dirty={attachmentsDirty}
                    onChange={changed}
                  />
                </div>
              </fieldset>
            </form>
            {/* Outside the form: credential actions save on their own. */}
            <AgentEnvironmentSettings
              hidden={page !== "execution" || !showSection("sandboxes")}
              slug={slug}
              agentId={agentId}
              canManageCredentials={canManageCredentials}
              pending={pending}
              perform={perform}
              environment={environment}
              setEnvironment={setEnvironment}
              onReviewStale={() => setReview(null)}
              secretObfuscation={secretObfuscation}
              secretObfuscationDirty={fieldDirty.secretObfuscation}
              onSecretObfuscationChange={(checked) => {
                setSecretObfuscation(checked);
                changed();
              }}
            />
          </div>
          {review ? (
            <AgentRevisionReview
              review={review}
              appliedConfig={appliedConfig}
              providers={providers}
              piPackages={piPackages}
            />
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter
        className="flex-wrap [&>div:last-child]:min-w-0 [&>div:last-child]:shrink [&>div:last-child]:flex-wrap"
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
            variant={saveNeedsAttention ? "primary" : "secondary"}
            disabled={
              pending || (page === "execution" && streamRules.rules === null)
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
