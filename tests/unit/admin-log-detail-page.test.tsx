import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  event: vi.fn(),
  trace: vi.fn(),
  a2a: vi.fn(),
  workspace: vi.fn(),
  user: vi.fn(),
  agent: vi.fn(),
  endpoint: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(",")}` : key,
      { has: () => false },
    ),
}));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/observability/queries", () => ({
  getLogEvent: mocks.event,
  getLogTrace: mocks.trace,
  getA2aMetadata: mocks.a2a,
}));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findUnique: mocks.workspace },
    user: { findUnique: mocks.user },
    agent: { findFirst: mocks.agent },
    agentEndpoint: { findFirst: mocks.endpoint },
  },
}));
vi.mock("@/components/dashboard/CopyButton", () => ({
  CopyButton: () => null,
}));
vi.mock("@/components/agents/agent-code", () => ({
  AgentCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

import LogDetailPage from "@/app/admin/logs/[id]/page";
const page = (returnTo?: string) =>
  LogDetailPage({
    params: Promise.resolve({ id: "event-1" }),
    searchParams: Promise.resolve({ returnTo }),
  });
const event = () => ({
  id: "event-1",
  eventName: "mcp.call",
  domain: "mcp",
  outcome: "success",
  createdAt: new Date("2026-08-01T12:00:00Z"),
  durationMs: null,
  httpStatus: null,
  requestId: null,
  traceId: "trace-1",
  workspaceId: null,
  actorId: null,
  agentId: null,
  deploymentId: null,
  runId: null,
  conversationId: null,
  channelId: null,
  providerId: null,
  model: null,
  method: null,
  path: null,
  rpcMethod: null,
  toolName: null,
  errorType: null,
  errorCode: null,
  attributes: null,
  detailState: "available",
  detail: null,
});
const detail = (payload: unknown, truncated = false) => ({
  data: { payload },
  expiresAt: new Date("2026-09-01"),
  truncated,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin-1" });
  mocks.event.mockResolvedValue(event());
  mocks.trace.mockResolvedValue([]);
  mocks.a2a.mockReturnValue(null);
  mocks.workspace.mockResolvedValue(null);
  mocks.user.mockResolvedValue(null);
  mocks.agent.mockResolvedValue(null);
  mocks.endpoint.mockResolvedValue(null);
});
afterEach(cleanup);

describe("admin log diagnostic detail", () => {
  it("enforces administrator access before reading event bodies", async () => {
    mocks.admin.mockRejectedValue(new Error("Admin access required"));
    await expect(page()).rejects.toThrow("Admin access required");
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("returns notFound for missing events within the admin scope", async () => {
    mocks.event.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("notFound");
    expect(mocks.event).toHaveBeenCalledWith({ adminId: "admin-1" }, "event-1");
  });
  it.each([
    ["expired", "logsBodyExpired"],
    ["restricted", "logsBodyRestricted"],
    ["missing", "logsBodyUnavailable"],
  ])(
    "explains %s body availability without inventing payloads",
    async (detailState, message) => {
      mocks.event.mockResolvedValue({ ...event(), detailState });
      render(await page());
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "logsRequestBody" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("logsNoTarget", { exact: false }),
      ).toBeInTheDocument();
    },
  );
  it("shows JSON request and response payloads in distinct readable regions", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      rpcMethod: "tools/call",
      durationMs: 125,
      httpStatus: 200,
      detail: detail({
        request: { query: "weather" },
        response: { result: "sunny" },
        responseKind: "json",
      }),
    });
    render(await page());
    expect(
      screen.getByRole("heading", { name: "tools/call" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "logsRequestBody" }),
    ).toHaveTextContent('"query": "weather"');
    expect(
      screen.getByRole("region", { name: "logsResponseBody" }),
    ).toHaveTextContent('"result": "sunny"');
    expect(screen.getByText("125 ms")).toBeInTheDocument();
    expect(screen.getByText("HTTP 200")).toBeInTheDocument();
  });
  it("does not reveal a retained payload when the detail state restricts access", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      detailState: "restricted",
      detail: detail({
        request: { secret: "do-not-render" },
        response: { token: "private" },
      }),
    });
    render(await page());
    expect(screen.queryByText(/do-not-render/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "logsResponseBody" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("logsBodyRestricted")).toHaveLength(1);
  });
  it.each([
    [true, "logsNoResponseBody"],
    [false, "logsNoResponseReceived"],
  ])(
    "distinguishes complete=%s responses with no body",
    async (responseComplete, message) => {
      mocks.event.mockResolvedValue({
        ...event(),
        eventName: "a2a.request",
        detail: detail({ responseKind: "none", responseComplete }),
      });
      render(await page());
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByText("logsRequestBody")).toBeInTheDocument();
    },
  );
  it.each([
    [true, true, "logsResponseTruncated"],
    [false, true, "logsResponseComplete"],
    [false, false, "logsResponseDisconnected"],
  ])(
    "explains streamed response truncation=%s completion=%s",
    async (truncated, responseComplete, message) => {
      mocks.event.mockResolvedValue({
        ...event(),
        detailState: truncated ? "truncated" : "available",
        detail: detail(
          {
            response: [{ data: "chunk" }],
            responseKind: "sse",
            responseComplete,
          },
          truncated,
        ),
      });
      render(await page());
      expect(
        screen.getByText(`logsSseResponse · ${message}`),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: "logsResponseBody" }),
      ).toHaveTextContent("chunk");
    },
  );
  it("shows a diagnostic-only detail instead of fabricating request or response bodies", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      detail: {
        data: { diagnostic: "Process exited unexpectedly" },
        expiresAt: new Date("2026-09-01"),
      },
    });
    render(await page());
    expect(
      screen.getByRole("region", { name: "logsDiagnosticDetail" }),
    ).toHaveTextContent("Process exited unexpectedly");
    expect(screen.queryByText("logsResponseBody")).not.toBeInTheDocument();
  });
  it("extracts RPC error detail from the response when no explicit diagnostic error exists", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      outcome: "error",
      detail: detail({
        response: { error: { code: -32601, message: "Unknown method" } },
      }),
    });
    render(await page());
    expect(
      screen.getByRole("region", { name: "logsErrorDetail" }),
    ).toHaveTextContent("Unknown method");
  });
  it("prefers explicit diagnostic errors to the transport response", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      detail: {
        ...detail({ response: { error: "Transport failure" } }),
        data: {
          error: { cause: "Credential expired" },
          payload: { response: { error: "Transport failure" } },
        },
      },
    });
    render(await page());
    expect(
      screen.getByRole("region", { name: "logsErrorDetail" }),
    ).toHaveTextContent("Credential expired");
    expect(
      screen.getByRole("region", { name: "logsErrorDetail" }),
    ).not.toHaveTextContent("Transport failure");
  });
  it("resolves related identities and builds scoped correlation navigation", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      workspaceId: "ws-1",
      actorId: "user-1",
      agentId: "agent-1",
      deploymentId: "dep-1",
      requestId: "req-1",
      attributes: { task: "metadata" },
      eventName: "a2a.task.settled",
    });
    mocks.a2a.mockReturnValue({
      endpointId: "endpoint-1",
      direction: "inbound",
      taskId: "task-1",
      contextId: "ctx-1",
      rootTaskId: "root-1",
      parentTaskId: "parent-1",
      taskState: "completed",
      rpcErrorCode: -32000,
    });
    mocks.workspace.mockResolvedValue({ id: "ws-1", name: "Acme" });
    mocks.user.mockResolvedValue({
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
    });
    mocks.agent.mockResolvedValue({ name: "Research agent" });
    mocks.endpoint.mockResolvedValue({ name: "Public endpoint" });
    mocks.trace.mockResolvedValue([
      {
        ...event(),
        id: "http-1",
        domain: "http",
        eventName: "http.request",
        requestId: "req-1",
        path: "/api/a2a",
        message: "HTTP entry",
      },
      { ...event(), toolName: "search", message: "fallback" },
    ]);
    render(await page("/admin/logs?tab=a2a"));
    expect(screen.getByText("Acme / Research agent")).toBeInTheDocument();
    expect(screen.getByText("/api/a2a")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(
      screen.getByText("logFields.rpcErrorCode: -32000"),
    ).toBeInTheDocument();
    const taskLink = screen.getByRole("link", { name: "task-1" });
    const taskUrl = new URL(
      taskLink.getAttribute("href") ?? "",
      "https://example.com",
    );
    expect(taskUrl.searchParams.get("domain")).toBe("a2a");
    expect(taskUrl.searchParams.get("tab")).toBe("a2a");
    expect(taskUrl.searchParams.get("taskId")).toBe("task-1");
    expect(taskUrl.searchParams.get("since")).toBe("2026-08-01T11:00:00.000Z");
    expect(
      screen.getByRole("link", { name: "workspaces: Acme" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/workspaces/ws-1?returnTo="),
    );
  });
  it("falls back to endpoint and service client identities when user and agent are absent", async () => {
    mocks.event.mockResolvedValue({
      ...event(),
      workspaceId: "ws-1",
      actorId: null,
    });
    mocks.a2a.mockReturnValue({
      endpointId: "endpoint-1",
      clientId: "client-1",
      direction: "inbound",
    });
    mocks.endpoint.mockResolvedValue({ name: "Public endpoint" });
    render(await page("https://evil.example"));
    expect(screen.getByText("ws-1 / Public endpoint")).toBeInTheDocument();
    expect(
      screen.getByText("logsServiceClient · client-1"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "logsTitle" })).toHaveAttribute(
      "href",
      "/admin/logs",
    );
  });
  it("caps a trace at 500 events and discloses truncation", async () => {
    mocks.trace.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        ...event(),
        id: `trace-row-${index}`,
        eventName: `trace-event-${index}`,
        outcome: index % 2 ? "error" : "success",
        message: "Trace step",
        durationMs: index,
      })),
    );
    render(await page());
    expect(screen.getByRole("status")).toHaveTextContent("logsTruncated");
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(500);
    expect(screen.queryByText("trace-event-500")).not.toBeInTheDocument();
  });
});
