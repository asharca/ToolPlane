// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  listing: vi.fn(),
  listingUpdate: vi.fn(),
  listingDelete: vi.fn(),
  release: vi.fn(),
  releaseUpdate: vi.fn(),
  count: vi.fn(),
  categories: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { $transaction: m.transaction, agentInstall: { count: m.count } },
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: m.audit }));
import {
  approvePendingAgentRelease,
  rejectPendingAgentRelease,
  setDirectoryAgentListingStatus,
  deleteDirectoryAgentListing,
  updateDirectoryAgentListing,
} from "@/lib/admin/agent-market";
const listing = {
  id: "l",
  publisherKind: "workspace",
  publisherWorkspaceId: "w",
  pendingReleaseId: "r",
  latestReleaseId: "old",
  latestRelease: { reviewStatus: "approved" },
  publishedAt: null,
  status: "published",
  _count: { categories: 1 },
};
const review = { listingId: "l", releaseId: "r", reviewedById: "admin" };
const metadata = {
  directorySlug: "helper",
  name: "Helper",
  author: null,
  summary: null,
  iconUrl: null,
  tags: [" TAG ", "tag"],
  curated: true,
  isFeatured: true,
  categoryIds: [" c ", "c"],
  status: "published" as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.listing.mockResolvedValue(listing);
  m.release.mockResolvedValue({
    id: "r",
    reviewStatus: "pending",
    manifestVersion: 999,
  });
  m.count.mockResolvedValue(0);
  m.categories.mockResolvedValue(1);
  m.listingUpdate.mockImplementation(async ({ data }) => ({
    id: "l",
    ...data,
  }));
  m.transaction.mockImplementation(async (run) =>
    run({
      agentListing: {
        findUnique: m.listing,
        update: m.listingUpdate,
        delete: m.listingDelete,
      },
      agentRelease: { findFirst: m.release, update: m.releaseUpdate },
      agentInstall: { count: m.count },
      category: { count: m.categories },
    }),
  );
});
describe("agent publisher moderation boundaries", () => {
  it.each([approvePendingAgentRelease, rejectPendingAgentRelease])(
    "requires a current pending release before moderation",
    async (action) => {
      m.listing
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...listing, pendingReleaseId: "other" });
      await expect(action(review)).rejects.toMatchObject({ code: "not_found" });
      await expect(action(review)).rejects.toMatchObject({
        code: "release_not_pending",
      });
      m.release
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "r", reviewStatus: "approved" });
      await expect(action(review)).rejects.toMatchObject({
        code: "release_not_found",
      });
      await expect(action(review)).rejects.toMatchObject({
        code: "release_not_pending",
      });
      expect(m.releaseUpdate).not.toHaveBeenCalled();
    },
  );
  it("does not approve orphaned publishers or unsupported release schemas", async () => {
    m.listing.mockResolvedValueOnce({ ...listing, publisherWorkspaceId: null });
    await expect(approvePendingAgentRelease(review)).rejects.toMatchObject({
      code: "orphaned_publisher",
    });
    await expect(approvePendingAgentRelease(review)).rejects.toMatchObject({
      code: "invalid_release",
    });
    m.release.mockResolvedValue({
      id: "r",
      reviewStatus: "pending",
      manifestVersion: 1,
      manifest: {},
      checksum: "broken",
    });
    await expect(approvePendingAgentRelease(review)).rejects.toMatchObject({
      code: "invalid_release",
    });
    expect(m.releaseUpdate).not.toHaveBeenCalled();
  });
  it.each([
    { latestReleaseId: null, expected: "draft" },
    { latestReleaseId: "old", expected: "published" },
  ])(
    "keeps approved versions when rejecting replacement snapshots",
    async ({ latestReleaseId, expected }) => {
      m.listing.mockResolvedValue({ ...listing, latestReleaseId });
      expect(
        await rejectPendingAgentRelease({
          ...review,
          reviewNote: "  Not approved  ",
        }),
      ).toMatchObject({ pendingReleaseId: null, status: expected });
      expect(m.releaseUpdate).toHaveBeenCalledWith({
        where: { id: "r" },
        data: expect.objectContaining({
          reviewStatus: "rejected",
          reviewedById: "admin",
          reviewNote: "Not approved",
        }),
      });
      expect(m.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "market.agent.rejected" }),
      );
    },
  );
  it("normalizes absent rejection notes to null", async () => {
    await rejectPendingAgentRelease(review);
    expect(m.releaseUpdate.mock.calls[0][0].data.reviewNote).toBeNull();
  });
  it("requires an approved categorized release and publisher for publication", async () => {
    m.listing
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...listing, publisherWorkspaceId: null })
      .mockResolvedValueOnce({ ...listing, latestReleaseId: null })
      .mockResolvedValueOnce({
        ...listing,
        latestRelease: { reviewStatus: "pending" },
      })
      .mockResolvedValueOnce({ ...listing, _count: { categories: 0 } });
    for (const code of [
      "not_found",
      "orphaned_publisher",
      "publish_without_release",
      "publish_without_release",
      "invalid_categories",
    ])
      await expect(
        setDirectoryAgentListingStatus("l", "published"),
      ).rejects.toMatchObject({ code });
    expect(m.listingUpdate).not.toHaveBeenCalled();
  });
  it.each([null, new Date("2026-01-01")])(
    "publishes with stable original publication time",
    async (publishedAt) => {
      m.listing.mockResolvedValue({ ...listing, publishedAt });
      expect(
        await setDirectoryAgentListingStatus("l", "published"),
      ).toMatchObject({
        status: "published",
        publishedAt: publishedAt ?? expect.any(Date),
      });
    },
  );
  it("can disable an orphaned uncategorized entry without republishing it", async () => {
    m.listing.mockResolvedValue({
      ...listing,
      publisherWorkspaceId: null,
      latestReleaseId: null,
      _count: { categories: 0 },
    });
    expect(
      await setDirectoryAgentListingStatus("l", "disabled", "admin"),
    ).toMatchObject({ status: "disabled" });
    expect(m.listingUpdate.mock.calls[0][0].data).not.toHaveProperty(
      "publishedAt",
    );
  });
  it("refuses deletion for missing or installed listings", async () => {
    m.listing.mockResolvedValueOnce(null);
    await expect(deleteDirectoryAgentListing("l")).rejects.toMatchObject({
      code: "not_found",
    });
    m.count.mockResolvedValue(3);
    await expect(deleteDirectoryAgentListing("l")).rejects.toMatchObject({
      code: "installed",
      count: 3,
    });
    expect(m.listingDelete).not.toHaveBeenCalled();
  });
  it("translates foreign-key races to an accurate install count", async () => {
    m.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    m.listingDelete.mockRejectedValueOnce({ code: "P2003" });
    await expect(deleteDirectoryAgentListing("l")).rejects.toMatchObject({
      code: "installed",
      count: 2,
    });
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("audits successful deletion and preserves unknown failures", async () => {
    await deleteDirectoryAgentListing("l", "admin");
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "market.agent.deleted",
        actorId: "admin",
      }),
    );
    m.listingDelete.mockRejectedValueOnce(new Error("offline"));
    await expect(deleteDirectoryAgentListing("l")).rejects.toThrow("offline");
  });
  it("updates normalized metadata without allocating another release", async () => {
    expect(
      await updateDirectoryAgentListing("l", metadata, "admin"),
    ).toMatchObject({
      tags: ["tag"],
      latestReleaseId: "old",
      categories: { set: [{ id: "c" }] },
    });
    expect(m.releaseUpdate).not.toHaveBeenCalled();
  });
  it("rejects absent metadata targets, empty categories and unpublished configurations", async () => {
    m.listing.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...listing,
      latestReleaseId: null,
      latestRelease: null,
    });
    await expect(
      updateDirectoryAgentListing("l", metadata, "admin"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateDirectoryAgentListing("l", metadata, "admin"),
    ).rejects.toMatchObject({ code: "publish_without_release" });
    await expect(
      updateDirectoryAgentListing(
        "l",
        { ...metadata, categoryIds: [" "] },
        "admin",
      ),
    ).rejects.toMatchObject({ code: "invalid_categories" });
    m.categories.mockResolvedValueOnce(0);
    await expect(
      updateDirectoryAgentListing("l", metadata, "admin"),
    ).rejects.toMatchObject({ code: "invalid_categories" });
  });
  it("refuses configuration changes while a publisher release awaits review", async () => {
    await expect(
      updateDirectoryAgentListing(
        "l",
        {
          ...metadata,
          config: {
            systemPrompt: null,
            maxSteps: 10,
            modelFormat: null,
            model: null,
            serverIds: [],
            skillIds: [],
          },
        },
        "admin",
      ),
    ).rejects.toMatchObject({ code: "pending_release_exists" });
  });
  it("translates duplicate slugs and propagates unrelated database errors", async () => {
    m.listingUpdate
      .mockRejectedValueOnce({ code: "P2002" })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      updateDirectoryAgentListing("l", metadata, "admin"),
    ).rejects.toMatchObject({ code: "slug_conflict" });
    await expect(
      updateDirectoryAgentListing("l", metadata, "admin"),
    ).rejects.toThrow("offline");
  });
});
