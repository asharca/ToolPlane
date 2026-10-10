// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { lookupProviderModelReferencesAction } from "@/lib/agents/model-reference-actions";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => auth);

let ownerId = "";
let memberId = "";
let workspaceId = "";
let foreignWorkspaceId = "";
let slug = "";
let providerId = "";
let foreignProviderId = "";

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = await db.user.create({
    data: {
      email: `model-reference-owner-${suffix}@test.dev`,
      passwordHash: "x",
    },
  });
  const member = await db.user.create({
    data: {
      email: `model-reference-member-${suffix}@test.dev`,
      passwordHash: "x",
    },
  });
  ownerId = owner.id;
  memberId = member.id;
  slug = `model-reference-${suffix}`;
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Model reference",
      ownerId,
      members: {
        create: [
          { userId: ownerId, role: "owner" },
          { userId: memberId, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const foreign = await db.workspace.create({
    data: {
      slug: `${slug}-foreign`,
      name: "Foreign reference",
      ownerId,
      members: { create: { userId: ownerId, role: "owner" } },
    },
  });
  foreignWorkspaceId = foreign.id;
  providerId = (
    await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Pi OpenAI reference",
        format: "pi:openai",
        baseUrl: "",
        apiKey: "fixture-not-a-real-key",
      },
    })
  ).id;
  foreignProviderId = (
    await db.modelProvider.create({
      data: {
        workspaceId: foreignWorkspaceId,
        name: "Foreign provider",
        format: "pi:openai",
        baseUrl: "",
        apiKey: "fixture-not-a-real-key",
      },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.deleteMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
  });
  await db.user.deleteMany({
    where: { id: { in: [ownerId, memberId].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("Pi model reference lookup", () => {
  it("matches exact IDs and display names case-insensitively within the selected Pi provider", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    const result = await lookupProviderModelReferencesAction(slug, providerId, [
      " GPT-5 ",
      "gpt-5",
    ]);
    expect(result.error).toBeUndefined();
    expect(
      result.matches.map(({ providerId, modelId }) => ({
        providerId,
        modelId,
      })),
    ).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    const byName = await lookupProviderModelReferencesAction(slug, providerId, [
      " GPT-5 Mini ",
    ]);
    expect(byName.matches.map((model) => model.modelId)).toEqual([
      "gpt-5-mini",
    ]);
    expect(JSON.stringify(result)).not.toContain("fixture-not-a-real-key");
    expect(result.matches[0]).not.toHaveProperty("baseUrl");
    expect(result.matches[0]).not.toHaveProperty("headers");
  });

  it("does not assign reference pricing to prefixes, unknown models, or another Pi provider’s models", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    for (const query of [
      "gpt-5-min",
      "unknown-reference-model",
      "claude-sonnet-4-5",
    ]) {
      expect(
        await lookupProviderModelReferencesAction(slug, providerId, [query]),
      ).toEqual({ matches: [] });
    }
  });

  it("uses native protocol references for proxies and prioritizes a configured provider host", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    await db.modelProvider.update({
      where: { id: providerId },
      data: { format: "openai", baseUrl: "https://unknown.test/v1" },
    });
    try {
      expect(
        (await lookupProviderModelReferencesAction(slug, providerId, ["gpt-5"]))
          .matches,
      ).toMatchObject([
        {
          providerId: "openai",
          modelId: "gpt-5",
          cost: { input: 1.25, output: 10 },
        },
      ]);
      await db.modelProvider.update({
        where: { id: providerId },
        data: { baseUrl: "https://api.openai.com/v1" },
      });
      const result = await lookupProviderModelReferencesAction(
        slug,
        providerId,
        ["gpt-5"],
      );
      expect(result.matches).toMatchObject([
        {
          providerId: "openai",
          modelId: "gpt-5",
          cost: { input: 1.25, output: 10 },
        },
      ]);
      await db.modelProvider.update({
        where: { id: providerId },
        data: { baseUrl: "https://opencode.ai/zen/v1" },
      });
      const reseller = await lookupProviderModelReferencesAction(
        slug,
        providerId,
        ["gpt-5"],
      );
      expect(reseller.matches).toMatchObject([
        {
          providerId: "opencode",
          modelId: "gpt-5",
          cost: { input: 1.07, output: 8.5 },
        },
      ]);
    } finally {
      await db.modelProvider.update({
        where: { id: providerId },
        data: { format: "pi:openai", baseUrl: "" },
      });
    }
  });

  it("prioritizes the current model ID and returns one source when the display label names another model", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect(
      (
        await lookupProviderModelReferencesAction(slug, providerId, [
          "gpt-5",
          "GPT-5 Mini",
        ])
      ).matches,
    ).toMatchObject([{ providerId: "openai", modelId: "gpt-5" }]);
  });

  it("rejects unauthenticated callers and non-owner workspace members", async () => {
    for (const user of [null, { id: memberId }]) {
      auth.getCurrentUser.mockResolvedValue(user);
      expect(
        await lookupProviderModelReferencesAction(slug, providerId, ["gpt-5"]),
      ).toEqual({ matches: [], error: "Not authorized." });
    }
  });

  it("rejects a foreign provider even when the caller owns both workspaces", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect(
      await lookupProviderModelReferencesAction(slug, foreignProviderId, [
        "gpt-5",
      ]),
    ).toEqual({ matches: [], error: "Provider not found." });
  });

  it("bounds lookup input and rejects malformed query values", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    for (const queries of [
      Array(52).fill("gpt-5"),
      ["x".repeat(201)],
      [null] as unknown as string[],
    ]) {
      expect(
        await lookupProviderModelReferencesAction(slug, providerId, queries),
      ).toEqual({ matches: [], error: "Invalid model query." });
    }
  });
});
