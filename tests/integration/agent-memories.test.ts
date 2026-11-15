// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { handleAgentMemories } from "@/lib/agents/memories-api";
import { recallAgentMemories, retainAgentMemory } from "@/lib/agents/memories";

let owner = "";
let outsider = "";
let workspace = "";
let otherWorkspace = "";
let slug = "";
let otherSlug = "";
let agent = "";
let sibling = "";
let foreignAgent = "";
let token = "";
let outsiderToken = "";

beforeAll(async () => {
  const stamp = randomUUID();
  owner = (await db.user.create({ data: { email: `memory-owner-${stamp}@test.invalid`, passwordHash: "fixture" } })).id;
  outsider = (await db.user.create({ data: { email: `memory-outsider-${stamp}@test.invalid`, passwordHash: "fixture" } })).id;
  slug = `memory-${stamp}`;
  otherSlug = `other-memory-${stamp}`;
  workspace = (await db.workspace.create({ data: { ownerId: owner, name: "Memories", slug } })).id;
  otherWorkspace = (await db.workspace.create({ data: { ownerId: owner, name: "Other", slug: otherSlug } })).id;
  agent = (await db.agent.create({ data: { workspaceId: workspace, name: "Memory owner", slug: "owner", runtimeKind: "pi-sdk" } })).id;
  sibling = (await db.agent.create({ data: { workspaceId: workspace, name: "Sibling", slug: "sibling", runtimeKind: "pi-sdk" } })).id;
  foreignAgent = (await db.agent.create({ data: { workspaceId: otherWorkspace, name: "Foreign", slug: "foreign", runtimeKind: "pi-sdk" } })).id;
  token = (await createApiToken(owner, "memory integration")).token;
  outsiderToken = (await createApiToken(outsider, "memory outsider")).token;
});
beforeEach(async () => {
  await db.agentMemory.deleteMany({ where: { workspaceId: { in: [workspace, otherWorkspace] } } });
});
afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspace, otherWorkspace] } } });
  await db.user.deleteMany({ where: { id: { in: [owner, outsider] } } });
});

async function api(method: string, agentId = agent, memoryId?: string, body?: unknown, accessToken = token, workspaceSlug = slug, query?: string) {
  const url = new URL(`https://toolplane.test/api/v1/agents/${agentId}/memories${memoryId ? `/${memoryId}` : ""}`);
  url.searchParams.set("workspace", workspaceSlug);
  if (query !== undefined) url.searchParams.set("query", query);
  return handleAgentMemories(new Request(url, {
    method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { params: Promise.resolve({ agentId, memoryId }) });
}

describe("Agent-scoped memories", () => {
  it("retains immediately, ranks literal matches and stops recalling after deletion", async () => {
    const saved = await api("POST", agent, undefined, { workspace: slug, content: "部署使用 bluebird，先检查 readiness。" });
    expect(saved.status).toBe(201);
    const { memory } = await saved.json();
    expect(memory).toMatchObject({ workspaceId: workspace, agentId: agent, creatorType: "user", conversationId: null, taskId: null });
    const recalled = await db.$transaction((tx) => recallAgentMemories(tx, { workspaceId: workspace, agentId: agent }, { query: "bluebird" }));
    expect(recalled.notice).toContain("UNTRUSTED HISTORICAL MEMORIES");
    expect(recalled.memories.map((item) => item.id)).toEqual([memory.id]);
    expect((await api("DELETE", agent, memory.id)).status).toBe(200);
    expect((await (await api("GET", agent, undefined, undefined, token, slug, "bluebird")).json()).memories).toEqual([]);
  });

  it("rejects cross-Agent and cross-workspace list/write/delete, and nonmembers", async () => {
    const { memory } = await (await api("POST", agent, undefined, { workspace: slug, content: "isolation sentinel" })).json();
    expect((await (await api("GET", sibling)).json()).memories).toEqual([]);
    expect((await (await api("GET", foreignAgent, undefined, undefined, token, otherSlug)).json()).memories).toEqual([]);
    expect((await api("DELETE", sibling, memory.id)).status).toBe(404);
    expect((await api("DELETE", foreignAgent, memory.id, undefined, token, otherSlug)).status).toBe(404);
    expect((await api("GET", foreignAgent)).status).toBe(404);
    expect((await api("POST", foreignAgent, undefined, { workspace: slug, content: "not allowed" })).status).toBe(404);
    expect((await api("DELETE", foreignAgent, memory.id)).status).toBe(404);
    expect((await api("GET", agent, undefined, undefined, outsiderToken)).status).toBe(404);
    expect((await api("GET", agent, undefined, undefined, "invalid-token")).status).toBe(401);
    expect(await db.agentMemory.count({ where: { id: memory.id } })).toBe(1);
  });

  it("rejects credentials and oversized content, and treats LIKE wildcards as literal data", async () => {
    const rejected = await api("POST", agent, undefined, { workspace: slug, content: `sk-${"a".repeat(24)}` });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "AGENT_MEMORY_SECRET_DETECTED" });
    expect((await api("POST", agent, undefined, { workspace: slug, content: "a".repeat(2001) })).status).toBe(400);
    expect(await db.agentMemory.count({ where: { agentId: agent } })).toBe(0);
    await api("POST", agent, undefined, { workspace: slug, content: "literal 100%_coverage" });
    await api("POST", agent, undefined, { workspace: slug, content: "unrelated data" });
    const result = await (await api("GET", agent, undefined, undefined, token, slug, "%_")).json();
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].content).toBe("literal 100%_coverage");
  });

  it("enforces 500 memories across simultaneous tool and settings writers and frees capacity on delete", async () => {
    await db.agentMemory.createMany({ data: Array.from({ length: 499 }, (_, index) => ({ workspaceId: workspace, agentId: agent, content: `Existing ${index}`, creatorType: "user" })) });
    const scope = { workspaceId: workspace, agentId: agent };
    const results = await Promise.allSettled([
      db.$transaction((tx) => retainAgentMemory(tx, scope, "tool fact", { creatorType: "tool" })),
      db.$transaction((tx) => retainAgentMemory(tx, scope, "user fact", { creatorType: "user" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { reason: "AGENT_MEMORY_LIMIT_REACHED" } });
    const full = await api("POST", agent, undefined, { workspace: slug, content: "one too many" });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "AGENT_MEMORY_LIMIT_REACHED" });
    const memory = await db.agentMemory.findFirstOrThrow({ where: scope });
    expect((await api("DELETE", agent, memory.id)).status).toBe(200);
    expect((await api("POST", agent, undefined, { workspace: slug, content: "capacity reclaimed" })).status).toBe(201);
  });
});

it("lets workspace members manage memories without enabling execution tools or publishing a revision", async () => {
  await db.membership.create({ data: { workspaceId: workspace, userId: outsider, role: "member" } });
  try {
    const before = await db.agent.findUniqueOrThrow({ where: { id: agent } });
    const saved = await api("POST", agent, undefined, { workspace: slug, content: "member-managed historical context" }, outsiderToken);
    expect(saved.status).toBe(201);
    const { memory } = await saved.json();
    expect((await api("DELETE", agent, memory.id, undefined, outsiderToken)).status).toBe(200);
    const after = await db.agent.findUniqueOrThrow({ where: { id: agent } });
    expect(after.currentRevisionVersion).toBe(before.currentRevisionVersion);
    expect(after.optionalBuiltinTools).toEqual([]);
  } finally {
    await db.membership.deleteMany({ where: { workspaceId: workspace, userId: outsider } });
  }
});
