import "server-only";
import { request as http } from "node:http";
import { request as https } from "node:https";
import type { IncomingMessage } from "node:http";
import { addresses } from "@/lib/a2a/remote-network";
export type ResourceResponse = {
  status: number;
  headers: Headers;
  text: string;
};
/** One hop. Only a validated IP can be selected by the socket, including on redirects. */
export async function pinnedGet(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ResourceResponse> {
  const pinned = await addresses(url.hostname.replace(/^\[|\]$/g, ""), signal);
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const req = (url.protocol === "https:" ? https : http)(
    url,
    {
      headers,
      signal,
      agent: false,
      maxHeaderSize: 16384,
      family: pinned.family,
      lookup: (_host, opts, cb) =>
        opts.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
    },
    resolve,
  );
  req.once("error", reject);
  req.end();
  const res = await promise;
  try {
    const status = res.statusCode ?? 0;
    const responseHeaders = new Headers();
    for (const key of [
      "location",
      "retry-after",
      "x-ratelimit-reset",
      "x-rate-limit-reset",
      "x-ratelimit-remaining",
    ]) {
      const value = res.headers[key];
      if (typeof value === "string") responseHeaders.set(key, value);
    }
    let text = "";
    if (status >= 200 && status < 300) {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of res) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new InvalidResponse();
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks, size).toString("utf8");
    }
    return { status, headers: responseHeaders, text };
  } finally {
    res.destroy();
  }
}
export class InvalidResponse extends Error {}
