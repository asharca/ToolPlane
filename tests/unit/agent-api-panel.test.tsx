import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentApiPanel,
  type AgentEndpointView,
} from "@/components/dashboard/agents/AgentApiPanel";

const actions = vi.hoisted(() => ({
  publishAgentEndpointAction: vi.fn(),
  createAgentApiClientAction: vi.fn(),
  createAgentApiKeyAction: vi.fn(),
  createAgentClientTokenAction: vi.fn(),
  revokeAgentApiKeyAction: vi.fn(),
  setAgentEndpointStatusAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/lib/agents/public-api/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const endpoint: AgentEndpointView = {
  id: "agep_support",
  name: "Support API",
  status: "active",
  isolationMode: "subject",
  rpmLimit: 20,
  dailyRequestLimit: 200,
  dailyOutputCharacterLimit: 200000,
  maxConcurrent: 2,
  maxRuntimes: 10,
  maxStoredCharacters: 220000,
  timeoutSeconds: 60,
  retentionDays: 7,
  systemPrompt: "Answer product questions only",
  allowedOrigins: ["https://customer.example"],
  revision: 3,
  deploymentIds: [],
  skillIds: ["skill"],
  clients: [
    {
      id: "client",
      name: "Backend",
      createdAt: "2026-01-01",
      lastUsedAt: null,
      keys: [
        {
          id: "live",
          name: "Current",
          prefix: "tp_live",
          createdAt: "2026-01-01",
          lastUsedAt: "2026-02-01",
          expiresAt: "2027-01-01",
          revokedAt: null,
        },
        {
          id: "revoked",
          name: "Old",
          prefix: "tp_old",
          createdAt: "2025-01-01",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: "2026-01-01",
        },
        {
          id: "unused",
          name: "Unused",
          prefix: "tp_unused",
          createdAt: "2026-01-01",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    },
  ],
};
const props = {
  workspaceSlug: "team",
  agentId: "agent",
  agentName: "Support",
  origin: "https://tp.example",
  canManage: true,
  endpoint,
  deployments: [
    {
      id: "mcp",
      label: "Search service",
      checked: true,
      description: "Read only",
      status: "running",
    },
  ],
  skills: [{ id: "skill", label: "FAQ", checked: false }],
};
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});
function submit(name: string) {
  const button = screen.getByRole("button", { name });
  const form = button.closest("form");
  if (!form) throw new Error(`Missing form for ${name}`);
  fireEvent.submit(form);
}

describe("Agent API publishing and credentials", () => {
  it("makes unpublished configuration read-only for members and keeps integration examples usable", () => {
    render(
      <AgentApiPanel
        {...props}
        canManage={false}
        endpoint={null}
        deployments={[]}
        skills={[]}
      />,
    );
    expect(
      screen.getByText("This agent does not have a published API endpoint."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Endpoint name" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: "Requests / minute" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Publish API" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create client and key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Nothing available in this workspace."),
    ).toHaveLength(2);
    expect(
      screen.getByText(
        "Only workspace owners and admins can publish endpoints or manage API credentials.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "OpenAI JavaScript" }));
    expect(document.querySelector("pre")).toHaveTextContent(
      'model: "agep_your_endpoint"',
    );
    expect(document.querySelector("pre")).toHaveTextContent(
      'baseURL: "https://tp.example/api/openai/v1"',
    );
    fireEvent.click(screen.getByRole("tab", { name: "OpenAI Python" }));
    expect(document.querySelector("pre")).toHaveTextContent(
      'model="agep_your_endpoint"',
    );
    fireEvent.click(screen.getByRole("tab", { name: "curl" }));
    expect(document.querySelector("pre")).toHaveTextContent(
      "/agent-endpoints/{endpoint_id}/responses",
    );
  });

  it("publishes the edited allowlist rather than the workspace defaults and surfaces publication errors", async () => {
    actions.publishAgentEndpointAction
      .mockResolvedValueOnce({
        error: "Deployment not approved for public use",
      })
      .mockResolvedValueOnce({ endpointId: "agep_support" });
    render(<AgentApiPanel {...props} />);
    expect(
      screen.getByRole("checkbox", { name: "Search service" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "FAQ" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Search service" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "FAQ" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Endpoint name" }), {
      target: { value: "Public support" },
    });
    submit("Publish new revision");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Deployment not approved for public use",
    );
    const submitted = actions.publishAgentEndpointAction.mock
      .calls[0]?.[1] as FormData;
    expect(submitted.get("name")).toBe("Public support");
    expect(submitted.getAll("deploymentIds")).toEqual(["mcp"]);
    expect(submitted.getAll("skillIds")).toEqual([]);
    expect(submitted.get("workspace")).toBe("team");
    expect(router.refresh).not.toHaveBeenCalled();
    submit("Publish new revision");
    await screen.findByText("The Agent API configuration was published.");
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("reveals a newly issued client key, rotates it and sends revocation only for active keys", async () => {
    actions.createAgentApiClientAction.mockResolvedValue({
      clientId: "new-client",
      apiKey: "tp_agent_once",
    });
    actions.createAgentApiKeyAction.mockResolvedValue({
      success: true,
      secret: "tp_agent_rotation",
    });
    actions.revokeAgentApiKeyAction.mockResolvedValue(undefined);
    render(<AgentApiPanel {...props} />);
    expect(
      screen.getByText("Last used 2026-02-01 · expires 2027-01-01"),
    ).toBeInTheDocument();
    expect(screen.getByText("Revoked 2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("Never used")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Client name" }), {
      target: { value: "Mobile backend" },
    });
    submit("Create client and key");
    await screen.findByText("tp_agent_once");
    expect(
      screen.getByText(
        "Copy this key now. Only its hash is stored and the full value cannot be shown again.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Key name" }), {
      target: { value: "Rotation" },
    });
    submit("Create key");
    await screen.findByText("tp_agent_rotation");
    expect(screen.queryByText("tp_agent_once")).not.toBeInTheDocument();
    const current = screen.getByText("Current").closest("li");
    if (!current) throw new Error("Key row missing");
    const revokeForm = within(current)
      .getByRole("button", { name: "Revoke" })
      .closest("form");
    if (!revokeForm) throw new Error("Revocation form missing");
    fireEvent.submit(revokeForm);
    await waitFor(() =>
      expect(actions.revokeAgentApiKeyAction).toHaveBeenCalled(),
    );
    expect(
      (
        actions.revokeAgentApiKeyAction.mock.calls[0]?.[0] as
          | FormData
          | undefined
      )?.get("keyId"),
    ).toBe("live");
  });

  it("mints browser tokens bound to an explicit client, subject and allowed origin and reports denial", async () => {
    actions.createAgentClientTokenAction
      .mockResolvedValueOnce({ error: "Origin denied" })
      .mockResolvedValueOnce({ clientToken: "browser_subject_token" });
    render(<AgentApiPanel {...props} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create a short-lived browser token",
      }),
    );
    fireEvent.change(
      await screen.findByRole("textbox", { name: "End-user subject" }),
      { target: { value: "customer_42" } },
    );
    submit("Create token");
    expect(await screen.findByRole("alert")).toHaveTextContent("Origin denied");
    submit("Create token");
    await screen.findByText("browser_subject_token");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const data = actions.createAgentClientTokenAction.mock
      .calls[1]?.[1] as FormData;
    expect(data.get("clientId")).toBe("client");
    expect(data.get("subject")).toBe("customer_42");
    expect(data.get("origin")).toBe("https://customer.example");
  });

  it("hides all credential mutations from non-managers even with an existing shared endpoint", () => {
    render(
      <AgentApiPanel
        {...props}
        canManage={false}
        endpoint={{ ...endpoint, status: "disabled", isolationMode: "shared" }}
      />,
    );
    expect(screen.getByText("Disabled", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "FAQ" })).toBeDisabled();
    for (const name of [
      "Enable API",
      "Create key",
      "Revoke",
      "Create client and key",
      "Create a short-lived browser token",
      "Publish new revision",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it.each(["active", "disabled"])(
    "submits the opposite endpoint state from %s",
    async (status) => {
      actions.setAgentEndpointStatusAction.mockResolvedValue(undefined);
      render(
        <AgentApiPanel
          {...props}
          endpoint={{ ...endpoint, status, clients: [] }}
        />,
      );
      submit(status === "active" ? "Disable API" : "Enable API");
      await waitFor(() =>
        expect(actions.setAgentEndpointStatusAction).toHaveBeenCalled(),
      );
      expect(
        (
          actions.setAgentEndpointStatusAction.mock.calls[0]?.[0] as
            | FormData
            | undefined
        )?.get("status"),
      ).toBe(status === "active" ? "disabled" : "active");
      expect(screen.getByText("No API clients yet")).toBeInTheDocument();
    },
  );
});
