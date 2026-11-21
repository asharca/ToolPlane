import "server-only";
import { resolvePrivateHostsSettings } from "@/lib/admin/settings";
import { parseRemoteMcpPrivateHosts } from "../../../../scripts/remote-mcp-private-hosts.mjs";
import {
  asMetadataUrls,
  challengeParams,
  checkedUrl,
  issuerId,
  OAuthFailure,
} from "./protocol";
import { oauthRequest } from "./http";

export type AuthorizationServer = {
  issuer: string;
  responseIssuer: string;
  authorize: string;
  token: string;
  registration: string | null;
  revoke: string | null;
  metadataClient: boolean;
  responseIss: boolean;
  registrationAuth:
    | "none"
    | "client_secret_basic"
    | "client_secret_post"
    | null;
};
export async function discoverAuthorizationServer(
  issuer: string,
  signal = AbortSignal.timeout(8000),
): Promise<AuthorizationServer> {
  for (const target of asMetadataUrls(issuer)) {
    const { status, data } = await oauthRequest(target, { signal });
    if (status < 200 || status >= 300) continue;
    if (
      issuerId(data.issuer) !== issuerId(issuer) ||
      (data.code_challenge_methods_supported !== undefined &&
        !(
          Array.isArray(data.code_challenge_methods_supported) &&
          data.code_challenge_methods_supported.includes("S256")
        ))
    )
      throw new OAuthFailure("oauthDiscoveryFailed");
    const methods = data.token_endpoint_auth_methods_supported;
    const registrationAuth =
      methods === undefined
        ? "none"
        : ((
            ["none", "client_secret_basic", "client_secret_post"] as const
          ).find(
            (method) => Array.isArray(methods) && methods.includes(method),
          ) ?? null);
    return {
      issuer: issuerId(data.issuer),
      responseIssuer: String(data.issuer),
      authorize: checkedUrl(data.authorization_endpoint).href,
      token: checkedUrl(data.token_endpoint).href,
      registrationAuth,
      registration: data.registration_endpoint
        ? checkedUrl(data.registration_endpoint).href
        : null,
      revoke: data.revocation_endpoint
        ? checkedUrl(data.revocation_endpoint).href
        : null,
      metadataClient: data.client_id_metadata_document_supported === true,
      responseIss: data.authorization_response_iss_parameter_supported === true,
    };
  }
  throw new OAuthFailure("oauthDiscoveryFailed");
}
export async function discoverMcpOAuth(
  resource: string,
  options: {
    challenge?: string;
    presetScopes?: string[];
    allowHttp?: boolean;
  } = {},
) {
  const url = checkedUrl(resource, options.allowHttp);
  const privateHosts = parseRemoteMcpPrivateHosts(
    (await resolvePrivateHostsSettings()).value,
  );
  const signal = AbortSignal.timeout(12000);
  const transport = { signal, privateHosts, allowHttp: options.allowHttp };
  const challenge =
    options.challenge ??
    (
      await oauthRequest(url.href, {
        ...transport,
        headersOnly: true,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "ToolPlane", version: "1" },
          },
        }),
      })
    ).challenge;
  const { metadata, scope } = challengeParams(challenge);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  const candidates = metadata
    ? [metadata]
    : [...new Set([root + (url.pathname === "/" ? "" : url.pathname), root])];
  for (const target of candidates) {
    const endpoint = checkedUrl(target, options.allowHttp);
    const sameOrigin = url.origin === endpoint.origin;
    const { status, data } = await oauthRequest(
      endpoint.href,
      sameOrigin ? transport : { signal },
    );
    if (status < 200 || status >= 300) continue;
    if (
      checkedUrl(data.resource, options.allowHttp).origin !== url.origin ||
      !Array.isArray(data.authorization_servers)
    )
      throw new OAuthFailure("oauthDiscoveryFailed");
    const server = await discoverAuthorizationServer(
      issuerId(data.authorization_servers[0]),
      signal,
    );
    const scopes =
      options.presetScopes ??
      (scope ? scope.split(/ +/) : (data.scopes_supported ?? []));
    if (
      !Array.isArray(scopes) ||
      scopes.length > 256 ||
      !scopes.every(
        (s): s is string =>
          typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s),
      )
    )
      throw new OAuthFailure("oauthDiscoveryFailed");
    return { server, scopes, resource: url.href };
  }
  throw new OAuthFailure("oauthDiscoveryFailed");
}
