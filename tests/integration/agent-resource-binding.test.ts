// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { bindAgentWorkspaceResource } from "@/lib/agents/mutations";

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
it("does not mutate a selected Agent while Work is waiting for approval", async () => {
  const conversation = await db.conversation.create({
    data: { agentId: other },
  });
  const work = await db.workSession.create({
    data: {
      workspaceId,
      agentId: other,
      conversationId: conversation.id,
      runtimeKind: "pi-sdk",
      status: "waiting_approval",
    },
  });
  await expect(
    bindAgentWorkspaceResource(workspaceId, other, {
      kind: "skill",
      id: firstSkill,
    }),
  ).rejects.toThrow("resource_binding_busy");
  expect(await db.agentSkill.count({ where: { agentId: other } })).toBe(0);
  await db.workSession.update({
    where: { id: work.id },
    data: { status: "completed" },
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
it("revalidates market approval and private ownership before adding a binding", async () => {
  const listing = await db.marketListing.create({
    data: {
      namespace: stamp,
      slug: "reviewed",
      kind: "skill",
      name: "Reviewed resource",
      metadata: {},
      status: "published",
      publisherWorkspaceId: workspaceId,
    },
  });
  listings.push(listing.id);
  const release = await db.marketRelease.create({
    data: {
      listingId: listing.id,
      version: 1,
      checksum: "fixture",
      manifest: {},
      releaseSummary: {},
      reviewStatus: "approved",
    },
  });
  await db.marketListing.update({
    where: { id: listing.id },
    data: { latestReleaseId: release.id },
  });
  const skill = await db.installedSkill.create({
    data: {
      workspaceId,
      name: "Reviewed",
      slug: "reviewed",
      content: "# Reviewed",
      source: "custom",
    },
  });
  await db.marketInstall.create({
    data: {
      listingId: listing.id,
      targetWorkspaceId: workspaceId,
      installedSkillId: skill.id,
      currentReleaseId: release.id,
      requestedReleaseId: release.id,
      idempotencyKey: stamp,
      status: "ready",
      resourceMap: { kind: "skill" },
    },
  });
  await db.marketRelease.update({
    where: { id: release.id },
    data: { reviewStatus: "rejected" },
  });
  await expect(
    bindAgentWorkspaceResource(workspaceId, selected, {
      kind: "skill",
      id: skill.id,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  await db.marketRelease.update({
    where: { id: release.id },
    data: { reviewStatus: "approved" },
  });
  await db.marketListing.update({
    where: { id: listing.id },
    data: { visibility: "private", publisherWorkspaceId: foreignWorkspaceId },
  });
  await expect(
    bindAgentWorkspaceResource(workspaceId, selected, {
      kind: "skill",
      id: skill.id,
    }),
  ).rejects.toThrow("resource_binding_unavailable");
  expect(
    await db.agentSkill.count({
      where: { agentId: selected, installedSkillId: skill.id },
    }),
  ).toBe(0);
});
