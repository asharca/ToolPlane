import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VariablesEditor } from "@/components/dashboard/VariablesEditor";
import { setDeploymentEnvAction } from "@/lib/workspace/actions";

vi.mock("@/lib/workspace/actions", () => ({
  setDeploymentEnvAction: vi.fn(),
  getMcpConnectionImpactAction: vi
    .fn()
    .mockResolvedValue({ agentIds: [], assistantIds: [] }),
}));

function formChanges(): unknown {
  const input = document.querySelector(
    'input[name="changes"]',
  ) as HTMLInputElement;
  return JSON.parse(input.value);
}

describe("VariablesEditor", () => {
  it("renders configured metadata without placing existing values in the DOM", () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[{ key: "API_TOKEN", configured: true, required: true }]}
      />,
    );

    expect(screen.getByDisplayValue("API_TOKEN")).toBeDisabled();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-value");
    expect(formChanges()).toEqual({ set: {}, remove: [] });
  });

  it("submits only an explicit replacement and keeps an untouched configured value out of the patch", () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[
          { key: "API_TOKEN", configured: true, required: true },
          { key: "KEEP_ME", configured: true, required: false },
        ]}
      />,
    );

    const replacement = screen.getAllByPlaceholderText(
      "Enter a replacement value",
    )[0];
    fireEvent.change(replacement, { target: { value: "new-secret" } });

    expect(formChanges()).toEqual({
      set: { API_TOKEN: "new-secret" },
      remove: [],
    });
  });

  it("marks removal explicitly instead of treating an empty password input as a delete", () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[{ key: "API_TOKEN", configured: true, required: true }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      screen.getByText("This variable will be removed when you save."),
    ).toBeInTheDocument();
    expect(formChanges()).toEqual({ set: {}, remove: ["API_TOKEN"] });
  });

  it("surfaces a shared-change refusal instead of reporting a saved environment", async () => {
    vi.mocked(setDeploymentEnvAction).mockResolvedValueOnce({
      error: "sharedChangeConfirmationRequired",
      impactedObjects: { agentIds: ["agent-shared"], assistantIds: [] },
    });
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[{ key: "API_TOKEN", configured: true, required: true }]}
      />,
    );
    const input = screen.getByPlaceholderText("Enter a replacement value");
    fireEvent.change(input, { target: { value: "replacement-secret" } });
    const form = input.closest("form");
    if (!form) throw new Error("Expected environment form");
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(await screen.findByText("Agent · agent-shared")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter a replacement value"),
    ).toHaveValue("replacement-secret");
  });
});
