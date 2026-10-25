import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const io = vi.hoisted(() => ({
  reveal: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  impact: vi.fn(),
}));
vi.mock("@/lib/workspace/runtime-files-actions", () => ({
  revealDeploymentRuntimeFileAction: io.reveal,
  upsertDeploymentRuntimeFileAction: io.save,
  deleteDeploymentRuntimeFileAction: io.remove,
}));
vi.mock("@/lib/workspace/actions", () => ({
  getMcpConnectionImpactAction: io.impact,
}));
vi.mock("next-intl", () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true },
  );
  return { useTranslations: () => t, useLocale: () => "en" };
});
import { RuntimeFilesEditor } from "@/components/dashboard/RuntimeFilesEditor";
const file = {
  id: "f",
  path: "config.txt",
  size: 20,
  updatedAt: "2026-01-01T00:00:00Z",
};
function editor(initialFiles = [file], relativePathArgumentsWork = true) {
  return render(
    <RuntimeFilesEditor
      workspace="space"
      deploymentId="dep"
      initialFiles={initialFiles}
      relativePathArgumentsWork={relativePathArgumentsWork}
    />,
  );
}
async function newDraft() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "addFile" }));
  await user.type(screen.getByRole("textbox", { name: "filePath" }), "new.txt");
  await user.type(
    screen.getByRole("textbox", { name: "textContent" }),
    "contents",
  );
}
function saveDraft() {
  const form = screen
    .getByRole("button", { name: "saveAndRestart" })
    .closest("form");
  if (!form) throw new Error("Missing draft");
  fireEvent.submit(form);
}

