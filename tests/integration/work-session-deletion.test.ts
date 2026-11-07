// @vitest-environment node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DELETE } from "@/app/api/v1/work-sessions/[workSessionId]/route";
import { db } from "@/lib/db";
import { listWorkSessions } from "@/lib/work/sessions";
import { withAgentExecutionLease } from "@/lib/agents/agent-execution-gate";
import { agentSessionWorkspaceRoot } from "@/lib/agents/session-paths";
import { beginAgentConversationSandboxAccess } from "@/lib/sandboxes/activity";
import {
  createDockerVolume,
  removeDockerVolumeStrict,
  sandboxContainerName,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";
import {
  removeWorkspaceAttachmentVolume,
  workspaceAttachmentVolumeName,
  writeWorkspaceAttachment,
} from "@/lib/attachments/storage";

// Only HTTP authentication is injected. Database, lifecycle gates and (when
// enabled) Docker cleanup all use their actual implementations.
const actor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () => (actor.id ? { id: actor.id } : null),
}));

const stamp = randomUUID();
const execFileAsync = promisify(execFile);
let ownerId = "";
let memberId = "";
let outsiderId = "";
let workspaceId = "";
let foreignWorkspaceId = "";
let agentId = "";
let peerAgentId = "";
let foreignAgentId = "";
const liveSandboxes: string[] = [];

async function docker(args: string[]) {
  return (
    await execFileAsync("docker", args, { timeout: 120_000 })
  ).stdout.trim();
}

async function volumeShell(
  volume: string,
  script: string,
  args: string[] = [],
) {
  return docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    "alpine:3.20",
    "sh",
    "-eu",
    "-c",
    script,
    "sh",
    ...args,
  ]);
}

async function workFixture(
  options: {
    status?: string;
    workspace?: string;
    agent?: string;
    conversationAgent?: string;
    sandboxId?: string;
  } = {},
) {
  const conversation = await db.conversation.create({
    data: {
      agentId: options.conversationAgent ?? options.agent ?? agentId,
      sandboxId: options.sandboxId,
      messages: {
        create: {
          role: "user",
          parts: [{ type: "text", text: "Retained history" }],
        },
      },
    },
  });
  return db.workSession.create({
    data: {
      workspaceId: options.workspace ?? workspaceId,
      agentId: options.agent ?? agentId,
      conversationId: conversation.id,
      sandboxId: options.sandboxId,
      runtimeKind: "omp",
      status: options.status ?? "completed",
    },
  });
}

async function sandboxFixture() {
  const existing = await db.sandbox.findFirst({
    where: { workspaceId, config: { path: ["agentId"], equals: agentId } },
  });
  if (existing) return existing;
  const deployment = await db.deployment.create({
    data: { workspaceId, status: "stopped" },
  });
  return db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      slug: `shared-${randomUUID()}`,
      name: "Shared",
      kind: "docker",
      config: {
        managedBy: "agent-conversation",
        scope: "agent",
        agentId,
        sourceSandboxId: "retained-template",
      },
    },
  });
}

