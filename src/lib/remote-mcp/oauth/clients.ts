import "server-only";
import { db } from "@/lib/db";
import type { McpOAuthClient } from "@prisma/client";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";
import { oauthLocations, metadataDocument, OAuthFailure } from "./protocol";
import { oauthRequest } from "./http";
import type { AuthorizationServer } from "./discovery";

export async function clientAvailability(as: AuthorizationServer) {
  const row = await db.mcpOAuthClient.findUnique({
    where: { issuer: as.issuer },
    select: { source: true, clientId: true },
  });
  if (row?.source === "manual") return { kind: "registered" as const, row };
  if (as.metadataClient && oauthLocations().clientMetadataUrl)
    return { kind: "metadata" as const };
  if (row || (as.registration && as.registrationAuth))
    return { kind: "dynamic" as const, row };
  return { kind: "missing" as const };
}
export async function chooseClient(as: AuthorizationServer) {
  const { kind, row } = await clientAvailability(as);
  if (row) return row.clientId;
  const metadataUrl = oauthLocations().clientMetadataUrl;
  if (kind === "metadata" && metadataUrl) return metadataUrl;
  if (kind !== "dynamic" || !as.registration || !as.registrationAuth)
    throw new OAuthFailure("oauthClientMissing");
  const { client_id: _id, ...metadata } = metadataDocument();
  const { status, data } = await oauthRequest(as.registration, {
    body: JSON.stringify({
      ...metadata,
      token_endpoint_auth_method: as.registrationAuth,
    }),
    headers: { "content-type": "application/json" },
  });
  const method = data.token_endpoint_auth_method ?? as.registrationAuth;
  if (
    status < 200 ||
    status >= 300 ||
    typeof data.client_id !== "string" ||
    !data.client_id ||
    data.client_id.length > 4096 ||
    typeof method !== "string" ||
    !["none", "client_secret_post", "client_secret_basic"].includes(method) ||
    (method !== "none" &&
      !(typeof data.client_secret === "string" && data.client_secret))
  ) {
    throw new OAuthFailure("oauthClientMissing");
  }
  const client = await db.mcpOAuthClient.upsert({
    where: { issuer: as.issuer },
    update: {},
    create: {
      issuer: as.issuer,
      clientId: data.client_id,
      source: "dynamic",
      authMethod: method,
      ...(typeof data.client_secret === "string" && {
        encryptedSecret: encryptSecretText(data.client_secret),
      }),
    },
  });
  return client.clientId;
}
export async function exchangeClient(issuer: string, clientId: string) {
  if (clientId === oauthLocations().clientMetadataUrl) return null;
  const client = await db.mcpOAuthClient.findUnique({ where: { issuer } });
  if (!client || client.clientId !== clientId)
    throw new OAuthFailure("oauthClientMissing");
  return client;
}
export function clientForm(
  clientId: string,
  client: McpOAuthClient | null,
  fields: Record<string, string>,
) {
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (client && client.clientId !== clientId)
    throw new OAuthFailure("oauthClientMissing");
  if (!client || client.authMethod === "none") form.set("client_id", clientId);
  else {
    const secret = decryptSecretText(client.encryptedSecret);
    if (client.authMethod === "client_secret_post") {
      form.set("client_id", clientId);
      form.set("client_secret", secret);
    } else if (client.authMethod === "client_secret_basic") {
      const encode = (value: string) =>
        new URLSearchParams([["", value]]).toString().slice(1);
      headers.authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString("base64")}`;
    } else throw new OAuthFailure("oauthClientMissing");
  }
  return { headers, body: form.toString() };
}
