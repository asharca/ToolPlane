import { assertDefined } from "../assert-defined";
import { Blob as NodeBlob } from "node:buffer";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxConsole } from "@/components/dashboard/sandboxes/SandboxConsole";

vi.mock("@/components/dashboard/ConversationMessage", () => ({
  AssistantMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

function rpcResponse(value: unknown) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(value) }] },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SandboxConsole files", () => {
  it.each([
    [503, { error: "runtime_not_ready" }, "runtime_not_ready"],
    [502, { error: "upstream unreachable" }, "upstream unreachable"],
    [
      200,
      { error: { code: -32602, message: "Unknown tool: read_file" } },
      "Unknown tool: read_file",
    ],
  ])(
    "shows the server failure when preview cannot read a file (%s)",
    async (status, body, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status })),
      );
      render(
        <SandboxConsole
          compact
          filesOnly
          deploymentId="deployment-1"
          running
          initialPath="."
          initialEntries={[{ name: "README.md", type: "file", size: 7 }]}
        />,
      );
      fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
      expect(
        await within(screen.getByRole("dialog")).findByRole("alert"),
      ).toHaveTextContent(message);
    },
  );

  it("lazily expands and caches directory children", async () => {
    const listedPaths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: { path: string } };
      };
      expect(body.params.name).toBe("list_dir");
      const path = body.params.arguments.path;
      listedPaths.push(path);
      return rpcResponse(
        path === "."
          ? {
              path: ".",
              entries: [
                { name: "src", type: "dir", size: null },
                { name: "README.md", type: "file", size: 7 },
              ],
            }
          : {
              path: "src",
              entries: [{ name: "index.ts", type: "file", size: 12 }],
            },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[]}
      />,
    );

    const src = await screen.findByRole("treeitem", { name: "src" });
    expect(listedPaths).toEqual(["."]);
    expect(src).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("treeitem", { name: "index.ts" }),
    ).not.toBeInTheDocument();

    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(
      await screen.findByRole("treeitem", { name: "index.ts" }),
    ).toBeInTheDocument();
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(listedPaths).toEqual([".", "src"]);
    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "index.ts" }), {
      key: "ArrowLeft",
    });
    expect(src).toHaveFocus();
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(
      screen.queryByRole("treeitem", { name: "index.ts" }),
    ).not.toBeInTheDocument();
    fireEvent.click(src);
    expect(
      await screen.findByRole("treeitem", { name: "index.ts" }),
    ).toBeInTheDocument();
    expect(listedPaths).toEqual([".", "src"]);
  });

  it("previews Markdown and images in a dialog while preserving the tree and focus", async () => {
    const createObjectURL = vi.fn(() => "blob:sandbox-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string };
      };
      if (body.params.name === "list_dir") {
        return rpcResponse({
          path: ".",
          entries: [
            { name: "README.md", type: "file", size: 7 },
            { name: "preview.png", type: "file", size: 8 },
          ],
        });
      }
      if (body.params.name === "read_file") {
        return rpcResponse({ path: "README.md", content: "# Hello" });
      }
      return rpcResponse({
        filename: "preview.png",
        encoding: "base64",
        content: "iVBORw0KGgo=",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[]}
      />,
    );

    const markdownFile = await screen.findByRole("treeitem", {
      name: "README.md",
    });
    const tree = screen.getByRole("tree");
    const scrollContainer = assertDefined(tree.parentElement);
    scrollContainer.scrollTop = 48;
    act(() => markdownFile.focus());
    fireEvent.click(markdownFile);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("# Hello")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tree")).toBe(tree);
    expect(scrollContainer.scrollTop).toBe(48);
    expect(markdownFile).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(markdownFile).toHaveFocus());
    fireEvent.click(screen.getByRole("treeitem", { name: "preview.png" }));

    const image = await screen.findByRole("img", { name: "preview.png" });
    expect(image).toHaveAttribute("src", "blob:sandbox-preview");
    expect(createObjectURL).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /close/i,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:sandbox-preview"),
    );
  });

  it("aborts a pending read on close and retains the expanded directory for another preview", async () => {
    let resolveRead!: (response: Response) => void;
    let readSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: { path: string } };
      };
      if (body.params.name === "list_dir") {
        return rpcResponse({
          path: "src",
          entries: [
            { name: "first.md", type: "file", size: 7 },
            { name: "second.md", type: "file", size: 7 },
          ],
        });
      }
      if (body.params.arguments.path === "src/first.md") {
        readSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveRead = resolve;
        });
      }
      return rpcResponse({ content: "# Current" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[{ name: "src", type: "dir", size: null }]}
      />,
    );

    const directory = screen.getByRole("treeitem", { name: "src" });
    fireEvent.click(directory);
    const first = await screen.findByRole("treeitem", { name: "first.md" });
    act(() => first.focus());
    fireEvent.click(first);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(readSignal).toBeInstanceOf(AbortSignal));
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(readSignal?.aborted).toBe(true);
    expect(directory).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(first).toHaveFocus());
    expect(
      screen.getByRole("button", { name: "Upload files" }),
    ).toHaveAttribute("title", expect.stringContaining("/workspace/src"));

    fireEvent.click(screen.getByRole("treeitem", { name: "second.md" }));
    expect(await screen.findByText("# Current")).toBeInTheDocument();
    await act(async () => {
      resolveRead(rpcResponse({ content: "# Stale" }));
    });
    expect(screen.queryByText("# Stale")).not.toBeInTheDocument();
    expect(screen.getByText("# Current")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uploads files into the selected directory and refreshes it", async () => {
    const calls: { name: string; path: string; body?: BodyInit | null }[] = [];
    let srcListings = 0;
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/files/upload")) {
          calls.push({
            name: "upload_file",
            path: new URL(String(url)).searchParams.get("path") ?? "",
            body: init?.body,
          });
          return Response.json(
            { relativePath: "src/notes.txt", size: 5 },
            { status: 201 },
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          params: { name: string; arguments: { path: string } };
        };
        calls.push({ name: body.params.name, ...body.params.arguments });
        srcListings += 1;
        return rpcResponse({
          path: "src",
          entries:
            srcListings === 1
              ? []
              : [{ name: "notes.txt", type: "file", size: 5 }],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[{ name: "src", type: "dir", size: null }]}
      />,
    );

    fireEvent.click(screen.getByRole("treeitem", { name: "src" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const uploadInput = document.querySelector('input[type="file"]');
    expect(uploadInput).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(uploadInput as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(
      await screen.findByRole("treeitem", { name: "notes.txt" }),
    ).toBeInTheDocument();
    expect(calls.slice(0, 2)).toEqual([
      { name: "list_dir", path: "src" },
      { name: "upload_file", path: "src/notes.txt", body: file },
    ]);
    expect(calls.at(2)).toEqual({ name: "list_dir", path: "src" });
  });
});
