import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpSeeds, seedSmokeWorkspace } from "../../scripts/smoke-seed";

const seedDatabase = vi.hoisted(() => {
  const writes: Array<{ model: string; data: Record<string, unknown> }> = [];
  let sequence = 0;
  const tables = Object.fromEntries(
    [
      "category",
      "user",
      "workspace",
      "membership",
      "server",
      "skill",
      "deployment",
      "installedSkill",
      "toolkit",
      "toolkitServer",
      "toolkitSkill",
      "chatAssistant",
      "marketListing",
      "marketRelease",
      "logEvent",
      "skillInvocation",
      "syncEvent",
      "agent",
      "sandbox",
      "agentListing",
      "agentRelease",
      "apiToken",
      "agentRevision",
      "agentServer",
      "agentSkill",
      "agentToolkit",
      "chatAssistantMcpGrant",
    ].map((model) => [
      model,
      {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ model, data });
          return { id: `${model}-${++sequence}`, latestVersion: 0, ...data };
        }),
        createMany: vi.fn(
          async ({ data }: { data: Record<string, unknown>[] }) => {
            writes.push(...data.map((row) => ({ model, data: row })));
            return { count: data.length };
          },
        ),
        upsert: vi.fn(
          async ({ create }: { create: Record<string, unknown> }) => {
            writes.push({ model, data: create });
            return { id: `${model}-${++sequence}`, ...create };
          },
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ model, data });
          return data;
        }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    ]),
  );
  return { tables, writes, disconnect: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: {
    ...seedDatabase.tables,
    $transaction: async (
      callback: (tx: typeof seedDatabase.tables) => Promise<unknown>,
    ) => callback(seedDatabase.tables),
    $disconnect: seedDatabase.disconnect,
  },
}));
vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("fixture-password-hash"),
}));

afterEach(() => vi.restoreAllMocks());

