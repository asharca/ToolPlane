import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const io = vi.hoisted(() => ({
  check: vi.fn(),
  update: vi.fn(),
  reveal: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/agents/actions", () => ({
  checkPiRuntimesAction: io.check,
  updatePiRuntimesAction: io.update,
}));
vi.mock("@/lib/workspace/runtime-files-actions", () => ({
  revealDeploymentRuntimeFileAction: io.reveal,
  upsertDeploymentRuntimeFileAction: io.save,
  deleteDeploymentRuntimeFileAction: io.remove,
}));
vi.mock("next-intl", () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true },
  );
  return { useTranslations: () => t, useLocale: () => "en" };
});
import { PiRuntimeManagement } from "@/components/dashboard/agents/PiRuntimeManagement";
import { RuntimeFilesEditor } from "@/components/dashboard/RuntimeFilesEditor";
const agents = [
  {
    agentId: "a",
    name: "Alpha",
    installed: true,
    version: "1",
    status: "ready",
  },
  {
    agentId: "b",
    name: "Beta",
    installed: false,
    version: "0.9",
    status: "error",
    error: "Broken installation",
  },
  {
    agentId: "c",
    name: "Gamma",
    installed: false,
    version: null,
    status: "unchanged",
  },
];
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

describe("Pi runtime fleet management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.check.mockResolvedValue({ latestVersion: "2", agents });
  });
  it("loads, selects a batch and merges only updated agents", async () => {
    const user = userEvent.setup();
    io.update.mockResolvedValue({
      targetVersion: "2",
      finishedAt: "now",
      agents: [
        { ...agents[0], status: "updated", version: "2" },
        { ...agents[1], status: "error" },
        { ...agents[2], status: "unchanged" },
      ],
      warning: "Some unavailable",
    });
    render(<PiRuntimeManagement slug="space" />);
    await screen.findByText("Alpha");
    expect(screen.getByText("Broken installation")).toBeVisible();
    expect(screen.getByText("piNotInstalled")).toBeVisible();
    const checks = screen.getAllByRole("checkbox");
    await user.click(checks[1]);
    await user.click(screen.getByRole("button", { name: "piUpdateLatest" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenCalledWith("space", "latest", ["a"]),
    );
    expect(await screen.findByRole("status")).toHaveTextContent('"updated":1');
    expect(screen.getByText("Some unavailable")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    const version = screen.getByRole("textbox", { name: "piTargetVersion" });
    await user.type(version, " 1.5 ");
    await user.click(screen.getByRole("button", { name: "piInstallVersion" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenLastCalledWith("space", "1.5", ["a"]),
    );
  });
  it("disables latest updates only when all selected runtimes are current", async () => {
    const user = userEvent.setup();
    io.check.mockResolvedValue({ latestVersion: "1", agents });
    render(<PiRuntimeManagement slug="space" />);
    await screen.findByText("Alpha");
    await user.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByRole("button", { name: "piUpToDate" })).toBeDisabled();
    await user.click(screen.getAllByRole("checkbox")[2]);
    expect(
      screen.getByRole("button", { name: "piUpdateLatest" }),
    ).toBeEnabled();
    io.update.mockRejectedValue(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "piUpdateLatest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "piManagementFailed",
    );
    expect(screen.getByText("Alpha")).toBeVisible();
    io.check.mockResolvedValue({ agents: [], warning: "No runtimes" });
    await user.click(screen.getByRole("button", { name: "piCheckUpdates" }));
    expect(await screen.findByText("No runtimes")).toBeVisible();
    expect(screen.queryByText("Alpha")).toBeNull();
  });
  it("shows initial failures and ignores an obsolete load after unmount", async () => {
    io.check.mockRejectedValueOnce(new Error("denied"));
    const view = render(<PiRuntimeManagement slug="space" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "piManagementFailed",
    );
    view.unmount();
    const { promise, resolve } = Promise.withResolvers<object>();
    io.check.mockReturnValueOnce(promise);
    const next = render(<PiRuntimeManagement slug="other" />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    next.unmount();
    resolve({ agents });
  });
});

describe("deployment text file editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
