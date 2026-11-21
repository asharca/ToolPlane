export function isOAuthConfig(
  value: unknown,
): value is Record<string, unknown> & { authType: "oauth" } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "authType" in value &&
    value.authType === "oauth"
  );
}
