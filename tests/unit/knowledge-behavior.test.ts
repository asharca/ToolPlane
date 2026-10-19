import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteChunks: vi.fn(),
  execute: vi.fn(),
  updateBase: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    knowledgeDocument: {
      findUnique: mocks.findDocument,
      update: mocks.updateDocument,
    },
    $queryRaw: mocks.query,
    $transaction: mocks.transaction,
  },
}));

import {
  buildKnowledgeTool,
  embed,
  indexKnowledgeText,
  searchKnowledgeBases,
  splitKnowledgeText,
} from "@/lib/knowledge";

const provider = {
  format: "openai",
  baseUrl: "https://embedding.example/v1///",
  apiKey: "secret",
};
const base = {
  id: "kb",
  embeddingModel: "embed",
  topK: 5,
  threshold: 0.5,
  provider,
};
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () =>
    Response.json({ data: [{ embedding: [0.1, 0.2] }] }),
  );
  mocks.findDocument.mockResolvedValue({
    id: "doc",
    knowledgeBaseId: "kb",
    knowledgeBase: { ...base, chunkSize: 200, chunkOverlap: 0 },
  });
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      knowledgeChunk: { deleteMany: mocks.deleteChunks },
      knowledgeBase: { update: mocks.updateBase },
      knowledgeDocument: { update: mocks.updateDocument },
      $executeRaw: mocks.execute,
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("knowledge embeddings", () => {
  it.each(["anthropic", "pi:anthropic"])(
    "rejects unsupported %s without sending credentials",
    async (format) => {
      await expect(
        embed({ ...provider, format }, "model", "text"),
      ).rejects.toThrow("does not expose");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("normalizes the endpoint and sends the requested model and input", async () => {
    await expect(embed(provider, "embed", "hello")).resolves.toEqual([
      0.1, 0.2,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://embedding.example/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
        body: JSON.stringify({ model: "embed", input: "hello" }),
      }),
    );
    await embed({ ...provider, apiKey: "" }, "embed", "hello");
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty(
      "authorization",
    );
  });
  it("reports unsuccessful responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("private upstream detail", { status: 429 }),
    );
    await expect(embed(provider, "embed", "hello")).rejects.toThrow(
      "Embedding request failed (429).",
    );
  });
  it.each([
    {},
    { data: [] },
    { data: [{}] },
    { data: [{ embedding: [] }] },
    { data: [{ embedding: [1, "2"] }] },
    { data: [{ embedding: "bad" }] },
  ])("rejects invalid embedding payload %j", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(embed(provider, "embed", "text")).rejects.toThrow(
      "invalid vector",
    );
  });
});

describe("knowledge indexing", () => {
  it("replaces old chunks and marks the document indexed within one transaction", async () => {
    await indexKnowledgeText("doc", "a".repeat(401));
    expect(mocks.deleteChunks).toHaveBeenCalledWith({
      where: { documentId: "doc" },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(mocks.execute.mock.calls[0][0].values).toEqual(
      expect.arrayContaining(["doc", 0, "a".repeat(200), "[0.1,0.2]"]),
    );
    expect(mocks.updateBase).toHaveBeenCalledWith({
      where: { id: "kb" },
      data: { dimensions: 2 },
    });
    expect(
      mocks.updateDocument.mock.calls.map((call) => call[0].data.status),
    ).toEqual(["indexing", "indexed"]);
  });
  it.each<[unknown, string, string]>([
    [null, "text", "Knowledge document not found."],
    [
      { id: "doc", knowledgeBase: { provider: null } },
      "text",
      "Configure an embedding provider first.",
    ],
    [
      {
        id: "doc",
        knowledgeBase: { ...base, chunkSize: 200, chunkOverlap: 0 },
      },
      " \r\n ",
      "does not contain indexable text",
    ],
  ])(
    "rejects unindexable documents before changing state",
    async (document, text, message) => {
      mocks.findDocument.mockResolvedValue(document);
      await expect(indexKnowledgeText("doc", text)).rejects.toThrow(message);
      expect(mocks.updateDocument).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it("does not replace old chunks when embedding dimensions differ", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ embedding: [1] }] }),
    );
    await expect(indexKnowledgeText("doc", "a".repeat(201))).rejects.toThrow(
      "dimensions are inconsistent",
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateDocument).toHaveBeenLastCalledWith({
      where: { id: "doc" },
      data: {
        status: "failed",
        error: "Embedding dimensions are inconsistent.",
      },
    });
  });
  it.each([new Error("x".repeat(600)), "failed upstream"])(
    "persists a bounded failure and rethrows the original error",
    async (error) => {
      fetchMock.mockRejectedValue(error);
      await expect(indexKnowledgeText("doc", "text")).rejects.toBe(error);
      expect(mocks.updateDocument).toHaveBeenLastCalledWith({
        where: { id: "doc" },
        data: {
          status: "failed",
          error: error instanceof Error ? "x".repeat(500) : "Indexing failed.",
        },
      });
    },
  );
});

describe("knowledge retrieval", () => {
  it("skips blank queries and unconfigured bases", async () => {
    await expect(searchKnowledgeBases([base], " \n ")).resolves.toEqual([]);
    await expect(
      searchKnowledgeBases([{ ...base, provider: null }], "query"),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(buildKnowledgeTool([])).toEqual({});
  });
  it("returns source citations through the authorized knowledge tool", async () => {
    mocks.query.mockResolvedValue([
      {
        chunkId: "chunk",
        documentId: "doc",
        filename: "guide.txt",
        sourcePath: "guide.txt",
        content: "answer",
        score: 0.8,
      },
    ]);
    const tool = buildKnowledgeTool([base]).knowledge_search;
    await expect(tool.execute({ query: "question" })).resolves.toEqual({
      sources: [
        {
          chunkId: "chunk",
          documentId: "doc",
          filename: "guide.txt",
          sourcePath: "guide.txt",
          content: "answer",
          score: 0.8,
          knowledgeBaseId: "kb",
        },
      ],
    });
  });
  it("bounds queries and topK, filters thresholds, merges sources by score and caps results", async () => {
    mocks.query.mockResolvedValueOnce([
      { chunkId: "excluded", score: 0.49 },
      { chunkId: "equal", score: 0.5 },
    ]);
    mocks.query.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => ({
        chunkId: `chunk-${i}`,
        score: 1 - i / 100,
      })),
    );
    const result = await searchKnowledgeBases(
      [
        { ...base, topK: -1 },
        { ...base, id: "kb2", topK: 500 },
      ],
      `  ${"q".repeat(5000)}  `,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toBe(
      "q".repeat(4000),
    );
    expect(mocks.query.mock.calls[0][0].values.at(-1)).toBe(1);
    expect(mocks.query.mock.calls[1][0].values.at(-1)).toBe(20);
    expect(result).toHaveLength(20);
    expect(result[0]).toMatchObject({
      chunkId: "chunk-0",
      score: 1,
      knowledgeBaseId: "kb2",
    });
    expect(result.at(-1)?.chunkId).toBe("chunk-19");
  });
  it("normalizes newlines, clamps chunk sizes and handles overlap", () => {
    expect(splitKnowledgeText("  hello\r\nworld\r!  ", 1, -5)).toEqual([
      "hello\nworld\n!",
    ]);
    expect(splitKnowledgeText("x".repeat(201), 1, 999)).toEqual([
      "x".repeat(200),
      "x".repeat(200),
    ]);
    expect(
      splitKnowledgeText("x".repeat(8001), 9000, 0).map(
        (chunk) => chunk.length,
      ),
    ).toEqual([8000, 1]);
  });
});
