import { Wrench } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AdminBadge,
  AdminEmptyState,
  AdminEntity,
  AdminPage,
  AdminPageHeader,
  AdminPagination,
  AdminSearchForm,
  AdminTableLink,
} from "@/components/admin/AdminUI";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import { listDirectorySkills } from "@/lib/admin/market";
import { normalizeAdminPage } from "@/lib/admin/pagination";
import { adminHref } from "@/lib/admin/navigation";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export default async function AdminSkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const [t, params] = await Promise.all([
    getTranslations("admin"),
    searchParams,
    requireAdmin(),
  ]);
  const { page = "1" } = params;
  const rawQuery = params.q ?? "";
  const q = rawQuery.trim();
  const rawPage = Number(page);
  const requestedPage = normalizeAdminPage(rawPage);
  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listDirectorySkills({ page: requestedPage, q });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set("q", q);
    return `/admin/skills?${query.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawQuery !== q || rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={t("directorySkills")}
        description={t("skillsDescription")}
        meta={t("skillCount", { count: total.toLocaleString() })}
      />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t("searchNameOrSlug")}
        label={t("searchNameOrSlug")}
        searchLabel={t("search")}
        clearLabel={t("clear")}
        clearHref="/admin/skills"
      />

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Wrench}
          title={t("noSkills")}
          description={
            q ? t("noSkillsDescription") : t("emptySkillsDescription")
          }
        />
      ) : (
        <DashboardTable
          ariaLabel={t("skillsTableLabel")}
          minWidth="64rem"
          headers={[
            { label: t("skillColumn"), width: "35%" },
            { label: t("scoreColumn"), align: "right" },
            { label: t("installsColumn"), align: "right" },
            { label: t("bundleColumn"), align: "right" },
            { label: t("statusColumn") },
            { label: <span className="sr-only">{t("edit")}</span> },
          ]}
          rows={items.map((skill) => {
            const bundleSize = Array.isArray(skill.files)
              ? skill.files.length + 1
              : 1;

            return {
              id: skill.id,
              cells: [
                <>
                  {" "}
                  <AdminEntity
                    title={
                      <Link
                        href={adminHref(`/admin/skills/${skill.id}/edit`, {
                          returnTo: hrefForPage(currentPage),
                        })}
                        className="hover:underline"
                      >
                        {skill.name}
                      </Link>
                    }
                    description={`/${skill.slug}`}
                    initials={skill.name}
                  />{" "}
                </>,
                skill.score,
                skill._count.installs,
                bundleSize,
                skill.curated ? (
                  <AdminBadge key="curation" tone="info">
                    {t("curated")}
                  </AdminBadge>
                ) : (
                  <span
                    key="curation"
                    className="text-sm text-muted-foreground"
                  >
                    {t("none")}
                  </span>
                ),
                <>
                  {" "}
                  <AdminTableLink
                    href={adminHref(`/admin/skills/${skill.id}/edit`, {
                      returnTo: hrefForPage(currentPage),
                    })}
                    label={`${t("edit")}: ${skill.name}`}
                  />{" "}
                </>,
              ],
            };
          })}
        />
      )}

      <AdminPagination
        page={currentPage}
        total={total}
        pageSize={pageSize}
        itemLabel={t("directorySkills")}
        pageLabel={t("page")}
        previousLabel={t("prev")}
        nextLabel={t("next")}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
