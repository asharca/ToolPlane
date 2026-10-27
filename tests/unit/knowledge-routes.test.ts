// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  provider: vi.fn(),
  base: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  sandbox: vi.fn(),
  document: vi.fn(),
  createDocument: vi.fn(),
  readDocument: vi.fn(),
  deleteDocument: vi.fn(),
  agents: vi.fn(),
  deleteLinks: vi.fn(),
  createLinks: vi.fn(),
  transaction: vi.fn(),
  rpc: vi.fn(),
  index: vi.fn(),
  search: vi.fn(),
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/auth/request-user", () => ({ resolveRequestUser: m.user }));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: m.workspace },
    modelProvider: { findFirst: m.provider },
    knowledgeBase: {
      findFirst: m.base,
      findMany: m.list,
      create: m.create,
      update: m.update,
      delete: m.remove,
    },
    sandbox: { findFirst: m.sandbox },
    knowledgeDocument: {
      findFirst: m.document,
      create: m.createDocument,
      findUnique: m.readDocument,
      delete: m.deleteDocument,
    },
    agent: { findMany: m.agents },
    agentKnowledgeBase: {
      deleteMany: m.deleteLinks,
      createMany: m.createLinks,
    },
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/process/mcp-client", () => ({ mcpRpc: m.rpc }));
vi.mock("@/lib/knowledge", () => ({
  indexKnowledgeText: m.index,
  searchKnowledgeBases: m.search,
}));

import { GET, POST } from "@/app/api/v1/knowledge/route";
import { PATCH, DELETE } from "@/app/api/v1/knowledge/[knowledgeBaseId]/route";
import { PUT } from "@/app/api/v1/knowledge/[knowledgeBaseId]/agents/route";
import { POST as upload } from "@/app/api/v1/knowledge/[knowledgeBaseId]/documents/route";
import {
  POST as retry,
  DELETE as deleteDocument,
} from "@/app/api/v1/knowledge/[knowledgeBaseId]/documents/[documentId]/route";
import { POST as search } from "@/app/api/v1/knowledge/[knowledgeBaseId]/search/route";

const context = {
  params: Promise.resolve({ knowledgeBaseId: "kb", documentId: "doc" }),
};
const request = (body: unknown = {}, method = "POST") =>
  new Request("http://localhost/api/v1/knowledge?workspace=team", {
    method,
    body: JSON.stringify(body),
  });
const malformed = () =>
  new Request("http://localhost/api/v1/knowledge", {
    method: "POST",
    body: "{",
  });
const valid = {
  workspace: " team ",
  name: " Handbook ",
  providerId: "provider",
  embeddingModel: " embed ",
};
const membership = {
  status: "active",
  OR: [{ ownerId: "user" }, { members: { some: { userId: "user" } } }],
};
function fileRequest(
  name = "notes.md",
  type = "text/markdown",
  text = "# Notes",
) {
  const form = new FormData();
  form.set("file", new File([text], name, { type }));
  form.set("sandboxId", "sandbox");
  return new Request("http://localhost/upload", { method: "POST", body: form });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ id: "user" });
  m.workspace.mockResolvedValue({ id: "workspace" });
  m.provider.mockResolvedValue({ id: "provider" });
  m.base.mockResolvedValue({ id: "kb", workspaceId: "workspace" });
  m.create.mockImplementation(async ({ data }) => ({ id: "kb", ...data }));
  m.update.mockImplementation(async ({ data }) => ({ id: "kb", ...data }));
  m.sandbox.mockResolvedValue({ id: "sandbox", deploymentId: "deployment" });
  m.createDocument.mockResolvedValue({ id: "doc" });
  m.readDocument.mockResolvedValue({ id: "doc", status: "indexed" });
  m.document.mockResolvedValue({
    id: "doc",
    sourcePath: "notes.md",
    sandbox: { deploymentId: "deployment" },
  });
  m.rpc.mockResolvedValue({ content: [{ type: "text", text: "notes" }] });
  m.agents.mockResolvedValue([{ id: "agent" }]);
  m.search.mockResolvedValue([{ text: "Relevant paragraph", score: 0.9 }]);
});

