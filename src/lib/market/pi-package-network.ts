import "server-only";
import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { publicRemoteAddress } from "@/lib/a2a/remote-network";
import { MarketError } from "@/lib/market/skills";
import type { MarketErrorCode } from "@/lib/market/skills";

export type PiSourceAuthentication = { url: string; authorization: string };
export const PI_PUBLIC_REGISTRY = "https://registry.npmjs.org/";
export function sourceError(
  code: MarketErrorCode = "source_unavailable",
): MarketError {
  return new MarketError(
    code,
    "The package source request could not be completed safely.",
  );
}
export function piSourceUrl(raw: string): URL {
  try {
    if (
      typeof raw !== "string" ||
      raw.length > 2048 ||
      /[^\x21-\uFFFF]|[\x7f\\]/.test(raw)
    )
      throw sourceError();
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== "443")
    )
      throw sourceError();
    const path = decodeURIComponent(url.pathname);
    if (
      /[^\x21-\uFFFF]|[\\\x7f%]/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw sourceError();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !publicRemoteAddress(host)) throw sourceError();
    return url;
  } catch {
    throw sourceError("source_invalid");
  }
}
export function sourceAuthorization(
  url: URL,
  authentication?: PiSourceAuthentication,
): string | undefined {
  if (!authentication) return undefined;
  const scope = piSourceUrl(authentication.url);
  const path = decodeURIComponent(url.pathname);
  const prefix = decodeURIComponent(scope.pathname).replace(/\/$/, "");
  if (
    url.origin !== scope.origin ||
    !(path === prefix || path.startsWith(`${prefix}/`))
  )
    return undefined;
  if (
    !/^(?:Bearer|Basic) [\x21-\x7e]{1,8192}$/.test(authentication.authorization)
  )
    throw sourceError("source_credentials_invalid");
  return authentication.authorization;
}
/** No redirects, cookies or ambient proxy credentials. DNS is checked in full and pinned for TLS. */
export async function piSourceRequest(
  url: URL,
  options: {
    authentication?: PiSourceAuthentication;
    method?: "GET" | "PUT";
    body?: Buffer;
    maxBytes?: number;
    accept?: string;
  } = {},
): Promise<Buffer> {
  const checked = piSourceUrl(url.origin + url.pathname);
  checked.search = url.search;
  try {
    const host = checked.hostname.replace(/^\[|\]$/g, "");
    const addresses = await Promise.race([
      isIP(host)
        ? Promise.resolve([{ address: host, family: isIP(host) }])
        : lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(sourceError()), 15_000);
        timer.unref();
      }),
    ]);
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some((item) => !publicRemoteAddress(item.address))
    )
      throw sourceError("source_network_blocked");
    const authorization = sourceAuthorization(checked, options.authentication);
    return await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        checked,
        {
          method: options.method ?? "GET",
          agent: false,
          family: addresses[0].family,
          lookup: (_hostname, _options, callback) =>
            callback(null, addresses[0].address, addresses[0].family),
          headers: {
            accept: options.accept ?? "application/json",
            ...(authorization ? { authorization } : {}),
            ...(options.body
              ? {
                  "content-type": "application/json",
                  "content-length": String(options.body.length),
                }
              : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.destroy();
            reject(
              sourceError(
                status === 401 || status === 403
                  ? "source_auth_failed"
                  : status === 404
                    ? "source_not_found"
                    : status === 409
                      ? "registry_version_conflict"
                      : status >= 300 && status < 400
                        ? "source_redirect_blocked"
                        : "source_unavailable",
              ),
            );
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > (options.maxBytes ?? 2 * 1024 * 1024)) {
              response.destroy();
              req.destroy(sourceError("source_response_too_large"));
            } else chunks.push(chunk);
          });
          response.once("error", () => reject(sourceError()));
          response.once("end", () => resolve(Buffer.concat(chunks, size)));
        },
      );
      const timer = setTimeout(() => req.destroy(sourceError()), 30_000);
      req.once("close", () => clearTimeout(timer));
      req.once("error", (error) =>
        reject(error instanceof MarketError ? error : sourceError()),
      );
      req.end(options.body);
    });
  } catch (error) {
    throw error instanceof MarketError ? error : sourceError();
  }
}
