import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpJsonConfigEditor } from "@/components/dashboard/McpJsonConfigEditor";

const mocks = vi.hoisted(() => ({
  revealMcpJsonConfigAction: vi.fn(),
  getMcpConnectionImpactAction: vi.fn(),
  updateMcpJsonConfigAction: vi.fn(),
}));

vi.mock("@/lib/workspace/actions", () => ({
  revealMcpJsonConfigAction: mocks.revealMcpJsonConfigAction,
  getMcpConnectionImpactAction: mocks.getMcpConnectionImpactAction,
  updateMcpJsonConfigAction: mocks.updateMcpJsonConfigAction,
}));

describe("McpJsonConfigEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpConnectionImpactAction.mockResolvedValue({
      agentIds: [],
      assistantIds: [],
    });
    mocks.updateMcpJsonConfigAction.mockResolvedValue({ savedAt: 1 });
  });

  it("shows the stored config and a save-and-rebuild action", () => {
    const initialConfig = JSON.stringify(
      {
        command: "npx",
        args: ["-y", "@fangjunjie/ssh-mcp-server", "--port", "22"],
      },
      null,
      2,
    );

    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={initialConfig}
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall
      />,
    );

    expect(screen.getByLabelText("MCP JSON config")).toHaveValue(initialConfig);
    expect(screen.getByRole("radio", { name: /isolated/i })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Save and rebuild" }),
    ).toBeInTheDocument();
  });

  it("links to the dedicated variable editor instead of showing credentials in JSON", () => {
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={JSON.stringify({ command: "npx", args: ["mcp-server"] })}
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall={false}
        variablesHref="/app/acme/mcp/dep1?tab=variables"
        configuredVariables={2}
      />,
    );

    expect(
      screen.getByText("Environment variables are managed separately"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage variables" }),
    ).toHaveAttribute("href", "/app/acme/mcp/dep1?tab=variables");
  });

  it("allows the runtime network mode to be changed independently of JSON", () => {
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={JSON.stringify({ source: "npm", ref: "pkg" })}
        requiresReveal={false}
        initialNetwork="none"
        warnAboutPackageInstall
      />,
    );

    const none = screen.getByRole("radio", { name: /no network/i });
    const isolated = screen.getByRole("radio", { name: /isolated/i });
    expect(none).toBeChecked();
    fireEvent.click(isolated);
    expect(isolated).toBeChecked();
  });

  it("fetches credentials only after the user explicitly reveals the editable config", async () => {
    const initialConfig = JSON.stringify(
      {
        command: "npx",
        args: ["ssh-mcp-server", "--password", "secret"],
        env: { SSH_TOKEN: "token-value" },
      },
      null,
      2,
    );
    const maskedConfig = initialConfig
      .replace("secret", "********")
      .replace("token-value", "********");
    mocks.revealMcpJsonConfigAction.mockResolvedValue({
      config: initialConfig,
    });

    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={maskedConfig}
        requiresReveal
        initialNetwork="none"
        warnAboutPackageInstall
      />,
    );

    expect(screen.getByLabelText("MCP JSON config")).toHaveTextContent(
      "********",
    );
    expect(screen.queryByDisplayValue(initialConfig)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save and rebuild" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Reveal sensitive values and edit" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("MCP JSON config")).toHaveValue(
        initialConfig,
      ),
    );
    expect(mocks.revealMcpJsonConfigAction).toHaveBeenCalledWith({
      workspace: "acme",
      deploymentId: "dep1",
    });
    expect(
      screen.getByRole("button", { name: "Save and rebuild" }),
    ).toBeInTheDocument();
  });

  it("requires explicit confirmation of the actual sorted shared objects", async () => {
    mocks.getMcpConnectionImpactAction.mockResolvedValue({
      agentIds: ["agent-b", "agent-a"],
      assistantIds: ["assistant-a"],
    });
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={'{"command":"npx","args":["mcp"]}'}
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall={false}
      />,
    );
    const confirmation = await screen.findByRole("checkbox");
    expect(screen.getByText("Agent · agent-a")).toBeInTheDocument();
    expect(screen.getByText("Assistant · assistant-a")).toBeInTheDocument();
    const form = confirmation.closest("form");
    expect(form).not.toBeNull();
    if (!form) throw new Error("Expected connection configuration form");
    expect(new FormData(form).has("confirmedImpactedObjects")).toBe(false);
    expect(confirmation).toBeRequired();
    fireEvent.click(confirmation);
    expect(
      JSON.parse(String(new FormData(form).get("confirmedImpactedObjects"))),
    ).toEqual({
      agentIds: ["agent-a", "agent-b"],
      assistantIds: ["assistant-a"],
    });
  });

  it("requires renewed confirmation when the backend reports a changed impact set", async () => {
    mocks.getMcpConnectionImpactAction.mockResolvedValue({
      agentIds: ["agent-a"],
      assistantIds: [],
    });
    mocks.updateMcpJsonConfigAction.mockResolvedValue({
      error: "sharedChangeConfirmationRequired",
      impactedObjects: { agentIds: ["agent-a", "agent-b"], assistantIds: [] },
    });
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={'{"command":"npx","args":["mcp"]}'}
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall={false}
      />,
    );
    const confirmation = await screen.findByRole("checkbox");
    fireEvent.click(confirmation);
    const form = confirmation.closest("form");
    if (!form) throw new Error("Expected connection configuration form");
    fireEvent.submit(form);
    await screen.findByText("Agent · agent-b");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(new FormData(form).has("confirmedImpactedObjects")).toBe(false);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("offers separate unchecked HTTP consent without stdio network controls for remote editing", () => {
    render(
      <McpJsonConfigEditor
        slug="acme"
        deploymentId="dep1"
        maskedConfig={
          '{"type":"http","url":"http://mcp.example.com/mcp","allowUnsafeHttp":true}'
        }
        requiresReveal={false}
        initialNetwork="isolated"
        warnAboutPackageInstall={false}
        remote
      />,
    );
    const consent = screen.getByRole("checkbox");
    expect(consent).not.toBeChecked();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    const form = consent.closest("form");
    if (!form) throw new Error("Expected remote configuration form");
    expect(new FormData(form).has("allowUnsafeHttp")).toBe(false);
    fireEvent.click(consent);
    expect(new FormData(form).get("allowUnsafeHttp")).toBe("true");
  });
});
