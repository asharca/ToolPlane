// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  servers: vi.fn(),
  market: vi.fn(),
  recipes: vi.fn(),
  workspace: vi.fn(),
  workspaces: vi.fn(),
  deployments: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    server: { findFirst: mocks.server, findMany: mocks.servers },
    marketListing: { findMany: mocks.market },
    $queryRaw: mocks.recipes,
    workspace: { findFirst: mocks.workspace, findMany: mocks.workspaces },
    deployment: { findMany: mocks.deployments },
  },
}));
import {
  getBrowseServers,
  getDefaultWorkspace,
  getDeployments,
  getMarketServer,
  getWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/workspace/queries";

const category = { name: "Search", slug: "search" };
const tools = [{ name: "search", inputSchema: { type: "object" } }];
const base = {
  id: "server",
  slug: "server",
  name: "Server",
  author: null,
  description: null,
  iconUrl: null,
  stars: 1,
  isOfficial: false,
  isFeatured: false,
  createdAt: new Date(0),
  categories: [category],
  marketListing: null,
};
beforeEach(() => vi.resetAllMocks());

describe("workspace query projections", () => {
  it("projects connection lists without encrypted or plaintext credentials", async () => {
    mocks.deployments.mockResolvedValue([
      {
        id: "connection",
        installCfg: {
          env: { TOKEN: "", EMPTY: "", LEGACY: "private-plaintext" },
          requiredEnv: ["TOKEN", "EMPTY"],
          credentialEnvelope: {
            configuredKeys: ["TOKEN"],
            encrypted: { data: "private-ciphertext" },
          },
          args: ["--token", "private-argument"],
          toolCatalog: tools,
        },
      },
    ]);
    const projected = await getDeployments("workspace");
    expect(projected).toEqual([
      {
        id: "connection",
        installCfg: {
          env: { TOKEN: "configured", EMPTY: "", LEGACY: "" },
          requiredEnv: ["TOKEN", "EMPTY"],
          toolCatalog: tools,
        },
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("private-");
    expect(JSON.stringify(projected)).not.toContain("credentialEnvelope");
    expect(mocks.deployments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace" }),
      }),
    );
  });

  it("does not expose inactive or unrelated workspaces and falls back from an inaccessible last slug", async () => {
    const records = [
      {
        id: "foreign",
        slug: "foreign",
        ownerId: "other",
        status: "active",
        members: [],
      },
      {
        id: "disabled",
        slug: "disabled",
        ownerId: "user",
        status: "disabled",
        members: [],
      },
      {
        id: "mine",
        slug: "mine",
        ownerId: "user",
        status: "active",
        members: [],
      },
    ];
    mocks.workspace.mockImplementation(
      async ({ where }) =>
        records.find(
          (record) =>
            (!where.slug || record.slug === where.slug) &&
            record.status === where.status &&
            (record.ownerId === where.OR[0].ownerId ||
              record.members.some(
                (member: { userId: string }) =>
                  member.userId === where.OR[1].members.some.userId,
              )),
        ) ?? null,
    );
    expect(await getWorkspaceForUser("foreign", "user")).toBeNull();
    expect(await getWorkspaceForUser("disabled", "user")).toBeNull();
    expect(await getDefaultWorkspace("user", "foreign")).toMatchObject({
      id: "mine",
    });
    expect(await getDefaultWorkspace("user", "mine")).toMatchObject({
      id: "mine",
    });
  });

  it("derives roles from ownership before membership and strips membership internals", async () => {
    mocks.workspaces.mockResolvedValue([
      {
        id: "own",
        ownerId: "user",
        members: [{ role: "member" }],
        _count: { members: 3 },
      },
      {
        id: "admin",
        ownerId: "other",
        members: [{ role: "admin" }],
        _count: { members: 2 },
      },
      { id: "member", ownerId: "other", members: [], _count: { members: 1 } },
    ]);
    expect(await listWorkspacesForUser("user")).toEqual([
      { id: "own", role: "owner", memberCount: 3 },
      { id: "admin", role: "admin", memberCount: 2 },
      { id: "member", role: "member", memberCount: 1 },
    ]);
  });

  it.each(["popular", "newest", "name"] as const)(
    "combines validated catalogs before %s sorting, facets and pagination",
    async (sort) => {
      mocks.servers.mockResolvedValue([
        { ...base, id: "alpha", name: "Alpha", stars: 2, isFeatured: true },
        {
          ...base,
          id: "beta",
          name: "Beta",
          stars: 8,
          createdAt: new Date(2000),
        },
        { ...base, id: "invalid", name: "Invalid" },
      ]);
      mocks.market.mockResolvedValue([]);
      mocks.recipes.mockResolvedValue([
        { id: "alpha", installCfg: { source: "npm", ref: "alpha" } },
        {
          id: "beta",
          installCfg: { source: "remote", ref: "https://example.com/mcp" },
        },
        { id: "invalid", installCfg: { source: "npm", ref: "INVALID NAME" } },
      ]);
      const result = await getBrowseServers(0, "", { sort });
      expect(result.all.map(({ id }) => id)).toEqual(
        sort === "name" ? ["alpha", "beta"] : ["beta", "alpha"],
      );
      expect(result.total).toBe(2);
      expect(result.categories).toEqual([{ ...category, count: 2 }]);
      expect(result.featured.map(({ id }) => id)).toEqual(
        sort === "popular" ? ["alpha"] : [],
      );
      expect(
        (await getBrowseServers(1, "", { type: "connector" })).all.map(
          ({ id }) => id,
        ),
      ).toEqual(["beta"]);
      expect((await getBrowseServers(2)).all).toEqual([]);
    },
  );

  it.each([
    ["npm", "@scope/server", "https://www.npmjs.com/package/%40scope/server"],
    ["pypi", "fetch-server", "https://pypi.org/project/fetch-server/"],
    [
      "github",
      "https://github.com/org/server",
      "https://github.com/org/server",
    ],
    ["docker", "org/server", null],
  ])(
    "chooses the canonical %s source URL when README links are unsafe",
    async (source, ref, expected) => {
      mocks.server.mockResolvedValue({
        ...base,
        verifiedAt: new Date(),
        verifiedTools: 1,
        readme: "https://user:secret@example.com/private https://:invalid",
        deployments: [],
        installCfg: { source, ref, toolCatalog: tools },
      });
      expect(await getMarketServer("server", "workspace")).toMatchObject({
        sourceUrl: expected,
        deploymentId: null,
        tools,
      });
    },
  );
});
