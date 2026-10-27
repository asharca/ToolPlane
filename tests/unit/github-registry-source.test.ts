// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GithubRegistryTransport,
  parseGithubRegistryIndex,
} from "@/lib/market/github-registry-source";

const commit = "a".repeat(40);
const resource = {
  id: "review",
  kind: "skill",
  version: "1.0.0",
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
  it.each([
    { schemaVersion: 1, resources: [resource, resource] },
    { schemaVersion: 1, resources: [{ ...resource, path: "../escape" }] },
    { schemaVersion: 1, resources: [{ ...resource, path: "skills\\review" }] },
    { schemaVersion: 1, resources: [{ ...resource, version: "01.0.0" }] },
    {
      schemaVersion: 1,
      resources: [
        {
          ...resource,
          source: {
            repository: "acme/source",
            commit: "main",
            path: "skills/review",
          },
        },
      ],
    },
    {
      schemaVersion: 1,
      resources: [
        {
          ...resource,
          source: {
            repository: "https://evil.test/repo",
            commit,
            path: "skills/review",
          },
        },
      ],
    },
    { schemaVersion: 1, resources: [resource], unrecognized: true },
  ])("rejects ambiguous, unsafe or mutable index entries", (raw) => {
    expect(() => parseGithubRegistryIndex(raw)).toThrow();
  });
  it("downloads bytes only from the resolved SHA and verifies their Git blob identity without exposing credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        expect(init?.redirect).toBe("error");
        if (url.hostname === "api.github.com") {
          if (url.pathname.includes("/git/trees/")) {
            expect(url.pathname.endsWith(commit)).toBe(true);
            return Response.json({ truncated: false, tree: [file] });
          }
          return url.pathname === "/repos/acme/source"
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
