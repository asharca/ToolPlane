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
import { GET, DELETE } from "@/app/api/v1/attachments/[attachmentId]/route";
import { POST } from "@/app/api/v1/workspaces/[slug]/attachments/route";
const ctx = { params: Promise.resolve({ attachmentId: "attachment" }) };
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
    expect(m.find).not.toHaveBeenCalled();
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
  it("rejects every workspace upload with 403 before touching storage", async () => {
    const response = await POST(new Request("https://test/api"));
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("disabled");
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
});
