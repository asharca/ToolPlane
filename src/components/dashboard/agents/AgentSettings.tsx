"use client";
import { DialogNav } from "../dialog";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  Blocks,
  Cable,
  Settings2,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
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
  AgentSettingsPage,
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
import { SettingsSection } from "./SettingsSection";

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
  | "triggers"
  | "usage"
  | "changelog"
  | "evolution"
  | "clone"
  | "memories";
/** Every value accepted by `?settings=`; each lands on a page and a section. */
export type AgentSettingsTarget = AgentSettingsSection | PanelTarget;
type SettingsPage = AgentSettingsPage | "connections" | "operations";

const PANEL_PAGE: Record<PanelTarget, SettingsPage> = {
  channels: "connections",
  a2a: "connections",
  triggers: "connections",
  usage: "operations",
  changelog: "operations",
  evolution: "operations",
  clone: "operations",
  memories: "capabilities",
};

function pageFor(target: AgentSettingsTarget): SettingsPage {
  return target in PANEL_PAGE
    ? PANEL_PAGE[target as PanelTarget]
    : AGENT_SETTINGS_SECTION_PAGE[target as AgentSettingsSection];
}

/** Memory management lives in the long-term memory feature row. */
function sectionFor(target: AgentSettingsTarget) {
  return target === "memories" ? "builtInTools" : target;
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
  const supportsChannelSettings = isExecutableAgentRuntimeKind(
    settings.runtimeKind,
  );
  const initialTarget =
    initialSettingsTab === "channels" && !supportsChannelSettings
      ? "general"
      : (initialSettingsTab ?? "general");
  const [page, setPage] = useState<SettingsPage>(pageFor(initialTarget));
  // The section to bring into view after the next render of its page.
  const [scrollTarget, setScrollTarget] = useState<string | null>(
    initialTarget === "general" ? null : sectionFor(initialTarget),
  );
  const [dirtySections, setDirtySections] = useState<AgentSettingsSection[]>(
    [],
  );
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollTarget) return;
    const frame = requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector(`[data-settings-section="${scrollTarget}"]`)
        ?.scrollIntoView({ block: "start" });
      setScrollTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget]);

  const pages = [
    { id: "basic", icon: SlidersHorizontal, top: "general" },
    { id: "capabilities", icon: Blocks, top: "builtInTools" },
    { id: "execution", icon: Workflow, top: "toolApproval" },
    {
      id: "connections",
      icon: Cable,
      top: supportsChannelSettings ? "channels" : "a2a",
    },
    { id: "operations", icon: Settings2, top: "usage" },
  ] satisfies Array<{
    id: SettingsPage;
    icon: typeof Settings2;
    top: string;
  }>;

  function show(section: AgentSettingsSection) {
    setPage(AGENT_SETTINGS_SECTION_PAGE[section]);
    setScrollTarget(section);
  }

  const formPage =
    page === "basic" || page === "capabilities" || page === "execution"
      ? page
      : null;

  return (
    <div className="h-full min-h-0">
      <section
        aria-label={agentName}
        className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <DialogNav
            label={t("configurationNavigation")}
            items={pages.map((item) => ({
              id: item.id,
              label: t(`navigationGroups.${item.id}`),
              icon: <item.icon aria-hidden="true" />,
              dirty: dirtySections.some(
                (section) => AGENT_SETTINGS_SECTION_PAGE[section] === item.id,
              ),
            }))}
            active={page}
            onSelect={(id) => {
              const next = pages.find((item) => item.id === id);
              if (!next) return;
              setPage(next.id);
              setScrollTarget(next.top);
            }}
            footer={
              settings.publishedRevision
                ? t("revisions.published", {
                    version: settings.publishedRevision.version,
                  })
                : t("revisions.unpublished")
            }
          />
          <div
            ref={contentRef}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {/* The form stays mounted so every page's fields are saved together. */}
            <div
              hidden={!formPage}
              className={formPage ? "h-full min-h-0" : "hidden"}
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
                activePage={formPage ?? "basic"}
                initialMemoryManagerOpen={initialTarget === "memories"}
                onSectionChange={show}
                onDirtySectionsChange={setDirtySections}
                className="flex h-full min-h-0 flex-col"
              />
            </div>
            {page === "connections" ? (
              <div className="h-full min-w-0 space-y-2 overflow-y-auto pb-5">
                {supportsChannelSettings ? (
                  <SettingsSection
                    id="channels"
                    title={t("channelSettingsTab")}
                    flush
                  >
                    <AgentMessagingPanel
                      showHeader={false}
                      slug={slug}
                      agentId={agentId}
                      sandboxId={settings.ownSandbox?.id}
                      connections={channelSettings.connections}
                      ready={ready}
                    />
                  </SettingsSection>
                ) : null}
                <SettingsSection id="a2a" title={t("a2a.title")} flush>
                  <AgentA2APanel
                    key={`${slug}:${agentId}:${initialA2ATaskId ?? ""}`}
                    slug={slug}
                    agentId={agentId}
                    runtimeKind={settings.runtimeKind}
                    initialTaskId={initialA2ATaskId}
                  />
                </SettingsSection>
                <SettingsSection
                  id="triggers"
                  title={automationT("triggers")}
                  flush
                >
                  <AgentTriggersPanel
                    key={`${slug}:${agentId}:triggers`}
                    slug={slug}
                    agentId={agentId}
                    canManage={settings.canApprovePluginSync ?? false}
                  />
                </SettingsSection>
              </div>
            ) : page === "operations" ? (
              <div className="h-full min-w-0 space-y-2 overflow-y-auto pb-5">
                <SettingsSection id="usage" title={usageT("title")} flush>
                  <AgentUsagePanel
                    key={`${slug}:${agentId}:usage`}
                    agentId={agentId}
                    canManage={settings.canApprovePluginSync ?? false}
                  />
                </SettingsSection>
                <SettingsSection id="changelog" title={t("changelogTab")} flush>
                  <RevisionChangelog
                    showHeader={false}
                    key={agentId}
                    url={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions`}
                    diffUrl={`/api/v1/agents/${encodeURIComponent(agentId)}/revisions/diff`}
                    title={t("changelogTab")}
                    className="space-y-5 px-6 py-5"
                  />
                </SettingsSection>
                <SettingsSection id="evolution" title={t("evolutionTab")} flush>
                  <AgentEvolutionPanel
                    key={agentId}
                    agentId={agentId}
                    currentRevisionId={settings.publishedRevision?.id ?? null}
                  />
                </SettingsSection>
                <SettingsSection id="clone" title={t("cloneAgent")} flush>
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
                </SettingsSection>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
