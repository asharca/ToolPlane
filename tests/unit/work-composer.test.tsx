import { assertDefined } from "../assert-defined";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkComposer } from "@/components/dashboard/work/WorkComposer";
import { McpPromptPickerButton } from "@/components/dashboard/McpPromptPickerButton";
import {
  ComposerReferencesSchema,
  composerTrigger,
  type ComposerReference,
} from "@/lib/work/composer-types";
import { runtimeCommands } from "@/lib/agents/runtime-commands";

function Composer({
  sandboxId = "sandbox-1",
  onSubmit = vi.fn(),
  runtimeKind,
  conversationId = "conversation-1",
  workSessionId = "work-1",
  supportsAttachments = true,
}: {
  sandboxId?: string;
  runtimeKind?: string;
  conversationId?: string;
  workSessionId?: string;
  supportsAttachments?: boolean;
  onSubmit?: (references: ComposerReference[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <WorkComposer
        key={sandboxId}
        agentId="agent-1"
        sandboxId={sandboxId}
        workSessionId={workSessionId || undefined}
        conversationId={conversationId || undefined}
        commands={runtimeKind ? runtimeCommands(runtimeKind) : []}
        runtimeKind={runtimeKind ?? ""}
        draft={draft}
        onDraftChange={setDraft}
        references={references}
        onReferencesChange={setReferences}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        disabled={false}
        supportsAttachments={supportsAttachments}
        onSubmit={() => onSubmit(references)}
        onPendingChange={setPending}
        onError={setError}
        toolbarStart={null}
        toolbarEnd={
          <button type="submit" disabled={pending}>
            Send
          </button>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
const input = () =>
  screen.getByRole("combobox", { name: "What should the Agent accomplish?" });

describe("Work composer", () => {
  it("does not request current Agent capabilities before a session is pinned", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Composer conversationId="" workSessionId="" />);
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    for (const name of ["Skills", "MCP resources", "MCP prompts"])
      expect(screen.getByRole("option", { name })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps native file attachments local, removable, and separate from the draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Composer />);
    const fileInput = assertDefined(
      container.querySelector<HTMLInputElement>('input[type="file"]'),
    );
    const openPicker = vi.spyOn(fileInput, "click");
    await user.type(input(), "Review these files");
    await user.click(screen.getByRole("button", { name: "Open tools" }));
    await user.click(screen.getByRole("option", { name: "Add attachment" }));
    expect(openPicker).toHaveBeenCalledOnce();
    openPicker.mockRestore();
    await user.upload(fileInput, [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]);
    expect(screen.getByText("first.txt")).toBeInTheDocument();
    expect(screen.getByText("second.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove first.txt" }));
    expect(screen.queryByText("first.txt")).not.toBeInTheDocument();
    expect(screen.getByText("second.txt")).toBeInTheDocument();
    expect(input()).toHaveValue("Review these files");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the five-file limit across successive native selections", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer />);
    const fileInput = assertDefined(
      container.querySelector<HTMLInputElement>('input[type="file"]'),
    );
    await user.upload(fileInput, [
      new File(["first"], "first.txt", { type: "text/plain" }),
    ]);
    await user.upload(
      fileInput,
      Array.from(
        { length: 5 },
        (_, index) =>
          new File([`file ${index}`], `file-${index}.txt`, {
            type: "text/plain",
          }),
      ),
    );
    expect(screen.getByText("first.txt")).toBeInTheDocument();
    for (let index = 0; index < 4; index += 1)
      expect(screen.getByText(`file-${index}.txt`)).toBeInTheDocument();
    expect(screen.queryByText("file-4.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("disables native attachments when the workspace cannot accept uploads", async () => {
    render(<Composer supportsAttachments={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Open tools" }));
    expect(
      screen.getByRole("option", { name: "Add attachment" }),
    ).toBeDisabled();
  });

  it.each(["pi-sdk"])(
    "offers only %s commands through /, completes without executing, and keeps + unchanged",
    async (runtimeKind) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<Composer runtimeKind={runtimeKind} onSubmit={onSubmit} />);
      await user.type(input(), "/");
      const names = runtimeCommands(runtimeKind).map((item) => `/${item.name}`);
      for (const name of names)
        expect(
          screen.getByRole("option", { name: new RegExp(name) }),
        ).toBeInTheDocument();
      await user.click(screen.getByRole("option", { name: /\/compact/ }));
      expect(input()).toHaveValue("/compact ");
      expect(onSubmit).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(onSubmit).toHaveBeenCalledOnce();
      await user.clear(input());
      await user.click(screen.getByRole("button", { name: "Open tools" }));
      expect(
        screen.queryByRole("option", { name: /\/compact/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("submits a case-sensitive SDK command before any live catalog is available", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer runtimeKind="pi-sdk" onSubmit={onSubmit} />);
    await user.type(input(), "/Review:1");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(input()).toHaveValue("/Review:1");
  });

  it("resolves current-sandbox references, blocks premature send, and aborts a late result after switching", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            Response.json({
              items: [
                { kind: "file", id: "src/plan.md", label: "src/plan.md" },
                { kind: "session", id: "previous", label: "Previous task" },
              ],
            }),
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} />);
    await user.type(input(), "Review @");
    await user.click(
      await screen.findByRole("option", { name: "src/plan.md" }),
    );
    expect(input()).toHaveValue("Review ");
    expect(input()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(assertDefined(input().closest("form")));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toContain("sandboxId=sandbox-1");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "excludeConversationId=conversation-1",
    );
    expect(fetchMock.mock.calls[0][0]).toContain(
      "conversationId=conversation-1",
    );
    const resolveRequest = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(resolveRequest?.[1]?.body))).toMatchObject({
      conversationId: "conversation-1",
      workSessionId: "work-1",
      sandboxId: "sandbox-1",
    });
    const reference = {
      kind: "file",
      id: "src/plan.md",
      label: "src/plan.md",
      text: "Reference material: actual sandbox plan",
    };
    await act(async () => finish(Response.json(reference)));
    expect(screen.getByText("src/plan.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith([reference]);
    await user.click(
      screen.getByRole("button", { name: "Remove reference: src/plan.md" }),
    );
    await user.type(input(), "@");
    await user.click(
      await screen.findByRole("option", { name: "Previous task" }),
    );
    const pendingSignal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
    rerender(<Composer sandboxId="sandbox-2" onSubmit={onSubmit} />);
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () =>
      finish(
        Response.json({
          ...reference,
          kind: "session",
          id: "previous",
          label: "Previous task",
        }),
      ),
    );
    expect(screen.queryByText("Previous task")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("does not insert a late MCP prompt after the picker is canceled", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(
              Response.json({
                prompts: [
                  {
                    deploymentId: "dep",
                    serverName: "Tools",
                    name: "Review",
                    arguments: [],
                  },
                ],
              }),
            ),
      ),
    );
    const onInsert = vi.fn();
    render(
      <McpPromptPickerButton
        apiPath="/prompts"
        disabled={false}
        onError={vi.fn()}
        onInsert={onInsert}
      />,
    );
    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByRole("button", { name: /Review/ }));
    await user.click(screen.getByRole("button", { name: "Insert prompt" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => finish(Response.json({ text: "Stale prompt" })));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("bounds reference payloads and detects only unselected trigger tokens at the caret", () => {
    const reference = {
      kind: "file",
      id: "plan",
      label: "Plan",
      text: "Context",
    };
    expect(ComposerReferencesSchema.safeParse([reference]).success).toBe(true);
    expect(
      ComposerReferencesSchema.safeParse(Array(11).fill(reference)).success,
    ).toBe(false);
    expect(
      ComposerReferencesSchema.safeParse(
        Array(4).fill({ ...reference, text: "x".repeat(20_000) }),
      ).success,
    ).toBe(false);
    expect(composerTrigger("Review @src/file.md after", 19)).toMatchObject({
      symbol: "@",
      query: "src/file.md",
      start: 7,
      end: 19,
    });
    expect(composerTrigger("https://test/path", 17)).toBeNull();
    expect(composerTrigger("/tmp/file", 9)).toBeNull();
    expect(composerTrigger("/task", 5, 4)).toBeNull();
  });
});
