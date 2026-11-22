// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { accountConnectionApi } from "@/lib/account-connections/http";
import { finishOAuth, liveConnection } from "@/lib/account-connections/oauth";
import * as network from "@/lib/account-connections/pinned-get";
import * as tokenEndpoint from "@/lib/remote-mcp/oauth/http";
import { handleAgentAutomation } from "@/lib/agents/automation-http";
import { syncTriggerSource } from "@/lib/agents/trigger-sources";

const slug = `connections-${randomUUID()}`;
const foreign = `other-${slug}`;
const secret = randomUUID();
const input = {
  name: "Private feed",
  authType: "bearer",
  preset: "custom",
  secret,
  allowedHosts: ["news.test"],
};
let owner: string,
  member: string,
  adminToken: string,
  memberToken: string,
  agentId: string,
  workspaceId: string;
function request(method: string, token: string, body?: unknown) {
  return new Request("https://toolplane.test/api", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  const [a, b] = await db.user.createManyAndReturn({
    data: ["owner", "member"].map((role) => ({
      email: `${role}-${slug}@test.invalid`,
      passwordHash: "unused",
    })),
  });
  owner = a.id;
  member = b.id;
  const ws = await db.workspace.create({
    data: {
      slug,
      name: "Connections",
      ownerId: owner,
      members: { create: { userId: member, role: "member" } },
    },
  });
  workspaceId = ws.id;
  await db.workspace.create({
    data: { slug: foreign, name: "Other", ownerId: owner },
  });
  adminToken = (await createApiToken(owner, "Accounts")).token;
  memberToken = (await createApiToken(member, "Accounts")).token;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        slug: "reader",
        name: "Reader",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (workspaceId) await db.agentTrigger.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { slug: { in: [slug, foreign] } } });
  await db.user.deleteMany({
    where: { id: { in: [owner, member].filter(Boolean) } },
  });
});

