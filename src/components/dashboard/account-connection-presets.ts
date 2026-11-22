export type AccountConnectionPreset = "github" | "x" | "google" | "custom";
export type AccountConnectionAuthType =
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2";
export type AccountConnectionStatus =
  | "active"
  | "pending"
  | "expired"
  | "failed";

export type AccountConnectionOAuthConfig = {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  extraParams: Record<string, string>;
  clientAuth: "body" | "basic";
};

export type AccountConnectionDTO = {
  id: string;
  name: string;
  preset: AccountConnectionPreset;
  authType: AccountConnectionAuthType;
  status: AccountConnectionStatus;
  accountLabel: string | null;
  lastError: string | null;
  allowedHosts: string[];
  headerName: string | null;
  queryName: string | null;
  username: string | null;
  testUrl: string | null;
  accountPath: string | null;
  oauth: AccountConnectionOAuthConfig | null;
  hasSecret: boolean;
  expiresAt: string | null;
  usage: number;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionInput = {
  name: string;
  preset: AccountConnectionPreset;
  authType: AccountConnectionAuthType;
  allowedHosts: string[];
  headerName?: string;
  queryName?: string;
  username?: string;
  testUrl?: string | null;
  accountPath?: string | null;
  oauth?: AccountConnectionOAuthConfig;
  secret?: string;
};

export type ConnectionPresetTemplateId =
  | "github_token"
  | "github_oauth"
  | "x_token"
  | "x_oauth"
  | "google"
  | "custom";

export type ConnectionDraft = {
  id?: string;
  templateId: ConnectionPresetTemplateId;
  preset: AccountConnectionPreset;
  authType: AccountConnectionAuthType;
  name: string;
  allowedHosts: string;
  headerName: string;
  queryName: string;
  username: string;
  testUrl: string;
  accountPath: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string;
  extraParams: string;
  clientAuth: "body" | "basic";
  secret: string;
  hasSecret: boolean;
};

export const GITHUB_CREATE_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=notifications&description=ToolPlane";

export const CONNECTION_TEMPLATE_IDS: readonly ConnectionPresetTemplateId[] = [
  "github_token",
  "github_oauth",
  "x_token",
  "x_oauth",
  "google",
  "custom",
];

export const CONNECTION_AUTH_TYPES: readonly AccountConnectionAuthType[] = [
  "bearer",
  "header",
  "query",
  "basic",
  "oauth2",
];

export function formatExtraParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseExtraParams(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function parseHosts(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const host = part.trim().toLowerCase();
    if (host) seen.add(host);
  }
  return Array.from(seen);
}

export function parseScopes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function draftFromTemplate(
  templateId: ConnectionPresetTemplateId,
  existingName = "",
): ConnectionDraft {
  const base: ConnectionDraft = {
    templateId,
    preset: "custom",
    authType: "bearer",
    name: existingName,
    allowedHosts: "",
    headerName: "",
    queryName: "",
    username: "",
    testUrl: "",
    accountPath: "",
    authorizationUrl: "",
    tokenUrl: "",
    clientId: "",
    scopes: "",
    extraParams: "",
    clientAuth: "body",
    secret: "",
    hasSecret: false,
  };

  switch (templateId) {
    case "github_token":
      return {
        ...base,
        preset: "github",
        authType: "bearer",
        allowedHosts: "api.github.com",
        testUrl: "https://api.github.com/user",
        accountPath: "login",
      };
    case "github_oauth":
      return {
        ...base,
        preset: "github",
        authType: "oauth2",
        allowedHosts: "api.github.com",
        testUrl: "https://api.github.com/user",
        accountPath: "login",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: "notifications",
        clientAuth: "body",
      };
    case "x_token":
      return {
        ...base,
        preset: "x",
        authType: "bearer",
        allowedHosts: "api.x.com",
      };
    case "x_oauth":
      return {
        ...base,
        preset: "x",
        authType: "oauth2",
        allowedHosts: "api.x.com",
        testUrl: "https://api.x.com/2/users/me",
        accountPath: "data.username",
        authorizationUrl: "https://x.com/i/oauth2/authorize",
        tokenUrl: "https://api.x.com/2/oauth2/token",
        scopes: "tweet.read users.read offline.access",
        clientAuth: "basic",
      };
    case "google":
      return {
        ...base,
        preset: "google",
        authType: "oauth2",
        allowedHosts: "www.googleapis.com\nyoutube.googleapis.com",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/youtube.readonly",
        extraParams: formatExtraParams({
          access_type: "offline",
          prompt: "consent",
        }),
        clientAuth: "body",
      };
    case "custom":
      return base;
  }
}

export function draftFromConnection(
  connection: AccountConnectionDTO,
): ConnectionDraft {
  const templateId: ConnectionPresetTemplateId =
    connection.preset === "github"
      ? connection.authType === "oauth2"
        ? "github_oauth"
        : "github_token"
      : connection.preset === "x"
        ? connection.authType === "oauth2"
          ? "x_oauth"
          : "x_token"
        : connection.preset === "google"
          ? "google"
          : "custom";

  return {
    id: connection.id,
    templateId,
    preset: connection.preset,
    authType: connection.authType,
    name: connection.name,
    allowedHosts: connection.allowedHosts.join("\n"),
    headerName: connection.headerName ?? "",
    queryName: connection.queryName ?? "",
    username: connection.username ?? "",
    testUrl: connection.testUrl ?? "",
    accountPath: connection.accountPath ?? "",
    authorizationUrl: connection.oauth?.authorizationUrl ?? "",
    tokenUrl: connection.oauth?.tokenUrl ?? "",
    clientId: connection.oauth?.clientId ?? "",
    scopes: connection.oauth?.scopes.join(" ") ?? "",
    extraParams: connection.oauth
      ? formatExtraParams(connection.oauth.extraParams)
      : "",
    clientAuth: connection.oauth?.clientAuth ?? "body",
    secret: "",
    hasSecret: connection.hasSecret,
  };
}

export function buildConnectionPayload(
  draft: ConnectionDraft,
): Partial<ConnectionInput> {
  const testUrl = draft.testUrl.trim();
  const accountPath = draft.accountPath.trim();
  const secret = draft.secret.trim();
  const payload: Partial<ConnectionInput> = {
    name: draft.name.trim(),
    preset: draft.preset,
    ...(!draft.id ? { authType: draft.authType } : {}),
    allowedHosts: parseHosts(draft.allowedHosts),
    // On edit, null clears a stored optional field; omission would keep it.
    ...(testUrl ? { testUrl } : draft.id ? { testUrl: null } : {}),
    ...(testUrl && accountPath
      ? { accountPath }
      : draft.id
        ? { accountPath: null }
        : {}),
    // A public OAuth client confirms a client rebind with an explicit empty secret.
    ...(secret
      ? { secret }
      : draft.id && draft.authType === "oauth2" && !draft.hasSecret
        ? { secret: "" }
        : {}),
  };

  if (draft.authType === "header") {
    payload.headerName = draft.headerName.trim();
  } else if (draft.authType === "query") {
    payload.queryName = draft.queryName.trim();
  } else if (draft.authType === "basic") {
    payload.username = draft.username.trim();
  } else if (draft.authType === "oauth2") {
    payload.oauth = {
      authorizationUrl: draft.authorizationUrl.trim(),
      tokenUrl: draft.tokenUrl.trim(),
      clientId: draft.clientId.trim(),
      scopes: parseScopes(draft.scopes),
      extraParams: parseExtraParams(draft.extraParams),
      clientAuth: draft.clientAuth,
    };
  }

  return payload;
}
