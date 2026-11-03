"use client";
import { DialogNav } from "../dialog";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AgentResourceOption } from "@/components/dashboard/agents/AgentResourceSelect";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";
import type {
  AgentOwnSandbox,
  AgentExternalSandbox,
  AgentPiPackageOption,
  AgentSettingsSection,
} from "@/components/dashboard/agents/AgentSettingsForm";
import type { AgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";

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
  disabledBuiltinTools?: string[];
  ompConfig?: unknown;
  providerId: string | null;
  model: string | null;
  maxSteps: number;
  providers: Array<ModelProviderOption & { format: string }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  piPackages?: AgentPiPackageOption[];
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

type SettingsTab = AgentSettingsSection | "channels" | "a2a" | "changelog";
type InitialSettingsTab = SettingsTab | "agent";

const AGENT_SETTINGS_SECTIONS: readonly AgentSettingsSection[] = [
  "general",
  "instructions",
  "builtInTools",
  "mcp",
  "skills",
  "piPackages",
  "sandboxes",
  "subAgents",
  "advanced",
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

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
  if (requested === "a2a" || requested === "changelog") return requested;
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
  const supportsChannelSettings = isExecutableAgentRuntimeKind(
    settings.runtimeKind,
  );
  const requestedTab = resolveSettingsTab({
    initialSettingsTab,
    supportsChannelSettings,
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    requestedTab === "subAgents" && !supportsChannelSettings
      ? "general"
      : requestedTab,
  );
  const [dirtySections, setDirtySections] = useState<AgentSettingsSection[]>(
    [],
  );

  const navigationItems: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: t("basic") },
    { id: "instructions", label: t("instructions") },
    { id: "sandboxes", label: t("sandboxes") },
    { id: "advanced", label: t("advanced") },
    { id: "builtInTools", label: t("builtInTools") },
    { id: "mcp", label: t("mcp") },
    { id: "skills", label: t("skills") },
    { id: "piPackages", label: t("piPackages") },
    ...(isExecutableAgentRuntimeKind(settings.runtimeKind)
      ? [{ id: "subAgents" as const, label: t("subAgents") }]
      : []),
    { id: "a2a", label: t("a2a.title") },
    { id: "changelog", label: t("changelogTab") },
    ...(supportsChannelSettings
      ? [{ id: "channels" as const, label: t("channelSettingsTab") }]
      : []),
  ];

  return (
    <div className="h-full min-h-0">
      <section
        aria-label={agentName}
        className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <DialogNav
            label={t("configurationNavigation")}
            items={navigationItems.map((item) => ({
              ...item,
              dirty: dirtySections.includes(item.id as AgentSettingsSection),
            }))}
            active={settingsTab}
            onSelect={(id) => setSettingsTab(id as SettingsTab)}
          />
          <div className={cx("min-h-0 min-w-0 flex-1 overflow-hidden")}>
            <div
              hidden={!isAgentSettingsSection(settingsTab)}
              className={
                isAgentSettingsSection(settingsTab)
                  ? "h-full min-h-0"
                  : "hidden"
              }
            >
              <AgentSettingsForm
                key={`${settings.publishedRevision?.id ?? "draft"}:${settings.piPackages?.map((pkg) => `${pkg.marketInstallId}:${pkg.enabledReleaseId}`).join(",") ?? ""}`}
                slug={slug}
                workspaceId={settings.workspaceId}
                agentId={agentId}
                name={settings.name}
                description={settings.description}
                systemPrompt={settings.systemPrompt}
                disabledBuiltinTools={settings.disabledBuiltinTools}
                ompConfig={settings.ompConfig}
                providerId={settings.providerId}
                model={settings.model}
                maxSteps={settings.maxSteps}
                providers={settings.providers}
                deployments={settings.deployments}
                skills={settings.skills}
                piPackages={settings.piPackages}
                ownSandbox={settings.ownSandbox}
                externalSandboxes={settings.externalSandboxes}
                runtimeKind={settings.runtimeKind}
                publishedRevision={settings.publishedRevision}
                canManageCredentials={settings.canManageCredentials}
                canApprovePluginSync={settings.canApprovePluginSync}
                activeSection={
                  isAgentSettingsSection(settingsTab) ? settingsTab : "general"
                }
                onSectionChange={setSettingsTab}
                onDirtySectionsChange={setDirtySections}
                showNavigation={false}
                className="flex h-full min-h-0 flex-col"
              />
            </div>
            {settingsTab === "channels" && supportsChannelSettings ? (
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
            ) : settingsTab === "changelog" ? (
              <div className="h-full overflow-y-auto">
                <RevisionChangelog
                  key={agentId}
                  url={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions`}
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
