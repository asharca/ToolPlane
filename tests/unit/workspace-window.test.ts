import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceWindow } from "@/components/workspace/workspace-shell";

afterEach(() => vi.restoreAllMocks());

describe("workspace popup security and lifecycle", () => {
  it.each([
    "https://attacker.example/work",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    `http://user:password@${window.location.host}/work`,
    `http://user@${window.location.host}/work`,
    `http://:password@${window.location.host}/work`,
  ])("rejects unsafe destination %s before opening a window", (href) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(() => openWorkspaceWindow(href)).toThrow("同源 HTTP(S)");
    expect(open).not.toHaveBeenCalled();
  });

  it("returns null without preparation when the browser blocks the popup", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const prepare = vi.fn();
    expect(openWorkspaceWindow("/app/team/work", prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("severs the opener before preparing and navigating a same-origin destination", () => {
    const replace = vi.fn();
    const popup = { opener: window, location: { replace }, close: vi.fn() };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    const prepare = vi.fn((target: Window) => {
      expect(target.opener).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    });
    expect(
      openWorkspaceWindow(
        new URL("/app/team/work?q=task#result", window.location.href),
        prepare,
      ),
    ).toBe(popup);
    expect(open).toHaveBeenCalledWith(
      "about:blank",
      "_blank",
      "popup,width=1100,height=760",
    );
    expect(prepare).toHaveBeenCalledWith(popup);
    expect(replace).toHaveBeenCalledWith(
      `${window.location.origin}/app/team/work?q=task#result`,
    );
    expect(popup.close).not.toHaveBeenCalled();
  });

  it.each(["prepare", "navigate"])(
    "closes a partially opened popup after %s fails",
    (stage) => {
      const error = new Error("popup initialization failed");
      const popup = {
        opener: window,
        location: {
          replace: vi.fn(() => {
            if (stage === "navigate") throw error;
          }),
        },
        close: vi.fn(),
      };
      vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
      expect(() =>
        openWorkspaceWindow("/app/team/work", () => {
          if (stage === "prepare") throw error;
        }),
      ).toThrow(error);
      expect(popup.close).toHaveBeenCalledOnce();
    },
  );

  it("navigates without a preparation callback", () => {
    const popup = {
      opener: window,
      location: { replace: vi.fn() },
      close: vi.fn(),
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    expect(openWorkspaceWindow("/app/team/work")).toBe(popup);
    expect(popup.location.replace).toHaveBeenCalledWith(
      `${window.location.origin}/app/team/work`,
    );
  });
});
