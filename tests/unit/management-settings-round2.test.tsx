import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";

const io = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/agents/actions", () => ({
  updateAgentAction: io.update,
  prepareAgentRevisionAction: vi.fn(),
  publishAgentRevisionAction: vi.fn(),
  stopAgentRuntimeAction: vi.fn(),
}));
vi.mock("@/lib/agents/environment-credential-actions", () => ({
  createAgentEnvironmentCredentialAction: vi.fn(),
  listAgentEnvironmentCredentialsAction: vi.fn(),
  revokeAgentEnvironmentCredentialAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: io.refresh }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { has: () => true }),
}));
vi.mock("@/components/dashboard/agents/AgentSystemPromptEditor", () => ({
  AgentSystemPromptEditor: () => null,
}));
vi.mock("@/components/dashboard/models/ModelPicker", () => ({
  ModelPicker: () => null,
}));
const base = {
  slug: "space",
  agentId: "agent",
  runtimeKind: "pi-sdk",
  name: "Agent",
  systemPrompt: "Be useful",
  providerId: null,
  providerIds: [],
  model: null,
  maxSteps: 8,
  providers: [],
  deployments: [],
  skills: [],
  sandboxes: [],
  subAgents: [],
};

describe("Agent draft resource mutation feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.update.mockResolvedValue({ savedAt: 1 });
  });
  it("does not autosave and preserves unsaved state on explicit draft save failure", async () => {
    io.update.mockResolvedValue({ error: "Permission denied" });
    const user = userEvent.setup();
    render(<AgentSettingsForm {...base} />);
    const name = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(name, { target: { value: "Changed" } });
    fireEvent.blur(name, { relatedTarget: null });
    expect(io.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "saveDraft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission denied",
    );
    expect(name.closest("form")).toHaveAttribute(
      "data-unsaved-changes",
      "true",
    );
    expect((io.update.mock.calls[0][1] as FormData).get("name")).toBe(
      "Changed",
    );
  });
  it("preserves controlled navigation without saving a draft", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSettingsForm
        {...base}
        activeSection="general"
        onSectionChange={change}
      />,
    );
    await user.click(screen.getByRole("button", { name: "advanced" }));
    expect(change).toHaveBeenCalledWith("advanced");
    expect(screen.getByRole("textbox", { name: "name" })).toBeVisible();
    expect(io.update).not.toHaveBeenCalled();
  });
  it("updates a package draft version while preserving independently selected packages", async () => {
    const user = userEvent.setup();
    const pkg = {
      marketInstallId: "package",
      name: "Package",
      currentReleaseId: "new",
      currentVersion: 2,
      currentAvailable: true,
      enabledReleaseId: "old",
      enabledVersion: 1,
      enabledAvailable: false,
    };
    render(
      <AgentSettingsForm
        {...base}
        activeSection="piPackages"
        piPackages={[
          pkg,
          {
            ...pkg,
            marketInstallId: "second",
            name: "Second",
            enabledReleaseId: null,
          },
          {
            ...pkg,
            marketInstallId: "missing",
            name: "Missing",
            currentAvailable: false,
            currentReleaseId: null,
            currentVersion: null,
            enabledReleaseId: null,
          },
        ]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Missing" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "piPackageApplyWorkspaceVersion" }),
    );
    await user.click(screen.getByRole("button", { name: "saveDraft" }));
    await waitFor(() => expect(io.update).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        String((io.update.mock.calls[0][1] as FormData).get("piPackages")),
      ),
    ).toEqual([{ marketInstallId: "package", releaseId: "new" }]);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Second" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("checkbox", { name: "Second" }));
    await user.click(screen.getByRole("checkbox", { name: "Package" }));
    await user.click(screen.getByRole("button", { name: "saveDraft" }));
    await waitFor(() => expect(io.update).toHaveBeenCalledTimes(2));
    expect(
      JSON.parse(
        String((io.update.mock.calls[1][1] as FormData).get("piPackages")),
      ),
    ).toEqual([{ marketInstallId: "second", releaseId: "new" }]);
  });
});