describe("knowledge access and configuration", () => {
  it("requires authentication for every operation", async () => {
    m.user.mockResolvedValue(null);
    const responses = await Promise.all([
      GET(new Request("http://localhost?workspace=team")),
      POST(request(valid)),
      PATCH(request(), context),
      DELETE(request(), context),
      PUT(request(), context),
      upload(request(), context),
      retry(request(), context),
      deleteDocument(request(), context),
      search(request(), context),
    ]);
    expect(responses.map((r) => r.status)).toEqual(Array(9).fill(401));
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.base).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("lists only the requested active workspace and hides inaccessible workspaces", async () => {
    expect((await GET(new Request("http://localhost"))).status).toBe(400);
    m.workspace.mockResolvedValueOnce(null);
    expect(
      (await GET(new Request("http://localhost?workspace=other"))).status,
    ).toBe(404);
    expect(m.list).not.toHaveBeenCalled();
    m.list.mockResolvedValue([{ id: "kb", name: "Handbook", documents: [] }]);
    const response = await GET(
      new Request("http://localhost?workspace=%20team%20"),
    );
    expect(await response.json()).toEqual([
      { id: "kb", name: "Handbook", documents: [] },
    ]);
    expect(m.workspace).toHaveBeenLastCalledWith({
      where: { slug: "team", ...membership },
      select: { id: true },
    });
    expect(m.list).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "workspace" } }),
    );
  });

  it("validates creation before writing and prevents cross-workspace providers", async () => {
    expect((await POST(malformed())).status).toBe(400);
    for (const field of ["workspace", "name", "providerId", "embeddingModel"]) {
      expect((await POST(request({ ...valid, [field]: 42 }))).status).toBe(400);
    }
    m.workspace.mockResolvedValueOnce(null);
    expect((await POST(request(valid))).status).toBe(404);
    m.provider.mockResolvedValueOnce(null);
    expect((await POST(request(valid))).status).toBe(400);
    expect(m.provider).toHaveBeenCalledWith({
      where: { id: "provider", workspaceId: "workspace" },
      select: { id: true },
    });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rejects malformed patches and foreign providers before writes", async () => {
    expect((await PATCH(malformed(), context)).status).toBe(400);
    m.provider.mockResolvedValueOnce(null);
    expect(
      (await PATCH(request({ providerId: "foreign" }), context)).status,
    ).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("hides inaccessible bases for updates and deletes, and deletes an authorized base", async () => {
    m.base.mockResolvedValue(null);
    expect((await PATCH(request(), context)).status).toBe(404);
    expect((await DELETE(request(), context)).status).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.base).toHaveBeenCalledWith({
      where: { id: "kb", workspace: membership },
      select: { id: true, workspaceId: true },
    });
    m.base.mockResolvedValue({ id: "kb", workspaceId: "workspace" });
    const response = await DELETE(request(), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(m.remove).toHaveBeenCalledWith({ where: { id: "kb" } });
  });

  it("replaces deduplicated agent links only when all agents belong to the workspace", async () => {
    expect((await PUT(malformed(), context)).status).toBe(400);
    for (const agentIds of ["agent", [1]])
      expect((await PUT(request({ agentIds }), context)).status).toBe(400);
    m.base.mockResolvedValueOnce(null);
    expect((await PUT(request({ agentIds: ["agent"] }), context)).status).toBe(
      404,
    );
    m.agents.mockResolvedValueOnce([]);
    expect(
      (await PUT(request({ agentIds: ["foreign"] }), context)).status,
    ).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
    const response = await PUT(
      request({ agentIds: ["agent", "agent"] }),
      context,
    );
    expect(await response.json()).toEqual({ agentIds: ["agent"] });
    expect(m.agents).toHaveBeenLastCalledWith({
      where: { id: { in: ["agent"] }, workspaceId: "workspace" },
      select: { id: true },
    });
    expect(m.createLinks).toHaveBeenCalledWith({
      data: [{ agentId: "agent", knowledgeBaseId: "kb" }],
    });
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("knowledge document lifecycle", () => {
  it("rejects missing, oversized and unsupported uploads before sandbox writes", async () => {
    const empty = new Request("http://localhost/upload", {
      method: "POST",
      body: new FormData(),
    });
    expect((await upload(empty, context)).status).toBe(400);
    expect(
      (await upload(fileRequest("image.png", "image/png"), context)).status,
    ).toBe(415);
    expect(
      (
        await upload(
          fileRequest("big.txt", "text/plain", "x".repeat(5 * 1024 * 1024 + 1)),
          context,
        )
      ).status,
    ).toBe(413);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("does not allow inaccessible bases or sandboxes from another workspace", async () => {
    m.base.mockResolvedValueOnce(null);
    expect((await upload(fileRequest(), context)).status).toBe(404);
    m.sandbox.mockResolvedValueOnce(null);
    expect((await upload(fileRequest(), context)).status).toBe(404);
    expect(m.sandbox).toHaveBeenCalledWith({
      where: { id: "sandbox", workspaceId: "workspace" },
      select: { id: true, deploymentId: true },
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { isError: true, content: [] },
    { isError: true, content: [{ text: "Disk full" }] },
  ])(
    "reports sandbox write failures without creating documents: %j",
    async (result) => {
      m.rpc.mockResolvedValue(result);
      const response = await upload(fileRequest(), context);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: result?.content?.[0]?.text || "Sandbox write failed",
      });
      expect(m.createDocument).not.toHaveBeenCalled();
    },
  );

  it("stores sanitized text uploads and returns the persisted indexing status even after indexing fails", async () => {
    m.index.mockRejectedValueOnce(new Error("provider unavailable"));
    m.readDocument.mockResolvedValueOnce({
      id: "doc",
      status: "failed",
      error: "provider unavailable",
    });
    const response = await upload(
      fileRequest("../notes?.md", "", "# Notes"),
      context,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "failed" });
    expect(m.createDocument).toHaveBeenCalledWith({
      data: expect.objectContaining({
        filename: "notes_.md",
        mimeType: "application/octet-stream",
        status: "pending",
        sandboxId: "sandbox",
      }),
    });
    expect(m.rpc).toHaveBeenCalledWith(
      "deployment",
      "tools/call",
      {
        name: "write_file",
        arguments: {
          path: expect.stringMatching(
            /\.toolplane\/knowledge\/kb\/\d+-notes_\.md$/,
          ),
          content: Buffer.from("# Notes").toString("base64"),
          encoding: "base64",
        },
      },
      30_000,
      { maxRequestBytes: 10 * 1024 * 1024 },
    );
    expect(m.index).toHaveBeenCalledWith("doc", "# Notes");
    expect((await upload(fileRequest(), context)).status).toBe(201);
  });

  it.each([
    null,
    {},
    { content: [] },
    { content: [null] },
    { content: [{ text: 9 }] },
  ])("reports missing source text without indexing: %j", async (result) => {
    m.rpc.mockResolvedValue(result);
    expect((await retry(request(), context)).status).toBe(502);
    expect(m.index).not.toHaveBeenCalled();
  });

  it.each(["plain source", '{"content":"wrapped source"}', '{"other":true}'])(
    "reindexes sandbox source text: %s",
    async (raw) => {
      m.rpc.mockResolvedValue({ content: [{ text: raw }] });
      const response = await retry(request(), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "doc", status: "indexed" });
      expect(m.index).toHaveBeenCalledWith(
        "doc",
        raw.includes("wrapped") ? "wrapped source" : raw,
      );
    },
  );

  it.each([new Error("Embedding failed"), "failure"])(
    "returns an actionable reindex error: %s",
    async (error) => {
      m.index.mockRejectedValue(error);
      const response = await retry(request(), context);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: error instanceof Error ? error.message : "Reindex failed",
      });
    },
  );

  it("hides foreign documents and permits authorized deletion", async () => {
    m.document
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "doc", sandbox: null });
    expect((await retry(request(), context)).status).toBe(404);
    expect((await deleteDocument(request(), context)).status).toBe(404);
    expect((await retry(request(), context)).status).toBe(404);
    expect(m.document).toHaveBeenCalledWith({
      where: {
        id: "doc",
        knowledgeBaseId: "kb",
        knowledgeBase: { workspace: membership },
      },
      include: { sandbox: { select: { deploymentId: true } } },
    });
    expect(m.rpc).not.toHaveBeenCalled();
    expect((await deleteDocument(request(), context)).status).toBe(204);
    expect(m.deleteDocument).toHaveBeenCalledWith({ where: { id: "doc" } });
  });
});

describe("knowledge search", () => {
  it("validates queries and conceals inaccessible bases", async () => {
    expect((await search(malformed(), context)).status).toBe(400);
    for (const query of [null, " ", "x".repeat(4001)])
      expect((await search(request({ query }), context)).status).toBe(400);
    m.base.mockResolvedValueOnce(null);
    expect((await search(request({ query: "hello" }), context)).status).toBe(
      404,
    );
    expect(m.search).not.toHaveBeenCalled();
  });

  it("returns ranked sources and exposes provider failures as gateway errors", async () => {
    const response = await search(request({ query: "release" }), context);
    expect(await response.json()).toEqual({
      sources: [{ text: "Relevant paragraph", score: 0.9 }],
    });
    for (const error of [new Error("Provider offline"), "unknown"]) {
      m.search.mockRejectedValueOnce(error);
      const failed = await search(request({ query: "release" }), context);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({
        error: error instanceof Error ? error.message : "Search failed",
      });
    }
  });
});
