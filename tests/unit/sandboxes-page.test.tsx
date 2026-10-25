import { Children } from "react";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConnectorConfig } from "@/lib/sandboxes/connector";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  sandboxes: vi.fn(),
  runtimes: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
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
vi.mock("@/lib/sandboxes/queries", () => ({
  listSandboxes: mocks.sandboxes,
  listManagedAgentRuntimes: mocks.runtimes,
}));
vi.mock("@/lib/process/supervisor", () => ({
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  sandboxVolumeName: (id: string) => `toolplane-sandbox-${id}`,
}));
vi.mock("@/lib/sandboxes/actions", () => ({
  deleteSandboxAction: vi.fn(),
  restartSandboxAction: vi.fn(),
  startSandboxAction: vi.fn(),
  stopSandboxAction: vi.fn(),
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
vi.mock("@/components/dashboard/sandboxes/SshSandboxCreate", () => ({
  SshSandboxCreate: () => null,
}));
vi.mock("@/components/dashboard/sandboxes/SandboxCreateForm", () => ({
  SandboxCreateForm: () => null,
}));
vi.mock("@/components/dashboard/sandboxes/SandboxConnectorStatus", () => ({
  SandboxConnectorStatus: () => null,
}));
vi.mock("@/components/dashboard/sandboxes/SandboxBatchTable", () => ({
  SandboxBatchTable: ({
    rows,
  }: {
    rows: {
      id: string;
      name: string;
      batchEligible: boolean;
      cells: ReactNode[];
    }[];
  }) => (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} aria-label={row.name}>
            <td>
              <input
                aria-label={`Select ${row.name}`}
                type="checkbox"
                disabled={!row.batchEligible}
              />
            </td>
            {Children.map(row.cells, (cell) => (
              <td>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

import SandboxesPage from "@/app/app/[workspace]/sandboxes/page";
const page = (scope?: string) =>
  SandboxesPage({
    params: Promise.resolve({ workspace: "acme" }),
    searchParams: Promise.resolve({ scope }),
  });
const sandbox = (id: string, status = "running", kind = "docker") => ({
  id,
  name: `Sandbox ${id}`,
  slug: id,
  kind,
  image: "custom:image",
  network: "none",
  config: {},
  deploymentId: `dep-${id}`,
  deployment: { status },
  createdAt: new Date("2026-08-01"),
  agentLinks: [],
  _count: { agentLinks: 0, snapshots: 0 },
});
const runtime = (status = "running") => ({
  id: "runtime-1",
  status,
  image: "hermes:latest",
  lastError: null,
  agent: { id: "agent-1", name: "Research agent" },
  sandbox: {
    ...sandbox("hermes-sandbox", status),
    name: "Hermes runtime",
    config: { importSource: "hermes-archive" },
    snapshots: [],
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1", timeZone: "UTC" });
  mocks.workspace.mockResolvedValue({ id: "ws-1" });
  mocks.sandboxes.mockResolvedValue([]);
  mocks.runtimes.mockResolvedValue([]);
});
afterEach(cleanup);

describe("sandbox list ownership and scope", () => {
  it("requires sign-in and skips private list reads", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.sandboxes).not.toHaveBeenCalled();
  });
  it("redirects inaccessible workspace users", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.sandboxes).not.toHaveBeenCalled();
  });
  it("shows an actionable empty state without an empty batch table", async () => {
    render(await page());
    expect(screen.getByText("noSandboxesYet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "createALinuxSandboxThenAttachItToAnAgentFromTheAgentSettingsPage",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it.each(["all", "invalid", "agents", "users"])(
    "filters real ownership rows for scope %s",
    async (scope) => {
      mocks.sandboxes.mockResolvedValue([
        sandbox("personal"),
        {
          ...sandbox("attached"),
          agentLinks: [{ agent: { id: "agent-2", name: "Builder" } }],
          _count: { agentLinks: 1, snapshots: 2 },
        },
      ]);
      mocks.runtimes.mockResolvedValue([runtime()]);
      render(await page(scope));
      const expected =
        scope === "agents"
          ? ["Sandbox attached", "Hermes runtime"]
          : scope === "users"
            ? ["Sandbox personal"]
            : ["Sandbox personal", "Sandbox attached", "Hermes runtime"];
      expect(
        screen.getAllByRole("row").map((row) => row.getAttribute("aria-label")),
      ).toEqual(expected);
      expect(
        screen.getByRole("link", {
          name:
            scope === "agents"
              ? "agentSandboxes"
              : scope === "users"
                ? "userCreatedSandboxes"
                : "sandboxes",
        }),
      ).toHaveAttribute("aria-current", "page");
    },
  );
  it("sorts resources by creation date rather than resource type", async () => {
    mocks.sandboxes.mockResolvedValue([
      { ...sandbox("old"), createdAt: new Date("2026-01-01") },
      { ...sandbox("new"), createdAt: new Date("2026-10-01") },
    ]);
    mocks.runtimes.mockResolvedValue([runtime()]);
    render(await page());
    expect(
      screen.getAllByRole("row").map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Sandbox new", "Hermes runtime", "Sandbox old"]);
  });
  it.each([
    "running",
    "stopped",
    "provisioning",
    "copying",
    "copy_failed",
    "restoring",
    "restore_failed",
    "restore_cleanup_required",
    "upgrading",
    "deleting",
  ])("exposes safe lifecycle controls for %s", async (status) => {
    mocks.sandboxes.mockResolvedValue([sandbox("one", status)]);
    render(await page());
    const row = within(screen.getByRole("row", { name: "Sandbox one" }));
    const blocked = !["running", "stopped", "provisioning"].includes(status);
    if (blocked) {
      expect(
        row.queryByRole("button", { name: "start" }),
      ).not.toBeInTheDocument();
      expect(
        row.queryByRole("button", { name: "stop" }),
      ).not.toBeInTheDocument();
    } else
      expect(
        row.getByRole("button", {
          name: status === "stopped" ? "start" : "stop",
        }),
      ).toBeInTheDocument();
    if (blocked || status === "provisioning")
      expect(row.getByRole("checkbox")).toBeDisabled();
    else expect(row.getByRole("checkbox")).toBeEnabled();
  });
  it.each(["host", "ssh", "connector"])(
    "keeps invalid legacy %s resources out of lifecycle and batch operations",
    async (kind) => {
      mocks.sandboxes.mockResolvedValue([sandbox("legacy", "running", kind)]);
      render(await page());
      const row = within(screen.getByRole("row", { name: "Sandbox legacy" }));
      expect(row.getByRole("checkbox")).toBeDisabled();
      expect(
        row.queryByRole("button", { name: "stop" }),
      ).not.toBeInTheDocument();
      expect(
        row.getByText(
          kind === "host"
            ? "legacyHostDisabled"
            : kind === "ssh"
              ? "legacySshDisabled"
              : "connectorConfigMissing",
        ),
      ).toBeInTheDocument();
    },
  );
  it("shows configured connector provenance and allows its lifecycle operations", async () => {
    const connector = buildConnectorConfig(
      { serverUrl: "https://example.com", remoteRoot: "/home/ada" },
      "mcpcon_secret",
    );
    mocks.sandboxes.mockResolvedValue([
      {
        ...sandbox("connector", "running", "connector"),
        config: { connector },
      },
    ]);
    render(await page());
    const row = within(screen.getByRole("row", { name: "Sandbox connector" }));
    expect(
      row.getByText("connectorBackingStore:/home/ada"),
    ).toBeInTheDocument();
    expect(row.getByText("openSandboxToGenerateCommand")).toBeInTheDocument();
    expect(row.getByRole("checkbox")).toBeEnabled();
    expect(row.getByRole("button", { name: "stop" })).toBeInTheDocument();
  });
  it.each(["running", "stopped", "error", "setup_required", "copying"])(
    "renders managed runtime %s with agent rather than standalone deletion",
    async (status) => {
      mocks.runtimes.mockResolvedValue([
        {
          ...runtime(status),
          lastError: status === "error" ? "Runtime image unavailable" : null,
        },
      ]);
      render(await page());
      const row = within(screen.getByRole("row", { name: "Hermes runtime" }));
      expect(row.getByRole("link", { name: "Research agent" })).toHaveAttribute(
        "href",
        "/app/acme/agents/agent-1",
      );
      expect(
        row.queryByRole("link", { name: "channels" }),
      ).not.toBeInTheDocument();
      expect(
        row.queryByRole("link", { name: /terminal|dashboard/i }),
      ).not.toBeInTheDocument();
      expect(
        row.queryByRole("button", { name: "start" }),
      ).not.toBeInTheDocument();
      expect(
        row.queryByRole("button", { name: "restart" }),
      ).not.toBeInTheDocument();
      expect(
        row.queryByRole("button", { name: /Manage/ }),
      ).not.toBeInTheDocument();
      expect(row.getByText(/importedHermesArchiveLabel/)).toBeInTheDocument();
      expect(
        row.queryByRole("button", { name: "delete" }),
      ).not.toBeInTheDocument();
      if (status === "error")
        expect(row.getByText("Runtime image unavailable")).toBeInTheDocument();
      expect(row.getByRole("checkbox")).toBeDisabled();
      if (status === "running")
        expect(row.getByRole("button", { name: "stop" })).toBeInTheDocument();
      else
        expect(
          row.queryByRole("button", { name: "stop" }),
        ).not.toBeInTheDocument();
    },
  );
});
