import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDocs } from "@/lib/docs";
import { resolveDocLink } from "@/lib/docs-links";
import { GET } from "@/app/docs/search/route";
import { staticClient } from "fumadocs-core/search/client/orama-static";

describe("public documentation", () => {
  it("covers all maintained Markdown files without colliding README routes", async () => {
    const files = readdirSync(path.join(process.cwd(), "docs"), {
      recursive: true,
    })
      .filter(
        (file): file is string =>
          typeof file === "string" && file.endsWith(".md"),
      )
      .map((file) => `docs/${file.split(path.sep).join("/")}`)
      .filter(
        (file) =>
          !file
            .split("/")
            .some(
              (part) =>
                part.startsWith(".") ||
                /^(?:AGENTS|CLAUDE)(?:\.|$)/i.test(part) ||
                /^plans$/i.test(part),
            ),
      );
    const docs = await getDocs();
    expect(docs.map((doc) => doc.file).sort()).toEqual(
      [
        ...files,
        "README.md",
        "CHANGELOG.md",
        "infra/firecrawl/README.md",
      ].sort(),
    );
    expect(new Set(docs.map((doc) => doc.url)).size).toBe(docs.length);
    expect(docs.find((doc) => doc.file === "README.md")?.url).toBe(
      "/docs/zh/guides/README",
    );
    expect(docs.find((doc) => doc.file === "docs/README.md")?.url).toBe(
      "/docs/en/guides/docs/README",
    );
    for (const doc of docs) {
      expect(doc.url).toBe(
        `/docs/${doc.language}/${doc.category}/${doc.topic.split("/").map(encodeURIComponent).join("/")}`,
      );
    }
    expect(
      docs.find((doc) => doc.file === "docs/ARCHITECTURE.md"),
    ).toMatchObject({ language: "zh", topic: "docs/ARCHITECTURE" });
    expect(
      docs.find((doc) => doc.file === "docs/ARCHITECTURE.en.md"),
    ).toMatchObject({ language: "en", topic: "docs/ARCHITECTURE" });
    expect(
      docs.find((doc) => doc.file === "docs/HERMES_AGENT_RUNTIME.md")?.language,
    ).toBe("zh");
    expect(
      docs.find((doc) => doc.file === "docs/HERMES_AGENT_RUNTIME.en.md")
        ?.language,
    ).toBe("en");
  });

  it("resolves known documents and repository files without consuming anchors or escaping the repository", () => {
    const docs = [
      { file: "README.md", url: "/docs/zh/guides/README" },
      {
        file: "docs/nested/space name.md",
        url: "/docs/en/guides/docs/nested/space%20name",
      },
    ];
    expect(
      resolveDocLink("docs/README.md", "../README.md#quick-start", docs),
    ).toBe("/docs/zh/guides/README#quick-start");
    expect(
      resolveDocLink(
        "docs/README.md",
        "./nested/space%20name.md?lang=en#section",
        docs,
      ),
    ).toBe("/docs/en/guides/docs/nested/space%20name?lang=en#section");
    expect(
      resolveDocLink("docs/nested/space name.md", "../../src/app.ts#L12", docs),
    ).toBe("https://github.com/asharca/ToolPlane/blob/main/src/app.ts#L12");
    expect(resolveDocLink("docs/README.md", "./missing.md", docs)).toBe(
      "https://github.com/asharca/ToolPlane/blob/main/docs/missing.md",
    );
    for (const href of [
      "#section",
      "?lang=en",
      "/docs/api",
      "https://example.com/a#b",
      "//example.com/a",
      "mailto:hello@example.com",
      "../../.env",
      "%2e%2e/%2e%2e/.env",
      "%2Fetc/passwd",
      "..\\.env",
      "%invalid",
    ]) {
      expect(resolveDocLink("docs/README.md", href, docs)).toBe(href);
    }
  });
});

describe("scoped documentation search", () => {
  it.each([
    ["zh", "guides", "docs/WORKSPACES.md"],
    ["en", "guides", "docs/WORKSPACES.en.md"],
    ["zh", "developers", "docs/ARCHITECTURE.md"],
    ["en", "developers", "docs/ARCHITECTURE.en.md"],
    ["zh", "api", "docs/AGENT_PUBLIC_API.zh-CN.md"],
    ["en", "api", "docs/AGENT_PUBLIC_API.md"],
  ])(
    "searches only %s/%s using the real Markdown inventory",
    async (language, category, file) => {
      const doc = assertDefined(
        (await getDocs()).find((candidate) => candidate.file === file),
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => GET());
      try {
        const client = staticClient({
          from: "/docs/search",
          locale: language,
          tag: category,
        });
        const results = await client.search(doc.title);
        expect(results.some((result) => result.url === doc.url)).toBe(true);
        expect(
          results.every((result) =>
            result.url.startsWith(`/docs/${language}/${category}/`),
          ),
        ).toBe(true);
      } finally {
        fetch.mockRestore();
      }
    },
  );
});
