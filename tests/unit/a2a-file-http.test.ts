// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  actor: vi.fn(),
  authority: vi.fn(),
  open: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: mocks.user }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/a2a/local-policy", () => ({ assertLocalActor: mocks.actor }));
vi.mock("@/lib/a2a/files", () => ({
  assertTaskFileReadAuthority: mocks.authority,
  openTaskFile: mocks.open,
  openTaskFileCapability: mocks.capability,
}));
import { taskFileDownload, taskFileSessionDownload } from "@/lib/a2a/file-http";
const download = (headers: Record<string, string> = {}, query = "task=t") =>
  new Request(`https://tp.example/api/v1/a2a/files/f/download?${query}`, {
    headers,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "u" });
  mocks.actor.mockResolvedValue(undefined);
  mocks.authority.mockResolvedValue({
    id: "t",
    grant: { kind: "local", actorId: "u", workspaceId: "w" },
  });
  mocks.open.mockImplementation(async () => ({
    file: { filename: "safe.txt", size: 3 },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("abc"));
        c.close();
      },
    }),
  }));
});
describe("task file download boundaries", () => {
  it.each<Record<string, string>>([
    {},
    { authorization: "Bearer personal-token" },
    { "sec-fetch-site": "same-origin" },
  ])("accepts authorized user downloads with %j", async (headers) => {
    const response = await taskFileSessionDownload(download(headers), "f");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(mocks.actor).toHaveBeenCalledWith({}, "w", "u");
    expect(mocks.open).toHaveBeenCalledWith("t", "f");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each(["session", "capability"])(
    "downloads Unicode filenames through %s access",
    async (access) => {
      const filename = "2026年10月月报 ('final')*.docx";
      const opened = {
        file: { filename, size: 3 },
        body: new Blob(["abc"]).stream(),
      };
      mocks.open.mockResolvedValue(opened);
      mocks.capability.mockResolvedValue(opened);
      const response =
        access === "session"
          ? await taskFileSessionDownload(download(), "f")
          : await taskFileDownload(
              download({}, "task=t&expires=123&signature=valid"),
              "f",
            );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("abc");
      const disposition = response.headers.get("content-disposition");
      if (!disposition) throw new Error("Missing download filename");
      expect(disposition).toMatch(
        /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/,
      );
      const encoded = disposition.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toBe(filename);
      expect(encoded).not.toMatch(/['()*]/);
    },
  );
  it("rejects browser cross-site access before authentication", async () => {
    expect(
      (
        await taskFileSessionDownload(
          download({ "sec-fetch-site": "cross-site" }),
          "f",
        )
      ).status,
    ).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("requires an authenticated user", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await taskFileSessionDownload(download(), "f")).status).toBe(401);
  });
  it("does not expose another actor's file", async () => {
    mocks.user.mockResolvedValue({ id: "other" });
    expect((await taskFileSessionDownload(download(), "f")).status).toBe(404);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("does not bypass live task revocation", async () => {
    mocks.authority.mockRejectedValue(new TaskNotFoundError());
    expect((await taskFileSessionDownload(download(), "f")).status).toBe(404);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("rejects ambiguous task parameters", async () => {
    expect(
      (await taskFileSessionDownload(download({}, "task=t&task=other"), "f"))
        .status,
    ).toBe(404);
    expect(mocks.authority).not.toHaveBeenCalled();
  });
  it("never falls back from invalid capability to session authentication", async () => {
    mocks.capability.mockRejectedValue(new TaskNotFoundError());
    const response = await taskFileDownload(
      download({}, "task=t&expires=123&signature=invalid"),
      "f",
    );
    expect(response.status).toBe(404);
    expect(mocks.user).not.toHaveBeenCalled();
  });
});
