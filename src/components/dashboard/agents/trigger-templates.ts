import type { AccountConnectionPreset } from "../account-connection-presets";

export type SourceKind = "feed" | "http";
export type TriggerKind = "schedule" | "webhook" | SourceKind;
export type TriggerTemplateId = "github" | "x" | "youtube";

export type FeedConfig = {
  url: string;
};

export type HttpFilter = {
  path: string;
  values: string[];
};

export type HttpConfig = {
  url: string;
  itemsPath: string;
  idPath: string;
  revisionPath?: string;
  filters?: HttpFilter[];
};

export type HttpFilterDraft = {
  id: string;
  path: string;
  values: string;
};

export const SOURCE_KINDS: readonly SourceKind[] = ["feed", "http"];

export const isSourceKind = (kind: string): kind is SourceKind =>
  kind === "feed" || kind === "http";

export const TRIGGER_TEMPLATES: readonly TriggerTemplateId[] = [
  "github",
  "x",
  "youtube",
];

export const GITHUB_REASONS = [
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "author",
  "comment",
  "state_change",
  "ci_activity",
] as const;

export const GITHUB_NOTIFICATIONS_URL =
  "https://api.github.com/notifications?participating=true&per_page=50";

export const MAX_HTTP_FILTERS = 10;

export function parseList(raw: string): string[] {
  return raw
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseRepositories(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractYouTubeChannelId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^UC[\w-]{10,}$/.test(trimmed)) return trimmed;
  const fromUrl = trimmed.match(/\/channel\/(UC[\w-]{10,})(?:[/?#]|$)/i);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{10,64}$/.test(trimmed)) return trimmed;
  return null;
}

export function buildGitHubSourceConfig(
  reasons: string[],
  repositories: string,
): HttpConfig {
  const filters: HttpFilter[] = [];
  if (reasons.length > 0) {
    filters.push({ path: "reason", values: reasons });
  }
  const repos = parseRepositories(repositories);
  if (repos.length > 0) {
    filters.push({ path: "repository.full_name", values: repos });
  }
  return {
    url: GITHUB_NOTIFICATIONS_URL,
    itemsPath: "",
    idPath: "id",
    revisionPath: "updated_at",
    ...(filters.length > 0 ? { filters } : {}),
  };
}

export function buildXSourceConfig(userId: string): HttpConfig {
  const cleanId = encodeURIComponent(userId.trim());
  return {
    url: `https://api.x.com/2/users/${cleanId}/mentions?tweet.fields=author_id,created_at&max_results=100`,
    itemsPath: "data",
    idPath: "id",
  };
}

export function buildYouTubeSourceConfig(
  channelInput: string,
): FeedConfig | null {
  const channelId = extractYouTubeChannelId(channelInput);
  if (!channelId) return null;
  return {
    url: `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
  };
}

export function templateRequiredPreset(
  template: TriggerTemplateId | null,
): AccountConnectionPreset | null {
  if (template === "github") return "github";
  if (template === "x") return "x";
  return null;
}

export function extractSourceHost(
  config: Record<string, unknown> | undefined,
): string | null {
  const url = typeof config?.url === "string" ? config.url : "";
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function filtersFromConfig(
  config: Record<string, unknown> | undefined,
  nextId: () => string,
): HttpFilterDraft[] {
  if (!Array.isArray(config?.filters)) return [];
  const rows: HttpFilterDraft[] = [];
  for (const item of config.filters) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const values = Array.isArray(record.values)
      ? record.values.filter((v): v is string => typeof v === "string")
      : [];
    if (path || values.length > 0) {
      rows.push({
        id: nextId(),
        path,
        values: values.join(", "),
      });
    }
  }
  return rows;
}
