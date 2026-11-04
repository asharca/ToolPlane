import {
  DEFAULT_TRANSPORT_POLICY,
  permitsTransportProtocol,
  type TransportPolicy,
} from "@/lib/transport-policy";
import { createHash, timingSafeEqual } from "node:crypto";
import { SANDBOX_MCP_TOOLS, type SandboxMcpTool } from "./mcp-policy";

export const SANDBOX_OAUTH_SCOPES = [
  "sandbox:read",
  "sandbox:write",
  "sandbox:execute",
  "offline_access",
] as const;
export type SandboxOAuthScope = (typeof SANDBOX_OAUTH_SCOPES)[number];
export const AUTHORIZE_PATH = "/api/v1/sandbox-oauth/authorize";
export const CONSENT_COOKIE = "toolplane_mcp_consent";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

// Never infer the issuer or audience from attacker-controlled Host/Forwarded headers.
export function sandboxPublicOrigin(
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): string {
  const configured =
    process.env.TOOLPLANE_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured)
    throw new Error(
      "Configure TOOLPLANE_PUBLIC_URL before enabling sandbox OAuth.",
    );
  const url = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!permitsTransportProtocol(url.protocol, policy) &&
      !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Sandbox OAuth requires a canonical HTTPS origin (HTTP loopback is development-only).",
    );
  }
  return url.origin;
}
export function sandboxMcpResource(
  sandboxId: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): string {
  if (!ID.test(sandboxId)) throw new Error("Invalid sandbox ID.");
  return `${sandboxPublicOrigin(policy)}/api/v1/sandboxes/${sandboxId}/mcp`;
}
export function sandboxIdFromResource(
  resource: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): string | null {
  const prefix = `${sandboxPublicOrigin(policy)}/api/v1/sandboxes/`;
  if (!resource.startsWith(prefix) || !resource.endsWith("/mcp")) return null;
  const id = resource.slice(prefix.length, -4);
  return ID.test(id) && sandboxMcpResource(id, policy) === resource ? id : null;
}
export function sandboxProtectedResourceMetadata(
  sandboxId: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
) {
  return {
    resource: sandboxMcpResource(sandboxId, policy),
    authorization_servers: [sandboxPublicOrigin(policy)],
    scopes_supported: [...SANDBOX_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "ToolPlane sandbox",
  };
}
export function sandboxAuthChallenge(
  sandboxId: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): string {
  sandboxMcpResource(sandboxId, policy);
  return `Bearer resource_metadata="${sandboxPublicOrigin(policy)}/.well-known/oauth-protected-resource/api/v1/sandboxes/${sandboxId}/mcp"`;
}
export function sandboxAuthorizationMetadata(
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
) {
  const origin = sandboxPublicOrigin(policy);
  return {
    issuer: origin,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}/api/v1/sandbox-oauth/token`,
    registration_endpoint: `${origin}/api/v1/sandbox-oauth/register`,
    revocation_endpoint: `${origin}/api/v1/sandbox-oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SANDBOX_OAUTH_SCOPES],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
  };
}
export function parseSandboxScopes(raw: string | null): SandboxOAuthScope[] {
  const scopes = [
    ...new Set(
      (raw ?? "sandbox:read offline_access").split(" ").filter(Boolean),
    ),
  ];
  if (
    !scopes.length ||
    scopes.some(
      (scope) => !SANDBOX_OAUTH_SCOPES.includes(scope as SandboxOAuthScope),
    )
  ) {
    throw new Error("invalid_scope");
  }
  return scopes as SandboxOAuthScope[];
}
export function toolOAuthScope(name: string): SandboxOAuthScope {
  if (name === "shell_exec" || name === "process_exec")
    return "sandbox:execute";
  if (name === "write_file" || name === "delete_file") return "sandbox:write";
  return "sandbox:read";
}
export function toolsForSandboxScopes(
  scopes: readonly string[],
): SandboxMcpTool[] {
  return SANDBOX_MCP_TOOLS.filter((tool) =>
    scopes.includes(toolOAuthScope(tool)),
  );
}
export function sandboxToolAnnotations(name: string) {
  const readOnlyHint = toolOAuthScope(name) === "sandbox:read";
  return {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: readOnlyHint,
    openWorldHint: !readOnlyHint,
  };
}
export function isValidOAuthRedirect(
  value: string,
  policy: TransportPolicy = DEFAULT_TRANSPORT_POLICY,
): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || value.length > 2048)
      return false;
    // Exact URI matching at authorization and token exchange; no wildcard redirects.
    return (
      permitsTransportProtocol(url.protocol, policy) ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  )
    return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
}
export function exactParameter(
  params: URLSearchParams,
  name: string,
): string | null {
  if (params.getAll(name).length > 1)
    throw new Error("Duplicate OAuth parameter.");
  return params.get(name);
}
