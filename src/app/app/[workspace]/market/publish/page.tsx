import { ButtonLink } from "@/components/motion/button";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listWorkspacePublishedResources } from "@/lib/market/skills";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { DashboardPage } from "@/components/dashboard/DashboardUI";
import { PublisherControls } from "@/components/dashboard/market/PublisherControls";
import type { ListingStatus } from "@/components/dashboard/market/PublisherControls";

export const dynamic = "force-dynamic";

export default async function MarketPublishPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const [{ workspace: slug }, t, common, user] = await Promise.all([
    params,
    getTranslations("console.market"),
    getTranslations("common"),
    getCurrentUser(),
  ]);
  if (!user)
    redirect(
      `/app/login?next=${encodeURIComponent(`/app/${slug}/market/publish`)}`,
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");

  const [listings, membership] = await Promise.all([
    listWorkspacePublishedResources(workspace.id),
    workspace.ownerId === user.id
      ? Promise.resolve(null)
      : db.membership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          select: { role: true },
        }),
  ]);
  const canPublish =
    workspace.ownerId === user.id || membership?.role === "admin";
  const base = `/app/${encodeURIComponent(workspace.slug)}`;

  const publicationLabel = (listing: ListingStatus | undefined) => {
    if (listing?.pendingRelease?.reviewStatus === "pending") {
      return t("publicationPending", {
        version: listing.pendingRelease.version,
      });
    }
    if (listing?.status === "published" && listing.latestRelease) {
      return t("publicationPublished", {
        version: listing.latestRelease.version,
      });
    }
    if (listing?.status === "disabled") return t("publicationDisabled");
    return t("publicationNotPublished");
  };
  const publisherControlLabels = {
    withdraw: t("withdrawSubmission"),
    withdrawing: t("withdrawingSubmission"),
    withdrawConfirm: t("withdrawSubmissionConfirm"),
    unpublish: t("unpublishListing"),
    unpublishing: t("unpublishingListing"),
    unpublishConfirm: t("unpublishListingConfirm"),
    cancel: common("cancel"),
  };
  const visibleListings = listings.filter(
    (listing) => listing.kind !== "toolkit",
  );

  return (
    <DashboardPage className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          {t("ownedPublications")}
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t("publishDescription")}
        </p>
        {!canPublish ? (
          <p className="mt-2 text-xs text-(--color-warning) dark:text-(--color-warning)">
            {t("publishRequiresManager")}
          </p>
        ) : null}
      </div>

      <section aria-label={t("ownedPublications")} className="space-y-3">
        {visibleListings.length ? (
          visibleListings.map((listing) => {
            const summary = listing.latestRelease?.releaseSummary;
            const policy =
              summary && typeof summary === "object" && !Array.isArray(summary)
                ? summary.reviewPolicy
                : null;
            return (
              <article
                key={listing.id}
                className="space-y-3 rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words font-semibold">
                      {listing.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {listing.namespace}/{listing.slug} ·{" "}
                      {t(
                        listing.visibility === "private"
                          ? "privateResource"
                          : "publicResource",
                      )}
                    </p>
                    <p className="mt-1 text-sm">{publicationLabel(listing)}</p>
                    {policy ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(
                          policy === "workspace-owner-trust"
                            ? "piWorkspaceOwnerTrusted"
                            : policy === "official-directory"
                              ? "piOfficialValidated"
                              : "piReviewApproved",
                        )}
                      </p>
                    ) : null}
                  </div>
                  {listing.latestRelease ? (
                    <ButtonLink
                      href={`${base}/market/items/${encodeURIComponent(listing.namespace)}/${encodeURIComponent(listing.slug)}`}
                      variant="secondary"
                      size="sm"
                    >
                      {t("viewDetails")}
                    </ButtonLink>
                  ) : null}
                  {canPublish && listing.kind === "pi-package" ? (
                    <ButtonLink
                      href={`${base}/market/import?type=pi&listingId=${encodeURIComponent(listing.id)}`}
                      variant="secondary"
                      size="sm"
                    >
                      {t("submitNewVersion")}
                    </ButtonLink>
                  ) : null}
                </div>
                {listing.pendingRelease?.reviewNote ? (
                  <p className="text-sm text-muted-foreground">
                    {listing.pendingRelease.reviewNote}
                  </p>
                ) : null}
                <PublisherControls
                  listing={listing}
                  workspace={workspace.slug}
                  canPublish={canPublish}
                  labels={publisherControlLabels}
                />
              </article>
            );
          })
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("noOwnedPublications")}
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-sm leading-6 text-muted-foreground">
          {t("packageImportOnly")}
        </p>
        <ButtonLink href={`${base}/market/import`} variant="secondary" size="sm">
          {t("intakePi")}
        </ButtonLink>
      </section>
    </DashboardPage>
  );
}
