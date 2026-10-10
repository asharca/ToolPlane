import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/acme/settings",
  useSelectedLayoutSegments: () => [],
  useSearchParams: () =>
    new URLSearchParams(
      "returnTo=%2Fapp%2Facme%2Fmcp%3F__dashboardTab%3Dtab-1",
    ),
}));

import { SettingsModal } from "@/components/dashboard/SettingsModal";

describe("SettingsModal", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("keeps unsaved settings open until the user confirms leaving", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <SettingsModal title="Settings" fallbackHref="/app/acme/chat">
        <form>
          <input aria-label="Name" defaultValue="Saved" />
        </form>
      </SettingsModal>,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Name" }),
      " edit",
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        "/app/acme/mcp?__dashboardTab=tab-1",
      ),
    );
  });

  it.each(["Close", "Escape", "Dismiss modal"])(
    "waits for the native exit before navigating after %s",
    async (method) => {
      render(
        <SettingsModal title="Settings" fallbackHref="/app/acme/chat">
          Content
        </SettingsModal>,
      );
      const panel = screen.getByRole("dialog", { name: "Settings" });
      if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: method }));

      expect(replaceMock).not.toHaveBeenCalled();
      expect(panel).toBeInTheDocument();
      expect(panel.closest("[inert]")).not.toBeNull();
      await waitFor(() => expect(panel).not.toBeInTheDocument());
      expect(replaceMock).toHaveBeenCalledExactlyOnceWith(
        "/app/acme/mcp?__dashboardTab=tab-1",
      );
    },
  );
});
