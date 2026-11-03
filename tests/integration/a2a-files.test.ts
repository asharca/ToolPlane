// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { db } from "@/lib/db";
import { createLocalRootGrant } from "@/lib/a2a/local-policy";
import type * as AttachmentStorage from "@/lib/attachments/storage";
import type * as RuntimeOwnership from "@/lib/runtime/ownership-state";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
import { encryptSecretText } from "@/lib/security/secrets";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
const io = vi.hoisted(() => ({
  blobs: new Map<string, Uint8Array>(),
  remove: vi.fn(),
  gate: null as null | Promise<void>,
  entered: null as null | (() => void),
}));
vi.mock("@/lib/attachments/storage", async (original) => ({
  ...(await original<typeof AttachmentStorage>()),
  writeWorkspaceAttachment: vi.fn(
    async (input: {
      workspaceId: string;
      objectId: string;
      filename: string;
      body: ReadableStream<Uint8Array>;
      maxBytes: number;
    }) => {
      const bytes = new Uint8Array(
        await new Response(input.body).arrayBuffer(),
      );
      if (bytes.length > input.maxBytes) throw new Error("File too large");
      io.entered?.();
      if (io.gate) await io.gate;
      const storagePath = `objects/${input.objectId}-${input.filename}`;
      io.blobs.set(`${input.workspaceId}/${storagePath}`, bytes);
      return {
        storagePath,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  ),
  readWorkspaceAttachment: (workspace: string, path: string) => {
    const bytes = io.blobs.get(`${workspace}/${path}`);
    if (!bytes) throw new Error("Stored attachment missing");
    return new Blob([Uint8Array.from(bytes)]).stream();
  },
  deleteWorkspaceAttachmentFile: async (workspace: string, path: string) => {
    await io.remove();
    io.blobs.delete(`${workspace}/${path}`);
  },
}));
vi.mock("@/lib/agents/execution/worker", () => ({ wakeAgentWorker: vi.fn() }));
vi.mock("@/lib/runtime/ownership-state", async (original) => ({
  ...(await original<typeof RuntimeOwnership>()),
  assertRuntimeOwner: vi.fn(),
}));
import {
  cleanupTaskFiles,
  copyTaskFile,
  createTaskFileUrl,
  openTaskFile,
  openTaskFileCapability,
  storeTaskFile,
  storeAdmittedTaskFile,
  TASK_FILE_LIMITS,
} from "@/lib/a2a/files";
import { submitTask } from "@/lib/a2a/store";
let user: string;
const fixtures: { workspace: string; agent: string }[] = [];
const body = (value = "abc") => new Blob([value]).stream();
async function task(index = 0) {
  const f = fixtures[index];
  const grant = await createLocalRootGrant(f.workspace, f.agent, user);
  return submitTask(
    grant,
    SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: "file fixture" }],
      },
      configuration: { returnImmediately: true },
    }),
  );
}
async function seed(
  taskId: string,
  count: number,
  bytes: number,
  workspace = fixtures[0].workspace,
) {
  await db.a2ATaskFile.createMany({
    data: Array.from({ length: count }, () => ({
      taskId,
      workspaceId: workspace,
      sourceKey: randomUUID(),
      filename: "seed.txt",
      mimeType: "text/plain",
      status: "ready",
      storagePath: `objects/${randomUUID()}-seed.txt`,
      size: bytes,
      sha256: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3600000),
    })),
  });
}
beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "isolated-task-file-integration-secret");
  user = (
    await db.user.create({
      data: { email: `files-${randomUUID()}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  for (let i = 0; i < 2; i++) {
    const workspace = await db.workspace.create({
      data: {
        slug: `files-${randomUUID()}`,
        name: "File integration",
        ownerId: user,
      },
    });
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: workspace.id,
        name: "Fixture",
        format: "openai",
        baseUrl: "https://fixture.invalid",
        apiKey: "fixture",
      },
    });
    const deployment = await db.deployment.create({
      data: { workspaceId: workspace.id, name: "Fixture", source: "config" },
    });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId: workspace.id,
        deploymentId: deployment.id,
        name: "Fixture",
        slug: "fixture",
        kind: "docker",
        network: "isolated",
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: "Fixture",
        slug: "fixture",
        runtimeKind: "pi-sdk",
        providerId: provider.id,
        model: "fixture",
        a2aInboundEnabled: true,
        sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
      },
    });
    await publishFixtureAgentRevision(workspace.id, agent.id);
    fixtures.push({ workspace: workspace.id, agent: agent.id });
  }
});
beforeEach(async () => {
  io.blobs.clear();
  io.remove.mockReset();
  io.gate = null;
  io.entered = null;
  await db.a2ATaskFile.deleteMany({
    where: { workspaceId: { in: fixtures.map((f) => f.workspace) } },
  });
  await db.a2AContext.deleteMany({
    where: { workspaceId: { in: fixtures.map((f) => f.workspace) } },
  });
  await db.agent.updateMany({
    where: { id: { in: fixtures.map((f) => f.agent) } },
    data: { a2aInboundEnabled: true },
  });
});
afterAll(async () => {
  await db.a2ATaskFile.deleteMany({
    where: { workspaceId: { in: fixtures.map((f) => f.workspace) } },
  });
  for (const f of fixtures)
    await db.workspace.delete({ where: { id: f.workspace } });
  if (user) await db.user.delete({ where: { id: user } });
  vi.unstubAllEnvs();
});
describe("PostgreSQL task file invariants with streaming storage boundary", () => {
  it("writes admitted input with send-only authority without granting download or arbitrary writes", async () => {
    const t = await task();
    const grant = t.grant as unknown as LocalA2AGrant;
    await db.a2ATask.update({
      where: { id: t.id },
      data: {
        phase: "file-receiving",
        grant: JSON.parse(JSON.stringify({ ...grant, scopes: ["a2a:send"] })),
      },
    });
    const file = await db.a2ATaskFile.create({
      data: {
        taskId: t.id,
        workspaceId: fixtures[0].workspace,
        sourceKey: "admitted",
        filename: "input.txt",
        mimeType: "text/plain",
        source: encryptSecretText(
          JSON.stringify({
            taskId: t.id,
            sourceKey: "admitted",
            source: {
              kind: "raw",
              value: Buffer.from("abc").toString("base64"),
            },
          }),
        ),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await expect(
      storeAdmittedTaskFile(
        t.id,
        "unadmitted",
        "input.txt",
        "text/plain",
        body(),
      ),
    ).rejects.toThrow();
    await expect(
      storeAdmittedTaskFile(
        t.id,
        "admitted",
        "changed.txt",
        "text/plain",
        body(),
      ),
    ).rejects.toThrow();
    expect(
      (
        await storeAdmittedTaskFile(
          t.id,
          "admitted",
          "input.txt",
          "text/plain",
          body(),
        )
      ).id,
    ).toBe(file.id);
    await expect(openTaskFile(t.id, file.id)).rejects.toThrow();
    await expect(
      storeTaskFile(t.id, "other", "input.txt", "text/plain", body()),
    ).rejects.toThrow();
    await db.a2ATask.update({ where: { id: t.id }, data: { phase: "queued" } });
    await expect(
      storeAdmittedTaskFile(
        t.id,
        "admitted",
        "input.txt",
        "text/plain",
        body(),
      ),
    ).rejects.toThrow();
  });
  it("replays identical source identity and rejects changed bytes or metadata", async () => {
    const t = await task();
    const first = await storeTaskFile(
      t.id,
      "stable",
      "a.txt",
      "text/plain",
      body(),
    );
    expect(
      (await storeTaskFile(t.id, "stable", "a.txt", "text/plain", body())).id,
    ).toBe(first.id);
    await expect(
      storeTaskFile(t.id, "stable", "a.txt", "text/plain", body("changed")),
    ).rejects.toThrow("different content");
    await expect(
      storeTaskFile(t.id, "stable", "b.txt", "text/plain", body()),
    ).rejects.toThrow("different content");
    expect(await db.a2ATaskFile.count({ where: { taskId: t.id } })).toBe(1);
    expect(io.blobs.size).toBe(1);
  });
  it("rejects cross-task reads and unrelated or cross-workspace copies", async () => {
    const a = await task(),
      b = await task(),
      c = await task(1);
    const file = await storeTaskFile(
      a.id,
      "source",
      "a.txt",
      "text/plain",
      body(),
    );
    await expect(openTaskFile(b.id, file.id)).rejects.toThrow();
    await expect(openTaskFile(c.id, file.id)).rejects.toThrow();
    await expect(copyTaskFile(a.id, file.id, b.id, "copy")).rejects.toThrow();
    await expect(copyTaskFile(a.id, file.id, c.id, "copy")).rejects.toThrow();
  });
  it("serializes concurrent file-count reservations", async () => {
    const t = await task();
    await seed(t.id, 19, 0);
    const result = await Promise.allSettled([
      storeTaskFile(t.id, "one", "a.txt", "text/plain", body()),
      storeTaskFile(t.id, "two", "b.txt", "text/plain", body()),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.a2ATaskFile.count({ where: { taskId: t.id } })).toBe(20);
  });
  it.each(["task", "workspace"])(
    "serializes concurrent %s byte reservations",
    async (scope) => {
      const a = await task(),
        b = scope === "task" ? a : await task();
      if (scope === "task") await seed(a.id, 9, TASK_FILE_LIMITS.fileBytes);
      else {
        for (let i = 0; i < 6; i++) {
          const t = await task();
          await seed(t.id, i === 5 ? 1 : 20, TASK_FILE_LIMITS.fileBytes);
        }
      }
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { promise: entered, resolve: markEntered } =
        Promise.withResolvers<void>();
      io.gate = gate;
      io.entered = markEntered;
      const first = storeTaskFile(a.id, "one", "a.txt", "text/plain", body());
      try {
        await entered;
        await expect(
          storeTaskFile(b.id, "two", "b.txt", "text/plain", body()),
        ).rejects.toThrow("storage limit");
      } finally {
        release();
      }
      await first;
    },
  );
  it("binds capabilities to signature, expiry and live revocation without execution lease", async () => {
    const t = await task();
    const file = await storeTaskFile(
      t.id,
      "source",
      "a.txt",
      "text/plain",
      body(),
    );
    await db.a2ATask.update({
      where: { id: t.id },
      data: {
        state: TaskState.TASK_STATE_COMPLETED,
        phase: "done",
        leaseToken: null,
        deadlineAt: new Date(Date.now() - 1000),
      },
    });
    const url = new URL(
      await createTaskFileUrl(t.id, file.id, "https://tp.example"),
    );
    const expiry = url.searchParams.get("expires");
    const signature = url.searchParams.get("signature");
    if (!expiry || !signature) throw new Error("Missing file capability");
    const opened = await openTaskFileCapability(
      file.id,
      t.id,
      expiry,
      signature,
    );
    expect(await new Response(opened.body).text()).toBe("abc");
    await expect(
      openTaskFileCapability(
        file.id,
        t.id,
        expiry,
        `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`,
      ),
    ).rejects.toThrow();
    await expect(
      openTaskFileCapability(
        file.id,
        t.id,
        String(Date.now() - 1000),
        signature,
      ),
    ).rejects.toThrow();
    await db.agent.update({
      where: { id: fixtures[0].agent },
      data: { a2aInboundEnabled: false },
    });
    await expect(
      openTaskFileCapability(file.id, t.id, expiry, signature),
    ).rejects.toThrow();
  });
  it("retains SetNull orphan cleanup identity until physical deletion succeeds", async () => {
    const t = await task();
    const file = await storeTaskFile(
      t.id,
      "source",
      "a.txt",
      "text/plain",
      body(),
    );
    await db.a2ATask.delete({ where: { id: t.id } });
    expect(
      (await db.a2ATaskFile.findUniqueOrThrow({ where: { id: file.id } }))
        .taskId,
    ).toBeNull();
    io.remove.mockRejectedValueOnce(new Error("storage offline"));
    await expect(cleanupTaskFiles()).rejects.toThrow("storage offline");
    expect(
      (await db.a2ATaskFile.findUniqueOrThrow({ where: { id: file.id } }))
        .storagePath,
    ).toBe(file.storagePath);
    await cleanupTaskFiles();
    const cleaned = await db.a2ATaskFile.findUniqueOrThrow({
      where: { id: file.id },
    });
    expect(cleaned.storagePath).toBeNull();
    expect(cleaned.sha256).toBe(file.sha256);
    expect(io.blobs.size).toBe(0);
  });
});
