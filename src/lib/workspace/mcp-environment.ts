export function mcpEnvironmentState(value: unknown): Record<string, string> {
  const cfg =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const env =
    cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
      ? (cfg.env as Record<string, unknown>)
      : {};
  const envelope = cfg.credentialEnvelope as
    | { configuredKeys?: unknown }
    | undefined;
  const configured = new Set(
    Array.isArray(envelope?.configuredKeys)
      ? envelope.configuredKeys.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
  );
  return Object.fromEntries(
    Object.keys(env).map((key) => [
      key,
      configured.has(key) ? "configured" : "",
    ]),
  );
}
