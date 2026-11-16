"use client";

import dynamic from "next/dynamic";
import { useId, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { AgentResourceOption } from "@/components/dashboard/agents/AgentResourceSelect";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";
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
import {
  isExecutableAgentRuntimeKind,
  type AgentOptionalBuiltinTool,
} from "@/lib/agents/runtime-kind";
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
  optionalBuiltinToolOptions: readonly AgentOptionalBuiltinTool[];
  providerId: string | null;
  model: string | null;
  reasoningEffort: ReasoningLevel | null;
  toolApproval?: ToolApprovalPolicy;
  secretObfuscation: boolean;
  advisor?: AgentRevisionConfig["advisor"] | null;
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
};

type ChannelSettingsData = {
  connections: AgentChannelConnectionClientView[];
};

type SettingsTab =
  | AgentSettingsSection
  | "channels"
  | "a2a"
  | "changelog"
  | "evolution"
  | "memories"
  | "triggers"
  | "usage"
  | "clone";
type InitialSettingsTab = SettingsTab | "agent";

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

type SettingsGroup =
  | "basic"
  | "capabilities"
  | "execution"
  | "connections"
  | "operations";

function isAgentSettingsSection(tab: SettingsTab): tab is AgentSettingsSection {
  return AGENT_SETTINGS_SECTIONS.includes(tab as AgentSettingsSection);
}

