// @vitest-environment node
import { assertDefined } from "../assert-defined";
import { createHash, randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  REMOTE_CARD,
  REMOTE_RPC,
  remoteCard,
  remoteTask,
} from "../fixtures/a2a-remote";
import {
  mutateRemoteRegistry,
  remoteCredential,
  remoteRegistryView,
} from "@/lib/a2a/remote-registry";
import { remoteChildGrant, assertRemoteGrant } from "@/lib/a2a/remote-policy";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { createLocalRootGrant, childGrant } from "@/lib/a2a/local-policy";
import {
  submitTask,
  claimTask,
  finishTask,
  getTask,
  getTaskRow,
  interruptTask,
  requestCancellation,
  deferTaskFileStaging,
  completeTaskFileStaging,
} from "@/lib/a2a/store";
import { retryTaskFileReception } from "@/lib/a2a/store";
import { stageTaskFileTransfers } from "@/lib/a2a/task-files";
import { listTaskFiles, openTaskFile } from "@/lib/a2a/files";
import { taskFileLimitError } from "@/lib/a2a/file-limits";
import { DEFAULT_A2A_FILE_BYTES } from "@/lib/transport-policy";
import {
  requestLocalWait,
  reconcileLocalWaits,
} from "@/lib/a2a/local-continuation";
import {
  executeRemoteTask,
  reconcileRemoteTasks,
} from "@/lib/a2a/remote-executor";
import {
  executeAgentTask,
  startAgentWorker,
  stopAgentWorker,
} from "@/lib/agents/execution/worker";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import type { ConsoleActor } from "@/lib/a2a/console-service";
import type * as Worker from "@/lib/agents/execution/worker";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import type { A2ALogBinding } from "@/lib/observability/a2a-log";
import { withLogContext } from "@/lib/observability/context";

import type * as AttachmentStorage from "@/lib/attachments/storage";
const network = vi.hoisted(() => ({
  discover: vi.fn(),
  rpc: vi.fn(),
  files: vi.fn(),
  objects: new Map<string, Uint8Array>(),
}));
vi.mock("@/lib/attachments/storage", async (original) => ({
  ...(await original<typeof AttachmentStorage>()),
  writeWorkspaceAttachment: async (input: {
    workspaceId: string;
    filename: string;
    body: ReadableStream<Uint8Array>;
    objectId: string;
    maxBytes: number;
  }) => {
    const bytes = new Uint8Array(await new Response(input.body).arrayBuffer());
    if (bytes.byteLength > input.maxBytes)
      throw new Error("fixture storage limit");
    const storagePath = `objects/${input.objectId}-${input.filename}`;
    network.objects.set(`${input.workspaceId}/${storagePath}`, bytes);
    return {
      storagePath,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
  readWorkspaceAttachment: (workspaceId: string, storagePath: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = network.objects.get(`${workspaceId}/${storagePath}`);
        if (!bytes) {
          controller.error(new Error("fixture file missing"));
          return;
        }
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  deleteWorkspaceAttachmentFile: async (
    workspaceId: string,
    storagePath: string,
  ) => {
    network.objects.delete(`${workspaceId}/${storagePath}`);
  },
}));
vi.mock("@/lib/db", async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== "1") return original();
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  return {
    db: new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      }),
    }),
  };
});
vi.mock("@/lib/a2a/remote-network", async (original) => ({
  ...(await original<typeof import("@/lib/a2a/remote-network")>()),
  fetchRemoteJson: network.discover,
  fetchRemoteFile: network.files,
  // Only the network boundary is replaced; the official ClientFactory/JSONRPC transport remains unchanged.
  remoteRpcFetch:
    (url: string, token: string | undefined, _binding: A2ALogBinding) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(url);
      const rpc = await request.json();
      const result = await network.rpc(rpc, token);
      const { validateRemoteResponse } = await import("@/lib/a2a/remote-wire");
      validateRemoteResponse(rpc, result);
      return Response.json(result);
    },
}));
vi.mock("@/lib/agents/execution/worker", async (original) => ({
  ...(await original<typeof Worker>()),
  wakeAgentWorker: vi.fn(),
}));

let user: string,
  member: string,
  ws: string,
  agent: string,
  otherAgent: string,
  remote: string;
let ctx: ConsoleActor, grant: LocalA2AGrant;
let peerState: string, peerDetail: string | undefined;
const message = (
  text = "Review only this explicit text",
  extra: Record<string, unknown> = {},
) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
      ...extra,
    },
    configuration: { returnImmediately: true },
  });
