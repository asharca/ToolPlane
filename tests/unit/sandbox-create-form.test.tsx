import { assertDefined } from "../assert-defined";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxCreateForm } from "@/components/dashboard/sandboxes/SandboxCreateForm";
import { DEFAULT_SANDBOX_IMAGE } from "@/lib/sandboxes/images";

vi.mock("@/lib/sandboxes/actions", () => ({ createSandboxAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
afterEach(cleanup);

function creationForm(buttonName: string) {
  return assertDefined(
    screen.getByRole("button", { name: buttonName }).closest("form"),
  );
}

describe("SandboxCreateForm", () => {
  it("offers Docker and connector creation without a retired Hermes import entrance", async () => {
    render(<SandboxCreateForm workspace="acme" />);
    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    expect(
      screen.getByRole("button", { name: "Docker container" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "User connector" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Import .hermes archive/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Hermes archive")).not.toBeInTheDocument();
    const data = new FormData(creationForm("Create container"));
    expect(data.get("workspace")).toBe("acme");
    expect(data.get("kind")).toBe("docker");
    expect(data.get("imageChoice")).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(data.get("network")).toBe("isolated");
  });

  it("preserves a custom Docker image and workspace environment in the creation form", async () => {
    render(<SandboxCreateForm workspace="acme" />);
    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    const image = assertDefined(
      document.querySelector<HTMLInputElement>('input[name="customImage"]'),
    );
    await userEvent.type(image, "registry.example/workspace:pinned");
    const env = assertDefined(
      document.querySelector<HTMLTextAreaElement>('textarea[name="env"]'),
    );
    await userEvent.type(env, "LANG=en_US.UTF-8");
    const data = new FormData(creationForm("Create container"));
    expect(data.get("imageChoice")).toBe("custom");
    expect(data.get("customImage")).toBe("registry.example/workspace:pinned");
    expect(data.get("env")).toBe("LANG=en_US.UTF-8");
  });

  it("switches to connector creation without Docker network controls", async () => {
    render(<SandboxCreateForm workspace="acme" />);
    await userEvent.click(screen.getByRole("button", { name: "New sandbox" }));
    await userEvent.click(
      screen.getByRole("button", { name: "User connector" }),
    );
    const data = new FormData(creationForm("Create connector"));
    expect(data.get("workspace")).toBe("acme");
    expect(data.get("kind")).toBe("connector");
    expect(data.has("network")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Create container" }),
    ).not.toBeInTheDocument();
  });
});
