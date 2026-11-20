"use client";
import { DialogNav } from "../dialog";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AgentResourceOption } from "@/components/dashboard/agents/AgentResourceSelect";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import {
  AGENT_SETTINGS_SECTION_PAGE,
  AgentSettingsForm,
} from "@/components/dashboard/agents/AgentSettingsForm";
import type {
  AgentOwnSandbox,
  AgentExternalSandbox,
  AgentPiPackageOption,
  AgentSettingsSection,
} from "@/components/dashboard/agents/AgentSettingsForm";
import type { AgentPluginCatalogOption } from "@/components/dashboard/agents/AgentPluginsPanel";
import type { PluginBindingDeployment } from "@/lib/plugins/binding-deployments";
import type { AgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import type { ToolApprovalPolicy } from "@/lib/agents/tool-approval-policy";
import type { ReasoningLevel } from "@/lib/agents/constants";
import { AgentTriggersPanel } from "./AgentTriggersPanel";
import { AgentUsagePanel } from "../AgentUsagePanel";
import { AgentClonePanel } from "./AgentClonePanel";
import { AgentEvolutionPanel } from "./AgentEvolutionPanel";
import { AgentMemoriesPanel } from "./AgentMemoriesPanel";

const AgentMessagingPanel = dynamic(() =>
  import("@/components/dashboard/agents/AgentMessagingPanel").then(
    (module) => module.AgentMessagingPanel,
  ),
);

const AgentA2APanel = dynamic(() =>
  import("@/components/dashboard/agents/AgentA2APanel").then(
    (module) => module.AgentA2APanel,
  ),
);

const RevisionChangelog = dynamic(() =>
  import("@/components/dashboard/RevisionChangelog").then(
    (module) => module.RevisionChangelog,
  ),
);

type SettingsData = {
  workspaceId?: string;
  name: string;
  description?: string;
  runtimeKind: string;
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
  taskTimeoutSeconds: number | null;
  defaultTaskTimeoutSeconds: number;
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
};

type ChannelSettingsData = {
  connections: AgentChannelConnectionClientView[];
};

type PanelTarget =
  | "channels"
  | "a2a"
  | "changelog"
  | "evolution"
  | "memories"
  | "triggers"
  | "usage"
  | "clone";
/** Every value accepted by `?settings=`. */
export type AgentSettingsTarget = AgentSettingsSection | PanelTarget;
type SettingsTab = AgentSettingsTarget;

const AGENT_SETTINGS_SECTIONS: readonly AgentSettingsSection[] = [
  "general",
  "instructions",
  "builtInTools",
  "streamRules",
  "toolApproval",
  "mcp",
  "skills",
  "piPackages",
  "sandboxes",
  "subAgents",
  "advanced",
];

function isAgentSettingsSection(tab: SettingsTab): tab is AgentSettingsSection {
  return AGENT_SETTINGS_SECTIONS.includes(tab as AgentSettingsSection);
}

function resolveSettingsTab({
  initialSettingsTab,
  executable,
}: {
  initialSettingsTab?: AgentSettingsTarget | null;
  executable: boolean;
}): SettingsTab {
  const requested = initialSettingsTab ?? "general";
  if (
    !executable &&
    (requested === "channels" ||
      requested === "subAgents" ||
      requested === "streamRules")
  ) {
    return "general";
  }
  return requested;
}

export function AgentSettings({
  slug,
  agentId,
  settings,
  channelSettings,
  ready,
  agentName,
  initialSettingsTab,
  initialA2ATaskId,
}: {
  slug: string;
  agentId: string;
  settings: SettingsData;
  channelSettings: ChannelSettingsData;
  ready: boolean;
  agentName: string;
  initialSettingsTab?: AgentSettingsTarget | null;
  initialA2ATaskId?: string;
}) {
  const t = useTranslations("console.agents");
  const automationT = useTranslations("console.agentAutomation");
  const usageT = useTranslations("console.agentUsage");
  const approvalT = useTranslations("console.toolApproval");
  const executable = isExecutableAgentRuntimeKind(settings.runtimeKind);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() =>
    resolveSettingsTab({ initialSettingsTab, executable }),
  );
  const [dirtySections, setDirtySections] = useState<AgentSettingsSection[]>(
    [],
  );
  const formSection = isAgentSettingsSection(settingsTab) ? settingsTab : null;

  // Related pages sit together; groups are set apart by whitespace, not titles.
  const navigationGroups: Array<Array<{ id: SettingsTab; label: string }>> = [
    [
      { id: "general", label: t("basic") },
      { id: "instructions", label: t("instructions") },
    ],
    [
      { id: "builtInTools", label: t("builtInTools") },
      { id: "mcp", label: t("mcp") },
      { id: "skills", label: t("skills") },
      { id: "piPackages", label: t("piPackages") },
      ...(executable
        ? [{ id: "subAgents" as const, label: t("subAgents") }]
        : []),
      { id: "memories", label: t("memories") },
    ],
    [
      { id: "sandboxes", label: t("sandboxes") },
      { id: "toolApproval", label: approvalT("title") },
      ...(executable
        ? [{ id: "streamRules" as const, label: t("streamRules.title") }]
        : []),
      { id: "advanced", label: t("advanced") },
    ],
    [
      ...(executable
        ? [{ id: "channels" as const, label: t("channelSettingsTab") }]
        : []),
      { id: "a2a", label: t("a2a.title") },
      { id: "triggers", label: automationT("triggers") },
    ],
    [
      { id: "usage", label: usageT("title") },
      { id: "changelog", label: t("changelogTab") },
      { id: "evolution", label: t("evolutionTab") },
      { id: "clone", label: t("cloneAgent") },
    ],
  ];
  const navigationItems = navigationGroups.flatMap((group, groupIndex) =>
    group.map((item, index) => ({
      ...item,
      separated: groupIndex > 0 && index === 0,
      dirty: dirtySections.includes(item.id as AgentSettingsSection),
    })),
  );

  return (
    <div className="h-full min-h-0">
      <section
        aria-label={agentName}
        className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <DialogNav
            label={t("configurationNavigation")}
            items={navigationItems}
            className="md:w-52 [&_nav]:space-y-0.5 [&_nav_button]:h-8"
            active={settingsTab}
            onSelect={(id) => setSettingsTab(id as SettingsTab)}
          />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* The form stays mounted so every section's fields are saved together. */}
            <div
              hidden={!formSection}
              className={formSection ? "h-full min-h-0" : "hidden"}
            >
              <AgentSettingsForm
                // Only saved bindings reset the draft; a workspace install from the panel must not.
                key={`${settings.publishedRevision?.id ?? "draft"}:${
                  settings.piPackages
                    ?.filter((pkg) => pkg.enabledReleaseId)
                    .map(
                      (pkg) => `${pkg.marketInstallId}:${pkg.enabledReleaseId}`,
                    )
                    .join(",") ?? ""
                }`}
                slug={slug}
                workspaceId={settings.workspaceId}
                agentId={agentId}
                name={settings.name}
                description={settings.description}
                systemPrompt={settings.systemPrompt}
                contextFiles={settings.contextFiles}
                disabledBuiltinTools={settings.disabledBuiltinTools}
                optionalBuiltinTools={settings.optionalBuiltinTools}
                providerId={settings.providerId}
                model={settings.model}
                reasoningEffort={settings.reasoningEffort}
                toolApproval={settings.toolApproval}
                secretObfuscation={settings.secretObfuscation}
                advisor={settings.advisor}
                maxSteps={settings.maxSteps}
                taskTimeoutSeconds={settings.taskTimeoutSeconds}
                defaultTaskTimeoutSeconds={settings.defaultTaskTimeoutSeconds}
                mcpToolTimeoutSeconds={settings.mcpToolTimeoutSeconds}
                providers={settings.providers}
                deployments={settings.deployments}
                skills={settings.skills}
                piPackages={settings.piPackages}
                pluginCatalog={settings.pluginCatalog}
                pluginDeployments={settings.pluginDeployments}
                ownSandbox={settings.ownSandbox}
                externalSandboxes={settings.externalSandboxes}
                runtimeKind={settings.runtimeKind}
                publishedRevision={settings.publishedRevision}
                canManageCredentials={settings.canManageCredentials}
                canApprovePluginSync={settings.canApprovePluginSync}
                activePage={
                  formSection
                    ? AGENT_SETTINGS_SECTION_PAGE[formSection]
                    : "basic"
                }
                activeSection={formSection ?? undefined}
                onSectionChange={setSettingsTab}
                onDirtySectionsChange={setDirtySections}
                className="flex h-full min-h-0 flex-col"
              />
            </div>
            {settingsTab === "evolution" ? (
              <div className="h-full min-w-0 overflow-y-auto">
                <AgentEvolutionPanel
                  key={agentId}
                  agentId={agentId}
                  currentRevisionId={settings.publishedRevision?.id ?? null}
                />
              </div>
            ) : settingsTab === "memories" ? (
              <div className="h-full min-w-0 overflow-y-auto">
                <AgentMemoriesPanel
                  key={`${slug}:${agentId}:memories`}
                  slug={slug}
                  agentId={agentId}
                />
              </div>
            ) : settingsTab === "triggers" ? (
              <div className="h-full overflow-y-auto">
                <AgentTriggersPanel
                  key={`${slug}:${agentId}:triggers`}
                  slug={slug}
                  agentId={agentId}
                  canManage={settings.canApprovePluginSync ?? false}
                />
              </div>
            ) : settingsTab === "usage" ? (
              <div className="h-full overflow-y-auto">
                <AgentUsagePanel
                  key={`${slug}:${agentId}:usage`}
                  agentId={agentId}
                  canManage={settings.canApprovePluginSync ?? false}
                />
              </div>
            ) : settingsTab === "channels" && executable ? (
              <div className="h-full w-full overflow-y-auto">
                <AgentMessagingPanel
                  slug={slug}
                  agentId={agentId}
                  sandboxId={settings.ownSandbox?.id}
                  connections={channelSettings.connections}
                  ready={ready}
                />
              </div>
            ) : settingsTab === "a2a" ? (
              <div className="h-full overflow-y-auto">
                <AgentA2APanel
                  key={`${slug}:${agentId}:${initialA2ATaskId ?? ""}`}
                  slug={slug}
                  agentId={agentId}
                  runtimeKind={settings.runtimeKind}
                  initialTaskId={initialA2ATaskId}
                />
              </div>
            ) : settingsTab === "clone" ? (
              <div className="h-full overflow-y-auto">
                <AgentClonePanel
                  slug={slug}
                  agentId={agentId}
                  agentName={settings.name}
                  mcpCount={
                    settings.deployments.filter((item) => item.checked).length
                  }
                  skillCount={
                    settings.skills.filter((item) => item.checked).length
                  }
                  piPackageCount={
                    settings.piPackages?.filter((pkg) => pkg.enabledReleaseId)
                      .length ?? 0
                  }
                />
              </div>
            ) : settingsTab === "changelog" ? (
              <div className="h-full overflow-y-auto">
                <RevisionChangelog
                  key={agentId}
                  url={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions`}
                  diffUrl={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions/diff`}
                  title={t("changelogTab")}
                  className="space-y-6 px-6 py-5"
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
