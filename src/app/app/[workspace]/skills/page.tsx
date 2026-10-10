import { ButtonLink } from "@/components/motion/button";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, Store } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getSkillImportSettings } from "@/lib/admin/settings";
import {
  getWorkspaceForUser,
  getInstalledSkills,
} from "@/lib/workspace/queries";
import { skillLabel } from "@/lib/workspace/skill-label";
import { AddSkillDialog } from "@/components/dashboard/AddSkillDialog";
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from "@/components/dashboard/DashboardUI";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { InstalledSkillsTable } from "@/components/dashboard/InstalledSkillsTable";

export const dynamic = "force-dynamic";

function fmt(d: Date, timeZone: string, locale: string) {
  return formatInTimeZone(
    d,
    timeZone,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    locale,
  );
}

export default async function SkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    create?: string | string[];
    imported?: string | string[];
  }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("console.skills"),
    getLocale(),
  ]);
  const { workspace: slug } = await params;
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/app/login");
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect("/app");
  const [skills, skillImportSettings] = await Promise.all([
    getInstalledSkills(ws.id),
    getSkillImportSettings(),
  ]);
  const importedIds = new Set(
    String(
      Array.isArray(query.imported) ? query.imported[0] : query.imported || "",
    )
      .split(",")
      .filter(Boolean),
  );
  const importedSkills = skills.filter((skill) => importedIds.has(skill.id));

  return (
    <DashboardPage>
      <DashboardToolbar
        actions={
          <>
            <ButtonLink
              href={`/app/${slug}/market/skills`}
              variant="secondary"
              size="md"
            >
              <Store className="size-4" />
              {t("browseSkillMarket")}
            </ButtonLink>
            <AddSkillDialog
              slug={slug}
              maxSkillImportSkills={skillImportSettings.maxSkills}
              defaultOpen={
                (Array.isArray(query.create)
                  ? query.create[0]
                  : query.create) === "1"
              }
            />
          </>
        }
      >
        <h1 className="text-xl font-semibold">{t("skills")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("installedCount", { count: skills.length })}
        </p>
      </DashboardToolbar>

      {importedSkills.length > 0 ? (
        <section className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CheckCircle2 className="size-4" />
                {t("importedSkills", { count: importedSkills.length })}
              </div>
            </div>
            <Link
              href={`/app/${slug}/skills`}
              className="text-xs font-medium text-(--color-success) underline-offset-4 hover:underline dark:text-(--color-success)"
            >
              {t("clear")}
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {importedSkills.map((skill) => {
              const label = skillLabel(skill);
              return (
                <Link
                  key={skill.id}
                  href={`/app/${slug}/skills/${skill.id}`}
                  className="min-w-0 text-sm underline-offset-4 hover:underline"
                >
                  <span className="block truncate font-medium text-foreground">
                    {label.name}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {skills.length === 0 ? (
        <DashboardEmptyState description={t("emptyInstalledHint")} />
      ) : null}

      {skills.length > 0 ? (
        <InstalledSkillsTable
          slug={slug}
          skills={skills.map((skill) => ({
            id: skill.id,
            name: skillLabel(skill).name,
            slug: skillLabel(skill).slug,
            description: skill.skill?.description ?? skill.description,
            marketManaged: Boolean(
              skill.marketInstall || skill.toolkitLinks.length,
            ),
            iconUrl: skill.skill?.iconUrl ?? null,
            createdAt: fmt(skill.createdAt, timeZone, locale),
          }))}
        />
      ) : null}
    </DashboardPage>
  );
}
