import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { listSandboxes } from "@/lib/sandboxes/queries";
import {
  getAgentPageData,
  listAgentDeploymentOptions,
  listAgents,
  listAgentSkillOptions,
  listProviders,
  resolveAgentMarketSetupGuide,
} from "@/lib/agents/queries";
import { effectiveStatus } from "@/lib/process/supervisor";
import { AgentSettings } from "@/components/dashboard/agents/AgentSettings";
import type { AgentSettingsSection } from "@/components/dashboard/agents/AgentSettingsForm";
import { listAgentChannelConnections } from "@/lib/agents/channel-connections";
import { toAgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
import { SettingsModal } from "@/components/dashboard/SettingsModal";
import { db } from "@/lib/db";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";

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
  const selectedSandboxes = new Set(
    agent.sandboxes.map((sandbox) => sandbox.sandboxId),
  );
  const selectedSubAgents = new Set(
    agent.subAgents.map((child) => child.childId),
  );
  const [
    connections,
    providers,
    deployments,
    skills,
    sandboxes,
    agents,
    installs,
    current,
  ] = await Promise.all([
    listAgentChannelConnections(ws.id, agentId),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id, selectedDeps),
    listAgentSkillOptions(ws.id, selectedSkills),
    listSandboxes(ws.id),
    listAgents(ws.id),
    db.marketInstall.findMany({
      where: { targetWorkspaceId: ws.id, listing: { kind: "pi-package" } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        currentReleaseId: true,
        listing: { select: { name: true, status: true } },
        currentRelease: { select: { version: true, reviewStatus: true } },
      },
    }),
    db.agent.findFirst({
      where: { id: agentId, workspaceId: ws.id },
      select: { currentRevisionVersion: true },
    }),
  ]);
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
  const marketSetup = await resolveAgentMarketSetupGuide(
    ws.id,
    agent.marketInstall,
  );
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
    settings === "a2a" || settings === "channels"
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
        marketSetup={marketSetup}
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
          piPackages: installs.map((install) => {
            const enabled = agent.piPackages.find(
              (pkg) => pkg.marketInstallId === install.id,
            );
            const available =
              install.status === "ready" &&
              install.listing.status === "published";
            return {
              marketInstallId: install.id,
              name: install.listing.name,
              currentReleaseId: install.currentReleaseId,
              currentVersion: install.currentRelease?.version ?? null,
              currentAvailable:
                available &&
                install.currentRelease?.reviewStatus === "approved",
              enabledReleaseId: enabled?.releaseId ?? null,
              enabledVersion: enabled?.release.version ?? null,
              enabledAvailable:
                available && enabled?.release.reviewStatus === "approved",
            };
          }),
          defaultSandboxId:
            agent.sandboxes.find((sandbox) => sandbox.isDefault)?.sandboxId ??
            null,
          sandboxes: sandboxes
            .filter(
              (sandbox) =>
                (sandbox._count.agentLinks === 0 ||
                  selectedSandboxes.has(sandbox.id)) &&
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
                ),
            )
            .map((sandbox) => ({
              id: sandbox.id,
              label: sandbox.name,
              kind: sandbox.kind,
              network: sandbox.network,
              checked: selectedSandboxes.has(sandbox.id),
              status: effectiveStatus(
                sandbox.deploymentId,
                sandbox.deployment.status,
              ),
            })),
          subAgents: agents
            .filter(
              (child) => child.id !== agentId && child.runtimeKind === "pi-sdk",
            )
            .map((child) => ({
              id: child.id,
              label: child.name,
              checked: selectedSubAgents.has(child.id),
            })),
        }}
      />
    </SettingsModal>
  );
}
