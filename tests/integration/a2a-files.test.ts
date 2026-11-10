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
import {
  DEFAULT_A2A_FILE_BYTES,
  DEFAULT_TRANSPORT_POLICY,
} from "@/lib/transport-policy";
import { TRANSPORT_SETTINGS_KEY } from "@/lib/admin/transport-settings";
const io = vi.hoisted(() => ({
  blobs: new Map<string, Uint8Array>(),
  remove: vi.fn(),
  gate: null as null | Promise<void>,
  entered: null as null | (() => void),
}));
vi.mock("@/lib/attachments/storage", async (original) => {
  const actual = await original<typeof AttachmentStorage>();
  return {
    ...actual,
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
        if (bytes.length > input.maxBytes)
          throw new actual.AttachmentTooLargeError(input.maxBytes);
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
  };
});
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
} from "@/lib/a2a/files";
import { submitTask } from "@/lib/a2a/store";
let user: string;
let originalTransportSetting: string | undefined;
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
      sourceKey: `input:${randomUUID()}`,
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
  originalTransportSetting = (
    await db.systemSetting.findUnique({
      where: { key: TRANSPORT_SETTINGS_KEY },
    })
  )?.value;
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
  await db.systemSetting.deleteMany({ where: { key: TRANSPORT_SETTINGS_KEY } });
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
  await db.systemSetting.deleteMany({ where: { key: TRANSPORT_SETTINGS_KEY } });
  if (originalTransportSetting !== undefined)
    await db.systemSetting.create({
      data: { key: TRANSPORT_SETTINGS_KEY, value: originalTransportSetting },
    });
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
      if (scope === "task") await seed(a.id, 9, DEFAULT_A2A_FILE_BYTES);
      else {
        for (let i = 0; i < 6; i++) {
          const t = await task();
          await seed(t.id, i === 5 ? 1 : 20, DEFAULT_A2A_FILE_BYTES);
        }
      }
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { promise: entered, resolve: markEntered } =
        Promise.withResolvers<void>();
      io.gate = gate;
      io.entered = markEntered;
      const first = storeTaskFile(
        a.id,
        "input:one",
        "a.txt",
        "text/plain",
        body(),
      );
      try {
        await entered;
        await expect(
          storeTaskFile(
            b.id,
            "input:two",
            "b.txt",
            "text/plain",
            new Blob([new Uint8Array(5 * 1024 * 1024)]).stream(),
          ),
        ).rejects.toThrow();
      } finally {
        release();
      }
      await first;
    },
  );
  it("applies file size changes to storage while retaining ready files and total quotas", async () => {
    const setLimit = (mib: number) =>
      db.systemSetting.upsert({
        where: { key: TRANSPORT_SETTINGS_KEY },
        create: {
          key: TRANSPORT_SETTINGS_KEY,
          value: JSON.stringify({
            ...DEFAULT_TRANSPORT_POLICY,
            a2aFileBytes: mib * 1024 ** 2,
          }),
        },
        update: {
          value: JSON.stringify({
            ...DEFAULT_TRANSPORT_POLICY,
            a2aFileBytes: mib * 1024 ** 2,
          }),
        },
      });
    const t = await task();
    const large = new Uint8Array(12 * 1024 ** 2);
    large[large.length - 1] = 42;
    const stream = () => new Blob([large]).stream();
    await expect(
      storeTaskFile(
        t.id,
        "large",
        "large.bin",
        "application/octet-stream",
        stream(),
      ),
    ).rejects.toThrow();
    await setLimit(25);
    const file = await storeTaskFile(
      t.id,
      "large",
      "large.bin",
      "application/octet-stream",
      stream(),
    );
    expect(file.size).toBe(large.byteLength);
    await setLimit(1);
    const opened = await openTaskFile(t.id, file.id);
    expect(
      Buffer.from(await new Response(opened.body).arrayBuffer()).equals(
        Buffer.from(large.buffer),
      ),
    ).toBe(true);
    await expect(
      storeTaskFile(
        t.id,
        "new",
        "new.bin",
        "application/octet-stream",
        stream(),
      ),
    ).rejects.toThrow();
    await setLimit(100);
    const next = await storeTaskFile(
      t.id,
      "small",
      "small.txt",
      "text/plain",
      body("after large file"),
    );
    expect(
      await new Response((await openTaskFile(t.id, next.id)).body).text(),
    ).toBe("after large file");
  });

  it("retains an active reservation when the administrator lowers the file limit", async () => {
    const t = await task();
    await seed(t.id, 6, DEFAULT_A2A_FILE_BYTES);
    await db.systemSetting.create({
      data: {
        key: TRANSPORT_SETTINGS_KEY,
        value: JSON.stringify({
          ...DEFAULT_TRANSPORT_POLICY,
          a2aFileBytes: 40 * 1024 ** 2,
        }),
      },
    });
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: markEntered } =
      Promise.withResolvers<void>();
    io.gate = gate;
    io.entered = markEntered;
    const first = storeTaskFile(
      t.id,
      "input:first",
      "a.txt",
      "text/plain",
      body(),
    );
    try {
      await entered;
      await db.systemSetting.update({
        where: { key: TRANSPORT_SETTINGS_KEY },
        data: {
          value: JSON.stringify({
            ...DEFAULT_TRANSPORT_POLICY,
            a2aFileBytes: DEFAULT_A2A_FILE_BYTES,
          }),
        },
      });
      await expect(
        storeTaskFile(t.id, "input:second", "b.txt", "text/plain", body()),
      ).rejects.toThrow("Task input files exceed the 100 MiB total limit.");
    } finally {
      release();
    }
    await first;
  });

  it("limits only admitted input bytes per task and reports the exceeded limit", async () => {
    const t = await task();
    await seed(t.id, 9, DEFAULT_A2A_FILE_BYTES);
    await seed(t.id, 1, 5 * 1024 ** 2);
    const sixMiB = () => new Blob([new Uint8Array(6 * 1024 ** 2)]).stream();
    await expect(
      storeTaskFile(t.id, "input:over", "in.bin", "text/plain", sixMiB()),
    ).rejects.toThrow("Task input files exceed the 100 MiB total limit.");
    expect(
      (
        await db.a2ATaskFile.findUniqueOrThrow({
          where: {
            taskId_sourceKey: { taskId: t.id, sourceKey: "input:over" },
          },
        })
      ).errorCode,
    ).toBe("TASK_INPUT_BYTES_EXCEEDED");
    for (const key of ["artifact:a:0", "artifact:a:1"])
      expect(
        (await storeTaskFile(t.id, key, "out.bin", "text/plain", sixMiB()))
          .size,
      ).toBe(6 * 1024 ** 2);
    await expect(
      storeTaskFile(
        t.id,
        "artifact:big:0",
        "big.bin",
        "text/plain",
        new Blob([new Uint8Array(DEFAULT_A2A_FILE_BYTES + 1)]).stream(),
      ),
    ).rejects.toThrow("File exceeds the 10 MiB per-file limit.");
  });

  it("applies administrator task input and file count limits", async () => {
    const t = await task();
    await seed(t.id, 9, DEFAULT_A2A_FILE_BYTES);
    await seed(t.id, 1, 5 * 1024 ** 2);
    await db.systemSetting.create({
      data: {
        key: TRANSPORT_SETTINGS_KEY,
        value: JSON.stringify({
          ...DEFAULT_TRANSPORT_POLICY,
          a2aTaskInputBytes: 200 * 1024 ** 2,
          a2aTaskFiles: 11,
        }),
      },
    });
    const sixMiB = () => new Blob([new Uint8Array(6 * 1024 ** 2)]).stream();
    expect(
      (
        await storeTaskFile(
          t.id,
          "input:more",
          "in.bin",
          "text/plain",
          sixMiB(),
        )
      ).size,
    ).toBe(6 * 1024 ** 2);
    await expect(
      storeTaskFile(t.id, "artifact:a:0", "out.bin", "text/plain", body()),
    ).rejects.toThrow("Task files exceed the 11-file limit.");
  });

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
