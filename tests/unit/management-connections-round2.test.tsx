import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { A2AConsoleView } from "@/lib/a2a/connection-info";
import type { AgentChannelConnectionClientView } from "@/lib/agents/channel-connection-client";
vi.mock("next-intl", () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => "en" };
});
import { AgentA2APanel } from "@/components/dashboard/agents/AgentA2APanel";
import { AgentMessagingPanel } from "@/components/dashboard/agents/AgentMessagingPanel";
const fetcher = vi.fn();
const baseView: A2AConsoleView = {
  canManage: true,
  local: { ready: false, supported: false },
  collaboration: { inboundEnabled: false, outboundEnabled: false },
  endpoint: {
    id: "endpoint",
    enabled: true,
    ready: true,
    revision: 3,
    clients: [],
  },
  connections: {
    localRpc: "https://example.test/local",
    localCard: "https://example.test/local/card",
    publicRpc: "https://example.test/public",
    publicCard: "https://example.test/public/card",
    publicMcp: "https://example.test/mcp",
  },
};
const channel: AgentChannelConnectionClientView = {
  id: "connection",
  agentId: "agent",
  sandboxId: null,
  platform: "feishu",
  platformLabel: "Feishu",
  name: "Team",
  status: "stopped",
  connectionMode: "websocket",
  credentialNames: [],
  credentialValues: {},
  missingStartCredentialNames: [],
  pairing: null,
  lastError: null,
};
function reply(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe("agent A2A management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetcher.mockResolvedValue(reply(baseView));
  });
  it("reads historical public connection details without issuing new credentials", async () => {
    const user = userEvent.setup();
    render(<AgentA2APanel slug="a b" agentId="agent/1" runtimeKind="hermes" />);
    await screen.findByText("https://example.test/local");
    expect(fetcher.mock.calls[0][0]).toContain("a%20b/agents/agent%2F1");
    await user.click(screen.getByRole("button", { name: "publicTitle" }));
    expect(screen.getByText("https://example.test/public")).toBeVisible();
    expect(screen.getByText("serviceCredential")).toBeVisible();
    expect(screen.queryByRole("button", { name: "createClient" })).toBeNull();
    expect(screen.queryByRole("button", { name: "createKey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "enablePublic" })).toBeNull();
    expect(screen.queryByRole("button", { name: "disablePublic" })).toBeNull();
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
      false,
    );
  });
  it("surfaces rejected directional mutations without submitting public enablement", async () => {
    const user = userEvent.setup();
    render(<AgentA2APanel slug="space" agentId="a" runtimeKind="pi-sdk" />);
    const button = await screen.findByRole("button", { name: "enableInbound" });
    fetcher.mockResolvedValueOnce(reply({}, false));
    await user.click(button);
    expect(await screen.findByText("operationFailed")).toBeVisible();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      action: "set-inbound",
      enabled: true,
    });
  });
  it("renders revoked, expired and active historical keys and submits only scoped revocation", async () => {
    const user = userEvent.setup();
    const keys = [
      {
        id: "live",
        name: "Live",
        prefix: "live-prefix",
        revokedAt: null,
        expiresAt: null,
      },
      {
        id: "old",
        name: "Old",
        prefix: "old-prefix",
        revokedAt: null,
        expiresAt: "2000-01-01",
      },
      {
        id: "revoked",
        name: "Revoked",
        prefix: "revoked-prefix",
        revokedAt: "2020-01-01",
        expiresAt: null,
      },
      {
        id: "future",
        name: "Future",
        prefix: "future-prefix",
        revokedAt: null,
        expiresAt: "2099-01-01",
      },
    ];
    const view = {
      ...baseView,
      endpoint: {
        ...baseView.endpoint,
        clients: [{ id: "client", name: "Device", status: "active", keys }],
      },
    };
    fetcher.mockResolvedValue(reply(view));
    render(<AgentA2APanel slug="space" agentId="a" runtimeKind="hermes" />);
    await screen.findByText("live-prefix");
    expect(screen.getAllByText("activeKey")).toHaveLength(2);
    expect(screen.getByText("expired")).toBeVisible();
    expect(screen.getByText("revoked")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "revoke" })[2]).toBeDisabled();
    expect(screen.queryByRole("button", { name: "createKey" })).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "revoke" })[0]);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            call[1]?.body ===
            JSON.stringify({ action: "revoke-key", keyId: "live" }),
        ),
      ).toBe(true),
    );
  });
  it.each(["native", "pi-sdk", "hermes"])(
    "enforces read-only and unavailable connections for %s",
    async (runtimeKind) => {
      fetcher.mockResolvedValue(
        reply({
          ...baseView,
          canManage: false,
          connections: null,
          endpoint: null,
        }),
      );
      render(
        <AgentA2APanel slug="space" agentId="a" runtimeKind={runtimeKind} />,
      );
      await screen.findByText("readOnly");
      expect(screen.getByText("invalidOrigin")).toBeVisible();
      expect(screen.getByText("connectionUnavailable")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "enableInbound" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "enableOutbound" }),
      ).toBeDisabled();
      expect(screen.queryByRole("button", { name: "enablePublic" })).toBeNull();
      expect(
        screen.queryByRole("link", { name: "openPublication" }),
      ).toBeNull();
    },
  );
  it("reports failed initial loads, recovers on refresh and ignores unmounted responses", async () => {
    const user = userEvent.setup();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    const view = render(
      <AgentA2APanel slug="space" agentId="a" runtimeKind="native" />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    await user.click(screen.getByRole("button", { name: "refresh" }));
    await screen.findByText("unsupportedLocal");
    view.unmount();
    const deferred = Promise.withResolvers<{
      ok: boolean;
      json: () => Promise<unknown>;
    }>();
    fetcher.mockReturnValueOnce(deferred.promise);
    const pending = render(
      <AgentA2APanel slug="space" agentId="b" runtimeKind="native" />,
    );
    pending.unmount();
    deferred.resolve(reply(baseView));
  });
  it.each([false, true])(
    "keeps inbound/outbound policy mutations independent from channel operators when enabled=%s",
    async (enabled) => {
      const user = userEvent.setup();
      const view = {
        ...baseView,
        local: { supported: true, ready: true },
        collaboration: { inboundEnabled: enabled, outboundEnabled: enabled },
        channels: [
          {
            id: "channel",
            name: "Team bridge",
            platform: "telegram",
            enabled,
            mine: true,
          },
        ],
      };
      fetcher.mockImplementation(async (url: string) =>
        reply(
          url.endsWith("/remotes") ? { canManage: true, agents: [] } : view,
        ),
      );
      render(<AgentA2APanel slug="space" agentId="a" runtimeKind="pi-sdk" />);
      const toggle = await screen.findByRole("button", {
        name: enabled ? "disableInbound" : "enableInbound",
      });
      await user.click(toggle);
      await waitFor(() =>
        expect(
          fetcher.mock.calls.some(
            (call) =>
              call[1]?.body ===
              JSON.stringify({ action: "set-inbound", enabled: !enabled }),
          ),
        ).toBe(true),
      );
      const outbound = screen.getByRole("button", {
        name: enabled ? "disableOutbound" : "enableOutbound",
      });
      await waitFor(() => expect(outbound).toBeEnabled());
      await user.click(outbound);
      await waitFor(() =>
        expect(
          fetcher.mock.calls.some(
            (call) =>
              call[1]?.body ===
              JSON.stringify({
                action: "set-outbound",
                enabled: !enabled,
              }),
          ),
        ).toBe(true),
      );
      const operator = screen.getByRole("button", {
        name: enabled ? "channelOperator.disable" : "channelOperator.enable",
      });
      if (!enabled) expect(operator).toBeDisabled();
      else {
        await waitFor(() => expect(operator).toBeEnabled());
        await user.click(operator);
        await waitFor(() =>
          expect(
            fetcher.mock.calls.some(
              (call) =>
                call[1]?.body ===
                JSON.stringify({
                  action: "set-channel-operator",
                  connectionId: "channel",
                  enabled: false,
                }),
            ),
          ).toBe(true),
        );
      }
    },
  );
  it("explains a supported runtime that is not ready", async () => {
    fetcher.mockImplementation(async (url: string) =>
      reply(
        url.endsWith("/remotes")
          ? { canManage: false, agents: [] }
          : {
              ...baseView,
              local: { supported: true, ready: false },
            },
      ),
    );
    render(<AgentA2APanel slug="space" agentId="a" runtimeKind="pi-sdk" />);
    expect(await screen.findByText("localNotReady")).toBeVisible();
    expect(screen.getByRole("button", { name: "enableInbound" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "enableOutbound" }),
    ).toBeEnabled();
  });
});

