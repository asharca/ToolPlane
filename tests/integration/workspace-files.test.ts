// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Part, TaskState } from "@a2a-js/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as downloadAttachment } from "@/app/api/v1/attachments/[attachmentId]/route";
import { DELETE, GET } from "@/app/api/v1/workspaces/[slug]/files/route";
import { cleanupTaskFiles, hydrateTaskParts } from "@/lib/a2a/files";
import { hydrateWorkspaceAttachmentMessages } from "@/lib/attachments/messages";
import {
  attachmentObjectPath,
  deleteWorkspaceAttachmentFile,
} from "@/lib/attachments/storage";
import { cleanupAttachmentUploads } from "@/lib/attachments/uploads";
import { materializeConversationAttachments } from "@/lib/attachments/work";
import { createApiToken } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { getUserQuotaSummary } from "@/lib/storage/user-quota";
import type { WorkspaceFileRef } from "@/lib/storage/workspace-files";

vi.mock("next/headers", () => ({ cookies: async () => new Map() }));
vi.mock(import("@/lib/attachments/storage"), async (original) => ({
  ...(await original()),
  deleteWorkspaceAttachmentFile: vi.fn(),
}));
const removeFile = vi.mocked(deleteWorkspaceAttachmentFile);

let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let memberId: string;
let ownerToken: string;
let memberToken: string;
let contextId: string;
let agentId: string;
const createdAt = new Date("2025-11-10T12:34:56.789Z");
const expiresAt = () => new Date(Date.now() + 60 * 60_000);

