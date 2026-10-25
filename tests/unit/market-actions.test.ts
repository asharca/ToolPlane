// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  installMarketRelease: vi.fn(),
  publish: vi.fn(),
  preview: vi.fn(),
  update: vi.fn(),
  ignore: vi.fn(),
  remove: vi.fn(),
  withdraw: vi.fn(),
  unpublish: vi.fn(),
  deleteAssistant: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
}));
vi.mock("@/lib/chat/service", () => ({
  deleteChatAssistant: mocks.deleteAssistant,
}));
vi.mock("@/lib/market/skills", () => ({
  ignoreMarketUpdate: mocks.ignore,
  MarketError: class MarketError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  publishAssistantRelease: mocks.publish,
  publishSkillRelease: mocks.publish,
  removeMarketInstall: mocks.remove,
}));
vi.mock("@/lib/market/resources", () => ({
  installMarketRelease: mocks.installMarketRelease,
  publishMcpRelease: mocks.publish,
  publishPiPackageRelease: mocks.publish,
  publishAssembledPiPackageRelease: mocks.publish,
  previewPiPackageSource: mocks.preview,
  updateMarketInstall: mocks.update,
}));
vi.mock("@/lib/market/publisher-management", () => ({
  unpublishMarketListing: mocks.unpublish,
  withdrawMarketRelease: mocks.withdraw,
}));

import * as actions from "@/lib/market/actions";
import { installMarketResourceAction } from "@/lib/market/actions";
import { MarketError } from "@/lib/market/skills";

describe("market install action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: "workspace-1" });
  });

  it.each([
    ["setup_required", "/app/acme/mcp/deployment-1?tab=variables"],
    ["stopped", "/app/acme/mcp/deployment-1"],
  ])(
    "redirects an MCP in %s state to its next required step",
    async (status, expected) => {
      mocks.installMarketRelease.mockResolvedValue({
        kind: "mcp",
        resource: { id: "deployment-1", status },
      });
      const form = new FormData();
      form.set("workspace", "acme");
      form.set("releaseId", "release-1");

      await installMarketResourceAction(form);

      expect(mocks.redirect).toHaveBeenCalledWith(expected);
    },
  );
});

function marketForm(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "acme",
    sourceDigest: "a".repeat(64),
    ...values,
  }))
    data.set(key, value);
  return data;
}

