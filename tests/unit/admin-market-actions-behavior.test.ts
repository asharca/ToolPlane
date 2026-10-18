// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  createServer: vi.fn(),
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  setRecipe: vi.fn(),
  verify: vi.fn(),
  server: vi.fn(),
  skill: vi.fn(),
  fetchBundle: vi.fn(),
  metadata: vi.fn(),
  validate: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("@/lib/db", () => ({
  db: {
    server: { findUnique: mocks.server },
    skill: { findUnique: mocks.skill },
  },
}));
vi.mock("@/lib/admin/market", () => ({
  createDirectoryServer: mocks.createServer,
  updateDirectoryServer: mocks.updateServer,
  deleteDirectoryServer: mocks.deleteServer,
  createDirectorySkill: mocks.createSkill,
  updateDirectorySkill: mocks.updateSkill,
  deleteDirectorySkill: mocks.deleteSkill,
  setServerRecipe: mocks.setRecipe,
  setServerVerified: mocks.verify,
}));
vi.mock("@/lib/admin/recipe-validate", () => ({
  validateServerRecipe: mocks.validate,
}));
vi.mock("@/lib/admin/server-source", () => ({
  fetchServerSourceMetadata: mocks.metadata,
}));
vi.mock("@/lib/skills/bundle", () => ({
  fetchGithubSkillBundle: mocks.fetchBundle,
}));
vi.mock("@/lib/skills/registry", () => ({ syncGithubSkillRegistry: vi.fn() }));
vi.mock("@/lib/observability/events", () => ({ recordEvent: vi.fn() }));
import * as actions from "@/lib/admin/market-actions";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    id: "resource",
    slug: "resource-slug",
    name: " Resource ",
    ...values,
  }))
    data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin" });
});

