import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  membership: vi.fn(),
  toolkit: vi.fn(),
  defaultToolkit: vi.fn(),
  mcps: vi.fn(),
  skills: vi.fn(),
  live: vi.fn(),
  tools: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: "example.com", "x-forwarded-proto": "https" }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/db", () => ({
  db: { membership: { findUnique: mocks.membership } },
}));
vi.mock("@/lib/toolkits/queries", () => ({
  getToolkitBySlug: mocks.toolkit,
  getOrCreateDefaultToolkit: mocks.defaultToolkit,
  getToolkitMcpCandidates: mocks.mcps,
  getToolkitSkillCandidates: mocks.skills,
}));
vi.mock("@/lib/toolkits/install-link", () => ({
  getOrCreateToolkitInstallLink: async () => ({ id: "install-link-1" }),
}));
vi.mock("@/lib/process/supervisor", () => ({
  liveStatus: mocks.live,
  effectiveStatus: (_id: string, status: string) => status,
}));
vi.mock("@/lib/process/mcp-client", () => ({ listMcpTools: mocks.tools }));
vi.mock("@/lib/toolkits/actions", () => ({
  cloneToolkitAction: vi.fn(),
  deleteToolkitAction: vi.fn(),
  renameToolkitAction: vi.fn(),
  removeServerFromToolkitAction: vi.fn(),
  removeSkillFromToolkitAction: vi.fn(),
  updateToolkitAvailabilityAction: vi.fn(),
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
vi.mock("@/components/dashboard/ConfirmSubmitButton", () => ({
  ConfirmSubmitButton: ({ triggerLabel }: { triggerLabel: ReactNode }) => (
    <button type="button">{triggerLabel}</button>
  ),
}));
vi.mock("@/components/dashboard/ToolkitInstall", () => ({
  ToolkitInstall: () => null,
}));
vi.mock("@/components/dashboard/toolkits/ToolkitResourcePicker", () => ({
  ToolkitResourcePicker: () => null,
}));

import ToolkitDetailPage from "@/app/app/[workspace]/toolkits/[slug]/page";
const page = (tab?: string, slug = "research") =>
  ToolkitDetailPage({
    params: Promise.resolve({ workspace: "acme", slug }),
    searchParams: Promise.resolve({ tab }),
  });
const toolkit = () => ({
  id: "toolkit-1",
  name: "Research toolkit",
  slug: "research",
  enabled: true,
  visibility: "private",
  servers: [],
  skills: [],
});
const deployment = (id: string) => ({
  id,
  name: `MCP ${id}`,
  serverId: null,
  server: null,
  source: "custom",
  sourceRef: null,
  status: "running",
});
const skill = () => ({
  id: "skill-1",
  name: "Writer skill",
  slug: "writer",
  skillId: null,
  skill: null,
  source: "custom",
  sourceRef: null,
  description: "Write reports",
  userInvocable: true,
  agentInvocable: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1" });
  mocks.workspace.mockResolvedValue({ id: "ws-1", ownerId: "user-1" });
  mocks.membership.mockResolvedValue(null);
  mocks.toolkit.mockResolvedValue(toolkit());
  mocks.mcps.mockResolvedValue([]);
  mocks.skills.mockResolvedValue([]);
  mocks.live.mockReturnValue("running");
  mocks.tools.mockResolvedValue([{ name: "search" }, { name: "fetch" }]);
});
afterEach(cleanup);

describe("toolkit detail tabs and management permissions", () => {
  it("requires sign-in before reading private toolkits", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.toolkit).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspaces", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.toolkit).not.toHaveBeenCalled();
  });
  it("returns notFound for missing toolkit slugs", async () => {
    mocks.toolkit.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("notFound");
  });
  it.each([undefined, "unknown"])(
    "defaults %s tabs to meaningful overview empty states",
    async (tab) => {
      render(await page(tab));
      expect(
        screen.getByRole("heading", { name: "Research toolkit" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("noServersAttachedYetAddSomeFromTheMcpsTab"),
      ).toBeInTheDocument();
      expect(screen.getByText("noSkillsAttachedYet")).toBeInTheDocument();
      expect(mocks.mcps).not.toHaveBeenCalled();
      expect(mocks.skills).not.toHaveBeenCalled();
    },
  );
  it("shows tool counts only for live MCPs and links attached resources", async () => {
    mocks.toolkit.mockResolvedValue({
      ...toolkit(),
      servers: [
        { id: "link-1", deployment: deployment("live") },
        { id: "link-2", deployment: deployment("offline") },
      ],
      skills: [{ id: "skill-link", installedSkill: skill() }],
    });
    mocks.live.mockImplementation((id: string) =>
      id === "live" ? "running" : "stopped",
    );
    render(await page());
    expect(screen.getByRole("link", { name: "MCP live" })).toHaveAttribute(
      "href",
      "/app/acme/mcp/live",
    );
    expect(screen.getByText("toolsCount:2")).toBeInTheDocument();
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Writer skill" })).toHaveAttribute(
      "href",
      "/app/acme/skills/skill-1",
    );
    expect(mocks.tools).toHaveBeenCalledExactlyOnceWith("live");
  });
  it.each(["mcps", "skills"])(
    "provides resource-specific empty state for %s",
    async (tab) => {
      render(await page(tab));
      expect(
        screen.getByText(
          tab === "mcps"
            ? "noServersInThisToolkitYet"
            : "noSkillsInThisToolkitYet",
        ),
      ).toBeInTheDocument();
      expect(tab === "mcps" ? mocks.mcps : mocks.skills).toHaveBeenCalledWith(
        "ws-1",
        "toolkit-1",
      );
      expect(mocks.tools).not.toHaveBeenCalled();
    },
  );
  it.each(["mcps", "skills"])(
    "provides removal controls for attached %s",
    async (tab) => {
      mocks.toolkit.mockResolvedValue({
        ...toolkit(),
        servers: [{ id: "link-1", deployment: deployment("one") }],
        skills: [{ id: "skill-link", installedSkill: skill() }],
      });
      render(await page(tab));
      expect(
        screen.getByText(tab === "mcps" ? "MCP one" : "Writer skill"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "remove" }),
      ).toBeInTheDocument();
    },
  );
  it("lets owners update availability while keeping identity and clone controls", async () => {
    render(await page("settings"));
    expect(
      screen.getByRole("button", { name: "saveAvailability" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "enabled" })).toBeChecked();
    expect(screen.getByLabelText("toolkitName")).toHaveValue(
      "Research toolkit",
    );
    expect(screen.getByLabelText("copyName")).toHaveValue(
      "copyNameDefault:Research toolkit",
    );
    expect(
      screen.getByRole("button", { name: "deleteToolkit" }),
    ).toBeInTheDocument();
    expect(mocks.membership).not.toHaveBeenCalled();
  });
  it.each([
    ["admin", true],
    ["member", false],
    [null, false],
  ])("enforces availability manager role %s", async (role, canManage) => {
    mocks.workspace.mockResolvedValue({ id: "ws-1", ownerId: "owner-2" });
    mocks.membership.mockResolvedValue(role ? { role } : null);
    render(await page("settings"));
    if (canManage)
      expect(
        screen.getByRole("button", { name: "saveAvailability" }),
      ).toBeInTheDocument();
    else {
      expect(
        screen.queryByRole("button", { name: "saveAvailability" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("onlyWorkspaceManagersCanUpdateAvailability"),
      ).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "clone" })).toBeInTheDocument();
  });
  it("creates the personal default toolkit but protects it from deletion", async () => {
    render(await page("settings", "me"));
    expect(mocks.defaultToolkit).toHaveBeenCalledWith("ws-1");
    expect(
      screen.queryByRole("button", { name: "deleteToolkit" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "rename" })).toBeInTheDocument();
  });
});
