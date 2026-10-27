// @vitest-environment node
import { assertDefined } from "../assert-defined";
// Requires real disposable PostgreSQL with current migrations. No paid model is used.
// Requests use real HTTP sockets and the official MCP/A2A SDK codecs.
// Run serially: pnpm vitest run tests/integration/pi-agent-communication.test.ts
import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AgentCard,
  SendMessageRequest,
  GetTaskRequest,
  CancelTaskRequest,
  TaskState,
  Task,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { A2ATask } from "@prisma/client";
import type * as RemoteNetwork from "@/lib/a2a/remote-network";
import type { A2ALogBinding } from "@/lib/observability/a2a-log";
import type * as Worker from "@/lib/a2a/worker";
import type {
  HttpFixture,
  RemotePeerFixture,
} from "../fixtures/pi-agent-communication";
import { db } from "@/lib/db";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { createApiToken } from "@/lib/auth/tokens";
import { createAgentRuntimeToken } from "@/lib/agents/runtime-access";
import type { AgentRuntimeTokenPayload } from "@/lib/agents/runtime-access";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";
import { withAgentExecutionLease } from "@/lib/agents/agent-execution-gate";
import { handleLocalMcp } from "@/lib/a2a/local-mcp";
import { handleRuntimeApprovals } from "@/lib/a2a/approval-http";
import { LOCAL_LIMITS } from "@/lib/a2a/local-policy";
import { submitNativeEntry } from "@/lib/a2a/ingress";
import { claimTask as claimStoredTask, finishTask } from "@/lib/a2a/store";
import { executeA2ATask, stopA2AWorker } from "@/lib/a2a/worker";
import { reconcileRemoteTasks } from "@/lib/a2a/remote-executor";
import { mutateRemoteRegistry } from "@/lib/a2a/remote-registry";
import { validateRemoteResponse } from "@/lib/a2a/remote-wire";
import {
  GET as inboundGet,
  POST as inboundPost,
} from "@/app/api/v1/workspaces/[slug]/agents/[agentId]/a2a/local/route";
import { REMOTE_CARD, REMOTE_RPC, remoteCard } from "../fixtures/a2a-remote";
import {
  httpFixture,
  remotePeerFixture,
} from "../fixtures/pi-agent-communication";
import {
  assertMappedDeployment,
  assertMappedVolume,
  mapTaskSandbox,
  taskSandbox,
} from "./task-sandbox-fixture";
import type * as SandboxRuntime from "@/lib/sandboxes/runtime";
import type * as ProcessSupervisor from "@/lib/process/supervisor";

const routing = vi.hoisted(() => ({ peerBase: "" }));
// Only DNS/TLS routing is replaced: requests cross a real socket and both ends use official SDK codecs.
// SSRF/DNS/redirect behavior remains covered by a2a-remote-network.test.ts, not claimed by this fixture.
vi.mock("@/lib/a2a/remote-network", async (original) => ({
  ...(await original<typeof RemoteNetwork>()),
  fetchRemoteJson: async () => fetch(`${routing.peerBase}/card`),
  remoteRpcFetch:
    (url: string, token: string | undefined, _binding: A2ALogBinding) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(url);
      const headers = new Headers(request.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      const body = await request.text();
      const response = await fetch(`${routing.peerBase}/a2a`, {
        method: request.method,
        headers,
        body,
        redirect: "error",
        signal: request.signal,
      });
      if (response.ok) {
        validateRemoteResponse(JSON.parse(body), await response.clone().json());
      }
      return response;
    },
}));
// Deterministic scheduling only: SDK communication crosses the real protocol and authorization boundary.
vi.mock("@/lib/a2a/worker", async (original) => ({
  ...(await original<typeof Worker>()),
  wakeA2AWorker: vi.fn(),
}));
// Only Docker provisioning is injected; persisted mappings and authorization remain real.
vi.mock("@/lib/sandboxes/runtime", async (original) => {
  const runtime = await original<typeof SandboxRuntime>();
  return {
    ...runtime,
    assertDockerVolumeExists: vi.fn(async (name: string) =>
      assertMappedVolume(name, runtime.sandboxVolumeName),
    ),
  };
});
vi.mock("@/lib/process/supervisor", async (original) => ({
  ...(await original<typeof ProcessSupervisor>()),
  startProcess: vi.fn((id: string) => assertMappedDeployment(id)),
}));

