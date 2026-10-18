import { assertDefined } from "../assert-defined";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxCreateForm } from "@/components/dashboard/sandboxes/SandboxCreateForm";

vi.mock("@/lib/sandboxes/actions", () => ({ createSandboxAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

class MockXmlHttpRequest extends EventTarget {
  static instances: MockXmlHttpRequest[] = [];

  status = 201;
  responseText = JSON.stringify({ agentId: "agent-imported" });
  withCredentials = false;
  upload = new EventTarget();
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn(() => {
    queueMicrotask(() => {
      this.upload.dispatchEvent(new Event("load"));
      this.dispatchEvent(new Event("load"));
    });
  });

  constructor() {
    super();
    MockXmlHttpRequest.instances.push(this);
  }
}

afterEach(() => {
  MockXmlHttpRequest.instances = [];
  vi.unstubAllGlobals();
});

describe("SandboxCreateForm", () => {
  it("offers a safe .hermes ZIP import flow", async () => {
    render(
      <SandboxCreateForm workspace="acme" hermesArchiveMaxUploadMiB={17} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    await userEvent.click(
      screen.getByRole("button", { name: /Import .hermes archive/ }),
    );

    const archive = screen.getByLabelText("Hermes archive");
    expect(archive).toHaveAttribute("type", "file");
    expect(archive).toHaveAttribute("accept", ".zip,application/zip");
    expect(screen.getByText(/up to 17 MiB/)).toBeInTheDocument();
    const form = assertDefined(
      screen
        .getByRole("button", { name: "Import and create Hermes sandbox" })
        .closest("form"),
    );
    expect(form.elements.namedItem("trustArchive")).toBeRequired();
    expect(form.elements.namedItem("allowSudo")).not.toBeRequired();
    expect(screen.getByText("What gets imported")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import and create Hermes sandbox" }),
    ).toBeInTheDocument();
    expect(document.querySelector('input[name="workspace"]')).toHaveValue(
      "acme",
    );
  });

  it("renders a 10 GiB configured limit in a human-readable form", async () => {
    render(
      <SandboxCreateForm workspace="acme" hermesArchiveMaxUploadMiB={10_240} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    await userEvent.click(
      screen.getByRole("button", { name: /Import .hermes archive/ }),
    );

    expect(screen.getByText(/up to 10 GiB \(10240 MiB\)/)).toBeInTheDocument();
  });

  it("uses the instance-configured Hermes image as the archive import default", async () => {
    render(
      <SandboxCreateForm
        workspace="acme"
        hermesImages={[
          "registry.example/hermes-agent:stable",
          "nousresearch/hermes-agent:latest",
        ]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    await userEvent.click(
      screen.getByRole("button", { name: /Import .hermes archive/ }),
    );

    const form = assertDefined(
      screen
        .getByRole("button", { name: "Import and create Hermes sandbox" })
        .closest("form"),
    );
    expect(new FormData(form).get("hermesImage")).toBe(
      "registry.example/hermes-agent:stable",
    );
  });

  it("sends a stable client import ID with the raw Hermes archive request", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "import-request-0001") });
    const user = userEvent.setup();
    render(<SandboxCreateForm workspace="acme" />);

    await user.click(screen.getByRole("button", { name: "New sandbox" }));
    await user.click(
      screen.getByRole("button", { name: /Import .hermes archive/ }),
    );
    await user.click(screen.getByRole("combobox", { name: "Hermes version" }));
    await user.click(
      screen.getByRole("option", {
        name: "nousresearch/hermes-agent:v2026.8.3",
      }),
    );
    const archive = new File(["zip"], "backup.zip", {
      type: "application/zip",
    });
    await user.upload(screen.getByLabelText("Hermes archive"), archive);
    await user.click(
      screen.getByRole("checkbox", { name: /I trust this archive/ }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Allow the agent to use sudo/ }),
    );
    fireEvent.submit(
      assertDefined(
        screen
          .getByRole("button", { name: "Import and create Hermes sandbox" })
          .closest("form"),
      ),
    );

    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    const request = MockXmlHttpRequest.instances[0];
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "x-toolplane-hermes-import-id",
      "import-request-0001",
    );
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "x-toolplane-hermes-image",
      encodeURIComponent("nousresearch/hermes-agent:v2026.8.3"),
    );
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "x-toolplane-hermes-allow-sudo",
      "1",
    );
    expect(request.send).toHaveBeenCalledWith(archive);
  });

  it("blocks dismissal during archive import and restores native closing after failure", async () => {
    class PendingRequest extends MockXmlHttpRequest {
      send = vi.fn();
    }
    vi.stubGlobal("XMLHttpRequest", PendingRequest);
    const user = userEvent.setup();
    render(<SandboxCreateForm workspace="acme" />);
    const trigger = screen.getByRole("button", { name: "New sandbox" });
    await user.click(trigger);
    await user.click(
      screen.getByRole("button", { name: /Import .hermes archive/ }),
    );
    await user.upload(
      screen.getByLabelText("Hermes archive"),
      new File(["zip"], "backup.zip", { type: "application/zip" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /I trust this archive/ }),
    );
    fireEvent.submit(
      assertDefined(
        screen
          .getByRole("button", { name: "Import and create Hermes sandbox" })
          .closest("form"),
      ),
    );

    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Dismiss modal" }));
    expect(
      screen.getByRole("dialog", { name: "New sandbox" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    MockXmlHttpRequest.instances[0].dispatchEvent(new Event("error"));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false"),
    );
    expect(trigger).toHaveFocus();
  });
  it.each(["missing", "empty", "untrusted", "oversize"])(
    "rejects %s archives before upload",
    async (invalid) => {
      vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
      render(
        <SandboxCreateForm workspace="acme" hermesArchiveMaxUploadMiB={1} />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "New sandbox" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: /Import .hermes archive/ }),
      );
      if (invalid !== "missing") {
        const file = new File(
          [invalid === "empty" ? "" : "zip"],
          "backup.zip",
          { type: "application/zip" },
        );
        if (invalid === "oversize")
          Object.defineProperty(file, "size", { value: 2 * 1024 * 1024 });
        fireEvent.change(screen.getByLabelText("Hermes archive"), {
          target: { files: [file] },
        });
      }
      if (invalid !== "untrusted")
        await userEvent.click(
          screen.getByRole("checkbox", { name: /I trust this archive/ }),
        );
      fireEvent.submit(
        assertDefined(
          screen
            .getByRole("button", { name: "Import and create Hermes sandbox" })
            .closest("form"),
        ),
      );
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(MockXmlHttpRequest.instances).toHaveLength(0);
    },
  );

  it.each(["error", "abort", "malformed", "server", "missing-id"])(
    "reports archive upload %s and enables retry",
    async (failure) => {
      class FailedRequest extends MockXmlHttpRequest {
        send = vi.fn(() =>
          queueMicrotask(() => {
            if (failure === "malformed") {
              this.status = 502;
              this.responseText = "<html>proxy</html>";
            }
            if (failure === "server") {
              this.status = 400;
              this.responseText = JSON.stringify({
                error: "Invalid archive layout",
              });
            }
            if (failure === "missing-id") this.responseText = "{}";
            this.upload.dispatchEvent(
              new ProgressEvent("progress", {
                loaded: 2,
                total: 3,
                lengthComputable: true,
              }),
            );
            this.upload.dispatchEvent(
              new ProgressEvent("progress", {
                loaded: 3,
                lengthComputable: false,
              }),
            );
            this.dispatchEvent(
              new Event(
                failure === "error" || failure === "abort" ? failure : "load",
              ),
            );
          }),
        );
      }
      vi.stubGlobal("XMLHttpRequest", FailedRequest);
      vi.stubGlobal("crypto", {});
      render(<SandboxCreateForm workspace="acme" />);
      await userEvent.click(
        screen.getByRole("button", { name: "New sandbox" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: /Import .hermes archive/ }),
      );
      fireEvent.change(screen.getByLabelText("Hermes archive"), {
        target: { files: [new File(["zip"], "backup.zip")] },
      });
      await userEvent.click(
        screen.getByRole("checkbox", { name: /I trust this archive/ }),
      );
      fireEvent.submit(
        assertDefined(
          screen
            .getByRole("button", { name: "Import and create Hermes sandbox" })
            .closest("form"),
        ),
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toBeVisible();
      expect(alert).not.toHaveTextContent("<html>");
      if (failure === "server")
        expect(alert).toHaveTextContent("Invalid archive layout");
      expect(
        screen.getByRole("button", {
          name: "Import and create Hermes sandbox",
        }),
      ).toBeEnabled();
      expect(
        MockXmlHttpRequest.instances[0]?.setRequestHeader,
      ).toHaveBeenCalledWith(
        "x-toolplane-hermes-import-id",
        expect.stringMatching(/^import-/),
      );
    },
  );
});
