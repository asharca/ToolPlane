// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  bindAgentWorkspaceResource,
  createAgent,
  setAgentTools,
} from "@/lib/agents/mutations";
import {
  captureAgentRevisionConfig,
  prepareAgentRevisionMcpDeployments,
} from "@/lib/agents/revisions";
import type { AgentEnvironmentSnapshot } from "@/lib/agents/revision-types";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import type * as McpRuntimeImage from "@/lib/process/mcp-runtime-image";
import { createAgentFromControl } from "@/lib/agents/control-service";

vi.mock("@/lib/process/mcp-runtime-image", async (importOriginal) => ({
  ...(await importOriginal<typeof McpRuntimeImage>()),
  prepareSessionMcpRuntimeImage: vi.fn(async () => `sha256:${"a".repeat(64)}`),
}));

afterEach(() => vi.unstubAllGlobals());

const stamp = randomUUID();
const users: string[] = [],
  workspaces: string[] = [],
  listings: string[] = [];
let workspaceId: string,
  foreignWorkspaceId: string,
  selected: string,
  other: string,
  foreignAgent: string;
let firstSkill: string,
  secondSkill: string,
  foreignSkill: string,
  firstMcp: string,
  secondMcp: string;
beforeAll(async () => {
  for (const suffix of ["own", "foreign"]) {
    const user = await db.user.create({
      data: {
        email: `resource-bind-${stamp}-${suffix}@example.invalid`,
        passwordHash: "fixture",
      },
    });
    users.push(user.id);
    const workspace = await db.workspace.create({
      data: {
        slug: `resource-bind-${stamp}-${suffix}`,
        name: "Owned resource binding fixture",
        ownerId: user.id,
      },
    });
    workspaces.push(workspace.id);
  }
  [workspaceId, foreignWorkspaceId] = workspaces;
  for (const [name, ws] of [
    ["selected", workspaceId],
    ["other", workspaceId],
    ["foreign", foreignWorkspaceId],
  ]) {
    const agent = await db.agent.create({
      data: {
        workspaceId: ws,
        slug: name,
        name,
        runtimeKind: "pi-sdk",
        systemPrompt: "Preserve this prompt",
        maxSteps: 7,
        disabledBuiltinTools: ["bash"],
      },
    });
    if (name === "selected") selected = agent.id;
    else if (name === "other") other = agent.id;
    else foreignAgent = agent.id;
  }
  const skills = [];
  for (const [name, ws] of [
    ["first", workspaceId],
    ["second", workspaceId],
    ["foreign", foreignWorkspaceId],
  ])
    skills.push(
      await db.installedSkill.create({
        data: {
          workspaceId: ws,
          name,
          slug: name,
          content: `# ${name}`,
          source: "custom",
        },
      }),
    );
  [firstSkill, secondSkill, foreignSkill] = skills.map((skill) => skill.id);
  const deployments = [];
  for (const name of ["first", "second"])
    deployments.push(
      await db.deployment.create({
        data: {
          workspaceId,
          name,
          source: "config",
          sourceRef: "docker",
          installCfg: {
            command: "docker",
            args: ["run", "owned"],
            env: { KEEP: "owned-target-value" },
          },
        },
      }),
    );
  [firstMcp, secondMcp] = deployments.map((deployment) => deployment.id);
  await db.agentSkill.create({
    data: { agentId: selected, installedSkillId: firstSkill },
  });
  await db.agentServer.create({
    data: { agentId: selected, deploymentId: firstMcp },
  });
});
afterAll(async () => {
  if (workspaces.length)
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  if (listings.length)
    await db.marketListing.deleteMany({ where: { id: { in: listings } } });
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
it("adds only the selected Agent's resource, preserving other bindings and unrelated defaults", async () => {
  await bindAgentWorkspaceResource(workspaceId, selected, {
    kind: "skill",
    id: secondSkill,
  });
  await bindAgentWorkspaceResource(workspaceId, selected, {
    kind: "mcp",
    id: secondMcp,
  });
  await bindAgentWorkspaceResource(workspaceId, selected, {
    kind: "skill",
    id: secondSkill,
  });
  const agent = await db.agent.findUniqueOrThrow({
    where: { id: selected },
    include: { skills: true, servers: true },
  });
  expect(agent).toMatchObject({
    name: "selected",
    systemPrompt: "Preserve this prompt",
    maxSteps: 7,
    disabledBuiltinTools: ["bash"],
    providerId: null,
    model: null,
  });
  expect(agent.skills.map((skill) => skill.installedSkillId).sort()).toEqual(
    [firstSkill, secondSkill].sort(),
  );
  expect(agent.servers.map((server) => server.deploymentId).sort()).toEqual(
    [firstMcp, secondMcp].sort(),
  );
  expect(await db.agentSkill.count({ where: { agentId: other } })).toBe(0);
  expect(await db.agentServer.count({ where: { agentId: other } })).toBe(0);
  expect(
    (await db.deployment.findUniqueOrThrow({ where: { id: secondMcp } }))
      .installCfg,
  ).toMatchObject({ env: { KEEP: "owned-target-value" } });
});
it("rejects a foreign Agent or resource without touching either workspace", async () => {
  await expect(
    bindAgentWorkspaceResource(workspaceId, foreignAgent, {
      kind: "skill",
      id: secondSkill,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  await expect(
    bindAgentWorkspaceResource(workspaceId, selected, {
      kind: "skill",
      id: foreignSkill,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  expect(await db.agentSkill.count({ where: { agentId: foreignAgent } })).toBe(
    0,
  );
  expect(
    await db.agentSkill.count({
      where: { agentId: selected, installedSkillId: foreignSkill },
    }),
  ).toBe(0);
});
it("binds a draft resource to a selected Agent while Work is running", async () => {
  const conversation = await db.conversation.create({
    data: { agentId: other },
  });
  await db.workSession.create({
    data: {
      workspaceId,
      agentId: other,
      conversationId: conversation.id,
      runtimeKind: "pi-sdk",
      status: "running",
    },
  });
  await bindAgentWorkspaceResource(workspaceId, other, {
    kind: "skill",
    id: firstSkill,
  });
  expect(
    await db.agentSkill.count({
      where: { agentId: other, installedSkillId: firstSkill },
    }),
  ).toBe(1);
});
it("binds retained materialized skills independently of retired marketplace metadata", async () => {
  const skill = await db.installedSkill.create({
    data: {
      workspaceId,
      name: "Retained",
      slug: "retained",
      content: "# Retained",
      source: "custom",
    },
  });
  await bindAgentWorkspaceResource(workspaceId, selected, {
    kind: "skill",
    id: skill.id,
  });
  expect(
    await db.agentSkill.count({
      where: { agentId: selected, installedSkillId: skill.id },
    }),
  ).toBe(1);
});

it("pins an existing floating npm binding before revision checksum capture", async () => {
  const registry = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": { name: "@fixture/floating-mcp", version: "1.2.3" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", registry);
  const agent = await createAgent(workspaceId, "Floating npm binding");
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Floating npm",
      source: "npm",
      sourceRef: "@fixture/floating-mcp",
      installCfg: { env: { KEEP: "preserved" }, customSetting: "preserved" },
    },
  });
  await bindAgentWorkspaceResource(workspaceId, agent.id, {
    kind: "mcp",
    id: deployment.id,
  });
  const config = await captureAgentRevisionConfig(db, agent.id, {
    kind: "docker",
    image: `fixture@sha256:${"a".repeat(64)}`,
    network: "isolated",
    piVersion: "0.87.1",
    initialSnapshot: null,
    resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
    credentialReferences: [],
  });
  const pinned = await db.deployment.findUniqueOrThrow({
    where: { id: deployment.id },
  });
  expect(pinned.sourceRef).toBe("@fixture/floating-mcp@1.2.3");
  expect(pinned.installCfg).toEqual(deployment.installCfg);
  expect(config.mcpGrants).toEqual([
    expect.objectContaining({
      deploymentId: deployment.id,
      definitionChecksum: mcpDefinitionChecksum(pinned),
      allowedToolNames: [],
    }),
  ]);
  expect(registry).toHaveBeenCalled();
});

it("returns a friendly resolution code without attaching or rewriting a failed npm recipe", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("private registry failure details")),
  );
  const agent = await createAgent(workspaceId, "Unresolvable npm binding");
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Unresolvable npm",
      source: "npm",
      sourceRef: "@fixture/missing-mcp",
      installCfg: { env: { KEEP: "preserved" } },
    },
  });
  await expect(
    bindAgentWorkspaceResource(workspaceId, agent.id, {
      kind: "mcp",
      id: deployment.id,
    }),
  ).rejects.toMatchObject({
    code: "mcpVersionResolutionFailed",
    message: "mcpVersionResolutionFailed",
  });
  expect(await db.agentServer.count({ where: { agentId: agent.id } })).toBe(0);
  expect(
    await db.deployment.findUniqueOrThrow({ where: { id: deployment.id } }),
  ).toMatchObject({
    sourceRef: deployment.sourceRef,
    installCfg: deployment.installCfg,
  });
});

