import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const io = vi.hoisted(() => ({
  update: vi.fn(),
  sync: vi.fn(),
  stop: vi.fn(),
  upgrade: vi.fn(),
  env: vi.fn(),
  model: vi.fn(),
  selection: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/agents/actions", () => ({
  updateAgentAction: io.update,
  syncAgentRuntimeAction: io.sync,
  stopAgentRuntimeAction: io.stop,
  upgradeHermesRuntimeAction: io.upgrade,
  updateAgentRuntimeEnvAction: io.env,
  updateAgentModelAction: io.model,
  updateHermesConversationSelectionAction: io.selection,
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
import { AgentModelDialog } from "@/components/dashboard/agents/AgentModelDialog";
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
const modelAgent = {
  id: "agent",
  name: "Assistant",
  runtimeKind: "hermes",
  providerId: null,
  providerIds: [],
  model: null,
};
const conversation = {
  id: "chat",
  profile: "default",
  provider: null,
  model: null,
  hasMessages: false,
  editable: true,
};
const profiles = [
  {
    name: "default",
    isDefault: true,
    provider: "openai",
    model: "gpt",
    description: "",
  },
  {
    name: "research",
    isDefault: false,
    provider: null,
    model: null,
    description: "",
  },
];
function dialog(
  props: Partial<React.ComponentProps<typeof AgentModelDialog>> = {},
) {
  return render(
    <AgentModelDialog
      open
      onOpenChange={vi.fn()}
      slug="space"
      agent={modelAgent}
      providers={[]}
      trigger={<button type="button">Open model</button>}
      hermesConversation={conversation}
      {...props}
    />,
  );
}
async function selectProfile() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "hermesProfile" }));
  await user.click(await screen.findByRole("option", { name: "research" }));
}

describe("agent configuration mutation feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const action of [
      io.update,
      io.sync,
      io.stop,
      io.upgrade,
      io.env,
      io.model,
      io.selection,
    ])
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
  it.each([
    ["syncRuntime", "sync", "runtimeSynced"],
    ["stopRuntime", "stop", "runtimeStopped"],
    ["upgradeHermesRuntime", "upgrade", "hermesRuntimeUpgraded"],
    ["saveEnvironment", "env", "environmentSaved"],
  ] as const)(
    "submits %s and exposes success and errors",
    async (label, action, message) => {
      const user = userEvent.setup();
      render(
        <AgentSettingsForm
          {...base}
          runtimeKind="hermes"
          activeSection="advanced"
          runtime={{
            kind: "hermes",
            image: "hermes:latest",
            status: "running",
            lastError: "Prior error",
            lastSyncedAt: "2026-01-01T00:00:00Z",
            sandboxId: "sandbox",
            environment: "KEY=value",
          }}
          hermesImages={["hermes:latest"]}
        />,
      );
      expect(screen.getByText("Prior error")).toBeVisible();
      io[action].mockResolvedValueOnce({ error: "Action denied" });
      await user.click(screen.getByRole("button", { name: label }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Action denied",
      );
      await user.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(screen.getAllByText(message).length).toBeGreaterThan(0),
      );
      expect(io.refresh).toHaveBeenCalled();
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

describe("Hermes conversation model selections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", io.fetch);
    io.fetch.mockResolvedValue(
      Response.json({ profiles, profileChatSupported: true }),
    );
    io.selection.mockResolvedValue({ savedAt: 5, conversationId: "chat" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  it("keeps new-conversation drafts local instead of invoking a server mutation", async () => {
    const user = userEvent.setup();
    const draft = vi.fn();
    const close = vi.fn();
    dialog({
      hermesConversation: { ...conversation, id: null },
      onHermesDraftChange: draft,
      onOpenChange: close,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
    );
    await selectProfile();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(draft).toHaveBeenCalledWith({
      profile: "research",
      provider: null,
      model: null,
    });
    expect(close).toHaveBeenCalledWith(false);
    expect(io.selection).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "confirms profile switches with fork=%s and routes to committed conversations",
    async (fork) => {
      const user = userEvent.setup();
      io.selection.mockResolvedValue({ savedAt: 2, conversationId: "fork" });
      dialog({
        hermesConversation: {
          ...conversation,
          hasMessages: true,
          forkOnProfileChange: fork,
        },
        confirmationMessage: "Confirm switch",
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
      );
      await selectProfile();
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(io.selection).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "save" }));
      await waitFor(() =>
        expect(io.push).toHaveBeenCalledWith(
          "/app/space/work?agent=agent&c=fork",
        ),
      );
      expect(window.confirm).toHaveBeenLastCalledWith(
        fork ? "hermesProfileSwitchStartsNewConversation" : "Confirm switch",
      );
      const data = io.selection.mock.calls[0][1] as FormData;
      expect(Object.fromEntries(data)).toEqual({
        workspace: "space",
        agentId: "agent",
        conversationId: "chat",
        profile: "research",
        useDefault: "1",
      });
    },
  );
  it("refreshes an existing selection once and reports persistence errors", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    io.selection.mockResolvedValueOnce({ error: "No access" });
    dialog({ onHermesSelectionSaved: saved });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No access");
    await user.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(io.refresh).toHaveBeenCalledOnce();
  });
  it.each(["error-body", "empty-body", "throw-string"])(
    "handles unavailable profile data: %s",
    async (mode) => {
      if (mode === "throw-string") io.fetch.mockRejectedValue("offline");
      else
        io.fetch.mockResolvedValue(
          Response.json(
            mode === "error-body" ? { error: "Profiles denied" } : {},
            { status: 503 },
          ),
        );
      dialog();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        mode === "error-body" ? "Profiles denied" : "hermesProfilesUnavailable",
      );
      expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    },
  );
  it.each(["valid-current", "valid-default", "first-model", "no-models"])(
    "chooses available custom models using %s",
    async (mode) => {
      const user = userEvent.setup();
      const providers =
        mode === "no-models"
          ? []
          : [
              {
                id: "provider",
                name: "Provider",
                models: ["first", "saved", "default"],
              },
            ];
      io.fetch.mockImplementation(async (url: string) =>
        Response.json(
          url.includes("/models?")
            ? {
                providers,
                provider: mode === "valid-default" ? "provider" : "missing",
                model: "default",
              }
            : { profiles, profileChatSupported: true },
        ),
      );
      dialog({
        hermesConversation: {
          ...conversation,
          provider: "provider",
          model: mode === "valid-current" ? "saved" : "gone",
        },
      });
      await waitFor(() => expect(io.fetch).toHaveBeenCalledTimes(2));
      if (mode === "no-models") {
        expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
        return;
      }
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "save" }));
      await waitFor(() => expect(io.selection).toHaveBeenCalled());
      const data = io.selection.mock.calls[0][1] as FormData;
      expect(data.get("provider")).toBe("provider");
      expect(data.get("model")).toBe(
        mode === "valid-current"
          ? "saved"
          : mode === "valid-default"
            ? "default"
            : "first",
      );
    },
  );
});
