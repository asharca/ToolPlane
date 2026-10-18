import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  data: vi.fn(),
  plugin: vi.fn(),
  resolve: vi.fn(),
  authorize: vi.fn(),
  events: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: m.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: m.workspace,
}));
vi.mock("@/lib/observability/log", () => ({ getObservability: m.data }));
vi.mock("@/lib/observability/plugin-telemetry", () => ({
  getPluginTelemetry: m.plugin,
}));
vi.mock("@/lib/observability/queries", () => ({
  aggregateLogs: m.stats,
  authorizeLogs: m.authorize,
  listLogEvents: m.events,
  resolveLogFilters: m.resolve,
  getA2aMetadata: (metadata: unknown) => metadata,
  logFilterSchema: { safeParse: () => ({ success: true }) },
}));
vi.mock("@/components/dashboard/DashboardHeader", () => ({
  DashboardHeader: () => null,
}));
import Observability from "@/app/app/[workspace]/observability/page";
const page = (query = {}) =>
  Observability({
    params: Promise.resolve({ workspace: "acme" }),
    searchParams: Promise.resolve(query),
  });
const data = () => ({
  total: 0,
  errors: 0,
  avgMs: 0,
  p95Ms: 0,
  series: [],
  deployments: [],
  deploymentUsage: [],
  recent: [],
  selectedDeployment: null,
  nextCursor: null,
  until: "2026-08-02T00:00:00.000Z",
});
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: "user", timeZone: "UTC" });
  m.workspace.mockResolvedValue({ id: "ws" });
  m.data.mockResolvedValue(data());
  m.plugin.mockResolvedValue({
    skill: { total: 0, byUser: 0, byAgent: 0, errors: 0, recent: [] },
    sync: { applied: 0, failures: 0, recent: [] },
  });
  m.resolve.mockImplementation((value) => value);
  m.authorize.mockResolvedValue(undefined);
  m.events.mockResolvedValue({
    items: [],
    until: "2026-08-02",
    nextCursor: null,
  });
  m.stats.mockResolvedValue({ total: 0, errors: 0, p95Ms: 0 });
});
afterEach(cleanup);
describe("workspace observability operational states", () => {
  it("requires sign-in before reading telemetry", async () => {
    m.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(m.data).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspace telemetry", async () => {
    m.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(m.data).not.toHaveBeenCalled();
  });
  it("distinguishes no traffic from missing servers", async () => {
    render(await page({ tab: "usage" }));
    expect(
      screen.getByText(
        "noTrafficYetCallADeploymentsGatewayEndpointToSeeActivityHere",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("noServersYet")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "clearFilter" }),
    ).not.toBeInTheDocument();
  });
  it("derives aggregate and per-server error rates and links to the affected deployment", async () => {
    m.data.mockResolvedValue({
      ...data(),
      total: 1500,
      errors: 150,
      avgMs: 40,
      p95Ms: 90,
      selectedDeployment: "Search server",
      deployments: [{ id: "dep", name: "Search server" }],
      series: [
        { timestamp: "2026-08-01T00:00Z", hour: "00", total: 20, errors: 2 },
        { timestamp: "2026-08-01T01:00Z", hour: "01", total: 0, errors: 0 },
      ],
      deploymentUsage: [
        { id: "dep", name: "Search server", total: 20, errors: 2, avgMs: 40 },
        { id: null, name: "Workspace API", total: 0, errors: 0, avgMs: 0 },
      ],
    });
    await act(async () => {
      render(await page({ tab: "usage", q: "search", deploymentId: " dep " }));
    });
    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByText("filteredTo:Search server")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search server" })).toHaveAttribute(
      "href",
      "/app/acme/mcp/dep",
    );
    expect(screen.getByRole("link", { name: "clearFilter" })).toHaveAttribute(
      "href",
      "/app/acme/observability?tab=usage",
    );
  });
  it("explains absent plugin invocations and synchronization history", async () => {
    render(await page({ tab: "plugin" }));
    expect(
      screen.getByText(
        "noSkillInvocationsYetInstallAToolkitAsAnAutosyncPluginAndRunOneOfItsSkills",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("noSyncsRecordedYet")).toBeInTheDocument();
  });
  it("distinguishes user/agent invocation failures and sync outcomes", async () => {
    const date = new Date("2026-08-01");
    m.plugin.mockResolvedValue({
      skill: {
        total: 2000,
        byUser: 1500,
        byAgent: 500,
        errors: 1,
        recent: [
          {
            id: "ok",
            skillSlug: "writing",
            source: "user",
            outcome: "ok",
            errorClass: null,
            createdAt: date,
          },
          {
            id: "error",
            skillSlug: "research",
            source: "agent",
            outcome: "error",
            errorClass: "TimeoutError",
            createdAt: date,
          },
        ],
      },
      sync: {
        applied: 3,
        failures: 2,
        recent: [
          {
            id: "success",
            outcome: "applied",
            added: 2,
            updated: 1,
            removed: 0,
            createdAt: date,
          },
          {
            id: "failure",
            outcome: "failure",
            reason: "Checksum mismatch",
            added: 0,
            updated: 0,
            removed: 0,
            createdAt: date,
          },
          {
            id: "failure-empty",
            outcome: "failure",
            reason: null,
            added: 0,
            updated: 0,
            removed: 0,
            createdAt: date,
          },
        ],
      },
    });
    await act(async () => {
      render(await page({ tab: "plugin" }));
    });
    expect(screen.getByText("2.0k")).toBeInTheDocument();
    expect(screen.getByText("error · TimeoutError")).toBeInTheDocument();
    expect(screen.getByText("failure · Checksum mismatch")).toBeInTheDocument();
    expect(screen.getByText("writing")).toBeInTheDocument();
  });
  it("preserves pinned time window and search when loading older audit events", async () => {
    m.data.mockResolvedValue({ ...data(), nextCursor: "cursor-2" });
    render(await page({ tab: "audit", q: "search", deploymentId: "dep" }));
    const href = screen
      .getByRole("link", { name: "olderLogs" })
      .getAttribute("href");
    const url = new URL(href ?? "", "https://example.com");
    expect(url.searchParams.get("cursor")).toBe("cursor-2");
    expect(url.searchParams.get("until")).toBe("2026-08-02T00:00:00.000Z");
    expect(url.searchParams.get("q")).toBe("search");
    expect(url.searchParams.get("deploymentId")).toBe("dep");
  });
  it("rejects unsupported A2A windows before querying events", async () => {
    await expect(page({ tab: "a2a", range: "999" })).rejects.toThrow(
      "redirect:/app/acme/observability?tab=a2a",
    );
    expect(m.events).not.toHaveBeenCalled();
  });
  it("propagates log authorization failures instead of rendering private A2A events", async () => {
    m.authorize.mockRejectedValue(new Error("Forbidden log scope"));
    await expect(
      page({
        tab: "a2a",
        range: "1",
        q: "search",
        agentId: "agent",
        taskId: "task",
        direction: "inbound",
        outcome: "error",
        requestId: "request",
        contextId: "context",
        rootTaskId: "root",
        parentTaskId: "parent",
        until: "2026-08-02",
        cursor: "cursor",
      }),
    ).rejects.toThrow("Forbidden log scope");
    expect(m.events).not.toHaveBeenCalled();
  });
});
