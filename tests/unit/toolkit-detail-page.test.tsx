import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  toolkit: vi.fn(),
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
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/toolkits/queries", () => ({ getToolkitBySlug: mocks.toolkit }));

import ToolkitHistoryPage from "@/app/app/[workspace]/toolkits/[slug]/page";
const page = (slug = "research") =>
  ToolkitHistoryPage({
    params: Promise.resolve({ workspace: "acme", slug }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1" });
  mocks.workspace.mockResolvedValue({ id: "ws-1", ownerId: "user-1" });
  mocks.toolkit.mockResolvedValue({
    id: "toolkit-1",
    name: "Research toolkit",
    slug: "research",
    enabled: true,
    visibility: "private",
    servers: [
      {
        id: "link-1",
        deployment: {
          id: "mcp-1",
          name: "Saved MCP",
          serverId: null,
          server: null,
          source: "custom",
          sourceRef: null,
          status: "running",
        },
      },
    ],
    skills: [
      {
        id: "link-2",
        installedSkill: {
          id: "skill-1",
          name: "Saved Skill",
          slug: "writer",
          skillId: null,
          skill: null,
          source: "custom",
        },
      },
    ],
  });
});
afterEach(cleanup);

describe("read-only Toolkit history", () => {
  it("requires sign-in before reading private history", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.toolkit).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspaces", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.toolkit).not.toHaveBeenCalled();
  });
  it("does not create missing default history", async () => {
    mocks.toolkit.mockResolvedValue(null);
    await expect(page("me")).rejects.toThrow("notFound");
    expect(mocks.toolkit).toHaveBeenCalledWith("ws-1", "me");
  });
  it("renders saved resources without execution, install, publish, or edit actions", async () => {
    const { container } = render(await page());
    expect(
      screen.getByRole("heading", { name: "Research toolkit" }),
    ).toBeVisible();
    expect(screen.getByText("historyReadOnly")).toBeVisible();
    expect(screen.getByText("Saved MCP")).toBeVisible();
    expect(screen.getByText("Saved Skill")).toBeVisible();
    expect(screen.getByRole("link", { name: "newPiPackage" })).toHaveAttribute(
      "href",
      "/app/acme/market/compose",
    );
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector('a[href*="/install/"]')).toBeNull();
  });
});
