import { assertDefined } from "../assert-defined";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useTheme } from "next-themes";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

function SwitchTheme() {
  const { setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme("light")}>
      Light
    </button>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("applies a persisted theme on client mount and persists theme switches without script warnings", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
  localStorage.setItem("theme", "dark");
  const errors = vi.spyOn(console, "error");
  render(
    <ThemeProvider>
      <SwitchTheme />
    </ThemeProvider>,
  );
  expect(document.documentElement).toHaveClass("dark");
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement).toHaveClass("light");
  expect(document.documentElement).not.toHaveClass("dark");
  expect(localStorage.getItem("theme")).toBe("light");
  expect(errors.mock.calls.flat().join(" ")).not.toContain(
    "Encountered a script tag",
  );
});

it("keeps an executable server bootstrap that applies the stored theme before hydration", () => {
  const browserWindow = window;
  vi.stubGlobal("window", undefined);
  const html = renderToString(
    <ThemeProvider>
      <span>Content</span>
    </ThemeProvider>,
  );
  vi.unstubAllGlobals();
  const container = document.createElement("div");
  container.innerHTML = html;
  const script = assertDefined(container.querySelector("script"));
  expect(script.type).toBe("text/javascript");
  localStorage.setItem("theme", "light");
  new Function(
    "document",
    "localStorage",
    "window",
    assertDefined(script.textContent),
  )(document, localStorage, browserWindow);
  expect(document.documentElement).toHaveClass("light");
});
