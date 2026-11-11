// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  open: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.principal,
}));
vi.mock("@/lib/a2a/files", () => ({
  openWorkspaceTaskFile: mocks.open,
  openTaskFileCapability: mocks.capability,
}));
import { taskFileDownload, taskFileSessionDownload } from "@/lib/a2a/file-http";
const download = (headers: Record<string, string> = {}, query = "task=t") =>
  new Request(`https://tp.example/api/v1/a2a/files/f/download?${query}`, {
    headers,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.principal.mockResolvedValue({
    user: { id: "u" },
    credential: "session",
    token: null,
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
  it.each<Record<string, string>>([{}, { "sec-fetch-site": "same-origin" }])(
    "accepts authorized session downloads with %j",
    async (headers) => {
      const response = await taskFileSessionDownload(download(headers), "f");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("abc");
      expect(response.headers.get("cache-control")).toContain("no-store");
    },
  );
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
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it.each(["Bearer personal-token", "Bearer toolkit-token", "invalid", ""])(
    "rejects explicit Authorization %j without falling back to the session",
    async (authorization) => {
      const response = await taskFileSessionDownload(
        download({ authorization }),
        "f",
      );
      expect(response.status).toBe(401);
      expect(mocks.principal).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );
  it.each(["personal-token", "toolkit-token"])(
    "rejects a resolved %s credential for session-only downloads",
    async (credential) => {
      mocks.principal.mockResolvedValue({
        user: { id: "u" },
        credential,
        token: {},
      });
      expect((await taskFileSessionDownload(download(), "f")).status).toBe(401);
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );
  it("requires an authenticated user", async () => {
    mocks.principal.mockResolvedValue(null);
    expect((await taskFileSessionDownload(download(), "f")).status).toBe(401);
  });
  it("does not expose files denied by workspace observation authorization", async () => {
    mocks.open.mockRejectedValue(new TaskNotFoundError());
    const response = await taskFileSessionDownload(download(), "f");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.capability).not.toHaveBeenCalled();
  });
  it("rejects ambiguous task parameters", async () => {
    expect(
      (await taskFileSessionDownload(download({}, "task=t&task=other"), "f"))
        .status,
    ).toBe(404);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("never falls back from invalid capability to session authentication", async () => {
    mocks.capability.mockRejectedValue(new TaskNotFoundError());
    const response = await taskFileDownload(
      download({}, "task=t&expires=123&signature=invalid"),
      "f",
    );
    expect(response.status).toBe(404);
    expect(mocks.principal).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
