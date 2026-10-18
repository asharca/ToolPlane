import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceKnowledge } from "@/components/dashboard/knowledge/WorkspaceKnowledge";

const fetchMock = vi.fn();
const base = {
  id: "manuals",
  name: "Manuals",
  embeddingModel: "embed-small",
  providerId: "provider",
  providerName: "Embedding service",
  chunkSize: 1200,
  chunkOverlap: 200,
  topK: 6,
  threshold: 0.2,
  agentIds: ["writer"],
  documents: [
    {
      id: "guide",
      filename: "guide.md",
      status: "failed",
      error: "Embedding quota exhausted",
    },
    { id: "faq", filename: "faq.txt", status: "indexed", error: null },
  ],
};
const props = {
  slug: "team",
  initialBases: [
    base,
    { ...base, id: "archive", name: "Archive", documents: [], agentIds: [] },
  ],
  providers: [
    { id: "provider", name: "Embedding service", models: ["embed-small"] },
  ],
  sandboxes: [
    { id: "stopped", name: "Stopped", running: false },
    { id: "running", name: "Runner", running: true },
  ],
  agents: [
    { id: "writer", name: "Writer" },
    { id: "reader", name: "Reader" },
  ],
};
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("knowledge workflow boundaries", () => {
  it("imports through the running Sandbox, reindexes failures and deletes only after server success", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ id: "new", filename: "notes.md", status: "pending" }),
      )
      .mockResolvedValueOnce(Response.json({ id: "new", status: "indexing" }))
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden" }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const { container } = render(<WorkspaceKnowledge {...props} />);
    expect(screen.getByText("Embedding quota exhausted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("File chooser missing");
    fireEvent.change(input, {
      target: {
        files: [new File(["notes"], "notes.md", { type: "text/markdown" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Pending");
    const upload = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(upload.get("sandboxId")).toBe("running");
    expect((upload.get("file") as File).name).toBe("notes.md");
    expect(
      screen.getByRole("button", { name: "Choose file" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex document" }));
    await screen.findByText("Indexing");
    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Indexing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await waitFor(() =>
      expect(screen.queryByText("Indexing")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Embedding quota exhausted")).toBeInTheDocument();
  });

  it("surfaces import and reindex server errors and permits retry", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: "File forbidden" }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json({ filename: "missing-id" }))
      .mockResolvedValueOnce(
        Response.json({ error: "Index unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ id: "guide", status: "indexed" }));
    const { container } = render(<WorkspaceKnowledge {...props} />);
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("File chooser missing");
    fireEvent.change(input, {
      target: { files: [new File(["data"], "report.txt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File forbidden",
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not import file",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reindex document" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Index unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reindex document" }));
    await screen.findByText("Indexed");
    expect(
      screen.queryByText("Embedding quota exhausted"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("guards blank recall, renders ranked sources and reports forbidden searches", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          sources: [
            {
              chunkId: "chunk",
              filename: "guide.md",
              sourcePath: "/knowledge/guide.md",
              content: "Reset with the red button",
              score: 0.87654,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({ error: "Search forbidden" }, { status: 403 }),
      );
    render(<WorkspaceKnowledge {...props} />);
    tab("Recall test");
    const query = screen.getByPlaceholderText(
      "Test what this knowledge base can recall",
    );
    fireEvent.change(query, { target: { value: "  " } });
    fireEvent.keyDown(query, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(query, { target: { value: "reset" } });
    fireEvent.keyDown(query, { key: "Enter" });
    await screen.findByText("Reset with the red button");
    expect(screen.getByText("0.877")).toBeInTheDocument();
    expect(screen.getByText("/knowledge/guide.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Test semantic retrieval");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search forbidden",
    );
  });

  it("persists authorized agent additions/removals and reports authorization rejection", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({ error: "Owner permission required" }, { status: 403 }),
      );
    render(<WorkspaceKnowledge {...props} />);
    tab("Agent access");
    expect(screen.getByRole("checkbox", { name: "Writer" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reader" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Reader" })).toBeEnabled(),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({
      agentIds: ["writer", "reader"],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Writer" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Writer" })).toBeEnabled(),
    );
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({
      agentIds: ["reader"],
    });
    tab("Documents");
    tab("Agent access");
    expect(screen.getByRole("checkbox", { name: "Writer" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Reader" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Writer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Owner permission required",
    );
  });

  it("saves changed retrieval defaults and preserves a rejected edit for retry", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: "Invalid chunk overlap" }, { status: 400 }),
      )
      .mockResolvedValueOnce(Response.json({}));
    render(<WorkspaceKnowledge {...props} />);
    tab("Settings");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Reference" },
    });
    for (const [name, value] of [
      ["Chunk size", "1800"],
      ["Chunk overlap", "100"],
      ["Results per search", "8"],
      ["Similarity threshold", "0.5"],
    ]) {
      fireEvent.change(screen.getByRole("spinbutton", { name }), {
        target: { value },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid chunk overlap",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByRole("heading", { name: "Reference" });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
      name: "Reference",
      chunkSize: 1800,
      chunkOverlap: 100,
      topK: 8,
      threshold: 0.5,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gates creation on a provider and name, reports rejected creation and cancels without deleting", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Workspace access denied" }, { status: 403 }),
    );
    render(<WorkspaceKnowledge {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "New knowledge base" }));
    expect(
      screen.getByRole("button", { name: "Create knowledge base" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Products" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create knowledge base" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace access denied",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      workspace: "team",
      name: "Products",
      embeddingModel: "embed-small",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("heading", { name: "Manuals" }),
    ).toBeInTheDocument();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete knowledge base" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
