// @vitest-environment node
// Use Next's request stores so the route exercises the real signed session cookie.
import "next/dist/server/node-environment-baseline";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { createWorkStore } from "next/dist/server/async-storage/work-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { GET as start } from "@/app/api/v1/mcp-oauth/start/route";
import { GET as callback } from "@/app/api/v1/mcp-oauth/callback/route";
import { oauthRequest } from "@/lib/remote-mcp/oauth/http";
import { stateHash } from "@/lib/remote-mcp/oauth/protocol";
import { resolveMcpConnectionSpawnSpec } from "@/lib/process/mcp-credentials";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";

vi.mock("@/lib/remote-mcp/oauth/http", () => ({ oauthRequest: vi.fn() }));
const run = randomUUID();
const app = "https://toolplane.test";
const issuer = `https://${run}.provider.test`;
const resource = "https://resource.test/mcp";
const workspace = `oauth-${run}`;
let owner: string, member: string, dep: string, foreignDep: string;
let refreshAccepted = false;

async function get(
  userId: string,
  path: "start" | "callback",
  params: Record<string, string>,
) {
  const token = await new SignJWT({ sub: userId, sv: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(run));
  const url = new URL(`/api/v1/mcp-oauth/${path}`, app);
  url.search = new URLSearchParams(params).toString();
  const req = new NextRequest(url, {
    headers: { cookie: `mcp_session=${token}` },
  });
  const unit = createRequestStoreForAPI(
    req,
    url,
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
  );
  const work = createWorkStore({
    page: `${url.pathname}/route`,
    buildId: "test",
    deploymentId: "test",
    previouslyRevalidatedTags: [],
    renderOpts: {
      supportsDynamicResponse: true,
      cacheComponents: false,
      experimental: { authInterrupts: false },
      waitUntil: undefined,
      onClose: () => {},
      onAfterTaskError: undefined,
    },
  });
  const response = await workAsyncStorage.run(work, () =>
    workUnitAsyncStorage.run(unit, () =>
      (path === "start" ? start : callback)(req),
    ),
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "about:blank");
}
async function authorize() {
  const url = await get(owner, "start", { workspace, deploymentId: dep });
  expect(url.origin).toBe(issuer);
  expect(url.searchParams.get("scope")).toBe("read");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return {
    state: url.searchParams.get("state") ?? "",
    iss: issuer,
    code: "test-code",
  };
}
describe("remote MCP OAuth authorization", () => {
  beforeAll(async () => {
    vi.stubEnv("AUTH_SECRET", run);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", app);
    owner = (
      await db.user.create({
        data: { email: `${run}@owner.test`, passwordHash: "unused" },
      })
    ).id;
    member = (
      await db.user.create({
        data: { email: `${run}@member.test`, passwordHash: "unused" },
      })
    ).id;
    const ws = await db.workspace.create({
      data: {
        slug: workspace,
        name: "OAuth",
        ownerId: owner,
        members: { create: { userId: member, role: "member" } },
      },
    });
    const other = await db.workspace.create({
      data: { slug: `other-${workspace}`, name: "Other", ownerId: member },
    });
    const data = {
      name: "Test",
      source: "remote",
      sourceRef: resource,
      installCfg: { authType: "oauth", resource, issuer },
      status: "setup_required",
    };
    dep = (
      await db.deployment.create({ data: { ...data, workspaceId: ws.id } })
    ).id;
    foreignDep = (
      await db.deployment.create({ data: { ...data, workspaceId: other.id } })
    ).id;
    vi.mocked(oauthRequest).mockImplementation(async (target, options) => {
      const challenge =
        'Bearer resource_metadata="https://resource.test/prm", scope="read"';
      if (target === resource) return { status: 401, challenge, data: {} };
      if (target === "https://resource.test/prm")
        return {
          status: 200,
          challenge: undefined,
          data: { resource, authorization_servers: [issuer] },
        };
      if (target === `${issuer}/.well-known/oauth-authorization-server`)
        return {
          status: 200,
          challenge: undefined,
          data: {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true,
          },
        };
      if (
        target === `${issuer}/token` &&
        refreshAccepted &&
        new URLSearchParams(options?.body).get("grant_type") === "refresh_token"
      ) {
        return {
          status: 200,
          challenge: undefined,
          data: {
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          },
        };
      }
      if (target === `${issuer}/token`)
        return { status: 400, challenge: undefined, data: {} };
      throw new Error("Unexpected OAuth request");
    });
  });
  afterAll(async () => {
    await db.mcpOAuthPending.deleteMany({
      where: { deploymentId: { in: [dep, foreignDep].filter(Boolean) } },
    });
    await db.user.deleteMany({
      where: { id: { in: [owner, member].filter(Boolean) } },
    });
    vi.unstubAllEnvs();
  });
  it("does not authorize a deployment through a different workspace slug", async () => {
    expect(
      (
        await get(owner, "start", { workspace, deploymentId: foreignDep })
      ).searchParams.get("oauth"),
    ).toBe("oauthDenied");
    expect(
      await db.mcpOAuthPending.count({ where: { deploymentId: foreignDep } }),
    ).toBe(0);
  });
  it("binds state to the initiating session user and consumes it before an unsuccessful token exchange", async () => {
    const params = await authorize();
    expect(
      (await get(member, "callback", params)).searchParams.get("oauth"),
    ).toBe("oauthStateInvalid");
    const outcomes = await Promise.all([
      get(owner, "callback", params),
      get(owner, "callback", params),
    ]);
    expect(outcomes.map((url) => url.searchParams.get("oauth")).sort()).toEqual(
      ["oauthExchangeFailed", "oauthStateInvalid"],
    );
    expect(
      vi
        .mocked(oauthRequest)
        .mock.calls.filter(([url]) => url === `${issuer}/token`),
    ).toHaveLength(1);
    expect(
      await db.mcpOAuthPending.findUnique({
        where: { stateHash: stateHash(params.state) },
      }),
    ).toBeNull();
  });
  it("rejects expired state and mismatched response issuer without exchanging a code", async () => {
    const expired = await authorize();
    await db.mcpOAuthPending.update({
      where: { stateHash: stateHash(expired.state) },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (await get(owner, "callback", expired)).searchParams.get("oauth"),
    ).toBe("oauthStateInvalid");
    const mixed = await authorize();
    expect(
      (
        await get(owner, "callback", {
          ...mixed,
          iss: "https://different.test",
        })
      ).searchParams.get("oauth"),
    ).toBe("oauthStateInvalid");
    expect(
      await db.mcpOAuthCredential.findUnique({ where: { deploymentId: dep } }),
    ).toBeNull();
  });
  it("refreshes once under contention and closes the grant on refresh refusal", async () => {
    const { workspaceId } = await db.deployment.findUniqueOrThrow({
      where: { id: dep },
      select: { workspaceId: true },
    });
    const { id } = await db.deployment.create({
      data: {
        workspaceId,
        source: "remote",
        sourceRef: resource,
        status: "running",
        installCfg: { authType: "oauth", issuer, resource },
      },
    });
    await db.mcpOAuthCredential.create({
      data: {
        workspaceId,
        deploymentId: id,
        resource,
        issuer,
        clientId: `${app}/api/v1/mcp-oauth/client-metadata.json`,
        scopes: ["read"],
        encryptedAccessToken: encryptSecretText("old-access"),
        encryptedRefreshToken: encryptSecretText("old-refresh"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    refreshAccepted = true;
    const resolve = () =>
      resolveMcpConnectionSpawnSpec({ workspaceId, deploymentId: id });
    const results = await Promise.all([resolve(), resolve(), resolve()]);
    expect(
      results.every(
        ({ spec }) =>
          spec.kind === "remote" &&
          spec.headers.authorization === "Bearer rotated-access",
      ),
    ).toBe(true);
    expect(results[0].redactionValues).toContain("rotated-access");
    const requests = vi
      .mocked(oauthRequest)
      .mock.calls.filter(
        ([, options]) =>
          new URLSearchParams(options?.body).get("refresh_token") ===
          "old-refresh",
      );
    expect(requests).toHaveLength(1);
    const stored = await db.mcpOAuthCredential.findUniqueOrThrow({
      where: { deploymentId: id },
    });
    expect(decryptSecretText(stored.encryptedRefreshToken)).toBe(
      "rotated-refresh",
    );
    expect(JSON.stringify(stored)).not.toContain("rotated-access");
    refreshAccepted = false;
    await db.mcpOAuthCredential.update({
      where: { deploymentId: id },
      data: { expiresAt: new Date(0) },
    });
    await expect(resolve()).rejects.toThrow("MCP_REAUTH_REQUIRED");
    expect(
      await db.mcpOAuthCredential.findUniqueOrThrow({
        where: { deploymentId: id },
      }),
    ).toMatchObject({ status: "reauth_required", refreshLeaseUntil: null });
    expect(
      await db.deployment.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: "setup_required" });
  });
});
