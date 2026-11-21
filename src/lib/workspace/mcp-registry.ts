import "server-only";
import { z } from "zod";
import { fetchPublicWebText } from "@/lib/a2a/remote-network";
import { isValidMcpRef } from "./custom-mcp";
import {
  analyzeEntry,
  analyzePreset,
  presetForRemoteUrl,
  IntakeError,
  type IntakeEntry,
} from "./mcp-intake";
import type {
  McpRegistryItem,
  McpRegistrySearchResult,
} from "./mcp-intake-types";

const base = "https://registry.modelcontextprotocol.io/v0.1/servers";
const text = z.string().max(16000);
const variable = z.object({
  description: text.optional(),
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  default: text.optional(),
  choices: z.array(text).max(100).optional(),
});
const input = variable.extend({
  name: text.min(1),
  value: text.optional(),
  variables: z.record(z.string(), variable).optional(),
});
const remote = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: text,
  headers: z.array(input).max(32).default([]),
});
const argument = z.object({
  type: z.enum(["positional", "named"]),
  name: text.optional(),
  value: text.optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  isSecret: z.boolean().optional(),
});
const pkg = z.object({
  registryType: z.enum(["npm", "pypi", "oci"]),
  identifier: text,
  version: text.optional(),
  registryBaseUrl: text.optional(),
  transport: z.object({ type: z.literal("stdio") }).optional(),
  runtimeArguments: z.array(argument).default([]),
  packageArguments: z.array(argument).default([]),
  environmentVariables: z.array(input).max(100).default([]),
});
const serverSchema = z.object({
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(128),
  title: text.optional(),
  description: text.optional(),
  websiteUrl: text.optional(),
  repository: z.object({ url: text }).optional(),
  remotes: z.array(z.unknown()).default([]),
  packages: z.array(z.unknown()).default([]),
});
const envelope = z.object({ server: serverSchema });
type Server = z.infer<typeof serverSchema>;
function unsupported(): never {
  throw new IntakeError("unsupportedRegistryEntry");
}
function fields(entry: IntakeEntry, inputs: z.infer<typeof input>[]) {
  for (const field of entry.draft.fields) {
    const spec = inputs.find((input) => input.name === field.label);
    if (!spec) unsupported();
    const variableName = /\{([^{}]+)\}/.exec(spec.value ?? "")?.[1];
    const info = {
      ...spec,
      ...(variableName && spec.variables?.[variableName]),
    };
    field.secret = info.isSecret ?? entry.draft.kind === "remote";
    field.required =
      info.isRequired ?? spec.name.toLowerCase() === "authorization";
    if (info.description) field.description = info.description.slice(0, 300);
    if (!field.secret) {
      if (info.default !== undefined) field.default = info.default;
      if (info.choices) field.choices = info.choices;
    }
  }
  return entry;
}
function mapRemote(title: string, recipe: z.infer<typeof remote>) {
  if (/[{}?]|%7[bd]/i.test(recipe.url)) unsupported();
  const preset = presetForRemoteUrl(recipe.url);
  if (preset) return analyzePreset(preset.id, "registry");
  const headers = Object.fromEntries(
    recipe.headers.map((header) => {
      const authorization = header.name.toLowerCase() === "authorization";
      const template = /^(Bearer\s+)?\{([\w-]+)\}$/i.exec(header.value ?? "");
      if (!template && /[{}]/.test(header.value ?? "")) unsupported();
      if (!template && header.value) return [header.name, header.value];
      const defaultKey = authorization
        ? "MCP_BEARER_TOKEN"
        : `MCP_${header.name}`;
      const key = (template?.[2] ?? defaultKey)
        .toUpperCase()
        .replace(/\W/g, "_");
      const scheme =
        authorization && (template?.[1] || !header.value) ? "Bearer " : "";
      return [header.name, `${scheme}\${${key}}`];
    }),
  );
  if (Object.keys(headers).length !== recipe.headers.length) unsupported();
  const entry = analyzeEntry(
    { url: recipe.url, type: recipe.type, headers },
    title,
    "registry",
  );
  return fields(entry, recipe.headers);
}