function resolveSettingsTab({
  initialSettingsTab,
  supportsChannelSettings,
}: {
  initialSettingsTab?: InitialSettingsTab | null;
  supportsChannelSettings: boolean;
}): SettingsTab {
  const requested =
    initialSettingsTab === "agent"
      ? "general"
      : (initialSettingsTab ?? "general");
  if (
    requested === "a2a" ||
    requested === "changelog" ||
    requested === "evolution" ||
    requested === "memories" ||
    requested === "triggers" ||
    requested === "usage" ||
    requested === "clone"
  )
    return requested;
  if (requested === "channels" && supportsChannelSettings) return requested;
  if (isAgentSettingsSection(requested)) return requested;
  return "general";
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
  initialSettingsTab?: InitialSettingsTab | null;
  initialA2ATaskId?: string;
}) {
  const t = useTranslations("console.agents");
  const automationT = useTranslations("console.agentAutomation");
  const usageT = useTranslations("console.agentUsage");
  const supportsChannelSettings = isExecutableAgentRuntimeKind(
    settings.runtimeKind,
  );
  const requestedTab = resolveSettingsTab({
    initialSettingsTab,
    supportsChannelSettings,
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    (requestedTab === "subAgents" || requestedTab === "streamRules") &&
      !supportsChannelSettings
      ? "general"
      : requestedTab,
  );
  const [dirtySections, setDirtySections] = useState<AgentSettingsSection[]>(
    [],
  );

  const approvalT = useTranslations("console.toolApproval");
  const common = useTranslations("common");
  const panelId = useId();
  const lastTabs = useRef<Partial<Record<SettingsGroup, SettingsTab>>>({});
  const groups = [
    {
      id: "basic",
      tabs: [
        { id: "general", label: t("basic") },
        { id: "instructions", label: t("instructions") },
      ],
    },
    {
      id: "capabilities",
      tabs: [
        { id: "builtInTools", label: t("builtInTools") },
        { id: "mcp", label: t("mcp") },
        { id: "skills", label: t("skills") },
        { id: "piPackages", label: t("piPackages") },
        ...(supportsChannelSettings
          ? [{ id: "subAgents" as const, label: t("subAgents") }]
          : []),
      ],
    },
    {
      id: "execution",
      tabs: [
        { id: "sandboxes", label: t("sandboxes") },
        { id: "toolApproval", label: approvalT("title") },
        ...(supportsChannelSettings
          ? [{ id: "streamRules" as const, label: t("streamRules.title") }]
          : []),
        { id: "advanced", label: t("advanced") },
      ],
    },
    {
      id: "connections",
      tabs: [
        ...(supportsChannelSettings
          ? [{ id: "channels" as const, label: t("channelSettingsTab") }]
          : []),
        { id: "a2a", label: t("a2a.title") },
        { id: "triggers", label: automationT("triggers") },
      ],
    },
    {
      id: "operations",
      tabs: [
        { id: "memories", label: t("memories") },
        { id: "usage", label: usageT("title") },
        { id: "changelog", label: t("changelogTab") },
        { id: "evolution", label: t("evolutionTab") },
        { id: "clone", label: t("cloneAgent") },
      ],
    },
  ] satisfies Array<{
    id: SettingsGroup;
    tabs: Array<{ id: SettingsTab; label: string }>;
  }>;
  const activeGroup =
    groups.find((group) => group.tabs.some((tab) => tab.id === settingsTab)) ??
    groups[0];
  function selectTab(tab: SettingsTab) {
    lastTabs.current[activeGroup.id] = settingsTab;
    const group = groups.find((item) =>
      item.tabs.some((item) => item.id === tab),
    );
    if (group) lastTabs.current[group.id] = tab;
    setSettingsTab(tab);
  }

  const showSubtabs = activeGroup.id !== "basic" && activeGroup.tabs.length > 1;
  const published = settings.publishedRevision
    ? t("revisions.published", {
        version: settings.publishedRevision.version,
      })
    : t("revisions.unpublished");

  return (
    <div className="h-full min-h-0">
      <section
        aria-label={agentName}
        className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      >
        <header className="shrink-0 border-b border-border">
          <div className="flex items-center gap-3 px-4 py-3 md:px-6">
            <nav
              aria-label={t("configurationNavigation")}
              className="min-w-0 flex-1 overflow-x-auto"
            >
              <div className="inline-flex min-w-0 gap-1">
                {groups.map((group) => {
                  const active = group.id === activeGroup.id;
                  const dirty = group.tabs.some((tab) =>
                    dirtySections.includes(tab.id as AgentSettingsSection),
                  );
                  return (
                    <button
                      key={group.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        const remembered =
                          group.id === activeGroup.id
                            ? settingsTab
                            : lastTabs.current[group.id];
                        selectTab(
                          group.tabs.find((tab) => tab.id === remembered)?.id ??
                            group.tabs[0].id,
                        );
                      }}
                      className={cn(
                        "inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      {t(`navigationGroups.${group.id}`)}
                      {dirty ? (
                        <span
                          role="img"
                          aria-label={common("modified")}
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </nav>
            <p className="shrink-0 text-xs text-muted-foreground">
              {published}
            </p>
          </div>
          {showSubtabs ? (
            <div className="px-2 md:px-4">
              <Tabs
                value={settingsTab}
                onValueChange={(id) => selectTab(id as SettingsTab)}
                variant="underline"
                className="min-w-0"
              >
                <TabsList
                  aria-label={t(`navigationGroups.${activeGroup.id}`)}
                  wrapperClassName="min-w-0"
                  className="border-b-0"
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const tabs = activeGroup.tabs;
                    const index = tabs.findIndex(
                      (tab) => tab.id === settingsTab,
                    );
                    const nextIndex =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              tabs.length) %
                            tabs.length;
                    const next = tabs[nextIndex].id;
                    selectTab(next);
                    document.getElementById(`${panelId}-${next}`)?.focus();
                  }}
                >
                  {activeGroup.tabs.map((tab) => (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      id={`${panelId}-${tab.id}`}
                      aria-controls={panelId}
                      tabIndex={tab.id === settingsTab ? 0 : -1}
                      className="shrink-0 gap-2 whitespace-nowrap px-3 text-sm"
                      indicatorClassName="h-0.5"
                    >
                      {tab.label}
                      {dirtySections.includes(
                        tab.id as AgentSettingsSection,
                      ) ? (
                        <span
                          role="img"
                          aria-label={common("modified")}
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          ) : null}
        </header>
        <div
          id={panelId}
          {...(showSubtabs
            ? {
                role: "tabpanel" as const,
                "aria-labelledby": `${panelId}-${settingsTab}`,
              }
            : {})}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          <div
            hidden={!isAgentSettingsSection(settingsTab)}
            className={
              isAgentSettingsSection(settingsTab) ? "h-full min-h-0" : "hidden"
            }
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
              optionalBuiltinToolOptions={settings.optionalBuiltinToolOptions}
              providerId={settings.providerId}
              model={settings.model}
              reasoningEffort={settings.reasoningEffort}
              toolApproval={settings.toolApproval}
              secretObfuscation={settings.secretObfuscation}
              advisor={settings.advisor}
              maxSteps={settings.maxSteps}
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
              activeSection={
                isAgentSettingsSection(settingsTab) ? settingsTab : "general"
              }
              onSectionChange={selectTab}
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
          ) : settingsTab === "channels" && supportsChannelSettings ? (
            <div className="h-full w-full overflow-y-auto">
              <AgentMessagingPanel
                showHeader={false}
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
                showHeader={false}
                key={agentId}
                url={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions`}
                diffUrl={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions/diff`}
                title={t("changelogTab")}
                className="space-y-5 px-6 py-5"
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
