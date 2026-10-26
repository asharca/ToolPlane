import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const io = vi.hoisted(() => ({
  update: vi.fn(),
  env: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/lib/agents/actions", () => ({
  updateAgentAction: io.update,
  updateAgentRuntimeEnvAction: io.env,
}));
vi.mock("next/navigation", () => {
  const router = { refresh: io.refresh, push: io.push };
  return { useRouter: () => router };
});
vi.mock("next-intl", () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => "en" };
});
import { AgentSettingsForm } from "@/components/dashboard/agents/AgentSettingsForm";
const base = {
  slug: "space",
  agentId: "agent",
  runtimeKind: "pi-sdk",
  name: "Assistant",
  systemPrompt: "Be useful",
  providerId: null,
  model: null,
  maxSteps: 8,
  providers: [],
  deployments: [],
  skills: [],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
};

describe("agent configuration mutation feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const action of [io.update, io.env])
      action.mockResolvedValue({ savedAt: 1 });
  });
  it.each([
    ["PI_PACKAGE_MCP_BINDING_REQUIRED", "piPackageMcpBindingRequired"],
    ["pi_package_agent_busy", "piPackageErrors.pi_package_agent_busy"],
    ["pi_package_unknown", "piPackageErrors.unavailable"],
    ["Permission denied", "Permission denied"],
  ])(
    "translates %s autosave failures and keeps unsaved state",
    async (error, message) => {
      io.update.mockResolvedValue({ error });
      render(<AgentSettingsForm {...base} />);
      const name = screen.getByRole("textbox", { name: "name" });
      fireEvent.change(name, { target: { value: "Changed" } });
      fireEvent.blur(name, { relatedTarget: null });
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(name.closest("form")).toHaveAttribute(
        "data-unsaved-changes",
        "true",
      );
      expect((io.update.mock.calls[0][1] as FormData).get("name")).toBe(
        "Changed",
      );
    },
  );
  it("supports controlled navigation and does not flush while focus remains in the form", async () => {
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
    const name = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(name, { target: { value: "Updated" } });
    fireEvent.blur(name, {
      relatedTarget: screen.getByRole("textbox", { name: "description" }),
    });
    expect(io.update).not.toHaveBeenCalled();
  });
  it.each([["saveEnvironment", "env", "environmentSaved"]] as const)(
    "submits %s and exposes success and errors",
    async (label, action, message) => {
      const user = userEvent.setup();
      render(
        <AgentSettingsForm
          {...base}
          runtimeSandboxId="sandbox"
          runtimeEnvironment="KEY=value"
          activeSection="advanced"
          showNavigation={false}
        />,
      );
      io[action].mockResolvedValueOnce({ error: "Action denied" });
      await user.click(screen.getByRole("button", { name: label }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Action denied",
      );
      await user.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(screen.getAllByText(message).length).toBeGreaterThan(0),
      );
      const data = io[action].mock.calls[0][1] as FormData;
      expect(data.get("workspace")).toBe("space");
      expect(data.get("agentId")).toBe("agent");
    },
  );
  it("applies a current package version while preserving other package selections", async () => {
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
    const form = screen
      .getByRole("checkbox", { name: "Package" })
      .closest("form");
    if (!form) throw new Error("Missing settings form");
    fireEvent.submit(form);
    await waitFor(() => expect(io.update).toHaveBeenCalled());
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
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        JSON.parse(
          String(
            (io.update.mock.calls.at(-1)?.[1] as FormData | undefined)?.get(
              "piPackages",
            ),
          ),
        ),
      ).toEqual([{ marketInstallId: "second", releaseId: "new" }]),
    );
  });
});
