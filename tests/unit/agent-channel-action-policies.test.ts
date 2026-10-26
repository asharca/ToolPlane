// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentChannelConnectionAction,
  updateAgentChannelConnectionCredentialsAction,
  requestAgentChannelPairingAction,
  checkAgentChannelPairingAction,
  deleteAgentChannelConnectionAction,
  startAgentChannelConnectionAction,
  stopAgentChannelConnectionAction,
} from "@/lib/agents/actions";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  agent: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  request: vi.fn(),
  check: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/db", () => ({ db: { agent: { findFirst: mocks.agent } } }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/agents/channel-connections", () => ({
  createAgentChannelConnection: mocks.create,
  updateAgentChannelConnectionCredentials: mocks.update,
  deleteAgentChannelConnection: mocks.remove,
}));
vi.mock("@/lib/agents/channel-pairing", () => ({
  requestAgentChannelPairing: mocks.request,
  checkAgentChannelPairing: mocks.check,
}));
vi.mock("@/lib/agents/channel-runtime", () => ({
  startAgentChannelRunner: mocks.start,
  stopAgentChannelRunner: mocks.stop,
}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({}));
vi.mock("@/lib/sandboxes/actions", () => ({}));
vi.mock("@/lib/process/supervisor", () => ({}));

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "acme",
    agentId: "agent",
    connectionId: "connection",
    platform: "telegram",
    ...values,
  }))
    data.set(key, value);
  return data;
}
const actions = [
  createAgentChannelConnectionAction,
  updateAgentChannelConnectionCredentialsAction,
  requestAgentChannelPairingAction,
  checkAgentChannelPairingAction,
  deleteAgentChannelConnectionAction,
  startAgentChannelConnectionAction,
  stopAgentChannelConnectionAction,
];

describe("round two agent channel action authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "owner" });
    mocks.workspace.mockResolvedValue({ id: "workspace", ownerId: "owner" });
    mocks.agent.mockResolvedValue({ publicRuntimeAllocation: null });
    mocks.create.mockResolvedValue({
      connection: { id: "created", missingStartCredentialNames: [] },
    });
  });

  it.each(actions)(
    "requires owner permission before any channel mutation",
    async (action) => {
      mocks.workspace.mockResolvedValue({ id: "workspace", ownerId: "other" });
      await action(form());
      for (const operation of [
        mocks.create,
        mocks.update,
        mocks.remove,
        mocks.request,
        mocks.check,
        mocks.start,
        mocks.stop,
      ])
        expect(operation).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it.each([null, { publicRuntimeAllocation: { id: "allocation" } }])(
    "does not create channels for missing or endpoint-owned agents %j",
    async (agent) => {
      mocks.agent.mockResolvedValue(agent);
      await createAgentChannelConnectionAction(form());
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    createAgentChannelConnectionAction,
    updateAgentChannelConnectionCredentialsAction,
  ])(
    "ignores unknown platform definitions without credential writes",
    async (action) => {
      await action(form({ platform: "not-a-platform" }));
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it("whitelists platform credentials, omits blank values, and falls back to the platform name", async () => {
    await createAgentChannelConnectionAction(
      form({
        name: " ",
        "credential:TELEGRAM_BOT_TOKEN": "  bot-token  ",
        "credential:TELEGRAM_ALLOWED_USERS": "  ",
        "credential:UNRECOGNIZED": "must-not-store",
      }),
    );
    expect(mocks.create).toHaveBeenCalledWith({
      workspaceId: "workspace",
      agentId: "agent",
      platform: "telegram",
      name: "Telegram",
      credentials: { TELEGRAM_BOT_TOKEN: "bot-token" },
    });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledWith("/app/acme/agents/agent");
  });

  it("requests built-in pairing for a created WeCom connection missing start credentials", async () => {
    mocks.create.mockResolvedValue({
      connection: {
        id: "created",
        missingStartCredentialNames: ["WECOM_BOT_ID"],
      },
    });
    await createAgentChannelConnectionAction(
      form({ platform: "wecom", name: "  Team bot  " }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Team bot" }),
    );
    expect(mocks.request).toHaveBeenCalledWith("workspace", "created");
  });

  it("does not start pairing when the connection was not created", async () => {
    mocks.create.mockResolvedValue({ error: "invalid credentials" });
    await createAgentChannelConnectionAction(form());
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not use a built-in pairing flow for a direct API platform", async () => {
    mocks.create.mockResolvedValue({
      connection: {
        id: "created",
        missingStartCredentialNames: ["TOOLPLANE_API_TOKEN"],
      },
    });
    await createAgentChannelConnectionAction(form({ platform: "api" }));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("updates only nonblank recognized platform credential fields", async () => {
    await updateAgentChannelConnectionCredentialsAction(
      form({
        "credential:TELEGRAM_BOT_TOKEN": " token ",
        "credential:TELEGRAM_ALLOWED_USERS": " ",
        "credential:UNRECOGNIZED": "drop",
      }),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      workspaceId: "workspace",
      connectionId: "connection",
      credentials: { TELEGRAM_BOT_TOKEN: "token" },
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/app/acme/agents/agent");
  });

  it("keeps channel deletion ordered after a successful runner stop", async () => {
    mocks.stop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(deleteAgentChannelConnectionAction(form())).rejects.toThrow(
      "stop failed",
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    await deleteAgentChannelConnectionAction(form());
    expect(mocks.stop.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );
    expect(mocks.remove).toHaveBeenCalledWith("workspace", "connection");
  });

  it("invalidates the agent view after start, stop and pairing request/check", async () => {
    await startAgentChannelConnectionAction(form());
    await stopAgentChannelConnectionAction(form());
    await requestAgentChannelPairingAction(form());
    await checkAgentChannelPairingAction(form());
    expect(mocks.revalidate.mock.calls).toEqual(
      Array.from({ length: 4 }, () => ["/app/acme/agents/agent"]),
    );
  });
});