it("rejects foreign MCP targets and Agents before contacting a registry", async () => {
  const registry = vi.fn();
  vi.stubGlobal("fetch", registry);
  const deployment = await db.deployment.create({
    data: {
      workspaceId: foreignWorkspaceId,
      name: "Foreign npm",
      source: "npm",
      sourceRef: "@fixture/foreign-mcp",
    },
  });
  await expect(
    bindAgentWorkspaceResource(workspaceId, selected, {
      kind: "mcp",
      id: deployment.id,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  await expect(
    bindAgentWorkspaceResource(workspaceId, foreignAgent, {
      kind: "mcp",
      id: firstMcp,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  expect(registry).not.toHaveBeenCalled();
  expect(
    (await db.deployment.findUniqueOrThrow({ where: { id: deployment.id } }))
      .sourceRef,
  ).toBe("@fixture/foreign-mcp");
});

it.each(["standalone", "prepared transaction"] as const)(
  "repairs an already attached floating deployment before %s revision capture",
  async (mode) => {
    let insideTransaction = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        expect(insideTransaction).toBe(false);
        return new Response(
          JSON.stringify({ "dist-tags": { latest: "2.3.4" } }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const agent = await createAgent(workspaceId, "Existing floating binding");
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        name: "Existing floating config",
        source: "config",
        sourceRef: "npx",
        installCfg: {
          command: "npx",
          args: ["-y", "@fixture/existing-mcp", "--port", "1234"],
          env: { KEEP: "preserved" },
          toolCatalog: [{ name: "reviewed" }],
        },
      },
    });
    await db.agentServer.create({
      data: {
        agentId: agent.id,
        deploymentId: deployment.id,
        allowedToolNames: ["reviewed"],
      },
    });
    const environment: AgentEnvironmentSnapshot = {
      kind: "docker",
      image: `fixture@sha256:${"a".repeat(64)}`,
      network: "isolated",
      piVersion: "0.87.1",
      initialSnapshot: null,
      resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
      credentialReferences: [],
    };
    if (mode === "prepared transaction")
      await prepareAgentRevisionMcpDeployments(workspaceId, agent.id);
    const config =
      mode === "standalone"
        ? await captureAgentRevisionConfig(db, agent.id, environment)
        : await db.$transaction(async (tx) => {
            insideTransaction = true;
            try {
              return await captureAgentRevisionConfig(
                tx,
                agent.id,
                environment,
              );
            } finally {
              insideTransaction = false;
            }
          });
    const pinned = await db.deployment.findUniqueOrThrow({
      where: { id: deployment.id },
    });
    expect(pinned.installCfg).toEqual({
      command: "npx",
      args: ["-y", "@fixture/existing-mcp@2.3.4", "--port", "1234"],
      env: { KEEP: "preserved" },
      toolCatalog: [{ name: "reviewed" }],
    });
    expect(config.mcpGrants).toEqual([
      expect.objectContaining({
        deploymentId: deployment.id,
        definitionChecksum: mcpDefinitionChecksum(pinned),
        allowedToolNames: ["reviewed"],
      }),
    ]);
  },
);

it("returns a friendly control error when an existing MCP dependency cannot be pinned", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("private upstream details")),
  );
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Unavailable control MCP",
      source: "npm",
      sourceRef: "@fixture/control-mcp",
    },
  });
  const before = await db.agent.count({ where: { workspaceId } });
  await expect(
    createAgentFromControl(workspaceId, `resource-bind-${stamp}-own`, {
      name: "Unresolvable control binding",
      runtime: "pi-sdk",
      maxSteps: 7,
      deploymentIds: [deployment.id],
      installedSkillIds: [],
      toolkitIds: [],
      externalSandboxes: [],
    }),
  ).rejects.toMatchObject({
    code: "unavailable",
    message: "mcpVersionResolutionFailed",
  });
  expect(await db.agent.count({ where: { workspaceId } })).toBe(before);
});

it("materializes the full catalog whenever a deployment is bound", async () => {
  const agent = await createAgent(workspaceId, "MCP selection regression");
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: "Selection catalog",
      source: "remote",
      sourceRef: "https://selection.test.invalid/mcp",
      installCfg: {
        transport: "streamable-http",
        authType: "none",
        toolCatalog: [{ name: "read" }, { name: "write" }],
      },
    },
  });
  const tools = {
    deploymentIds: [deployment.id],
    installedSkillIds: [],
    toolkitIds: [],
  };
  const binding = () =>
    db.agentServer.findUniqueOrThrow({
      where: {
        agentId_deploymentId: {
          agentId: agent.id,
          deploymentId: deployment.id,
        },
      },
    });
  await setAgentTools(workspaceId, agent.id, tools);
  expect(await binding()).toMatchObject({
    allowedToolNames: ["read", "write"],
  });
  await db.agentServer.update({
    where: {
      agentId_deploymentId: { agentId: agent.id, deploymentId: deployment.id },
    },
    data: { allowedToolNames: ["write"] },
  });
  await setAgentTools(workspaceId, agent.id, tools);
  expect(await binding()).toMatchObject({
    allowedToolNames: ["read", "write"],
  });
});
