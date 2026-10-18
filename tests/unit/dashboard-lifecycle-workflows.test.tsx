import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { SandboxConnectorStatus } from "@/components/dashboard/sandboxes/SandboxConnectorStatus";
import { ToolkitInstallations } from "@/components/dashboard/ToolkitInstallations";
import { ToolkitInstall } from "@/components/dashboard/ToolkitInstall";

const mocks = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.router.refresh.mockReset();
});

describe("clipboard outcomes", () => {
  it.each([false, true])(
    "copies text and resets feedback (iconOnly=%s)",
    async (iconOnly) => {
      vi.useFakeTimers();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      render(<CopyButton text="private endpoint" iconOnly={iconOnly} />);
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await act(async () => {});
      expect(writeText).toHaveBeenCalledWith("private endpoint");
      expect(screen.getByRole("button", { name: /copied/i })).toBeVisible();
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    },
  );

  it.each(["denied", "missing", "timeout"])(
    "falls back on %s and restores focused input selection",
    async (mode) => {
      vi.useFakeTimers();
      const writeText =
        mode === "timeout"
          ? vi.fn(() => Promise.withResolvers<void>().promise)
          : vi.fn().mockRejectedValue(new Error("Denied"));
      vi.stubGlobal(
        "navigator",
        mode === "missing" ? {} : { clipboard: { writeText } },
      );
      const exec = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: exec,
      });
      render(
        <>
          <input aria-label="Draft" defaultValue="abcdef" />
          <CopyButton text="endpoint" />
        </>,
      );
      const input = screen.getByRole("textbox", { name: "Draft" });
      expect(input).toBeInstanceOf(HTMLInputElement);
      if (!(input instanceof HTMLInputElement))
        throw new Error("Missing input");
      input.focus();
      input.setSelectionRange(1, 4, "backward");
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await act(async () => {
        if (mode === "timeout") await vi.advanceTimersByTimeAsync(2000);
      });
      expect(exec).toHaveBeenCalledWith("copy");
      expect(input).toHaveFocus();
      expect([
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]).toEqual([1, 4, "backward"]);
      expect(screen.getByRole("button", { name: /copied/i })).toBeVisible();
    },
  );

  it("preserves document selection even when native copying throws", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => {
        throw new Error("Unavailable");
      },
    });
    render(
      <>
        <p>Selected text</p>
        <CopyButton text="endpoint" />
      </>,
    );
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Selected text"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      await screen.findByRole("button", { name: /failed/i }),
    ).toBeVisible();
    expect(window.getSelection()?.toString()).toBe("Selected text");
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("runtime polling", () => {
  it("refreshes collections only while active and cancels intervals", async () => {
    vi.useFakeTimers();
    const view = render(<ProvisioningRefresher active={false} />);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    view.rerender(<ProvisioningRefresher active />);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it("retries API failures, slows down after readiness, and stops on a missing runtime", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ snapshot: { status: "running" } }))
      .mockResolvedValueOnce(Response.json({ snapshot: { status: "running" } }))
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    render(<ProvisioningRefresher active deploymentId="dep" />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not refresh when a request completes after unmount", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => promise),
    );
    const view = render(
      <ProvisioningRefresher
        active
        deploymentId="dep"
        initialStatus="running"
      />,
    );
    view.unmount();
    await act(async () =>
      resolve(Response.json({ snapshot: { status: "failed" } })),
    );
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it("refreshes connector controls only when runtime identity changes, not heartbeats", async () => {
    vi.useFakeTimers();
    const status = {
      connected: true,
      connectedAt: "2026-01-01",
      lastSeen: null,
      root: "/work",
      platform: "linux",
      arch: "x64",
      shell: "bash",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...status, lastSeen: "now" }))
      .mockResolvedValueOnce(Response.json({ ...status, root: "/new" }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    const view = render(
      <SandboxConnectorStatus
        workspace="a b"
        sandboxId="x/y"
        initialStatus={status}
      />,
    );
    await act(async () => {});
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    expect(screen.getByTitle("linux/x64 · bash · /work")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(mocks.router.refresh).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/a%20b/sandboxes/x%2Fy/connector-status",
      { cache: "no-store" },
    );
    view.unmount();
  });

  it("establishes an initial disconnected connector without refreshing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<SandboxConnectorStatus workspace="team" sandboxId="local" />);
    expect(await screen.findByText(/waiting for connector/i)).toBeVisible();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });
});

