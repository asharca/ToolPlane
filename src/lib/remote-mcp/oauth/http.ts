import "server-only";
import { request as https } from "node:https";
import { request as http, type IncomingMessage } from "node:http";
import { addresses } from "@/lib/a2a/remote-network";
import type { PrivateHostsPolicy } from "../../../../scripts/remote-mcp-private-hosts.mjs";
import { checkedUrl, OAuthFailure } from "./protocol";

/** One bounded, DNS-pinned request, no cookie jar, redirects or inherited credentials. */
export async function oauthRequest(
  target: string,
  options: {
    privateHosts?: PrivateHostsPolicy | null;
    allowHttp?: boolean;
    headersOnly?: boolean;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
) {
  const url = checkedUrl(target, options.allowHttp);
  const signal = options.signal ?? AbortSignal.timeout(8000);
  const pinned = await addresses(
    url.hostname.replace(/^\[|\]$/g, ""),
    signal,
    options.privateHosts,
  );
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const req = (url.protocol === "https:" ? https : http)(
    url,
    {
      signal,
      agent: false,
      maxHeaderSize: 16384,
      method: options.body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...options.headers },
      family: pinned.family,
      lookup: (_host, opts, cb) => {
        if (opts.all) cb(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      },
    },
    resolve,
  );
  req.once("error", reject);
  req.end(options.body);
  const response = await promise;
  const status = response.statusCode ?? 0;
  const challenge = response.headers["www-authenticate"];
  let data: Record<string, unknown> = {};
  try {
    if (!options.headersOnly && status >= 200 && status < 300) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 64 * 1024) throw new OAuthFailure("oauthDiscoveryFailed");
        chunks.push(chunk);
      }
      if (size) {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (value && typeof value === "object" && !Array.isArray(value))
          data = value as typeof data;
      }
    }
    return { status, challenge, data };
  } finally {
    response.destroy();
  }
}
