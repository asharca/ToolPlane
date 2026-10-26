// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import { getAgentResponseForPrincipal } from "@/lib/agents/public-api/runs";
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (
    _route: string,
    handler: (request: Request) => Promise<Response>,
  ) => handler,
}));
import { POST as retiredResponse } from "@/app/api/v1/agent-endpoints/[endpointId]/responses/route";
import { POST as retiredCompletion } from "@/app/api/openai/v1/chat/completions/route";

let userId = "";
let workspaceId = "";
let principal: AgentApiPrincipal;
let responseId = "";

beforeAll(async () => {
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: { email: `retired-runs-${suffix}@test.dev`, passwordHash: "x" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `retired-runs-${suffix}`,
      name: "Retired runs",
      ownerId: userId,
    },
  });
  workspaceId = workspace.id;
  const source = await db.agent.create({
    data: {
      workspaceId,
      name: "Historical",
      slug: `historical-${suffix}`,
      runtimeKind: "claude-code",
    },
  });
  const endpoint = await db.agentEndpoint.create({
    data: {
      publicId: `agep_${suffix.replaceAll("-", "")}`,
      workspaceId,
      sourceAgentId: source.id,
      createdById: userId,
      name: "Historical endpoint",
      status: "active",
    },
  });
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId: endpoint.id,
      version: 1,
      systemPrompt: "Historical",
      runtimeImage: "historical-claude-code:retired",
      toolPolicy: {},
    },
  });
  const client = await db.agentApiClient.create({
    data: { endpointId: endpoint.id, name: "Historical client" },
  });
  principal = {
    credentialType: "api_key",
    endpointId: endpoint.id,
    endpointPublicId: endpoint.publicId,
    workspaceId,
    sourceAgentId: source.id,
    revisionId: revision.id,
    clientId: client.id,
    keyId: "historical-key",
    subjectHash: null,
    origin: null,
    scopes: ["responses:create"],
    limits: {
      rpm: 100,
      dailyRequests: 100,
      maxConcurrent: 1,
      timeoutSeconds: 60,
      retentionDays: 30,
    },
    rateBuckets: {
      endpointRpm: 100,
      clientRpm: 100,
      endpointDaily: 100,
      clientDaily: 100,
    },
  };
  responseId = `ares_${suffix.replaceAll("-", "")}`;
  await db.agentRun.create({
    data: {
      publicId: responseId,
      requestId: `areq_${suffix.replaceAll("-", "")}`,
      endpointId: endpoint.id,
      revisionId: revision.id,
      clientId: client.id,
      subjectHash: "historical-subject",
      requestHash: "historical-request",
      status: "completed",
      inputCharacters: 5,
      outputCharacters: 16,
      outputText: "Preserved answer",
      deadlineAt: new Date(),
      completedAt: new Date(),
    },
  });
});

afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe("retired public Agent execution", () => {
  it("rejects admission without reserving runs or runtime allocations", async () => {
    const before = await db.agentRun.count({
      where: { endpointId: principal.endpointId },
    });
    const response = await retiredResponse(
      new Request(
        `http://localhost/api/v1/agent-endpoints/${principal.endpointPublicId}/responses`,
        {
          method: "POST",
          body: JSON.stringify({
            input: "hello",
            end_user: "subject",
            stream: false,
          }),
        },
      ),
    );
    expect(response.status).toBe(410);
    expect(
      await db.agentRun.count({ where: { endpointId: principal.endpointId } }),
    ).toBe(before);
    expect(
      await db.agentEndpointRuntime.count({
        where: { endpointId: principal.endpointId },
      }),
    ).toBe(0);
  });

  it("cannot materialize a Hermes runtime through the old OpenAI endpoint", async () => {
    const response = await retiredCompletion(
      new Request("http://localhost/api/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: principal.endpointPublicId,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    expect(response.status).toBe(410);
    expect(
      await db.agentEndpointRuntime.count({
        where: { endpointId: principal.endpointId },
      }),
    ).toBe(0);
  });

  it("retains historical response reads scoped to the original client", async () => {
    const lookup = {
      endpointPublicId: principal.endpointPublicId,
      responseId,
      clientId: principal.clientId,
    };
    expect(await getAgentResponseForPrincipal(lookup)).toMatchObject({
      status: "completed",
      output_text: "Preserved answer",
    });
    expect(
      await getAgentResponseForPrincipal({
        ...lookup,
        clientId: "another-client",
      }),
    ).toBeNull();
  });
});