async function claimTask(id: string) {
  const row = await claimStoredTask(id);
  if (row) await mapTaskSandbox(row);
  return row;
}

let workspaceId: string,
  foreignWorkspaceId: string,
  slug: string,
  foreignSlug: string;
let actorId: string, otherActorId: string, providerId: string, remoteId: string;
let personalToken: string, otherPersonalToken: string, toolkitToken: string;
const agents: string[] = [],
  templateSandboxes: string[] = [],
  tokens: string[] = [];
const clients: Client[] = [];
let platform: HttpFixture;
let peer: RemotePeerFixture;
const inboundResponses: Array<{ status: number; body: string }> = [];
const rawNames = [
  "pi_a2a_peers",
  "pi_a2a_submit",
  "pi_a2a_status",
  "pi_a2a_cancel",
];
const legacyNames = [
  "a2a_list_agents",
  "a2a_list_remote_agents",
  "a2a_send_message",
  "a2a_send_remote_message",
  "a2a_get_task",
  "a2a_cancel_task",
  "a2a_await_tasks",
  "a2a_request_input",
  "a2a_publish_artifact",
];
const request = (text = "Controlled delegation", messageId = randomUUID()) =>
  SendMessageRequest.fromJSON({
    message: { messageId, role: "ROLE_USER", parts: [{ text }] },
    configuration: { returnImmediately: true },
  });

