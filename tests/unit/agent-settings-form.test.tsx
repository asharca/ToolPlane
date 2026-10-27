import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";

const actions = vi.hoisted(() => ({
  updateAgentAction: vi.fn(),
  prepareAgentRevisionAction: vi.fn(),
  publishAgentRevisionAction: vi.fn(),
}));
vi.mock("@/lib/agents/actions", () => actions);
const credentials = vi.hoisted(() => ({
  createAgentEnvironmentCredentialAction: vi.fn(),
  listAgentEnvironmentCredentialsAction: vi.fn(),
  revokeAgentEnvironmentCredentialAction: vi.fn(),
}));
vi.mock("@/lib/agents/environment-credential-actions", () => credentials);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/dashboard/agents/AgentSystemPromptEditor", () => ({
  AgentSystemPromptEditor: () => null,
}));
vi.mock("@/components/dashboard/models/ModelPicker", () => ({
  ModelPicker: () => null,
}));

const config: AgentRevisionConfig = {
  schemaVersion: 1,
  runtimeKind: "pi-sdk",
  systemPrompt: "Review carefully.",
  providerId: null,
  model: null,
  modelProviderIds: [],
  maxSteps: 20,
  disabledBuiltinTools: [],
  sandboxTemplateId: null,
  environment: {
    kind: "docker",
    image: `example/pi@sha256:${"a".repeat(64)}`,
    network: "isolated",
    piVersion: "0.87.1",
    initialSnapshot: null,
    resourceLimits: { memoryBytes: 1_073_741_824, cpus: 1, pidsLimit: 128 },
    credentialReferences: [],
  },
  skills: [],
  knowledgeBaseIds: [],
  packages: [],
  mcpGrants: [],
  a2a: {
    inboundEnabled: false,
    outboundEnabled: false,
    policy: { schemaVersion: 1, targets: [] },
  },
};
const props = {
  slug: "acme",
  agentId: "agent-1",
  runtimeKind: "pi-sdk",
  name: "Researcher",
  systemPrompt: "",
  providerId: null,
  model: null,
  maxSteps: 20,
  providers: [],
  deployments: [],
  skills: [],
  sandboxes: [],
  subAgents: [],
};

describe("Agent revision settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.updateAgentAction.mockResolvedValue({ savedAt: 1 });
    actions.prepareAgentRevisionAction.mockResolvedValue({
      expectedRevisionId: "revision-1",
      config,
    });
    actions.publishAgentRevisionAction.mockResolvedValue({
      revisionId: "revision-2",
    });
    credentials.listAgentEnvironmentCredentialsAction.mockResolvedValue({
      credentials: [
        { id: "credential-1", name: "SERVICE_TOKEN", revokedAt: null },
      ],
    });
  });

  it("prepares without publishing, then applies the exact reviewed config with its CAS identity", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsForm {...props} />);
    await user.click(screen.getByRole("button", { name: "Prepare revision" }));
    expect(actions.publishAgentRevisionAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Review prepared revision" }),
    ).toHaveValue(JSON.stringify(config, null, 2));
    await user.click(screen.getByRole("button", { name: "Apply as default" }));
    await waitFor(() =>
      expect(actions.publishAgentRevisionAction).toHaveBeenCalledTimes(1),
    );
    const submitted = actions.publishAgentRevisionAction.mock
      .calls[0]?.[0] as FormData;
    expect(submitted.get("workspace")).toBe("acme");
    expect(submitted.get("agentId")).toBe("agent-1");
    expect(submitted.get("expectedRevisionId")).toBe("revision-1");
    expect(JSON.parse(String(submitted.get("config")))).toEqual(config);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Revision published",
    );
  });

  it("keeps a CAS rejection visible and does not silently replace the reviewed revision", async () => {
    actions.publishAgentRevisionAction.mockRejectedValue(
      new Error("Agent revision changed. Prepare again."),
    );
    const user = userEvent.setup();
    render(<AgentSettingsForm {...props} />);
    await user.click(screen.getByRole("button", { name: "Prepare revision" }));
    await user.click(screen.getByRole("button", { name: "Apply as default" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent revision changed. Prepare again.",
    );
    expect(actions.prepareAgentRevisionAction).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("textbox", { name: "Review prepared revision" }),
    ).toHaveValue(JSON.stringify(config, null, 2));
  });

  it("invalidates a prepared review when the draft changes and requires a draft save", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsForm {...props} />);
    await user.click(screen.getByRole("button", { name: "Prepare revision" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), " updated");
    expect(
      screen.queryByRole("button", { name: "Apply as default" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Prepare revision" }),
    ).toBeDisabled();
    expect(actions.updateAgentAction).not.toHaveBeenCalled();
    expect(actions.publishAgentRevisionAction).not.toHaveBeenCalled();
  });

  it("adds only an owner-scoped credential reference to the environment and invalidates review", async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsForm
        {...props}
        activeSection="sandboxes"
        canManageCredentials
        publishedRevision={{ id: "revision-1", version: 1, config }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Prepare revision" }));
    await user.click(screen.getByRole("button", { name: "Load credentials" }));
    await user.click(
      await screen.findByRole("button", { name: "Credential reference" }),
    );
    const environment = JSON.parse(
      (
        screen.getByRole("textbox", {
          name: "Environment definition",
        }) as HTMLTextAreaElement
      ).value,
    );
    expect(environment.credentialReferences).toEqual([
      { name: "SERVICE_TOKEN", credentialId: "credential-1" },
    ]);
    expect(
      screen.queryByRole("button", { name: "Apply as default" }),
    ).not.toBeInTheDocument();
    expect(actions.publishAgentRevisionAction).not.toHaveBeenCalled();
    const scope = credentials.listAgentEnvironmentCredentialsAction.mock
      .calls[0]?.[0] as FormData;
    expect(scope.get("workspace")).toBe("acme");
    expect(scope.get("agentId")).toBe("agent-1");
  });
});
