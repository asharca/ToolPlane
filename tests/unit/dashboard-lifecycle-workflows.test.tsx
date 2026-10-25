import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { ProvisioningRefresher } from "@/components/dashboard/ProvisioningRefresher";
import { SandboxConnectorStatus } from "@/components/dashboard/sandboxes/SandboxConnectorStatus";

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
