import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: vi.fn(), releases: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: mocks.workspace },
    marketRelease: { findMany: mocks.releases },
  },
}));
import { listPrivateApprovedPiReleases } from "@/lib/market/pi-package-catalog";
beforeEach(() => vi.resetAllMocks());
it("authorizes publisher access and returns only safe private approved release metadata", async () => {
  mocks.workspace.mockResolvedValue({ id: "workspace" });
  mocks.releases.mockResolvedValue([
    {
      id: "release",
      version: 1,
      checksum: "digest",
      listing: {
        id: "listing",
        slug: "private",
        name: "Private",
        summary: null,
        iconUrl: null,
        tags: [],
      },
    },
  ]);
  expect(
    await listPrivateApprovedPiReleases({
      workspaceId: "workspace",
      userId: "user",
    }),
  ).toEqual([
    {
      releaseId: "release",
      version: 1,
      checksum: "digest",
      listing: {
        id: "listing",
        slug: "private",
        name: "Private",
        summary: null,
        iconUrl: null,
        tags: [],
      },
    },
  ]);
  expect(mocks.workspace).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: "workspace",
        status: "active",
        OR: expect.arrayContaining([
          {
            members: {
              some: { userId: "user", role: { in: ["owner", "admin"] } },
            },
          },
        ]),
      }),
    }),
  );
  expect(mocks.releases).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        reviewStatus: "approved",
        listing: {
          kind: "pi-package",
          visibility: "private",
          status: "published",
          publisherWorkspaceId: "workspace",
        },
      },
    }),
  );
});
it("does not query release metadata after authorization is revoked", async () => {
  mocks.workspace.mockResolvedValue(null);
  await expect(
    listPrivateApprovedPiReleases({ workspaceId: "other", userId: "user" }),
  ).rejects.toMatchObject({ code: "not_authorized" });
  expect(mocks.releases).not.toHaveBeenCalled();
});
