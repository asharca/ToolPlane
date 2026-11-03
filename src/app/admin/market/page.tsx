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
import { Button } from "@/components/motion/button";

export const dynamic = "force-dynamic";

export default async function AdminPluginsPage() {
  await requireAdmin();
  const t = await getTranslations("admin");
  const listings = await db.marketListing.findMany({
    where: { kind: "pi-package" },
    orderBy: { updatedAt: "desc" },
    include: { releases: { orderBy: { createdAt: "desc" } } },
  });
  return (
    <AdminPage>
      <AdminPageHeader title={t("adminNavCatalog")} />
      {listings.map((listing) => (
        <AdminPanel key={listing.id} title={listing.name}>
          <p className="text-sm text-muted-foreground">
            {listing.namespace}/{listing.slug} · {listing.status}
          </p>
          {listing.status === "published" && (
            <form action={withdrawPluginListing} className="mt-3">
              <input type="hidden" name="listingId" value={listing.id} />
              <Button type="submit" variant="secondary">
                {t("pluginWithdraw")}
              </Button>
            </form>
          )}
          <ul className="mt-4 divide-y divide-border">
            {listing.releases.map((release) => (
              <li
                key={release.id}
                className="flex items-center justify-between gap-4 py-3"
              >
                <span>
                  {release.version} · {release.reviewStatus}
                </span>
                {release.reviewStatus === "approved" && (
                  <form action={revokePluginRelease}>
                    <input type="hidden" name="releaseId" value={release.id} />
                    <Button type="submit" variant="secondary">
                      {t("pluginRevoke")}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </AdminPanel>
      ))}
      {!listings.length && (
        <p className="text-muted-foreground">{t("pluginEmpty")}</p>
      )}
    </AdminPage>
  );
}