describe("deployment text file editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.impact.mockResolvedValue({ agentIds: [], assistantIds: [] });
    io.save.mockResolvedValue({
      savedAt: "now",
      file: { ...file, id: "new", path: "new.txt" },
    });
    io.remove.mockResolvedValue({ savedAt: "now" });
    io.reveal.mockResolvedValue({ path: file.path, content: "sensitive" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  it("keeps content private until reveal and sends only scoped edit data", async () => {
    const user = userEvent.setup();
    editor();
    expect(screen.queryByRole("textbox", { name: "textContent" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "revealAndEdit" }));
    expect(
      await screen.findByRole("textbox", { name: "textContent" }),
    ).toHaveValue("sensitive");
    expect(io.reveal).toHaveBeenCalledWith({
      workspace: "space",
      deploymentId: "dep",
      fileId: "f",
    });
    expect(screen.queryByRole("textbox", { name: "filePath" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "textContent" }), {
      target: { value: "edited" },
    });
    saveDraft();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "runtimeFileSaved",
    );
    const data = io.save.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(data)).toEqual({
      workspace: "space",
      deploymentId: "dep",
      path: file.path,
      content: "edited",
    });
  });
  it("warns on normalized case-insensitive replacement and overlays the saved path", async () => {
    const user = userEvent.setup();
    const view = editor();
    await user.click(screen.getByRole("button", { name: "addFile" }));
    expect(
      screen.getByRole("button", { name: "saveAndRestart" }),
    ).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "filePath" }),
      " CONFIG.TXT ",
    );
    expect(screen.getByText(/runtimeFileReplaceWarning/)).toBeVisible();
    io.save.mockResolvedValue({
      savedAt: "now",
      file: { ...file, id: "replacement", path: "CONFIG.TXT" },
    });
    saveDraft();
    await screen.findByRole("status");
    expect(screen.queryByText("config.txt")).toBeNull();
    view.rerender(
      <RuntimeFilesEditor
        workspace="space"
        deploymentId="dep"
        initialFiles={[{ ...file, id: "replacement", path: "CONFIG.TXT" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "runtimeFileRemoved",
    );
    expect(screen.getByText("noRuntimeFiles")).toBeVisible();
  });
  it.each([
    ["invalidFile", "invalidRuntimeFile"],
    ["notAuthorized", "runtimeFileNotAuthorized"],
    ["deploymentNotFound", "deploymentNotFound"],
    ["fileNotFound", "runtimeFileNotFound"],
    ["saveFailed", "runtimeFileSaveFailed"],
    ["restartFailed", "runtimeFileRestartFailed"],
    ["sharedChangeConfirmationRequired", "sharedChangeConfirmationRequired"],
    [undefined, "runtimeFileSaveFailed"],
  ])("retains a draft after %s save failures", async (error, message) => {
    io.save.mockResolvedValue({ error });
    editor([]);
    await newDraft();
    saveDraft();
    expect(await screen.findByRole("alert")).toHaveTextContent(String(message));
    expect(screen.getByRole("textbox", { name: "textContent" })).toHaveValue(
      "contents",
    );
    expect(
      screen.getByRole("textbox", { name: "textContent" }),
    ).toHaveAttribute("aria-invalid", "true");
  });
  it.each([
    ["saveFailed", "runtimeFileRemoveFailed"],
    ["restartFailed", "runtimeFileRemoveRestartFailed"],
    ["notAuthorized", "runtimeFileNotAuthorized"],
    ["sharedChangeConfirmationRequired", "sharedChangeConfirmationRequired"],
    [undefined, "runtimeFileRemoveFailed"],
  ])(
    "reports %s removal failures without losing metadata",
    async (error, message) => {
      io.remove.mockResolvedValue({ error });
      editor();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "remove" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        String(message),
      );
      expect(
        screen.getByText("config.txt", { selector: "code" }),
      ).toBeVisible();
    },
  );
  it("cancels removal, handles thrown I/O, and clears stale feedback when closing", async () => {
    const user = userEvent.setup();
    editor();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(io.remove).not.toHaveBeenCalled();
    io.reveal.mockRejectedValueOnce(new Error("down"));
    await user.click(screen.getByRole("button", { name: "revealAndEdit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "runtimeFileRevealFailed",
    );
    await newDraft();
    io.save.mockRejectedValueOnce(new Error("down"));
    saveDraft();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "runtimeFileSaveFailed",
    );
    await user.click(
      screen.getByRole("button", { name: "closeRuntimeFileEditor" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    io.remove.mockRejectedValueOnce(new Error("down"));
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "runtimeFileRemoveFailed",
    );
  });
  it.each([{}, { error: "notAuthorized" }])(
    "reports reveal responses without content: %j",
    async (result) => {
      io.reveal.mockResolvedValue(result);
      editor();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "revealAndEdit" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "error" in result
          ? "runtimeFileNotAuthorized"
          : "runtimeFileRevealFailed",
      );
    },
  );
  it("formats metadata sizes, tolerates invalid dates and hides unsupported relative hints", () => {
    const view = editor([{ ...file, size: 1024, updatedAt: "invalid" }], false);
    expect(screen.getByText(/1.0 KB/)).toBeVisible();
    expect(screen.getByText(/invalid/)).toBeVisible();
    expect(screen.queryByText("runtimeFilesRelativeArgumentHint")).toBeNull();
    view.rerender(
      <RuntimeFilesEditor
        workspace="space"
        deploymentId="dep"
        initialFiles={[{ ...file, size: 2 * 1024 * 1024 }]}
      />,
    );
    expect(screen.getByText(/2.0 MB/)).toBeVisible();
  });
  it.each([[65, 66], [0, 65], [255]])(
    "imports only valid UTF-8 plain text: %j",
    async (...bytes) => {
      editor([]);
      const upload = screen.getByLabelText("uploadTextFile", {
        selector: "input",
      });
      const file = new File([new Uint8Array(bytes)], "upload.txt");
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new Uint8Array(bytes).buffer,
      });
      fireEvent.change(upload, { target: { files: [file] } });
      if (bytes[0] === 65) {
        expect(
          await screen.findByRole("textbox", { name: "textContent" }),
        ).toHaveValue("AB");
        expect(screen.getByRole("textbox", { name: "filePath" })).toHaveValue(
          "upload.txt",
        );
      } else
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "invalidRuntimeTextUpload",
        );
    },
  );
  it("retains the complete draft and requires renewed confirmation when affected objects change", async () => {
    const user = userEvent.setup();
    io.impact.mockResolvedValue({
      agentIds: ["agent-b", "agent-a"],
      assistantIds: [],
    });
    io.save.mockResolvedValueOnce({
      error: "sharedChangeConfirmationRequired",
      impactedObjects: {
        agentIds: ["agent-a", "agent-b"],
        assistantIds: ["assistant-new"],
      },
    });
    editor([]);
    await newDraft();
    await user.click(await screen.findByRole("checkbox"));
    saveDraft();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sharedChangeConfirmationRequired",
    );
    expect(screen.getByRole("textbox", { name: "filePath" })).toHaveValue(
      "new.txt",
    );
    expect(screen.getByRole("textbox", { name: "textContent" })).toHaveValue(
      "contents",
    );
    expect(screen.getByText("Assistant · assistant-new")).toBeVisible();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      document.querySelector('input[name="confirmedImpactedObjects"]'),
    ).toBeNull();
    expect(io.save).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(io.save.mock.calls[0][1].get("confirmedImpactedObjects")),
    ).toEqual({ agentIds: ["agent-a", "agent-b"], assistantIds: [] });
    await user.click(screen.getByRole("checkbox"));
    saveDraft();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "runtimeFileSaved",
    );
    expect(io.save).toHaveBeenCalledTimes(2);
    const retry = io.save.mock.calls[1][1] as FormData;
    expect(JSON.parse(String(retry.get("confirmedImpactedObjects")))).toEqual({
      agentIds: ["agent-a", "agent-b"],
      assistantIds: ["assistant-new"],
    });
    expect(retry.get("path")).toBe("new.txt");
    expect(retry.get("content")).toBe("contents");
  });

  it("keeps file metadata after a shared deletion refusal and sends explicit confirmation on retry", async () => {
    const user = userEvent.setup();
    io.remove.mockResolvedValueOnce({
      error: "sharedChangeConfirmationRequired",
      impactedObjects: { agentIds: [], assistantIds: ["assistant-a"] },
    });
    editor();
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sharedChangeConfirmationRequired",
    );
    expect(screen.getByText("config.txt", { selector: "code" })).toBeVisible();
    expect(io.remove).toHaveBeenCalledTimes(1);
    expect(io.remove.mock.calls[0][0].has("confirmedImpactedObjects")).toBe(
      false,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "remove" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "runtimeFileRemoved",
    );
    expect(
      JSON.parse(io.remove.mock.calls[1][0].get("confirmedImpactedObjects")),
    ).toEqual({ agentIds: [], assistantIds: ["assistant-a"] });
    expect(screen.queryByText("config.txt", { selector: "code" })).toBeNull();
  });
});
