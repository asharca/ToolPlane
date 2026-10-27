import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { PiPackageSetupWizard } from "@/components/dashboard/market/PiPackageSetupWizard";
import { PiPackageDetails } from "@/components/dashboard/market/PiPackageDetails";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listMarketListings } from "@/lib/market/listings";
import {
  parsePiPackageReleaseManifest,
  projectPiPackageSummary,
  scanPiPackageReleaseManifest,
} from "@/lib/market/pi-package-manifest";
import { effectiveStatus } from "@/lib/process/supervisor";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { storedRequiredEnvironment } from "@/lib/workspace/server-recipe";
import { getDeployments, getWorkspaceForUser } from "@/lib/workspace/queries";

export const dynamic = "force-dynamic";
export default async function ConfigureInstalledPiRelease({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; installId: string }>;
  searchParams: Promise<{ releaseId?: string }>;
}) {
  const [{ workspace: slug, installId }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.market"),
  ]);
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) notFound();
  const install = await db.marketInstall.findFirst({
    where: {
      id: installId,
      targetWorkspaceId: workspace.id,
      status: "ready",
      listing: {
        kind: "pi-package",
        status: "published",
        OR: [
          { visibility: "public" },
          { visibility: "private", publisherWorkspaceId: workspace.id },
        ],
      },
    },
    include: { listing: true },
  });
  if (!install) notFound();
  const releaseId = query.releaseId ?? install.currentReleaseId;
  if (releaseId.length > 240) notFound();
  const release = await db.marketRelease.findFirst({
    where: {
      id: releaseId,
      listingId: install.listingId,
      reviewStatus: "approved",
    },
  });
  if (!release) notFound();
  const manifest = parsePiPackageReleaseManifest(
    release.manifest,
    release.checksum,
  );
  if (
    scanPiPackageReleaseManifest(manifest, release.releaseNotes).status ===
    "blocked"
  )
    notFound();
  const [agents, deployments, mcpPage, sandboxes] = await Promise.all([
    db.agent.findMany({
      where: {
        workspaceId: workspace.id,
        runtimeKind: "pi-sdk",
        publicRuntimeAllocation: null,
      },
      select: {
        id: true,
        name: true,
        currentRevisionVersion: true,
        sandboxes: { select: { sandboxId: true } },
      },
      orderBy: { name: "asc" },
    }),
    getDeployments(workspace.id),
    listMarketListings({
      kind: "mcp",
      pageSize: 50,
      sort: "name",
      viewer: { workspaceId: workspace.id, userId: user.id },
    }),
    db.sandbox.findMany({
      where: {
        workspaceId: workspace.id,
        kind: { in: ["docker", "connector"] },
      },
      select: {
        id: true,
        name: true,
        network: true,
        deploymentId: true,
        deployment: { select: { status: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]);
  const currentAgentRevisions = agents.length
    ? await db.agentRevision.findMany({
        where: {
          OR: agents.map((agent) => ({
            agentId: agent.id,
            version: agent.currentRevisionVersion,
          })),
        },
        select: { id: true, agentId: true },
      })
    : [];
  const currentRevisionIds = new Map(
    currentAgentRevisions.map((revision) => [revision.agentId, revision.id]),
  );
  const summary = release.releaseSummary;
  const policy =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? summary.reviewPolicy
      : null;
  return (
    <DashboardPage className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {t("setupWizardTitle")} · {install.listing.name}
        </h1>
        <p>{t("releaseVersion", { version: release.version })}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            policy === "workspace-owner-trust"
              ? "piWorkspaceOwnerTrusted"
              : policy === "official-directory"
                ? "piOfficialValidated"
                : "piReviewApproved",
          )}
        </p>
        <p className="text-sm text-muted-foreground">{t("piVersionImpact")}</p>
      </header>
      <PiPackageSetupWizard
        key={release.id}
        workspace={workspace.slug}
        releaseId={release.id}
        requirements={manifest.package.toolplane?.mcp ?? []}
        agents={agents.map((agent) => ({
          ...agent,
          currentRevisionId: currentRevisionIds.get(agent.id) ?? null,
        }))}
        deployments={deployments
          .filter((deployment) => deployment.source !== "sandbox")
          .map((deployment) => ({
            id: deployment.id,
            name: deploymentLabel(deployment).name,
            status: effectiveStatus(deployment.id, deployment.status),
            requiredEnvironment: storedRequiredEnvironment(
              deployment.installCfg,
            ),
          }))}
        marketMcpReleases={mcpPage.items.flatMap((item) =>
          item.latestRelease
            ? [
                {
                  id: item.latestRelease.id,
                  name: item.name,
                  version: item.latestRelease.version,
                  requiredEnvironment: item.requiredEnvironment,
                },
              ]
            : [],
        )}
        sandboxes={sandboxes.map((sandbox) => ({
          id: sandbox.id,
          name: sandbox.name,
          network: sandbox.network,
          status: effectiveStatus(
            sandbox.deploymentId,
            sandbox.deployment.status,
          ),
        }))}
      />
      <PiPackageDetails
        snapshot={projectPiPackageSummary(manifest.package)}
        checksum={release.checksum}
      />
    </DashboardPage>
  );
}
