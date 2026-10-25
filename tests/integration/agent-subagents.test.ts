// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { createAgent, setAgentTools } from "@/lib/agents/mutations";

let userId = "";
let otherUserId = "";
let workspaceId = "";
let otherWorkspaceId = "";
let parentId = "";
let childId = "";
let crossId = "";

const stamp = Date.now();
const noTools = { deploymentIds: [], installedSkillIds: [], toolkitIds: [] };

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `sa-${stamp}@test.dev`, passwordHash: "x" },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: {
      slug: `sa-${stamp}`,
      name: "SA",
      ownerId: userId,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = ws.id;

  const other = await db.user.create({
    data: { email: `sa-other-${stamp}@test.dev`, passwordHash: "x" },
  });
  otherUserId = other.id;
  const otherWs = await db.workspace.create({
    data: {
      slug: `sa-other-${stamp}`,
      name: "Other",
      ownerId: otherUserId,
      members: { create: { userId: otherUserId, role: "owner" } },
    },
  });
  otherWorkspaceId = otherWs.id;

  const parent = await createAgent(workspaceId, "Parent", {
    runtime: "pi-sdk",
  });
  const child = await createAgent(workspaceId, "Child", { runtime: "pi-sdk" });
  const cross = await createAgent(otherWorkspaceId, "Cross", {
    runtime: "pi-sdk",
  });
  parentId = parent.id;
  childId = child.id;
  crossId = cross.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.workspace.delete({ where: { id: otherWorkspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.user.delete({ where: { id: otherUserId } });
  await db.$disconnect();
});

describe("setAgentTools sub-agents", () => {
  it("persists same-workspace links and drops self + cross-workspace", async () => {
    await setAgentTools(workspaceId, parentId, {
      ...noTools,
      subAgentIds: [childId, parentId, crossId],
    });
    const links = await db.agentSubAgent.findMany({ where: { parentId } });
    expect(links.map((l) => l.childId)).toEqual([childId]);
  });

  it("replaces links on re-save (empty clears)", async () => {
    await setAgentTools(workspaceId, parentId, {
      ...noTools,
      subAgentIds: [childId],
    });
    await expect(
      db.agentSubAgent.findMany({ where: { parentId } }),
    ).resolves.toMatchObject([{ childId }]);
    await setAgentTools(workspaceId, parentId, {
      ...noTools,
      subAgentIds: [],
    });
    const links = await db.agentSubAgent.findMany({ where: { parentId } });
    expect(links).toHaveLength(0);
  });
});
