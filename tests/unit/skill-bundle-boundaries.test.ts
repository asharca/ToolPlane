// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGithubSkillBundle,
  fetchGithubSkillBundles,
  normalizeSkillFiles,
  parseUploadedSkillBundles,
  safeSkillFilePath,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_IMPORT_FILES,
  MAX_SKILL_IMPORT_BYTES,
} from "@/lib/skills/bundle";
const fetchMock = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fetchMock.mockReset();
});
const skill = { type: "blob", path: "SKILL.md", size: 5 };

describe("skill bundle transport and import limits", () => {
  it.each([
    { status: 403, remaining: "0", message: "API rate limit exceeded" },
    { status: 403, remaining: "1", message: "GitHub request failed (403)." },
    { status: 500, remaining: "0", message: "GitHub request failed (500)." },
  ])(
    "reports GitHub failure without importing partial content",
    async ({ status, remaining, message }) => {
      vi.stubGlobal(
        "fetch",
        fetchMock.mockResolvedValue(
          new Response("private", {
            status,
            headers: { "x-ratelimit-remaining": remaining },
          }),
        ),
      );
      await expect(fetchGithubSkillBundles("acme/repo")).rejects.toThrow(
        message,
      );
    },
  );
  it("retries transport failures with bounded backoff and propagates the final error", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    vi.stubGlobal("fetch", fetchMock.mockRejectedValue(error));
    const assertion = expect(fetchGithubSkillBundles("acme/repo")).rejects.toBe(
      error,
    );
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("recovers from a transient transport error and authenticates file requests", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("TOOLPLANE_GITHUB_TOKEN", "secret");
    vi.stubGlobal(
      "fetch",
      fetchMock
        .mockRejectedValueOnce(new Error("transient"))
        .mockImplementation(async (url: string) =>
          url.includes("api.github.com")
            ? Response.json({ tree: [skill] })
            : new Response("# Skill"),
        ),
    );
    const pending = fetchGithubSkillBundles("acme/repo");
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toMatchObject([
      { name: "Uploaded skill", author: "acme" },
    ]);
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.authorization).toBe(
      "Bearer secret",
    );
  });
  it.each([{}, { tree: "bad" }, { tree: [], truncated: true }, { tree: [] }])(
    "rejects invalid, truncated or skill-less trees %j",
    async (tree) => {
      vi.stubGlobal("fetch", fetchMock.mockResolvedValue(Response.json(tree)));
      await expect(fetchGithubSkillBundles("acme/repo")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it("handles direct SKILL.md sources and binary assets in nested skills", async () => {
    vi.stubGlobal(
      "fetch",
      fetchMock.mockImplementation(async (url: string) =>
        url.includes("api.github.com")
          ? Response.json({
              tree: [
                { type: "tree", path: "directory" },
                { type: "blob", path: "outside" },
                { type: "blob", path: "folder/SKILL.md" },
              ],
            })
          : new Response("# Skill"),
      ),
    );
    expect(
      await fetchGithubSkillBundle(
        "https://github.com/acme/repo/blob/main/folder/SKILL.md",
      ),
    ).toMatchObject({
      content: "# Skill",
      source: { path: "folder/SKILL.md" },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.github.com"))
        return Response.json({
          tree: [
            { type: "blob", path: "folder/first/SKILL.md" },
            { type: "blob", path: "folder/first/icon.bin" },
            { type: "blob", path: "folder/second/SKILL.md" },
            { type: "blob", path: "folder/.git/ignored" },
            { type: "blob", path: "outside/SKILL.md" },
          ],
        });
      return url.endsWith(".bin")
        ? new Response(new Uint8Array([0, 255]), {
            headers: { "content-type": "application/octet-stream" },
          })
        : new Response("# Instructions");
    });
    const bundles = await fetchGithubSkillBundles("acme/repo/folder");
    expect(bundles).toMatchObject([
      {
        source: { normalized: "acme/repo/folder/first" },
        files: [{ path: "icon.bin", encoding: "base64", content: "AP8=" }],
      },
      { source: { normalized: "acme/repo/folder/second" } },
    ]);
    await expect(
      fetchGithubSkillBundle("https://github.com/acme/repo/tree/main/folder"),
    ).rejects.toThrow("Multiple skills found");
  });
  it("reports failed individual downloads rather than constructing empty skills", async () => {
    vi.stubGlobal(
      "fetch",
      fetchMock
        .mockResolvedValueOnce(Response.json({ tree: [skill] }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );
    await expect(fetchGithubSkillBundles("acme/repo")).rejects.toThrow(
      "GitHub file download failed (404)",
    );
  });
  it.each(["skills", "files", "file-size", "total-size"])(
    "rejects excessive declared import %s before downloading",
    async (limit) => {
      const tree =
        limit === "skills"
          ? [
              { ...skill, path: "one/SKILL.md" },
              { ...skill, path: "two/SKILL.md" },
            ]
          : limit === "files"
            ? [
                skill,
                ...Array.from({ length: MAX_SKILL_IMPORT_FILES }, (_, i) => ({
                  type: "blob",
                  path: `file-${i}`,
                })),
              ]
            : limit === "file-size"
              ? [{ ...skill, size: MAX_SKILL_FILE_BYTES + 1 }]
              : [
                  skill,
                  ...Array.from(
                    {
                      length: Math.ceil(
                        MAX_SKILL_IMPORT_BYTES / MAX_SKILL_FILE_BYTES,
                      ),
                    },
                    (_, i) => ({
                      type: "blob",
                      path: `file-${i}`,
                      size: MAX_SKILL_FILE_BYTES,
                    }),
                  ),
                ];
      vi.stubGlobal(
        "fetch",
        fetchMock.mockResolvedValue(Response.json({ tree })),
      );
      await expect(
        fetchGithubSkillBundles("acme/repo", limit === "skills" ? 1 : 100),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});

describe("portable uploaded skill boundaries", () => {
  it.each([
    "",
    "/absolute",
    "x\0y",
    "a//b",
    "a/./b",
    "a/../b",
    "._meta",
    "__MACOSX/file",
    "a?b",
    "control\u0001",
    "trailing.",
    "trailing /child",
    "CON.txt",
    "lpt9",
    ".git/config",
    "node_modules/x",
    "a".repeat(241),
  ])("rejects unsafe portable paths %j", (path) => {
    expect(safeSkillFilePath(path)).toBeNull();
  });
  it("normalizes Windows separators and skips invalid or duplicate assets without altering binary data", () => {
    expect(safeSkillFilePath("./folder\\file.txt")).toBe("folder/file.txt");
    expect(
      normalizeSkillFiles([
        null,
        {},
        { path: 3, content: "bad" },
        { path: "file", content: 3 },
        { path: "SKILL.md", content: "skip" },
        { path: "a.txt", content: "a\0b" },
        { path: "A.txt", content: "duplicate" },
        { path: "é.txt", content: "first" },
        { path: "e\u0301.txt", content: "duplicate" },
        { path: "image", content: "AP8=", encoding: "base64" },
      ] as never),
    ).toEqual([
      { path: "a.txt", content: "ab" },
      { path: "é.txt", content: "first" },
      { path: "image", content: "AP8=", encoding: "base64" },
    ]);
  });
  it("enforces normalized asset file count and byte size", () => {
    expect(() =>
      normalizeSkillFiles([
        { path: "big", content: "a".repeat(MAX_SKILL_FILE_BYTES + 1) },
      ]),
    ).toThrow("File too large");
    expect(() =>
      normalizeSkillFiles(
        Array.from({ length: MAX_SKILL_FILES }, (_, i) => ({
          path: `file-${i}`,
          content: "x",
        })),
      ),
    ).toThrow("too many files");
  });
  it("rejects empty, malformed, binary or oversized skill documents", () => {
    for (const files of [
      [],
      [null, {}, { path: "../SKILL.md", content: "x" }],
      [{ path: "other", content: "x" }],
      [{ path: "SKILL.md", content: "eA==", encoding: "base64" }],
      [{ path: "SKILL.md", content: "a".repeat(MAX_SKILL_FILE_BYTES + 1) }],
    ])
      expect(() => parseUploadedSkillBundles(files as never)).toThrow();
  });
  it("assigns nested assets to the nearest skill, excludes outside files and applies fallback metadata", () => {
    const bundles = parseUploadedSkillBundles([
      { path: "outside", content: "ignore" },
      { path: "root/SKILL.md", content: "# Parent" },
      { path: "root/asset.txt", content: "parent" },
      {
        path: "root/child/SKILL.md",
        content:
          "---\nname: Child\nauthor: Author\ndescription: Description\n---\n# Child",
      },
      { path: "root/child/asset.txt", content: "child" },
    ]);
    expect(bundles).toMatchObject([
      {
        name: "root",
        rootPath: "root",
        files: [{ path: "asset.txt", content: "parent" }],
      },
      {
        name: "Child",
        author: "Author",
        description: "Description",
        files: [{ path: "asset.txt", content: "child" }],
      },
    ]);
    expect(
      parseUploadedSkillBundles(
        [{ path: "SKILL.md", content: "# Skill" }],
        "  Fallback  ",
      )[0].name,
    ).toBe("Fallback");
  });
});
