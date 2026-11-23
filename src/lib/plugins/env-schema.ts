import { z } from "zod";

export const PLUGIN_ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Environment names reserved by the Node/Pi runtime and never user/plugin-writable. */
export const BASE_RESERVED_ENV_REGEX =
  /^(?:TOOLPLANE_|TP_|NODE_|LD_|DYLD_|npm_|NPM_|BUN_|AUTH_SECRET$|DATABASE_URL$|DIRECT_URL$|PI_CODING_AGENT_DIR$|PI_PACKAGE_DIR$|HOME$|PATH$|SHELL$|ENV$|BASH_ENV$|PYTHONPATH$)/;

/** Additional proxy/CA variables that plugins cannot declare or overwrite. */
export const PLUGIN_RESERVED_ENV_REGEX =
  /^(?:TOOLPLANE_|TP_|NODE_|LD_|DYLD_|npm_|NPM_|BUN_|AUTH_SECRET$|DATABASE_URL$|DIRECT_URL$|PI_CODING_AGENT_DIR$|PI_PACKAGE_DIR$|HOME$|PATH$|SHELL$|ENV$|BASH_ENV$|PYTHONPATH$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|all_proxy$|no_proxy$|SSL_CERT_FILE$|NODE_EXTRA_CA_CERTS$|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$)/;

export function isValidBaseEnvironmentName(name: string): boolean {
  return (
    PLUGIN_ENV_NAME_REGEX.test(name) && !BASE_RESERVED_ENV_REGEX.test(name)
  );
}

export function isValidPluginEnvName(name: string): boolean {
  return (
    PLUGIN_ENV_NAME_REGEX.test(name) && !PLUGIN_RESERVED_ENV_REGEX.test(name)
  );
}

const PLUGIN_HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const FORBIDDEN_PLUGIN_PROXY_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "x-toolplane-runtime-token",
]);

export function isValidPluginHeaderName(name: string): boolean {
  return (
    PLUGIN_HEADER_NAME_REGEX.test(name) &&
    !FORBIDDEN_PLUGIN_PROXY_HEADERS.has(name.toLowerCase())
  );
}

export function validatePluginEnvUrl(raw: string): string {
  if (
    typeof raw !== "string" ||
    raw.length > 2048 ||
    raw !== raw.trim() ||
    /[^\x21-\uFFFF]|[\x7f\\]/.test(raw)
  ) {
    throw new Error("env_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("env_url_invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.port === "0"
  ) {
    throw new Error("env_url_invalid");
  }
  return url.toString();
}

export const piPackageEnvRequirementSchema = z
  .object({
    name: z.string().min(1).max(128).refine(isValidPluginEnvName),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    kind: z.enum(["string", "url"]).optional(),
    description: z.string().max(400).optional(),
  })
  .strict();

export const piPackageHttpProxyAuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("bearer"),
      secretEnv: z.string().min(1).max(128).refine(isValidPluginEnvName),
    })
    .strict(),
  z
    .object({
      type: z.literal("header"),
      headerName: z.string().min(1).max(64).refine(isValidPluginHeaderName),
      prefix: z
        .string()
        .max(64)
        .refine((value) => !/[\r\n\0]/.test(value))
        .optional(),
      secretEnv: z.string().min(1).max(128).refine(isValidPluginEnvName),
    })
    .strict(),
  z
    .object({
      type: z.literal("query"),
      paramName: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
      secretEnv: z.string().min(1).max(128).refine(isValidPluginEnvName),
    })
    .strict(),
]);

export const piPackageHttpProxySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    baseUrlEnv: z.string().min(1).max(128).refine(isValidPluginEnvName),
    defaultUpstreamUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          validatePluginEnvUrl(value);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    auth: piPackageHttpProxyAuthSchema,
  })
  .strict();

export const piPackageEnvRequirementsSchema = z
  .array(piPackageEnvRequirementSchema)
  .max(32);

export const piPackageHttpProxiesSchema = z
  .array(piPackageHttpProxySchema)
  .max(16);

export type PiPackageEnvRequirement = z.infer<
  typeof piPackageEnvRequirementSchema
>;
export type PiPackageHttpProxy = z.infer<typeof piPackageHttpProxySchema>;

export function isEnvRequired(item: PiPackageEnvRequirement): boolean {
  return item.required !== false;
}

export function isEnvSecret(item: PiPackageEnvRequirement): boolean {
  return item.secret !== false;
}

export function envValueKind(item: PiPackageEnvRequirement): "string" | "url" {
  return item.kind ?? "string";
}

export function validatePluginEnvDeclarations(
  env?: readonly PiPackageEnvRequirement[],
  httpProxies?: readonly PiPackageHttpProxy[],
): boolean {
  const envList = env ?? [];
  if (new Set(envList.map((item) => item.name)).size !== envList.length)
    return false;
  const proxies = httpProxies ?? [];
  if (!proxies.length) return true;
  if (!envList.length) return false;
  if (
    new Set(proxies.map((proxy) => proxy.key)).size !== proxies.length ||
    new Set(proxies.map((proxy) => proxy.baseUrlEnv)).size !== proxies.length ||
    new Set(proxies.map((proxy) => proxy.auth.secretEnv)).size !==
      proxies.length
  ) {
    return false;
  }
  const byName = new Map(envList.map((item) => [item.name, item]));
  for (const proxy of proxies) {
    if (proxy.baseUrlEnv === proxy.auth.secretEnv) return false;
    const baseUrlItem = byName.get(proxy.baseUrlEnv);
    const secretItem = byName.get(proxy.auth.secretEnv);
    if (
      !baseUrlItem ||
      isEnvSecret(baseUrlItem) ||
      envValueKind(baseUrlItem) !== "url" ||
      (!proxy.defaultUpstreamUrl && !isEnvRequired(baseUrlItem))
    ) {
      return false;
    }
    if (!secretItem || !isEnvSecret(secretItem) || !isEnvRequired(secretItem)) {
      return false;
    }
  }
  return true;
}

