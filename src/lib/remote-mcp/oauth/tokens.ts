import "server-only";
import {
  Prisma,
  type McpOAuthClient,
  type McpOAuthCredential,
} from "@prisma/client";
import {
  decryptSecretText,
  encryptSecretText,
  type SecretEnvelope,
} from "@/lib/security/secrets";
import { clientForm } from "./clients";
import { discoverAuthorizationServer } from "./discovery";
import { oauthRequest } from "./http";
import { OAuthFailure } from "./protocol";

/** Encrypted token material ready to persist on McpOAuthCredential. */
export type IssuedTokens = {
  encryptedAccessToken: SecretEnvelope & { refreshLeadMs: number };
  encryptedRefreshToken: SecretEnvelope | typeof Prisma.DbNull;
  expiresAt: Date | null;
  accountLabel: string | null;
  scopes: string[] | undefined;
};

export async function requestTokens(
  endpoint: string,
  clientId: string,
  client: McpOAuthClient | null,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<IssuedTokens> {
  const { status, data } = await oauthRequest(endpoint, {
    ...clientForm(clientId, client, fields),
    signal,
  });
  const token = data.access_token;
  const ttl = data.expires_in;
  if (
    status < 200 ||
    status >= 300 ||
    typeof token !== "string" ||
    !/^[!-~]{1,8185}$/.test(token) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    (ttl !== undefined &&
      (typeof ttl !== "number" ||
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        ttl > 86400 * 365 * 100))
  ) {
    throw new OAuthFailure("oauthExchangeFailed");
  }
  const refresh =
    typeof data.refresh_token === "string" ? data.refresh_token : "";
  const secretIn = (text: string) =>
    text.includes(token) || (refresh !== "" && text.includes(refresh));
  let accountLabel: string | null = null;
  // Display only: this unverified claim must never establish application identity.
  if (typeof data.id_token === "string") {
    try {
      const { email } = JSON.parse(
        Buffer.from(data.id_token.split(".")[1], "base64url").toString(),
      );
      if (
        typeof email === "string" &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+$/.test(email) &&
        !secretIn(email)
      )
        accountLabel = email;
    } catch {
      /* Optional display claim. */
    }
  }
  const scopes =
    typeof data.scope === "string"
      ? data.scope.split(/ +/).filter(Boolean)
      : undefined;
  if (scopes?.some(secretIn)) throw new OAuthFailure("oauthExchangeFailed");
  return {
    encryptedAccessToken: {
      ...encryptSecretText(token),
      // Keep short-lived tokens usable without refreshing on every RPC.
      refreshLeadMs:
        typeof ttl === "number" ? Math.min(300_000, ttl * 500) : 300_000,
    },
    encryptedRefreshToken: refresh ? encryptSecretText(refresh) : Prisma.DbNull,
    expiresAt:
      typeof ttl === "number" ? new Date(Date.now() + ttl * 1000) : null,
    accountLabel,
    scopes,
  };
}
export async function revokeCredential(
  row: McpOAuthCredential & { oauthClient: McpOAuthClient | null },
) {
  const as = await discoverAuthorizationServer(row.issuer);
  if (!as.revoke) return;
  const refresh = row.encryptedRefreshToken;
  await oauthRequest(
    as.revoke,
    clientForm(row.clientId, row.oauthClient, {
      token: decryptSecretText(refresh ?? row.encryptedAccessToken),
      token_type_hint: refresh ? "refresh_token" : "access_token",
    }),
  );
}
