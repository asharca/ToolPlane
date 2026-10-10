import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillMarkdownViewer } from "@/components/dashboard/SkillMarkdownViewer";
import { updateSkillContentAction } from "@/lib/skills/actions";

vi.mock("@/lib/skills/actions", () => ({ updateSkillContentAction: vi.fn() }));
vi.mock("@streamdown/code", () => ({ code: {} }));
vi.mock("@/components/dashboard/SafeStreamdown", () => ({
  SafeStreamdown: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const initial = "# Original\n\nOld text";
const editable = { workspace: "acme", installId: "skill-1", content: initial };

describe("SkillMarkdownViewer", () => {
  beforeEach(() => vi.mocked(updateSkillContentAction).mockReset());

  it("previews and copies the current draft instead of the saved document", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    render(<SkillMarkdownViewer markdown={initial} editable={editable} />);
    await user.click(screen.getByRole("button", { name: "Edit source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit source" }), {
      target: { value: "# Draft\n\nnew text" },
    });
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText(/# Draft/)).toHaveTextContent("new text");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith("# Draft\n\nnew text");
  });

  it("retains failed drafts, disables pending edits, and invalidates saved feedback on another edit", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<{ error: string }>();
    vi.mocked(updateSkillContentAction)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ saved: true });
    const { rerender } = render(
      <SkillMarkdownViewer
        markdown={initial}
        editable={editable}
        downloadHref="/saved"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit source" }));
    const textarea = screen.getByRole("textbox", { name: "Edit source" });
    fireEvent.change(textarea, { target: { value: "# Draft" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(textarea).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await act(async () => pending.resolve({ error: "Save failed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    rerender(
      <SkillMarkdownViewer
        markdown="# Server old"
        editable={{ ...editable, content: "# Server old" }}
        downloadHref="/saved"
      />,
    );
    expect(textarea).toHaveValue("# Draft");
    expect(textarea).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Saved", { exact: true }),
    ).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "# Another draft" } });
    expect(screen.getByText("Unsaved", { exact: true })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download SKILL.md" }),
    ).toHaveAttribute("href", "/saved");
  });

  it("shows saved feedback when existing content uses multipart CRLF line endings", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSkillContentAction).mockResolvedValue({ saved: true });
    const persisted = "# Original\r\n\r\nOld text";
    render(
      <SkillMarkdownViewer
        markdown={persisted}
        editable={{ ...editable, content: persisted }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit source" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Saved", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Edit source" })).toHaveValue(
      "# Original\n\nOld text",
    );
  });

  it("offers source inspection without saving or downloading read-only catalog content", async () => {
    const user = userEvent.setup();
    render(<SkillMarkdownViewer markdown={initial} />);
    await user.click(screen.getByRole("button", { name: "Source code" }));
    expect(screen.getByText(/# Original/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Download SKILL.md" }),
    ).not.toBeInTheDocument();
  });
});
