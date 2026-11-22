import "server-only";
import { RemoteA2AError } from "@/lib/a2a/remote-network";
import {
  type ConnectionConfig,
  ConnectionError,
  permitsHost,
  webUrl,
  atPath,
} from "./config";
import { pinnedGet, InvalidResponse } from "./pinned-get";

export type RequestAuth = {
  config: ConnectionConfig;
  authType: string;
  secrets: Record<string, string>;
};

/** Never return a request URL: query authentication can put a secret in it. */
export async function getResource(
  raw: string,
  auth?: RequestAuth,
  signal = AbortSignal.timeout(30_000),
) {
  try {
    let url = new URL(webUrl.parse(raw));
    for (let hop = 0; hop <= 5; hop++) {
      const headers: Record<string, string> = {
        "user-agent": "ToolPlane",
        "accept-encoding": "identity",
        accept: "*/*",
      };
      let encoded: string | undefined;
      if (auth) {
        const { config, authType, secrets } = auth;
        if (!permitsHost(config, url))
          throw new ConnectionError("ACCOUNT_CONNECTION_NETWORK_BLOCKED");
        const token =
          authType === "oauth2" ? secrets.accessToken : secrets.value;
        if (!token) throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
        switch (authType) {
          case "header":
            if (!config.headerName)
              throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
            headers[config.headerName] = token;
            break;
          case "query":
            if (!config.queryName)
              throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
            url.searchParams.set(config.queryName, token);
            encoded = new URLSearchParams({ v: token }).toString().slice(2);
            break;
          case "basic":
            if (!config.username)
              throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
            encoded = Buffer.from(`${config.username}:${token}`).toString(
              "base64",
            );
            headers.authorization = `Basic ${encoded}`;
            break;
          case "bearer":
          case "oauth2":
            headers.authorization = `Bearer ${token}`;
            break;
          default:
            throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
        }
      }
      const response = await pinnedGet(url, headers, signal);
      const location = response.headers.get("location");
      if (location && [301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(webUrl.parse(new URL(location, url).href));
        if (auth && next.origin !== url.origin)
          throw new ConnectionError("ACCOUNT_CONNECTION_NETWORK_BLOCKED");
        url = next;
        continue;
      }
      if (
        auth &&
        [...Object.values(auth.secrets), encoded].some(
          (s) => s && response.text.includes(s),
        )
      )
        throw new InvalidResponse();
      return response;
    }
  } catch (e) {
    if (e instanceof ConnectionError || e instanceof InvalidResponse) throw e;
    if (e instanceof RemoteA2AError && e.code === "NETWORK_BLOCKED")
      throw new ConnectionError("ACCOUNT_CONNECTION_NETWORK_BLOCKED");
  }
  throw new ConnectionError("ACCOUNT_CONNECTION_UNREACHABLE");
}
export async function testResource(auth: RequestAuth) {
  const { testUrl, accountPath } = auth.config;
  if (!testUrl) return null;
  try {
    const response = await getResource(testUrl, auth);
    if ([401, 403].includes(response.status))
      throw new ConnectionError("ACCOUNT_CONNECTION_AUTH_FAILED");
    if (response.status < 200 || response.status >= 300)
      throw new ConnectionError("ACCOUNT_CONNECTION_UNREACHABLE");
    if (!accountPath) return null;
    const value = atPath(JSON.parse(response.text), accountPath);
    if (typeof value !== "string" && typeof value !== "number")
      throw new InvalidResponse();
    const label = String(value).trim().slice(0, 256);
    if (
      !label ||
      Object.values(auth.secrets).some((s) => s && label.includes(s))
    )
      throw new InvalidResponse();
    return label;
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    throw new ConnectionError("ACCOUNT_CONNECTION_UNREACHABLE");
  }
}