/** Platform presets require every secret variable to stay on the server behind an HTTP proxy. */
export function supportsPlatformPreset(
  toolplane?: {
    env?: readonly PiPackageEnvRequirement[];
    httpProxies?: readonly PiPackageHttpProxy[];
  } | null,
): boolean {
  const env = toolplane?.env ?? [];
  const proxies = toolplane?.httpProxies ?? [];
  if (!env.length) return false;
  const proxiedSecrets = new Set(proxies.map((proxy) => proxy.auth.secretEnv));
  return env.every(
    (item) => !isEnvSecret(item) || proxiedSecrets.has(item.name),
  );
}

export type PluginEnvSourceMode = "platform_preset" | "custom";

export type PluginEnvStatus = {
  requiresEnv: boolean;
  requirements: PiPackageEnvRequirement[];
  httpProxies: PiPackageHttpProxy[];
  isOfficial: boolean;
  presetSupported: boolean;
  presetConfiguredKeys: string[];
  presetMissingRequiredKeys: string[];
  presetComplete: boolean;
  mode: PluginEnvSourceMode | null;
  effectiveDefaultMode: PluginEnvSourceMode | null;
  customConfiguredKeys: string[];
  customMissingRequiredKeys: string[];
  customComplete: boolean;
  complete: boolean;
  missingRequiredKeys: string[];
};

export function normalizePluginEnvSourceMode(
  mode: string | null | undefined,
): PluginEnvSourceMode | null {
  return mode === "platform_preset" || mode === "custom" ? mode : null;
}

export function evaluatePluginEnvStatus(input: {
  requirements?: readonly PiPackageEnvRequirement[];
  httpProxies?: readonly PiPackageHttpProxy[];
  isOfficial: boolean;
  presetConfiguredKeys?: readonly string[];
  installedMode?: string | null;
  customConfiguredKeys?: readonly string[];
}): PluginEnvStatus {
  const requirements = [...(input.requirements ?? [])];
  const httpProxies = [...(input.httpProxies ?? [])];
  const presetConfiguredKeys = [...new Set(input.presetConfiguredKeys ?? [])];
  const customConfiguredKeys = [...new Set(input.customConfiguredKeys ?? [])];

  if (!requirements.length) {
    return {
      requiresEnv: false,
      requirements: [],
      httpProxies,
      isOfficial: input.isOfficial,
      presetSupported: false,
      presetConfiguredKeys: [],
      presetMissingRequiredKeys: [],
      presetComplete: false,
      mode: null,
      effectiveDefaultMode: null,
      customConfiguredKeys: [],
      customMissingRequiredKeys: [],
      customComplete: true,
      complete: true,
      missingRequiredKeys: [],
    };
  }

  const requiredKeys = requirements
    .filter(isEnvRequired)
    .map((item) => item.name);
  const presetSupported =
    input.isOfficial &&
    supportsPlatformPreset({ env: requirements, httpProxies });
  const presetSet = new Set(presetConfiguredKeys);
  const customSet = new Set(customConfiguredKeys);

  const presetMissingRequiredKeys = presetSupported
    ? requiredKeys.filter((key) => !presetSet.has(key))
    : requiredKeys;
  const presetComplete =
    presetSupported && presetMissingRequiredKeys.length === 0;

  const customMissingRequiredKeys = requiredKeys.filter(
    (key) => !customSet.has(key),
  );
  const customComplete = customMissingRequiredKeys.length === 0;

  const normalizedMode = normalizePluginEnvSourceMode(input.installedMode);
  const effectiveDefaultMode: PluginEnvSourceMode = presetComplete
    ? "platform_preset"
    : "custom";

  if (normalizedMode === "platform_preset") {
    return {
      requiresEnv: true,
      requirements,
      httpProxies,
      isOfficial: input.isOfficial,
      presetSupported,
      presetConfiguredKeys,
      presetMissingRequiredKeys,
      presetComplete,
      mode: "platform_preset",
      effectiveDefaultMode,
      customConfiguredKeys,
      customMissingRequiredKeys,
      customComplete,
      complete: presetComplete,
      missingRequiredKeys: presetMissingRequiredKeys,
    };
  }

  if (normalizedMode === "custom") {
    return {
      requiresEnv: true,
      requirements,
      httpProxies,
      isOfficial: input.isOfficial,
      presetSupported,
      presetConfiguredKeys,
      presetMissingRequiredKeys,
      presetComplete,
      mode: "custom",
      effectiveDefaultMode,
      customConfiguredKeys,
      customMissingRequiredKeys,
      customComplete,
      complete: customComplete,
      missingRequiredKeys: customMissingRequiredKeys,
    };
  }

  return {
    requiresEnv: true,
    requirements,
    httpProxies,
    isOfficial: input.isOfficial,
    presetSupported,
    presetConfiguredKeys,
    presetMissingRequiredKeys,
    presetComplete,
    mode: null,
    effectiveDefaultMode,
    customConfiguredKeys,
    customMissingRequiredKeys,
    customComplete,
    complete: presetComplete,
    missingRequiredKeys: presetSupported
      ? presetMissingRequiredKeys
      : requiredKeys,
  };
}
