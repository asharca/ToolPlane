// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  requestAgentChannelPairing,
  checkAgentChannelPairing,
} from "@/lib/agents/channel-pairing";
import { pairingFromConfig } from "@/lib/agents/channel-pairing-state";

const store = vi.hoisted(() => ({
  row: {
    id: "c",
    workspaceId: "w",
    platform: "wecom",
    credentials: {},
    config: {} as Prisma.JsonValue,
  },
  missing: false,
  update: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    agentChannelConnection: {
      findFirst: vi.fn(async () => (store.missing ? null : store.row)),
      findUniqueOrThrow: vi.fn(async () => store.row),
      update: vi.fn(async ({ data }) => {
        store.row.config = data.config;
        store.update(data);
        return store.row;
      }),
    },
  },
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  updateAgentChannelConnectionCredentials: store.credentials,
}));
vi.mock("@/lib/security/secrets", () => ({
  encryptSecretRecord: vi.fn((value) => value),
  decryptSecretRecord: vi.fn((value) => {
    if (value.broken) throw new Error("bad cipher");
    return value;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.row = {
    id: "c",
    workspaceId: "w",
    platform: "wecom",
    credentials: {},
    config: {},
  };
  store.missing = false;
  store.credentials.mockResolvedValue({});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function session(
  platform: string,
  provider: string,
  secrets: Record<string, string | undefined> = {},
) {
  store.row.platform = platform;
  const pairingSecrets: Prisma.JsonObject = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined) pairingSecrets[key] = value;
  }
  store.row.config = {
    pairing: {
      provider,
      status: "waiting",
      providerSessionId: "session",
      extra: {},
    },
    pairingSecrets,
  };
}
function responses(...values: unknown[]) {
  const fetch = vi.fn();
  for (const value of values) fetch.mockResolvedValueOnce(Response.json(value));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("QR pairing provider outcomes", () => {
  it("rejects unavailable connections and platforms before contacting a provider", async () => {
    store.missing = true;
    for (const operation of [
      requestAgentChannelPairing,
      checkAgentChannelPairing,
    ])
      expect(await operation("w", "c")).toEqual({
        error: "Channel connection not found.",
      });
    store.missing = false;
    store.row.platform = "unknown";
    expect(await requestAgentChannelPairing("w", "c")).toEqual({
      error: "This platform does not use QR pairing.",
    });
    expect(await checkAgentChannelPairing("w", "c")).toEqual({
      error: "This platform does not use QR pairing.",
    });
  });
  it("requires Telegram bot credentials instead of contacting a managed setup service", async () => {
    store.row.platform = "telegram";
    const fetch = responses();
    expect(await requestAgentChannelPairing("w", "c")).toEqual({
      error: "This platform does not use QR pairing.",
    });
    expect(await checkAgentChannelPairing("w", "c")).toEqual({
      error: "This platform does not use QR pairing.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, "text", 12])(
    "persists malformed JSON provider failure %j",
    async (body) => {
      responses(body);
      const result = await requestAgentChannelPairing("w", "c");
      expect(result.error).toBe("Invalid JSON response.");
      expect(pairingFromConfig(store.row.config)?.status).toBe("error");
    },
  );
  it("persists HTTP, incomplete and non-Error request failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    );
    expect((await requestAgentChannelPairing("w", "c")).error).toContain(
      "HTTP 503",
    );
    responses({});
    expect((await requestAgentChannelPairing("w", "c")).error).toContain(
      "incomplete",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    expect((await requestAgentChannelPairing("w", "c")).error).toBe(
      "Failed to request QR.",
    );
  });
  it("expires local sessions and never polls terminal states", async () => {
    const fetch = responses();
    session("wecom", "wecom_admin_qr");
    store.row.config = {
      pairing: {
        provider: "wecom_admin_qr",
        status: "waiting",
        expiresAt: "2029-01-01",
        qrPayload: "secret",
      },
    };
    await checkAgentChannelPairing("w", "c");
    expect(pairingFromConfig(store.row.config)).toMatchObject({
      status: "expired",
      qrPayload: undefined,
    });
    for (const status of ["ready", "expired", "error"]) {
      store.row.config = {
        pairing: { provider: "wecom_admin_qr", status },
      };
      expect(await checkAgentChannelPairing("w", "c")).toEqual({});
    }
    expect(fetch).not.toHaveBeenCalled();
    store.row.config = {};
    expect((await checkAgentChannelPairing("w", "c")).error).toContain(
      "Request a QR",
    );
  });
  it.each([
    ["wecom", "wecom_admin_qr", "scode"],
    ["weixin", "weixin_ilink_qr", "QR id"],
    ["dingtalk", "dingtalk_device_qr", "device code"],
    ["feishu", "feishu_device_qr", "new Feishu"],
  ])(
    "rejects missing %s provider session",
    async (platform, provider, error) => {
      store.row.platform = platform;
      store.row.config = { pairing: { provider, status: "waiting" } };
      expect((await checkAgentChannelPairing("w", "c")).error).toContain(error);
    },
  );
  it.each(["wecom", "weixin"])(
    "requests %s QR and rejects incomplete provider responses",
    async (platform) => {
      store.row.platform = platform;
      responses({});
      expect((await requestAgentChannelPairing("w", "c")).error).toContain(
        "incomplete",
      );
      responses(
        platform === "wecom"
          ? { data: { scode: "s", auth_url: "https://scan" } }
          : { qrcode: "q" },
      );
      expect(
        (await requestAgentChannelPairing("w", "c")).pairing,
      ).toMatchObject({
        status: "waiting",
        providerSessionId: platform === "wecom" ? "s" : "q",
      });
    },
  );
  it.each(["", "waiting", "success"])(
    "transitions WeCom status %s",
    async (status) => {
      session("wecom", "wecom_admin_qr");
      responses({
        data: { status, bot_info: { bot_id: 123, secret: "secret" } },
      });
      await checkAgentChannelPairing("w", "c");
      expect(pairingFromConfig(store.row.config)?.status).toBe(
        status === "success" ? "ready" : "waiting",
      );
      if (status === "success")
        expect(store.credentials).toHaveBeenCalledWith(
          expect.objectContaining({
            credentials: { WECOM_BOT_ID: "123", WECOM_SECRET: "secret" },
          }),
        );
    },
  );
  it.each(["wait", "scaned", "expired", "scaned_but_redirect", "confirmed"])(
    "transitions Weixin status %s",
    async (status) => {
      session("weixin", "weixin_ilink_qr");
      responses({
        status,
        redirect_host: "next.example",
        ilink_bot_id: "account",
        bot_token: "token",
        baseurl: "https://next.example",
      });
      await checkAgentChannelPairing("w", "c");
      expect(pairingFromConfig(store.row.config)?.status).toBe(
        status === "confirmed"
          ? "ready"
          : status === "expired"
            ? "expired"
            : status.startsWith("scaned")
              ? "scanned"
              : "waiting",
      );
      if (status === "scaned_but_redirect")
        expect(pairingFromConfig(store.row.config)?.extra).toEqual({
          baseUrl: "https://next.example",
        });
      if (status === "confirmed")
        expect(store.credentials).toHaveBeenCalledWith(
          expect.objectContaining({
            credentials: {
              WEIXIN_ACCOUNT_ID: "account",
              WEIXIN_TOKEN: "token",
              WEIXIN_BASE_URL: "https://next.example",
            },
          }),
        );
    },
  );
  it.each([
    ["wecom", "wecom_admin_qr", { data: { status: "success" } }],
    ["weixin", "weixin_ilink_qr", { status: "confirmed" }],
    ["dingtalk", "dingtalk_device_qr", { status: "SUCCESS" }],
  ])(
    "rejects missing authorized %s credentials",
    async (platform, provider, body) => {
      session(platform, provider);
      responses(body);
      expect((await checkAgentChannelPairing("w", "c")).error).toContain(
        "missing",
      );
      expect(store.credentials).not.toHaveBeenCalled();
    },
  );
  it("requests DingTalk registration and clamps timing values", async () => {
    store.row.platform = "dingtalk";
    vi.stubEnv("DINGTALK_REGISTRATION_SOURCE", "  ");
    vi.stubEnv("DINGTALK_REGISTRATION_BASE_URL", "https://ding.example/");
    const fetch = responses(
      { nonce: "n" },
      {
        device_code: "d",
        verification_uri_complete: "https://scan",
        expires_in: "3",
        interval: "1",
      },
    );
    const result = await requestAgentChannelPairing("w", "c");
    expect(result.pairing).toMatchObject({
      expiresAt: "2030-01-01T00:01:00.000Z",
      extra: { interval: "2", source: "openClaw" },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://ding.example/app/registration/init",
    );
  });
  it.each([
    [{}, "nonce"],
    [{ nonce: "n" }, "device code"],
    [{ errcode: 12 }, "errcode 12"],
    [{ errcode: 12, errmsg: "denied" }, "denied"],
  ])("rejects DingTalk registration %j", async (first, error) => {
    store.row.platform = "dingtalk";
    responses(first, {});
    expect((await requestAgentChannelPairing("w", "c")).error).toContain(error);
  });
  it.each(["SUCCESS", "WAITING", "EXPIRED", "DENIED", ""])(
    "transitions DingTalk %s",
    async (status) => {
      session("dingtalk", "dingtalk_device_qr");
      responses({ status, client_id: "id", client_secret: "secret" });
      await checkAgentChannelPairing("w", "c");
      expect(pairingFromConfig(store.row.config)?.status).toBe(
        status === "SUCCESS"
          ? "ready"
          : status === "WAITING"
            ? "waiting"
            : status === "EXPIRED"
              ? "expired"
              : "error",
      );
      if (status === "SUCCESS")
        expect(store.credentials).toHaveBeenCalledWith(
          expect.objectContaining({
            credentials: {
              DINGTALK_CLIENT_ID: "id",
              DINGTALK_CLIENT_SECRET: "secret",
            },
          }),
        );
    },
  );
  it.each(["feishu", "lark"])(
    "requests %s registration and keeps device code private",
    async (domain) => {
      store.row.platform = "feishu";
      Object.assign(store.row.credentials, { FEISHU_DOMAIN: domain });
      const fetch = responses(
        {},
        {
          device_code: "device",
          verification_uri_complete: "https://scan",
          expires_in: "600",
          interval: "bad",
        },
      );
      expect(
        (await requestAgentChannelPairing("w", "c")).pairing,
      ).toMatchObject({
        qrPayload: "https://scan",
        extra: { domain, interval: "5" },
      });
      expect(fetch.mock.calls[0]?.[0]).toContain(
        domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn",
      );
      expect(store.row.config).toMatchObject({
        pairingSecrets: { deviceCode: "device" },
      });
    },
  );
  it.each([
    "authorization_pending",
    "slow_down",
    "expired_token",
    "access_denied",
    "unexpected",
    "",
  ])("handles Feishu authorization %s", async (error) => {
    session("feishu", "feishu_device_qr", { deviceCode: "device" });
    responses({ error });
    await checkAgentChannelPairing("w", "c");
    expect(pairingFromConfig(store.row.config)?.status).toBe(
      error === "expired_token"
        ? "expired"
        : ["access_denied", "unexpected"].includes(error)
          ? "error"
          : "waiting",
    );
    if (error === "slow_down")
      expect(pairingFromConfig(store.row.config)?.extra?.interval).toBe("10");
  });
  it.each([false, true])(
    "saves Feishu credential result with failure=%s",
    async (failure) => {
      session("feishu", "feishu_device_qr", { deviceCode: "device" });
      responses({ client_id: "id", client_secret: "secret" });
      if (failure)
        store.credentials.mockResolvedValue({ error: "write denied" });
      const result = await checkAgentChannelPairing("w", "c");
      expect(result).toEqual(failure ? { error: "write denied" } : {});
      expect(pairingFromConfig(store.row.config)?.status).toBe(
        failure ? "error" : "ready",
      );
      if (!failure)
        expect(store.row.config).toMatchObject({ pairingSecrets: {} });
    },
  );
  it("rejects incomplete Feishu registration and external runner absence", async () => {
    store.row.platform = "feishu";
    responses({}, {});
    expect((await requestAgentChannelPairing("w", "c")).error).toContain(
      "incomplete",
    );
    store.row.platform = "whatsapp";
    expect((await requestAgentChannelPairing("w", "c")).pairing?.status).toBe(
      "error",
    );
    session("whatsapp", "external_setup_runner");
    expect((await checkAgentChannelPairing("w", "c")).error).toContain(
      "No active setup runner",
    );
  });
});
