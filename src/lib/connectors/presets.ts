/**
 * Built-in connector presets. Client-safe display data plus the remote recipe
 * the server turns into a deployment; credential values never live here.
 */
export type ConnectorPresetId = "github" | "gmail";

export type ConnectorPreset = {
  id: ConnectorPresetId;
  name: string;
  /** Lowercase search terms matched against the intake input. */
  keywords: string[];
  remote: { url: string; transport: "streamable-http" | "sse" };
  token?: {
    /** Environment key holding the token; sent as `Authorization: Bearer`. */
    key: string;
    label: string;
    createUrl: string;
  };
  oauth?: {
    /** Requested scopes; omitted means the MCP challenge/metadata decides. */
    scopes?: string[];
    /** Extra authorization request parameters the provider needs. */
    authorizeParams?: Record<string, string>;
    /** Where an admin registers the OAuth client for this provider. */
    clientSetupUrl: string;
  };
};

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
  {
    id: "github",
    name: "GitHub",
    keywords: ["github", "gh", "git"],
    remote: {
      url: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http",
    },
    token: {
      key: "GITHUB_TOKEN",
      label: "Personal access token",
      createUrl: "https://github.com/settings/personal-access-tokens/new",
    },
    oauth: { clientSetupUrl: "https://github.com/settings/apps/new" },
  },
  {
    id: "gmail",
    name: "Gmail",
    keywords: ["gmail", "google", "mail", "email", "邮件", "邮箱"],
    remote: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      transport: "streamable-http",
    },
    oauth: {
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      authorizeParams: { access_type: "offline", prompt: "consent" },
      clientSetupUrl:
        "https://console.cloud.google.com/auth/overview/personal?apis=ws,wsmcp&clientType=web&isAgent=true",
    },
  },
];

export function connectorPreset(id: string): ConnectorPreset | null {
  return CONNECTOR_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Popular remote MCPs shown before the user types. Each one connects without
 * an administrator: it is public, or its authorization server supports
 * dynamic client registration. Selecting one analyzes the URL like a paste.
 */
export const FEATURED_MCPS: readonly { name: string; url: string }[] = [
  { name: "Notion", url: "https://mcp.notion.com/mcp" },
  { name: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp" },
  { name: "Supabase", url: "https://mcp.supabase.com/mcp" },
  { name: "Context7", url: "https://mcp.context7.com/mcp" },
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp" },
  { name: "Hugging Face", url: "https://huggingface.co/mcp" },
  { name: "Exa", url: "https://mcp.exa.ai/mcp" },
  { name: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp" },
];
