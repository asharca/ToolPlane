/** Client-safe contract for remote MCP OAuth connections and admin clients. */

/** Allowlisted outcomes the OAuth callback reports via `?oauth=` on the detail page. */
export type McpOAuthOutcome =
  | "connected"
  | "oauthDenied"
  | "oauthStateInvalid"
  | "oauthClientMissing"
  | "oauthDiscoveryFailed"
  | "oauthExchangeFailed";

export type McpOAuthConnectionStatus =
  | "not_connected"
  | "active"
  | "reauth_required";

/** Shown on the deployment detail page; null for non-OAuth deployments. */
export type McpOAuthConnectionSummary = {
  issuer: string;
  status: McpOAuthConnectionStatus;
  /** Login/email reported at connect time, display only. */
  accountLabel: string | null;
  scopes: string[];
  /** ISO timestamp of the last successful sign-in. */
  connectedAt: string | null;
  /** Same-origin path that (re)starts sign-in. */
  startUrl: string;
};

export type McpOAuthClientAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";

/** Admin view of a registered or dynamically registered OAuth client. */
export type McpOAuthClientSummary = {
  id: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  authMethod: McpOAuthClientAuthMethod;
  source: "manual" | "dynamic";
  createdAt: string;
};

export type McpOAuthAdminOverview = {
  clients: McpOAuthClientSummary[];
  /** Register this exact URI as the redirect URI at the provider. */
  redirectUri: string;
  /** Client ID Metadata Document URL; null unless the app origin is HTTPS. */
  clientMetadataUrl: string | null;
};

export type McpOAuthClientInput = {
  issuer: string;
  clientId: string;
  /** Blank keeps the stored secret when updating an existing issuer. */
  clientSecret?: string;
  authMethod: McpOAuthClientAuthMethod;
};

export type McpOAuthActionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "notAuthorized"
        | "invalidIssuer"
        | "invalidClient"
        | "notFound"
        | "operationFailed";
    };
