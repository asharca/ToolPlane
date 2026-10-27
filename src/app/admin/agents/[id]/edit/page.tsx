/* DashboardTable consumes cell arrays as indexed values. */

import { Button, ButtonLink } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { History } from "lucide-react";
import Link from "next/link";
import { ReleaseChanges } from "@/components/admin/ReleaseChanges";
import { LogTimestamp } from "@/components/admin/LogUI";
import { adminHref, adminReturnHref } from "@/lib/admin/navigation";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { AgentReleaseReview } from "@/components/admin/AgentReleaseReview";
import {
  AdminBadge,
  AdminPage,
  AdminPageHeader,
  AdminPanel,
} from "@/components/admin/AdminUI";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import {
  getDirectoryAgentListing,
  readAgentReleaseManifest,
} from "@/lib/admin/agent-market";
import {
  deleteAgentListingAction,
  rejectAgentReleaseAction,
  setAgentListingStatusAction,
} from "@/lib/admin/agent-market-actions";
import { listCategories } from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function releaseStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

export default async function EditAgentListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string; releaseId?: string }>;
}) {
  const { id } = await params;
  await requireAdmin();
  const [t, listing, categories] = await Promise.all([
    getTranslations("admin"),
    getDirectoryAgentListing(id),
    listCategories(),
  ]);
  if (!listing) notFound();
  const ops = await getTranslations("adminOps");
  const query = await searchParams;
  const backHref = adminReturnHref(query.returnTo, "/admin/agents");
  const detailHref = adminHref(`/admin/agents/${id}/edit`, {
    releaseId: query.releaseId,
    returnTo: backHref,
  });
  const selectedRelease = query.releaseId
    ? await db.agentRelease.findFirst({
        where: { id: query.releaseId, listingId: id },
        include: { reviewedBy: { select: { name: true, email: true } } },
      })
    : null;
  if (query.releaseId && !selectedRelease) notFound();
  const reviewRelease = selectedRelease ?? listing.pendingRelease;
  const canReview =
    reviewRelease?.reviewStatus === "pending" &&
    reviewRelease.id === listing.pendingRelease?.id;
  const previousRelease = reviewRelease
    ? await db.agentRelease.findFirst({
        where: {
          listingId: id,
          version: { lt: reviewRelease.version },
          reviewStatus: "approved",
        },
        orderBy: { version: "desc" },
        select: { manifest: true },
      })
    : null;

  let reviewManifest: ReturnType<typeof readAgentReleaseManifest> | null = null;
  if (reviewRelease) {
    try {
      reviewManifest = readAgentReleaseManifest(
        reviewRelease.manifest,
        reviewRelease.checksum,
      );
    } catch {
      reviewManifest = null;
    }
  }

  return (
    <AdminPage className="max-w-6xl">
      <AdminPageHeader
        title={`${t("edit")} ${listing.name}`}
        meta={<AdminBadge tone="neutral">/{listing.directorySlug}</AdminBadge>}
        backHref={backHref}
        backLabel={t("directoryAgents")}
        actions={
          <ButtonLink
            href={adminHref("/admin/logs", {
              tab: "audit",
              targetType: "agentListing",
              targetId: id,
              returnTo: detailHref,
            })}
            variant="secondary"
            size="md"
          >
            <History className="size-4" />
            {ops("audit")}
          </ButtonLink>
        }
      />

      {reviewRelease && reviewManifest ? (
        <AgentReleaseReview
          listingId={listing.id}
          release={{
            ...reviewRelease,
            manifest: reviewManifest,
            publishedAt: reviewRelease.publishedAt.toISOString(),
            reviewedAt: reviewRelease.reviewedAt?.toISOString() ?? null,
          }}
          categories={categories}
          canReview={canReview}
        />
      ) : reviewRelease ? (
        <AdminPanel
          title={`${ops("review")} v${reviewRelease.version}`}
          description={t("agentInvalidPendingRelease")}
          tone="danger"
        >
          <div className="space-y-4">
            <p className="text-sm text-destructive">
              {t("agentInvalidPendingReleaseDescription")}
            </p>
            {canReview ? (
              <ConfirmDialog
                label={t("agentRejectRelease")}
                prompt={t("agentRejectReleaseDescription")}
                action={rejectAgentReleaseAction}
                hidden={{ listingId: listing.id, releaseId: reviewRelease.id }}
                pendingLabel={t("agentRejectingRelease")}
                tone="danger"
              />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm">
                {ops.has(reviewRelease.reviewStatus)
                  ? ops(reviewRelease.reviewStatus)
                  : reviewRelease.reviewStatus}
                : {reviewRelease.reviewNote ?? "-"}
              </p>
            )}
          </div>
        </AdminPanel>
      ) : null}

      {reviewRelease ? (
        <ReleaseChanges
          before={previousRelease?.manifest ?? null}
          after={reviewRelease.manifest}
        />
      ) : null}

      <p className="text-sm text-muted-foreground">
        {t("githubManagedResources")}
      </p>

      <AdminPanel
        title={t("agentReleaseHistory")}
        description={t("agentReleaseHistoryDescription")}
        actions={<History className="size-4 text-muted-foreground" />}
        padded={false}
      >
        {listing.releases.length > 0 ? (
          <DashboardTable
            ariaLabel={t("agentReleaseHistory")}
            minWidth="46rem"
            headers={[
              { label: t("agentVersionColumn") },
              { label: t("statusColumn") },
              { label: ops("reviewer") },
              { label: ops("reviewNote") },
              { label: t("agentReleaseChecksum"), width: "35%" },
              { label: t("installsColumn"), align: "right" },
            ]}
            rows={listing.releases.map((release) => ({
              id: release.id,
              cells: [
                <Link
                  key="version"
                  href={adminHref(`/admin/agents/${id}/edit`, {
                    releaseId: release.id,
                    returnTo: backHref,
                  })}
                  className="hover:underline"
                  aria-current={
                    release.id === reviewRelease?.id ? "page" : undefined
                  }
                >
                  v{release.version}
                </Link>,
                <AdminBadge
                  key="status"
                  tone={releaseStatusTone(release.reviewStatus)}
                  dot
                >
                  {ops.has(release.reviewStatus)
                    ? ops(release.reviewStatus)
                    : release.reviewStatus}
                </AdminBadge>,
                <>
                  {" "}
                  <span className="block">
                    {release.reviewedBy?.name ??
                      release.reviewedBy?.email ??
                      "-"}
                  </span>
                  {release.reviewedAt ? (
                    <LogTimestamp date={release.reviewedAt} />
                  ) : null}{" "}
                </>,
                <div key="review-note" className="min-w-0 max-w-64">
                  {release.reviewNote ? (
                    <CenterMorphModal>
                      <CenterMorphModalTrigger>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="max-w-full"
                        >
                          <span className="truncate">{release.reviewNote}</span>
                        </Button>
                      </CenterMorphModalTrigger>
                      <CenterMorphModalContent
                        ariaLabel={ops("reviewNote")}
                        closeButtonLabel={t("cancel")}
                        className="max-w-2xl"
                      >
                        <div className="space-y-4 p-6">
                          <h2 className="pr-8 text-sm font-semibold">
                            {ops("reviewNote")}
                          </h2>
                          <p
                            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long review notes.
                            tabIndex={0}
                            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm"
                          >
                            {release.reviewNote}
                          </p>
                        </div>
                      </CenterMorphModalContent>
                    </CenterMorphModal>
                  ) : (
                    "-"
                  )}
                </div>,
                <code
                  key="checksum"
                  className="block max-w-xl truncate font-mono text-xs text-muted-foreground"
                >
                  sha256:{release.checksum}
                </code>,
                release._count.installs,
              ],
            }))}
          />
        ) : (
          <p className="px-5 py-8 text-sm text-muted-foreground">
            {t("agentNoReleases")}
          </p>
        )}
      </AdminPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        {listing.status === "published" ? (
          <AdminPanel
            title={t("disableAgentListing")}
            description={t("disableAgentListingDescription")}
            tone="danger"
          >
            <ConfirmDialog
              label={t("disableAgentListing")}
              prompt={t("disableAgentListingConfirm")}
              action={setAgentListingStatusAction}
              hidden={{ id: listing.id, status: "disabled" }}
              pendingLabel={t("saving")}
              tone="danger"
            />
          </AdminPanel>
        ) : null}

        <AdminPanel
          title={t("dangerZone")}
          description={t("agentDeleteListingDescription", {
            count: listing.installCount,
          })}
          tone="danger"
        >
          <ConfirmDialog
            label={t("deleteAgentListing")}
            prompt={t("deleteAgentListingConfirm")}
            action={deleteAgentListingAction}
            hidden={{ id: listing.id }}
            pendingLabel={t("deleting")}
            tone="danger"
          />
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