async function root() {
  return assertDefined(
    await claimTask((await submitTask(grant, message())).id),
  );
}
async function child(parent: Awaited<ReturnType<typeof root>>) {
  const authority = await remoteChildGrant(
    parent.id,
    assertDefined(parent.leaseToken),
    remote,
  );
  const row = await submitTask(authority, message(), {
    parentLeaseToken: assertDefined(parent.leaseToken),
  });
  return { grant: authority, row };
}
async function sendChild(parent: Awaited<ReturnType<typeof root>>) {
  const delegated = await child(parent),
    run = assertDefined(await claimTask(delegated.row.id));
  await executeRemoteTask(run, new AbortController().signal);
  return delegated;
}
async function due(id: string) {
  await db.a2ATask.update({
    where: { id },
    data: { remotePollAt: new Date(0) },
  });
  await reconcileRemoteTasks();
}
async function waiting(parent: Awaited<ReturnType<typeof root>>, id: string) {
  await requestLocalWait(parent.id, assertDefined(parent.leaseToken), [id]);
  await finishTask(parent.id, assertDefined(parent.leaseToken), 3);
}
const settledEvents = (taskId: string) =>
  db.logEvent.findMany({
    where: {
      workspaceId: ws,
      eventName: "a2a.task.settled",
      attributes: { path: ["data", "a2a", "taskId"], equals: taskId },
    },
    include: { detail: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const settledDetail = z.object({
  payload: z.object({ response: z.record(z.string(), z.unknown()) }),
});
const settledResponse = (data: unknown) =>
  Task.fromJSON(settledDetail.parse(data).payload.response);
beforeAll(async () => {
  process.env.AUTH_SECRET = "remote-tests-isolated-secret";
  vi.stubEnv(
    "TOOLPLANE_A2A_REMOTE_ORIGINS",
    JSON.stringify(["https://agent.example"]),
  );
  user = (
    await db.user.create({
      data: { email: `${randomUUID()}@remote.test`, passwordHash: "x" },
    })
  ).id;
  member = (
    await db.user.create({
      data: { email: `${randomUUID()}@remote.test`, passwordHash: "x" },
    })
  ).id;
  ws = (
    await db.workspace.create({
      data: {
        slug: `remote-${randomUUID()}`,
        name: "Remote fixture",
        ownerId: user,
        members: { create: { userId: member, role: "member" } },
      },
    })
  ).id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId: ws,
      name: "Model",
      format: "openai",
      baseUrl: "https://model.invalid",
      apiKey: "never-export-this-model-key",
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dep = await db.deployment.create({
      data: { workspaceId: ws, name: "Sandbox", source: "config" },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: ws,
        deploymentId: dep.id,
        name: "Sandbox",
        slug: `sandbox-${i}`,
        kind: "docker",
        network: "isolated",
      },
    });
    ids.push(
      (
        await db.agent.create({
          data: {
            workspaceId: ws,
            name: `Local ${i}`,
            slug: `local-${i}`,
            runtimeKind: "pi-sdk",
            model: "fixture",
            providerId: provider.id,
            a2aInternalEnabled: true,
            a2aInboundEnabled: true,
            a2aOutboundEnabled: true,
            sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
          },
        })
      ).id,
    );
  }
  [agent, otherAgent] = ids;
  ctx = { workspaceId: ws, actorId: user, agentId: agent, slug: "fixture" };
});
beforeEach(async () => {
  vi.clearAllMocks();
  network.objects.clear();
  network.files.mockReset();
  peerState = "TASK_STATE_WORKING";
  peerDetail = undefined;
  network.discover
    .mockReset()
    .mockImplementation(async () => Response.json(remoteCard()));
  network.rpc.mockImplementation(
    async (rpc: { id: unknown; method: string }) => ({
      jsonrpc: "2.0",
      id: rpc.id,
      result:
        rpc.method === "SendMessage"
          ? { task: remoteTask(peerState, peerDetail) }
          : remoteTask(peerState, peerDetail),
    }),
  );
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
  await db.remoteA2AAgent.deleteMany({ where: { workspaceId: ws } });
  await db.agentSubAgent.deleteMany({
    where: { parentId: { in: [agent, otherAgent] } },
  });
  await db.agent.updateMany({
    where: { workspaceId: ws },
    data: {
      a2aInternalEnabled: true,
      a2aInboundEnabled: true,
      a2aOutboundEnabled: true,
      systemPrompt: null,
      a2aPolicy: { schemaVersion: 1, targets: [] },
    },
  });
  remote = (
    await mutateRemoteRegistry(ctx, {
      action: "register",
      cardUrl: REMOTE_CARD,
      token: "fixture-peer-key",
    })
  ).id;
  await db.agent.update({
    where: { id: agent },
    data: {
      a2aPolicy: {
        schemaVersion: 1,
        targets: [
          {
            kind: "remote",
            targetId: remote,
            capabilityIds: remoteCard().skills.map((skill) => skill.id),
            maxCalls: 128,
            maxDepth: 3,
            maxConcurrent: 16,
            timeoutSeconds: 840,
            maxInputBytes: 65_536,
            dataAllowance: "text_only",
          },
        ],
      },
    },
  });
  for (const id of [agent, otherAgent])
    await publishFixtureAgentRevision(ws, id);
  grant = await createLocalRootGrant(ws, agent, user);
});
afterAll(async () => {
  stopAgentWorker();
  vi.unstubAllEnvs();
  if (ws) {
    await db.auditEvent.deleteMany({ where: { workspaceId: ws } });
    await db.logEvent.deleteMany({ where: { workspaceId: ws } });
    await db.workspace.delete({ where: { id: ws } });
  }
  await db.user.deleteMany({
    where: { id: { in: [user, member].filter(Boolean) } },
  });
  await db.$disconnect();
});

describe("registered remote Agents in the native task core", () => {
  it("externalizes raw input before persistence and stages storage before model admission", async () => {
    const request = SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [
          {
            raw: Buffer.from("input-file-body").toString("base64"),
            filename: "input.csv",
            mediaType: "text/csv",
          },
        ],
      },
      configuration: {
        returnImmediately: true,
        acceptedOutputModes: ["image/png"],
      },
    });
    const row = await submitTask(grant, request);
    expect(row.phase).toBe("file-receiving");
    expect(
      SendMessageRequest.fromJSON(row.request).configuration
        ?.acceptedOutputModes,
    ).toEqual(["image/png"]);
    expect(await claimTask(row.id)).toBeNull();
    expect(JSON.stringify([row.request, row.snapshot])).not.toContain(
      Buffer.from("input-file-body").toString("base64"),
    );
    const source = await db.a2ATaskFile.findFirstOrThrow({
      where: { taskId: row.id },
    });
    expect(source.status).toBe("pending");
    expect(JSON.stringify(source.source)).not.toContain("input-file-body");
    expect(await stageTaskFileTransfers(row.id)).toBe(true);
    const stored = (await listTaskFiles(row.id))[0];
    expect(
      await new Response((await openTaskFile(row.id, stored.id)).body).text(),
    ).toBe("input-file-body");
    expect((await submitTask(grant, request)).id).toBe(row.id);
    expect(await claimTask(row.id)).not.toBeNull();
    expect(network.rpc).not.toHaveBeenCalled();
  });
  it("fails the task with the specific reason when an input file exceeds a limit", async () => {
    const row = await submitTask(
      grant,
      SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [
            {
              url: "https://files.example/large.bin",
              filename: "large.bin",
              mediaType: "application/octet-stream",
            },
          ],
        },
        configuration: { returnImmediately: true },
      }),
    );
    network.files.mockRejectedValueOnce(
      taskFileLimitError("FILE_TOO_LARGE", DEFAULT_A2A_FILE_BYTES),
    );
    expect(await stageTaskFileTransfers(row.id)).toBe(false);
    const failed = await db.a2ATask.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(failed).toMatchObject({
      state: TaskState.TASK_STATE_FAILED,
      phase: "done",
    });
    const task = Task.fromJSON(failed.snapshot);
    expect(task.status?.message?.parts[0]?.content).toMatchObject({
      value: "File exceeds the 10 MiB per-file limit.",
    });
    expect(task.metadata?.toolplaneFileDelivery).toMatchObject({
      state: "failed",
      reason: "FILE_TOO_LARGE",
    });
    expect(
      (await db.a2ATaskFile.findFirstOrThrow({ where: { taskId: row.id } }))
        .errorCode,
    ).toBe("FILE_TOO_LARGE");
    expect(await claimTask(row.id)).toBeNull();
  });
  it("refuses unsupported file input or output MIME requirements before dispatch to a text-only peer", async () => {
    const parent = await root();
    const count = await db.a2ATask.count({
      where: { parentTaskId: parent.id },
    });
    expect(count).toBe(0);
    for (const request of [
      {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [
            { raw: "YQ==", filename: "image.png", mediaType: "image/png" },
          ],
        },
        configuration: { returnImmediately: true },
      },
      {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: "Return an image file" }],
        },
        configuration: {
          returnImmediately: true,
          acceptedOutputModes: ["image/png"],
        },
      },
    ])
      await expect(
        submitTask(
          await remoteChildGrant(
            parent.id,
            assertDefined(parent.leaseToken),
            remote,
          ),
          SendMessageRequest.fromJSON(request),
          {
            parentLeaseToken: assertDefined(parent.leaseToken),
          },
        ),
      ).rejects.toThrow(/input file MIME|output media types/);
    expect(await db.a2ATask.count({ where: { parentTaskId: parent.id } })).toBe(
      count,
    );
    expect(network.rpc).not.toHaveBeenCalled();
  });
  it("retries sandbox preparation without a continuation message or another business submission", async () => {
    const row = await submitTask(grant, message());
    const run = assertDefined(await claimTask(row.id));
    const lease = assertDefined(run.leaseToken);
    const before = Task.fromJSON(run.snapshot).history.length;
    await deferTaskFileStaging(row.id, lease);
    expect(await claimTask(row.id)).toBeNull();
    const retry = await retryTaskFileReception(grant, { taskId: row.id });
    expect(retry.status?.state).toBe(2);
    const claimed = assertDefined(await claimTask(row.id));
    expect(claimed.resumeCount).toBe(run.resumeCount);
    expect(Task.fromJSON(claimed.snapshot).history).toHaveLength(before);
    expect(claimed.leaseToken).not.toBe(lease);
    await completeTaskFileStaging(
      claimed.id,
      assertDefined(claimed.leaseToken),
    );
    expect(
      Task.fromJSON((await getTaskRow(grant, row.id)).snapshot).metadata
        ?.toolplaneFileDelivery,
    ).toMatchObject({ state: "ready", stage: "sandbox" });
    expect(network.rpc).not.toHaveBeenCalled();
  });
  it("retains an observed remote terminal outcome until required files arrive, then wakes the parent without resending work", async () => {
    const remoteDefinition = {
      ...remoteCard(),
      defaultInputModes: ["text/plain", "*/*"],
      defaultOutputModes: ["text/plain", "*/*"],
    };
    await db.remoteA2AAgent.update({
      where: { id: remote },
      data: { card: remoteDefinition },
    });
    network.files.mockRejectedValueOnce(
      new Error("secret-ticket-source-failed"),
    );
    network.files.mockImplementationOnce(async () =>
      new Blob(["remote-file-body"]).stream(),
    );
    network.rpc.mockImplementation(
      async (rpc: { id: unknown; method: string }) => {
        const task = {
          ...remoteTask("TASK_STATE_COMPLETED"),
          metadata: { bearer: "secret-peer-metadata" },
          artifacts: [
            {
              artifactId: "report",
              name: "report",
              parts: [
                {
                  url: `https://agent.example/report?signature=${rpc.method === "SendMessage" ? "old-secret-ticket" : "fresh-secret-ticket"}`,
                  filename: "报告 report 2026.csv",
                  mediaType: "text/csv",
                  metadata: { secret: "secret-part-metadata" },
                },
              ],
            },
          ],
        };
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: rpc.method === "SendMessage" ? { task } : task,
        };
      },
    );
    const parent = await root();
    const delegated = await sendChild(parent);
    const failed = await db.a2ATask.findUniqueOrThrow({
      where: { id: delegated.row.id },
    });
    expect(failed).toMatchObject({
      state: 2,
      remoteObservedState: 3,
      remoteFilesStatus: "failed",
      phase: "remote-file-failed",
    });
    expect(
      Task.fromJSON(failed.snapshot).metadata?.toolplaneFileDelivery,
    ).toMatchObject({ state: "failed", remoteState: 3 });
    expect(JSON.stringify([failed.snapshot, failed.request])).not.toMatch(
      /old-secret-ticket|secret-peer-metadata|secret-part-metadata|secret-ticket-source-failed/,
    );
    await waiting(parent, delegated.row.id);
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("waiting");
    const expiredGrant = { ...delegated.grant, expiresAt: Date.now() - 1000 };
    await db.a2ATask.update({
      where: { id: failed.id },
      data: { deadlineAt: new Date(0), grant: expiredGrant },
    });
    const recovered = await retryTaskFileReception(expiredGrant, {
      taskId: failed.id,
    });
    expect(recovered.status?.state).toBe(3);
    expect(recovered.metadata?.toolplaneFileDelivery).toMatchObject({
      state: "ready",
      remoteState: 3,
    });
    const [file] = await listTaskFiles(failed.id);
    expect(
      await new Response((await openTaskFile(failed.id, file.id)).body).text(),
    ).toBe("remote-file-body");
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("resumable");
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "GetTask",
    ]);
    expect(network.files).toHaveBeenCalledTimes(2);
    expect(network.files.mock.calls[1][0]).toContain("fresh-secret-ticket");
    await expect(
      retryTaskFileReception(expiredGrant, { taskId: failed.id }),
    ).rejects.toThrow();
    expect(
      network.rpc.mock.calls.filter(([rpc]) => rpc.method === "SendMessage"),
    ).toHaveLength(1);
  });
  async function localRelay(maxDepth: number) {
    const limits = {
      maxCalls: 128,
      maxDepth,
      maxConcurrent: 16,
      timeoutSeconds: 840,
      maxInputBytes: 65_536,
      dataAllowance: "text_only",
    };
    const ancestorPolicy = {
      schemaVersion: 1,
      targets: [
        { ...limits, kind: "local", targetId: otherAgent, capabilityIds: [] },
      ],
    };
    const relayPolicy = {
      schemaVersion: 1,
      targets: [
        {
          ...limits,
          maxDepth: 3,
          kind: "remote",
          targetId: remote,
          capabilityIds: remoteCard().skills.map((skill) => skill.id),
        },
      ],
    };
    await db.agentSubAgent.create({
      data: { parentId: agent, childId: otherAgent },
    });
    await db.agent.update({
      where: { id: agent },
      data: { a2aPolicy: ancestorPolicy },
    });
    await db.agent.update({
      where: { id: otherAgent },
      data: { a2aPolicy: relayPolicy },
    });
    await mutateRemoteRegistry(
      { ...ctx, agentId: otherAgent },
      {
        action: "configure",
        id: remote,
        revision: 1,
        allowCurrentAgent: true,
      },
    );
    for (const id of [agent, otherAgent])
      await publishFixtureAgentRevision(ws, id);
    grant = await createLocalRootGrant(ws, agent, user);
    const ancestor = await root();
    const authority = await childGrant(
      ancestor.id,
      assertDefined(ancestor.leaseToken),
      otherAgent,
    );
    const relay = assertDefined(
      await claimTask(
        (
          await submitTask(authority, message(), {
            parentLeaseToken: assertDefined(ancestor.leaseToken),
          })
        ).id,
      ),
    );
    return { relay, ancestorPolicy, relayPolicy };
  }

  it("includes the remote leaf in every ancestor's pinned depth after live expansion", async () => {
    const { relay, ancestorPolicy } = await localRelay(1);
    await expect(
      remoteChildGrant(relay.id, assertDefined(relay.leaseToken), remote),
    ).rejects.toThrow();
    await db.agent.update({
      where: { id: agent },
      data: {
        a2aPolicy: {
          ...ancestorPolicy,
          targets: ancestorPolicy.targets.map((policy) => ({
            ...policy,
            maxDepth: 3,
          })),
        },
      },
    });
    await expect(
      remoteChildGrant(relay.id, assertDefined(relay.leaseToken), remote),
    ).rejects.toThrow();
    expect(network.rpc).not.toHaveBeenCalled();
  });

  it.each(["ancestor", "remote-leaf"] as const)(
    "revalidates live %s depth before admitting or using an issued remote grant",
    async (edge) => {
      const { relay, ancestorPolicy, relayPolicy } = await localRelay(3);
      const delegated = await remoteChildGrant(
        relay.id,
        assertDefined(relay.leaseToken),
        remote,
      );
      expect(delegated.ancestorTaskIds).toHaveLength(2);
      await expect(assertRemoteGrant(delegated)).resolves.toBeUndefined();
      const previous = edge === "ancestor" ? ancestorPolicy : relayPolicy;
      await db.agent.update({
        where: { id: edge === "ancestor" ? agent : otherAgent },
        data: {
          a2aPolicy: {
            ...previous,
            targets: previous.targets.map((policy) => ({
              ...policy,
              maxDepth: 1,
            })),
          },
        },
      });
      const before = await db.a2ATask.count({
        where: { context: { workspaceId: ws } },
      });
      await expect(
        remoteChildGrant(relay.id, assertDefined(relay.leaseToken), remote),
      ).rejects.toThrow();
      await expect(assertRemoteGrant(delegated)).rejects.toThrow();
      await expect(
        submitTask(delegated, message(), {
          parentLeaseToken: assertDefined(relay.leaseToken),
        }),
      ).rejects.toThrow();
      expect(
        await db.a2ATask.count({ where: { context: { workspaceId: ws } } }),
      ).toBe(before);
      expect(network.rpc).not.toHaveBeenCalled();
    },
  );

  it("requires independent inbound and outbound approval", async () => {
    await db.agent.update({
      where: { id: agent },
      data: { a2aInboundEnabled: false },
    });
    await expect(createLocalRootGrant(ws, agent, user)).rejects.toThrow();
    await db.agent.update({
      where: { id: agent },
      data: { a2aInboundEnabled: true, a2aOutboundEnabled: false },
    });
    grant = await createLocalRootGrant(ws, agent, user);
    const parent = await root();
    await expect(child(parent)).rejects.toThrow(/approved policy/);
    expect(network.rpc).not.toHaveBeenCalled();
  });
  it.each(["calls", "authorized-cost", "input", "capabilities"] as const)(
    "enforces the approved %s scope before remote side effects",
    async (limit) => {
      const policy = {
        kind: "remote",
        targetId: remote,
        capabilityIds: ["review"],
        maxCalls: limit === "calls" ? 1 : 16,
        maxDepth: 3,
        maxConcurrent: 4,
        timeoutSeconds: 30,
        maxInputBytes: limit === "input" ? 1 : 65_536,
        dataAllowance: "text_only",
        ...(limit === "authorized-cost"
          ? {
              budget: {
                currency: "USD",
                maxAuthorizedCostMicros: 100,
                authorizedCostPerCallMicros: 100,
              },
            }
          : {}),
      };
      if (limit === "capabilities") policy.capabilityIds = [];
      await db.agent.update({
        where: { id: agent },
        data: { a2aPolicy: { schemaVersion: 1, targets: [policy] } },
      });
      grant = await createLocalRootGrant(ws, agent, user);
      const parent = await root();
      if (limit === "calls" || limit === "authorized-cost") {
        const delegated = await sendChild(parent);
        // Unknown/failed outcomes never refund an authorized reservation.
        await interruptTask(delegated.row.id, "Observation lost.");
      }
      const sent = network.rpc.mock.calls.length;
      await expect(child(parent)).rejects.toThrow();
      expect(network.rpc).toHaveBeenCalledTimes(sent);
    },
  );
  it("charges continuation admission against the same authorized reservation budget", async () => {
    await db.agent.update({
      where: { id: agent },
      data: {
        a2aPolicy: {
          schemaVersion: 1,
          targets: [
            {
              kind: "remote",
              targetId: remote,
              capabilityIds: ["review"],
              maxCalls: 16,
              maxDepth: 3,
              maxConcurrent: 4,
              timeoutSeconds: 840,
              maxInputBytes: 65_536,
              dataAllowance: "text_only",
              budget: {
                currency: "USD",
                maxAuthorizedCostMicros: 100,
                authorizedCostPerCallMicros: 100,
              },
            },
          ],
        },
      },
    });
    grant = await createLocalRootGrant(ws, agent, user);
    const parent = await root();
    peerState = "TASK_STATE_INPUT_REQUIRED";
    const delegated = await sendChild(parent);
    await expect(
      submitTask(
        delegated.grant,
        message("Additional input", { taskId: delegated.row.id }),
        { parentLeaseToken: assertDefined(parent.leaseToken) },
      ),
    ).rejects.toThrow(/authorized cost reservation/);
    expect(network.rpc).toHaveBeenCalledTimes(1);
  });
  it("registers enabled for only the current Agent, encrypts credentials and exposes no secret", async () => {
    await db.agent.update({
      where: { id: agent },
      data: { a2aInternalEnabled: false },
    });
    const id = (
      await mutateRemoteRegistry(ctx, {
        action: "register",
        cardUrl: REMOTE_CARD,
        token: "another-secret",
      })
    ).id;
    const row = await db.remoteA2AAgent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      name: "Remote reviewer",
      rpcUrl: REMOTE_RPC,
      enabled: true,
      allowedAgentIds: [agent],
      revision: 1,
    });
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agent } }))
        .a2aInternalEnabled,
    ).toBe(false);
    expect(JSON.stringify(row.credential)).not.toContain("another-secret");
    expect(remoteCredential(row)).toBe("another-secret");
    expect(() =>
      remoteCredential({ ...row, workspaceId: "different" }),
    ).toThrow();
    const view = await remoteRegistryView(ctx);
    expect(JSON.stringify(view)).not.toMatch(
      /another-secret|fixture-peer-key|credential/,
    );
    const audit = await db.auditEvent.findMany({ where: { workspaceId: ws } });
    expect(JSON.stringify(audit)).not.toContain("another-secret");
  });
  it("honors advanced name and declared RPC overrides and supports cards without auth", async () => {
    const card = { ...remoteCard(), securityRequirements: [] };
    const rpcUrl = "https://agent.example/advanced";
    card.supportedInterfaces.push({
      url: rpcUrl,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    network.discover.mockResolvedValueOnce(Response.json(card));
    const { id } = await mutateRemoteRegistry(ctx, {
      action: "register",
      cardUrl: REMOTE_CARD,
      name: "Custom reviewer",
      rpcUrl,
    });
    expect(
      await db.remoteA2AAgent.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      name: "Custom reviewer",
      rpcUrl,
      enabled: true,
      allowedAgentIds: [agent],
      credential: null,
    });
  });
  it.each(["ambiguous", "cross-origin", "unsupported", "disallowed", "noauth"])(
    "creates nothing for a rejected %s card",
    async (reason) => {
      const card = remoteCard();
      if (reason === "ambiguous")
        card.supportedInterfaces.push({
          url: "https://agent.example/second",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        });
      if (reason === "cross-origin")
        card.supportedInterfaces[0].url = "https://other.example/rpc";
      if (reason === "unsupported")
        card.supportedInterfaces[0].protocolVersion = "0.3";
      network.discover.mockResolvedValueOnce(Response.json(card));
      const before = await db.remoteA2AAgent.count({
        where: { workspaceId: ws },
      });
      await expect(
        mutateRemoteRegistry(ctx, {
          action: "register",
          cardUrl:
            reason === "disallowed"
              ? "https://other.example/card"
              : REMOTE_CARD,
          ...(reason === "noauth" ? {} : { token: "peer-key" }),
        }),
      ).rejects.toThrow();
      expect(
        await db.remoteA2AAgent.count({ where: { workspaceId: ws } }),
      ).toBe(before);
    },
  );
  it("rechecks administrator authority after discovery before committing registration", async () => {
    await db.membership.updateMany({
      where: { workspaceId: ws, userId: member },
      data: { role: "admin" },
    });
    network.discover.mockImplementationOnce(async () => {
      await db.membership.updateMany({
        where: { workspaceId: ws, userId: member },
        data: { role: "member" },
      });
      return Response.json(remoteCard());
    });
    const before = await db.remoteA2AAgent.count({
      where: { workspaceId: ws },
    });
    try {
      await expect(
        mutateRemoteRegistry(
          { ...ctx, actorId: member },
          { action: "register", cardUrl: REMOTE_CARD, token: "peer-key" },
        ),
      ).rejects.toThrow(/administrator/);
      expect(
        await db.remoteA2AAgent.count({ where: { workspaceId: ws } }),
      ).toBe(before);
    } finally {
      await db.membership.updateMany({
        where: { workspaceId: ws, userId: member },
        data: { role: "member" },
      });
    }
  });
  it("requires current admin authority before any remote discovery and per-Agent grants", async () => {
    await expect(
      mutateRemoteRegistry(
        { ...ctx, actorId: member },
        {
          action: "register",
          name: "Denied",
          cardUrl: REMOTE_CARD,
          rpcUrl: REMOTE_RPC,
        },
      ),
    ).rejects.toThrow();
    expect(network.discover).toHaveBeenCalledTimes(1);
    const viewer = await remoteRegistryView({ ...ctx, actorId: member });
    expect(viewer.canManage).toBe(false);
    expect(
      (
        await remoteRegistryView({
          ...ctx,
          actorId: member,
          agentId: otherAgent,
        })
      ).agents,
    ).toHaveLength(0);
    const other = await createLocalRootGrant(ws, otherAgent, user),
      parent = assertDefined(
        await claimTask((await submitTask(other, message())).id),
      );
    await expect(
      remoteChildGrant(parent.id, assertDefined(parent.leaseToken), remote),
    ).rejects.toThrow();
  });
  it("creates native child identity without fake clients/Endpoints or exporting local authority", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    const context = await db.a2AContext.findUniqueOrThrow({
      where: { id: delegated.row.contextId },
    });
    expect(context).toMatchObject({
      targetKind: "remote",
      remoteAgentId: remote,
      workspaceId: ws,
      agentId: null,
      clientId: null,
      endpointId: null,
    });
    expect(await db.agentEndpoint.count({ where: { workspaceId: ws } })).toBe(
      0,
    );
    const [rpc, token] = network.rpc.mock.calls[0];
    expect(rpc.method).toBe("SendMessage");
    expect(token).toBe("fixture-peer-key");
    expect(rpc.params.message.messageId).not.toBe(
      SendMessageRequest.fromJSON(delegated.row.request).message?.messageId,
    );
    for (const secret of [
      ws,
      user,
      agent,
      parent.id,
      delegated.row.id,
      assertDefined(parent.leaseToken),
      "never-export-this-model-key",
    ])
      expect(JSON.stringify(rpc)).not.toContain(secret);
    expect(rpc.params).not.toHaveProperty("metadata");
    expect(rpc.params.configuration.returnImmediately).toBe(true);
    await expect(getTask(grant, delegated.row.id)).rejects.toThrow();
  });
  it("releases the execution lease and resumes a waiting parent without a second SendMessage", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    expect(await getTaskRow(delegated.grant, delegated.row.id)).toMatchObject({
      phase: "remote-waiting",
      state: 2,
      leaseToken: null,
    });
    expect(await settledEvents(parent.id)).toEqual([]);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    peerState = "TASK_STATE_COMPLETED";
    const unrelatedRequest = randomUUID(),
      unrelatedTrace = randomUUID();
    await withLogContext(
      { requestId: unrelatedRequest, traceId: unrelatedTrace, actorId: member },
      () => due(delegated.row.id),
    );
    await due(delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    expect(resumed.resumeCount).toBe(1);
    expect(JSON.stringify(Task.fromJSON(resumed.snapshot).history)).toContain(
      "Remote review result",
    );
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "GetTask",
      "GetTask",
    ]);
    const tree = await getConsoleTaskTree(ctx, parent.id, delegated.row.id);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.selectedTask).toMatchObject({
      id: delegated.row.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    const committed = await getTaskRow(delegated.grant, delegated.row.id),
      events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "success",
      requestId: null,
      actorId: user,
      agentId: agent,
      workspaceId: ws,
      durationMs: committed.statusAt.getTime() - committed.createdAt.getTime(),
      attributes: {
        data: {
          a2a: {
            taskId: delegated.row.id,
            contextId: delegated.row.contextId,
            rootTaskId: parent.id,
            parentTaskId: parent.id,
            remoteAgentId: remote,
            taskState: "TASK_STATE_COMPLETED",
          },
        },
      },
    });
    expect(events[0].traceId).not.toBe(unrelatedTrace);
    const response = settledResponse(assertDefined(events[0].detail).data);
    expect(response.id).toBe(delegated.row.id);
    expect(response.contextId).toBe(delegated.row.contextId);
    expect(response.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(response.history).toEqual([]);
    expect(response.artifacts[0].parts[0].content).toEqual({
      $case: "text",
      value: "Remote review result",
    });
    expect(assertDefined(events[0].detail).data).not.toHaveProperty(
      "payload.request",
    );
    expect(JSON.stringify(events)).not.toMatch(
      /peer-task|peer-context|fixture-peer-key|ownerKey|Review only this explicit text/,
    );
  });
  it("keeps remote task/context IDs stable through input-required continuation", async () => {
    const parent = await root();
    peerState = "TASK_STATE_INPUT_REQUIRED";
    peerDetail = "Which branch?";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const authority = await remoteChildGrant(
      parent.id,
      assertDefined(resumed.leaseToken),
      remote,
    );
    const follow = await submitTask(
      authority,
      message("main", { taskId: delegated.row.id }),
      { parentLeaseToken: assertDefined(resumed.leaseToken) },
    );
    peerState = "TASK_STATE_COMPLETED";
    peerDetail = undefined;
    const run = assertDefined(await claimTask(follow.id));
    await executeRemoteTask(run, new AbortController().signal);
    const calls = network.rpc.mock.calls.map(([rpc]) => rpc);
    expect(calls).toHaveLength(2);
    expect(calls[1].params.message).toMatchObject({
      taskId: "peer-task",
      contextId: "peer-context",
    });
    expect(calls[1].params.message.messageId).not.toBe(
      calls[0].params.message.messageId,
    );
    expect((await getTask(authority, follow.id)).status?.state).toBe(3);
    expect(follow.deadlineAt).toEqual(delegated.row.deadlineAt);
    const events = await settledEvents(follow.id);
    expect(events).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_INPUT_REQUIRED" } },
        },
      },
      {
        outcome: "success",
        attributes: { data: { a2a: { taskState: "TASK_STATE_COMPLETED" } } },
      },
    ]);
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });
  it("does not claim cancellation until the peer confirms and sends CancelTask at most once", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    expect(
      (await requestCancellation(delegated.grant, delegated.row.id)).status
        ?.state,
    ).toBe(2);
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(2);
    expect(await settledEvents(delegated.row.id)).toEqual([]);
    peerState = "TASK_STATE_CANCELED";
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(5);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "CancelTask",
      "GetTask",
    ]);
    const events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "cancelled",
      attributes: { data: { a2a: { taskState: "TASK_STATE_CANCELED" } } },
    });
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("cancels a queued input continuation without resending its business message", async () => {
    const parent = await root();
    peerState = "TASK_STATE_INPUT_REQUIRED";
    peerDetail = "Which branch?";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const authority = await remoteChildGrant(
      parent.id,
      assertDefined(resumed.leaseToken),
      remote,
    );
    await submitTask(authority, message("main", { taskId: delegated.row.id }), {
      parentLeaseToken: assertDefined(resumed.leaseToken),
    });
    await requestCancellation(authority, delegated.row.id);
    await waiting(resumed, delegated.row.id);
    await due(delegated.row.id);
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("waiting");
    peerState = "TASK_STATE_CANCELED";
    peerDetail = undefined;
    await due(delegated.row.id);
    await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe("resumable");
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "CancelTask",
      "GetTask",
    ]);
  });
  it("observes externally resolved remote authorization without model approval or new submission", async () => {
    const parent = await root();
    peerState = "TASK_STATE_AUTH_REQUIRED";
    const delegated = await sendChild(parent);
    await expect(
      submitTask(
        delegated.grant,
        message("approved", { taskId: delegated.row.id }),
        { parentLeaseToken: assertDefined(parent.leaseToken) },
      ),
    ).rejects.toThrow();
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_AUTH_REQUIRED" } },
        },
      },
    ]);
    peerState = "TASK_STATE_WORKING";
    await due(delegated.row.id);
    expect(await settledEvents(delegated.row.id)).toHaveLength(1);
    peerState = "TASK_STATE_COMPLETED";
    await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(3);
    expect(
      network.rpc.mock.calls.filter(([rpc]) => rpc.method === "SendMessage"),
    ).toHaveLength(1);
    expect(await settledEvents(delegated.row.id)).toMatchObject([
      {
        outcome: "success",
        attributes: {
          data: { a2a: { taskState: "TASK_STATE_AUTH_REQUIRED" } },
        },
      },
      {
        outcome: "success",
        attributes: { data: { a2a: { taskState: "TASK_STATE_COMPLETED" } } },
      },
    ]);
  });
  it("propagates root cancellation but can still cancel the known remote child", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await requestCancellation(grant, parent.id);
    expect((await getTask(grant, parent.id)).status?.state).toBe(5);
    peerState = "TASK_STATE_CANCELED";
    await due(delegated.row.id);
    await expect(getTask(delegated.grant, delegated.row.id)).rejects.toThrow();
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: delegated.row.id } }))
        .state,
    ).toBe(TaskState.TASK_STATE_CANCELED);
  });
  it("fails an uncertain submission without automatic resend or false cancellation", async () => {
    const parent = await root(),
      delegated = await child(parent);
    network.rpc.mockRejectedValueOnce(new Error("secret upstream exception"));
    await executeAgentTask(delegated.row.id);
    const task = await getTask(delegated.grant, delegated.row.id);
    expect(task.status?.state).toBe(4);
    expect(JSON.stringify(task)).not.toContain("secret upstream exception");
    expect(JSON.stringify(task)).toContain("may still");
    expect(task.metadata?.toolplaneRemote).toMatchObject({
      outcome: "unknown",
    });
    const view = await getConsoleTaskTree(ctx, parent.id, delegated.row.id);
    expect(
      view.nodes.find((node) => node.id === delegated.row.id),
    ).toMatchObject({ remoteOutcome: "unknown" });
    await executeAgentTask(delegated.row.id);
    await due(delegated.row.id);
    expect(network.rpc).toHaveBeenCalledTimes(1);
    const events = await settledEvents(delegated.row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      attributes: { data: { a2a: { taskState: "TASK_STATE_FAILED" } } },
    });
    expect(
      settledResponse(assertDefined(events[0].detail).data).status?.state,
    ).toBe(TaskState.TASK_STATE_FAILED);
  });
  it("invalidates outstanding tasks on key rotation or access revocation", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await mutateRemoteRegistry(ctx, {
      action: "replace-key",
      id: remote,
      revision: 1,
      token: "new-key",
    });
    await expect(assertRemoteGrant(delegated.grant)).rejects.toThrow();
    await due(delegated.row.id);
    await expect(getTask(delegated.grant, delegated.row.id)).rejects.toThrow();
    expect(
      (await db.a2ATask.findUniqueOrThrow({ where: { id: delegated.row.id } }))
        .state,
    ).toBe(TaskState.TASK_STATE_FAILED);
    expect(network.rpc).toHaveBeenCalledTimes(1);
    expect(
      (await getConsoleTaskTree(ctx, parent.id, delegated.row.id)).selectedTask
        .id,
    ).toBe(delegated.row.id);
    await expect(
      mutateRemoteRegistry(ctx, {
        action: "configure",
        id: remote,
        revision: 1,
        enabled: true,
      }),
    ).rejects.toThrow();
  });
  it("withholds completed remote output from automatic continuation after authorization changes", async () => {
    const parent = await root();
    peerState = "TASK_STATE_COMPLETED";
    const delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await mutateRemoteRegistry(ctx, {
      action: "configure",
      id: remote,
      revision: 1,
      allowCurrentAgent: false,
    });
    await reconcileLocalWaits();
    const resumed = assertDefined(await claimTask(parent.id));
    const history = JSON.stringify(Task.fromJSON(resumed.snapshot).history);
    expect(history).not.toContain("Remote review result");
    expect(history).toContain("withheld");
  });
  it("rejects forged ancestry/actor/lease and cross-workspace configuration", async () => {
    const parent = await root(),
      delegated = await child(parent);
    await expect(
      submitTask(delegated.grant, message(), { parentLeaseToken: "wrong" }),
    ).rejects.toThrow();
    await expect(
      assertRemoteGrant({ ...delegated.grant, actorId: member }),
    ).rejects.toThrow();
    await expect(
      assertRemoteGrant({
        ...delegated.grant,
        ancestorTaskIds: [randomUUID()],
      }),
    ).rejects.toThrow();
    await expect(
      mutateRemoteRegistry(
        { ...ctx, workspaceId: randomUUID() },
        { action: "configure", id: remote, revision: 1, enabled: false },
      ),
    ).rejects.toThrow();
  });
  it("ignores stale observation errors after a newer phase/generation", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    const row = await getTaskRow(delegated.grant, delegated.row.id);
    await db.a2ATask.update({
      where: { id: row.id },
      data: { remoteMessageId: "new-generation" },
    });
    await interruptTask(row.id, "stale", {
      phase: "remote-waiting",
      remoteMessageId: row.remoteMessageId,
    });
    expect((await getTaskRow(delegated.grant, row.id)).state).toBe(2);
    expect(await settledEvents(row.id)).toEqual([]);
  });
  it("bounds failed read retries without issuing another business message", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    network.rpc.mockRejectedValue(new Error("read failed"));
    for (let i = 0; i < 5; i++) await due(delegated.row.id);
    expect(
      (await getTask(delegated.grant, delegated.row.id)).status?.state,
    ).toBe(4);
    expect(
      network.rpc.mock.calls.filter(([rpc]) => rpc.method === "SendMessage"),
    ).toHaveLength(1);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === "1")(
    "claims a remote task only once under concurrent PostgreSQL transactions",
    async () => {
      const parent = await root(),
        delegated = await child(parent);
      const claims = await Promise.all([
        claimTask(delegated.row.id),
        claimTask(delegated.row.id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    },
  );
  it("recovers a known remote task by observation only, never replaying SendMessage", async () => {
    const parent = await root(),
      delegated = await sendChild(parent);
    await waiting(parent, delegated.row.id);
    await db.a2ATask.update({
      where: { id: delegated.row.id },
      data: {
        phase: "executing",
        leaseToken: "obsolete",
        remotePollAt: new Date(0),
      },
    });
    await startAgentWorker();
    stopAgentWorker();
    expect(await getTaskRow(delegated.grant, delegated.row.id)).toMatchObject({
      phase: "remote-waiting",
      leaseToken: null,
    });
    peerState = "TASK_STATE_COMPLETED";
    await due(delegated.row.id);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual([
      "SendMessage",
      "GetTask",
    ]);
  });
});
