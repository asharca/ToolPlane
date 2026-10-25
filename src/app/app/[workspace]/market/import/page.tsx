import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { AddSkillDialog } from "@/components/dashboard/AddSkillDialog";
import { DeployCustomMcpDialog } from "@/components/dashboard/DeployCustomMcpDialog";
import {
  PiPackageComposeForm,
  PiPackagePublishForm,
  PiPublicResubmissionForm,
  McpPublishForm,
  type PiSourceOption,
} from "@/components/dashboard/market/SkillPublishForm";
import { Button, ButtonLink } from "@/components/motion/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import {
  getDeployments,
  getInstalledSkills,
  getWorkspaceForUser,
} from "@/lib/workspace/queries";
import {
  listPiPackageSources,
  listPrivateApprovedPiReleases,
} from "@/lib/market/pi-package-catalog";
import { readMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { skillLabel } from "@/lib/workspace/skill-label";
import { getTranslations } from "next-intl/server";
import { redirect, notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ResourceImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    type?: string;
    deploymentId?: string;
    listingId?: string;
  }>;
}) {
  const [{ workspace: slug }, query, user, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.market"),
  ]);
  const activeType =
    query.type === "skill" || query.type === "pi" || query.type === "mcp"
      ? query.type
      : "";
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/market/import${activeType ? `?type=${activeType}` : ""}`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const base = `/app/${encodeURIComponent(workspace.slug)}`;
  const [
    skills,
    deployments,
    categories,
    membership,
    privateApprovedReleases,
    sourceRows,
  ] = await Promise.all([
    activeType === "pi"
      ? getInstalledSkills(workspace.id)
      : Promise.resolve([]),
    activeType === "pi" || activeType === "mcp"
      ? getDeployments(workspace.id)
      : Promise.resolve([]),
    activeType === "pi" || activeType === "mcp"
      ? db.category.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    (activeType === "pi" || activeType === "mcp") &&
    workspace.ownerId !== user.id
      ? db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          select: { role: true },
        })
      : Promise.resolve(null),
    activeType === "pi"
      ? listPrivateApprovedPiReleases({
          workspaceId: workspace.id,
          userId: user.id,
        })
      : Promise.resolve([]),
    activeType === "pi"
      ? listPiPackageSources({ workspaceId: workspace.id, userId: user.id })
      : Promise.resolve([]),
  ]);
  const canPublish =
    workspace.ownerId === user.id || membership?.role === "admin";
  const editingId =
    typeof query.listingId === "string" ? query.listingId : undefined;
  if (query.listingId && (!editingId || editingId.length > 240)) notFound();
  const ownedListing =
    activeType === "pi" && editingId
      ? await db.marketListing.findFirst({
          where: {
            id: editingId,
            kind: "pi-package",
            publisherWorkspaceId: workspace.id,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            summary: true,
            tags: true,
            visibility: true,
            categories: { select: { id: true } },
          },
        })
      : null;
  if (editingId && !ownedListing) notFound();
  const listingDefaults = ownedListing
    ? {
        name: ownedListing.name,
        slug: ownedListing.slug,
        summary: ownedListing.summary,
        tags: ownedListing.tags,
        categoryIds: ownedListing.categories.map((category) => category.id),
      }
    : undefined;
  const selectedVisibility =
    ownedListing?.visibility === "public" ? "public" : "private";
  const piSources = sourceRows.flatMap<PiSourceOption>(
    ({ id, name, kind, url }) =>
      kind === "catalog" || kind === "npm" || kind === "git"
        ? [{ id, name, kind, url }]
        : [],
  );
  const compositionOptions = {
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skillLabel(skill).name,
    })),
    deployments: deployments.map((deployment) => ({
      id: deployment.id,
      name: deploymentLabel(deployment).name,
      tools: readMcpToolCatalog(deployment.installCfg)
        .filter(
          (tool) =>
            deployment.mcpToolExposure !== "allowlist" ||
            deployment.mcpAllowedTools.includes(tool.name),
        )
        .map((tool) => tool.name),
    })),
  };
  const requestedDeployment =
    typeof query.deploymentId === "string" ? query.deploymentId : "";
  const publishDeployment = deployments.find(
    (deployment) =>
      deployment.id === requestedDeployment && deployment.source !== "sandbox",
  );
  const flows = [
    {
      key: "skill",
      title: t("intakeSkill"),
      href: `${base}/market/import?type=skill`,
    },
    { key: "pi", title: t("intakePi"), href: `${base}/market/import?type=pi` },
    {
      key: "mcp",
      title: t("intakeMcp"),
      href: `${base}/market/import?type=mcp`,
    },
  ];
  return (
    <DashboardPage className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("intakeTitle")}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {t("intakeDescription")}
        </p>
        <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
          {t("intakeWorkflowNote")}
        </p>
      </header>
      <nav aria-label={t("resourceTypes")} className="flex flex-wrap gap-2">
        {flows.map((flow) => (
          <ButtonLink
            key={flow.key}
            href={flow.href}
            variant={activeType === flow.key ? "primary" : "secondary"}
            size="sm"
            aria-current={activeType === flow.key ? "page" : undefined}
          >
            {flow.title}
          </ButtonLink>
        ))}
      </nav>
      {activeType === "skill" ? (
        <AddSkillDialog slug={workspace.slug} inline />
      ) : null}
      {activeType === "pi" ? (
        <div className="space-y-4">
          <section className="space-y-3 rounded-lg border border-border p-4">
            <h2 className="font-semibold">
              {ownedListing
                ? `${t("submitNewVersion")}: ${ownedListing.name}`
                : t("piPublishTitle")}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("piSourceHelp")}
            </p>
            <PiPackagePublishForm
              workspace={workspace.slug}
              listingId={ownedListing?.id}
              listing={listingDefaults}
              visibility={selectedVisibility}
              canPublish={canPublish}
              categories={categories}
              sources={piSources}
              inline
            />
          </section>
          <section className="space-y-3 rounded-lg border border-border p-4">
            <h2 className="font-semibold">{t("piComposeTitle")}</h2>
            <PiPackageComposeForm
              workspace={workspace.slug}
              listingId={ownedListing?.id}
              listing={listingDefaults}
              visibility={selectedVisibility}
              canPublish={canPublish}
              categories={categories}
              options={compositionOptions}
              inline
            />
          </section>
          {canPublish ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h2 className="font-semibold">{t("piPublicResubmitTitle")}</h2>
              {privateApprovedReleases.length ? (
                <PiPublicResubmissionForm
                  workspace={workspace.slug}
                  releases={privateApprovedReleases}
                  categories={categories}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("piPublicResubmitEmpty")}
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
      {activeType === "mcp" ? (
        <div className="space-y-4">
          <section className="space-y-3 rounded-lg border border-border p-4">
            <h2 className="font-semibold">{t("intakeMcpCreateTitle")}</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("intakeMcpCreateDescription")}
            </p>
            <DeployCustomMcpDialog slug={workspace.slug} inline />
          </section>
          <section className="space-y-3 rounded-lg border border-border p-4">
            <h2 className="font-semibold">{t("intakeMcpInstallTitle")}</h2>
            <ButtonLink
              href={`${base}/market?type=mcp`}
              variant="secondary"
              size="sm"
            >
              {t("intakeMcpBrowse")}
            </ButtonLink>
          </section>
          {canPublish ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h2 className="font-semibold">{t("intakeMcpPublish")}</h2>
              <form method="get" className="flex flex-wrap gap-2">
                <input type="hidden" name="type" value="mcp" />
                <label className="min-w-0 flex-1 space-y-1 text-sm">
                  <span>{t("intakeMcpPublish")}</span>
                  <select
                    name="deploymentId"
                    required
                    defaultValue={requestedDeployment}
                    className="w-full rounded border border-border bg-background px-3 py-2"
                  >
                    <option value="">{t("resource")}</option>
                    {deployments
                      .filter((deployment) => deployment.source !== "sandbox")
                      .map((deployment) => (
                        <option key={deployment.id} value={deployment.id}>
                          {deploymentLabel(deployment).name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button type="submit" variant="secondary" size="sm">
                  {t("viewDetails")}
                </Button>
              </form>
              {publishDeployment ? (
                <McpPublishForm
                  workspace={workspace.slug}
                  mcp={{
                    id: publishDeployment.id,
                    name: deploymentLabel(publishDeployment).name,
                    slug: publishDeployment.server?.slug ?? "mcp",
                    description: null,
                  }}
                  canPublish
                  categories={categories}
                  inline
                />
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`${base}/market`} variant="ghost" size="sm">
          {t("discover")}
        </ButtonLink>
        <ButtonLink href={`${base}/market/publish`} variant="ghost" size="sm">
          {t("publishManagement")}
        </ButtonLink>
      </div>
    </DashboardPage>
  );
}
