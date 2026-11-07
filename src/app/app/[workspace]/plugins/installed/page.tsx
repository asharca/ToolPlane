import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import {
  InstalledPluginsTable,
  type InstalledPluginFilter,
} from "@/components/dashboard/plugins/InstalledPluginsTable";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { db } from "@/lib/db";
import { listPlugins, pluginReleaseLabel } from "@/lib/plugins/catalog";
import { releaseContents } from "@/lib/plugins/release-contents";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";

export const dynamic = "force-dynamic";

const filters: readonly InstalledPluginFilter[] = [
  "all",
  "updates",
  "unavailable",
];

export default async function InstalledPluginsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, query, user, t, locale] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.plugins"),
    getLocale(),
  ]);
  const base = `/app/${encodeURIComponent(slug)}/plugins`;
  if (!user)
    redirect(`/app/login?next=${encodeURIComponent(`${base}/installed`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const requested = Array.isArray(query.filter)
    ? query.filter[0]
    : query.filter;
  const filter = filters.find((item) => item === requested) ?? ("all" as const);
  const [{ items }, membership] = await Promise.all([
    listPlugins(workspace.id, user.id, { installedOnly: true }),
    db.membership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { role: true },
    }),
  ]);
  const canManage =
    workspace.ownerId === user.id ||
    membership?.role === "admin" ||
    membership?.role === "owner";
  const timeZone = resolveUserTimeZone(user);
  return (
    <DashboardPage>
      <InstalledPluginsTable
        // A changed `?filter=` (e.g. from the Plugin Center link) restarts the view.
        key={filter}
        workspace={slug}
        base={base}
        canManage={canManage}
        initialFilter={filter}
        plugins={items.flatMap((plugin) => {
          const install = plugin.install;
          if (!install) return [];
          const contents = releaseContents(
            install.currentRelease.releaseSummary,
          );
          const registry = plugin.githubRegistryResource?.registry;
          return [
            {
              installId: install.id,
              listingId: plugin.id,
              name: plugin.name,
              summary: plugin.summary?.trim() || null,
              source: registry?.official
                ? t("official")
                : (registry?.repository ?? t("privatePlugin")),
              status: plugin.status,
              currentVersion: pluginReleaseLabel(install.currentRelease),
              latestVersion: plugin.latestRelease
                ? pluginReleaseLabel(plugin.latestRelease)
                : null,
              updateAvailable: plugin.updateAvailable,
              contents: contents.counts,
              mcp: contents.mcp,
              omp: contents.omp,
              agents: install._count.agentPiPackages,
              addedAt: formatInTimeZone(
                install.createdAt,
                timeZone,
                { month: "short", day: "numeric", year: "numeric" },
                locale,
              ),
            },
          ];
        })}
      />
    </DashboardPage>
  );
}