describe("admin directory writes", () => {
  it.each([
    [
      actions.createServerAction,
      mocks.createServer,
      "errorServerExists",
      "/admin/servers",
    ],
    [
      actions.createSkillAction,
      mocks.createSkill,
      "errorSkillExists",
      "/admin/skills",
    ],
  ] as const)(
    "normalizes new directory entries and exposes conflicts",
    async (action, mutation, error, path) => {
      expect(await action({}, form({ slug: "invalid_slug" }))).toEqual({
        error: "errorNameSlugRequired",
      });
      expect(mutation).not.toHaveBeenCalled();
      const data = form({
        slug: " RESOURCE-SLUG ",
        stars: "12.9",
        score: "9.7",
        isOfficial: "on",
        isFeatured: "on",
        author: "  Author  ",
      });
      data.append("categoryIds", "category");
      mutation.mockRejectedValueOnce(new Error("duplicate"));
      expect(await action({}, data)).toEqual({ error });
      expect(mocks.revalidate).not.toHaveBeenCalled();
      await action({}, data);
      expect(mutation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          slug: "resource-slug",
          name: "Resource",
          author: "Author",
          description: null,
          iconUrl: null,
          categoryIds: ["category"],
        }),
        "admin",
      );
      expect(mocks.redirect).toHaveBeenCalledWith(path);
    },
  );
  it.each([
    [actions.updateServerAction, mocks.updateServer, "/admin/servers"],
    [actions.updateSkillAction, mocks.updateSkill, "/admin/skills"],
  ] as const)(
    "rejects empty names and handles update errors without stale redirects",
    async (action, mutation, path) => {
      expect(await action({}, form({ name: " " }))).toEqual({
        error: "errorNameRequired",
      });
      mutation.mockRejectedValueOnce(new Error("failed"));
      expect(await action({}, form())).toEqual({ error: "errorActionFailed" });
      expect(
        await action({}, form({ score: "not a number", stars: "Infinity" })),
      ).toEqual({});
      expect(mutation).toHaveBeenLastCalledWith(
        "resource",
        expect.objectContaining({ name: "Resource" }),
        "admin",
      );
      expect(mocks.revalidate).toHaveBeenCalledWith(`${path}/resource/edit`);
      expect(mocks.redirect).not.toHaveBeenCalled();
    },
  );
  it("bounds readme content and records valid canonical provenance", async () => {
    await actions.createServerAction(
      {},
      form({
        readme: "x".repeat(500100),
        stars: "bad",
        sourceMetadataSource: "npm",
        sourceMetadataRef: "@team/pkg",
        sourceMetadataCanonicalUrl: "https://www.npmjs.com/package/@team/pkg",
      }),
    );
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        readme: "x".repeat(500000),
        stars: 0,
        sourceMetadata: {
          source: "npm",
          ref: "@team/pkg",
          sourceUrl: "https://www.npmjs.com/package/@team/pkg",
        },
      }),
      "admin",
    );
  });
  it.each([
    {
      sourceMetadataSource: "unsupported",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl: "https://www.npmjs.com/package/pkg",
    },
    {
      sourceMetadataSource: "npm",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl: "http://www.npmjs.com/package/pkg",
    },
    {
      sourceMetadataSource: "npm",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl:
        "https://www.npmjs.com/package/pkg?token=secret",
    },
    {
      sourceMetadataSource: "npm",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl: "https://www.npmjs.com/package/pkg#fragment",
    },
    {
      sourceMetadataSource: "npm",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl: "https://evil.example/package/pkg",
    },
    {
      sourceMetadataSource: "npm",
      sourceMetadataRef: "pkg",
      sourceMetadataCanonicalUrl: "https://user:pass@www.npmjs.com/package/pkg",
    },
  ])("rejects untrusted source metadata before persistence", async (values) => {
    expect(await actions.createServerAction({}, form(values))).toEqual({
      error: "errorServerExists",
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
  it.each([
    [
      actions.deleteServerAction,
      mocks.deleteServer,
      "Refused: 3 live deployments exist",
      'errorServerReferenced:{"count":3}',
      "/admin/servers",
    ],
    [
      actions.deleteSkillAction,
      mocks.deleteSkill,
      "2 workspace installs exist",
      'errorSkillInstalled:{"count":2}',
      "/admin/skills",
    ],
  ] as const)(
    "reports referencing resources and only redirects on deletion",
    async (action, mutation, message, key, path) => {
      mutation.mockRejectedValueOnce(new Error(message));
      expect(await action({}, form())).toEqual({ error: key });
      mutation.mockRejectedValueOnce("unexpected");
      expect(await action({}, form())).toEqual({ error: "errorActionFailed" });
      expect(mocks.redirect).not.toHaveBeenCalled();
      await action({}, form());
      expect(mocks.redirect).toHaveBeenCalledWith(path);
    },
  );
  it("requires admin privileges even for invalid submissions", async () => {
    mocks.auth.mockRejectedValue(new Error("Forbidden"));
    await expect(
      actions.createServerAction({}, new FormData()),
    ).rejects.toThrow("Forbidden");
    await expect(actions.createSkillAction({}, new FormData())).rejects.toThrow(
      "Forbidden",
    );
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });
});

describe("directory skill import", () => {
  const bundle = {
    name: "Skill",
    description: "Description",
    author: "Author",
    slugHint: " My Skill ",
    source: { owner: "team", repo: "repo", normalized: "team/repo" },
    content: "# Skill",
    files: [],
  };
  it("requires a source and exposes fetch errors without writing", async () => {
    expect(await actions.importSkillFromGithubAction({}, form())).toEqual({
      error: "errorGithubSourceRequired",
    });
    mocks.fetchBundle.mockRejectedValueOnce(new Error("Not found"));
    expect(
      await actions.importSkillFromGithubAction(
        {},
        form({ githubSource: "team/repo" }),
      ),
    ).toEqual({ error: 'errorGithubFetch:{"message":"Not found"}' });
    mocks.fetchBundle.mockRejectedValueOnce("unknown");
    expect(
      await actions.importSkillFromGithubAction(
        {},
        form({ githubSource: "team/repo" }),
      ),
    ).toEqual({ error: 'errorGithubFetch:{"message":"errorActionFailed"}' });
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });
  it("deduplicates imported source identity", async () => {
    mocks.fetchBundle.mockResolvedValue(bundle);
    mocks.skill.mockResolvedValue({ githubSource: "team/repo" });
    expect(
      await actions.importSkillFromGithubAction(
        {},
        form({ githubSource: "team/repo" }),
      ),
    ).toEqual({ error: 'errorAlreadyImported:{"slug":"my-skill"}' });
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });
  it("falls back to repository slug and preserves bundled files", async () => {
    mocks.fetchBundle.mockResolvedValue({
      ...bundle,
      slugHint: "!",
      files: [{ path: "guide.txt", content: "guide" }],
    });
    await actions.importSkillFromGithubAction(
      {},
      form({ githubSource: "team/repo" }),
    );
    expect(mocks.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "team-repo",
        content: "# Skill",
        files: [{ path: "guide.txt", content: "guide" }],
        githubSource: "team/repo",
        score: 0,
      }),
      "admin",
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/skills");
  });
  it("resolves unrelated slug collisions and reports database failures", async () => {
    mocks.fetchBundle.mockResolvedValue(bundle);
    mocks.skill.mockResolvedValue({ githubSource: "another/repo" });
    mocks.createSkill.mockRejectedValueOnce(new Error("database"));
    expect(
      await actions.importSkillFromGithubAction(
        {},
        form({ githubSource: "team/repo" }),
      ),
    ).toEqual({ error: "errorSkillCreate" });
    expect(mocks.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: expect.stringMatching(/^my-skill-[a-z0-9]+$/),
      }),
      "admin",
    );
  });
});

