// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findAgent: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (operation: (tx: unknown) => unknown) =>
      operation({ agent: { findUnique: mocks.findAgent } }),
  },
}));
import { assessAgentPortability } from "@/lib/agents/market";
import { sealMcpEnvironment } from "@/lib/process/mcp-credentials";

function agent(id = "root") {
  return {
    id,
    workspaceId: "workspace-1",
    name: "Researcher",
    slug: "researcher",
    runtimeKind: "pi",
    runtime: null,
    systemPrompt: "Be accurate",
    maxSteps: 8,
    model: null,
    provider: null,
    modelProviders: [],
    sandboxes: [
      {
        sandbox: {
          id: "sandbox-1",
          workspaceId: "workspace-1",
          kind: "docker",
          network: "isolated",
        },
      },
    ],
    servers: [] as Array<{ deployment: Record<string, unknown> }>,
    skills: [] as Array<{ installedSkill: Record<string, unknown> }>,
    toolkits: [] as Array<{ toolkit: Record<string, unknown> }>,
    subAgents: [] as Array<{
      child: { id: string; workspaceId: string; name: string };
    }>,
  };
}
const input = { workspaceId: "workspace-1", agentId: "root" };

describe("market portable graph trust boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    [null, "agent_not_found"],
    [{ ...agent(), workspaceId: "foreign" }, "cross_workspace_agent"],
  ])("rejects missing or foreign root %j", async (root, code) => {
    mocks.findAgent.mockResolvedValue(root);
    await expect(assessAgentPortability(input)).resolves.toMatchObject({
      portable: false,
      issues: [expect.objectContaining({ code, resourceId: "root" })],
    });
  });

  it.each([
    [[], "invalid_definition"],
    [
      [
        {
          sandbox: {
            id: "sandbox",
            workspaceId: "workspace-1",
            kind: "docker",
            network: "none",
          },
        },
      ],
      "invalid_definition",
    ],
    [
      [
        {
          sandbox: {
            id: "sandbox",
            workspaceId: "foreign",
            kind: "docker",
            network: "isolated",
          },
        },
      ],
      "invalid_definition",
    ],
    [
      [
        {
          sandbox: {
            id: "sandbox",
            workspaceId: "workspace-1",
            kind: "local",
            network: "isolated",
          },
        },
      ],
      "invalid_definition",
    ],
  ])("rejects nonportable sandbox selection %j", async (sandboxes, code) => {
    mocks.findAgent.mockResolvedValue({ ...agent(), sandboxes });
    await expect(assessAgentPortability(input)).resolves.toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code, path: "agents.agent_1.sandboxes" }),
      ]),
    });
  });

  it("rejects unsupported runtime and external sandbox together rather than silently downgrading", async () => {
    mocks.findAgent.mockResolvedValue({
      ...agent(),
      runtimeKind: "claude-code",
      runtime: { id: "runtime", kind: "claude-code" },
    });
    const result = await assessAgentPortability(input);
    expect(result).toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_runtime" }),
        expect.objectContaining({ code: "external_sandbox" }),
      ]),
    });
  });

  it.each([
    [
      { id: "deployment", workspaceId: "foreign" },
      "cross_workspace_deployment",
    ],
    [
      { id: "deployment", workspaceId: "workspace-1", serverId: null },
      "custom_mcp",
    ],
    [
      {
        id: "deployment",
        workspaceId: "workspace-1",
        serverId: "server",
        server: { name: "Unverified", verifiedAt: null },
      },
      "unverified_catalog_mcp",
    ],
    [
      {
        id: "deployment",
        workspaceId: "workspace-1",
        serverId: "server",
        server: { name: "Broken", verifiedAt: new Date(), installCfg: {} },
      },
      "invalid_catalog_recipe",
    ],
  ])("rejects untrusted MCP deployment %j", async (deployment, code) => {
    const root = agent();
    root.servers = [{ deployment }, { deployment }];
    mocks.findAgent.mockResolvedValue(root);
    const result = await assessAgentPortability(input);
    expect(result).toMatchObject({
      portable: false,
      issues: [expect.objectContaining({ code, resourceId: "deployment" })],
    });
  });

  it("collects all foreign resource issues without exporting any resource contents", async () => {
    const root = agent();
    root.skills = [{ installedSkill: { id: "skill", workspaceId: "foreign" } }];
    root.toolkits = [{ toolkit: { id: "toolkit", workspaceId: "foreign" } }];
    root.subAgents = [
      {
        child: {
          id: "foreign-child",
          workspaceId: "foreign",
          name: "Secret agent",
        },
      },
    ];
    mocks.findAgent.mockResolvedValue({
      ...root,
      provider: { id: "provider", workspaceId: "foreign" },
    });
    const result = await assessAgentPortability(input);
    expect(result).toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "cross_workspace_skill" }),
        expect.objectContaining({ code: "cross_workspace_toolkit" }),
        expect.objectContaining({ code: "cross_workspace_agent" }),
        expect.objectContaining({ code: "cross_workspace_provider" }),
      ]),
    });
    expect(result).not.toHaveProperty("manifest");
    expect(mocks.findAgent).toHaveBeenCalledOnce();
  });

  it("traverses a cyclic delegation graph once and preserves its portable links", async () => {
    const root = agent();
    const child = agent("child");
    root.subAgents = [
      { child: { id: "child", workspaceId: "workspace-1", name: "Child" } },
    ];
    child.subAgents = [
      { child: { id: "root", workspaceId: "workspace-1", name: "Root" } },
    ];
    mocks.findAgent.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "root" ? root : child,
    );
    const result = await assessAgentPortability(input);
    expect(result).toMatchObject({
      portable: true,
      manifest: {
        agents: [
          expect.objectContaining({
            key: "agent_1",
            subAgentKeys: ["agent_2"],
          }),
          expect.objectContaining({
            key: "agent_2",
            subAgentKeys: ["agent_1"],
          }),
        ],
      },
    });
    expect(mocks.findAgent).toHaveBeenCalledTimes(2);
  });

  it("bounds delegation traversal to 64 agents instead of exporting a truncated graph", async () => {
    const root = agent();
    root.subAgents = Array.from({ length: 65 }, (_, index) => ({
      child: {
        id: `child-${index}`,
        workspaceId: "workspace-1",
        name: `Child ${index}`,
      },
    }));
    mocks.findAgent.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "root" ? root : agent(where.id),
    );
    const result = await assessAgentPortability(input);
    expect(result).toMatchObject({
      portable: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "graph_too_large" }),
      ]),
    });
    expect(mocks.findAgent).toHaveBeenCalledTimes(64);
    expect(result).not.toHaveProperty("manifest");
  });
  describe("round two portable resource policies", () => {
    const skill = {
      id: "skill",
      workspaceId: "workspace-1",
      skillId: null,
      skill: null,
      name: "Custom skill",
      slug: "custom-skill",
      description: null,
      content: "# Useful instructions\nRead carefully.",
      files: [],
      userInvocable: true,
      agentInvocable: false,
      effort: "",
    };
    const deployment = {
      id: "deployment",
      workspaceId: "workspace-1",
      serverId: "server",
      mcpToolExposure: "allowlist",
      mcpAllowedTools: ["trusted", "untrusted", "trusted"],
      server: {
        name: "Catalog server",
        slug: "catalog-server",
        verifiedAt: new Date(),
        installCfg: {
          source: "npm",
          ref: "@example/server",
          env: ["REQUIRED_KEY", "PUBLIC_MODE"],
          envValues: { PUBLIC_MODE: "safe" },
          toolCatalog: [{ name: "trusted" }],
        },
      },
    };

    it("exports only catalog-trusted MCP tools and public recipe environment rather than deployment secrets", async () => {
      const root = agent();
      root.servers = [
        {
          deployment: {
            ...deployment,
            installCfg: sealMcpEnvironment({}, "workspace-1", {
              REQUIRED_KEY: "private-deployment-secret",
            }),
          },
        },
        { deployment },
      ];
      mocks.findAgent.mockResolvedValue(root);
      const result = await assessAgentPortability(input);
      expect(result).toMatchObject({
        portable: true,
        manifest: {
          deployments: [
            expect.objectContaining({
              requiredEnv: ["REQUIRED_KEY"],
              publicEnv: { PUBLIC_MODE: "safe" },
              mcpAllowedTools: ["trusted"],
            }),
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain("private-deployment-secret");
    });

    it("flattens toolkit resources and deduplicates shared skills and MCPs", async () => {
      const root = agent();
      root.skills = [
        { installedSkill: skill },
        {
          installedSkill: {
            ...skill,
            id: "skill-2",
            name: " ",
            slug: "!!!",
            description: "Second",
            effort: "high",
          },
        },
      ];
      root.servers = [{ deployment }];
      root.toolkits = [
        {
          toolkit: {
            id: "toolkit",
            workspaceId: "workspace-1",
            name: "Toolkit",
            slug: "",
            enabled: true,
            servers: [
              { deployment },
              { deployment: { ...deployment, id: "deployment-2" } },
            ],
            skills: [
              { installedSkill: skill },
              { installedSkill: { ...skill, id: "skill-2" } },
            ],
          },
        },
        {
          toolkit: {
            id: "toolkit-2",
            workspaceId: "workspace-1",
            name: "Toolkit 2",
            slug: "toolkit-2",
            enabled: false,
            servers: [],
            skills: [],
          },
        },
      ];
      mocks.findAgent.mockResolvedValue(root);
      const result = await assessAgentPortability(input);
      expect(result).toMatchObject({
        portable: true,
        manifest: {
          skills: [
            expect.objectContaining({ origin: "custom", effort: "default" }),
            expect.objectContaining({
              name: "Skill",
              slug: "skill",
              effort: "high",
            }),
          ],
          toolkits: [],
          deployments: [
            expect.objectContaining({ key: "deployment_1" }),
            expect.objectContaining({ key: "deployment_2" }),
          ],
          agents: [
            expect.objectContaining({
              deploymentKeys: ["deployment_1", "deployment_2"],
              skillKeys: ["skill_1", "skill_2"],
              toolkitKeys: [],
            }),
          ],
        },
      });
    });

    it("exports catalog skill identity and revision instead of an installed copy's overridden identity", async () => {
      const root = agent();
      root.skills = [
        {
          installedSkill: {
            ...skill,
            skillId: "catalog",
            skill: {
              id: "catalog",
              name: "Catalog skill",
              slug: "catalog-skill",
              description: "Published",
              content: "Catalog body",
              author: "Author",
              sourceSha: "revision",
              files: [],
            },
            name: "Overridden",
          },
        },
      ];
      mocks.findAgent.mockResolvedValue(root);
      expect(await assessAgentPortability(input)).toMatchObject({
        portable: true,
        manifest: {
          skills: [
            expect.objectContaining({
              origin: "catalog",
              catalogSlug: "catalog-skill",
              sourceSha: "revision",
              name: "Catalog skill",
              description: "Published",
            }),
          ],
        },
      });
    });

    it("rejects a malformed skill bundle and caches the rejection across repeated references", async () => {
      const root = agent();
      const invalid = {
        ...skill,
        files: [{ path: "oversized.txt", content: "x".repeat(2_000_001) }],
      };
      root.skills = [{ installedSkill: invalid }, { installedSkill: invalid }];
      mocks.findAgent.mockResolvedValue(root);
      expect(await assessAgentPortability(input)).toMatchObject({
        portable: false,
        issues: [
          expect.objectContaining({
            code: "invalid_skill_bundle",
            resourceId: "skill",
          }),
        ],
      });
    });

    it.each(["deployment", "skill", "toolkit"])(
      "rejects a resource graph exceeding the 512-item bound for %s",
      async (kind) => {
        const root = agent();
        const resources = Array.from(
          { length: 513 },
          (_, index) => `${kind}-${index}`,
        );
        if (kind === "deployment")
          root.servers = resources.map((id) => ({
            deployment: { ...deployment, id },
          }));
        if (kind === "skill")
          root.skills = resources.map((id) => ({
            installedSkill: { ...skill, id },
          }));
        if (kind === "toolkit")
          root.toolkits = resources.map((id) => ({
            toolkit: {
              id,
              workspaceId: "workspace-1",
              name: id,
              slug: id,
              enabled: true,
              servers: [],
              skills: [],
            },
          }));
        mocks.findAgent.mockResolvedValue(root);
        expect(await assessAgentPortability(input)).toMatchObject({
          portable: false,
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "graph_too_large" }),
          ]),
        });
      },
    );

    it.each(["workspace", "sandbox"])(
      "rejects Hermes runtime ownership mismatch in %s",
      async (kind) => {
        mocks.findAgent.mockResolvedValue({
          ...agent(),
          runtimeKind: "hermes",
          sandboxes: [],
          runtime: {
            id: "runtime",
            kind: "hermes",
            image: "hermes:stable",
            workspaceId: kind === "workspace" ? "foreign" : "workspace-1",
            sandbox: {
              workspaceId: kind === "sandbox" ? "foreign" : "workspace-1",
            },
          },
        });
        expect(await assessAgentPortability(input)).toMatchObject({
          portable: false,
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "invalid_definition" }),
          ]),
        });
      },
    );

    it("rejects a Hermes model provider linked from another workspace", async () => {
      mocks.findAgent.mockResolvedValue({
        ...agent(),
        runtimeKind: "hermes",
        sandboxes: [],
        runtime: {
          id: "runtime",
          kind: "hermes",
          image: "hermes:stable",
          workspaceId: "workspace-1",
          sandbox: { workspaceId: "workspace-1" },
        },
        modelProviders: [
          {
            provider: {
              id: "provider",
              format: "openai",
              workspaceId: "foreign",
            },
          },
        ],
      });
      expect(await assessAgentPortability(input)).toMatchObject({
        portable: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "cross_workspace_provider" }),
        ]),
      });
    });
  });
});
