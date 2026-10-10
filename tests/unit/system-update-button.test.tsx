import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SystemUpdateButton,
  systemUpdateVersionDetail,
  waitForSystemUpdateReady,
} from "@/components/dashboard/SystemUpdateButton";

describe("SystemUpdateButton restart polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows refreshed version and release information from the header icon", async () => {
    const user = userEvent.setup();
    const updateStatus = {
      enabled: true,
      canUpdate: true,
      runtimeId: "runtime-1",
      currentVersion: "v1.0.0",
      latestVersion: "v1.0.1",
      updateAvailable: true,
      releaseName: "ToolPlane v1.0.1",
      releaseUrl: "https://github.com/asharca/ToolPlane/releases/tag/v1.0.1",
      artifactName: "toolplane-runtime-linux-amd64.tar.gz",
      reason: null,
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(updateStatus))),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemUpdateButton canInstall />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const trigger = screen.getByRole("button", {
      name: "System update: Update available",
    });

    await user.click(trigger);
    expect(await screen.findByText("v1.0.0 → v1.0.1")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ToolPlane v1.0.1" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/asharca/ToolPlane/releases/tag/v1.0.1",
    );

    await user.click(screen.getByRole("button", { name: "Check update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("does not repeat the same current and latest version", () => {
    expect(systemUpdateVersionDetail("v1.2.3", "v1.2.3")).toBe("v1.2.3");
    expect(systemUpdateVersionDetail("v1.2.3", "v1.2.4")).toBe(
      "v1.2.3 → v1.2.4",
    );
  });

  it("waits until the restarted runtime reports the target version", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "old-runtime",
            currentVersion: "v1.0.0",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: {
              status: "downloading",
              targetVersion: "v1.0.1",
              message: null,
            },
          }),
        ),
      )
      .mockRejectedValueOnce(new TypeError("service restarting"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "new-runtime",
            runtimeReady: true,
            currentVersion: "v1.0.1",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: { status: "idle", targetVersion: null, message: null },
          }),
        ),
      );

    const ready = waitForSystemUpdateReady("v1.0.1", {
      fetchImpl,
      previousRuntimeId: "old-runtime",
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(ready).resolves.toEqual({ status: "ready" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/admin/system/update?local=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("times out when the new version never appears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          runtimeId: "old-runtime",
          currentVersion: "v1.0.0",
          artifactName: "toolplane-runtime-linux-amd64.tar.gz",
          updateJob: {
            status: "downloading",
            targetVersion: "v1.0.1",
            message: null,
          },
        }),
      ),
    );

    const ready = waitForSystemUpdateReady("v1.0.1", {
      fetchImpl,
      previousRuntimeId: "old-runtime",
      pollIntervalMs: 10,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(30);

    await expect(ready).resolves.toEqual({ status: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not mistake an in-place version-file replacement for a completed restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "same-runtime",
            currentVersion: "v1.0.1",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: {
              status: "restarting",
              targetVersion: "v1.0.1",
              message: null,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "next-runtime",
            runtimeReady: true,
            currentVersion: "v1.0.1",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: { status: "idle", targetVersion: null, message: null },
          }),
        ),
      );

    const ready = waitForSystemUpdateReady("v1.0.1", {
      fetchImpl,
      previousRuntimeId: "same-runtime",
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(ready).resolves.toEqual({ status: "ready" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports each update phase while waiting for the replacement runtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onProgress = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "old-runtime",
            currentVersion: "v1.0.0",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: {
              status: "downloading",
              targetVersion: "v1.0.1",
              message: null,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "old-runtime",
            currentVersion: "v1.0.0",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: {
              status: "applying",
              targetVersion: "v1.0.1",
              message: null,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtimeId: "new-runtime",
            runtimeReady: true,
            currentVersion: "v1.0.1",
            artifactName: "toolplane-runtime-linux-amd64.tar.gz",
            updateJob: { status: "idle", targetVersion: null, message: null },
          }),
        ),
      );

    const ready = waitForSystemUpdateReady("v1.0.1", {
      fetchImpl,
      previousRuntimeId: "old-runtime",
      onProgress,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(ready).resolves.toEqual({ status: "ready" });
    expect(onProgress.mock.calls.map(([job]) => job?.status)).toEqual([
      "downloading",
      "applying",
      "idle",
    ]);
  });

  it("surfaces a background update failure without waiting for the restart timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          runtimeId: "new-runtime",
          runtimeReady: true,
          currentVersion: "v1.0.1",
          artifactName: "toolplane-runtime-linux-amd64.tar.gz",
          updateJob: {
            status: "failed",
            targetVersion: "v1.0.1",
            message: "Checksum mismatch",
          },
        }),
      ),
    );

    await expect(
      waitForSystemUpdateReady("v1.0.1", {
        fetchImpl,
        previousRuntimeId: "same-runtime",
        pollIntervalMs: 10,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ status: "failed", message: "Checksum mismatch" });
  });

  it("waits for runtime recovery after the new process and version appear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let runtimeReady = false;
    const fetchImpl = vi.fn(async () =>
      Response.json({
        runtimeId: "new-runtime",
        currentVersion: "v1.0.1",
        runtimeReady,
        updateJob: { status: "idle", targetVersion: null, message: null },
      }),
    );
    const result = waitForSystemUpdateReady("v1.0.1", {
      fetchImpl,
      previousRuntimeId: "old-runtime",
      pollIntervalMs: 10,
      timeoutMs: 100,
    });
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).not.toHaveBeenCalled();
    runtimeReady = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({ status: "ready" });
  });

  it.each([false, undefined])(
    "does not accept a replacement runtime without positive readiness: %s",
    async (runtimeReady) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetchImpl = vi.fn(async () =>
        Response.json({
          runtimeId: "new-runtime",
          currentVersion: "v1.0.1",
          runtimeReady,
          updateJob: { status: "idle", targetVersion: null, message: null },
        }),
      );
      const result = waitForSystemUpdateReady("v1.0.1", {
        fetchImpl,
        previousRuntimeId: "old-runtime",
        pollIntervalMs: 10,
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(30);
      await expect(result).resolves.toEqual({ status: "timeout" });
    },
  );

  it("does not accept an absent process identity as evidence of a restart", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        currentVersion: "v1.0.1",
        runtimeReady: true,
        updateJob: { status: "idle", targetVersion: null, message: null },
      }),
    );
    await expect(
      waitForSystemUpdateReady("v1.0.1", {
        fetchImpl,
        previousRuntimeId: "old-runtime",
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });
});
