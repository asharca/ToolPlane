import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import {
  resolveWorkspaceScope,
  workspaceScopeWhere,
  type WorkspaceScope,
} from "@/lib/workspace/scope";
import { presetForRemoteUrl } from "@/lib/workspace/mcp-intake";
import { mcpProcessOptions } from "@/lib/workspace/mcp-intake-creation";
import { runMcpDeploymentOperation } from "@/lib/workspace/mcp-operation";
import { trackRuntimeOperation } from "@/lib/runtime/ownership-state";
import { resolveMcpConnectionSpawnSpec } from "@/lib/process/mcp-credentials";
import { startProcess } from "@/lib/process/supervisor";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import { chooseClient, exchangeClient } from "./clients";
import { discoverAuthorizationServer, discoverMcpOAuth } from "./discovery";
import { requestTokens } from "./tokens";
import {
  checkedUrl,
  makeAuthorizationProof,
  oauthLocations,
  OAuthFailure,
  stateHash,
} from "./protocol";
import type { McpOAuthOutcome } from "../oauth-types";

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function outcome(
  result: McpOAuthOutcome,
  ws?: WorkspaceScope | null,
  id?: string,
) {
  return redirect(
    `${oauthLocations().origin + (ws && id ? `/app/${encodeURIComponent(ws.slug)}/mcp/${encodeURIComponent(id)}` : "/app")}?oauth=${result}`,
  );
}
function deploymentWhere(scope: WorkspaceScope, id: string) {
  return {
    id,
    workspace: workspaceScopeWhere(scope),
    source: "remote",
    installCfg: { path: ["authType"], equals: "oauth" },
  };
}
export async function beginAuthorization(
  userId: string,
  slug: string,
  deploymentId: string,
) {
  const ws = await resolveWorkspaceScope({ slug }, userId);
  if (!ws) return outcome("oauthDenied");
  const dep = await db.deployment.findFirst({
    where: deploymentWhere(ws, deploymentId),
  });
  if (!dep?.sourceRef) return outcome("oauthDenied");
  try {
    const cfg = dep.installCfg as Record<string, unknown>;
    const preset = presetForRemoteUrl(dep.sourceRef);
    const allowHttp =
      cfg.allowUnsafeHttp === true || (await getTransportSettings()).allowHttp;
    const { server, resource, scopes } = await discoverMcpOAuth(dep.sourceRef, {
      allowHttp,
      presetScopes: preset?.oauth?.scopes,
    });
    if (cfg.issuer != null && server.issuer !== cfg.issuer)
      throw new OAuthFailure("oauthDiscoveryFailed");
    const clientId = await chooseClient(server);
    const { state, verifier, challenge } = makeAuthorizationProof();
    const { redirectUri } = oauthLocations();
    const url = checkedUrl(server.authorize);
    for (const [key, value] of Object.entries({
      ...preset?.oauth?.authorizeParams,
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    }))
      url.searchParams.set(key, value);
    await db.$transaction(async (tx) => {
      await tx.mcpOAuthPending.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });
      if (
        !(await tx.deployment.findFirst({
          where: {
            ...deploymentWhere(ws, deploymentId),
            sourceRef: dep.sourceRef,
          },
          select: { id: true },
        }))
      )
        throw new OAuthFailure("oauthDenied");
      // Bind the advertised response-issuer requirement at initiation, not just on rediscovery.
      await tx.mcpOAuthPending.create({
        data: {
          stateHash: stateHash(state),
          workspaceId: ws.id,
          deploymentId,
          userId,
          issuer: server.issuer,
          clientId,
          encryptedVerifier: encryptSecretText(
            JSON.stringify({
              verifier,
              responseIss: server.responseIss ? server.responseIssuer : null,
            }),
          ),
          resource,
          redirectUri,
          scopes,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    });
    return redirect(url.href);
  } catch (e) {
    return outcome(
      e instanceof OAuthFailure ? e.outcome : "oauthDiscoveryFailed",
      ws,
      deploymentId,
    );
  }
}
export async function finishAuthorization(
  userId: string,
  params: URLSearchParams,
) {
  const state = params.get("state");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state))
    return outcome("oauthStateInvalid");
  const pending = await db.mcpOAuthPending.findFirst({
    where: { stateHash: stateHash(state), userId },
  });
  if (!pending) return outcome("oauthStateInvalid");
  const { deploymentId, clientId, issuer, resource, redirectUri } = pending;
  const ws = await resolveWorkspaceScope({ id: pending.workspaceId }, userId);
  if (!ws) return outcome("oauthDenied");
  const where = deploymentWhere(ws, deploymentId);
  try {
    const result = await runMcpDeploymentOperation(ws.id, deploymentId, () =>
      trackRuntimeOperation(async () => {
        const consumed = await db.mcpOAuthPending.deleteMany({
          where: {
            stateHash: pending.stateHash,
            userId,
            expiresAt: { gt: new Date() },
          },
        });
        if (!consumed.count) throw new OAuthFailure("oauthStateInvalid");
        const dep = await db.deployment.findFirst({ where });
        if (!dep?.sourceRef || new URL(dep.sourceRef).href !== resource)
          throw new OAuthFailure("oauthDenied");
        const config = dep.installCfg as Prisma.JsonObject;
        if (config.issuer != null && config.issuer !== issuer)
          throw new OAuthFailure("oauthDenied");
        const { verifier, responseIss } = JSON.parse(
          decryptSecretText(pending.encryptedVerifier),
        );
        if (responseIss && params.get("iss") !== responseIss)
          throw new OAuthFailure("oauthStateInvalid");
        if (params.has("error"))
          throw new OAuthFailure(
            params.get("error") === "access_denied"
              ? "oauthDenied"
              : "oauthExchangeFailed",
          );
        const code = params.get("code");
        if (!code || code.length > 8192)
          throw new OAuthFailure("oauthExchangeFailed");
        const as = await discoverAuthorizationServer(issuer);
        if (
          (as.responseIss || params.has("iss")) &&
          params.get("iss") !== as.responseIssuer
        )
          throw new OAuthFailure("oauthStateInvalid");
        const client = await exchangeClient(issuer, clientId);
        const tokens = await requestTokens(as.token, clientId, client, {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          resource,
          redirect_uri: redirectUri,
        });
        const data = {
          ...tokens,
          scopes: tokens.scopes ?? pending.scopes,
          workspaceId: ws.id,
          issuer,
          clientId,
          oauthClientId: client?.id ?? null,
          resource,
          connectedAt: new Date(),
          connectedById: userId,
          status: "active",
          refreshLeaseUntil: null,
        };
        await db.$transaction(async (tx) => {
          const updated = await tx.deployment.updateMany({
            where: {
              ...where,
              sourceRef: dep.sourceRef,
              installCfg: { equals: config },
            },
            data: {
              status: "provisioning",
              ...(config.issuer == null && {
                installCfg: { ...config, issuer },
              }),
            },
          });
          if (!updated.count) throw new OAuthFailure("oauthDenied");
          await tx.mcpOAuthCredential.upsert({
            where: { deploymentId },
            create: { ...data, deploymentId },
            update: data,
          });
        });
        try {
          const { spec } = await resolveMcpConnectionSpawnSpec({
            workspaceId: ws.id,
            deploymentId,
          });
          await startProcess(
            deploymentId,
            spec,
            mcpProcessOptions({ ws, user: { id: userId } }, deploymentId),
          );
        } catch {
          await db.deployment.updateMany({
            where: { ...where, status: "provisioning" },
            data: { status: "error" },
          });
          throw new OAuthFailure("oauthExchangeFailed");
        }
      }),
    );
    return outcome(
      result.accepted ? "connected" : "oauthDenied",
      ws,
      deploymentId,
    );
  } catch (e) {
    return outcome(
      e instanceof OAuthFailure ? e.outcome : "oauthExchangeFailed",
      ws,
      deploymentId,
    );
  }
}
