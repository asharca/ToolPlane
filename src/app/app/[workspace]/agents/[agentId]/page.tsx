import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { listSandboxes } from "@/lib/sandboxes/queries";
import {
  isExternalSandboxAccess,
  isExternalSandboxCandidate,
} from "@/lib/sandboxes/external";
import {
  getAgentPageData,
  listAgentDeploymentOptions,
  listAgentSkillOptions,
  listProviders,
} from "@/lib/agents/queries";
import { effectiveStatus } from "@/lib/process/supervisor";
import { AgentSettings } from "@/components/dashboard/agents/AgentSettings";
import type { AgentSettingsSection } from "@/components/dashboard/agents/AgentSettingsForm";
import { listAgentChannelConnections } from "@/lib/agents/channel-connections";
import { toAgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import { SettingsModal } from "@/components/dashboard/SettingsModal";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { listPlugins } from "@/lib/plugins/catalog";
import {
  buildAgentPluginCatalog,
  buildAgentPluginOptions,
} from "@/lib/plugins/agent-options";
import { listPluginBindingDeployments } from "@/lib/plugins/binding-deployments";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
  searchParams: Promise<{
    c?: string;
    settings?: string;
    tab?: string;
    task?: string;
  }>;
}) {
  const { workspace: slug, agentId } = await params;
  const { c, settings, tab, task } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const agent = await getAgentPageData(ws.id, agentId);
  if (!agent) notFound();
  if (
    task !== undefined &&
    (typeof task !== "string" ||
      !task ||
      task.length > 200 ||
      settings !== "a2a")
  )
    notFound();
  if (c || tab === "chat") {
    const query = new URLSearchParams({ agent: agentId });
    if (c) query.set("c", c);
    redirect(`/app/${slug}/work?${query}`);
  }
  const selectedDeps = new Set(
    agent.servers.map((server) => server.deploymentId),
  );
  const selectedSkills = new Set(
    agent.skills.map((skill) => skill.installedSkillId),
  );
  const [
    connections,
    providers,
    deployments,
    skills,
    sandboxes,
    installs,
    catalog,
    pluginDeployments,
    current,
    externalLinks,
  ] = await Promise.all([
    listAgentChannelConnections(ws.id, agentId),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id, selectedDeps),
    listAgentSkillOptions(ws.id, selectedSkills),
    listSandboxes(ws.id),
    listPlugins(ws.id, user.id, { installedOnly: true }),
    listPlugins(ws.id, user.id),
    listPluginBindingDeployments(ws.id),
    db.agent.findFirst({
      where: { id: agentId, workspaceId: ws.id },
      select: { currentRevisionVersion: true },
    }),
    db.agentExternalSandbox.findMany({
      where: { agentId, agent: { workspaceId: ws.id } },
      select: { sandboxId: true, access: true },
    }),
  ]);
  const ownSandboxId = agent.sandboxes.find(
    (link) => link.isDefault,
  )?.sandboxId;
  const ownSandbox = sandboxes.find((sandbox) => sandbox.id === ownSandboxId);
  const revision = current?.currentRevisionVersion
    ? await db.agentRevision.findUnique({
        where: {
          agentId_version: { agentId, version: current.currentRevisionVersion },
        },
        select: { id: true, version: true, config: true },
      })
    : null;
  const publishedRevision = revision
    ? { ...revision, config: AgentRevisionConfigSchema.parse(revision.config) }
    : null;
  const allowedSections: AgentSettingsSection[] = [
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
  const initialSettingsTab =
    settings === "a2a" ||
    settings === "channels" ||
    settings === "changelog" ||
    settings === "evolution" ||
    settings === "triggers" ||
    settings === "usage"
      ? settings
      : (allowedSections.find((section) => section === settings) ?? "general");
  return (
    <SettingsModal
      title={agent.name}
      fallbackHref={`/app/${slug}/work?agent=${encodeURIComponent(agent.id)}`}
    >
      <AgentSettings
        slug={slug}
        agentId={agentId}
        initialA2ATaskId={task}
        initialSettingsTab={initialSettingsTab}
        agentName={agent.name}
        ready={agent.runtimeKind === "pi-sdk" && Boolean(publishedRevision)}
        channelSettings={{
          connections: connections.map(toAgentChannelConnectionClientView),
        }}
        settings={{
          workspaceId: ws.id,
          name: agent.name,
          description: agent.description ?? "",
          runtimeKind: agent.runtimeKind,
          systemPrompt: agent.systemPrompt ?? "",
          disabledBuiltinTools: agent.disabledBuiltinTools,
          providerId: agent.providerId,
          model: agent.model,
          maxSteps: agent.maxSteps,
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            format: provider.format,
            models: provider.models,
            modelRecords: (provider.modelRecords ?? []).map((model) => ({
              modelId: model.modelId,
              primaryType: model.primaryType,
              capabilities: model.capabilities,
              inputModalities: model.inputModalities,
              cost: model.cost,
            })),
          })),
          deployments,
          skills,
          publishedRevision,
          canManageCredentials: ws.ownerId === user.id,
          canApprovePluginSync:
            ws.ownerId === user.id ||
            Boolean(
              await db.membership.findFirst({
                where: {
                  workspaceId: ws.id,
                  userId: user.id,
                  role: { in: ["owner", "admin"] },
                },
                select: { userId: true },
              }),
            ),
          piPackages: buildAgentPluginOptions(installs.items, agent),
          pluginCatalog: buildAgentPluginCatalog(
            catalog.items,
            agent.runtimeKind,
          ),
          pluginDeployments,
          ownSandbox: ownSandbox
            ? {
                id: ownSandbox.id,
                name: ownSandbox.name,
                kind: ownSandbox.kind,
                image: ownSandbox.image,
                network: ownSandbox.network,
                status: effectiveStatus(
                  ownSandbox.deploymentId,
                  ownSandbox.deployment.status,
                ),
              }
            : null,
          // Attached rows stay listed in any state so saving never detaches them silently.
          externalSandboxes: sandboxes
            .filter(
              (sandbox) =>
                isExternalSandboxCandidate({
                  kind: sandbox.kind,
                  config: sandbox.config,
                  isAgentTemplate: sandbox._count.agentLinks > 0,
                }) &&
                (externalLinks.some((link) => link.sandboxId === sandbox.id) ||
                  ![
                    "copying",
                    "copy_failed",
                    "restoring",
                    "restore_failed",
                    "restore_cleanup_required",
                    "upgrading",
                    "deleting",
                  ].includes(
                    effectiveStatus(
                      sandbox.deploymentId,
                      sandbox.deployment.status,
                    ),
                  )),
            )
            .map((sandbox) => {
              const access = externalLinks.find(
                (link) => link.sandboxId === sandbox.id,
              )?.access;
              return {
                id: sandbox.id,
                name: sandbox.name,
                kind: sandbox.kind,
                access: isExternalSandboxAccess(access) ? access : null,
                status: effectiveStatus(
                  sandbox.deploymentId,
                  sandbox.deployment.status,
                ),
              };
            }),
        }}
      />
    </SettingsModal>
  );
}