describe("workspace account connections", () => {
  it("scopes mutations, rejects foreign references and disallowed hosts, and restricts deletes", async () => {
    const api = (
      method: string,
      token: string,
      body?: unknown,
      id?: string,
      target = slug,
    ) => accountConnectionApi(request(method, token, body), target, id);
    expect((await api("POST", memberToken, input)).status).toBe(403);
    const result = await api("POST", adminToken, input);
    expect(result.status).toBe(201);
    const { connection } = await result.json();
    expect(connection).toMatchObject({
      status: "active",
      hasSecret: true,
      usage: 0,
    });
    expect(JSON.stringify(connection)).not.toContain(secret);
    expect(connection).not.toHaveProperty("encryptedSecret");
    const stored = await db.accountConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(stored.encryptedSecret).toMatchObject({
      value: { alg: "aes-256-gcm" },
    });
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(
      (await api("DELETE", memberToken, undefined, connection.id)).status,
    ).toBe(403);
    const elsewhere = await (
      await api("POST", adminToken, input, undefined, foreign)
    ).json();
    const trigger = (id: string, url: string) =>
      handleAgentAutomation(
        request("POST", adminToken, {
          name: "Feed",
          kind: "feed",
          cron: "0 * * * *",
          timezone: "UTC",
          prompt: "Read",
          connectionId: id,
          sourceConfig: { url },
        }),
        agentId,
        "triggers",
      );
    expect(
      (await trigger(elsewhere.connection.id, "https://news.test/feed")).status,
    ).toBe(400);
    for (const url of [
      "http://news.test/feed",
      "https://other.news.test/feed",
    ]) {
      const denied = await trigger(connection.id, url);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({
        error: "TRIGGER_SOURCE_HOST_NOT_ALLOWED",
      });
    }
    const created = await trigger(connection.id, "https://news.test/feed");
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain(secret);
    const held = await api("DELETE", adminToken, undefined, connection.id);
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "ACCOUNT_CONNECTION_IN_USE" });
    const list = await (await api("GET", memberToken)).json();
    expect(list.connections).toContainEqual(
      expect.objectContaining({ id: connection.id, usage: 1 }),
    );
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(list)).not.toContain("aes-256-gcm");
  });

  it("checks account identity, retains the secret on patch, and never follows authenticated cross-origin redirects", async () => {
    const rest = vi
      .spyOn(network, "pinnedGet")
      .mockImplementation(async (url, headers) => {
        expect(url.hostname).toBe("news.test");
        expect(headers["X-News-Key"]).toBe(secret);
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({ data: { name: "reader" } }),
        };
      });
    const body = {
      ...input,
      name: "Checked account",
      authType: "header",
      headerName: "X-News-Key",
      testUrl: "https://news.test/me",
      accountPath: "data.name",
    };
    const res = await accountConnectionApi(
      request("POST", adminToken, body),
      slug,
    );
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection.accountLabel).toBe("reader");
    const update = await accountConnectionApi(
      request("PATCH", adminToken, { name: "Renamed account", secret: "" }),
      slug,
      connection.id,
    );
    expect(update.status).toBe(200);
    const broadened = await accountConnectionApi(
      request("PATCH", adminToken, {
        allowedHosts: ["news.test", "other.test"],
        secret: "",
      }),
      slug,
      connection.id,
    );
    expect(broadened.status).toBe(400);
    expect(await broadened.json()).toEqual({
      error: "INVALID_ACCOUNT_CONNECTION",
    });
    rest.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://other.test/me" }),
      text: "",
    });
    const denied = await accountConnectionApi(
      request("POST", adminToken),
      slug,
      connection.id,
      "test",
    );
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({
      error: "ACCOUNT_CONNECTION_NETWORK_BLOCKED",
    });
    expect(rest).toHaveBeenCalledTimes(3);
    rest.mockResolvedValueOnce({
      status: 401,
      headers: new Headers(),
      text: "",
    });
    expect(
      (
        await accountConnectionApi(
          request("POST", adminToken, { ...body, name: "Invalid account" }),
          slug,
        )
      ).status,
    ).toBe(422);
    expect(
      await db.accountConnection.count({
        where: { workspaceId, name: "Invalid account" },
      }),
    ).toBe(0);
    expect(
      (
        await accountConnectionApi(
          request("DELETE", adminToken),
          slug,
          connection.id,
        )
      ).status,
    ).toBe(204);
  });

  it("blocks loopback before opening a socket and rejects reserved configuration", async () => {
    const blocked = await accountConnectionApi(
      request("POST", adminToken, {
        ...input,
        name: "Local",
        allowedHosts: ["127.0.0.1"],
        testUrl: "https://127.0.0.1/me",
      }),
      slug,
    );
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toEqual({
      error: "ACCOUNT_CONNECTION_NETWORK_BLOCKED",
    });
    for (const invalid of [
      { allowedHosts: ["*.news.test"] },
      { authType: "header", headerName: "Proxy-Authorization" },
      {
        authType: "oauth2",
        oauth: {
          authorizationUrl: "https://issuer.test/login",
          tokenUrl: "https://issuer.test/token",
          clientId: "fixture",
          clientAuth: "body",
          scopes: [],
          extraParams: { state: "fixed" },
        },
      },
    ]) {
      const bad = await accountConnectionApi(
        request("POST", adminToken, { ...input, ...invalid, name: "Invalid" }),
        slug,
      );
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "INVALID_ACCOUNT_CONNECTION" });
    }
  });

  it.each(["rss", "atom"])(
    "polls %s feed IDs and safely decodes titles and summaries",
    async (format) => {
      const row = await db.agentTrigger.create({
        data: {
          workspaceId,
          agentId,
          actorId: owner,
          name: format,
          prompt: "{{payload}}",
          kind: "feed",
          sourceConfig: { url: "https://news.test/feed" },
        },
      });
      const isRss = format === "rss";
      const feed = (ids: string[]) => {
        const entries = ids
          .map((id) =>
            isRss
              ? `<item><guid>${id}</guid><link>https://news.test/${id}</link><title>A &amp; B</title><pubDate>today</pubDate><description><![CDATA[<story>]]></description></item>`
              : `<entry><id>${id}</id><link rel="alternate" href="https://news.test/${id}"/><title>A &amp; B</title><published>today</published><summary><![CDATA[<story>]]></summary></entry>`,
          )
          .join("");
        return isRss
          ? `<rss version="2.0"><channel>${entries}</channel></rss>`
          : `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
      };
      const mock = vi.spyOn(network, "pinnedGet").mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: feed(["first"]),
      });
      expect(await syncTriggerSource(row)).toBeNull();
      const poll = async () =>
        syncTriggerSource(
          await db.agentTrigger.findUniqueOrThrow({ where: { id: row.id } }),
        );
      mock.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: feed(["first", "second"]),
      });
      const prompt = await poll();
      expect(JSON.parse(prompt?.split("\n\n")[1] ?? "null")).toEqual([
        {
          id: "second",
          source: "feed",
          untrusted: true,
          title: "A & B",
          link: "https://news.test/second",
          published: "today",
          summary: "<story>",
        },
      ]);
      expect(await poll()).toBeNull();
      mock.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: `<!DOCTYPE feed>${feed([])}`,
      });
      await expect(poll()).rejects.toThrow("SUBSCRIPTION_RESPONSE_INVALID");
    },
  );

  it("binds PKCE to one user and callback, and leases one refresh for concurrent consumers", async () => {
    const clientSecret = randomUUID(),
      accessToken = randomUUID(),
      refreshToken = randomUUID();
    const oauth = {
      clientId: "public-id",
      authorizationUrl: "https://issuer.test/login",
      tokenUrl: "https://issuer.test/token",
      scopes: ["read"],
      extraParams: { prompt: "consent" },
      clientAuth: "body",
    };
    const body = {
      ...input,
      name: "OAuth",
      authType: "oauth2",
      oauth,
      secret: clientSecret,
    };
    const { connection } = await (
      await accountConnectionApi(request("POST", adminToken, body), slug)
    ).json();
    expect(connection.status).toBe("pending");
    const { authorizationUrl } = await (
      await accountConnectionApi(
        request("POST", adminToken),
        slug,
        connection.id,
        "start",
      )
    ).json();
    const auth = new URL(authorizationUrl).searchParams;
    expect(auth.get("code_challenge_method")).toBe("S256");
    const params = new URLSearchParams({
      state: auth.get("state") ?? "",
      code: randomUUID(),
    });
    const endpoint = vi
      .spyOn(tokenEndpoint, "oauthRequest")
      .mockImplementation(async (_url, options) => {
        const form = new URLSearchParams(options?.body);
        expect(form.get("client_secret")).toBe(clientSecret);
        if (form.get("grant_type") === "authorization_code") {
          expect(
            createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url"),
          ).toBe(auth.get("code_challenge"));
          return {
            status: 200,
            challenge: undefined,
            data: {
              access_token: accessToken,
              refresh_token: refreshToken,
              expires_in: 30,
              token_type: "bearer",
            },
          };
        }
        expect(form.get("refresh_token")).toBe(refreshToken);
        return {
          status: 200,
          challenge: undefined,
          data: {
            access_token: "renewed-token",
            expires_in: 3600,
            token_type: "bearer",
          },
        };
      });
    expect(
      (await finishOAuth(member, params)).headers.get("location"),
    ).toContain("error=");
    expect(endpoint).not.toHaveBeenCalled();
    expect(
      (await finishOAuth(owner, params)).headers.get("location"),
    ).not.toContain("error=");
    expect(
      (await finishOAuth(owner, params)).headers.get("location"),
    ).toContain("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
    const tokens = await Promise.all(
      [1, 2].map(() =>
        liveConnection(
          { id: connection.id, workspaceId },
          AbortSignal.timeout(5000),
        ),
      ),
    );
    expect(tokens.map((t) => t.auth.secrets.accessToken)).toEqual([
      "renewed-token",
      "renewed-token",
    ]);
    expect(endpoint).toHaveBeenCalledTimes(2);
    const text = await (
      await accountConnectionApi(request("GET", adminToken), slug)
    ).text();
    for (const value of [
      accessToken,
      refreshToken,
      clientSecret,
      "renewed-token",
      "aes-256-gcm",
    ])
      expect(text).not.toContain(value);
    const newStart = await (
      await accountConnectionApi(
        request("POST", adminToken),
        slug,
        connection.id,
        "start",
      )
    ).json();
    params.set(
      "state",
      new URL(newStart.authorizationUrl).searchParams.get("state") ?? "",
    );
    await db.accountConnectionOAuthPending.updateMany({
      where: { connectionId: connection.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await finishOAuth(owner, params)).headers.get("location"),
    ).toContain("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
    expect(endpoint).toHaveBeenCalledTimes(2);
    endpoint.mockRejectedValueOnce(new Error("failed request"));
    await db.accountConnection.update({
      where: { id: connection.id },
      data: { expiresAt: new Date() },
    });
    const trigger = await db.agentTrigger.create({
      data: {
        workspaceId,
        agentId,
        actorId: owner,
        name: "expired",
        kind: "feed",
        prompt: "Read",
        connectionId: connection.id,
        sourceConfig: { url: "https://news.test/feed" },
      },
    });
    await expect(syncTriggerSource(trigger)).rejects.toThrow(
      "SUBSCRIPTION_CONNECTION_UNAVAILABLE",
    );
    expect(
      await db.accountConnection.findUnique({ where: { id: connection.id } }),
    ).toMatchObject({
      status: "expired",
      lastError: "ACCOUNT_CONNECTION_EXPIRED",
      refreshLeaseUntil: null,
    });
  });
});