function assertNoSecrets(value: unknown, extra: string[] = []) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    ...tokens,
    personalToken,
    otherPersonalToken,
    toolkitToken,
    "private-provider-secret",
    "shared-peer-credential",
    ...extra,
  ].filter(Boolean))
    expect(serialized).not.toContain(secret);
}
async function root(index = 0, actor = actorId) {
  const revision = await db.$transaction((tx) =>
    requireAgentRevision(tx, agents[index]),
  );
  const conversation = await db.conversation.create({
    data: {
      agentId: agents[index],
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    },
  });
  const accepted = await submitNativeEntry(
    {
      kind: "chat",
      sourceId: conversation.id,
      workspaceId,
      agentId: agents[index],
      actorId: actor,
      messageId: randomUUID(),
      text: "Controlled delegation",
    },
    vi.fn(),
  );
  const row = await claimTask(accepted.row.id);
  if (!row) throw new Error("Could not claim test root");
  return row;
}
async function payload(
  row: A2ATask,
  index = 0,
): Promise<AgentRuntimeTokenPayload> {
  const context = await db.a2AContext.findUniqueOrThrow({
    where: { id: row.contextId },
  });
  return {
    workspaceId,
    agentId: agents[index],
    agentRevisionId: assertDefined(context.agentRevisionId),
    ...taskSandbox(row),
    providerId,
    deploymentIds: [],
    a2aTaskId: row.id,
    a2aContextId: row.contextId,
    a2aLeaseToken: assertDefined(row.leaseToken),
    a2aApprovalRequired: true,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}
async function credential(row: A2ATask, index = 0, ready = true) {
  const token = await createAgentRuntimeToken(await payload(row, index));
  tokens.push(token);
  if (ready) {
    const response = await fetch(
      `${platform.base}/api/v1/agent-runtime/a2a/${row.id}/approvals`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "ready" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  }
  return token;
}
async function connect(row: A2ATask, index = 0, token?: string) {
  const client = new Client({
    name: "native-communication-verification",
    version: "1",
  });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${platform.base}/api/v1/agent-runtime/a2a/${row.id}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${token ?? (await credential(row, index))}`,
          },
        },
      },
    ),
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  assertNoSecrets(result);
  expect(result.isError, JSON.stringify(result)).toBe(false);
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(
    content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ) as {
    taskId: string;
    task: { id: string; status: { state: string }; artifacts?: unknown[] };
    peers: Array<{ target: string }>;
  };
}
async function rejected(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  assertNoSecrets(result);
}
async function delegate(
  client: Client,
  index = 1,
  messageId = randomUUID(),
  message = "Return a marker",
) {
  const result = await call(client, "pi_a2a_submit", {
    target: `agent:${agents[index]}`,
    message,
    messageId,
  });
  expect(result.taskId).toEqual(expect.any(String));
  return result.taskId;
}
async function remoteSubmit(client: Client, messageId = randomUUID()) {
  return (
    await call(client, "pi_a2a_submit", {
      target: `remote:${remoteId}`,
      message: "Review only the supplied public text",
      messageId,
    })
  ).taskId;
}
async function inboundClient(
  token: string,
  selectedSlug = slug,
  headers: Record<string, string> = {},
) {
  const card = remoteCard();
  card.supportedInterfaces[0].url = `${platform.base}/api/v1/workspaces/${selectedSlug}/agents/${agents[0]}/a2a/local`;
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl: async (input, init) => {
          const outgoing = new Headers(init?.headers);
          if (token) outgoing.set("authorization", `Bearer ${token}`);
          for (const [key, value] of Object.entries(headers))
            outgoing.set(key, value);
          return fetch(input, { ...init, headers: outgoing });
        },
      }),
    ],
  }).createFromAgentCard(AgentCard.fromJSON(card));
}

beforeAll(async () => {
  if (process.env.TOOLPLANE_TEST_PGLITE === "1")
    throw new Error(
      "This suite requires real PostgreSQL; PGlite is not an acceptable substitute.",
    );
  const database = new URL(process.env.DATABASE_URL ?? "missing:");
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    !(
      /test|disposable/i.test(database.pathname) ||
      database.pathname === "/toolplane_pi_harness_20260927"
    )
  )
    throw new Error(
      "DATABASE_URL must name a disposable local PostgreSQL test database.",
    );
  vi.stubEnv(
    "AUTH_SECRET",
    process.env.AUTH_SECRET || "pi-communication-disposable-test-secret",
  );
  vi.stubEnv(
    "TOOLPLANE_A2A_REMOTE_ORIGINS",
    JSON.stringify(["https://agent.example"]),
  );
  peer = await remotePeerFixture();
  routing.peerBase = peer.base;
  const stamp = randomUUID();
  actorId = (
    await db.user.create({
      data: {
        email: `pi-comm-${stamp}@test.invalid`,
        passwordHash: "test-only",
      },
    })
  ).id;
  otherActorId = (
    await db.user.create({
      data: {
        email: `pi-comm-other-${stamp}@test.invalid`,
        passwordHash: "test-only",
      },
    })
  ).id;
  slug = `pi-comm-${stamp}`;
  foreignSlug = `pi-comm-foreign-${stamp}`;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug,
        name: "Native communication fixture",
        ownerId: actorId,
        members: { create: { userId: otherActorId, role: "member" } },
      },
    })
  ).id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: foreignSlug,
        name: "Foreign fixture",
        ownerId: otherActorId,
      },
    })
  ).id;
  for (let index = 0; index < 6; index++) {
    const workspace = index === 5 ? foreignWorkspaceId : workspaceId;
    const provider =
      index === 0 || index === 5
        ? await db.modelProvider.create({
            data: {
              workspaceId: workspace,
              name: "Controlled HTTP fixture",
              format: "openai",
              baseUrl: "https://controlled.invalid",
              apiKey: "private-provider-secret",
            },
          })
        : { id: providerId };
    if (index === 0) providerId = provider.id;
    const deployment = await db.deployment.create({
      data: {
        workspaceId: workspace,
        name: `Fixture ${index}`,
        source: "config",
      },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: workspace,
        deploymentId: deployment.id,
        name: `Fixture ${index}`,
        slug: `s-${index}`,
        kind: "docker",
        network: "isolated",
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace,
        name: `Agent ${index}`,
        slug: `a-${index}`,
        runtimeKind: "pi-sdk",
        providerId: provider.id,
        model: "controlled",
        a2aInternalEnabled: true,
        a2aInboundEnabled: true,
        a2aOutboundEnabled: true,
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    agents.push(agent.id);
    templateSandboxes.push(sandbox.id);
  }
  personalToken = (await createApiToken(actorId, "Communication test personal"))
    .token;
  otherPersonalToken = (
    await createApiToken(otherActorId, "Communication test other")
  ).token;
  const toolkit = await db.toolkit.create({
    data: { workspaceId, name: "Scoped token fixture", slug: "scoped" },
  });
  toolkitToken = (
    await createApiToken(actorId, "Communication test toolkit", {
      toolkitId: toolkit.id,
    })
  ).token;
  platform = await httpFixture(async (req) => {
    const path = new URL(req.url).pathname;
    const runtime =
      /^\/api\/v1\/agent-runtime\/a2a\/([^/]+)\/(mcp|approvals)$/.exec(path);
    if (runtime) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      if (runtime[2] === "mcp") return handleLocalMcp(req, runtime[1]);
      return handleRuntimeApprovals(req, runtime[1]);
    }
    const inbound =
      /^\/api\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)\/a2a\/local$/.exec(
        path,
      );
    if (!inbound) return new Response(null, { status: 404 });
    const response = await (req.method === "GET" ? inboundGet : inboundPost)(
      req,
      { params: Promise.resolve({ slug: inbound[1], agentId: inbound[2] }) },
    );
    inboundResponses.push({
      status: response.status,
      body: await response.clone().text(),
    });
    return response;
  });
  vi.stubEnv("NEXT_PUBLIC_APP_URL", platform.base);
}, 30_000);

beforeEach(async () => {
  await db.a2AContext.deleteMany({
    where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.remoteA2AAgent.deleteMany({ where: { workspaceId } });
  await db.agentSubAgent.deleteMany({ where: { parentId: { in: agents } } });
  await db.agentSubAgent.createMany({
    data: [
      [0, 1],
      [1, 0],
      [1, 2],
      [2, 3],
      [3, 4],
    ].map(([parent, child]) => ({
      parentId: agents[parent],
      childId: agents[child],
    })),
  });
  await db.agent.updateMany({
    where: { id: { in: agents } },
    data: { a2aInternalEnabled: false },
  });
  peer.calls.length = 0;
  peer.tasks.clear();
  peer.behavior.state = "TASK_STATE_WORKING";
  peer.behavior.loseSendResponse = false;
  inboundResponses.length = 0;
  const actor = { workspaceId, actorId, agentId: agents[0], slug };
  remoteId = (
    await mutateRemoteRegistry(actor, {
      action: "register",
      name: "Controlled peer",
      cardUrl: REMOTE_CARD,
      rpcUrl: REMOTE_RPC,
      token: "shared-peer-credential",
    })
  ).id;
  let remote = await db.remoteA2AAgent.findUniqueOrThrow({
    where: { id: remoteId },
  });
  if (!remote.enabled || !remote.allowedAgentIds.includes(agents[0]))
    await mutateRemoteRegistry(actor, {
      action: "configure",
      id: remote.id,
      revision: remote.revision,
      enabled: true,
      allowCurrentAgent: true,
    });
  remote = await db.remoteA2AAgent.findUniqueOrThrow({
    where: { id: remoteId },
  });
  await mutateRemoteRegistry(
    { ...actor, agentId: agents[1] },
    {
      action: "configure",
      id: remote.id,
      revision: remote.revision,
      allowCurrentAgent: true,
    },
  );
  for (const [index, agentId] of agents.entries()) {
    const localTargets = index === 5 ? [agents[5]] : agents.slice(0, 5);
    const bounds = {
      maxCalls: 128,
      maxDepth: 3,
      maxConcurrent: 16,
      timeoutSeconds: 840,
      maxInputBytes: 65_536,
      dataAllowance: "text_only",
    };
    await db.agent.update({
      where: { id: agentId },
      data: {
        a2aInboundEnabled: true,
        a2aOutboundEnabled: true,
        a2aPolicy: {
          schemaVersion: 1,
          targets: [
            ...localTargets.map((targetId) => ({
              ...bounds,
              kind: "local",
              targetId,
              capabilityIds: [],
            })),
            ...(index < 2
              ? [
                  {
                    ...bounds,
                    kind: "remote",
                    targetId: remoteId,
                    capabilityIds: remoteCard().skills.map((skill) => skill.id),
                  },
                ]
              : []),
          ],
        },
      },
    });
    await publishFixtureAgentRevision(
      index === 5 ? foreignWorkspaceId : workspaceId,
      agentId,
    );
  }
});
afterEach(async () => {
  const results = await Promise.allSettled([
    ...clients.splice(0).map((client) => client.close()),
  ]);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});
afterAll(async () => {
  stopA2AWorker();
  const servers = await Promise.allSettled([platform?.close(), peer?.close()]);
  vi.unstubAllEnvs();
  if (workspaceId) {
    await db.auditEvent.deleteMany({
      where: {
        OR: [
          {
            workspaceId: {
              in: [workspaceId, foreignWorkspaceId].filter(Boolean),
            },
          },
          { actorId: { in: [actorId, otherActorId].filter(Boolean) } },
        ],
      },
    });
    await db.logEvent.deleteMany({
      where: {
        workspaceId: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) },
      },
    });
    await db.a2AContext.deleteMany({
      where: {
        workspaceId: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) },
      },
    });
    await db.conversation.deleteMany({
      where: { agentId: { in: agents } },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
    });
  }
  await db.user.deleteMany({
    where: { id: { in: [actorId, otherActorId].filter(Boolean) } },
  });
  await db.$disconnect();
  for (const result of servers)
    if (result.status === "rejected") throw result.reason;
});

describe("native communication transport: real PostgreSQL and MCP SDK HTTP", () => {
  it("intersects pinned collaboration scopes with live outbound authorization", async () => {
    const client = await connect(await root());
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(
      [...rawNames].sort(),
    );
    expect(
      (await call(client, "pi_a2a_peers")).peers
        .map((entry) => entry.target)
        .sort(),
    ).toEqual([`agent:${agents[1]}`, `remote:${remoteId}`].sort());
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aOutboundEnabled: false },
    });
    expect((await client.listTools()).tools).toEqual([]);
    for (const target of [`agent:${agents[1]}`, `remote:${remoteId}`])
      await rejected(client, "pi_a2a_submit", {
        target,
        message: "Revoked live grant",
        messageId: randomUUID(),
      });
    expect(peer.calls).toEqual([]);
    for (const name of [
      ...legacyNames,
      "a2a_call",
      "a2a_peers",
      "a2a_status",
      "a2a_cancel",
    ])
      await rejected(client, name, {});
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aOutboundEnabled: true },
    });
    expect(
      (await call(client, "pi_a2a_peers")).peers
        .map((entry) => entry.target)
        .sort(),
    ).toEqual([`agent:${agents[1]}`, `remote:${remoteId}`].sort());
  });

  it("deduplicates concurrent A→B submits and rejects a changed message under the same ID", async () => {
    const parent = await root(),
      client = await connect(parent),
      messageId = randomUUID();
    const ids = await Promise.all([
      delegate(client, 1, messageId),
      delegate(client, 1, messageId),
    ]);
    expect(ids[0]).toBe(ids[1]);
    await rejected(client, "pi_a2a_submit", {
      target: `agent:${agents[1]}`,
      message: "Changed content",
      messageId,
    });
    expect(await db.a2ATask.count({ where: { parentTaskId: parent.id } })).toBe(
      1,
    );
    expect(await db.a2ARequest.count({ where: { taskId: ids[0] } })).toBe(1);
    expect(
      await db.a2ATask.findUniqueOrThrow({ where: { id: ids[0] } }),
    ).toMatchObject({
      parentTaskId: parent.id,
      nativeOperationId: null,
    });
  });

  it("binds get/cancel to both the parent and explicit target; cancellation waits for acknowledgment", async () => {
    const parent = await root(),
      client = await connect(parent),
      id = await delegate(client);
    const other = await connect(await root(0, otherActorId));
    for (const name of ["pi_a2a_status", "pi_a2a_cancel"]) {
      await rejected(client, name, {
        target: `agent:${agents[2]}`,
        taskId: id,
      });
      await rejected(client, name, {
        target: `remote:${remoteId}`,
        taskId: id,
      });
      await rejected(other, name, { target: `agent:${agents[1]}`, taskId: id });
    }
    expect(
      (
        await call(client, "pi_a2a_status", {
          target: `agent:${agents[1]}`,
          taskId: id,
        })
      ).task.status.state,
    ).toBe("TASK_STATE_SUBMITTED");
    const running = assertDefined(await claimTask(id));
    expect(
      (
        await call(client, "pi_a2a_cancel", {
          target: `agent:${agents[1]}`,
          taskId: id,
        })
      ).task.status.state,
    ).toBe("TASK_STATE_WORKING");
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id } })).cancelRequestedAt,
    ).not.toBeNull();
    // Transport cancellation acknowledgement only; this unstarted child has no native operation.
    await finishTask(
      id,
      assertDefined(running.leaseToken),
      TaskState.TASK_STATE_CANCELED,
    );
    expect(
      (
        await call(client, "pi_a2a_status", {
          target: `agent:${agents[1]}`,
          taskId: id,
        })
      ).task.status.state,
    ).toBe("TASK_STATE_CANCELED");
  });

  it("denies unauthorized C, foreign workspace, self, ancestors, and excessive depth", async () => {
    await db.agentSubAgent.createMany({
      data: [0, 5].map((index) => ({
        parentId: agents[0],
        childId: agents[index],
      })),
    });
    const parent = await root(),
      client = await connect(parent);
    for (const index of [0, 2, 5])
      await rejected(client, "pi_a2a_submit", {
        target: `agent:${agents[index]}`,
        message: "Denied",
        messageId: randomUUID(),
      });
    await rejected(client, "pi_a2a_submit", {
      target: `agent:${randomUUID()}`,
      message: "Missing target",
      messageId: randomUUID(),
    });
    let childId = await delegate(client),
      child = assertDefined(await claimTask(childId)),
      current = await connect(child, 1);
    await rejected(current, "pi_a2a_submit", {
      target: `agent:${agents[0]}`,
      message: "Ancestor cycle",
      messageId: randomUUID(),
    });
    for (let depth = 2; depth <= LOCAL_LIMITS.depth; depth++) {
      childId = await delegate(current, depth);
      child = assertDefined(await claimTask(childId));
      current = await connect(child, depth);
    }
    await rejected(current, "pi_a2a_submit", {
      target: `agent:${agents[LOCAL_LIMITS.depth + 1]}`,
      message: "Too deep",
      messageId: randomUUID(),
    });
    expect(await db.a2ATask.count({ where: { rootTaskId: parent.id } })).toBe(
      LOCAL_LIMITS.depth + 1,
    );
  });

  it("requires approval readiness and exact runtime scope, rejects forged claims, and invalidates old credentials on a new lease", async () => {
    const parent = await root(),
      token = await credential(parent, 0, false);
    await expect(connect(parent, 0, token)).rejects.toThrow();
    await credential(parent);
    const client = await connect(parent, 0, token);
    await call(client, "pi_a2a_peers");
    expect(taskSandbox(parent).sandboxId).not.toBe(templateSandboxes[0]);
    for (const claims of [
      { workspaceId: foreignWorkspaceId },
      { sandboxId: templateSandboxes[0] },
      { a2aContextId: undefined },
      { a2aContextId: randomUUID() },
    ]) {
      const forged = await createAgentRuntimeToken({
        ...(await payload(parent)),
        ...claims,
      });
      tokens.push(forged);
      await expect(connect(parent, 0, forged)).rejects.toThrow();
      const response = await fetch(
        `${platform.base}/api/v1/agent-runtime/a2a/${parent.id}/approvals`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${forged}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "ready" }),
        },
      );
      expect(response.status).toBe(404);
    }
    await finishTask(
      parent.id,
      assertDefined(parent.leaseToken),
      TaskState.TASK_STATE_INPUT_REQUIRED,
      "Please provide the next task input.",
    );
    const paused = await db.a2ATask.findUniqueOrThrow({
      where: { id: parent.id },
    });
    const pausedTask = Task.fromJSON(paused.snapshot);
    expect(pausedTask.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(pausedTask.status?.message?.parts).toEqual([
      expect.objectContaining({
        content: {
          $case: "text",
          value: "Please provide the next task input.",
        },
      }),
    ]);
    expect(pausedTask.artifacts).toEqual([]);
    const grant = parent.grant as unknown as LocalA2AGrant;
    const accepted = await submitNativeEntry(
      {
        kind: "chat",
        sourceId: assertDefined(grant.entryPolicy).sourceId,
        workspaceId,
        agentId: agents[0],
        actorId,
        messageId: randomUUID(),
        text: "Continue with the approved scope.",
      },
      vi.fn(),
    );
    const next = assertDefined(await claimTask(accepted.row.id));
    expect(next.executionBackend).toBe("pi-sdk");
    expect(next.leaseToken).not.toBe(parent.leaseToken);
    expect(taskSandbox(next)).toEqual(taskSandbox(parent));
    await expect(
      client.callTool({ name: "pi_a2a_peers", arguments: {} }),
    ).rejects.toThrow();
    await expect(
      connect(next, 0, await credential(next, 0, false)),
    ).rejects.toThrow();
    await call(await connect(next), "pi_a2a_peers");
  });

  it("keeps a busy child queued without executing or suspending its parent (scheduler boundary)", async () => {
    const parent = await root(),
      client = await connect(parent),
      id = await delegate(client);
    const executor = vi.fn(async () => ({
      state: TaskState.TASK_STATE_COMPLETED,
    }));
    const child = await db.a2ATask.findUniqueOrThrow({ where: { id } });
    await mapTaskSandbox(child);
    const assertQueued = async () => {
      await executeA2ATask(id, executor);
      expect(executor).not.toHaveBeenCalled();
      const result = await call(client, "pi_a2a_status", {
        target: `agent:${agents[1]}`,
        taskId: id,
      });
      expect(result.task.status.state).toBe("TASK_STATE_SUBMITTED");
      expect(
        await db.a2ATask.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        state: TaskState.TASK_STATE_SUBMITTED,
        phase: "queued",
        leaseToken: null,
      });
    };
    let releaseSession!: () => void;
    let sessionReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      sessionReady = resolve;
    });
    const session = withAgentExecutionLease(
      { agentId: agents[1], sessionId: child.contextId, wait: false },
      async () => {
        const held = new Promise<void>((resolve) => {
          releaseSession = resolve;
        });
        sessionReady();
        await held;
      },
    );
    await ready;
    try {
      await assertQueued();
    } finally {
      releaseSession();
      await session;
    }
    await withSandboxExecutionLease(taskSandbox(child).sandboxId, assertQueued);
    expect(
      await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } }),
    ).toMatchObject({
      state: TaskState.TASK_STATE_WORKING,
      phase: "executing",
      leaseToken: parent.leaseToken,
      waitForTaskIds: [],
    });
    await executeA2ATask(id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await db.a2ATask.findUniqueOrThrow({ where: { id } })).toMatchObject(
      {
        state: TaskState.TASK_STATE_COMPLETED,
        phase: "done",
        leaseToken: null,
      },
    );
  }, 10_000);
});

describe("external SDK boundary and remote receipt ownership", () => {
  it("isolates remote callers sharing a credential and recovers known peer work with GET only", async () => {
    const first = await root(),
      second = await root(1),
      a = await connect(first),
      b = await connect(second, 1);
    const idA = await remoteSubmit(a),
      idB = await remoteSubmit(b);
    await executeA2ATask(idA);
    await executeA2ATask(idB);
    for (const name of ["pi_a2a_status", "pi_a2a_cancel"]) {
      await rejected(b, name, { target: `remote:${remoteId}`, taskId: idA });
      await rejected(a, name, { target: `remote:${remoteId}`, taskId: idB });
      await rejected(a, name, { target: `agent:${agents[1]}`, taskId: idA });
    }
    const stored = await db.a2ATask.findUniqueOrThrow({ where: { id: idA } });
    expect(stored.remoteTaskId).toMatch(/^private-peer-/);
    const shown = await call(a, "pi_a2a_status", {
      target: `remote:${remoteId}`,
      taskId: idA,
    });
    expect(shown.task.id).toBe(idA);
    expect(JSON.stringify(shown)).not.toContain(
      assertDefined(stored.remoteTaskId),
    );
    expect(peer.calls.map((entry) => entry.method)).toEqual([
      "SendMessage",
      "SendMessage",
    ]);
    peer.behavior.state = "TASK_STATE_COMPLETED";
    await db.a2ATask.updateMany({
      where: { id: { in: [idA, idB] } },
      data: { remotePollAt: new Date(0) },
    });
    await reconcileRemoteTasks();
    expect(peer.calls.map((entry) => entry.method)).toEqual([
      "SendMessage",
      "SendMessage",
      "GetTask",
      "GetTask",
    ]);
    expect(
      (
        await call(a, "pi_a2a_status", {
          target: `remote:${remoteId}`,
          taskId: idA,
        })
      ).task.status.state,
    ).toBe("TASK_STATE_COMPLETED");
    for (const entry of peer.calls) {
      expect(entry.authorization).toBe("Bearer shared-peer-credential");
      assertNoSecrets(entry.body, [
        workspaceId,
        actorId,
        agents[0],
        agents[1],
        first.id,
        second.id,
        idA,
        idB,
        assertDefined(first.leaseToken),
        assertDefined(second.leaseToken),
      ]);
    }
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aOutboundEnabled: false },
    });
    for (const name of ["pi_a2a_status", "pi_a2a_cancel"])
      await rejected(a, name, { target: `remote:${remoteId}`, taskId: idA });
    expect((await a.listTools()).tools).toEqual([]);
    expect(
      (
        await call(b, "pi_a2a_status", {
          target: `remote:${remoteId}`,
          taskId: idB,
        })
      ).task.status.state,
    ).toBe("TASK_STATE_COMPLETED");
    expect(peer.calls.map((entry) => entry.method)).toEqual([
      "SendMessage",
      "SendMessage",
      "GetTask",
      "GetTask",
    ]);
  });

  it("does not replay an accepted remote SendMessage whose acknowledgement was lost", async () => {
    const client = await connect(await root()),
      id = await remoteSubmit(client);
    peer.behavior.loseSendResponse = true;
    await executeA2ATask(id);
    expect(peer.tasks.size).toBe(1);
    expect(peer.calls.map((entry) => entry.method)).toEqual(["SendMessage"]);
    const result = await call(client, "pi_a2a_status", {
      target: `remote:${remoteId}`,
      taskId: id,
    });
    expect(result.task.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(result)).toContain("may still");
    await executeA2ATask(id);
    await reconcileRemoteTasks();
    expect(peer.calls.map((entry) => entry.method)).toEqual(["SendMessage"]);
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id } })).remoteTaskId,
    ).toBeNull();
  });

  it("accepts a personal-token SDK caller on the actual inbound route and permits only its task reads/cancel", async () => {
    const client = await inboundClient(personalToken);
    const sent = await client.sendMessage(
      request("text/plain inbound request"),
    );
    if (!("status" in sent))
      throw new Error("Expected an accepted task, not an immediate message");
    expect(sent.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(
      await client.getTask(GetTaskRequest.fromJSON({ id: sent.id })),
    ).toMatchObject({ id: sent.id });
    const other = await inboundClient(otherPersonalToken);
    await expect(
      other.getTask(GetTaskRequest.fromJSON({ id: sent.id })),
    ).rejects.toThrow();
    await expect(
      other.cancelTask(CancelTaskRequest.fromJSON({ id: sent.id })),
    ).rejects.toThrow();
    expect(
      await client.cancelTask(CancelTaskRequest.fromJSON({ id: sent.id })),
    ).toMatchObject({
      id: sent.id,
      status: { state: TaskState.TASK_STATE_CANCELED },
    });
    assertNoSecrets(inboundResponses);
  });

  it("rejects missing/Toolkit credentials, foreign workspace and disallowed Origin through the real route", async () => {
    for (const [token, selectedSlug, headers, status] of [
      ["", slug, {}, 401],
      [toolkitToken, slug, {}, 401],
      [personalToken, foreignSlug, {}, 404],
      [personalToken, slug, { origin: "https://untrusted.example" }, 403],
      [personalToken, slug, { origin: "" }, 403],
    ] as Array<[string, string, Record<string, string>, number]>) {
      const client = await inboundClient(token, selectedSlug, headers);
      await expect(client.sendMessage(request())).rejects.toThrow();
      expect(inboundResponses.at(-1)?.status).toBe(status);
    }
    await db.agent.update({
      where: { id: agents[0] },
      data: { a2aInboundEnabled: false },
    });
    const disabled = await inboundClient(personalToken);
    await expect(disabled.sendMessage(request())).rejects.toMatchObject({
      envelopeCode: A2A_ERROR_CODE.TASK_NOT_FOUND,
    });
    expect(
      await db.a2ATask.count({ where: { context: { workspaceId } } }),
    ).toBe(0);
    assertNoSecrets(inboundResponses);
  });
});
