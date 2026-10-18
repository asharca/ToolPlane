import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SystemUpdateButton,
  waitForSystemUpdateReady,
} from "@/components/dashboard/SystemUpdateButton";

const status = {
  enabled: true,
  canUpdate: true,
  runtimeId: "old",
  currentVersion: "v1.0.0",
  latestVersion: "v1.1.0",
  updateAvailable: true,
  releaseName: "New release",
  releaseUrl: null,
  artifactName: "runtime.tar.gz",
  reason: null,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open(canInstall = true) {
  const user = userEvent.setup();
  render(<SystemUpdateButton canInstall={canInstall} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "System update: Update available" }),
    ).toBeInTheDocument(),
  );
  await user.click(
    screen.getByRole("button", { name: "System update: Update available" }),
  );
  await screen.findByText("v1.0.0 → v1.1.0");
  return user;
}

describe("system update permission and failures", () => {
  it("never offers installation to a non-installer while still showing the release", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(status),
    );
    vi.stubGlobal("fetch", fetchMock);
    await open(false);
    expect(
      screen.queryByRole("button", { name: "Update now" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("New release")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "New release" }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(
        (call) => call.length < 2 || !(call[1] as RequestInit)?.method,
      ),
    ).toBe(true);
  });

  it("does not submit after cancelled confirmation, and reports an explicit rejected update", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json(
            { ok: false, message: "Only owners may install" },
            { status: 403 },
          )
        : Response.json(status),
    );
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Update now" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Update now" }));
    await screen.findByText("Only owners may install");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
  });

  it("recovers a dropped update request through local polling and displays the background failure", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("proxy disconnected");
      if (url.includes("local=1"))
        return Response.json({
          runtimeId: "old",
          currentVersion: "v1.0.0",
          updateJob: { status: "failed", message: "Archive signature invalid" },
        });
      return Response.json(status);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Update now" }));
    await screen.findByText("Archive signature invalid");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/system/update?local=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it.each(["updating", "restarting"])(
    "reports asynchronous %s acceptance then the background failure",
    async (phase) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST")
          return Response.json({
            ok: true,
            status: phase,
            latestVersion: "v1.1.0",
            runtimeId: "old",
          });
        if (url.includes("local=1"))
          return Response.json({
            updateJob: { status: "failed", message: "Cannot replace runtime" },
          });
        return Response.json(status);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const user = await open();
      await user.click(screen.getByRole("button", { name: "Update now" }));
      await screen.findByText("Cannot replace runtime");
      expect(screen.getByRole("button", { name: "Update now" })).toBeEnabled();
    },
  );

  it("stops polling immediately for an aborted caller or an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      waitForSystemUpdateReady("v2", { signal: controller.signal, fetchImpl }),
    ).resolves.toEqual({ status: "timeout" });
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    await expect(
      waitForSystemUpdateReady("v2", { fetchImpl }),
    ).resolves.toEqual({ status: "timeout" });
  });

  it("uses the supplied failure message when the job fails without details", async () => {
    await expect(
      waitForSystemUpdateReady(null, {
        fetchImpl: vi.fn(async () =>
          Response.json({ updateJob: { status: "failed" } }),
        ),
        fallbackFailureMessage: "Update failed safely",
      }),
    ).resolves.toEqual({ status: "failed", message: "Update failed safely" });
  });
});
