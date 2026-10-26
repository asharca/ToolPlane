// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  hashAgentApiSubject,
  type AgentApiPrincipal,
} from "@/lib/agents/public-api/auth";
import {
  prepareAgentResponse,
  executePreparedAgentResponse,
  getAgentResponseForPrincipal,
} from "@/lib/agents/public-api/runs";
import { activeAgentApiRunCount } from "@/lib/agents/public-api/run-control";
let userId: string,
  workspaceId: string,
  endpointId: string,
  endpointPublicId: string,
  revisionId: string,
  clientId: string,
  allocationId: string;
let principal: AgentApiPrincipal;
beforeAll(async () => {
  process.env.AUTH_SECRET = "agent-public-runs-integration-secret";
  const suffix = randomUUID();
  const user = await db.user.create({
    data: { email: `agent-runs-${suffix}@test.invalid`, passwordHash: "x" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `agent-runs-${suffix}`, name: "Runs", ownerId: userId },
  });
  workspaceId = workspace.id;
  const source = await db.agent.create({
    data: {
      workspaceId,
      name: "Source",
      slug: "source",
      runtimeKind: "pi-sdk",
    },
  });
  const hidden = await db.agent.create({
    data: {
      workspaceId,
      name: "Historical allocation",
      slug: "historical",
      runtimeKind: "pi-sdk",
    },
  });
  const endpoint = await db.agentEndpoint.create({
    data: {
      publicId: `agep_${suffix.replaceAll("-", "")}`,
      workspaceId,
      sourceAgentId: source.id,
      createdById: userId,
      name: "Runs API",
      status: "active",
      rpmLimit: 1000,
      dailyRequestLimit: 10000,
      maxConcurrent: 10,
      timeoutSeconds: 60,
    },
  });
  endpointId = endpoint.id;
  endpointPublicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId,
      version: 1,
      systemPrompt: "Historical public manifest",
      runtimeImage: "historical-runtime-image",
      toolPolicy: {},
    },
  });
  revisionId = revision.id;
  await db.agentEndpoint.update({
    where: { id: endpointId },
    data: { currentRevisionId: revisionId },
  });
  const client = await db.agentApiClient.create({
    data: {
      endpointId,
      name: "Runs client",
      rpmLimit: 1000,
      dailyRequestLimit: 10000,
      maxConcurrent: 10,
    },
  });
  clientId = client.id;
  const allocation = await db.agentEndpointRuntime.create({
    data: {
      endpointId,
      revisionId,
      subjectHash: hashAgentApiSubject(endpointId, clientId, "subject-a"),
      runtimeAgentId: hidden.id,
      status: "ready",
    },
  });
  allocationId = allocation.id;
  principal = {
    credentialType: "api_key",
    endpointId,
    endpointPublicId,
    workspaceId,
    sourceAgentId: source.id,
    revisionId,
    clientId,
    keyId: "key-1",
    subjectHash: null,
    origin: null,
    scopes: ["responses:create", "responses:read"],
    limits: {
      rpm: 1000,
      dailyRequests: 10000,
      maxConcurrent: 10,
      timeoutSeconds: 60,
      retentionDays: 30,
    },
    rateBuckets: {
      endpointRpm: 1000,
      clientRpm: 1000,
      endpointDaily: 10000,
      clientDaily: 10000,
    },
  };
});
afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
function prepare(
  overrides: Partial<Parameters<typeof prepareAgentResponse>[0]> = {},
) {
  return prepareAgentResponse({
    principal,
    input: "hello",
    endUser: "subject-a",
    stream: false,
    ...overrides,
  });
}
async function historicalRun(key: string) {
  const subjectHash = hashAgentApiSubject(endpointId, clientId, "subject-a");
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        input: "hello",
        conversation_id: null,
        subject_hash: subjectHash,
        metadata: {},
      }),
    )
    .digest("hex");
  return db.agentRun.create({
    data: {
      publicId: `resp_${randomUUID().replaceAll("-", "")}`,
      requestId: randomUUID(),
      endpointId,
      revisionId,
      runtimeAllocationId: allocationId,
      clientId,
      subjectHash,
      idempotencyKey: key,
      requestHash,
      status: "completed",
      inputCharacters: 5,
      outputCharacters: 6,
      outputText: "Answer",
      completedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60000),
    },
  });
}
describe("Agent API unsupported admission and retained history", () => {
  it("rejects concurrent new requests without allocating execution or reserving a run", async () => {
    const key = randomUUID();
    const results = await Promise.allSettled([
      prepare({ idempotencyKey: key }),
      prepare({ idempotencyKey: key }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          code: "runtime_unsupported",
          status: 409,
        }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          code: "runtime_unsupported",
          status: 409,
        }),
      }),
    ]);
    expect(
      await db.agentRun.count({ where: { clientId, idempotencyKey: key } }),
    ).toBe(0);
    expect(await db.agentEndpointRuntime.count({ where: { endpointId } })).toBe(
      1,
    );
    expect(activeAgentApiRunCount()).toBe(0);
  });
  it("keeps matching historical idempotent responses readable without executing", async () => {
    const key = randomUUID();
    const stored = await historicalRun(key);
    const prepared = await prepare({ idempotencyKey: key });
    expect(prepared).toMatchObject({ replay: true, runId: stored.id });
    expect(await executePreparedAgentResponse(prepared)).toMatchObject({
      id: stored.publicId,
      output_text: "Answer",
      status: "completed",
    });
    expect(
      await db.agentRun.count({ where: { clientId, idempotencyKey: key } }),
    ).toBe(1);
  });
  it("does not permit changing historical idempotent input", async () => {
    const key = randomUUID();
    await historicalRun(key);
    await expect(
      prepare({ idempotencyKey: key, input: "different" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });
  it("retains subject isolation when reading historical responses", async () => {
    const stored = await historicalRun(randomUUID());
    const scope = {
      endpointPublicId,
      responseId: stored.publicId,
      clientId,
      subjectHash: stored.subjectHash,
    };
    expect(await getAgentResponseForPrincipal(scope)).toMatchObject({
      output_text: "Answer",
    });
    expect(
      await getAgentResponseForPrincipal({
        ...scope,
        subjectHash: hashAgentApiSubject(endpointId, clientId, "other"),
      }),
    ).toBeNull();
  });
});
