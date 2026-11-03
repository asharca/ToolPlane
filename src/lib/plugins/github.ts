import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { safeSkillFilePath } from "@/lib/skills/bundle";

export class GithubRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GithubRegistryError";
  }
  get status() {
    return this.code === "not_authorized"
      ? 403
      : this.code === "registry_not_found"
        ? 404
        : /conflict|already_registered/.test(this.code)
          ? 409
          : 400;
  }
}
export const repositorySchema = z
  .string()
  .max(201)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/,
  )
  .refine((value) => !value.endsWith(".git") && !value.endsWith("/.."));
export const branchSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f) return false;
    }
    return (
      !/[~^:?*[\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every(
          (part) => part && !part.startsWith(".") && !part.endsWith(".lock"),
        )
    );
  });
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => safeSkillFilePath(value) === value);
const pluginEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    path: z.union([z.literal(""), pathSchema]),
  })
  .strict();
const indexSchema = z
  .object({
    schemaVersion: z.literal(3),
    plugins: z.array(pluginEntrySchema).max(200),
  })
  .strict();
export type GithubRegistryEntry = z.infer<typeof pluginEntrySchema>;
export function parseGithubRegistryIndex(raw: unknown) {
  if (
    raw &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    raw.schemaVersion === 2
  )
    throw new GithubRegistryError("registry_index_v2_unsupported");
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) throw new GithubRegistryError("registry_index_invalid");
  const plugins = parsed.data.plugins;
  if (
    new Set(plugins.map((entry) => entry.id)).size !== plugins.length ||
    new Set(plugins.map((entry) => entry.path.normalize("NFC").toLowerCase()))
      .size !== plugins.length
  )
    throw new GithubRegistryError("registry_index_invalid");
  return { schemaVersion: 3 as const, plugins };
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_BYTES = 64 * 1024 * 1024;
const treeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: commitSchema,
  size: z.number().int().nonnegative().optional(),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(treeEntrySchema).max(100_000),
});
type TreeEntry = z.infer<typeof treeEntrySchema>;

