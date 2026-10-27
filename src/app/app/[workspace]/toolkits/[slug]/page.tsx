import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { ButtonLink } from "@/components/motion/button";
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/DashboardUI";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getToolkitBySlug } from "@/lib/toolkits/queries";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { deploymentLabel } from "@/lib/workspace/deployment-label";
import { skillLabel } from "@/lib/workspace/skill-label";

export const dynamic = "force-dynamic";

export default async function ToolkitHistoryPage({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>;
}) {
  const [{ workspace: slug, slug: toolkitSlug }, user, t] = await Promise.all([
    params,
    getCurrentUser(),
    getTranslations("console.toolkits"),
  ]);
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const toolkit = await getToolkitBySlug(workspace.id, toolkitSlug);
  if (!toolkit) notFound();
  const base = `/app/${encodeURIComponent(slug)}`;
  return (
    <DashboardPage className="space-y-6">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("historyTitle")}</p>
        <h1 className="break-words text-2xl font-semibold">{toolkit.name}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {t("historyReadOnly")}
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`${base}/toolkits`} variant="ghost" size="sm">
            {t("historyTitle")}
          </ButtonLink>
          <ButtonLink
            href={`${base}/market/pi-packages`}
            variant="secondary"
            size="sm"
          >
            {t("browsePiPackages")}
          </ButtonLink>
        </div>
      </header>
      <DashboardPanel title={t("mcps")}>
        {toolkit.servers.length ? (
          <ul className="divide-y divide-border">
            {toolkit.servers.map(({ id, deployment }) => (
              <li key={id} className="break-words py-3 text-sm">
                {deploymentLabel(deployment).name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
        )}
      </DashboardPanel>
      <DashboardPanel title={t("skillsTab")}>
        {toolkit.skills.length ? (
          <ul className="divide-y divide-border">
            {toolkit.skills.map(({ id, installedSkill }) => (
              <li key={id} className="break-words py-3 text-sm">
                {skillLabel(installedSkill).name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
        )}
      </DashboardPanel>
    </DashboardPage>
  );
}
