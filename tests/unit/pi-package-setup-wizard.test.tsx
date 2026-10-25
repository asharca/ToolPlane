import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
vi.mock("@/lib/market/pi-package-setup-action", () => ({
  configurePiPackageAction: vi.fn(),
}));
import { PiPackageSetupWizard } from "@/components/dashboard/market/PiPackageSetupWizard";
import { configurePiPackageAction } from "@/lib/market/pi-package-setup-action";

it("masks new-connection credentials and discards source-specific drafts without editing shared connections", async () => {
  const user = userEvent.setup();
  render(
    <PiPackageSetupWizard
      workspace="owned"
      releaseId="approved"
      requirements={[
        { key: "search", name: "Owned Search", tools: ["lookup"] },
      ]}
      agents={[]}
      sandboxes={[
        {
          id: "sandbox",
          name: "Owned sandbox",
          status: "running",
          network: "isolated",
        },
      ]}
      marketMcpReleases={[
        {
          id: "first",
          name: "First",
          version: 1,
          requiredEnvironment: ["TOKEN"],
        },
        {
          id: "second",
          name: "Second",
          version: 1,
          requiredEnvironment: ["API_KEY"],
        },
      ]}
      deployments={[{ id: "existing", name: "Shared", status: "running" }]}
    />,
  );
  const source = screen.getByRole("combobox", { name: "setupMcpSource" });
  await user.selectOptions(source, "release:first");
  const secret = screen.getByLabelText("setupEnvValue");
  expect(secret).toHaveAttribute("type", "password");
  await user.type(secret, "owned-secret-draft");
  await user.click(screen.getByText("setupMcpConfig", { selector: "summary" }));
  await user.type(
    screen.getByLabelText("setupMcpConfig"),
    "owned config draft",
  );
  await user.type(screen.getByLabelText("setupMcpEnvRemove"), "OLD_KEY");
  await user.selectOptions(source, "release:second");
  expect(screen.getByLabelText("setupEnvKey")).toHaveValue("API_KEY");
  expect(screen.getByLabelText("setupEnvValue")).toHaveValue("");
  expect(screen.getByLabelText("setupMcpConfig")).toHaveValue("");
  expect(screen.getByLabelText("setupMcpEnvRemove")).toHaveValue("");
  expect(
    screen.queryByDisplayValue("owned-secret-draft"),
  ).not.toBeInTheDocument();
  await user.selectOptions(source, "deployment:existing");
  expect(screen.queryByLabelText("setupEnvValue")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("setupMcpConfig")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "setupSharedConnectionSettings" }),
  ).toHaveAttribute("href", "/app/owned/mcp/existing");
});

it("reviews the current applied revision before publishing a package-enabled default", async () => {
  vi.mocked(configurePiPackageAction).mockResolvedValueOnce({
    status: "complete",
    marketInstallId: "install",
    agentId: "agent",
    enabled: true,
    agentRevisionId: "revision-next",
  });
  const user = userEvent.setup();
  render(
    <PiPackageSetupWizard
      workspace="owned"
      releaseId="approved"
      requirements={[]}
      agents={[
        {
          id: "agent",
          name: "Research",
          currentRevisionId: "revision-current",
          sandboxes: [],
        },
      ]}
      deployments={[]}
      marketMcpReleases={[]}
      sandboxes={[]}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "setupAgentOptional" }),
    "agent",
  );
  expect(screen.getByText("revision-current")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "setupApplyToAgent" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "setupApplyConsent" }));
  await user.click(
    screen.getByRole("checkbox", { name: "setupExecutableConsent" }),
  );
  await user.click(screen.getByRole("button", { name: "setupApplyToAgent" }));
  expect(await screen.findByText("setupAgentEnabled")).toBeInTheDocument();
  const submitted = vi.mocked(configurePiPackageAction).mock.calls.at(-1)?.[1];
  expect(submitted?.get("expectedRevisionId")).toBe("revision-current");
  expect(submitted?.get("confirmApplyToAgent")).toBe("yes");
  expect(
    screen.getByRole("link", { name: "setupAgentSettingsLink" }),
  ).toHaveAttribute("href", "/app/owned/agents/agent");
});

it("blocks unpublished Agent drafts and links to real revision preparation", async () => {
  const user = userEvent.setup();
  render(
    <PiPackageSetupWizard
      workspace="owned"
      releaseId="approved"
      requirements={[]}
      agents={[
        { id: "draft", name: "Draft", currentRevisionId: null, sandboxes: [] },
      ]}
      deployments={[]}
      marketMcpReleases={[]}
      sandboxes={[]}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "setupAgentOptional" }),
    "draft",
  );
  expect(screen.getByText("setupAgentRevisionRequired")).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "setupApplyConsent" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "setupApplyToAgent" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("link", { name: "setupAgentSettingsLink" }),
  ).toHaveAttribute("href", "/app/owned/agents/draft");
});

it.each([
  ["agent_revision_conflict", "setupAgentRevisionConflict"],
  ["agent_revision_preparation_required", "setupAgentRevisionRequired"],
])("reports %s without claiming activation", async (error, message) => {
  vi.mocked(configurePiPackageAction).mockResolvedValueOnce({ error });
  const user = userEvent.setup();
  render(
    <PiPackageSetupWizard
      workspace="owned"
      releaseId="approved"
      requirements={[]}
      agents={[
        {
          id: "agent",
          name: "Research",
          currentRevisionId: "revision-reviewed",
          sandboxes: [],
        },
      ]}
      deployments={[]}
      marketMcpReleases={[]}
      sandboxes={[]}
    />,
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "setupAgentOptional" }),
    "agent",
  );
  await user.click(screen.getByRole("checkbox", { name: "setupApplyConsent" }));
  await user.click(
    screen.getByRole("checkbox", { name: "setupExecutableConsent" }),
  );
  await user.click(screen.getByRole("button", { name: "setupApplyToAgent" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByText("setupAgentEnabled")).toBeNull();
  expect(screen.queryByText("setupComplete")).toBeNull();
});
