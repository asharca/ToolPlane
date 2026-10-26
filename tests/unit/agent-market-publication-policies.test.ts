// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishAgentRelease,
  unpublishAgentListing,
  withdrawPendingAgentRelease,
  materializeAgentRelease,
  parseAgentReleaseManifest,
  assessAgentPortability,
  buildCatalogAgentManifest,
} from "@/lib/agents/market";
import type { Prisma } from "@prisma/client";

const tx = vi.hoisted(() => ({
  workspace: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn(), findUnique: vi.fn() },
  agentListing: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentRelease: { create: vi.fn(), updateMany: vi.fn() },
  category: { count: vi.fn() },
  agentInstall: { findUnique: vi.fn() },
  server: { findMany: vi.fn() },
  skill: { findMany: vi.fn() },
}));
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
function rootAgent() {
  return {
    id: "agent",
    name: "Researcher",
    slug: "researcher",
    workspaceId: "workspace",
    runtimeKind: "pi",
    systemPrompt: null,
    maxSteps: 8,
    model: null,
    provider: null,
    sandboxes: [
      {
        sandbox: {
          id: "sandbox",
          workspaceId: "workspace",
          kind: "docker",
          network: "isolated",
        },
      },
    ],
    servers: [],
    skills: [],
    toolkits: [],
    subAgents: [],
  };
}
const publish = {
  workspaceId: "workspace",
  agentId: "agent",
  publishedById: "owner",
  listing: { categoryIds: ["category"] },
};
const transition = {
  workspaceId: "workspace",
  agentId: "agent",
  actorId: "owner",
};
const install = {
  releaseId: "release",
  targetWorkspaceId: "workspace",
  installedById: "owner",
  idempotencyKey: "key",
};

