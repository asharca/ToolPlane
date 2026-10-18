// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentMarket from "@/lib/admin/agent-market";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  status: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: { count: number }) =>
    values ? `${key}:${values.count}` : key,
}));
vi.mock("@/lib/admin/agent-market", async (original) => ({
  ...(await original<typeof AgentMarket>()),
  createDirectoryAgentTemplate: mocks.create,
  updateDirectoryAgentListing: mocks.update,
  approvePendingAgentRelease: mocks.approve,
  rejectPendingAgentRelease: mocks.reject,
  setDirectoryAgentListingStatus: mocks.status,
  deleteDirectoryAgentListing: mocks.remove,
}));
import { AdminAgentMarketError } from "@/lib/admin/agent-market";
import {
  approveAgentReleaseAction,
  createAgentListingAction,
  deleteAgentListingAction,
  rejectAgentReleaseAction,
  setAgentListingStatusAction,
  updateAgentListingAction,
} from "@/lib/admin/agent-market-actions";
function form(values: Record<string, string | undefined> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    id: "listing",
    directorySlug: "agent-template",
    name: "Agent",
    maxSteps: "20",
    ...values,
  }))
    if (value !== undefined) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin" });
  mocks.create.mockResolvedValue({ id: "created" });
});

describe("admin agent template editing", () => {
  it.each([
    { modelFormat: "openai", model: "" },
    { modelFormat: "", model: "gpt" },
    { modelFormat: "unsupported", model: "gpt" },
    { maxSteps: "1.5" },
    { maxSteps: "0" },
    { maxSteps: "999999" },
  ])("rejects invalid configuration before creating", async (values) => {
    expect(await createAgentListingAction({}, form(values))).toEqual({
      error: "errorInvalidAgentTemplateConfig",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires a name and a valid directory slug", async () => {
    expect(await createAgentListingAction({}, form({ name: " " }))).toEqual({
      error: "errorAgentNameSlugRequired",
    });
    expect(
      await updateAgentListingAction({}, form({ directorySlug: "bad_slug" })),
    ).toEqual({ error: "errorAgentNameSlugRequired" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("normalizes metadata and deduplicates resource selections on creation", async () => {
    const data = form({
      directorySlug: " TEAM-AGENT ",
      name: " Name ",
      tags: " AI,ai, Tools, ",
      status: "invalid",
      modelFormat: "openai-responses",
      model: "gpt",
      isFeatured: "on",
    });
    for (const key of ["serverIds", "skillIds", "categoryIds"]) {
      data.append(key, "one");
      data.append(key, "one");
      data.append(key, "");
    }
    await createAgentListingAction({}, data);
    expect(mocks.create).toHaveBeenCalledWith(
      {
        directorySlug: "team-agent",
        name: "Name",
        author: null,
        summary: null,
        iconUrl: null,
        tags: ["ai", "tools"],
        curated: true,
        isFeatured: true,
        status: "draft",
        categoryIds: ["one"],
        systemPrompt: null,
        maxSteps: 20,
        modelFormat: "openai-responses",
        model: "gpt",
        serverIds: ["one"],
        skillIds: ["one"],
      },
      "admin",
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/agents/created/edit");
    expect(mocks.revalidate).toHaveBeenCalledWith(
      "/app/[workspace]/market/agents",
      "page",
    );
  });
  it("does not replace stored configuration unless explicitly requested", async () => {
    expect(
      await updateAgentListingAction(
        {},
        form({ maxSteps: "invalid", status: "published" }),
      ),
    ).toEqual({ ok: true });
    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty("config");
    expect(
      await updateAgentListingAction(
        {},
        form({ updateConfig: "yes", maxSteps: "invalid" }),
      ),
    ).toEqual({ error: "errorInvalidAgentTemplateConfig" });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(
      await updateAgentListingAction(
        {},
        form({
          updateConfig: "yes",
          systemPrompt: " Be useful ",
          curated: "on",
          status: "disabled",
        }),
      ),
    ).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenLastCalledWith(
      "listing",
      expect.objectContaining({
        curated: true,
        status: "disabled",
        config: {
          systemPrompt: "Be useful",
          maxSteps: 20,
          model: null,
          modelFormat: null,
          serverIds: [],
          skillIds: [],
        },
      }),
      "admin",
    );
  });
  it.each([
    ["slug_conflict", "errorAgentDirectorySlugExists"],
    ["release_not_found", "errorAgentReleaseNotPending"],
    ["release_not_pending", "errorAgentReleaseNotPending"],
    ["pending_release_exists", "errorAgentReleasePendingBeforeConfig"],
    ["invalid_config", "errorInvalidAgentTemplateConfig"],
    ["invalid_release", "errorInvalidAgentRelease"],
    ["invalid_categories", "errorInvalidMarketCategories"],
    ["publish_without_release", "errorAgentApprovedReleaseRequired"],
    ["orphaned_publisher", "errorAgentPublisherWorkspaceMissing"],
    ["not_found", "errorActionFailed"],
  ] as const)("maps %s to an actionable user error", async (code, error) => {
    mocks.update.mockRejectedValueOnce(
      new AdminAgentMarketError(code, "rejected"),
    );
    expect(await updateAgentListingAction({}, form())).toEqual({ error });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("returns generic errors for unexpected create failures", async () => {
    mocks.create.mockRejectedValue(new Error("private database detail"));
    expect(await createAgentListingAction({}, form())).toEqual({
      error: "errorActionFailed",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("admin agent release moderation", () => {
  it("requires explicit review and categories before approving", async () => {
    expect(await approveAgentReleaseAction({}, form())).toEqual({
      error: "errorAgentReviewConfirmationRequired",
    });
    expect(
      await approveAgentReleaseAction({}, form({ reviewConfirmed: "yes" })),
    ).toEqual({ error: "errorMarketCategoryRequired" });
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("records the administrator, bounded note and unique categories", async () => {
    const data = form({
      reviewConfirmed: "yes",
      listingId: "listing",
      releaseId: "release",
      reviewNote: "n".repeat(5000),
    });
    data.append("categoryIds", "c");
    data.append("categoryIds", "c");
    expect(await approveAgentReleaseAction({}, data)).toEqual({ ok: true });
    expect(mocks.approve).toHaveBeenCalledWith({
      listingId: "listing",
      releaseId: "release",
      reviewedById: "admin",
      reviewNote: "n".repeat(4000),
      categoryIds: ["c"],
    });
    mocks.approve.mockRejectedValueOnce(
      new AdminAgentMarketError("release_not_pending", "reviewed"),
    );
    expect(await approveAgentReleaseAction({}, data)).toEqual({
      error: "errorAgentReleaseNotPending",
    });
  });
  it("rejects a release with an optional note and exposes review races", async () => {
    const data = form({ listingId: "listing", releaseId: "release" });
    expect(await rejectAgentReleaseAction({}, data)).toEqual({ ok: true });
    expect(mocks.reject).toHaveBeenCalledWith({
      listingId: "listing",
      releaseId: "release",
      reviewedById: "admin",
      reviewNote: null,
    });
    mocks.reject.mockRejectedValueOnce(
      new AdminAgentMarketError("release_not_found", "missing"),
    );
    expect(await rejectAgentReleaseAction({}, data)).toEqual({
      error: "errorAgentReleaseNotPending",
    });
  });
  it("only publishes explicitly and otherwise disables", async () => {
    expect(
      await setAgentListingStatusAction({}, form({ status: "published" })),
    ).toEqual({ ok: true });
    expect(mocks.status).toHaveBeenLastCalledWith(
      "listing",
      "published",
      "admin",
    );
    expect(
      await setAgentListingStatusAction({}, form({ status: "draft" })),
    ).toEqual({ ok: true });
    expect(mocks.status).toHaveBeenLastCalledWith(
      "listing",
      "disabled",
      "admin",
    );
    mocks.status.mockRejectedValueOnce(
      new AdminAgentMarketError("publish_without_release", "no release"),
    );
    expect(
      await setAgentListingStatusAction({}, form({ status: "published" })),
    ).toEqual({ error: "errorAgentApprovedReleaseRequired" });
  });
  it("reports referencing installs rather than redirecting after a failed deletion", async () => {
    mocks.remove.mockRejectedValueOnce(
      new AdminAgentMarketError("installed", "installed", 4),
    );
    expect(await deleteAgentListingAction({}, form())).toEqual({
      error: "errorAgentListingInstalled:4",
    });
    mocks.remove.mockRejectedValueOnce(new Error("database"));
    expect(await deleteAgentListingAction({}, form())).toEqual({
      error: "errorActionFailed",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    await deleteAgentListingAction({}, form());
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/agents");
    expect(mocks.revalidate).not.toHaveBeenCalledWith(
      "/admin/agents/listing/edit",
    );
  });
  it("authorizes before accepting any template or moderation mutation", async () => {
    mocks.auth.mockRejectedValue(new Error("Forbidden"));
    for (const action of [
      createAgentListingAction,
      updateAgentListingAction,
      approveAgentReleaseAction,
      rejectAgentReleaseAction,
      setAgentListingStatusAction,
      deleteAgentListingAction,
    ]) {
      await expect(action({}, form())).rejects.toThrow("Forbidden");
    }
    for (const mutation of [
      mocks.create,
      mocks.update,
      mocks.approve,
      mocks.reject,
      mocks.status,
      mocks.remove,
    ])
      expect(mutation).not.toHaveBeenCalled();
  });
});