function request(
  method: "GET" | "DELETE",
  token?: string,
  query = "",
  body?: unknown,
) {
  return new Request(
    `http://localhost/api/v1/workspaces/${workspaceId}/files${query}`,
    {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

function params() {
  return { params: Promise.resolve({ slug: workspaceId }) };
}

function list(token: string, query = "") {
  return GET(request("GET", token, query), params());
}

function remove(token: string, files: WorkspaceFileRef[]) {
  return DELETE(request("DELETE", token, "", { files }), params());
}

function attachment(
  data: {
    uploadedById?: string;
    workspaceId?: string;
    size?: number;
    chatThreadId?: string;
    conversationId?: string;
  } = {},
) {
  return db.workspaceAttachment.create({
    data: {
      workspaceId,
      uploadedById: ownerId,
      name: "notes.txt",
      mimeType: "text/plain",
      storagePath: attachmentObjectPath(randomUUID(), "notes.txt"),
      size: 40,
      createdAt,
      ...data,
    },
  });
}

async function taskFile(state: TaskState = TaskState.TASK_STATE_COMPLETED) {
  const task = await db.a2ATask.create({
    data: {
      contextId,
      state,
      phase: state === TaskState.TASK_STATE_WORKING ? "executing" : "done",
      snapshot: {},
      request: {},
      grant: {},
      deadlineAt: expiresAt(),
    },
  });
  const file = await db.a2ATaskFile.create({
    data: {
      workspaceId,
      taskId: task.id,
      sourceKey: `fixture:${randomUUID()}`,
      filename: "output.txt",
      mimeType: "text/plain",
      status: "ready",
      storagePath: attachmentObjectPath(randomUUID(), "output.txt"),
      size: 40,
      sha256: "a".repeat(64),
      createdAt,
      expiresAt: expiresAt(),
    },
  });
  return { ...file, taskId: task.id };
}

beforeEach(async () => {
  removeFile.mockReset();
  removeFile.mockResolvedValue(undefined);
  const owner = await db.user.create({
    data: {
      email: `${randomUUID()}@test.invalid`,
      name: "File owner",
      passwordHash: "x",
      storageQuotaBytes: BigInt(1_000_000),
    },
  });
  ownerId = owner.id;
  memberId = (
    await db.user.create({
      data: { email: `${randomUUID()}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  ownerToken = (await createApiToken(ownerId, "workspace files owner")).token;
  memberToken = (await createApiToken(memberId, "workspace files member"))
    .token;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `files-${randomUUID()}`,
        name: "Workspace files",
        ownerId,
        members: { create: { userId: memberId, role: "member" } },
      },
    })
  ).id;
  otherWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `files-${randomUUID()}`,
        name: "Another workspace",
        ownerId,
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "file-agent",
        name: "File agent",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
  contextId = (
    await db.a2AContext.create({
      data: {
        workspaceId,
        agentId,
        targetKind: "local",
        targetBinding: `local:${agentId}`,
        ownerKey: ownerId,
        expiresAt: expiresAt(),
      },
    })
  ).id;
});

afterEach(async () => {
  const ids = [workspaceId, otherWorkspaceId];
  await db.a2ATaskFile.deleteMany({ where: { workspaceId: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { workspaceId: { in: ids } } });
  await db.workspace.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
});

describe("workspace file management", () => {
  it("lists both kinds with owner-wide and workspace-only usage", async () => {
    const note = await attachment();
    const output = await taskFile();
    await attachment({ workspaceId: otherWorkspaceId, size: 60 });
    const response = await list(ownerToken);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.files).toHaveLength(2);
    expect(data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: note.id,
          kind: "attachment",
          uploader: { id: ownerId, name: "File owner" },
          canDelete: true,
        }),
        expect.objectContaining({
          id: output.id,
          kind: "a2a",
          uploader: null,
          source: expect.objectContaining({
            type: "a2aTask",
            id: output.taskId,
          }),
          canDelete: true,
        }),
      ]),
    );
    expect(data.usage).toEqual({
      workspaceBytes: 80,
      owner: { usedBytes: 140, storageQuotaBytes: 1_000_000 },
    });
    expect(
      (await (await list(ownerToken, "?kind=a2a")).json()).files,
    ).toMatchObject([{ id: output.id }]);
    expect(
      (await (await list(ownerToken, "?kind=attachment")).json()).files,
    ).toMatchObject([{ id: note.id }]);
  });

  it.each(["size", "createdAt"])(
    "paginates stably across equal %s values",
    async (sort) => {
      const ids = [
        (await attachment()).id,
        (await taskFile()).id,
        (await attachment()).id,
      ];
      const expected = ids.sort().reverse();
      let cursor: string | null = null;
      for (const id of expected) {
        const query = new URLSearchParams({ sort, limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await list(ownerToken, `?${query}`);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.files.map((file: { id: string }) => file.id)).toEqual([id]);
        cursor = data.nextCursor;
        if (id !== expected.at(-1)) expect(cursor).toEqual(expect.any(String));
      }
      expect(cursor).toBeNull();
    },
  );

  it("lets members list all files but delete only their own attachments", async () => {
    const mine = {
      kind: "attachment",
      id: (await attachment({ uploadedById: memberId })).id,
    } as const;
    const theirs = { kind: "attachment", id: (await attachment()).id } as const;
    const a2a = { kind: "a2a", id: (await taskFile()).id } as const;
    const data = await (await list(memberToken)).json();
    expect(data.usage).toEqual({ workspaceBytes: 120, owner: null });
    expect(data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...mine, canDelete: true }),
        expect.objectContaining({
          ...theirs,
          canDelete: false,
          deleteBlockedReason: "forbidden",
        }),
        expect.objectContaining({
          ...a2a,
          canDelete: false,
          deleteBlockedReason: "forbidden",
        }),
      ]),
    );
    const response = await remove(memberToken, [mine, theirs, a2a]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: [mine],
      failed: [
        { ...theirs, code: "forbidden" },
        { ...a2a, code: "forbidden" },
      ],
    });
    expect(removeFile).toHaveBeenCalledTimes(1);
  });

  it("blocks running-task files and hides cross-workspace IDs", async () => {
    const running = {
      kind: "a2a",
      id: (await taskFile(TaskState.TASK_STATE_WORKING)).id,
    } as const;
    const outside = {
      kind: "attachment",
      id: (await attachment({ workspaceId: otherWorkspaceId })).id,
    } as const;
    const data = await (await list(ownerToken)).json();
    expect(data.files).toMatchObject([
      { ...running, canDelete: false, deleteBlockedReason: "in_use" },
    ]);
    expect(await (await remove(ownerToken, [running, outside])).json()).toEqual(
      {
        deleted: [],
        failed: [
          { ...running, code: "in_use" },
          { ...outside, code: "not_found" },
        ],
      },
    );
    expect(removeFile).not.toHaveBeenCalled();
  });

  it("releases quota, audits success and preserves historical messages", async () => {
    const assistant = await db.chatAssistant.create({
      data: { workspaceId, name: "Assistant" },
    });
    const thread = await db.chatThread.create({
      data: { workspaceId, assistantId: assistant.id },
    });
    const conversation = await db.conversation.create({ data: { agentId } });
    const note = await attachment({
      chatThreadId: thread.id,
      uploadedById: memberId,
    });
    const workFile = await attachment({ conversationId: conversation.id });
    const output = await taskFile();
    const turn = await db.chatTurn.create({ data: { threadId: thread.id } });
    const parts = [
      { type: "text", text: "Keep this" },
      { type: "file", url: `/api/v1/attachments/${note.id}` },
    ];
    const message = await db.chatMessage.create({
      data: { threadId: thread.id, turnId: turn.id, role: "user", parts },
    });
    const workParts = [
      { type: "file", url: `/api/v1/attachments/${workFile.id}` },
    ];
    const workMessage = await db.message.create({
      data: { conversationId: conversation.id, role: "user", parts: workParts },
    });
    const fileRefs: WorkspaceFileRef[] = [
      { kind: "attachment", id: note.id },
      { kind: "attachment", id: workFile.id },
      { kind: "a2a", id: output.id },
    ];
    expect((await getUserQuotaSummary(ownerId)).usedBytes).toBe(120);
    const response = await remove(ownerToken, fileRefs);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: fileRefs, failed: [] });
    expect((await getUserQuotaSummary(ownerId)).usedBytes).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          actorId: ownerId,
          workspaceId,
          action: "workspace.file.deleted",
          targetId: { in: fileRefs.map(({ id }) => id) },
        },
      }),
    ).toBe(3);
    const download = await downloadAttachment(
      new Request(`http://localhost/api/v1/attachments/${note.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      { params: Promise.resolve({ attachmentId: note.id }) },
    );
    expect(download.status).toBe(404);
    expect(
      (await db.chatMessage.findUnique({ where: { id: message.id } }))?.parts,
    ).toEqual(parts);
    expect(
      (await db.message.findUnique({ where: { id: workMessage.id } }))?.parts,
    ).toEqual(workParts);
    await expect(
      hydrateWorkspaceAttachmentMessages([{ role: "user", parts }], {
        workspaceId,
        scope: { chatThreadId: thread.id },
      }),
    ).resolves.toMatchObject([
      { parts: [{ text: "Keep this" }, { type: "text" }] },
    ]);
    await expect(
      materializeConversationAttachments({
        workspaceId,
        conversationId: conversation.id,
        volumeName: "unused",
        workspaceRoot: "/workspace",
      }),
    ).resolves.toBeUndefined();
    const taskPart = Part.fromJSON({
      data: { toolplaneFileId: output.id },
      metadata: { toolplaneFileId: output.id },
    });
    await expect(
      hydrateTaskParts(output.taskId, [taskPart], "https://test.invalid"),
    ).resolves.toEqual([taskPart]);
  });

  it("keeps failed physical deletions charged until the sweepers retry", async () => {
    const note = await attachment();
    const output = await taskFile();
    const files: WorkspaceFileRef[] = [
      { kind: "attachment", id: note.id },
      { kind: "a2a", id: output.id },
    ];
    removeFile.mockRejectedValue(new Error("Storage unavailable"));
    expect(await (await remove(ownerToken, files)).json()).toEqual({
      deleted: [],
      failed: files.map((file) => ({ ...file, code: "storage_error" })),
    });
    expect((await getUserQuotaSummary(ownerId)).usedBytes).toBe(80);
    expect((await (await list(ownerToken)).json()).files).toEqual([]);
    removeFile.mockResolvedValue(undefined);
    await cleanupAttachmentUploads();
    await cleanupTaskFiles();
    expect(removeFile).toHaveBeenCalledWith(workspaceId, note.storagePath);
    expect(removeFile).toHaveBeenCalledWith(workspaceId, output.storagePath);
    expect((await getUserQuotaSummary(ownerId)).usedBytes).toBe(0);
    expect(
      await db.workspaceAttachment.findUnique({ where: { id: note.id } }),
    ).toBeNull();
    expect(
      await db.a2ATaskFile.findUnique({ where: { id: output.id } }),
    ).toBeNull();
  });

  it("requires authentication for both methods", async () => {
    const listResponse = await GET(request("GET"), params());
    const deleteResponse = await DELETE(
      request("DELETE", undefined, "", {
        files: [{ kind: "attachment", id: "missing" }],
      }),
      params(),
    );
    expect(listResponse.status).toBe(401);
    expect(deleteResponse.status).toBe(401);
  });
});