it("seeds ungranted native drafts and read-only history without issuing client tokens", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await seedSmokeWorkspace();
  const agents = seedDatabase.writes.filter(({ model }) => model === "agent");
  expect(agents.map(({ data }) => data)).toEqual([
    expect.objectContaining({
      name: "Research Copilot",
      slug: "research-copilot",
      runtimeKind: "pi-sdk",
    }),
    expect.objectContaining({
      name: "Code Quality Guardian",
      slug: "code-quality-guardian",
      runtimeKind: "pi-sdk",
    }),
    expect.objectContaining({
      name: "Incident Response Lead",
      slug: "incident-response-lead",
      runtimeKind: "pi-sdk",
    }),
  ]);
  for (const { data } of agents) {
    expect(data.currentRevisionVersion).toBe(0);
    for (const authority of [
      "servers",
      "skills",
      "toolkits",
      "providerId",
      "a2aAgents",
    ]) {
      expect(data).not.toHaveProperty(authority);
    }
  }
  expect(
    seedDatabase.writes.filter(({ model }) =>
      [
        "apiToken",
        "agentRevision",
        "agentServer",
        "agentSkill",
        "agentToolkit",
        "chatAssistantMcpGrant",
      ].includes(model),
    ),
  ).toEqual([]);
  for (const { data } of seedDatabase.writes.filter(
    ({ model }) => model === "chatAssistant",
  )) {
    expect(data).not.toHaveProperty("mcpGrants");
  }
  for (const { data } of seedDatabase.writes.filter(
    ({ model }) => model === "toolkit",
  )) {
    expect(data).toMatchObject({ enabled: false, visibility: "private" });
    expect(data.name).toContain("read-only");
  }
  for (const { data } of seedDatabase.writes.filter(
    ({ model, data }) => model === "deployment" && "status" in data,
  )) {
    expect(data.status).toBe("stopped");
    if (data.source !== "sandbox") {
      expect(data).toMatchObject({
        mcpToolExposure: "allowlist",
        mcpAllowedTools: [],
      });
    }
  }
  const templates = seedDatabase.writes.filter(
    ({ model }) => model === "agentRelease",
  );
  expect(templates).toHaveLength(3);
  for (const { data } of templates) {
    expect(record(data.manifest).toolkits).toEqual([]);
  }
  expect(output.mock.calls.flat().join(" ")).not.toMatch(/TOKEN=/);
  expect(output.mock.calls.flat().join(" ")).toContain("Prepare/review/Apply");
});

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("smoke MCP catalog snapshots", () => {
  it("provides an input schema for every seeded market tool", () => {
    const catalogs = Object.fromEntries(
      mcpSeeds.flatMap((seed) =>
        seed.catalog ? [[seed.catalog.slug, seed.catalog] as const] : [],
      ),
    );
    expect(
      Object.values(catalogs).every((catalog) =>
        catalog.sourceUrl?.startsWith("https://github.com/"),
      ),
    ).toBe(true);
    const signatures = Object.fromEntries(
      Object.entries(catalogs).map(([slug, catalog]) => [
        slug,
        {
          verifiedTools: catalog.verifiedTools,
          tools: Object.fromEntries(
            catalog.toolCatalog.map((tool) => {
              const schema = record(tool.inputSchema);
              expect(schema.type).toBe("object");
              const properties = record(schema.properties);
              const required = Array.isArray(schema.required)
                ? schema.required
                : [];
              for (const field of required)
                expect(properties).toHaveProperty(String(field));
              return [
                tool.name,
                {
                  properties: Object.keys(properties),
                  required,
                },
              ];
            }),
          ),
        },
      ]),
    );

    expect(signatures).toEqual({
      "smoke-catalog-memory": {
        verifiedTools: 9,
        tools: {
          create_entities: { properties: ["entities"], required: ["entities"] },
          create_relations: {
            properties: ["relations"],
            required: ["relations"],
          },
          add_observations: {
            properties: ["observations"],
            required: ["observations"],
          },
          delete_entities: {
            properties: ["entityNames"],
            required: ["entityNames"],
          },
          delete_observations: {
            properties: ["deletions"],
            required: ["deletions"],
          },
          delete_relations: {
            properties: ["relations"],
            required: ["relations"],
          },
          read_graph: { properties: [], required: [] },
          search_nodes: { properties: ["query"], required: ["query"] },
          open_nodes: { properties: ["names"], required: ["names"] },
        },
      },
      "smoke-catalog-sequential-thinking": {
        verifiedTools: 1,
        tools: {
          sequentialthinking: {
            properties: [
              "thought",
              "nextThoughtNeeded",
              "thoughtNumber",
              "totalThoughts",
              "isRevision",
              "revisesThought",
              "branchFromThought",
              "branchId",
              "needsMoreThoughts",
            ],
            required: [
              "thought",
              "nextThoughtNeeded",
              "thoughtNumber",
              "totalThoughts",
            ],
          },
        },
      },
      "smoke-catalog-fetch": {
        verifiedTools: 1,
        tools: {
          fetch: {
            properties: ["url", "max_length", "start_index", "raw"],
            required: ["url"],
          },
        },
      },
      "smoke-catalog-time": {
        verifiedTools: 2,
        tools: {
          get_current_time: {
            properties: ["timezone"],
            required: ["timezone"],
          },
          convert_time: {
            properties: ["source_timezone", "time", "target_timezone"],
            required: ["source_timezone", "time", "target_timezone"],
          },
        },
      },
      "smoke-catalog-deepwiki": {
        verifiedTools: 3,
        tools: {
          ask_question: {
            properties: ["repoName", "question"],
            required: ["repoName", "question"],
          },
          read_wiki_contents: {
            properties: ["repoName"],
            required: ["repoName"],
          },
          read_wiki_structure: {
            properties: ["repoName"],
            required: ["repoName"],
          },
        },
      },
      "smoke-catalog-filesystem": {
        verifiedTools: 14,
        tools: {
          read_file: {
            properties: ["path", "tail", "head"],
            required: ["path"],
          },
          read_text_file: {
            properties: ["path", "tail", "head"],
            required: ["path"],
          },
          read_media_file: { properties: ["path"], required: ["path"] },
          read_multiple_files: { properties: ["paths"], required: ["paths"] },
          write_file: {
            properties: ["path", "content"],
            required: ["path", "content"],
          },
          edit_file: {
            properties: ["path", "edits", "dryRun"],
            required: ["path", "edits"],
          },
          create_directory: { properties: ["path"], required: ["path"] },
          list_directory: { properties: ["path"], required: ["path"] },
          list_directory_with_sizes: {
            properties: ["path", "sortBy"],
            required: ["path"],
          },
          directory_tree: {
            properties: ["path", "excludePatterns"],
            required: ["path"],
          },
          move_file: {
            properties: ["source", "destination"],
            required: ["source", "destination"],
          },
          search_files: {
            properties: ["path", "pattern", "excludePatterns"],
            required: ["path", "pattern"],
          },
          get_file_info: { properties: ["path"], required: ["path"] },
          list_allowed_directories: { properties: [], required: [] },
        },
      },
    });

    const fetchSchema = record(
      catalogs["smoke-catalog-fetch"].toolCatalog[0]?.inputSchema,
    );
    expect(record(record(fetchSchema.properties).max_length)).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      exclusiveMaximum: 1_000_000,
      default: 5_000,
    });

    const filesystemTools = new Map(
      catalogs["smoke-catalog-filesystem"].toolCatalog.map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const editSchema = record(filesystemTools.get("edit_file")?.inputSchema);
    const editItems = record(record(record(editSchema.properties).edits).items);
    expect(editItems.required).toEqual(["oldText", "newText"]);
    expect(record(record(editSchema.properties).dryRun)).toMatchObject({
      default: false,
    });
    expect(
      record(
        record(
          record(filesystemTools.get("read_multiple_files")?.inputSchema)
            .properties,
        ).paths,
      ),
    ).toMatchObject({ minItems: 1 });
  });
});
