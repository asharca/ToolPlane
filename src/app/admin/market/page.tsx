import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import {
  withdrawPluginListing,
  revokePluginRelease,
} from "@/lib/admin/plugin-actions";
import {
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";
import { AdminPluginPresetForm } from "@/components/admin/AdminPluginPresetForm";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import type { AdminActionState } from "@/lib/admin/user-actions";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import {
  evaluatePluginEnvStatus,
  supportsPlatformPreset,
} from "@/lib/plugins/env-schema";
import {
  isOfficialRegistrySource,
  readOfficialPluginPresetAdminView,
} from "@/lib/plugins/env-store";
import { pluginReleaseLabel } from "@/lib/plugins/catalog";

export const dynamic = "force-dynamic";

export default async function AdminPluginsPage() {
  await requireAdmin();
  const t = await getTranslations("admin");
  async function withdrawListingAction(
    _prev: AdminActionState,
    form: FormData,
  ): Promise<AdminActionState> {
    "use server";
    await withdrawPluginListing(form);
    return { ok: true };
  }
  async function revokeReleaseAction(
    _prev: AdminActionState,
    form: FormData,
  ): Promise<AdminActionState> {
    "use server";
    await revokePluginRelease(form);
    return { ok: true };
  }
  const listings = await db.marketListing.findMany({
    where: { kind: "pi-package" },
    orderBy: { updatedAt: "desc" },
    include: {
      githubRegistryResource: {
        select: {
          registry: { select: { official: true, workspaceId: true } },
        },
      },
      officialEnvPreset: true,
      releases: { orderBy: { createdAt: "desc" } },
    },
  });
  return (
    <AdminPage>
      <AdminPageHeader title={t("adminNavCatalog")} />
      {listings.map((listing) => {
        const isOfficial = isOfficialRegistrySource(
          listing.githubRegistryResource?.registry,
        );
        const latestApproved = [...listing.releases]
          .filter((release) => release.reviewStatus === "approved")
          .sort((a, b) => b.version - a.version)[0];
        let presetPanel: {
          status: ReturnType<typeof evaluatePluginEnvStatus>;
          nonSecretValues: Record<string, string>;
          updatedAtIso: string | null;
        } | null = null;
        if (isOfficial && latestApproved) {
          const parsed = parsePiPackageReleaseManifest(
            latestApproved.manifest,
            latestApproved.checksum,
          );
          const requirements = parsed.package.toolplane?.env ?? [];
          const httpProxies = parsed.package.toolplane?.httpProxies ?? [];
          if (supportsPlatformPreset({ env: requirements, httpProxies })) {
            const view = readOfficialPluginPresetAdminView({
              listingId: listing.id,
              requirements,
              preset: listing.officialEnvPreset,
            });
            presetPanel = {
              status: evaluatePluginEnvStatus({
                requirements,
                httpProxies,
                isOfficial: true,
                presetConfiguredKeys: view.configuredKeys,
              }),
              nonSecretValues: view.nonSecretValues,
              updatedAtIso: view.updatedAt?.toISOString() ?? null,
            };
          }
        }
        return (
          <AdminPanel key={listing.id} title={listing.name}>
            <p className="text-sm text-muted-foreground">
              {listing.namespace}/{listing.slug} ·{" "}
              {t.has(`pluginListingStatuses.${listing.status}`)
                ? t(`pluginListingStatuses.${listing.status}`)
                : listing.status}
            </p>
            {listing.status === "published" && (
              <div className="mt-3">
                <ConfirmDialog
                  label={t("pluginWithdraw")}
                  prompt={`${t("pluginWithdraw")}: ${listing.name} (${listing.namespace}/${listing.slug})`}
                  action={withdrawListingAction}
                  hidden={{ listingId: listing.id }}
                  tone="danger"
                  showStatusMessage={false}
                />
              </div>
            )}
            {presetPanel ? (
              <AdminPluginPresetForm
                key={`${listing.id}:${presetPanel.updatedAtIso ?? "none"}`}
                listingId={listing.id}
                status={presetPanel.status}
                nonSecretValues={presetPanel.nonSecretValues}
              />
            ) : null}
            <ul className="mt-4 divide-y divide-border">
              {listing.releases.map((release) => (
                <li
                  key={release.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <span>
                    v{pluginReleaseLabel(release)} ·{" "}
                    {t.has(`pluginReviewStatuses.${release.reviewStatus}`)
                      ? t(`pluginReviewStatuses.${release.reviewStatus}`)
                      : release.reviewStatus}
                  </span>
                  {release.reviewStatus === "approved" && (
                    <ConfirmDialog
                      label={t("pluginRevoke")}
                      prompt={`${t("pluginRevoke")}: ${listing.name} v${pluginReleaseLabel(release)}`}
                      action={revokeReleaseAction}
                      hidden={{ releaseId: release.id }}
                      tone="danger"
                      showStatusMessage={false}
                    />
                  )}
                </li>
              ))}
            </ul>
          </AdminPanel>
        );
      })}
      {!listings.length && (
        <p className="text-muted-foreground">{t("pluginEmpty")}</p>
      )}
    </AdminPage>
  );
}