describe("market publishing and lifecycle boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: "workspace-1" });
    mocks.publish.mockResolvedValue({ listing: { id: "listing" } });
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
  });

  it.each([
    [
      actions.publishSkillReleaseAction,
      "installedSkillId",
      "/app/acme/skills/resource",
    ],
    [actions.publishAssistantReleaseAction, "assistantId", "/app/acme/chat"],
    [actions.publishMcpReleaseAction, "deploymentId", "/app/acme/mcp/resource"],
  ] as const)(
    "validates source selection and normalizes publication metadata",
    async (action, field, path) => {
      expect(await action({}, marketForm())).toEqual({
        error: "not_authorized",
      });
      expect(mocks.publish).not.toHaveBeenCalled();
      const data = marketForm({
        [field]: "resource",
        tags: " alpha, ,beta ",
        slug: "template",
        name: "Template",
        summary: "Summary",
        releaseNotes: "Notes",
      });
      data.append("categoryIds", " c ");
      data.append("categoryIds", " ");
      expect(await action({}, data)).toEqual({
        ok: true,
        listingId: "listing",
      });
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          publishedById: "user-1",
          [field]: "resource",
          categoryIds: ["c"],
          listing: {
            slug: "template",
            name: "Template",
            summary: "Summary",
            tags: ["alpha", "beta"],
          },
          releaseNotes: "Notes",
        }),
      );
      expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
      mocks.publish.mockRejectedValueOnce(
        new MarketError("invalid_categories", "bad category"),
      );
      expect(await action({}, data)).toEqual({ error: "invalid_categories" });
      mocks.publish.mockRejectedValueOnce(new Error("private message"));
      expect(await action({}, data)).toEqual({ error: "action_failed" });
    },
  );

  it("previews real source inputs without publication and requires its digest for interactive publication", async () => {
    const preview = { sourceDigest: "b".repeat(64), name: "Captured name" };
    mocks.preview.mockResolvedValue(preview);
    const source =
      "https://github.com/acme/fixture#cccccccccccccccccccccccccccccccccccccccc";
    const form = marketForm({
      sourceType: "git",
      source,
      sourceId: "registry",
    });
    expect(await actions.previewPiPackageSourceAction({}, form)).toEqual({
      ok: true,
      preview,
    });
    expect(mocks.preview).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      publishedById: "user-1",
      source,
      sourceId: "registry",
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    form.delete("sourceDigest");
    expect(await actions.publishPiPackageReleaseAction({}, form)).toEqual({
      error: "source_preview_required",
    });
    form.set("sourceDigest", preview.sourceDigest);
    await actions.publishPiPackageReleaseAction({}, form);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDigest: preview.sourceDigest }),
    );
    mocks.preview.mockRejectedValueOnce(
      new MarketError("source_changed", "hidden"),
    );
    expect(await actions.previewPiPackageSourceAction({}, form)).toEqual({
      error: "source_changed",
    });
  });
  it("passes ZIP files and only explicit checked consent, and supports private artifact resubmission", async () => {
    const form = marketForm({ sourceType: "zip" });
    expect(await actions.publishPiPackageReleaseAction({}, form)).toEqual({
      error: "source_invalid",
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    form.set("archive", new File(["zip"], "package.zip"));
    await actions.publishPiPackageReleaseAction({}, form);
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceType: "zip",
        archive: expect.any(File),
        confirmExecutableCode: false,
        visibility: "private",
      }),
    );
    form.set("confirmExecutableCode", "on");
    await actions.publishPiPackageReleaseAction({}, form);
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmExecutableCode: true }),
    );
    await actions.publishPiPackageReleaseAction(
      {},
      marketForm({
        sourceType: "release",
        targetReleaseId: "private-release",
        visibility: "public",
      }),
    );
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceType: "release",
        targetReleaseId: "private-release",
        visibility: "public",
      }),
    );
  });
  it("keeps package publication private unless public visibility is explicit", async () => {
    expect(
      await actions.publishPiPackageReleaseAction(
        {},
        marketForm({
          sourceType: "git",
          source:
            "https://github.com/acme/pkg#cccccccccccccccccccccccccccccccccccccccc",
        }),
      ),
    ).toEqual({ ok: true, listingId: "listing" });
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source:
          "https://github.com/acme/pkg#cccccccccccccccccccccccccccccccccccccccc",
        sourceId: undefined,
        listingId: undefined,
        visibility: "private",
      }),
    );
    await actions.publishPiPackageReleaseAction(
      {},
      marketForm({
        source: "https://github.com/acme/pkg#cccccccccccccccccccccccccccccccccccccccc",
        sourceId: "source",
        visibility: "public",
        listingId: "listing",
      }),
    );
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceId: "source",
        visibility: "public",
        listingId: "listing",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/app/acme/market/import",
    );
  });

  it("groups assembled MCP tools by deployment while preserving selected skills", async () => {
    const data = marketForm({
      packageName: "@team/pkg",
      packageVersion: "1.0.0",
      visibility: "public",
    });
    for (const selected of [
      ["d1", "read"],
      ["d2", "search"],
      ["d1", "write"],
    ])
      data.append("mcpTools", JSON.stringify(selected));
    data.append("installedSkillIds", "skill");
    expect(
      await actions.publishAssembledPiPackageReleaseAction({}, data),
    ).toEqual({ ok: true, listingId: "listing" });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "@team/pkg",
        version: "1.0.0",
        installedSkillIds: ["skill"],
        mcps: [
          { deploymentId: "d1", tools: ["read", "write"] },
          { deploymentId: "d2", tools: ["search"] },
        ],
      }),
    );
  });
  it.each([
    "{}",
    '["one"]',
    '["deployment",1]',
    '["d","tool","extra"]',
    "null",
  ])("rejects malformed assembly selection %s", async (selection) => {
    const data = marketForm();
    data.append("mcpTools", selection);
    expect(
      await actions.publishAssembledPiPackageReleaseAction({}, data),
    ).toEqual({ error: "invalid_manifest" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("converts invalid JSON and package publisher failures to action errors", async () => {
    const data = marketForm();
    data.append("mcpTools", "invalid JSON");
    expect(
      await actions.publishAssembledPiPackageReleaseAction({}, data),
    ).toEqual({ error: "invalid_manifest" });
    mocks.publish.mockRejectedValueOnce(
      new MarketError("source_invalid", "bad source"),
    );
    expect(
      await actions.publishPiPackageReleaseAction({}, marketForm()),
    ).toEqual({ error: "source_invalid" });
  });

  it.each([
    ["skill", { id: "skill" }, "/app/acme/skills/skill"],
    ["pi-package", {}, "/app/acme/market/installed#install-install"],
  ])(
    "routes installed %s resources to their consumer surface",
    async (kind, resource, url) => {
      mocks.installMarketRelease.mockResolvedValue({
        kind,
        resource,
        install: { id: "install" },
      });
      await expect(
        actions.installMarketResourceAction(
          marketForm({ releaseId: "release", idempotencyKey: "request" }),
        ),
      ).rejects.toThrow(`REDIRECT:${url}`);
      expect(mocks.installMarketRelease).toHaveBeenCalledWith({
        releaseId: "release",
        targetWorkspaceId: "workspace-1",
        installedById: "user-1",
        idempotencyKey: "request",
      });
    },
  );
  it("does not swallow non-package installation failures", async () => {
    mocks.installMarketRelease.mockRejectedValueOnce(new Error("failed"));
    await expect(
      actions.installMarketResourceAction(marketForm({ releaseId: "release" })),
    ).rejects.toThrow("failed");
  });
  it("redirects package installation failures with an encoded actionable error", async () => {
    mocks.installMarketRelease.mockRejectedValue(
      new MarketError("source_not_found", "private"),
    );
    await expect(
      actions.installMarketResourceAction(
        marketForm({
          workspace: "a/b",
          releaseId: "release",
          kind: "pi-package",
        }),
      ),
    ).rejects.toThrow(
      "REDIRECT:/app/a%2Fb/market/installed?error=source_not_found",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
  it("carries optimistic update revisions and only forces explicitly", async () => {
    mocks.update.mockResolvedValue({ installedSkillId: "skill" });
    await actions.updateMarketInstallAction(
      marketForm({
        installId: "install",
        targetReleaseId: "next",
        currentReleaseId: "previous",
        force: "yes",
      }),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      installId: "install",
      targetWorkspaceId: "workspace-1",
      actorId: "user-1",
      targetReleaseId: "next",
      currentReleaseId: "previous",
      force: true,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/skills/skill");
    mocks.update.mockResolvedValue({});
    await actions.updateMarketInstallAction(
      marketForm({ installId: "install" }),
    );
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        force: false,
        targetReleaseId: undefined,
        currentReleaseId: undefined,
      }),
    );
  });
  it("preserves update failures except for package error redirects", async () => {
    mocks.update.mockRejectedValue(new Error("private"));
    await expect(
      actions.updateMarketInstallAction(marketForm({ installId: "install" })),
    ).rejects.toThrow("private");
    await expect(
      actions.updateMarketInstallAction(
        marketForm({ installId: "install", kind: "pi-package" }),
      ),
    ).rejects.toThrow(
      "REDIRECT:/app/acme/market/installed?error=action_failed",
    );
  });
  it("records the release revision when ignoring an update", async () => {
    await actions.ignoreMarketUpdateAction(
      marketForm({
        installId: "install",
        currentReleaseId: "old",
        targetReleaseId: "new",
      }),
    );
    expect(mocks.ignore).toHaveBeenCalledWith({
      installId: "install",
      targetWorkspaceId: "workspace-1",
      actorId: "user-1",
      currentReleaseId: "old",
      targetReleaseId: "new",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/app/acme/market/installed",
    );
  });
  it.each([
    [actions.withdrawMarketReleaseAction, mocks.withdraw],
    [actions.unpublishMarketListingAction, mocks.unpublish],
  ] as const)(
    "refreshes publisher and package views after changing listing availability",
    async (action, mutation) => {
      await action(marketForm({ listingId: "listing" }));
      expect(mutation).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        listingId: "listing",
        actorId: "user-1",
      });
      expect(mocks.revalidatePath).toHaveBeenCalledWith(
        "/app/acme/market/publish",
      );
      expect(mocks.revalidatePath).toHaveBeenCalledWith(
        "/app/acme/market/import",
      );
    },
  );
  it("keeps removal errors visible and redirects successful removals", async () => {
    const data = marketForm({ installId: "install" });
    mocks.remove.mockRejectedValueOnce(new MarketError("in_use", "private"));
    await expect(actions.removeMarketInstallAction(data)).rejects.toThrow(
      "?error=in_use",
    );
    mocks.remove.mockRejectedValueOnce("failure");
    await expect(actions.removeMarketInstallAction(data)).rejects.toThrow(
      "?error=action_failed",
    );
    await expect(actions.removeMarketInstallAction(data)).rejects.toThrow(
      "REDIRECT:/app/acme/market/installed",
    );
    expect(mocks.remove).toHaveBeenLastCalledWith({
      installId: "install",
      targetWorkspaceId: "workspace-1",
      actorId: "user-1",
    });
  });
  it("removes assistant copies as the current user and reports failure without refreshing", async () => {
    const data = marketForm({ assistantId: "assistant" });
    mocks.deleteAssistant.mockRejectedValueOnce(new Error("failure"));
    await expect(actions.removeAssistantMarketCopyAction(data)).rejects.toThrow(
      "?error=action_failed",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    await expect(actions.removeAssistantMarketCopyAction(data)).rejects.toThrow(
      "REDIRECT:/app/acme/market/installed",
    );
    expect(mocks.deleteAssistant).toHaveBeenCalledWith("user-1", "assistant");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/acme/chat");
  });
  it("denies anonymous and inaccessible workspaces before publication or mutations", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect(
      await actions.publishPiPackageReleaseAction({}, marketForm()),
    ).toEqual({ error: "not_authorized" });
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    expect(
      await actions.publishAssembledPiPackageReleaseAction({}, marketForm()),
    ).toEqual({ error: "not_authorized" });
    for (const action of [
      actions.installMarketResourceAction,
      actions.updateMarketInstallAction,
      actions.ignoreMarketUpdateAction,
      actions.removeMarketInstallAction,
      actions.withdrawMarketReleaseAction,
      actions.unpublishMarketListingAction,
      actions.removeAssistantMarketCopyAction,
    ])
      await action(
        marketForm({
          installId: "i",
          releaseId: "r",
          listingId: "l",
          assistantId: "a",
        }),
      );
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.installMarketRelease).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.ignore).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(mocks.unpublish).not.toHaveBeenCalled();
    expect(mocks.deleteAssistant).not.toHaveBeenCalled();
  });
});