describe("toolkit installation management", () => {
  const endpoint = "/api/toolkits/key/installations";
  it("loads devices from the same origin and revokes an individual credential", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          installations: [
            {
              id: "device",
              label: "Laptop",
              client: "codex",
              status: "active",
              lastUsedAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "old",
              label: "Old laptop",
              client: "hermes",
              status: "revoked",
              lastUsedAt: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ installations: [] }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <ToolkitInstallations mcpUrl="https://external.example/api/toolkits/key/mcp?secret=no" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /my client installations/i }),
    );
    expect(await screen.findByText(/Laptop · codex/)).toHaveTextContent(
      "2026-01-01T00:00:00.000Z",
    );
    expect(screen.getByText(/Old laptop/)).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operation: "revoke", installationId: "device" }),
      }),
    );
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it.each(["revoke-all", "rotate-link"])(
    "confirms and applies %s, then reloads devices",
    async (operation) => {
      const confirm = vi
        .spyOn(window, "confirm")
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json({ installations: [] }));
      vi.stubGlobal("fetch", fetcher);
      render(<ToolkitInstallations mcpUrl="/api/toolkits/key/mcp" />);
      const button = screen.getByRole("button", {
        name:
          operation === "rotate-link" ? /replace install link/i : /revoke all/i,
      });
      fireEvent.click(button);
      expect(fetcher).not.toHaveBeenCalled();
      fireEvent.click(button);
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenNthCalledWith(
        1,
        endpoint,
        expect.objectContaining({ body: JSON.stringify({ operation }) }),
      );
      expect(mocks.router.refresh).toHaveBeenCalledTimes(
        operation === "rotate-link" ? 1 : 0,
      );
    },
  );

  it.each(["load", "mutate"])(
    "reports %s failures and permits retry",
    async (mode) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ installations: [] }));
      vi.stubGlobal("fetch", fetcher);
      render(<ToolkitInstallations mcpUrl="/api/toolkits/key/mcp" />);
      fireEvent.click(
        screen.getByRole("button", {
          name: mode === "load" ? /my client installations/i : /revoke all/i,
        }),
      );
      expect(await screen.findByRole("alert")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: /my client installations/i }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
    },
  );

  it.each([false, true])(
    "switches installer clients and direct snippets (query=%s)",
    (query) => {
      const { container } = render(
        <ToolkitInstall
          installUrl={`/install${query ? "?key=x" : ""}`}
          uninstallUrl={`/uninstall${query ? "?key=x" : ""}`}
          mcpUrl="https://example.test/mcp"
          toolkitSlug="research"
          installationKey={query ? "opaque" : undefined}
          serverCount={2}
          skillCount={1}
        />,
      );
      for (const label of ["Codex", "Hermes", "opencode", "Claude Code"]) {
        fireEvent.click(screen.getByRole("button", { name: label }));
        expect(container.querySelector("pre")?.textContent).toContain(
          query ? "&client=" : "?client=",
        );
      }
      fireEvent.click(
        screen.getByRole("button", { name: /direct connection/i }),
      );
      for (const label of [
        "Codex",
        "Claude Code",
        "Cursor",
        "VS Code",
        "Claude Desktop",
      ]) {
        const button = screen.queryByRole("button", { name: label });
        if (button) {
          fireEvent.click(button);
          expect(container.querySelector("pre")?.textContent).toContain(
            "example.test/mcp",
          );
        }
      }
      fireEvent.click(screen.getByRole("button", { name: /auto.sync/i }));
      expect(screen.getByRole("link", { name: /inspect/i })).toHaveAttribute(
        "href",
        expect.stringContaining("client=claude-code"),
      );
    },
  );
});
