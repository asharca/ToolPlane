import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxMcpExport } from "@/components/dashboard/sandboxes/SandboxMcpExport";
import { WorkspaceModelSettings } from "@/components/dashboard/models/WorkspaceModelSettings";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/agents/actions", () => ({
  updateWorkspaceModelPreferenceAction: mocks.save,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("sandbox MCP grant workflows", () => {
  it.each([false, true])(
    "protects unavailable exports (exportable=%s)",
    (exportable) => {
      render(
        <SandboxMcpExport
          sandboxId="local"
          endpoint={null}
          exportable={exportable}
        />,
      );
      expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
      if (exportable) expect(screen.getByRole("alert")).toBeVisible();
      else expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("loads active and revoked grants and revokes only the selected grant", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          tokens: [
            {
              id: "one",
              name: "Desktop",
              allowedTools: ["read", "list"],
              expiresAt: "2026-12-01",
              oauthExpiresAt: "2026-11-01",
              revokedAt: null,
            },
            {
              id: "two",
              name: "Other client",
              allowedTools: ["read"],
              expiresAt: "2026-12-01",
              revokedAt: null,
            },
            {
              id: "old",
              name: "Old",
              allowedTools: [],
              expiresAt: "2026-01-01",
              revokedAt: "2026-01-01",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <SandboxMcpExport
        sandboxId="local"
        endpoint="https://example.test/sandbox/mcp"
        exportable
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /refresh authorizations/i }),
    );
    expect(await screen.findByText("Desktop")).toBeVisible();
    expect(screen.getByText("read, list")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^revoke$/i })).toHaveLength(
      2,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /^revoke$/i })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^revoke$/i })).toHaveLength(
        1,
      ),
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/v1/sandboxes/local/mcp-tokens/one",
      { method: "DELETE" },
    );
    expect(screen.getByText("Other client")).toBeVisible();
  });

  it.each(["load", "revoke"])(
    "reports %s failure without claiming successful revocation",
    async (phase) => {
      const fetcher = vi.fn();
      if (phase === "revoke")
        fetcher.mockResolvedValueOnce(
          Response.json({
            tokens: [
              {
                id: "one",
                name: "Desktop",
                allowedTools: ["read"],
                expiresAt: "2026-12-01",
                revokedAt: null,
              },
            ],
          }),
        );
      fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", fetcher);
      render(<SandboxMcpExport sandboxId="local" endpoint="/mcp" exportable />);
      fireEvent.click(
        screen.getByRole("button", { name: /refresh authorizations/i }),
      );
      if (phase === "revoke")
        fireEvent.click(
          await screen.findByRole("button", { name: /^revoke$/i }),
        );
      expect(await screen.findByRole("alert")).toBeVisible();
      if (phase === "revoke")
        expect(screen.getByRole("button", { name: /^revoke$/i })).toBeEnabled();
    },
  );

  it("shows the empty grant state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ tokens: [] })),
    );
    render(<SandboxMcpExport sandboxId="local" endpoint="/mcp" exportable />);
    fireEvent.click(
      screen.getByRole("button", { name: /refresh authorizations/i }),
    );
    expect(await screen.findByText(/no .*authorizations/i)).toBeVisible();
  });
});

describe("workspace model preference outcomes", () => {
  const providers = [
    { id: "provider", name: "Provider", models: ["model-one", "model-two"] },
  ];
  it("clears both preferences using the correct preference key", async () => {
    mocks.save.mockResolvedValue({});
    render(
      <WorkspaceModelSettings
        slug="team"
        providers={providers}
        defaultModel={{ providerId: "provider", model: "model-one" }}
        titleModel={{ providerId: "provider", model: "model-two" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /clear default/i }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[1].get("preference")).toBe("default");
    expect(mocks.save.mock.calls[0]?.[1].has("providerId")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /use default model/i }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1]?.[1].get("preference")).toBe("title");
  });

  it("rolls back a failed preference update and permits retry", async () => {
    mocks.save
      .mockResolvedValueOnce({ error: "Forbidden" })
      .mockResolvedValueOnce({});
    render(
      <WorkspaceModelSettings
        slug="team"
        providers={providers}
        defaultModel={{ providerId: "missing", model: "model-one" }}
        titleModel={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /clear default/i }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /default model: model-one/i }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /clear default/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("selects a real model through the picker and persists its provider", async () => {
    mocks.save.mockResolvedValue({});
    render(
      <WorkspaceModelSettings
        slug="team"
        providers={providers}
        defaultModel={null}
        titleModel={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /default model:/i }));
    fireEvent.click(await screen.findByRole("option", { name: /model-one/i }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0]?.[1].get("providerId")).toBe("provider");
    expect(mocks.save.mock.calls[0]?.[1].get("model")).toBe("model-one");
  });
});
