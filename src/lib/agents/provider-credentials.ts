import type {
  ApiKeyCredential,
  Credential,
  OAuthCredential,
} from "@earendil-works/pi-ai";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    )
  );
}

export function parseProviderCredential(
  rawApiKey: string,
): Credential | undefined {
  const trimmed = rawApiKey.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          record.type === "oauth" &&
          isNonEmptyString(record.access) &&
          isNonEmptyString(record.refresh) &&
          typeof record.expires === "number" &&
          Number.isFinite(record.expires)
        ) {
          return record as unknown as OAuthCredential;
        }
        if (
          record.type === "api_key" &&
          (isNonEmptyString(record.key) || isStringRecord(record.env))
        ) {
          return {
            type: "api_key",
            ...(isNonEmptyString(record.key) ? { key: record.key } : {}),
            ...(isStringRecord(record.env) ? { env: record.env } : {}),
          } satisfies ApiKeyCredential;
        }
      }
    } catch {
      // Treat non-JSON or malformed JSON strings as plain API keys.
    }
  }

  return { type: "api_key", key: trimmed };
}

export function serializeProviderCredential(credential: Credential): string {
  if (
    credential.type === "api_key" &&
    (!credential.env || Object.keys(credential.env).length === 0)
  ) {
    return credential.key?.trim() ?? "";
  }
  return JSON.stringify(credential);
}

export function providerAuthType(
  rawApiKey: string,
): "oauth" | "api_key" | "none" {
  const credential = parseProviderCredential(rawApiKey);
  if (!credential) return "none";
  return credential.type;
}

export function providerSecrets(rawApiKey: string): string[] {
  const trimmed = rawApiKey.trim();
  if (!trimmed) return [];
  const secrets = new Set<string>([trimmed]);
  const credential = parseProviderCredential(trimmed);
  if (credential?.type === "oauth") {
    if (isNonEmptyString(credential.access))
      secrets.add(credential.access.trim());
    if (isNonEmptyString(credential.refresh))
      secrets.add(credential.refresh.trim());
  } else if (credential?.type === "api_key") {
    if (isNonEmptyString(credential.key)) secrets.add(credential.key.trim());
  }
  return [...secrets];
}
