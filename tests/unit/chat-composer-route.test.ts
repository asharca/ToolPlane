// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  thread: vi.fn(),
  sources: vi.fn(),
  resources: vi.fn(),
  read: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/chat/service", () => ({ getChatThreadForExecution: m.thread }));
vi.mock("@/lib/process/mcp-prompts", () => ({
  getMcpPromptSources: m.sources,
  McpPromptRequestError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/process/mcp-resources", () => ({
  listAttachedMcpResources: m.resources,
  readAttachedMcpResource: m.read,
}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: m.status }));
import { McpPromptRequestError } from "@/lib/process/mcp-prompts";
import { GET, POST } from "@/app/api/v1/chat/threads/[threadId]/composer/route";
const context = { params: Promise.resolve({ threadId: "thread" }) };
const get = (query: string) =>
  new Request(`http://localhost/composer?${query}`);
const post = (body: unknown) =>
  new Request("http://localhost/composer", {
    method: "POST",
    body: JSON.stringify(body),
  });
const resource = {
  kind: "resource",
  id: "file:///notes",
  deploymentId: "attached",
};
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "user" });
  m.thread.mockResolvedValue({
    workspaceId: "workspace",
    assistant: { mcpGrants: [{ deploymentId: "attached" }] },
  });
  m.sources.mockResolvedValue([
    { deploymentId: "attached", serverName: "Files" },
    { deploymentId: "offline", serverName: "Offline" },
  ]);
  m.status.mockImplementation((id) =>
    id === "attached" ? "running" : "stopped",
  );
  m.resources.mockResolvedValue([
    {
      uri: "file:///notes",
      deploymentId: "attached",
      name: "Notes",
      description: "Project notes",
      serverName: "Files",
    },
    {
      uri: "file:///plan",
      deploymentId: "attached",
      name: "Plan",
      serverName: "Files",
    },
  ]);
  m.read.mockResolvedValue({
    text: "Release checklist",
    resource: { name: "Notes" },
  });
});
describe("chat composer resource access", () => {
  it("conceals threads from anonymous and cross-workspace requests", async () => {
    m.user.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect((await GET(get("section=mcp"), context)).status).toBe(404);
    expect((await POST(post(resource), context)).status).toBe(404);
    expect(m.thread).not.toHaveBeenCalled();
    m.thread.mockResolvedValue(null);
    expect((await GET(get("section=resources"), context)).status).toBe(404);
    expect((await POST(post(resource), context)).status).toBe(404);
    expect(m.thread).toHaveBeenCalledWith("user", "thread");
    expect(m.read).not.toHaveBeenCalled();
    expect(m.resources).not.toHaveBeenCalled();
  });
  it.each(["", "section=other", "section=mcp&extra=value"])(
    "rejects invalid strict list input: %s",
    async (query) => {
      expect((await GET(get(query), context)).status).toBe(400);
      expect(m.sources).not.toHaveBeenCalled();
    },
  );
  it("lists source availability and human-readable resource descriptions", async () => {
    expect(await (await GET(get("section=mcp"), context)).json()).toEqual({
      items: [
        { id: "attached", label: "Files", status: "running" },
        { id: "offline", label: "Offline", status: "unavailable" },
      ],
    });
    expect(m.sources).toHaveBeenCalledWith("workspace", ["attached"]);
    const req = get("section=resources");
    expect(await (await GET(req, context)).json()).toEqual({
      items: [
        { ...resource, label: "Notes", description: "Project notes" },
        {
          kind: "resource",
          id: "file:///plan",
          deploymentId: "attached",
          label: "Plan",
          description: "Files",
        },
      ],
    });
    expect(m.resources).toHaveBeenCalledWith({
      workspaceId: "workspace",
      deploymentIds: ["attached"],
      signal: req.signal,
    });
  });
  it("returns gateway errors when source or resource listing is unavailable", async () => {
    m.sources.mockRejectedValueOnce(new Error("offline"));
    m.resources.mockRejectedValueOnce(new Error("offline"));
    for (const section of ["mcp", "resources"]) {
      const response = await GET(get(`section=${section}`), context);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "MCP resources are unavailable.",
      });
    }
  });
  it.each([
    {},
    { ...resource, kind: "file" },
    { ...resource, id: " " },
    { ...resource, deploymentId: "x".repeat(241) },
    { ...resource, id: "x".repeat(4001) },
    { ...resource, extra: true },
  ])("rejects invalid resource references: %j", async (body) => {
    expect((await POST(post(body), context)).status).toBe(400);
    expect(m.read).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost", { method: "POST", body: "{" }),
          context,
        )
      ).status,
    ).toBe(400);
  });
  it("resolves trimmed references only within the thread's grant scope", async () => {
    const req = post({
      ...resource,
      id: " file:///notes ",
      deploymentId: " attached ",
    });
    expect(await (await POST(req, context)).json()).toEqual({
      ...resource,
      label: "Notes",
      text: "Reference material (resource): Notes\nfile:///notes\nRelease checklist",
    });
    expect(m.read).toHaveBeenCalledWith({
      workspaceId: "workspace",
      deploymentIds: ["attached"],
      deploymentId: "attached",
      uri: "file:///notes",
      signal: req.signal,
    });
  });
  it("caps large resource context and marks truncation explicitly", async () => {
    m.read.mockResolvedValue({
      text: "x".repeat(17001),
      resource: { name: "Large" },
    });
    const body = await (await POST(post(resource), context)).json();
    expect(body.text).toBe(
      `Reference material (resource): Large\nfile:///notes\n${"x".repeat(17000)}\n[Truncated]`,
    );
  });
  it("preserves access errors and sanitizes unexpected failures", async () => {
    m.read.mockRejectedValueOnce(
      new McpPromptRequestError(403, "Resource is not attached"),
    );
    const denied = await POST(
      post({ ...resource, deploymentId: "foreign" }),
      context,
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Resource is not attached" });
    m.read.mockRejectedValueOnce(new Error("secret backend details"));
    const failed = await POST(post(resource), context);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "MCP resource is unavailable.",
    });
  });
});
