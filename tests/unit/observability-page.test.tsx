import { assertDefined } from "../assert-defined";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";
import type * as ObservabilityQueries from "@/lib/observability/queries";

const mocks = vi.hoisted(() => ({
  logs: vi.fn(),
  refresh: vi.fn(),
  redirect: vi.fn(),
  authorize: vi.fn(),
  events: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  redirect: mocks.redirect,
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: "console.observability" | "admin") =>
    createTranslator({ locale: "en", messages, namespace }),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: async () => ({ id: "user-1" }),
}));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: async () => ({ id: "workspace-1" }),
}));
vi.mock("@/lib/observability/log", () => ({ getObservability: mocks.logs }));
vi.mock("@/lib/observability/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityQueries>()),
  authorizeLogs: mocks.authorize,
  listLogEvents: mocks.events,
  aggregateLogs: mocks.stats,
}));
vi.mock("@/lib/observability/plugin-telemetry", () => ({
  getPluginTelemetry: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
import ObservabilityPage from "@/app/app/[workspace]/observability/page";

const until = "2026-09-28T10:00:00.000Z";
const cursor = Buffer.from(
  JSON.stringify({ id: "last-log", at: until }),
).toString("base64url");
const data = {
  series: [],
  total: 0,
  errors: 0,
  avgMs: 0,
  p95Ms: 0,
  recent: [],
  deploymentUsage: [],
  deployments: [{ id: "server-1", name: "Memory" }],
  selectedDeployment: null,
  nextCursor: null,
  until,
};

describe("workspace observability page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logs.mockResolvedValue(data);
    mocks.authorize.mockResolvedValue(undefined);
    mocks.stats.mockResolvedValue({
      total: 2,
      errors: 1,
      avgMs: 12,
      p95Ms: 24,
    });
    mocks.events.mockResolvedValue({ rows: [], nextCursor: null, until });
  });

  it.each([undefined, "invalid", "audit"])(
    "defaults %s to request logs and keeps an empty searchable toolbar",
    async (tab) => {
      render(
        await ObservabilityPage({
          params: Promise.resolve({ workspace: "acme" }),
          searchParams: Promise.resolve({ tab }),
        }),
      );
      expect(
        within(screen.getByRole("navigation", { name: "Sections" })).getByRole(
          "tab",
          { name: "Request log" },
        ),
      ).toHaveAttribute("aria-current", "page");
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Refresh" }),
      ).toBeInTheDocument();
      expect(screen.getByText("No requests recorded yet.")).toBeInTheDocument();
      expect(mocks.logs).toHaveBeenCalledWith(
        "workspace-1",
        expect.any(String),
        24,
        undefined,
        { userId: "user-1", q: undefined, cursor: undefined, until: undefined },
      );
    },
  );

  it("allows clearing a keyword without a selected server", async () => {
    render(
      await ObservabilityPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ q: "echo" }),
      }),
    );
    expect(screen.getByRole("textbox")).toHaveValue("echo");
    expect(
      screen.getByRole("link", {
        name: messages.console.observability.clearFilter,
      }),
    ).toHaveAttribute("href", "/app/acme/observability?tab=audit");
  });

  it("preserves filters and window when paging but resets cursors on applying or changing tabs", async () => {
    mocks.logs.mockResolvedValue({ ...data, nextCursor: cursor });
    render(
      await ObservabilityPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          tab: "audit",
          q: "echo",
          deploymentId: "server-1",
          cursor,
          until,
        }),
      }),
    );
    const older = new URL(
      assertDefined(
        screen
          .getByRole("link", { name: messages.console.observability.olderLogs })
          .getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(Object.fromEntries(older.searchParams)).toEqual({
      tab: "audit",
      q: "echo",
      deploymentId: "server-1",
      cursor,
      until,
    });
    const form = assertDefined(screen.getByRole("textbox").closest("form"));
    expect(Object.fromEntries(new FormData(form))).toEqual({
      tab: "audit",
      q: "echo",
      deploymentId: "server-1",
    });
    const usage = new URL(
      assertDefined(
        screen.getByRole("tab", { name: "Usage" }).getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(Object.fromEntries(usage.searchParams)).toEqual({
      tab: "usage",
      q: "echo",
      deploymentId: "server-1",
    });
  });

  it("scopes every A2A query before aggregation and excludes MCP data and bodies from the list", async () => {
    mocks.events.mockResolvedValue({
      rows: [
        {
          id: "event-1",
          createdAt: new Date(until),
          domain: "a2a",
          outcome: "error",
          eventName: "a2a.request",
          rpcMethod: "GetTask",
          durationMs: 12,
          agentId: "agent-1",
          detailState: "restricted",
          message: "private request text",
          attributes: {
            data: {
              a2a: {
                direction: "inbound",
                transport: "jsonrpc",
                taskId: "task-1",
              },
            },
          },
        },
      ],
      nextCursor: null,
      until,
    });
    const { container } = render(
      await ObservabilityPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          tab: "a2a",
          direction: "inbound",
          workspaceId: "untrusted-workspace",
        }),
      }),
    );
    expect(mocks.logs).not.toHaveBeenCalled();
    expect(mocks.authorize).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(mocks.events).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        domain: "a2a",
        eventName: "a2a.request",
        direction: "inbound",
        workspaceId: "workspace-1",
      }),
    );
    expect(mocks.stats).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "a2a",
        eventName: "a2a.request",
        workspaceId: "workspace-1",
      }),
    );
    expect(await screen.findByText("GetTask")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("private request text");
    const task = new URL(
      assertDefined(
        screen.getByRole("link", { name: "task-1" }).getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(Object.fromEntries(task.searchParams)).toMatchObject({
      tab: "a2a",
      taskId: "task-1",
    });
    expect(task.searchParams.has("eventName")).toBe(false);
  });

  it("preserves the fixed time window and filters on pagination but clears cursor when filters change", async () => {
    mocks.events.mockResolvedValue({
      rows: [
        {
          id: "settled-1",
          createdAt: new Date(until),
          domain: "a2a",
          outcome: "success",
          eventName: "a2a.task.settled",
          durationMs: 360000,
          detailState: "unavailable",
          attributes: {
            data: {
              a2a: {
                direction: "internal",
                transport: "entry",
                taskId: "task-1",
                rootTaskId: "root-1",
                taskState: "TASK_STATE_COMPLETED",
              },
            },
          },
        },
      ],
      nextCursor: cursor,
      until,
    });
    const { container } = render(
      await ObservabilityPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({
          tab: "a2a",
          range: "168",
          taskId: "task-1",
          direction: "outbound",
          cursor,
          until,
        }),
      }),
    );
    const filters = mocks.events.mock.calls[0][1];
    expect(filters.eventName).toBeUndefined();
    expect(filters.until.toISOString()).toBe(until);
    expect(screen.getByText("Events in filtered window")).toBeInTheDocument();
    expect(
      await screen.findByText("Task elapsed time: 360000 ms"),
    ).toBeInTheDocument();
    const root = new URL(
      assertDefined(
        screen
          .getByRole("link", { name: "Root task ID: root-1" })
          .getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(Object.fromEntries(root.searchParams)).toMatchObject({
      tab: "a2a",
      rootTaskId: "root-1",
    });
    expect(filters.since.toISOString()).toBe("2026-09-21T10:00:00.000Z");
    const older = new URL(
      assertDefined(
        screen.getByRole("link", { name: "Older logs" }).getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(Object.fromEntries(older.searchParams)).toMatchObject({
      tab: "a2a",
      range: "168",
      taskId: "task-1",
      direction: "outbound",
      cursor,
      until,
    });
    const form = new FormData(assertDefined(container.querySelector("form")));
    expect(form.has("cursor")).toBe(false);
    expect(form.has("until")).toBe(false);
    expect(form.get("taskId")).toBe("task-1");
    const range = new URL(
      assertDefined(
        screen.getByRole("link", { name: "1 hour" }).getAttribute("href"),
      ),
      "http://localhost",
    );
    expect(range.searchParams.get("taskId")).toBe("task-1");
    expect(range.searchParams.has("cursor")).toBe(false);
    expect(range.searchParams.has("until")).toBe(false);
    const refresh = new FormData(
      assertDefined(
        screen.getByRole("button", { name: "Refresh" }).closest("form"),
      ),
    );
    expect(refresh.get("taskId")).toBe("task-1");
    expect(refresh.get("direction")).toBe("outbound");
    expect(refresh.has("cursor")).toBe(false);
    expect(refresh.has("until")).toBe(false);
  });

  it("never aggregates A2A events when workspace log authorization fails", async () => {
    mocks.authorize.mockRejectedValue(new Error("Forbidden"));
    await expect(
      ObservabilityPage({
        params: Promise.resolve({ workspace: "acme" }),
        searchParams: Promise.resolve({ tab: "a2a" }),
      }),
    ).rejects.toThrow("Forbidden");
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
  });
});
