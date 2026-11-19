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
import { DEFAULT_TRANSPORT_POLICY } from "@/lib/transport-policy";
import { createApiToken } from "@/lib/auth/tokens";
import { cleanupAttachmentUploads } from "@/lib/attachments/uploads";
import { getUserQuotaSummary } from "@/lib/storage/user-quota";
import { POST as upload } from "@/app/api/v1/workspaces/[slug]/attachments/route";
import { GET as download } from "@/app/api/v1/attachments/[attachmentId]/route";
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
        const storagePath = actual.attachmentObjectPath(
          input.objectId,
          input.filename,
        );
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
  hydrateTaskParts,
  makeTaskFilePart,
  openTaskFile,
  openTaskFileCapability,
  storeTaskFile,
  storeAdmittedTaskFile,
} from "@/lib/a2a/files";
import { submitTask } from "@/lib/a2a/store";
import { stageTaskFileTransfers } from "@/lib/a2a/task-files";
let user: string;
let authorization: string;
let originalTransportSetting: string | undefined;
const fixtures: { workspace: string; agent: string }[] = [];
const body = (value = "abc") => new Blob([value]).stream();
function uploadAttachment(workspaceId: string, value: string) {
  return upload(
    new Request(
      `http://localhost/api/v1/workspaces/${workspaceId}/attachments?filename=upload.txt`,
      {
        method: "POST",
        headers: { authorization, "content-type": "text/plain" },
        body: value,
      },
    ),
    { params: Promise.resolve({ slug: workspaceId }) },
  );
}

