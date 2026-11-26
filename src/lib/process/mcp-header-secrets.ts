export function mcpHeaderSecrets(headers: Record<string, string>): string[] {
  return Object.values(headers).flatMap((value) => {
    const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    return auth ? [value, auth] : [value];
  });
}
