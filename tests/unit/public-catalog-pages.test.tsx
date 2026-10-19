import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketingContent } from "@/lib/marketing/content";

const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  client: vi.fn(),
  skill: vi.fn(),
  related: vi.fn(),
  relatedSkills: vi.fn(),
  search: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  permanentRedirect: (path: string) => {
    throw new Error(`permanentRedirect:${path}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/app/(site)/_lib/catalog", () => ({
  getPublicServer: mocks.server,
  getPublicClient: mocks.client,
  getPublicSkill: mocks.skill,
  getPublicRelatedServers: mocks.related,
  getPublicRelatedSkills: mocks.relatedSkills,
}));
vi.mock("@/lib/queries/public-search", () => ({
  searchPublicDirectory: mocks.search,
}));
vi.mock("@/components/server/ServerList", () => ({ ServerList: () => null }));

import ServerPage, {
  generateMetadata as serverMetadata,
} from "@/app/(site)/server/[slug]/page";
import ClientPage, {
  generateMetadata as clientMetadata,
} from "@/app/(site)/client/[slug]/page";
import SkillPage, {
  generateMetadata as skillMetadata,
} from "@/app/(site)/tools/skills/[slug]/page";
import SearchPage, {
  generateMetadata as searchMetadata,
} from "@/app/(site)/search/page";
import ServerPaginationPage, {
  generateMetadata as paginationMetadata,
} from "@/app/(site)/server/page/[page]/page";

const props = () => ({ params: Promise.resolve({ slug: "example" }) });
const entity = () => ({
  id: "entity-1",
  slug: "example",
  name: "Example resource",
  description: "Useful resource description",
  author: "Ada",
  iconUrl: null,
  stars: 1234,
  score: 98,
  categories: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.server.mockResolvedValue({ ...entity(), deployable: true });
  mocks.client.mockResolvedValue(entity());
  mocks.skill.mockResolvedValue({
    ...entity(),
    installable: true,
    githubSource: null,
  });
  mocks.related.mockResolvedValue([]);
  mocks.relatedSkills.mockResolvedValue([]);
  mocks.search.mockResolvedValue({
    servers: [],
    clients: [],
    skills: [],
    agents: [],
  });
});
afterEach(cleanup);

describe("public directory detail pages", () => {
  it.each([
    ["server", ServerPage],
    ["client", ClientPage],
    ["skill", SkillPage],
  ] as const)(
    "returns notFound for unknown %s slugs",
    async (kind, component) => {
      mocks[kind].mockResolvedValue(null);
      await expect(component(props())).rejects.toThrow("notFound");
    },
  );
  it.each([
    ["server", serverMetadata, "/server/example"],
    ["client", clientMetadata, "/client/example"],
    ["skill", skillMetadata, "/tools/skills/example"],
  ] as const)(
    "marks missing %s pages noindex with stable canonical paths",
    async (kind, generate, path) => {
      mocks[kind].mockResolvedValue(null);
      const metadata = await generate(props());
      expect(metadata.alternates?.canonical).toBe(path);
      expect(metadata.robots).toEqual({
        index: false,
        follow: true,
        noarchive: true,
      });
      expect(metadata.title).toEqual(expect.stringContaining("Page not found"));
    },
  );
  it.each([
    ["server", serverMetadata],
    ["client", clientMetadata],
    ["skill", skillMetadata],
  ] as const)(
    "uses the %s description in search metadata",
    async (_kind, generate) => {
      const metadata = await generate(props());
      expect(metadata.description).toBe("Useful resource description");
      expect(metadata.title).toEqual(
        expect.stringContaining("Example resource"),
      );
      expect(metadata.robots).toEqual({ index: true, follow: true });
    },
  );
  it("offers deploy instructions only for a verified deployable MCP", async () => {
    render(await ServerPage(props()));
    expect(
      screen.getByRole("link", { name: "signInToRunOnToolplane" }),
    ).toHaveAttribute("href", "/app?server=example");
    expect(screen.getByText(/POST \/api\/v1\/mcp/)).toHaveTextContent(
      '"method":"tools/list"',
    );
    expect(
      screen.queryByRole("heading", { name: "relatedMcps" }),
    ).not.toBeInTheDocument();
  });
  it("routes unverified MCPs to the curated market instead of showing runnable instructions", async () => {
    mocks.server.mockResolvedValue({
      ...entity(),
      slug: "remote/tool",
      description: null,
      author: null,
      deployable: false,
    });
    render(await ServerPage(props()));
    expect(
      screen.getByRole("link", { name: "browseDeployableServers" }),
    ).toHaveAttribute("href", "/app?market=mcp&q=remote%2Ftool");
    expect(
      screen.getByRole("heading", { name: "deploymentUnavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/POST \/api\/v1\/mcp/)).not.toBeInTheDocument();
    expect(
      screen.getByText("defaultDescription:Example resource"),
    ).toBeInTheDocument();
  });
  it("renders category navigation and related MCP and skill destinations", async () => {
    mocks.server.mockResolvedValue({
      ...entity(),
      deployable: true,
      iconUrl: "https://example.com/icon.png",
      categories: [{ id: "cat-1", slug: "research", name: "Research" }],
    });
    mocks.related.mockResolvedValue([
      {
        slug: "related",
        name: "Related MCP",
        description: "Related description",
        iconUrl: "https://example.com/related.png",
      },
      { slug: "other", name: "Other MCP", description: null, iconUrl: null },
    ]);
    mocks.relatedSkills.mockResolvedValue([
      {
        slug: "writing",
        name: "Writing skill",
        description: "Skill description",
        iconUrl: null,
      },
    ]);
    render(await ServerPage(props()));
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute(
      "href",
      "/categories/research",
    );
    expect(
      screen.getByRole("link", { name: /Related MCP.*Related description/ }),
    ).toHaveAttribute("href", "/server/related");
    expect(
      screen.getByRole("link", { name: /Writing skill.*Skill description/ }),
    ).toHaveAttribute("href", "/tools/skills/writing");
    expect(mocks.related).toHaveBeenCalledWith("entity-1", ["cat-1"], 4);
  });
  it("renders client identity, category and server navigation", async () => {
    mocks.client.mockResolvedValue({
      ...entity(),
      iconUrl: "https://example.com/client.png",
      categories: [{ id: "cat-1", slug: "desktop", name: "Desktop" }],
    });
    render(await ClientPage(props()));
    expect(
      screen.getByRole("heading", { name: "Example resource" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Desktop" })).toHaveAttribute(
      "href",
      "/categories/desktop",
    );
    expect(
      screen.getByRole("link", { name: "browseMcpServers" }),
    ).toHaveAttribute("href", "/server");
  });
  it("uses client marketing fallback when the catalog lacks descriptive fields", async () => {
    mocks.client.mockResolvedValue({
      ...entity(),
      description: null,
      author: null,
    });
    render(await ClientPage(props()));
    expect(
      screen.getByText(
        getMarketingContent("en").capabilities.clients.description,
      ),
    ).toBeInTheDocument();
    expect((await clientMetadata(props())).description).toBe(
      getMarketingContent("en").capabilities.clients.description,
    );
  });
  it.each([true, false])(
    "uses installable=%s to select a safe skill installation destination",
    async (installable) => {
      mocks.skill.mockResolvedValue({
        ...entity(),
        slug: "writer/skill",
        installable,
        githubSource: "https://github.com/acme/skills",
        categories: [{ id: "cat-1", slug: "writing", name: "Writing" }],
      });
      render(await SkillPage(props()));
      expect(
        screen.getByRole("link", {
          name: installable ? "addToMyWorkspace" : "browseInstallableSkills",
        }),
      ).toHaveAttribute(
        "href",
        installable
          ? "/app?skill=writer%2Fskill"
          : "/app?market=skills&q=writer%2Fskill",
      );
      expect(
        screen.getByText("npx skillfish add https://github.com/acme/skills"),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Writing" })).toHaveAttribute(
        "href",
        "/categories/writing",
      );
    },
  );
  it("renders skill fallback description without inventing a GitHub installation command", async () => {
    mocks.skill.mockResolvedValue({
      ...entity(),
      description: null,
      author: null,
      installable: false,
      githubSource: null,
    });
    render(await SkillPage(props()));
    expect(
      screen.getByText(
        getMarketingContent("en").capabilities.skills.description,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/npx skillfish/)).not.toBeInTheDocument();
    expect((await skillMetadata(props())).description).toBe(
      getMarketingContent("en").capabilities.skills.description,
    );
  });
});

describe("public search", () => {
  it.each([undefined, "   "])(
    "does not search for empty query %s",
    async (q) => {
      render(await SearchPage({ searchParams: Promise.resolve({ q }) }));
      expect(
        screen.getByText(
          "enterASearchTermToFindMcpServersClientsAndAgentSkills",
        ),
      ).toBeInTheDocument();
      expect(mocks.search).not.toHaveBeenCalled();
    },
  );
  it("normalizes repeated queries to the first value and explains no results", async () => {
    render(
      await SearchPage({
        searchParams: Promise.resolve({ q: ["  weather  ", "ignored"] }),
      }),
    );
    expect(mocks.search).toHaveBeenCalledWith("weather");
    expect(screen.getByRole("searchbox")).toHaveValue("weather");
    expect(screen.getByText("noResultsForQuery:weather")).toBeInTheDocument();
  });
  it("bounds public queries and marks search pages noindex", async () => {
    const q = "x".repeat(200);
    const metadata = await searchMetadata({
      searchParams: Promise.resolve({ q }),
    });
    expect(metadata.title).toEqual(expect.stringContaining("x".repeat(160)));
    expect(metadata.title).not.toEqual(
      expect.stringContaining("x".repeat(161)),
    );
    expect(metadata.robots).toEqual({
      index: false,
      follow: true,
      noarchive: true,
    });
    render(await SearchPage({ searchParams: Promise.resolve({ q }) }));
    expect(mocks.search).toHaveBeenCalledWith("x".repeat(160));
  });
  it("shows each matching resource type with its real detail URL", async () => {
    mocks.search.mockResolvedValue({
      servers: [{ ...entity(), slug: "server", name: "Weather MCP" }],
      clients: [{ ...entity(), slug: "client", name: "Desktop client" }],
      skills: [{ ...entity(), slug: "skill", name: "Writer skill" }],
      agents: [
        {
          id: "agent-1",
          slug: "agent",
          directorySlug: "agent",
          name: "Research agent",
          author: null,
          summary: "Research tasks",
          iconUrl: null,
          installCount: 12,
          categories: [],
          publisherWorkspace: { slug: "acme", name: "Acme" },
        },
      ],
    });
    render(
      await SearchPage({ searchParams: Promise.resolve({ q: "example" }) }),
    );
    expect(screen.getByText("(4)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Weather MCP/ })).toHaveAttribute(
      "href",
      "/server/server",
    );
    expect(
      screen.getByRole("link", { name: /Desktop client/ }),
    ).toHaveAttribute("href", "/client/client");
    expect(screen.getByRole("link", { name: /Writer skill/ })).toHaveAttribute(
      "href",
      "/tools/skills/skill",
    );
    expect(
      screen.getByRole("link", { name: /Research agent/ }),
    ).toHaveAttribute("href", "/agents/acme/agent");
  });
  it("omits empty resource sections when only MCPs match", async () => {
    mocks.search.mockResolvedValue({
      servers: [entity()],
      clients: [],
      skills: [],
      agents: [],
    });
    render(
      await SearchPage({ searchParams: Promise.resolve({ q: "example" }) }),
    );
    expect(
      screen.getByRole("heading", { name: "servers" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "clients" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "skills" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "agents" }),
    ).not.toBeInTheDocument();
  });
});

describe("public directory pagination", () => {
  it.each(["0", "-1", "NaN", "1.5", "1000001", "9007199254740992"])(
    "rejects invalid page %s",
    async (page) => {
      await expect(
        ServerPaginationPage({ params: Promise.resolve({ page }) }),
      ).rejects.toThrow("notFound");
      const metadata = await paginationMetadata({
        params: Promise.resolve({ page }),
      });
      expect(metadata.robots).toEqual({
        index: false,
        follow: true,
        noarchive: true,
      });
    },
  );
  it("permanently redirects page one to the canonical directory", async () => {
    await expect(
      ServerPaginationPage({ params: Promise.resolve({ page: "1" }) }),
    ).rejects.toThrow("permanentRedirect:/server");
    expect(
      (await paginationMetadata({ params: Promise.resolve({ page: "1" }) }))
        .alternates?.canonical,
    ).toBe("/server");
  });
  it("gives later pages distinct canonical URLs and titles", async () => {
    const metadata = await paginationMetadata({
      params: Promise.resolve({ page: "2" }),
    });
    expect(metadata.alternates?.canonical).toBe("/server/page/2");
    expect(metadata.title).toEqual(expect.stringContaining("— 2 |"));
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });
});
