export function mcpHeaderSecrets(headers: Record<string, string>): string[] {
  return Object.values(headers).flatMap((value) => {
    const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    return auth ? [value, auth] : [value];
  });
}

export function redactMcpResult(
  value: Record<string, unknown>,
  secretValues: readonly string[],
): Record<string, unknown> | null {
  const shortSecrets = [...new Set(secretValues.filter((secret) => secret.length > 0 && secret.length < 4))];
  if (shortSecrets.some((secret) => containsSecret(value, secret))) return null;
  const secrets = [...new Set(secretValues.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') {
      return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), candidate);
    }
    if (Array.isArray(candidate)) return candidate.map(redact);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [
        secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), key),
        redact(entry),
      ]));
    }
    return secrets.includes(String(candidate)) ? '[REDACTED]' : candidate;
  };
  return redact(value) as Record<string, unknown>;
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret));
  return value !== null && typeof value === 'object'
    ? Object.entries(value).some(([key, entry]) => key.includes(secret) || containsSecret(entry, secret))
    : String(value) === secret;
}
