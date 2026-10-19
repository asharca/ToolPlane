// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Storage from "@/lib/attachments/storage";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  unlink: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: m.workspace },
    workspaceAttachment: {
      create: m.create,
      findFirst: m.find,
      deleteMany: m.remove,
    },
  },
}));
vi.mock("@/lib/attachments/storage", async (original) => ({
  ...(await original<typeof Storage>()),
  readWorkspaceAttachment: m.read,
  writeWorkspaceAttachment: m.write,
  deleteWorkspaceAttachmentFile: m.unlink,
}));
vi.mock("@/lib/agents/attachment-limits", () => ({
  maxAgentAttachmentBytes: async () => 100,
  formatAttachmentByteLimit: (n: number) => `${n} bytes`,
}));
vi.mock("@/lib/observability/system", () => ({ systemLog: m.log }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import {
  AttachmentStorageError,
  AttachmentTooLargeError,
  EmptyAttachmentError,
} from "@/lib/attachments/storage";
import { GET, DELETE } from "@/app/api/v1/attachments/[attachmentId]/route";
import { POST } from "@/app/api/v1/workspaces/[slug]/attachments/route";
const ctx = { params: Promise.resolve({ attachmentId: "attachment" }) };
const workspaceCtx = { params: Promise.resolve({ slug: "ws" }) };
const req = new Request("https://test/api");
const attachment = {
  id: "attachment",
  workspaceId: "ws",
  uploadedById: "user",
  chatThreadId: null,
  conversationId: null,
  name: "file.txt",
  mimeType: "text/plain",
  size: 3,
  storagePath: "file",
};
function upload(
  headers: Record<string, string | undefined> = {},
  filename = "file.txt",
  body: string | null = "abc",
) {
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) requestHeaders.set(name, value);
  }
  return new Request(
    `https://test/api?filename=${encodeURIComponent(filename)}`,
    { method: "POST", headers: requestHeaders, body },
  );
}
describe("workspace attachment transport failure boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.user.mockResolvedValue({ id: "user" });
    m.workspace.mockResolvedValue({ id: "ws" });
    m.find.mockResolvedValue(attachment);
    m.remove.mockResolvedValue({ count: 1 });
    m.read.mockReturnValue("abc");
    m.write.mockResolvedValue({ size: 3, storagePath: "file" });
    m.create.mockResolvedValue(attachment);
    m.unlink.mockResolvedValue(undefined);
  });
  it("requires authentication on every operation", async () => {
    m.user.mockResolvedValue(null);
    expect((await GET(req, ctx)).status).toBe(401);
    expect((await DELETE(req, ctx)).status).toBe(401);
    expect((await POST(upload(), workspaceCtx)).status).toBe(401);
    expect(m.find).not.toHaveBeenCalled();
    expect(m.workspace).not.toHaveBeenCalled();
  });
  it("conceals nonexistent and other users' unattached files", async () => {
    for (const value of [null, { ...attachment, uploadedById: "other" }]) {
      m.find.mockResolvedValue(value);
      expect((await GET(req, ctx)).status).toBe(404);
      expect((await DELETE(req, ctx)).status).toBe(404);
    }
    expect(m.read).not.toHaveBeenCalled();
  });
  it.each(["chatThreadId", "conversationId"])(
    "permits member reads of attached files but only uploader deletion (%s)",
    async (field) => {
      m.find.mockResolvedValue({
        ...attachment,
        uploadedById: "other",
        [field]: "thread",
      });
      expect((await GET(req, ctx)).status).toBe(200);
      expect((await DELETE(req, ctx)).status).toBe(404);
      m.find.mockResolvedValue({ ...attachment, [field]: "thread" });
      expect((await DELETE(req, ctx)).status).toBe(409);
      expect(m.remove).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects corrupt attachment size %s",
    async (size) => {
      m.find.mockResolvedValue({ ...attachment, size });
      expect((await GET(req, ctx)).status).toBe(500);
      expect(m.read).not.toHaveBeenCalled();
    },
  );
  it.each(["", "报告'(*)\\\".txt"])(
    "safely encodes download filename %s",
    async (name) => {
      m.find.mockResolvedValue({ ...attachment, name });
      const response = await GET(req, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("abc");
      expect(response.headers.get("content-disposition")).toContain(
        name
          ? "filename*=UTF-8''%E6%8A%A5%E5%91%8A%27%28%2A%29"
          : 'filename="attachment"',
      );
      expect(response.headers.get("content-length")).toBe("3");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );
  it("returns storage read failures as bad gateway", async () => {
    m.read.mockImplementation(() => {
      throw new Error("missing");
    });
    expect((await GET(req, ctx)).status).toBe(502);
  });
  it("detects a concurrent attachment use before deleting storage", async () => {
    m.remove.mockResolvedValue({ count: 0 });
    expect((await DELETE(req, ctx)).status).toBe(409);
    expect(m.unlink).not.toHaveBeenCalled();
  });
  it.each([new Error("storage failed"), "storage failed"])(
    "does not lose deletion success if cleanup fails %s",
    async (error) => {
      m.unlink.mockRejectedValue(error);
      expect((await DELETE(req, ctx)).status).toBe(204);
      expect(m.log).toHaveBeenCalledWith("error", expect.any(String), {
        attachmentId: "attachment",
        workspaceId: "ws",
        error: "storage failed",
      });
      expect(m.remove).toHaveBeenCalledWith({
        where: {
          id: "attachment",
          workspaceId: "ws",
          uploadedById: "user",
          chatThreadId: null,
          conversationId: null,
        },
      });
    },
  );
  it("rejects unavailable workspaces and multipart uploads", async () => {
    m.workspace.mockResolvedValueOnce(null);
    expect((await POST(upload(), workspaceCtx)).status).toBe(404);
    expect(
      (
        await POST(
          upload({ "content-type": "Multipart/Form-Data; boundary=x" }),
          workspaceCtx,
        )
      ).status,
    ).toBe(415);
  });
  it.each([
    { headers: {}, filename: "" },
    { headers: {}, filename: "x".repeat(241) },
    { headers: { "content-length": "-1" }, filename: "x" },
    { headers: { "content-length": "9007199254740992" }, filename: "x" },
  ])("rejects malformed upload metadata %j", async ({ headers, filename }) => {
    expect((await POST(upload(headers, filename), workspaceCtx)).status).toBe(
      400,
    );
    expect(m.write).not.toHaveBeenCalled();
  });
  it("rejects absent bodies and oversized declared files", async () => {
    expect((await POST(upload({}, "x", null), workspaceCtx)).status).toBe(400);
    expect(
      (await POST(upload({ "content-length": "101" }), workspaceCtx)).status,
    ).toBe(413);
    expect(m.write).not.toHaveBeenCalled();
  });
  it.each([
    { error: new AttachmentTooLargeError(100), status: 413 },
    { error: new EmptyAttachmentError(), status: 400 },
    { error: new AttachmentStorageError("secret"), status: 502 },
    { error: new Error("secret"), status: 502 },
  ])("maps streaming storage failure $status", async ({ error, status }) => {
    m.write.mockRejectedValue(error);
    const response = await POST(upload(), workspaceCtx);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("secret");
    expect(m.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "invalid", "text/plain; charset=utf-8"])(
    "normalizes mime type %s for saved metadata",
    async (mime) => {
      const response = await POST(
        upload(mime ? { "content-type": mime } : {}),
        workspaceCtx,
      );
      expect(response.status).toBe(201);
      expect(m.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws",
          uploadedById: "user",
          name: "file.txt",
          mimeType:
            mime === "text/plain; charset=utf-8" || mime === undefined
              ? "text/plain"
              : "application/octet-stream",
          size: 3,
          storagePath: "file",
        },
      });
    },
  );
  it.each([false, true])(
    "cleans storage when metadata fails even with cleanup error=%s",
    async (cleanupFails) => {
      m.create.mockRejectedValue(new Error("db failed"));
      if (cleanupFails) m.unlink.mockRejectedValue(new Error("cleanup failed"));
      expect((await POST(upload(), workspaceCtx)).status).toBe(500);
      expect(m.unlink).toHaveBeenCalledWith("ws", "file");
    },
  );
});