function remove(id: string) {
  return DELETE(
    new Request(`http://local/api/v1/work-sessions/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ workSessionId: id }) },
  );
}

beforeAll(async () => {
  const users = await Promise.all(
    ["owner", "member", "outsider"].map((name) =>
      db.user.create({
        data: {
          email: `work-delete-${name}-${stamp}@test.invalid`,
          passwordHash: "unused",
        },
      }),
    ),
  );
  [ownerId, memberId, outsiderId] = users.map((user) => user.id);
  workspaceId = (
    await db.workspace.create({
      data: {
        ownerId,
        slug: `work-delete-${stamp}`,
        name: "Work deletion",
        members: { create: { userId: memberId, role: "member" } },
      },
    })
  ).id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        ownerId: outsiderId,
        slug: `work-delete-foreign-${stamp}`,
        name: "Foreign Work",
      },
    })
  ).id;
  const agents = await Promise.all(
    [
      { workspaceId, slug: "primary" },
      { workspaceId, slug: "peer" },
      { workspaceId: foreignWorkspaceId, slug: "foreign" },
    ].map((input) =>
      db.agent.create({
        data: { ...input, name: input.slug, runtimeKind: "omp" },
      }),
    ),
  );
  [agentId, peerAgentId, foreignAgentId] = agents.map((agent) => agent.id);
});

beforeEach(() => {
  actor.id = ownerId;
});

afterAll(async () => {
  for (const sandboxId of liveSandboxes) {
    await docker(["rm", "-f", sandboxContainerName(sandboxId)]).catch(
      () => undefined,
    );
    await removeDockerVolumeStrict(sandboxVolumeName(sandboxId));
  }
  if (liveSandboxes.length) await removeWorkspaceAttachmentVolume(workspaceId);
  const ids = [workspaceId, foreignWorkspaceId].filter(Boolean);
  await db.workSession.deleteMany({ where: { workspaceId: { in: ids } } });
  await db.conversation.deleteMany({
    where: { agent: { workspaceId: { in: ids } } },
  });
  await db.workspace.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({
    where: { id: { in: [ownerId, memberId, outsiderId].filter(Boolean) } },
  });
});

describe.sequential("Work conversation deletion", () => {
  it("keeps creation order when older conversations receive activity or titles", async () => {
    const older = await workFixture();
    const newer = await workFixture();
    const tied = await workFixture();
    const ids = [older.id, newer.id, tied.id];
    await db.workSession.update({
      where: { id: older.id },
      data: { createdAt: new Date("2026-11-01T00:00:00Z") },
    });
    await db.workSession.updateMany({
      where: { id: { in: [newer.id, tied.id] } },
      data: { createdAt: new Date("2026-11-02T00:00:00Z") },
    });
    const expected = [newer.id, tied.id].sort().reverse().concat(older.id);
    const listedIds = async () =>
      (await listWorkSessions(workspaceId, agentId))
        .filter((item) => ids.includes(item.id))
        .map((item) => item.id);
    expect(await listedIds()).toEqual(expected);
    await db.workSession.update({
      where: { id: older.id },
      data: { title: "Updated title", status: "waiting_user" },
    });
    expect(await listedIds()).toEqual(expected);
    await db.workSession.update({
      where: { id: newer.id },
      data: { title: "Another title", status: "completed" },
    });
    expect(await listedIds()).toEqual(expected);
  });
  it("removes the target Work and message history without deleting other or archived conversations", async () => {
    const target = await workFixture();
    const peer = await workFixture();
    const archived = await workFixture({ status: "archived" });
    expect((await remove(target.id)).status).toBe(204);
    expect(
      await db.workSession.findUnique({ where: { id: target.id } }),
    ).toBeNull();
    expect(
      await db.conversation.findUnique({
        where: { id: target.conversationId },
      }),
    ).toBeNull();
    expect(
      await db.message.count({
        where: { conversationId: target.conversationId },
      }),
    ).toBe(0);
    expect(
      await db.workSession.findUnique({ where: { id: peer.id } }),
    ).not.toBeNull();
    expect(
      await db.message.count({
        where: { conversationId: peer.conversationId },
      }),
    ).toBe(1);
    expect(
      await db.workSession.findUnique({ where: { id: archived.id } }),
    ).toMatchObject({ status: "archived" });
    expect((await remove(target.id)).status).toBe(404);
  });

  it("allows workspace members but rejects unauthenticated, foreign and mismatched Agent ownership", async () => {
    const target = await workFixture();
    actor.id = "";
    expect((await remove(target.id)).status).toBe(401);
    actor.id = outsiderId;
    expect((await remove(target.id)).status).toBe(404);
    actor.id = ownerId;
    const foreign = await workFixture({
      workspace: foreignWorkspaceId,
      agent: foreignAgentId,
    });
    expect((await remove(foreign.id)).status).toBe(404);
    // Membership in both workspaces still cannot authorize a corrupt cross-
    // workspace Work/Agent mapping.
    await db.membership.create({
      data: {
        workspaceId: foreignWorkspaceId,
        userId: ownerId,
        role: "member",
      },
    });
    const wrongWorkspace = await workFixture({ agent: foreignAgentId });
    expect((await remove(wrongWorkspace.id)).status).toBe(404);
    const wrongAgent = await workFixture({ conversationAgent: peerAgentId });
    expect((await remove(wrongAgent.id)).status).toBe(404);
    expect(
      await db.workSession.findUnique({ where: { id: target.id } }),
    ).not.toBeNull();
    actor.id = memberId;
    expect((await remove(target.id)).status).toBe(204);
  });

  it.each(["queued", "running", "cancelling", "waiting_user"])(
    "retains %s work with a displayable conflict",
    async (status) => {
      const target = await workFixture({ status });
      const response = await remove(target.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
      });
      expect(
        await db.workSession.findUnique({ where: { id: target.id } }),
      ).toMatchObject({ status });
      expect(
        await db.message.count({
          where: { conversationId: target.conversationId },
        }),
      ).toBe(1);
    },
  );

  it("rejects deletion while an Agent execution lease is active", async () => {
    const target = await workFixture();
    await withAgentExecutionLease(
      { agentId, sessionId: "live-delete-conflict" },
      async () => {
        const response = await remove(target.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: expect.any(String),
        });
      },
    );
    expect(
      await db.conversation.findUnique({
        where: { id: target.conversationId },
      }),
    ).not.toBeNull();
  });

  it("rejects deletion while the shared sandbox has active file or terminal access", async () => {
    const sandbox = await sandboxFixture();
    const target = await workFixture({ sandboxId: sandbox.id });
    const release = beginAgentConversationSandboxAccess(sandbox.id);
    try {
      const response = await remove(target.id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
      });
      expect(
        await db.workSession.findUnique({ where: { id: target.id } }),
      ).not.toBeNull();
      expect(
        await db.sandbox.findUnique({ where: { id: sandbox.id } }),
      ).not.toBeNull();
    } finally {
      release();
    }
  });

  it("does not silently truncate an Agent's long list", async () => {
    const conversations = await db.conversation.createManyAndReturn({
      data: Array.from({ length: 105 }, () => ({ agentId: peerAgentId })),
    });
    await db.workSession.createMany({
      data: conversations.map((conversation) => ({
        workspaceId,
        agentId: peerAgentId,
        conversationId: conversation.id,
        runtimeKind: "omp",
        status: "completed",
      })),
    });
    const listed = new Set(
      (await listWorkSessions(workspaceId, peerAgentId)).map(
        (work) => work.conversationId,
      ),
    );
    for (const conversation of conversations)
      expect(listed.has(conversation.id)).toBe(true);
  });

  it.skipIf(process.env.SANDBOX_DOCKER_SMOKE !== "1")(
    "cleans only the target's real Docker workspace and attachment files while retaining the shared container",
    async () => {
      const sandbox = await sandboxFixture();
      liveSandboxes.push(sandbox.id);
      const target = await workFixture({ sandboxId: sandbox.id });
      const peer = await workFixture({ sandboxId: sandbox.id });
      const directory = (id: string) =>
        agentSessionWorkspaceRoot({ conversationId: id }).slice(
          "/workspace/".length,
        );
      const volume = sandboxVolumeName(sandbox.id);
      // A missing saved volume must fail closed and retain deletion intent,
      // not erase database history or silently recreate an empty workspace.
      expect((await remove(target.id)).status).toBe(409);
      expect(
        await db.workSession.findUnique({ where: { id: target.id } }),
      ).toMatchObject({ conversationId: target.conversationId });
      expect(
        await db.sandbox.findUnique({ where: { id: sandbox.id } }),
      ).toMatchObject({
        config: { pendingWorkspaceDeletes: [target.conversationId] },
      });
      await createDockerVolume(volume);
      await volumeShell(
        volume,
        'mkdir -p "/data/$1/.toolplane/history" "/data/$2"; printf target > "/data/$1/.toolplane/history/session.jsonl"; printf peer > "/data/$2/keep.txt"; printf shared > /data/shared.txt',
        [directory(target.conversationId), directory(peer.conversationId)],
      );
      await docker([
        "run",
        "-d",
        "--name",
        sandboxContainerName(sandbox.id),
        "--network",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/workspace`,
        "alpine:3.20",
        "sleep",
        "300",
      ]);
      const attachment = async (conversationId: string, filename: string) => {
        const stored = await writeWorkspaceAttachment({
          workspaceId,
          filename,
          body: new Blob([filename]).stream(),
          maxBytes: 100,
        });
        return db.workspaceAttachment.create({
          data: {
            workspaceId,
            uploadedById: ownerId,
            conversationId,
            name: filename,
            mimeType: "text/plain",
            storagePath: stored.storagePath,
            size: stored.size,
          },
        });
      };
      const targetAttachment = await attachment(
        target.conversationId,
        "target.txt",
      );
      const peerAttachment = await attachment(peer.conversationId, "peer.txt");

      expect((await remove(target.id)).status).toBe(204);
      expect(
        await db.workSession.findUnique({ where: { id: target.id } }),
      ).toBeNull();
      expect(
        await db.workspaceAttachment.findUnique({
          where: { id: targetAttachment.id },
        }),
      ).toBeNull();
      expect(
        await db.workSession.findUnique({ where: { id: peer.id } }),
      ).toMatchObject({ sandboxId: sandbox.id });
      expect(
        await db.sandbox.findUnique({ where: { id: sandbox.id } }),
      ).toMatchObject({ config: { pendingWorkspaceDeletes: [] } });
      expect(
        await db.deployment.findUnique({ where: { id: sandbox.deploymentId } }),
      ).toMatchObject({ status: "stopped" });
      expect(
        await docker([
          "inspect",
          "--format",
          "{{.State.Running}}",
          sandboxContainerName(sandbox.id),
        ]),
      ).toBe("true");
      expect(
        await volumeShell(
          volume,
          'test ! -e "/data/$1"; cat "/data/$2/keep.txt" /data/shared.txt',
          [directory(target.conversationId), directory(peer.conversationId)],
        ),
      ).toBe("peershared");
      expect(
        await volumeShell(
          workspaceAttachmentVolumeName(workspaceId),
          'test ! -e "/data/$1"; cat "/data/$2"',
          [targetAttachment.storagePath, peerAttachment.storagePath],
        ),
      ).toBe("peer.txt");
    },
    120_000,
  );
});
