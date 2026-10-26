"use client";
import { ModalSidebar } from "../ModalSidebar";
import { Button } from "@/components/motion/button/base";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AgentResourceOption } from "@/components/dashboard/agents/AgentResourceSelect";
import type { ModelProviderOption } from "@/components/dashboard/models/ModelPicker";
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";
import type {
  AgentPiPackageOption,
  AgentSettingsSection,
} from "@/components/dashboard/agents/AgentSettingsForm";
import { AgentMarketSetupBanner } from "@/components/dashboard/agents/AgentMarketSetupBanner";
import type { AgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import type { AgentMarketSetupGuide } from "@/lib/agents/market-setup";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";

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

type SettingsData = {
  workspaceId?: string;
  name: string;
  description?: string;
  runtimeKind: string;
  systemPrompt: string;
  disabledBuiltinTools?: string[];
  providerId: string | null;
  model: string | null;
  maxSteps: number;
  providers: Array<ModelProviderOption & { format: string }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  piPackages?: AgentPiPackageOption[];
  defaultSandboxId?: string | null;
  sandboxes: AgentResourceOption[];
  subAgents: AgentResourceOption[];
  publishedRevision?: {
    id: string;
    version: number;
    config: AgentRevisionConfig;
  } | null;
  canManageCredentials?: boolean;
};

type ChannelSettingsData = {
  connections: AgentChannelConnectionClientView[];
};

type SettingsTab = AgentSettingsSection | "channels" | "a2a";
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
  if (requested === "a2a") return requested;
  if (isAgentSettingsSection(requested)) return requested;
  if (requested === "channels" && supportsChannelSettings) return requested;
  return "general";
}

export function AgentSettings({
  slug,
  agentId,
  settings,
  channelSettings,
  ready,
  agentName,
  marketSetup = null,
  initialSettingsTab,
  initialA2ATaskId,
}: {
  slug: string;
  agentId: string;
  settings: SettingsData;
  channelSettings: ChannelSettingsData;
  ready: boolean;
  agentName: string;
  marketSetup?: AgentMarketSetupGuide | null;
  initialSettingsTab?: InitialSettingsTab | null;
  initialA2ATaskId?: string;
}) {
  const t = useTranslations("console.agents");
  const supportsChannelSettings = settings.runtimeKind === "pi-sdk";
  const requestedTab = resolveSettingsTab({
    initialSettingsTab,
    supportsChannelSettings,
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(requestedTab);

  const navigationItems: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: t("basic") },
    { id: "instructions", label: t("instructions") },
    { id: "sandboxes", label: t("sandboxes") },
    { id: "advanced", label: t("advanced") },
    { id: "builtInTools", label: t("builtInTools") },
    { id: "mcp", label: t("mcp") },
    { id: "skills", label: t("skills") },
    { id: "piPackages", label: t("piPackages") },
    { id: "subAgents", label: t("subAgents") },
    { id: "a2a", label: t("a2a.title") },
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
        {marketSetup ? (
          <AgentMarketSetupBanner slug={slug} setup={marketSetup} />
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <ModalSidebar className="sm:flex sm:w-52 sm:min-h-0 sm:flex-col sm:border-b-0 sm:border-r">
            <div className="p-3 sm:hidden">
              <select
                aria-label={t("configurationNavigation")}
                value={settingsTab}
                onChange={(event) =>
                  setSettingsTab(event.target.value as SettingsTab)
                }
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {navigationItems.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <nav
              aria-label={t("configurationNavigation")}
              className="hidden min-h-0 flex-1 space-y-1 overflow-y-auto p-4 sm:block"
            >
              {navigationItems.map(({ id, label }) => {
                const active = settingsTab === id;
                return (
                  <Button
                    key={id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setSettingsTab(id)}
                    variant={active ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start text-left"
                  >
                    <span className="truncate">{label}</span>
                  </Button>
                );
              })}
            </nav>
          </ModalSidebar>
          <div
            className={cx(
              "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
          >
            {isAgentSettingsSection(settingsTab) ? (
              <AgentSettingsForm
                slug={slug}
                workspaceId={settings.workspaceId}
                agentId={agentId}
                name={settings.name}
                description={settings.description}
                systemPrompt={settings.systemPrompt}
                disabledBuiltinTools={settings.disabledBuiltinTools}
                providerId={settings.providerId}
                model={settings.model}
                maxSteps={settings.maxSteps}
                providers={settings.providers}
                deployments={settings.deployments}
                skills={settings.skills}
                piPackages={settings.piPackages}
                defaultSandboxId={settings.defaultSandboxId}
                sandboxes={settings.sandboxes}
                subAgents={settings.subAgents}
                runtimeKind={settings.runtimeKind}
                publishedRevision={settings.publishedRevision}
                canManageCredentials={settings.canManageCredentials}
                activeSection={settingsTab}
                onSectionChange={setSettingsTab}
                showNavigation={false}
                className="mx-auto w-full max-w-2xl space-y-4 px-5 py-6 sm:px-6"
              />
            ) : settingsTab === "channels" && supportsChannelSettings ? (
              <div className="mx-auto h-full w-full max-w-6xl">
                <AgentMessagingPanel
                  slug={slug}
                  agentId={agentId}
                  sandboxId={settings.defaultSandboxId ?? undefined}
                  connections={channelSettings.connections}
                  ready={ready}
                />
              </div>
            ) : settingsTab === "a2a" ? (
              <AgentA2APanel
                key={`${slug}:${agentId}:${initialA2ATaskId ?? ""}`}
                slug={slug}
                agentId={agentId}
                runtimeKind={settings.runtimeKind}
                initialTaskId={initialA2ATaskId}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
