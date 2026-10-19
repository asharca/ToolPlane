import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ admin: vi.fn(), overview: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: m.admin }));
vi.mock("@/lib/admin/overview", () => ({ getSystemOverview: m.overview }));
import Overview from "@/app/admin/page";
const overview = () => ({
  counts: {
    users: 2,
    agents: 3,
    toolkits: 4,
    installedSkills: 5,
    providers: 6,
    servers: 7,
    skills: 8,
    agentListings: 9,
    clients: 10,
    categories: 11,
    workspaces: 12,
    memberships: 13,
    deployments: {},
  },
  requests: { total: 0, errors: 0, p95Ms: 0 },
  a2aRequests: { total: 0, errors: 0, p95Ms: 0 },
  attention: {
    pendingReviews: 0,
    abnormalCount: 0,
    unavailableWorkspaces: 0,
    abnormalDeployments: [],
    recentFailures: [],
  },
  recentRequests: [],
  recentUsers: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue({ id: "admin", timeZone: "UTC" });
  m.overview.mockResolvedValue(overview());
});
afterEach(cleanup);
describe("admin overview triage", () => {
  it("requires admin authorization before collecting system inventory", async () => {
    m.admin.mockRejectedValue(new Error("Admin required"));
    await expect(Overview()).rejects.toThrow("Admin required");
    expect(m.overview).not.toHaveBeenCalled();
  });
  it("distinguishes a quiet system from unavailable metrics", async () => {
    render(await Overview());
    expect(screen.getByText("noPendingWork")).toBeInTheDocument();
    expect(screen.getByText("noErrors")).toBeInTheDocument();
    expect(screen.getByText("noRecentSignups")).toBeInTheDocument();
    expect(screen.getByText("overviewNoDeployments")).toBeInTheDocument();
    expect(screen.getAllByText("noRequestData")).toHaveLength(3);
  });
  it("links operational failures, unavailable workspaces and review work to scoped diagnostics", async () => {
    const data = overview();
    m.overview.mockResolvedValue({
      ...data,
      attention: {
        pendingReviews: 2,
        abnormalCount: 2,
        unavailableWorkspaces: 1,
        abnormalDeployments: [
          {
            id: "dep-1",
            name: "Search failed",
            status: "error",
            workspaceId: "ws",
            workspace: { name: "Acme" },
          },
          {
            id: "dep-2",
            name: null,
            status: "custom_failure",
            workspaceId: "ws",
            workspace: { name: "Acme" },
          },
        ],
        recentFailures: [
          {
            id: "event",
            message: "Process exited",
            eventName: "runtime.exit",
            createdAt: new Date("2026-08-01"),
            outcome: "error",
          },
        ],
      },
    });
    render(await Overview());
    expect(screen.queryByText("noPendingWork")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Search failed/ })).toHaveAttribute(
      "href",
      expect.stringContaining("deploymentId=dep-1"),
    );
    expect(screen.getByRole("link", { name: /dep-2/ })).toHaveTextContent(
      "custom_failure",
    );
    expect(
      screen.getByRole("link", { name: /Process exited/ }),
    ).toHaveAttribute("href", "/admin/logs/event?returnTo=%2Fadmin");
    expect(
      screen.getByRole("link", { name: /workspaces \/ delete_failed/ }),
    ).toHaveAttribute("href", "/admin/workspaces?status=delete_failed");
  });
  it("shows deployment status totals and proportions including unknown lifecycle states", async () => {
    const data = overview();
    m.overview.mockResolvedValue({
      ...data,
      counts: {
        ...data.counts,
        deployments: { running: 6, error: 2, failed: 1, stopped: 1, custom: 3 },
      },
    });
    render(await Overview());
    expect(
      screen.getByRole("progressbar", { name: "deploymentStatusRunning" }),
    ).toHaveAttribute("value", "6");
    expect(
      screen.getByRole("progressbar", { name: "deploymentStatusRunning" }),
    ).toHaveAttribute("max", "13");
    expect(screen.getByRole("progressbar", { name: "custom" })).toHaveAttribute(
      "value",
      "3",
    );
  });
  it("renders mixed request caller identities, operation fallbacks and durations", async () => {
    const data = overview();
    const base = {
      createdAt: new Date("2026-08-01"),
      outcome: "ok",
      durationMs: 12,
      actorId: null,
      actorName: null,
      clientId: null,
      rpcMethod: null,
      toolName: null,
      eventName: "gateway.request",
      domain: "mcp",
    };
    m.overview.mockResolvedValue({
      ...data,
      requests: { total: 12, errors: 2, p95Ms: 250 },
      a2aRequests: { total: 3, errors: 0, p95Ms: 40 },
      recentRequests: [
        {
          ...base,
          id: "named",
          actorId: "user-1",
          actorName: "Ada",
          rpcMethod: "tools/call",
        },
        {
          ...base,
          id: "anonymous-name",
          actorId: "user-2",
          toolName: "search_documents",
          durationMs: null,
        },
        {
          ...base,
          id: "client",
          clientId: "client-key",
          domain: "a2a",
          rpcMethod: "message/send",
        },
        { ...base, id: "unknown" },
      ],
    });
    await act(async () => {
      render(await Overview());
    });
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("user-2")).toBeInTheDocument();
    expect(screen.getByText("client-key")).toBeInTheDocument();
    expect(screen.getByText("logsUnknownCaller")).toBeInTheDocument();
    expect(screen.getByText("250 ms")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /search_documents/ }),
    ).toHaveAttribute("href", "/admin/logs/anonymous-name?returnTo=%2Fadmin");
  });
  it("shows signup identity fallbacks and administrative suspension badges", async () => {
    m.overview.mockResolvedValue({
      ...overview(),
      recentUsers: [
        {
          id: "ada",
          name: "Ada",
          email: "ada@example.com",
          role: "admin",
          status: "suspended",
          createdAt: new Date("2026-08-01"),
        },
        {
          id: "bob",
          name: null,
          email: "bob@example.com",
          role: "user",
          status: "active",
          createdAt: new Date("2026-08-01"),
        },
      ],
    });
    render(await Overview());
    expect(
      screen.getByRole("link", { name: /Ada.*ada@example.com/ }),
    ).toHaveAttribute("href", "/admin/users/ada");
    expect(
      screen.getByRole("link", { name: /bob@example.com/ }),
    ).toHaveAttribute("href", "/admin/users/bob");
    expect(screen.getByText("suspended")).toBeInTheDocument();
  });
});