async function setQuota(bytes: number) {
  await db.user.update({
    where: { id: user },
    data: { storageQuotaBytes: BigInt(bytes) },
  });
}

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
  authorization = `Bearer ${(await createApiToken(user, "attachment fixture")).token}`;
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
  vi.stubEnv("TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES", "1048576");
  await db.user.update({
    where: { id: user },
    data: { storageQuotaBytes: null },
  });
  await db.workspaceAttachment.deleteMany({ where: { uploadedById: user } });
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
  it("preserves Unicode filenames through input admission and staging", async () => {
    const f = fixtures[0];
    const grant = await createLocalRootGrant(f.workspace, f.agent, user);
    const filename = "2026年10月月报.docx";
    const t = await submitTask(
      grant,
      SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [
            {
              raw: Buffer.from("monthly report").toString("base64"),
              filename,
              mediaType: "text/plain",
            },
          ],
        },
        configuration: { returnImmediately: true },
      }),
    );
    expect(await stageTaskFileTransfers(t.id)).toBe(true);
    const file = await db.a2ATaskFile.findFirstOrThrow({
      where: { taskId: t.id },
    });
    expect(file.filename).toBe(filename);
    expect(
      await new Response((await openTaskFile(t.id, file.id)).body).text(),
    ).toBe("monthly report");
  });
  it("preserves Unicode protocol filenames while using safe storage paths", async () => {
    const t = await task();
    const filename = "2026年10月月报.docx";
    const file = await storeTaskFile(
      t.id,
      "report",
      filename,
      "text/plain",
      body(),
    );
    expect(file.filename).toBe(filename);
    expect(file.storagePath).toMatch(/^objects\/[0-9a-f-]+-2026-10-\.docx$/);
    const [part] = await hydrateTaskParts(
      t.id,
      [makeTaskFilePart(file)],
      "https://tp.example",
    );
    expect(part.filename).toBe(filename);
    const url = new URL(
      part.content?.$case === "url" ? part.content.value : "",
    );
    const expires = url.searchParams.get("expires");
    const signature = url.searchParams.get("signature");
    if (!expires || !signature) throw new Error("Missing file capability");
    const opened = await openTaskFileCapability(
      file.id,
      t.id,
      expires,
      signature,
    );
    expect(await new Response(opened.body).text()).toBe("abc");
    await expect(
      storeTaskFile(t.id, "report", "2026-10-.docx", "text/plain", body()),
    ).rejects.toThrow("different content");
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
  it("charges A2A and conversation attachments in different workspaces to the same owner's quota", async () => {
    await setQuota(6);
    const attachment = await uploadAttachment(fixtures[0].workspace, "abc");
    expect(attachment.status).toBe(201);
    const t = await task(1);
    expect(
      (await storeTaskFile(t.id, "artifact:1", "a.txt", "text/plain", body()))
        .size,
    ).toBe(3);
    const summary = await getUserQuotaSummary(user);
    expect(summary).toMatchObject({
      usedBytes: 6,
      ownedWorkspaces: 2,
      storageQuotaBytes: 6,
      overrides: { storageQuotaBytes: 6, maxOwnedWorkspaces: null },
    });
    const denied = await uploadAttachment(fixtures[1].workspace, "a");
    expect(denied.status).toBe(413);
    expect(await denied.json()).toEqual({
      error: "Storage quota exceeded.",
      code: "STORAGE_QUOTA_EXCEEDED",
    });
    // The ready replay is not a new write and is still checked against its content.
    expect(
      (await storeTaskFile(t.id, "artifact:1", "a.txt", "text/plain", body()))
        .size,
    ).toBe(3);
    await expect(
      storeTaskFile(t.id, "artifact:2", "b.txt", "text/plain", body()),
    ).rejects.toThrow("Storage quota exceeded.");
  });

  it("cannot overcommit quota when both workspace uploads start together", async () => {
    await setQuota(5);
    const results = await Promise.all([
      uploadAttachment(fixtures[0].workspace, "abc"),
      uploadAttachment(fixtures[1].workspace, "def"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 413,
    ]);
    expect((await getUserQuotaSummary(user)).usedBytes).toBe(3);
  });

  it("reserves owner quota across in-flight uploads in different workspaces", async () => {
    await setQuota(5);
    const t = await task(1);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: markEntered } =
      Promise.withResolvers<void>();
    io.gate = gate;
    io.entered = markEntered;
    const first = uploadAttachment(fixtures[0].workspace, "abc");
    try {
      await entered;
      const uploading = await db.workspaceAttachment.findFirstOrThrow({
        where: { workspaceId: fixtures[0].workspace, status: "uploading" },
      });
      const invisible = await download(
        new Request("http://localhost/api/v1/attachments/file", {
          headers: { authorization },
        }),
        { params: Promise.resolve({ attachmentId: uploading.id }) },
      );
      expect(invisible.status).toBe(404);
      expect((await getUserQuotaSummary(user)).usedBytes).toBe(5);
      await expect(
        storeTaskFile(t.id, "artifact:2", "b.txt", "text/plain", body()),
      ).rejects.toThrow("Storage quota exceeded.");
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect((await getUserQuotaSummary(user)).usedBytes).toBe(3);
    expect(
      (
        await storeTaskFile(
          t.id,
          "artifact:2",
          "b.txt",
          "text/plain",
          body("ab"),
        )
      ).size,
    ).toBe(2);
  });

  it("aborts an A2A write at the remaining quota and releases its reservation", async () => {
    await setQuota(3);
    const t = await task();
    await expect(
      storeTaskFile(t.id, "input:over", "in.bin", "text/plain", body("four")),
    ).rejects.toThrow("Storage quota exceeded.");
    const failed = await db.a2ATaskFile.findUniqueOrThrow({
      where: { taskId_sourceKey: { taskId: t.id, sourceKey: "input:over" } },
    });
    expect(failed).toMatchObject({
      errorCode: "STORAGE_QUOTA_EXCEEDED",
      storagePath: null,
    });
    expect((await getUserQuotaSummary(user)).usedBytes).toBe(0);
    expect((await uploadAttachment(fixtures[0].workspace, "four")).status).toBe(
      413,
    );
    expect(
      await db.workspaceAttachment.count({ where: { uploadedById: user } }),
    ).toBe(0);
    expect((await uploadAttachment(fixtures[0].workspace, "abc")).status).toBe(
      201,
    );
  });

  it("bounds A2A ready-file comparison by the attachment hard limit", async () => {
    const t = await task();
    const key = "artifact:ready";
    await storeTaskFile(t.id, key, "out.txt", "text/plain", body());
    vi.stubEnv("TOOLPLANE_ATTACHMENT_HARD_MAX_BYTES", "2");
    await expect(
      storeTaskFile(t.id, key, "out.txt", "text/plain", body()),
    ).rejects.toMatchObject({
      metadata: { toolplaneFileLimit: "FILE_TOO_LARGE" },
    });
  });

  it("reclaims a stale attachment reservation but not a ready file", async () => {
    const workspaceId = fixtures[0].workspace;
    const response = await uploadAttachment(workspaceId, "abc");
    expect(response.status).toBe(201);
    const path = `objects/${randomUUID()}-interrupted.txt`;
    io.blobs.set(`${workspaceId}/${path}`, Buffer.from("abc"));
    const stale = await db.workspaceAttachment.create({
      data: {
        workspaceId,
        uploadedById: user,
        name: "interrupted.txt",
        mimeType: "text/plain",
        storagePath: path,
        size: 10,
        status: "uploading",
        uploadStartedAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    });
    expect((await getUserQuotaSummary(user)).usedBytes).toBe(13);
    await cleanupAttachmentUploads();
    expect(
      await db.workspaceAttachment.findUnique({ where: { id: stale.id } }),
    ).toBeNull();
    expect(io.blobs.has(`${workspaceId}/${path}`)).toBe(false);
    expect((await getUserQuotaSummary(user)).usedBytes).toBe(3);
  });

  it("applies the administrator task file count limit", async () => {
    const t = await task();
    await seed(t.id, 10, 1);
    await db.systemSetting.create({
      data: {
        key: TRANSPORT_SETTINGS_KEY,
        value: JSON.stringify({
          ...DEFAULT_TRANSPORT_POLICY,
          a2aTaskFiles: 11,
        }),
      },
    });
    expect(
      (await storeTaskFile(t.id, "input:more", "in.bin", "text/plain", body()))
        .size,
    ).toBe(3);
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
