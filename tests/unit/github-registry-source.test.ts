// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GithubRegistryTransport,
  parseGithubRegistryIndex,
} from "@/lib/plugins/github";

const commit = "a".repeat(40);
const resource = {
  id: "review",
  path: "skills/review",
};
const data = Buffer.from("# Review");
const sha = createHash("sha1")
  .update(`blob ${data.length}\0`)
  .update(data)
  .digest("hex");
const file = {
  type: "blob",
  mode: "100644",
  path: "skills/review/SKILL.md",
  size: data.length,
  sha,
};
afterEach(() => vi.unstubAllGlobals());

describe("GitHub registry source boundaries", () => {
  it("accepts v3 plugin directories and rejects retired v2 explicitly", () => {
    expect(
      parseGithubRegistryIndex({ schemaVersion: 3, plugins: [resource] }),
    ).toEqual({ schemaVersion: 3, plugins: [resource] });
    expect(() =>
      parseGithubRegistryIndex({ schemaVersion: 2, packages: [resource] }),
    ).toThrow("registry_index_v2_unsupported");
  });
  it.each([
    { schemaVersion: 3, plugins: [resource, resource] },
    {
      schemaVersion: 3,
      plugins: [resource, { id: "other", path: resource.path }],
    },
    ...["../escape", "./review", "skills\\review", "skills//review"].map(
      (path) => ({ schemaVersion: 3, plugins: [{ ...resource, path }] }),
    ),
    ...["Bad-id", "with.dot", "with_underscore", "-start", "a".repeat(65)].map(
      (id) => ({ schemaVersion: 3, plugins: [{ ...resource, id }] }),
    ),
    { schemaVersion: 3, plugins: [{ ...resource, version: "1.0.0" }] },
    { schemaVersion: 3, plugins: [resource], unrecognized: true },
    { schemaVersion: 1, resources: [] },
  ])("rejects ambiguous or escaping plugin identities and paths", (raw) => {
    expect(() => parseGithubRegistryIndex(raw)).toThrow();
  });
  it("uses a slugified package name when the repository has no index", async () => {
    const packageData = Buffer.from(
      JSON.stringify({ name: "@acme/review-tools", version: "1.0.0" }),
    );
    const packageFile = {
      ...file,
      path: "package.json",
      size: packageData.length,
      sha: createHash("sha1")
        .update(`blob ${packageData.length}\0`)
        .update(packageData)
        .digest("hex"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/trees/")
          ? Response.json({ truncated: false, tree: [packageFile] })
          : url.includes("api.github.com")
            ? Response.json({ private: false })
            : new Response(packageData),
      ),
    );
    const transport = new GithubRegistryTransport(
      "acme/source",
      undefined,
      "public",
    );
    await expect(transport.index("acme/source", commit)).resolves.toEqual({
      schemaVersion: 3,
      plugins: [{ id: "acme-review-tools", path: "" }],
    });
    await expect(
      transport.directory("acme/source", commit, ""),
    ).resolves.toEqual([
      { path: "package.json", data: packageData, executable: false },
    ]);
  });
  it("downloads bytes only from the resolved SHA and verifies their Git blob identity without exposing credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === "api.github.com") {
          if (url.pathname.startsWith("/repos/acme/source")) {
            return new Response(null, {
              status: 301,
              headers: {
                location: `https://api.github.com/repositories/123${url.pathname.slice("/repos/acme/source".length)}${url.search}`,
              },
            });
          }
          if (url.pathname.includes("/git/trees/")) {
            expect(url.pathname.endsWith(commit)).toBe(true);
            return Response.json({ truncated: false, tree: [file] });
          }
          return url.pathname === "/repositories/123"
            ? Response.json({ private: false })
            : Response.json({ message: "Not Found" }, { status: 404 });
        }
        expect(url.hostname).toBe("raw.githubusercontent.com");
        expect(url.pathname).toBe(
          `/acme/source/${commit}/skills/review/SKILL.md`,
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(data);
      }),
    );
    const files = await new GithubRegistryTransport(
      "acme/source",
      "github_pat_private_credential",
      "public",
    ).directory("acme/source", commit, "skills/review");
    expect(files).toEqual([{ path: "SKILL.md", data, executable: false }]);
  });
  it.each([
    "https://evil.test/repositories/123",
    "http://api.github.com/repositories/123",
    "https://credential@api.github.com/repositories/123",
    "https://api.github.com/repos/other/source",
    "https://api.github.com/repositories/123/git/trees/main",
    "https://api.github.com/repositories/123?access=other",
  ])(
    "does not send a scoped token to an unsafe rename target %s",
    async (location) => {
      const fetch = vi.fn(
        async () => new Response(null, { status: 301, headers: { location } }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        new GithubRegistryTransport(
          "acme/source",
          "private-token",
          "private",
        ).resolveCommit("acme/source", "main"),
      ).rejects.toMatchObject({ code: "github_request_failed" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("resolves a branch when commit details exceed general response limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ sha: commit, patch: "x".repeat(17 * 1024 * 1024) }),
      ),
    );
    await expect(
      new GithubRegistryTransport(
        "acme/source",
        "private-token",
        "private",
      ).resolveCommit("acme/source", "main"),
    ).resolves.toBe(commit);
  });

  it("keeps branch resolution pinned across a permanent repository rename", async () => {
    const branch = "release/next";
    const suffix = `/commits/${encodeURIComponent(branch)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer private-token",
        );
        if (url.pathname === `/repos/acme/source${suffix}`) {
          return new Response(null, {
            status: 308,
            headers: {
              location: `https://api.github.com/repositories/123${suffix}`,
            },
          });
        }
        if (
          url.origin !== "https://api.github.com" ||
          url.pathname !== `/repositories/123${suffix}`
        )
          throw new Error("Unexpected destination");
        return Response.json({ sha: commit });
      }),
    );
    await expect(
      new GithubRegistryTransport(
        "acme/source",
        "private-token",
        "private",
      ).resolveCommit("acme/source", branch),
    ).resolves.toBe(commit);
  });
  it.each([
    { truncated: true, tree: [file] },
    { truncated: false, tree: [{ ...file, mode: "120000" }] },
    { truncated: false, tree: [{ ...file, type: "commit", mode: "160000" }] },
    { truncated: false, tree: [{ ...file, path: "skills/review/../escape" }] },
    {
      truncated: false,
      tree: [file, { ...file, path: "skills/review/skill.md" }],
    },
    { truncated: false, tree: [{ ...file, size: 5 * 1024 * 1024 }] },
  ])("fails closed for incomplete, aliased or unsafe trees", async (tree) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/trees/")
          ? Response.json(tree)
          : Response.json({ private: false }),
      ),
    );
    await expect(
      new GithubRegistryTransport("acme/source", undefined, "public").directory(
        "acme/source",
        commit,
        "skills/review",
      ),
    ).rejects.toThrow();
  });
  it("rejects bytes inconsistent with the pinned tree even when the transport succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/trees/")
          ? Response.json({ truncated: false, tree: [file] })
          : url.includes("api.github.com")
            ? Response.json({ private: false })
            : new Response("altered"),
      ),
    );
    await expect(
      new GithubRegistryTransport("acme/source", undefined, "public").directory(
        "acme/source",
        commit,
        "skills/review",
      ),
    ).rejects.toMatchObject({ code: "github_blob_invalid" });
  });
  it("never forwards a registry's scoped token to a different indexed repository", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(new URL(input).hostname).toBe("api.github.com");
        return new Response(null, { status: 404 });
      }),
    );
    await expect(
      new GithubRegistryTransport(
        "acme/root",
        "github_pat_private_credential",
        "private",
      ).directory("other/private", commit, "skills/review"),
    ).rejects.toMatchObject({ code: "github_not_found" });
  });
  it("bounds a streamed response even when Content-Length is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/trees/")
          ? Response.json({ truncated: false, tree: [file] })
          : url.includes("api.github.com")
            ? Response.json({ private: false })
            : new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
                    controller.close();
                  },
                }),
              ),
      ),
    );
    await expect(
      new GithubRegistryTransport("acme/source", undefined, "public").directory(
        "acme/source",
        commit,
        "skills/review",
      ),
    ).rejects.toMatchObject({ code: "github_response_too_large" });
  });
});