async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum)
    throw new GithubRegistryError("github_response_too_large");
  if (!response.body) throw new GithubRegistryError("github_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new GithubRegistryError("github_response_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// Construct all API requests here; credentials never follow arbitrary redirects.
export class GithubRegistryTransport {
  private bytes = 0;
  private trees = new Map<string, TreeEntry[]>();
  private privacy = new Map<string, boolean>();
  constructor(
    private readonly credentialRepository: string,
    private readonly token: string | undefined,
    private readonly visibility: string,
  ) {}
  private async json(
    repository: string,
    suffix: string,
    maximum = MAX_RESPONSE_BYTES,
  ): Promise<unknown> {
    if (!repositorySchema.safeParse(repository).success)
      throw new GithubRegistryError("github_repository_invalid");
    const credential =
      repository.toLowerCase() === this.credentialRepository.toLowerCase()
        ? this.token
        : undefined;
    const url = `https://api.github.com/repos/${repository}${suffix ? `/${suffix}` : ""}`;
    const endpoint = new URL(url);
    const request: RequestInit = {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "toolplane-resource-registry",
        "x-github-api-version": "2022-11-28",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    };
    let response: Response;
    try {
      response = await fetch(url, request);
      if (response.status === 301 || response.status === 308) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new GithubRegistryError("github_request_failed");
        const target = new URL(location, url);
        const repositoryPath = target.pathname.match(
          /^\/repositories\/[1-9]\d*/,
        )?.[0];
        // GitHub renames redirect to an immutable repository ID on the same API.
        // Keep the exact endpoint and never forward credentials to another host.
        if (
          target.origin !== "https://api.github.com" ||
          target.username ||
          target.password ||
          target.search !== endpoint.search ||
          target.hash ||
          !repositoryPath ||
          target.pathname !==
            `${repositoryPath}${endpoint.pathname.slice(`/repos/${repository}`.length)}`
        )
          throw new GithubRegistryError("github_request_failed");
        response = await fetch(target.href, { ...request, redirect: "error" });
      }
    } catch {
      throw new GithubRegistryError("github_request_failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GithubRegistryError(
        response.status === 401 || response.status === 403
          ? "github_access_denied"
          : response.status === 404
            ? "github_not_found"
            : "github_request_failed",
      );
    }
    const body = await boundedBody(response, maximum);
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new GithubRegistryError("github_response_invalid");
    }
  }
  async assertAccess(repository: string) {
    if (!this.privacy.has(repository)) {
      const parsed = z
        .object({ private: z.boolean() })
        .safeParse(await this.json(repository, "", 64 * 1024));
      if (!parsed.success)
        throw new GithubRegistryError("github_response_invalid");
      this.privacy.set(repository, parsed.data.private);
    }
    if (this.visibility === "public" && this.privacy.get(repository))
      throw new GithubRegistryError(
        "private_repository_requires_private_visibility",
      );
  }
  async resolveCommit(repository: string, branch: string) {
    const parsed = z
      .object({ sha: commitSchema })
      .safeParse(
        await this.json(
          repository,
          `commits/${encodeURIComponent(branch)}`,
          256 * 1024,
        ),
      );
    if (!parsed.success) throw new GithubRegistryError("github_commit_invalid");
    return parsed.data.sha;
  }
  private async tree(repository: string, commit: string) {
    const key = `${repository}@${commit}`;
    const cached = this.trees.get(key);
    if (cached) return cached;
    if (!commitSchema.safeParse(commit).success)
      throw new GithubRegistryError("github_commit_invalid");
    await this.assertAccess(repository);
    const parsed = treeSchema.safeParse(
      await this.json(repository, `git/trees/${commit}?recursive=1`),
    );
    if (!parsed.success || parsed.data.truncated)
      throw new GithubRegistryError("github_tree_incomplete");
    this.trees.set(key, parsed.data.tree);
    return parsed.data.tree;
  }
  private async blob(repository: string, commit: string, entry: TreeEntry) {
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      entry.size === undefined ||
      entry.size > MAX_FILE_BYTES
    )
      throw new GithubRegistryError("github_file_unsafe");
    let data: Buffer;
    if (this.privacy.get(repository) === false) {
      // Raw public downloads do not spend the unauthenticated API quota, and never receive a token.
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      let response: Response;
      try {
        response = await fetch(
          `https://raw.githubusercontent.com/${repository}/${commit}/${path}`,
          {
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch {
        throw new GithubRegistryError("github_request_failed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GithubRegistryError("github_request_failed");
      }
      data = await boundedBody(response, MAX_FILE_BYTES);
    } else {
      // Private blobs stay on api.github.com; credentials are scoped to the registered repository.
      const parsed = z
        .object({
          encoding: z.literal("base64"),
          content: z
            .string()
            .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 200_000),
          size: z.number().int().nonnegative(),
          sha: commitSchema,
        })
        .safeParse(
          await this.json(
            repository,
            `git/blobs/${entry.sha}`,
            6 * 1024 * 1024,
          ),
        );
      if (!parsed.success) throw new GithubRegistryError("github_blob_invalid");
      data = Buffer.from(parsed.data.content.replace(/\n/g, ""), "base64");
      if (data.length !== parsed.data.size || parsed.data.sha !== entry.sha)
        throw new GithubRegistryError("github_blob_invalid");
    }
    const sha = createHash("sha1")
      .update(`blob ${data.length}\0`)
      .update(data)
      .digest("hex");
    if (data.length !== entry.size || sha !== entry.sha)
      throw new GithubRegistryError("github_blob_invalid");
    this.bytes += data.length;
    if (this.bytes > MAX_SYNC_BYTES)
      throw new GithubRegistryError("registry_too_large");
    return data;
  }
  async index(repository: string, commit: string) {
    const entry = (await this.tree(repository, commit)).find(
      (item) => item.path === "registry.json",
    );
    if (!entry) {
      const root = (await this.tree(repository, commit)).find(
        (item) => item.path === "package.json",
      );
      if (!root) throw new GithubRegistryError("registry_index_invalid");
      const pkg = z
        .object({ name: z.string().min(1) })
        .parse(parseJsonFile(await this.blob(repository, commit, root)));
      const id = pkg.name
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/, "");
      return parseGithubRegistryIndex({
        schemaVersion: 3,
        plugins: [{ id, path: "" }],
      });
    }
    if ((entry.size ?? Infinity) > 256 * 1024)
      throw new GithubRegistryError("registry_index_invalid");
    return parseGithubRegistryIndex(
      parseJsonFile(await this.blob(repository, commit, entry)),
    );
  }
  async directory(repository: string, commit: string, path: string) {
    if (path !== "" && !pathSchema.safeParse(path).success)
      throw new GithubRegistryError("github_path_invalid");
    const tree = await this.tree(repository, commit);
    const entries =
      path === ""
        ? tree
        : tree.filter((entry) => entry.path.startsWith(`${path}/`));
    if (!entries.length || entries.length > 10_000)
      throw new GithubRegistryError("github_directory_invalid");
    const seen = new Set<string>();
    const files: { path: string; data: Buffer; executable: boolean }[] = [];
    let bytes = 0;
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const relative =
        path === "" ? entry.path : entry.path.slice(path.length + 1);
      const key = relative.normalize("NFC").toLowerCase();
      if (safeSkillFilePath(relative) !== relative || seen.has(key))
        throw new GithubRegistryError("github_path_invalid");
      seen.add(key);
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new GithubRegistryError("github_symlink_or_submodule_forbidden");
      bytes += entry.size ?? MAX_DIRECTORY_BYTES + 1;
      if (bytes > MAX_DIRECTORY_BYTES)
        throw new GithubRegistryError("github_directory_too_large");
      files.push({
        path: relative,
        data: await this.blob(repository, commit, entry),
        executable: entry.mode === "100755",
      });
    }
    return files;
  }
}
export function parseJsonFile(data: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubRegistryError("registry_json_invalid");
  }
}