describe("round two market publication trust policies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(
      (operation: (client: typeof tx) => unknown) => operation(tx),
    );
    tx.workspace.findFirst.mockResolvedValue({ id: "workspace" });
    tx.agent.findFirst.mockResolvedValue({
      id: "agent",
      name: "Researcher",
      slug: "researcher",
      workspace: { name: "Workspace" },
    });
    tx.agent.findUnique.mockResolvedValue(rootAgent());
    tx.category.count.mockResolvedValue(1);
    tx.agentListing.create.mockResolvedValue({
      id: "listing",
      latestVersion: 0,
      status: "draft",
    });
    tx.agentListing.update.mockImplementation(async ({ data }) => ({
      id: "listing",
      ...data,
    }));
    tx.agentRelease.create.mockResolvedValue({ id: "release", version: 1 });
  });

  it.each([
    publishAgentRelease,
    unpublishAgentListing,
    withdrawPendingAgentRelease,
  ])(
    "rejects a publisher outside the authorized workspace",
    async (operation) => {
      tx.workspace.findFirst.mockResolvedValue(null);
      await expect(
        operation({ ...publish, ...transition }),
      ).rejects.toMatchObject({ code: "not_authorized" });
      expect(tx.agentRelease.create).not.toHaveBeenCalled();
      expect(tx.agentListing.update).not.toHaveBeenCalled();
    },
  );

  it("distinguishes missing source agents from nonportable graphs", async () => {
    tx.agent.findFirst.mockResolvedValueOnce(null);
    await expect(publishAgentRelease(publish)).rejects.toMatchObject({
      code: "agent_not_found",
    });
    tx.agent.findUnique.mockResolvedValue(null);
    await expect(publishAgentRelease(publish)).rejects.toMatchObject({
      code: "not_portable",
    });
    expect(tx.agentRelease.create).not.toHaveBeenCalled();
  });

  it.each([
    { categoryIds: [] },
    {
      categoryIds: Array.from(
        { length: 21 },
        (_, index) => `category-${index}`,
      ),
    },
  ])(
    "rejects empty or oversized category selection $categoryIds",
    async ({ categoryIds }) => {
      await expect(
        publishAgentRelease({ ...publish, listing: { categoryIds } }),
      ).rejects.toMatchObject({ code: "invalid_categories" });
      expect(tx.agentListing.create).not.toHaveBeenCalled();
    },
  );

  it("rejects deleted categories rather than silently dropping them", async () => {
    tx.category.count.mockResolvedValue(0);
    await expect(publishAgentRelease(publish)).rejects.toMatchObject({
      code: "invalid_categories",
    });
  });

  it("blocks credential-like content in a public summary before creating a listing", async () => {
    await expect(
      publishAgentRelease({
        ...publish,
        listing: {
          categoryIds: ["category"],
          summary:
            "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234567890",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(tx.agentRelease.create).not.toHaveBeenCalled();
  });

  it("refuses a source already claimed by another publisher", async () => {
    tx.agentListing.findUnique.mockResolvedValue({
      id: "listing",
      publisherWorkspaceId: "foreign",
    });
    await expect(publishAgentRelease(publish)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    expect(tx.agentRelease.create).not.toHaveBeenCalled();
  });

  it("refuses a workspace slug already used by another listing", async () => {
    tx.agentListing.findFirst.mockResolvedValue({ id: "conflict" });
    await expect(publishAgentRelease(publish)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    expect(tx.agentRelease.create).not.toHaveBeenCalled();
  });

  it.each(["P2002", "P2034"])(
    "maps concurrent publication conflict %s to a public domain error",
    async (code) => {
      tx.agentListing.create.mockRejectedValue({ code });
      await expect(publishAgentRelease(publish)).rejects.toMatchObject({
        code: "listing_conflict",
      });
    },
  );

  it.each([new Error("storage unavailable"), { code: 2 }, null])(
    "does not misclassify unexpected publication failures %j",
    async (error) => {
      tx.agentListing.create.mockRejectedValue(error);
      await expect(publishAgentRelease(publish)).rejects.toBe(error);
    },
  );

  it("queues the normalized public release without immediately publishing its contents", async () => {
    await publishAgentRelease({
      ...publish,
      listing: {
        slug: "  New Research!  ",
        name: "  Name  ",
        summary: "  Description  ",
        tags: [" A ", "a", "", "B"],
        categoryIds: [" category ", "category"],
        iconUrl: "  https://images.test/icon.png  ",
      },
    });
    expect(tx.agentRelease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reviewStatus: "pending",
        name: "Name",
        summary: "Description",
        tags: ["a", "b"],
        categoryIds: ["category"],
        version: 1,
      }),
    });
    expect(tx.agentListing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: "new-research",
        directorySlug: "new-research",
        name: "Name",
        author: "Workspace",
      }),
    });
    expect(tx.agentListing.update).toHaveBeenLastCalledWith({
      where: { id: "listing" },
      data: { status: "draft", latestVersion: 1, pendingReleaseId: "release" },
    });
  });

  it("preserves the last published release while superseding an older pending submission", async () => {
    const listing = {
      id: "listing",
      publisherWorkspaceId: "workspace",
      directorySlug: "stable-name",
      status: "published",
      latestVersion: 4,
      latestReleaseId: "public-release",
      pendingReleaseId: "old-submission",
    };
    tx.agentListing.findUnique.mockResolvedValue(listing);
    tx.agentListing.update.mockResolvedValue(listing);
    await publishAgentRelease(publish);
    expect(tx.agentRelease.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old-submission", reviewStatus: "pending" },
        data: expect.objectContaining({ reviewStatus: "rejected" }),
      }),
    );
    expect(tx.agentRelease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 5 }),
    });
    expect(tx.agentListing.update).toHaveBeenLastCalledWith({
      where: { id: "listing" },
      data: {
        status: "published",
        latestVersion: 5,
        pendingReleaseId: "release",
      },
    });
  });

  it("allocates a unique directory slug rather than overwriting a globally existing listing", async () => {
    tx.agentListing.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "taken" })
      .mockResolvedValueOnce(null);
    await publishAgentRelease(publish);
    expect(tx.agentListing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ directorySlug: "researcher-1" }),
    });
  });

  it.each([
    null,
    { id: "listing", pendingReleaseId: null },
    { id: "listing", pendingReleaseId: "pending" },
  ])(
    "unpublishes safely with optional pending submission %j",
    async (listing) => {
      tx.agentListing.findFirst.mockResolvedValue(listing);
      const result = await unpublishAgentListing(transition);
      if (!listing) {
        expect(result).toBeNull();
        expect(tx.agentListing.update).not.toHaveBeenCalled();
      } else {
        expect(tx.agentListing.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { status: "disabled", pendingReleaseId: null },
          }),
        );
        expect(tx.agentRelease.updateMany).toHaveBeenCalledTimes(
          listing.pendingReleaseId ? 1 : 0,
        );
      }
    },
  );

  it.each(["", " ", "x".repeat(201)])(
    "rejects invalid install idempotency key before starting a transaction: %s",
    async (idempotencyKey) => {
      await expect(
        materializeAgentRelease({ ...install, idempotencyKey }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["P2002", "P2034"])(
    "bounds retries for serialization/uniqueness failure %s",
    async (code) => {
      mocks.transaction.mockRejectedValue({ code });
      await expect(materializeAgentRelease(install)).rejects.toMatchObject({
        code: "install_failed",
      });
      expect(mocks.transaction).toHaveBeenCalledTimes(3);
    },
  );

  it.each([new Error("connection lost"), { code: "P9999" }, null])(
    "does not retry unexpected storage failure %j",
    async (error) => {
      mocks.transaction.mockRejectedValue(error);
      await expect(materializeAgentRelease(install)).rejects.toMatchObject({
        code: "install_failed",
      });
      expect(mocks.transaction).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { runtime: { kind: "unsupported" } },
    { runtime: { kind: "pi", image: "private-image" } },
    { runtime: { kind: "pi" }, providerLinks: [{ format: "openai" }] },
  ])(
    "rejects unsupported runtime and provider configuration %j",
    async (override) => {
      const result = await assessAgentPortability({
        workspaceId: "workspace",
        agentId: "agent",
      });
      if (!result.portable) throw new Error("fixture must be portable");
      const raw = {
        ...result.manifest,
        agents: result.manifest.agents.map((agent) => ({
          ...agent,
          ...override,
        })),
      };
      expect(() => parseAgentReleaseManifest(raw)).toThrow(
        "manifest is invalid",
      );
    },
  );

  it.each(["server", "skill"] as const)(
    "rejects missing catalog %s selections instead of exporting an incomplete template",
    async (kind) => {
      tx.server.findMany.mockResolvedValue([]);
      tx.skill.findMany.mockResolvedValue([]);
      await expect(
        buildCatalogAgentManifest(tx as unknown as Prisma.TransactionClient, {
          name: "Agent",
          slug: "agent",
          systemPrompt: null,
          maxSteps: 8,
          serverIds: kind === "server" ? ["missing"] : [],
          skillIds: kind === "skill" ? ["missing"] : [],
        }),
      ).rejects.toThrow("no longer exist");
    },
  );

  it.each([null, {}, { source: "npm", ref: "server", env: [] }])(
    "rejects unverified or invalid catalog recipe %j",
    async (recipe) => {
      tx.server.findMany.mockResolvedValue([
        {
          id: "server",
          name: "Server",
          slug: "server",
          verifiedAt: recipe && "source" in recipe ? null : new Date(),
          installCfg: recipe,
        },
      ]);
      await expect(
        buildCatalogAgentManifest(tx as unknown as Prisma.TransactionClient, {
          name: "Agent",
          slug: "agent",
          systemPrompt: null,
          maxSteps: 8,
          serverIds: ["server"],
        }),
      ).rejects.toThrow("not verified");
    },
  );

  it("rejects oversized catalog graphs before loading their resources", async () => {
    await expect(
      buildCatalogAgentManifest(tx as unknown as Prisma.TransactionClient, {
        name: "Agent",
        slug: "agent",
        systemPrompt: null,
        maxSteps: 8,
        serverIds: Array.from({ length: 513 }, (_, index) => `server-${index}`),
      }),
    ).rejects.toThrow("too many");
    expect(tx.server.findMany).not.toHaveBeenCalled();
  });
});