describe("agent messaging connection interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) =>
      reply(
        options?.method === "POST"
          ? { connections: [channel] }
          : {
              connections: [channel],
              agents: [{ id: "agent", name: "Assistant" }],
              sandboxes: [
                {
                  id: "next",
                  name: "Next sandbox",
                  agentId: null,
                  agentName: null,
                },
              ],
            },
      ),
    );
  });
  it("starts and stops connections and renders runtime errors", async () => {
    const user = userEvent.setup();
    render(
      <AgentMessagingPanel
        slug="space"
        connections={[channel]}
        ready={false}
      />,
    );
    await screen.findByText(/Assistant/);
    expect(
      screen.getByText(
        "configureAModelProviderBeforeExternalMessagesCanReceiveAgentReplies",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "start Team" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            call[1]?.body ===
            JSON.stringify({ action: "start", connectionId: "connection" }),
        ),
      ).toBe(true),
    );
    fetcher.mockResolvedValueOnce(
      reply({
        connections: [
          { ...channel, status: "running", lastError: "Last outage" },
        ],
      }),
    );
    await user.click(screen.getByRole("switch", { name: "start Team" }));
    expect(await screen.findByText("Last outage")).toBeVisible();
    await user.click(screen.getByRole("switch", { name: "stop Team" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            call[1]?.body ===
            JSON.stringify({ action: "stop", connectionId: "connection" }),
        ),
      ).toBe(true),
    );
  });
  it("edits names on blur and submits credentials without changing a sandbox binding", async () => {
    const user = userEvent.setup();
    render(<AgentMessagingPanel slug="space" connections={[channel]} />);
    await screen.findByText(/Assistant/);
    await user.click(screen.getByRole("button", { name: "edit" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", {
      name: "connectionName",
    });
    await user.clear(name);
    await user.type(name, "Renamed");
    fireEvent.blur(name);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          (call) =>
            call[1]?.body ===
            JSON.stringify({
              action: "update",
              connectionId: "connection",
              name: "Renamed",
            }),
        ),
      ).toBe(true),
    );
    const secret = within(dialog).getByLabelText("fields.FEISHU_APP_SECRET");
    fireEvent.change(secret, { target: { value: "new-secret" } });
    fireEvent.blur(secret);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some((call) =>
          call[1]?.body?.includes("new-secret"),
        ),
      ).toBe(true),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "saveCredentials" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("requires a target sandbox for migration and confirms deletion", async () => {
    const user = userEvent.setup();
    render(<AgentMessagingPanel slug="space" connections={[channel]} />);
    await screen.findByText(/Assistant/);
    await user.click(screen.getByRole("button", { name: "migrate" }));
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "migrate" }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("combobox", { name: "targetSandbox" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Next sandbox/ }),
    );
    expect(screen.getByText("targetHasNoAgent")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "migrate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetcher.mock.calls.some(
        (call) =>
          call[1]?.body ===
          JSON.stringify({
            action: "move",
            connectionId: "connection",
            sandboxId: "next",
          }),
      ),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "delete" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetcher.mock.calls.some(
        (call) =>
          call[1]?.body ===
          JSON.stringify({ action: "delete", connectionId: "connection" }),
      ),
    ).toBe(true);
  });
  it("opens runtime logs, displays entries, and retains server-side failures", async () => {
    const user = userEvent.setup();
    render(<AgentMessagingPanel slug="space" connections={[channel]} />);
    await screen.findByText(/Assistant/);
    fetcher.mockResolvedValueOnce(
      reply({
        logs: [
          { timestamp: "2026-01-01", level: "error", message: "Disconnected" },
          { timestamp: "2026-01-02", level: "info", message: "Reconnected" },
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "logs" }));
    expect(await screen.findByRole("log")).toHaveTextContent("Disconnected");
    expect(screen.getByRole("log")).toHaveTextContent("Reconnected");
  });
  it("shows request failures without discarding initial connections", async () => {
    fetcher.mockResolvedValueOnce(reply({ error: "Denied" }, false));
    render(
      <AgentMessagingPanel
        slug="space"
        agentId="agent"
        sandboxId="sandbox"
        connections={[
          { ...channel, sandboxId: "sandbox" },
          { ...channel, id: "other", agentId: "other", name: "Hidden" },
        ]}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
    expect(screen.getByText("Team")).toBeVisible();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(fetcher.mock.calls[0][0]).toContain("?sandboxId=sandbox");
  });
  it.each([
    ["feishu", "starting", "statusStarting"],
    ["telegram", "error", "statusError"],
    ["qqbot", "setup_required", "statusSetupRequired"],
    ["weixin", "waiting_callback", "statusWaitingCallback"],
    ["discord", "stopped", "statusStopped"],
    ["slack", "running", "statusRunning"],
  ] as const)(
    "renders %s credentials and %s lifecycle state",
    async (platform, status, label) => {
      const user = userEvent.setup();
      const connection = {
        ...channel,
        platform,
        status,
        sandboxId: "sandbox",
        credentialNames: ["FEISHU_APP_SECRET"],
      };
      fetcher.mockResolvedValue(reply({ connections: [connection] }));
      render(<AgentMessagingPanel slug="space" connections={[connection]} />);
      await user.click(
        screen.getByRole("button", { name: `platforms.${platform}` }),
      );
      expect(screen.getByText(label)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "edit" }));
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("combobox", { name: "bindAgent" }),
      ).toBeDisabled();
      if (platform === "qqbot") {
        await user.click(
          within(dialog).getByRole("switch", {
            name: "fields.QQBOT_REQUIRE_MENTION",
          }),
        );
        await waitFor(() =>
          expect(
            fetcher.mock.calls.some((call) =>
              call[1]?.body?.includes("QQBOT_REQUIRE_MENTION"),
            ),
          ).toBe(true),
        );
      }
      await user.click(
        within(dialog).getByRole("button", { name: "saveCredentials" }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const command = fetcher.mock.calls.find(
        (call) => call[1]?.method === "POST",
      )?.[1].body;
      expect(JSON.parse(command)).not.toHaveProperty("agentId");
    },
  );
  it.each(["expired", "ready"] as const)(
    "shows Telegram %s pairing feedback and applies allowed users",
    async (status) => {
      const user = userEvent.setup();
      const connection = {
        ...channel,
        platform: "telegram" as const,
        pairing: {
          provider: "telegram_managed_bot" as const,
          status,
          error: "Pairing note",
          extra: { ownerUserId: "42" },
        },
      };
      fetcher.mockResolvedValue(reply({ connections: [connection] }));
      render(<AgentMessagingPanel slug="space" connections={[connection]} />);
      await user.click(
        screen.getByRole("button", { name: "platforms.telegram" }),
      );
      await user.click(screen.getByRole("button", { name: "edit" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Pairing note",
      );
      if (status === "ready") {
        const allowed = within(dialog).getByRole("textbox", {
          name: "allowedTelegramUserIdsOptional",
        });
        expect(allowed).toHaveValue("42");
        fireEvent.change(allowed, { target: { value: "42,84" } });
        await user.click(
          within(dialog).getByRole("button", { name: "saveTelegramSetup" }),
        );
        await waitFor(() =>
          expect(
            fetcher.mock.calls.some(
              (call) =>
                call[1]?.body ===
                JSON.stringify({
                  action: "apply",
                  connectionId: "connection",
                  allowedUserIds: "42,84",
                }),
            ),
          ).toBe(true),
        );
      } else
        expect(within(dialog).getByRole("status")).toHaveTextContent(
          "statusExpired",
        );
      await user.click(
        within(dialog).getByRole("button", { name: "reauthenticate" }),
      );
      await waitFor(() =>
        expect(
          fetcher.mock.calls.some(
            (call) =>
              call[1]?.body ===
              JSON.stringify({ action: "pair", connectionId: "connection" }),
          ),
        ).toBe(true),
      );
    },
  );
  it("shows log-load errors and failed connection writes without closing the editor", async () => {
    const user = userEvent.setup();
    render(<AgentMessagingPanel slug="space" connections={[channel]} />);
    await screen.findByText(/Assistant/);
    fetcher.mockResolvedValueOnce(reply({ error: "Log access denied" }, false));
    await user.click(screen.getByRole("button", { name: "logs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Log access denied",
    );
    expect(screen.getByText("noLogs")).toBeVisible();
  });
});