function packageLaunch(recipe: z.infer<typeof pkg>) {
  const { identifier, registryType, registryBaseUrl, version } = recipe;
  if (registryType === "oci") {
    const pinnedImage =
      /(?:@sha256:[0-9a-f]{64}|:v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;
    if (
      !isValidMcpRef("docker", identifier) ||
      !pinnedImage.test(identifier) ||
      recipe.runtimeArguments.length
    )
      unsupported();
    return { command: "docker", args: ["run", "-i", "--rm", identifier] };
  }
  const npm = registryType === "npm";
  const officialRegistry = npm
    ? /^https:\/\/registry\.npmjs\.org\/?$/
    : /^https:\/\/pypi\.org(?:\/simple)?\/?$/;
  if (registryBaseUrl && !officialRegistry.test(registryBaseUrl)) unsupported();
  for (const argument of recipe.runtimeArguments) {
    if (
      !npm ||
      argument.type !== "positional" ||
      argument.value !== "-y" ||
      argument.variables
    )
      unsupported();
  }
  const reference = `${identifier}${npm ? "@" : "=="}${version}`;
  if (!version || !isValidMcpRef(registryType, reference)) unsupported();
  return npm
    ? { command: "npx", args: ["-y", reference] }
    : { command: "uvx", args: [reference] };
}

function mapPackage(title: string, recipe: z.infer<typeof pkg>) {
  const { command, args } = packageLaunch(recipe);
  for (const argument of recipe.packageArguments) {
    if (
      argument.variables ||
      argument.isSecret ||
      /[{}]/.test(`${argument.value ?? ""}${argument.name ?? ""}`)
    )
      unsupported();
    if (argument.type === "named") {
      if (!argument.name?.startsWith("-")) unsupported();
      args.push(argument.name);
    } else if (!argument.value) unsupported();
    if (argument.value !== undefined) args.push(argument.value);
  }
  const env = Object.fromEntries(
    recipe.environmentVariables.map((variable) => {
      if (variable.variables || /[{}]/.test(variable.value ?? ""))
        unsupported();
      return [variable.name, variable.value ?? ""];
    }),
  );
  if (Object.keys(env).length !== recipe.environmentVariables.length)
    unsupported();
  return fields(
    analyzeEntry({ command, args, env }, title, "registry"),
    recipe.environmentVariables,
  );
}

function mapServer(server: Server) {
  const title = (
    server.title ??
    server.name.split("/").at(-1) ??
    server.name
  ).slice(0, 80);
  for (const candidate of server.remotes) {
    const parsed = remote.safeParse(candidate);
    if (!parsed.success) continue;
    try {
      return mapRemote(title, parsed.data);
    } catch {
      /* Try another complete recipe. */
    }
  }
  for (const candidate of server.packages) {
    const parsed = pkg.safeParse(candidate);
    if (!parsed.success) continue;
    try {
      return mapPackage(title, parsed.data);
    } catch {
      /* Never install a partially mapped package. */
    }
  }
  return unsupported();
}
export function mapRegistryRecord(record: unknown) {
  const parsed = envelope.safeParse(record);
  if (!parsed.success) unsupported();
  const entry = mapServer(parsed.data.server);
  entry.draft.registryName = parsed.data.server.name;
  return entry;
}
async function get(url: URL) {
  const res = await fetchPublicWebText(url.href, AbortSignal.timeout(6000));
  return JSON.parse(res.text) as unknown;
}
function safeLink(value?: string) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function item(server: Server): McpRegistryItem {
  const kinds = new Set<McpRegistryItem["kinds"][number]>();
  if (server.remotes.length) kinds.add("remote");
  for (const candidate of server.packages) {
    const parsed = pkg.safeParse(candidate);
    if (parsed.success) kinds.add(parsed.data.registryType);
  }
  let supported = true;
  try {
    mapServer(server);
  } catch {
    supported = false;
  }
  return {
    name: server.name,
    version: server.version,
    title: (server.title ?? server.name.split("/").at(-1) ?? server.name).slice(
      0,
      300,
    ),
    description: server.description?.slice(0, 300) ?? "",
    websiteUrl: safeLink(server.websiteUrl),
    repositoryUrl: safeLink(server.repository?.url),
    kinds: [...kinds],
    supported,
  };
}
async function search(query: string, cursor?: string) {
  if (
    typeof query !== "string" ||
    query.length > 255 ||
    (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length > 1024))
  )
    throw new IntakeError("registryUnavailable");
  const url = new URL(base);
  url.search = new URLSearchParams({
    search: query,
    limit: "20",
    version: "latest",
    ...(cursor ? { cursor } : {}),
  }).toString();
  return z
    .object({
      servers: z.array(z.unknown()).max(20),
      metadata: z
        .object({ nextCursor: z.string().max(1024).nullish() })
        .optional(),
    })
    .parse(await get(url));
}
export async function searchRegistry(
  query: string,
  cursor?: string,
): Promise<McpRegistrySearchResult> {
  try {
    const result = await search(query, cursor);
    const items = result.servers.flatMap((record) => {
      const parsed = envelope.safeParse(record);
      return parsed.success ? [item(parsed.data.server)] : [];
    });
    const term = query.trim().toLowerCase();
    const rank = (item: McpRegistryItem) =>
      item.name.split("/")[0].toLowerCase().split(".").includes(term)
        ? 0
        : item.title.toLowerCase() === term
          ? 1
          : 2;
    items.sort((a, b) => rank(a) - rank(b));
    return { ok: true, items, nextCursor: result.metadata?.nextCursor ?? null };
  } catch {
    return { ok: false, error: "registryUnavailable" };
  }
}
export async function registryEntry(name: string, version: string) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ||
    name.length > 255 ||
    typeof version !== "string" ||
    !/^[\w+-][\w.+-]{0,127}$/.test(version) ||
    version === "latest"
  )
    unsupported();
  let server: Server | undefined;
  try {
    const url = new URL(
      `${base}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    );
    server = envelope.parse(await get(url)).server;
  } catch {
    try {
      const result = await search(name);
      server = result.servers
        .map((record) => envelope.safeParse(record).data?.server)
        .find(
          (candidate) =>
            candidate?.name === name && candidate.version === version,
        );
    } catch {
      throw new IntakeError("registryUnavailable");
    }
  }
  if (!server || server.name !== name || server.version !== version)
    throw new IntakeError("registryUnavailable");
  return mapRegistryRecord({ server });
}
