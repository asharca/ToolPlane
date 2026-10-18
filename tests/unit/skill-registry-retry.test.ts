// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const mocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/skills/bundle", () => ({
  fetchGithubSkillBundle: mocks.bundle,
}));
import {
  defaultTpSkillsSource,
  syncGithubSkillRegistry,
} from "@/lib/skills/registry";

const source = {
  owner: "acme",
  repo: "skills",
  ref: "main",
  rootPath: "skills",
};
const database = {
  skill: { findUnique: vi.fn().mockResolvedValue(null), upsert: mocks.upsert },
  auditEvent: { create: mocks.audit },
  category: {
    upsert: vi.fn().mockImplementation(async ({ where }) => ({
      id: `category-${where.slug}`,
    })),
  },
  $transaction: (run: (tx: unknown) => unknown) => run(database),
};

describe("registry retry selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/commits/")
            ? { sha: "abc" }
            : { skills: [{ path: "one" }, { path: "two" }] },
        ),
      ),
    );
    mocks.upsert.mockResolvedValue({ id: "skill-2" });
    mocks.bundle.mockResolvedValue({
      name: "Two",
      slugHint: "two",
      files: [],
      source: { normalized: "github:acme/skills/two" },
      content: "# Two",
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("updates only failed paths, preserves registry ordering and records the actor", async () => {
    const result = await syncGithubSkillRegistry(
      database as unknown as PrismaClient,
      source,
      { paths: ["skills/two"], actorId: "admin-1" },
    );
    expect(mocks.bundle).toHaveBeenCalledOnce();
    expect(mocks.bundle).toHaveBeenCalledWith(
      "https://github.com/acme/skills/tree/main/skills/two",
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ score: 6999 }),
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "admin-1",
          action: "catalog.skill.synced",
        }),
      }),
    );
    expect(result).toMatchObject({ found: 1, created: 1, failed: [] });
  });
  it("rejects retry paths absent from the registry before fetching bundles", async () => {
    await expect(
      syncGithubSkillRegistry(database as unknown as PrismaClient, source, {
        paths: ["../../private"],
      }),
    ).rejects.toThrow("Retry paths");
    expect(mocks.bundle).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("returns per-file reasons with credentials removed", async () => {
    mocks.bundle.mockRejectedValue(
      new Error("Authorization: Bearer sensitive-value"),
    );
    const result = await syncGithubSkillRegistry(
      database as unknown as PrismaClient,
      source,
      { paths: ["skills/two"] },
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe("skills/two");
    expect(result.failed[0].error).not.toContain("sensitive-value");
  });
  it("reads environment defaults and falls back when they are empty", () => {
    for (const [name, value] of Object.entries({
      TP_SKILLS_OWNER: "owner",
      TP_SKILLS_REPO: "repo",
      TP_SKILLS_REF: "tag",
      TP_SKILLS_ROOT: "catalog",
      TP_SKILLS_SLUG_PREFIX: "prefix-",
    }))
      vi.stubEnv(name, value);
    expect(defaultTpSkillsSource()).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "tag",
      rootPath: "catalog",
      slugPrefix: "prefix-",
    });
    for (const name of [
      "TP_SKILLS_OWNER",
      "TP_SKILLS_REPO",
      "TP_SKILLS_REF",
      "TP_SKILLS_ROOT",
      "TP_SKILLS_SLUG_PREFIX",
    ])
      vi.stubEnv(name, "");
    expect(defaultTpSkillsSource()).toEqual({
      owner: "asharca",
      repo: "tp-skills",
      ref: "main",
      rootPath: "skills",
      slugPrefix: "",
    });
  });

  it("normalizes catalog entries, deduplicates categories and updates existing skills", async () => {
    database.skill.findUnique.mockResolvedValueOnce({ id: "existing" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/commits/")
            ? { sha: "commit" }
            : {
                root: " /catalog/ ",
                skills: [
                  { path: 5 },
                  { path: " / " },
                  {
                    path: "/one/",
                    slug: " Custom Name ",
                    categories: ["Dev Tools", "dev-tools"],
                    curated: false,
                    score: "8.8",
                  },
                  {
                    path: "catalog/two",
                    slug: " ",
                    categories: "invalid",
                    score: "invalid",
                  },
                  { path: "catalog", score: 3 },
                ],
              },
        ),
      ),
    );
    const result = await syncGithubSkillRegistry(
      database as unknown as PrismaClient,
      { owner: "/acme/", repo: " /skills/ ", slugPrefix: "test-" },
    );
    expect(result).toMatchObject({
      registry: "github:acme/skills",
      found: 3,
      updated: 1,
      created: 2,
      failed: [],
    });
    expect(database.category.upsert).toHaveBeenCalledTimes(1);
    expect(database.category.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { slug: "dev-tools", name: "Dev Tools" },
      }),
    );
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
      where: { slug: "test-custom-name" },
      update: {
        score: 8,
        curated: false,
        sourcePath: "catalog/one",
        categories: { set: [{ id: "category-dev-tools" }] },
      },
    });
    expect(mocks.upsert.mock.calls[1][0]).toMatchObject({
      create: { slug: "test-two", score: 6999, curated: true },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorId: "system" }),
      }),
    );
  });

  it("discovers and sorts directory entries when no registry file exists", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/commits/")) return new Response("", { status: 404 });
      if (url.endsWith("registry.json"))
        return new Response("", { status: 404 });
      return Response.json([
        { name: "z", path: "skills/z", type: "dir" },
        { name: "ignore", path: "skills/file", type: "file" },
        { name: "a", path: "skills/a", type: "dir" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    const result = await syncGithubSkillRegistry(
      database as unknown as PrismaClient,
      {
        owner: "",
        repo: "",
        ref: " /feature/tag/ ",
        rootPath: " /skill folder/ ",
      },
    );
    expect(result).toMatchObject({
      registry: "github:asharca/tp-skills",
      commitSha: null,
      found: 2,
    });
    expect(mocks.bundle.mock.calls.map((call) => call[0])).toEqual([
      "https://github.com/asharca/tp-skills/tree/feature/tag/skills/a",
      "https://github.com/asharca/tp-skills/tree/feature/tag/skills/z",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/asharca/tp-skills/contents/skill%20folder?ref=feature%2Ftag",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer github-secret",
        }),
      }),
    );
  });

  it.each([{}, { skills: "invalid" }])(
    "treats a malformed or empty registry as empty without directory discovery",
    async (registry) => {
      const fetchMock = vi.fn(async (url: string) =>
        Response.json(url.includes("/commits/") ? {} : registry),
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await syncGithubSkillRegistry(
          database as unknown as PrismaClient,
          source,
        ),
      ).toMatchObject({ found: 0, commitSha: null });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mocks.bundle).not.toHaveBeenCalled();
    },
  );

  it.each([
    { paths: [] },
    { paths: Array.from({ length: 1001 }, (_, i) => `skills/${i}`) },
  ])(
    "rejects an invalid retry selection before fetching bundles",
    async ({ paths }) => {
      await expect(
        syncGithubSkillRegistry(database as unknown as PrismaClient, source, {
          paths,
        }),
      ).rejects.toThrow("Retry paths");
      expect(mocks.bundle).not.toHaveBeenCalled();
    },
  );

  it("reports non-directory roots and failed raw catalog responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("registry.json")
          ? new Response("missing", { status: 404 })
          : Response.json({ sha: "commit" }),
      ),
    );
    await expect(
      syncGithubSkillRegistry(database as unknown as PrismaClient, source),
    ).rejects.toThrow("Registry root is not a directory");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    await expect(
      syncGithubSkillRegistry(database as unknown as PrismaClient, source),
    ).rejects.toThrow("GitHub raw request failed (403): denied");
  });

  it("isolates non-Error bundle failures and continues importing other entries", async () => {
    mocks.bundle.mockRejectedValueOnce("bad bundle");
    const result = await syncGithubSkillRegistry(
      database as unknown as PrismaClient,
      source,
    );
    expect(result).toMatchObject({
      found: 2,
      created: 1,
      failed: [{ path: "skills/one", error: "Unknown error" }],
    });
  });
});
