import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { originFromHeaders } from "@/lib/http/origin";
import type { McpOAuthOutcome } from "../oauth-types";

export class OAuthFailure extends Error {
  constructor(readonly outcome: Exclude<McpOAuthOutcome, "connected">) {
    super(outcome);
  }
}
export function oauthLocations() {
  const origin = originFromHeaders(new Headers());
  const base = `${origin}/api/v1/mcp-oauth`;
  return {
    origin,
    redirectUri: `${base}/callback`,
    clientMetadataUrl: origin.startsWith("https://")
      ? `${base}/client-metadata.json`
      : null,
  };
}
export function startUrl(workspace: string, deploymentId: string) {
  return `/api/v1/mcp-oauth/start?${new URLSearchParams({ workspace, deploymentId })}`;
}
export function stateHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function makeAuthorizationProof() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  return {
    state,
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
export function checkedUrl(value: unknown, allowHttp = false) {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/u.test(value))
    throw new OAuthFailure("oauthDiscoveryFailed");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === "https:" || (allowHttp && url.protocol === "http:"))
  )
    throw new OAuthFailure("oauthDiscoveryFailed");
  return url;
}
export function issuerId(value: unknown) {
  const url = checkedUrl(value);
  if (url.search || String(value).includes("?") || String(value).includes("#"))
    throw new OAuthFailure("oauthDiscoveryFailed");
  return url.pathname === "/" ? url.origin : url.href;
}
export function asMetadataUrls(issuer: string) {
  const { origin, pathname } = new URL(issuerId(issuer));
  const path = pathname.replace(/\/$/, "");
  const oidc = "/.well-known/openid-configuration";
  return [
    ...new Set([
      `${origin}/.well-known/oauth-authorization-server${path}`,
      origin + oidc + path,
      origin + path + oidc,
    ]),
  ];
}
export function challengeParams(challenge = "") {
  const param = (key: string) =>
    new RegExp(`(?:^|[,\\s])${key}\\s*=\\s*(?:"([^"\\r\\n]*)"|([^,\\s]+))`, "i")
      .exec(challenge)
      ?.slice(1)
      .find((v) => v !== undefined);
  return { metadata: param("resource_metadata"), scope: param("scope") };
}
export function metadataDocument() {
  const { redirectUri, clientMetadataUrl } = oauthLocations();
  return {
    client_name: "ToolPlane",
    ...(clientMetadataUrl && { client_id: clientMetadataUrl }),
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
