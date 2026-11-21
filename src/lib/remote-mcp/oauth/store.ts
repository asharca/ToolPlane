import "server-only";
import { Prisma, type McpOAuthCredential } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "@/lib/db";
import { decryptSecretText } from "@/lib/security/secrets";
import { discoverAuthorizationServer } from "./discovery";
import { type IssuedTokens, requestTokens } from "./tokens";

const refreshWindow = 300_000;
export function accessRevision(envelope: Prisma.JsonValue) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    typeof envelope.iv !== "string"
  )
    throw new Error("MCP_CREDENTIAL_INVALID");
  return envelope.iv;
}
// Short-lived tokens rotate halfway through their lifetime rather than on every RPC.
function runtimeToken(row: McpOAuthCredential) {
  const expiresAt = row.expiresAt?.getTime() ?? null;
  const envelope = row.encryptedAccessToken;
  const lead =
    envelope && typeof envelope === "object" && !Array.isArray(envelope)
      ? envelope.refreshLeadMs
      : null;
  const refreshAt =
    expiresAt === null
      ? null
      : expiresAt -
        (typeof lead === "number" && lead > 0 && lead <= refreshWindow
          ? lead
          : refreshWindow);
  const revision = accessRevision(row.encryptedAccessToken);
  return {
    token: decryptSecretText(row.encryptedAccessToken),
    oauth: { revision, refreshAt, expiresAt },
  };
}
/** The resolver supplies the canonical URL, never a caller-provided audience. */
export async function resolveOAuthToken(
  workspaceId: string,
  deploymentId: string,
  resource: string,
  issuer: unknown,
  signal?: AbortSignal,
) {
  const where = { workspaceId, deploymentId };
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const row = await db.mcpOAuthCredential.findFirst({
      where,
      include: { oauthClient: true },
    });
    if (!row) {
      await db.deployment.updateMany({
        where: { id: deploymentId, workspaceId, mcpOAuthCredential: null },
        data: { status: "setup_required" },
      });
      throw new Error("MCP_CREDENTIAL_REQUIRED");
    }
    if (
      row.resource !== resource ||
      row.issuer !== issuer ||
      row.status !== "active"
    )
      throw new Error("MCP_REAUTH_REQUIRED");
    if (row.refreshLeaseUntil && row.refreshLeaseUntil.getTime() > Date.now()) {
      await delay(150, undefined, { signal });
      continue;
    }
    const current = runtimeToken(row);
    if (
      current.oauth.refreshAt === null ||
      current.oauth.refreshAt > Date.now()
    )
      return current;
    const refreshLeaseUntil = new Date(Date.now() + 30_000);
    const lease = await db.mcpOAuthCredential.updateMany({
      where: {
        ...where,
        id: row.id,
        updatedAt: row.updatedAt,
        status: "active",
        OR: [
          { refreshLeaseUntil: null },
          { refreshLeaseUntil: { lte: new Date() } },
        ],
      },
      data: { refreshLeaseUntil },
    });
    if (!lease.count) continue;
    const held = { ...where, id: row.id, refreshLeaseUntil, status: "active" };
    let rotated: IssuedTokens;
    try {
      if (!row.encryptedRefreshToken) throw new Error();
      const timeout = AbortSignal.timeout(16_000);
      const budget = signal ? AbortSignal.any([timeout, signal]) : timeout;
      const as = await discoverAuthorizationServer(row.issuer, budget);
      rotated = await requestTokens(
        as.token,
        row.clientId,
        row.oauthClient,
        {
          grant_type: "refresh_token",
          resource,
          refresh_token: decryptSecretText(row.encryptedRefreshToken),
        },
        budget,
      );
    } catch {
      if (signal?.aborted) {
        await db.mcpOAuthCredential.updateMany({
          where: held,
          data: { refreshLeaseUntil: null },
        });
        throw new Error("MCP_CONNECTION_UNAVAILABLE");
      }
      const changed = await db.$transaction(async (tx) => {
        const failure = await tx.mcpOAuthCredential.updateMany({
          where: held,
          data: { status: "reauth_required", refreshLeaseUntil: null },
        });
        if (failure.count)
          await tx.deployment.updateMany({
            where: { id: deploymentId, workspaceId },
            data: { status: "setup_required" },
          });
        return failure.count;
      });
      if (changed) throw new Error("MCP_REAUTH_REQUIRED");
      continue;
    }
    const updated = await db.mcpOAuthCredential.updateManyAndReturn({
      where: held,
      data: {
        encryptedAccessToken: rotated.encryptedAccessToken,
        encryptedRefreshToken:
          rotated.encryptedRefreshToken === Prisma.DbNull
            ? undefined
            : rotated.encryptedRefreshToken,
        expiresAt: rotated.expiresAt,
        scopes: rotated.scopes,
        refreshLeaseUntil: null,
      },
    });
    if (updated[0]) return runtimeToken(updated[0]);
  }
  throw new Error("MCP_CONNECTION_UNAVAILABLE");
}
