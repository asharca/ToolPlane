import { Blob as NodeBlob } from "node:buffer";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import messages from "../../messages/en.json";

const createObjectURL = vi.fn(() => "blob:attachment-preview");
const revokeObjectURL = vi.fn();
const NativeURL = URL;

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ConversationFilePreview", () => {
  it("previews a local text file without fetching and keeps removal independent", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["Local attachment content"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "text", {
      value: async () => "Local attachment content",
    });
    const remove = vi.fn();
    render(
      <ConversationFilePreview
        file={file}
        name={file.name}
        progress={0.5}
        onRemove={remove}
        removeLabel="Remove notes"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("50%");
    expect(screen.getByText(/24 B/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes" }));
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.txt" }));
    expect(
      await screen.findByText("Local attachment content"),
    ).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/attachments/attachment-1",
    "data:text/plain;base64,QXR0YWNobWVudCBjb250ZW50",
  ])("loads allowed content only on opening: %s", async (url) => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      blob: async () =>
        new NodeBlob(["Attachment content"], { type: "text/plain" }),
    }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(
      <ConversationFilePreview
        name="notes.txt"
        url={url}
        mimeType="text/plain"
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.txt" }));
    expect(await screen.findByText("Attachment content")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        redirect: "error",
      }),
    );
    view.rerender(
      <ConversationFilePreview
        name="notes.txt"
        url={url}
        mimeType="text/plain"
        progress={1}
      />,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: messages.filePreview.download }),
    ).toBeInTheDocument();
  });

  it.each([
    "https://example.com/file.png",
    "//example.com/file.png",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/api/v1/attachments/../../admin",
    "/api/v1/attachments/%2e%2e",
  ])("does not fetch or embed an untrusted source: %s", async (url) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(
      <ConversationFilePreview
        name="file.png"
        url={url}
        mimeType="image/png"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview file.png" }));
    expect(
      await screen.findByText(messages.filePreview.unavailable),
    ).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("rejects failed attachment responses instead of rendering their bodies", async () => {
    const blob = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, blob })),
    );
    render(
      <ConversationFilePreview
        name="notes.txt"
        url="/api/v1/attachments/private"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.txt" }));
    expect(
      await screen.findByText(messages.filePreview.unavailable),
    ).toBeInTheDocument();
    expect(blob).not.toHaveBeenCalled();
  });

  it("rejects an HTML body mislabeled as PDF rather than embedding it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () =>
          new NodeBlob(["<script>bad()</script>"], { type: "application/pdf" }),
      })),
    );
    render(
      <ConversationFilePreview
        name="document.pdf"
        url="/api/v1/attachments/document"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview document.pdf" }),
    );
    expect(
      await screen.findByText(messages.filePreview.unavailable),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("offers download instead of rendering binary bytes mislabeled as text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () =>
          new NodeBlob(["binary\0bytes"], { type: "text/plain" }),
      })),
    );
    render(
      <ConversationFilePreview
        name="data.txt"
        url="/api/v1/attachments/data"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview data.txt" }));
    expect(
      await screen.findByText(messages.filePreview.unsupported),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: messages.filePreview.download }),
    ).toBeEnabled();
    expect(screen.queryByText("binary\0bytes")).not.toBeInTheDocument();
  });

  it("revokes thumbnail URLs when the local file changes and on unmount", async () => {
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    const view = render(
      <ConversationFilePreview file={first} name={first.name} />,
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(first));
    view.rerender(<ConversationFilePreview file={second} name={second.name} />);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(second));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
