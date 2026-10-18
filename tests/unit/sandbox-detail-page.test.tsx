import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConnectorConfig } from "@/lib/sandboxes/connector";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  sandbox: vi.fn(),
  status: vi.fn(),
  rpc: vi.fn(),
  live: vi.fn(),
  cookie: vi.fn(),
  endpoint: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/sandboxes/queries", () => ({ getSandbox: mocks.sandbox }));
vi.mock("@/lib/process/supervisor", () => ({ effectiveStatus: mocks.status }));
vi.mock("@/lib/process/mcp-client", () => ({ mcpRpc: mocks.rpc }));
vi.mock("@/lib/sandboxes/connector-broker", () => ({
  connectorStatus: mocks.live,
}));
vi.mock("@/lib/sandboxes/connector-setup-token", () => ({
  readConnectorSetupTokenCookie: mocks.cookie,
}));
vi.mock("@/lib/sandboxes/oauth-policy", () => ({
  sandboxMcpResource: mocks.endpoint,
}));
vi.mock("@/lib/sandboxes/actions", () => ({
  deleteSandboxAction: vi.fn(),
  generateConnectorCommandAction: vi.fn(),
  renameSandboxAction: vi.fn(),
  restartSandboxAction: vi.fn(),
  startSandboxAction: vi.fn(),
  stopSandboxAction: vi.fn(),
  updateSandboxEnvAction: vi.fn(),
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
vi.mock("@/components/dashboard/ConfirmSubmitButton", () => ({
  ConfirmSubmitButton: ({ triggerLabel }: { triggerLabel: string }) => (
    <button type="button">{triggerLabel}</button>
  ),
}));
vi.mock("@/components/dashboard/ProvisioningRefresher", () => ({
  ProvisioningRefresher: () => null,
}));
vi.mock("@/components/dashboard/CopyButton", () => ({
  CopyButton: () => null,
}));
vi.mock("@/components/dashboard/sandboxes/SandboxSettingsDialog", () => ({
  SandboxSettingsDialog: ({ children }: { children: ReactNode }) => (
    <section aria-label="settings">{children}</section>
  ),
}));
vi.mock("@/components/dashboard/sandboxes/SandboxConnectorStatus", () => ({
  SandboxConnectorStatus: () => null,
}));
vi.mock("@/components/dashboard/sandboxes/SandboxMcpExport", () => ({
  SandboxMcpExport: ({ endpoint }: { endpoint: string | null }) => (
    <p>{endpoint ?? "MCP endpoint unavailable"}</p>
  ),
}));
vi.mock("@/components/dashboard/sandboxes/SandboxDataManagement", () => ({
  SandboxDataManagement: ({
    disabled,
    creationDisabled,
    disabledLabel,
    snapshots,
  }: {
    disabled: boolean;
    creationDisabled: boolean;
    disabledLabel?: string;
    snapshots: { id: string; name: string; error: string | null }[];
  }) => (
    <section aria-label="snapshots">
      <button type="button" disabled={disabled || creationDisabled}>
        Create snapshot
      </button>
      {disabledLabel}
      {snapshots.map((snapshot) => (
        <p key={snapshot.id}>
          {snapshot.name} {snapshot.error}
        </p>
      ))}
    </section>
  ),
}));
vi.mock("@/components/dashboard/sandboxes/SandboxWorkspace", () => ({
  SandboxWorkspace: ({
    running,
    initialPath,
    initialEntries,
  }: {
    running: boolean;
    initialPath: string;
    initialEntries: { name: string }[];
  }) => (
    <section aria-label="workspace">
      <p>{running ? "Console available" : "Console offline"}</p>
      <p>{initialPath}</p>
      {initialEntries.map((entry) => (
        <p key={entry.name}>{entry.name}</p>
      ))}
    </section>
  ),
}));

import SandboxDetailPage from "@/app/app/[workspace]/sandboxes/[sandboxId]/page";

const page = () =>
  SandboxDetailPage({
    params: Promise.resolve({ workspace: "acme", sandboxId: "sb-1" }),
  });
const baseSandbox = () => ({
  id: "sb-1",
  name: "Build sandbox",
  slug: "build",
  kind: "docker",
  image: "sandbox:latest",
  network: "none",
  config: {},
  deploymentId: "dep-1",
  deployment: { status: "running" },
  agentLinks: [],
  snapshots: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1", timeZone: "UTC" });
  mocks.workspace.mockResolvedValue({ id: "ws-1" });
  mocks.sandbox.mockResolvedValue(baseSandbox());
  mocks.status.mockReturnValue("running");
  mocks.rpc.mockResolvedValue(null);
  mocks.live.mockReturnValue(null);
  mocks.cookie.mockResolvedValue(null);
  mocks.endpoint.mockReturnValue("https://example.com/mcp/sb-1");
});
afterEach(cleanup);

describe("sandbox detail access, console and lifecycle", () => {
  it("requires authentication before reading a sandbox", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspaces", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });
  it("returns notFound for a sandbox outside the workspace", async () => {
    mocks.sandbox.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("notFound");
    expect(mocks.sandbox).toHaveBeenCalledWith("ws-1", "sb-1");
  });
  it("offers stop and restart for a running Docker sandbox", async () => {
    render(await page());
    expect(
      screen.getByRole("heading", { name: "Build sandbox" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Console available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "restart" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "start" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("networkNone")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "attachToAgent" })).toHaveAttribute(
      "href",
      "/app/acme/agents",
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "dep-1",
      "tools/call",
      { name: "list_dir", arguments: { path: "." } },
      5000,
    );
  });
  it("keeps a stopped sandbox offline and offers start without querying files", async () => {
    mocks.status.mockReturnValue("stopped");
    render(await page());
    expect(screen.getByText("Console offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "start" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "stop" }),
    ).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    "copying",
    "copy_failed",
    "restoring",
    "restore_failed",
    "restore_cleanup_required",
    "upgrading",
    "deleting",
  ])("prevents lifecycle mutation while %s", async (status) => {
    mocks.status.mockReturnValue(status);
    render(await page());
    expect(
      screen.getByRole("textbox", { name: "environmentVariables" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "start" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "restart" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "attachToAgent" }),
    ).not.toBeInTheDocument();
    if (status === "copy_failed" || status === "deleting")
      expect(
        screen.queryByRole("region", { name: "snapshots" }),
      ).not.toBeInTheDocument();
    else
      expect(
        screen.getByRole("button", { name: "Create snapshot" }),
      ).toBeDisabled();
  });
  it.each(["host", "ssh", "connector"])(
    "does not enable legacy or invalid %s consoles",
    async (kind) => {
      mocks.sandbox.mockResolvedValue({ ...baseSandbox(), kind });
      render(await page());
      expect(screen.getByText("Console offline")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "stop" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "start" }),
      ).not.toBeInTheDocument();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("routes managed sandbox deletion through its owning agent", async () => {
    mocks.sandbox.mockResolvedValue({
      ...baseSandbox(),
      agentLinks: [{ agent: { id: "agent-1", name: "Builder" } }],
    });
    render(await page());
    expect(screen.getByText("deleteAgentSandboxFromAgent")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "delete" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Builder" })).toHaveAttribute(
      "href",
      "/app/acme/agents/agent-1",
    );
  });
  it("keeps endpoint configuration failure local to the export hint", async () => {
    mocks.endpoint.mockImplementation(() => {
      throw new Error("Missing APP_URL");
    });
    render(await page());
    expect(screen.getByText("MCP endpoint unavailable")).toBeInTheDocument();
    expect(screen.getByText("Console available")).toBeInTheDocument();
  });
  it.each([
    null,
    { content: [] },
    { content: [{ text: 1 }] },
    { content: [{ text: "not a directory" }] },
  ])(
    "uses a safe empty directory for malformed RPC result %j",
    async (result) => {
      mocks.rpc.mockResolvedValue(result);
      render(await page());
      expect(
        screen.getByRole("region", { name: "workspace" }),
      ).toHaveTextContent("Console available.");
    },
  );
  it("shows connector setup instead of a disconnected console and never exposes an unrelated token", async () => {
    const config = buildConnectorConfig(
      { serverUrl: "https://example.com", remoteRoot: "/home/ada" },
      "mcpcon_validsecret",
    );
    mocks.sandbox.mockResolvedValue({
      ...baseSandbox(),
      kind: "connector",
      config: { connector: config },
    });
    mocks.cookie.mockResolvedValue("mcpcon_othersecret");
    render(await page());
    expect(
      screen.getByRole("button", { name: "generateCommand" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("/home/ada")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/mcpcon_othersecret/)).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("makes connected connector consoles available while preserving setup in settings", async () => {
    const token = "mcpcon_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
    const config = buildConnectorConfig(
      { serverUrl: "https://example.com", remoteRoot: "/home/ada" },
      token,
    );
    mocks.sandbox.mockResolvedValue({
      ...baseSandbox(),
      kind: "connector",
      config: { connector: config },
    });
    mocks.cookie.mockResolvedValue(` ${token} `);
    mocks.live.mockReturnValue({
      connected: true,
      connectedAt: "2026-08-01",
      root: "/home/ada",
      displays: [],
    });
    render(await page());
    expect(screen.getByText("Console available")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "updateAndRegenerateCommand" }),
    ).toBeInTheDocument();
    expect(screen.getByText("linuxMacosWindows")).toBeInTheDocument();
    expect(screen.getByText("androidViaAdb")).toBeInTheDocument();
  });
  it("loads the initial file browser from a structured directory response", async () => {
    mocks.rpc.mockResolvedValue({
      content: [
        {
          text: JSON.stringify({
            path: "/workspace/project",
            entries: [
              { name: "README.md", type: "file", size: 25 },
              { name: "src", type: "dir", size: null },
            ],
          }),
        },
      ],
    });
    render(await page());
    expect(screen.getByRole("region", { name: "workspace" })).toHaveTextContent(
      "project",
    );
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });
  it("shows snapshot state without leaking underlying snapshot errors", async () => {
    mocks.sandbox.mockResolvedValue({
      ...baseSandbox(),
      snapshots: [
        {
          id: "snapshot-1",
          name: "Before upgrade",
          status: "error",
          error: "Private filesystem error",
          createdAt: new Date("2026-08-01"),
        },
      ],
    });
    render(await page());
    expect(screen.getByRole("region", { name: "snapshots" })).toHaveTextContent(
      "Before upgrade error",
    );
    expect(
      screen.queryByText("Private filesystem error"),
    ).not.toBeInTheDocument();
  });
});
