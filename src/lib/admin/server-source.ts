import "server-only";

export type ServerMetadataSource = "github" | "npm" | "pypi";

const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result.slice(0, maxLength) : null;
}

async function limitedText(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    throw new Error("Source metadata response is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader
          .cancel("Source metadata response exceeded the byte limit")
          .catch(() => undefined);
        throw new Error("Source metadata response is too large.");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: HeadersInit = {},
  optional = false,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(url, {
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Source metadata request failed (${response.status}).`);
  try {
    return record(JSON.parse(await limitedText(response)));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Source metadata response is invalid.");
    throw error;
  }
}

/** Resolve only fixed public registry hosts, with the same bounded metadata transport. */
export async function resolveServerSourceVersion(
  source: ServerMetadataSource,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (source === "npm") {
    const match = /^((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)(?:@([^\s/]+))?$/.exec(
      ref,
    );
    if (!match) throw new Error("Invalid npm package reference.");
    const [, name, selector] = match;
    if (
      selector &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selector)
    )
      return ref;
    const metadata = await requestJson(
      fetchImpl,
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    );
    const version = text(record(metadata?.["dist-tags"])?.latest, 200);
    if (
      !version ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    )
      throw new Error("npm package version is missing.");
    return `${name}@${version}`;
  }
  if (source === "pypi") {
    const match =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9_,.-]+\])?(?:([<>=!~].+))?$/.exec(
        ref,
      );
    if (!match) throw new Error("Invalid PyPI package reference.");
    const [, name, extras = "", selector] = match;
    if (selector && /^==\d[A-Za-z0-9.+!-]*$/.test(selector)) return ref;
    const metadata = await requestJson(
      fetchImpl,
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    );
    const version = text(record(metadata?.info)?.version, 200);
    if (!version || !/^\d[A-Za-z0-9.+!-]*$/.test(version))
      throw new Error("PyPI package version is missing.");
    return `${name}${extras}==${version}`;
  }
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?(?:#([^\s]+))?$/.exec(
      ref,
    );
  if (!match) throw new Error("Invalid GitHub repository reference.");
  const [, owner, repository, revision] = match;
  if (revision && /^[a-fA-F0-9]{40}$/.test(revision)) return ref;
  const repo = repository.replace(/\.git$/, "");
  const token = process.env.GITHUB_TOKEN || process.env.TOOLPLANE_GITHUB_TOKEN;
  const metadata = await requestJson(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(revision || "HEAD")}`,
    {
      accept: "application/vnd.github+json",
      "user-agent": "toolplane-mcp-metadata",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  );
  const sha = metadata?.sha;
  if (typeof sha !== "string" || !/^[a-fA-F0-9]{40}$/.test(sha))
    throw new Error("GitHub commit is missing.");
  return `https://github.com/${owner}/${repo}#${sha}`;
}
