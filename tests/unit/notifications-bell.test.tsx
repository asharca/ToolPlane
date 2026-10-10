import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { getUnreadNotificationCountAction } from "@/lib/notifications/actions";

vi.mock("@/lib/notifications/actions", () => ({
  getUnreadNotificationCountAction: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getUnreadNotificationCountAction).mockReset();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("private notification badge refresh", () => {
  it("retains the last known count on errors and recovers on a user refresh event", async () => {
    vi.mocked(getUnreadNotificationCountAction)
      .mockResolvedValueOnce({ count: 105 })
      .mockResolvedValueOnce({ error: "unavailable" })
      .mockResolvedValueOnce({ count: 0 });
    await act(async () => {
      render(<NotificationBell compact />);
    });
    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAccessibleName(/105/);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
    await act(async () => {
      window.dispatchEvent(new Event("toolplane:notifications-changed"));
    });
    expect(screen.queryByText("99+")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAccessibleName(/0/);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does not invent zero on first failure or poll hidden/unmounted documents", async () => {
    vi.mocked(getUnreadNotificationCountAction).mockResolvedValue({
      error: "unavailable",
    });
    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<NotificationBell />));
    });
    expect(screen.getByRole("link")).not.toHaveAccessibleName(/0/);
    expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(getUnreadNotificationCountAction).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(getUnreadNotificationCountAction).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(getUnreadNotificationCountAction).toHaveBeenCalledTimes(2);
  });

  it("never overlaps slow count requests when focus, interval and inbox events coincide", async () => {
    let resolve!: (value: { count: number }) => void;
    vi.mocked(getUnreadNotificationCountAction).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { unmount } = render(<NotificationBell />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("toolplane:notifications-changed"));
      vi.advanceTimersByTime(60_000);
    });
    expect(getUnreadNotificationCountAction).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      resolve({ count: 17 });
    });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
