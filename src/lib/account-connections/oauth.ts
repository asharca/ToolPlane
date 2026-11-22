import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import type { AccountConnection, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { originFromHeaders } from "@/lib/http/origin";
import {
  makeAuthorizationProof,
  stateHash,
} from "@/lib/remote-mcp/oauth/protocol";
import { oauthRequest } from "@/lib/remote-mcp/oauth/http";
import {
  decryptSecretRecord,
  decryptSecretText,
  encryptSecretRecord,
  encryptSecretText,
} from "@/lib/security/secrets";
import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import {
  configSchema,
  ConnectionError,
  type ConnectionConfig,
  invalidInput,
} from "./config";
import { testResource } from "./transport";

export function redirectUri() {
  return `${originFromHeaders(new Headers())}/api/v1/account-connections/oauth/callback`;
}

async function exchange(
  config: ConnectionConfig,
  secrets: Record<string, string>,
  fields: Record<string, string>,
  signal?: AbortSignal,
) {
  const oauth = config.oauth;
  if (!oauth) throw invalidInput();
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "ToolPlane",
  };
  if (oauth.clientAuth === "basic" && secrets.clientSecret) {
    const encode = (v: string) =>
      new URLSearchParams({ v }).toString().slice(2);
    headers.authorization = `Basic ${Buffer.from(`${encode(oauth.clientId)}:${encode(secrets.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", oauth.clientId);
    if (secrets.clientSecret) body.set("client_secret", secrets.clientSecret);
  }
  // This HTTPS endpoint is pinned separately from the resource-host allowlist;
  // the token exchange never follows redirects or sends a resource credential.
  const { status, data } = await oauthRequest(oauth.tokenUrl, {
    headers,
    body: body.toString(),
    signal,
  });
  const printable = (v: unknown): v is string =>
    typeof v === "string" && /^[!-~]{1,8192}$/.test(v);
  const ttl = data.expires_in;
  if (
    status < 200 ||
    status >= 300 ||
    !printable(data.access_token) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    (data.refresh_token !== undefined && !printable(data.refresh_token)) ||
    (ttl !== undefined &&
      (typeof ttl !== "number" ||
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        ttl > 86400 * 365 * 100))
  )
    throw new ConnectionError("ACCOUNT_CONNECTION_OAUTH_FAILED");
  return {
    secrets: {
      ...secrets,
      accessToken: data.access_token,
      ...(typeof data.refresh_token === "string" && {
        refreshToken: data.refresh_token,
      }),
    },
    expiresAt:
      typeof ttl === "number" ? new Date(Date.now() + ttl * 1000) : null,
  };
}

/** Secrets sealed under a previous AUTH_SECRET are unusable, not a server error. */
export function storedSecrets(raw: unknown): Record<string, string> | null {
  try {
    return decryptSecretRecord(raw);
  } catch {
    return null;
  }
}

export async function liveConnection(
  where: {
    id: string;
    workspaceId: string;
    workspace?: Prisma.WorkspaceWhereInput;
  },
  signal: AbortSignal,
  test = false,
) {
  while (!signal.aborted) {
    const row = await db.accountConnection.findFirst({ where });
    if (!row || (row.status !== "active" && !(test && row.status === "failed")))
      throw new ConnectionError("ACCOUNT_CONNECTION_EXPIRED");
    const config = configSchema.parse(row.config);
    const secrets = storedSecrets(row.encryptedSecret);
    if (!secrets) throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
    if (!(row.authType === "oauth2" ? secrets.accessToken : secrets.value))
      throw new ConnectionError("ACCOUNT_CONNECTION_EXPIRED");
    const auth = { config, authType: row.authType, secrets };
    if (
      row.authType !== "oauth2" ||
      !row.expiresAt ||
      row.expiresAt.getTime() > Date.now() + 60000
    )
      return { auth, row };
    if (row.refreshLeaseUntil && row.refreshLeaseUntil.getTime() > Date.now()) {
      await delay(150, undefined, { signal });
      continue;
    }
    const refreshLeaseUntil = new Date(Date.now() + 30000);
    const claim = await db.accountConnection.updateMany({
      where: {
        ...where,
        id: row.id,
        updatedAt: row.updatedAt,
        OR: [
          { refreshLeaseUntil: null },
          { refreshLeaseUntil: { lte: new Date() } },
        ],
      },
      data: { refreshLeaseUntil },
    });
    if (!claim.count) continue;
    const held = { ...where, id: row.id, refreshLeaseUntil };
    try {
      if (!secrets.refreshToken)
        throw new ConnectionError("ACCOUNT_CONNECTION_EXPIRED");
      const rotated = await exchange(
        config,
        secrets,
        { grant_type: "refresh_token", refresh_token: secrets.refreshToken },
        AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      );
      const [updated] = await db.accountConnection.updateManyAndReturn({
        where: held,
        data: {
          encryptedSecret: encryptSecretRecord(rotated.secrets),
          expiresAt: rotated.expiresAt,
          refreshLeaseUntil: null,
          status: "active",
          lastError: null,
        },
      });
      if (updated)
        return { auth: { ...auth, secrets: rotated.secrets }, row: updated };
    } catch {
      const failed = await db.accountConnection.updateMany({
        where: held,
        data: {
          refreshLeaseUntil: null,
          status: "expired",
          lastError: "ACCOUNT_CONNECTION_EXPIRED",
        },
      });
      if (failed.count) throw new ConnectionError("ACCOUNT_CONNECTION_EXPIRED");
    }
  }
  throw new ConnectionError("ACCOUNT_CONNECTION_UNREACHABLE");
}

export async function startOAuth(
  scope: WorkspaceScope<"manage">,
  row: AccountConnection,
) {
  const config = configSchema.parse(row.config);
  if (row.authType !== "oauth2" || !config.oauth) throw invalidInput();
  const { state, verifier, challenge } = makeAuthorizationProof();
  const uri = redirectUri();
  const target = new URL(config.oauth.authorizationUrl);
  for (const [k, v] of Object.entries({
    ...config.oauth.extraParams,
    client_id: config.oauth.clientId,
    response_type: "code",
    redirect_uri: uri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(config.oauth.scopes.length && { scope: config.oauth.scopes.join(" ") }),
  }))
    target.searchParams.set(k, v);
  await db.$transaction(async (tx) => {
    await tx.accountConnectionOAuthPending.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await tx.accountConnectionOAuthPending.create({
      data: {
        stateHash: stateHash(state),
        userId: scope.actorUserId,
        connection: {
          connect: {
            id: row.id,
            workspace: workspaceScopeWhere(scope),
            updatedAt: row.updatedAt,
          },
        },
        encryptedVerifier: encryptSecretText(
          JSON.stringify({
            verifier,
            version: row.updatedAt.toISOString(),
            config: stateHash(JSON.stringify(row.config)),
          }),
        ),
        redirectUri: uri,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
  });
  return target.href;
}

export async function finishOAuth(
  userId: string | null,
  params: URLSearchParams,
) {
  const origin = originFromHeaders(new Headers());
  let destination = new URL("/app", origin);
  const redirect = (error?: string) => {
    if (error) destination.searchParams.set("error", error);
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  };
  if (!userId) return redirect("ACCOUNT_CONNECTION_OAUTH_DENIED");
  const state = params.get("state");
  if (!state || !/^[\w-]{43}$/.test(state))
    return redirect("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
  const pending = await db.accountConnectionOAuthPending.findFirst({
    where: { userId, stateHash: stateHash(state) },
    include: { connection: true },
  });
  if (!pending) return redirect("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
  const row = pending.connection;
  const scope = await resolveWorkspaceScope(
    { id: row.workspaceId },
    userId,
    "manage",
  );
  if (!scope) return redirect("ACCOUNT_CONNECTION_OAUTH_DENIED");
  destination = new URL(
    `/app/${encodeURIComponent(scope.slug)}/settings`,
    origin,
  );
  destination.search = new URLSearchParams({
    section: "connections",
    connection: row.id,
  }).toString();
  const consumed = await db.accountConnectionOAuthPending.deleteMany({
    where: {
      userId,
      stateHash: pending.stateHash,
      expiresAt: { gt: new Date() },
      connection: { workspace: workspaceScopeWhere(scope) },
    },
  });
  if (!consumed.count) return redirect("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
  const where = {
    id: row.id,
    workspace: workspaceScopeWhere(scope),
    updatedAt: row.updatedAt,
  };
  try {
    const proof = JSON.parse(decryptSecretText(pending.encryptedVerifier));
    if (
      row.authType !== "oauth2" ||
      row.updatedAt.toISOString() !== proof.version ||
      stateHash(JSON.stringify(row.config)) !== proof.config ||
      pending.redirectUri !== redirectUri()
    )
      return redirect("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
    if (params.has("error"))
      throw new ConnectionError(
        params.get("error") === "access_denied"
          ? "ACCOUNT_CONNECTION_OAUTH_DENIED"
          : "ACCOUNT_CONNECTION_OAUTH_FAILED",
      );
    const code = params.get("code");
    if (!code || code.length > 8192)
      throw new ConnectionError("ACCOUNT_CONNECTION_OAUTH_FAILED");
    const config = configSchema.parse(row.config);
    const { clientSecret } = decryptSecretRecord(row.encryptedSecret);
    const issued = await exchange(
      config,
      clientSecret ? { clientSecret } : {},
      {
        grant_type: "authorization_code",
        code,
        code_verifier: proof.verifier,
        redirect_uri: pending.redirectUri,
      },
    );
    const accountLabel = await testResource({
      config,
      authType: row.authType,
      secrets: issued.secrets,
    });
    const changed = await db.accountConnection.updateMany({
      where,
      data: {
        encryptedSecret: encryptSecretRecord(issued.secrets),
        expiresAt: issued.expiresAt,
        accountLabel,
        status: "active",
        lastError: null,
        refreshLeaseUntil: null,
      },
    });
    return changed.count
      ? redirect()
      : redirect("ACCOUNT_CONNECTION_OAUTH_EXPIRED");
  } catch (error) {
    const code =
      error instanceof ConnectionError
        ? error.code
        : "ACCOUNT_CONNECTION_OAUTH_FAILED";
    await db.accountConnection.updateMany({
      where,
      data: { lastError: code, status: "failed", refreshLeaseUntil: null },
    });
    return redirect(code);
  }
}