describe("saved connector recipe validation", () => {
  const recipe = { source: "npm", ref: "@team/pkg", env: [] };
  it("requires a saved valid recipe", async () => {
    expect(await actions.validateServerRecipeAction({}, form())).toEqual({
      error: "errorSaveRecipeFirst",
    });
    mocks.server.mockResolvedValue({ installCfg: { invalid: true } });
    expect(await actions.validateServerRecipeAction({}, form())).toEqual({
      error: "errorSaveRecipeFirst",
    });
    expect(mocks.validate).not.toHaveBeenCalled();
  });
  it("passes only valid test environment pairs and reports probing failure", async () => {
    mocks.server.mockResolvedValue({
      installCfg: recipe,
      updatedAt: new Date(0),
    });
    mocks.validate.mockResolvedValue({
      ok: false,
      error: "missing credential",
    });
    expect(
      await actions.validateServerRecipeAction(
        {},
        form({
          testEnv: " TOKEN=value=part\ninvalid line\n2BAD=no\n OTHER=ok ",
        }),
      ),
    ).toEqual({
      error: 'errorValidationFailed:{"message":"missing credential"}',
    });
    expect(mocks.validate).toHaveBeenCalledWith(
      expect.objectContaining(recipe),
      { TOKEN: "value=part", OTHER: "ok" },
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("commits verified tool snapshots against the recipe revision", async () => {
    const updatedAt = new Date(0);
    const toolCatalog = [{ name: "search", inputSchema: { type: "object" } }];
    mocks.server.mockResolvedValue({ installCfg: recipe, updatedAt });
    mocks.validate.mockResolvedValue({
      ok: true,
      toolCount: 1,
      tools: ["search"],
      toolCatalog,
    });
    expect(await actions.validateServerRecipeAction({}, form())).toEqual({
      ok: true,
      toolCount: 1,
      tools: ["search"],
    });
    expect(mocks.verify).toHaveBeenCalledWith(
      "resource",
      1,
      toolCatalog,
      updatedAt,
      "admin",
    );
    mocks.verify.mockRejectedValueOnce(new Error("changed since validation"));
    expect(await actions.validateServerRecipeAction({}, form())).toEqual({
      error: "errorSaveRecipeFirst",
    });
  });
  it("saves and removes recipes while preserving action failure boundaries", async () => {
    expect(
      await actions.setServerRecipeAction(
        {},
        form({ recipeSource: "invalid" }),
      ),
    ).toEqual({ error: "errorInvalidRecipe" });
    const data = form({
      recipeSource: "npm",
      recipeRef: "@team/pkg",
      recipeEnv: " TOKEN, OTHER\nTOKEN ",
      recipeEnvValues: "TOKEN=test",
      recipeNetwork: "on",
    });
    expect(await actions.setServerRecipeAction({}, data)).toEqual({ ok: true });
    expect(mocks.setRecipe).toHaveBeenCalledWith(
      "resource",
      expect.objectContaining({
        source: "npm",
        ref: "@team/pkg",
        env: ["TOKEN", "OTHER"],
        network: "none",
      }),
      "admin",
    );
    mocks.setRecipe.mockRejectedValueOnce(new Error("failed"));
    expect(await actions.setServerRecipeAction({}, data)).toEqual({
      error: "errorActionFailed",
    });
    mocks.setRecipe.mockRejectedValueOnce(new Error("failed"));
    expect(await actions.removeServerRecipeAction({}, form())).toEqual({
      error: "errorActionFailed",
    });
    expect(await actions.removeServerRecipeAction({}, form())).toEqual({
      ok: true,
    });
    expect(mocks.setRecipe).toHaveBeenLastCalledWith("resource", null, "admin");
  });
  it("returns source lookup errors without leaking thrown values", async () => {
    mocks.metadata.mockRejectedValueOnce(new Error("upstream failed"));
    expect(
      await actions.fetchServerSourceMetadataAction(
        {},
        form({ sourceMetadataSource: "npm", sourceMetadataRef: "pkg" }),
      ),
    ).toEqual({
      error: 'errorSourceMetadataFetch:{"message":"upstream failed"}',
    });
    mocks.metadata.mockRejectedValueOnce(null);
    expect(await actions.fetchServerSourceMetadataAction({}, form())).toEqual({
      error: 'errorSourceMetadataFetch:{"message":"errorActionFailed"}',
    });
  });
});
