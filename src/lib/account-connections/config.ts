import "server-only";
import { z } from "zod";

export type ConnectionErrorCode =
  | "INVALID_ACCOUNT_CONNECTION"
  | "ACCOUNT_CONNECTION_IN_USE"
  | "ACCOUNT_CONNECTION_AUTH_FAILED"
  | "ACCOUNT_CONNECTION_UNREACHABLE"
  | "ACCOUNT_CONNECTION_NETWORK_BLOCKED"
  | "ACCOUNT_CONNECTION_OAUTH_FAILED"
  | "ACCOUNT_CONNECTION_OAUTH_DENIED"
  | "ACCOUNT_CONNECTION_OAUTH_EXPIRED"
  | "ACCOUNT_CONNECTION_EXPIRED";
export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    readonly status = 422,
  ) {
    super(code);
  }
}
export const invalidInput = () =>
  new ConnectionError("INVALID_ACCOUNT_CONNECTION", 400);

export const webUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    if (!/^https?:\/\//i.test(raw) || /[\s\\]/u.test(raw) || !URL.canParse(raw))
      return false;
    const url = new URL(raw);
    return !url.username && !url.password && url.port !== "0";
  });
const httpsUrl = webUrl.refine(
  (s) => /^https:\/\//i.test(s) && !s.includes("#"),
);
const host = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  )
  .refine(
    (s) =>
      URL.canParse(`https://${s}`) && new URL(`https://${s}`).hostname === s,
  );
export const fieldPath = z
  .string()
  .min(1)
  .max(256)
  .refine((v) =>
    v
      .split(".")
      .every(
        (part) =>
          /^[\w-]+$/.test(part) &&
          !["__proto__", "constructor", "prototype"].includes(part),
      ),
  );
export function atPath(value: unknown, path: string): unknown {
  if (!path) return value;
  for (const key of path.split(".")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const tokenName = z
  .string()
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~\w-]+$/);
const headerName = tokenName.refine(
  (s) =>
    !Object.hasOwn(Object.prototype, s.toLowerCase()) &&
    !/^(?:host|authorization|cookie2?|set-cookie|content-.*|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|forwarded|x-forwarded-.*|expect|origin|referer|user-agent|accept-encoding|sec-.*|via|range|accept)$/i.test(
      s,
    ),
);
const paramAllowed = (s: string) =>
  !/^(?:response_type|client_id|redirect_uri|state|code_challenge.*|scope|client_secret|access_token|refresh_token|request|request_uri|response_mode)$/i.test(
    s,
  );
const authorizationUrl = httpsUrl.refine(
  (s) =>
    URL.canParse(s) &&
    Array.from(new URL(s).searchParams.keys()).every(paramAllowed),
);
const boundedText = z.string().trim().min(1).max(1024);
const oauthSchema = z.strictObject({
  authorizationUrl,
  tokenUrl: httpsUrl,
  clientId: boundedText,
  scopes: z.array(boundedText).max(50),
  extraParams: z.record(tokenName.refine(paramAllowed), z.string().max(2048)),
  clientAuth: z.enum(["body", "basic"]),
});
export const configSchema = z.strictObject({
  allowedHosts: z.array(host).min(1).max(10),
  headerName: headerName.optional(),
  queryName: tokenName.optional(),
  username: boundedText.refine((s) => !s.includes(":")).optional(),
  testUrl: httpsUrl.optional(),
  accountPath: fieldPath.optional(),
  oauth: oauthSchema.optional(),
});
export type ConnectionConfig = z.infer<typeof configSchema>;
export const inputSchema = configSchema.extend({
  name: z.string().trim().min(1).max(80),
  preset: z.enum(["github", "x", "google", "custom"]),
  authType: z.enum(["bearer", "header", "query", "basic", "oauth2"]),
  secret: z
    .string()
    .max(8192)
    .regex(/^[!-~]*$/)
    .optional(),
});
export type ConnectionInput = z.infer<typeof inputSchema>;
export function permitsHost(
  config: Pick<ConnectionConfig, "allowedHosts">,
  url: URL,
) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    config.allowedHosts.includes(url.hostname)
  );
}
export function connectionConfig(input: ConnectionInput): ConnectionConfig {
  const {
    name: _name,
    preset: _preset,
    secret: _secret,
    authType,
    ...config
  } = input;
  if (
    (authType === "header") !== !!config.headerName ||
    (authType === "query") !== !!config.queryName ||
    (authType === "basic") !== !!config.username ||
    (authType === "oauth2") !== !!config.oauth ||
    (config.accountPath && !config.testUrl) ||
    (config.testUrl && !permitsHost(config, new URL(config.testUrl)))
  )
    throw invalidInput();
  return config;
}
