import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeEditor } from "@/components/admin/RecipeEditor";
const actions = vi.hoisted(() => ({
  save: vi.fn(),
  validate: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/admin/market-actions", () => ({
  setServerRecipeAction: actions.save,
  validateServerRecipeAction: actions.validate,
  removeServerRecipeAction: actions.remove,
}));
vi.mock("@/components/admin/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));
const initial = {
  source: "npm",
  ref: "research-mcp",
  sourceUrl: "",
  startCommand: "",
  env: "API_KEY",
  envValues: "",
  network: true,
};
beforeEach(() => {
  actions.save.mockReset();
  actions.validate.mockReset();
});
const editor = (hasRecipe = true) => (
  <RecipeEditor
    serverId="server"
    hasRecipe={hasRecipe}
    initial={initial}
    verifiedAt={null}
    verifiedTools={null}
  />
);

describe("recipe validation freshness", () => {
  it("does not offer a runtime validation before the recipe has been persisted", () => {
    render(editor(false));
    expect(screen.getByRole("button", { name: "Validate" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(actions.validate).not.toHaveBeenCalled();
  });

  it("invalidates previous validation feedback as soon as a recipe changes, then permits validation after a successful save", async () => {
    actions.validate.mockResolvedValue({
      ok: true,
      toolCount: 2,
      tools: ["search", "fetch"],
    });
    actions.save.mockResolvedValue({ ok: true });
    render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/search, fetch/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Source URL" }), {
      target: { value: "https://github.com/acme/changed" },
    });
    expect(screen.queryByText(/search, fetch/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Validate" })).toBeEnabled(),
    );
    expect(screen.queryByText(/search, fetch/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/search, fetch/)).toBeInTheDocument();
  });

  it("keeps validation disabled when saving changed configuration fails", async () => {
    actions.save.mockResolvedValue({ error: "Recipe revision changed" });
    render(editor());
    fireEvent.change(screen.getByRole("textbox", { name: "Source URL" }), {
      target: { value: "https://github.com/acme/changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recipe revision changed",
    );
    expect(screen.getByRole("button", { name: "Validate" })).toBeDisabled();
  });

  it("shows validation failure only for the currently saved recipe", async () => {
    actions.validate.mockResolvedValue({
      error: "Upstream rejected the test credentials",
    });
    render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upstream rejected the test credentials",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Source URL" }), {
      target: { value: "https://github.com/acme/changed" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
