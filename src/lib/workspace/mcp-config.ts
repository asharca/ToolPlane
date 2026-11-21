import "server-only";
import { diffLines } from "diff";
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  visit,
  type Node,
  type ParseError,
} from "jsonc-parser";
import {
  isSensitiveArgName,
  serializedArgs,
  serializeMcpDeploymentConfig,
} from "./custom-mcp";

const refPattern = /^\$\{([A-Za-z_]\w*)\}$/;
export const variableKey = (key: string) =>
  /^[A-Za-z_]\w*$/.test(key) && !(key in Object.prototype);
export const reference = (key: string) => `\${${key}}`;
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function invalid(): never {
  throw new Error("invalidConfig");
}
function tree(text: string) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536) invalid();
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (root?.type !== "object" || errors.length) invalid();
  function validate(node: Node, depth: number) {
    if (depth > 40) invalid();
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const prop of node.children ?? []) {
        if (prop.children?.length !== 2) invalid();
        const [key, value] = prop.children;
        if (keys.has(key.value) || key.value in Object.prototype) invalid();
        keys.add(key.value);
        validate(value, depth + 1);
      }
    } else if (node.type === "array")
      for (const child of node.children ?? []) validate(child, depth + 1);
  }
  validate(root, 0);
  return root;
}

export function setDocumentProperty(
  document: string,
  path: string[],
  value: unknown,
) {
  return applyEdits(document, modify(document, path, value, {}));
}

/** Slice the entry value, not its siblings or enclosing client's settings. */
export function splitMcpDocument(text: string): McpDocumentEntry[] {
  let root: Node;
  try {
    root = tree(text);
  } catch {
    text = `{${text}}`;
    root = tree(text);
  }
  if (
    ["command", "url", "serverUrl", "type"].some(
      (k) => findNodeAtLocation(root, [k])?.type === "string",
    )
  ) {
    return [
      {
        name: undefined,
        text,
        config: record(getNodeValue(root)),
      },
    ];
  }
  const entries =
    findNodeAtLocation(root, ["mcpServers"]) ??
    findNodeAtLocation(root, ["servers"]) ??
    root;
  if (entries.type !== "object" || !entries.children?.length) invalid();
  return entries.children.map((property) => {
    if (property.children?.length !== 2) invalid();
    const [name, value] = property.children;
    if (value.type !== "object") invalid();
    return {
      name: String(name.value),
      text: text.slice(value.offset, value.offset + value.length),
      config: record(getNodeValue(value)),
    };
  });
}

const placeholder =
  /^(?:\s*|\$\{input:[^}]+\}|<[^>]+>|your_.+|your-.+-(?:key|token)|x{3,}|\.{3})$/i;

function looksLikeCredential(value: string) {
  const token = value.trim();
  if (
    /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|(?:Bearer|Basic)\s+|-----BEGIN .*PRIVATE KEY-----)/i.test(
      token,
    )
  )
    return true;
  if (/^[a-z][\w+.-]*:\/\//i.test(token)) {
    try {
      const url = new URL(token);
      return (
        !!(url.username || url.password) ||
        [...url.searchParams.keys()].some(isSensitiveArgName)
      );
    } catch {
      return true;
    }
  }
  if (token.length < 24 || !/^[A-Za-z0-9+/_=.-]+$/.test(token)) return false;
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const frequency = count / token.length;
    entropy -= frequency * Math.log2(frequency);
  }
  return entropy >= 4 || (/^[a-f0-9]{32,}$/i.test(token) && entropy >= 3);
}
/** Patch token ranges so unchanged keys, whitespace, and comments survive extraction. */
export function normalizeMcpDocument(text: string): NormalizedMcpDocument {
  const root = tree(text);
  const config = record(getNodeValue(root));
  const remote = config.url !== undefined || config.serverUrl !== undefined;
  if (remote && config.command !== undefined) invalid();
  const used = new Set(
    remote
      ? ["type", "url", "serverUrl", "headers", "env"]
      : ["type", "command", "args", "env", "network", "cwd"],
  );
  for (const key of ["env", "headers"])
    if (
      config[key] !== undefined &&
      (!config[key] ||
        typeof config[key] !== "object" ||
        Array.isArray(config[key]))
    )
      invalid();
  for (const path of [config.command, config.cwd])
    if (
      typeof path === "string" &&
      (path.includes("://") || /[\r\n]/.test(path) || path.includes("\0"))
    )
      invalid();
  const ignoredFields = Object.keys(config).filter((key) => !used.has(key));
  const literals: Record<string, string> = Object.create(null);
  const edits: { offset: number; length: number; replacement: string }[] = [];
  const reserved = new Set([
    ...Object.keys(record(config.env)),
    ...Array.from(
      JSON.stringify(config).matchAll(/\$\{([A-Za-z_]\w*)\}/g),
      (match) => match[1],
    ),
  ]);
  function bind(value: string, preferred: string, fixed = false) {
    if (refPattern.test(value)) return value;
    if (!variableKey(preferred) || value.includes("\0") || value.length > 16000)
      invalid();
    let key = preferred;
    for (let n = 2; !fixed && reserved.has(key); n++) key = `${preferred}_${n}`;
    reserved.add(key);
    if (!placeholder.test(value.trim())) {
      if (Object.hasOwn(literals, key) && literals[key] !== value) invalid();
      literals[key] = value;
    }
    return reference(key);
  }
  function environmentValue(key: string, value: string) {
    if (value.length > 16000 || value.includes("\0")) invalid();
    return isSensitiveArgName(key) ||
      /(?:^|_)KEY(?:$|_)/i.test(key) ||
      looksLikeCredential(value) ||
      placeholder.test(value.trim())
      ? bind(value, key, true)
      : value;
  }
  function patch(path: (number | string)[], before: string, after: string) {
    if (before === after) return;
    const node = findNodeAtLocation(root, path);
    if (node?.type !== "string") invalid();
    edits.push({
      offset: node.offset,
      length: node.length,
      replacement: JSON.stringify(after),
    });
  }
  for (const [key, value] of Object.entries(record(config.env))) {
    if (typeof value !== "string" || !variableKey(key)) invalid();
    patch(["env", key], value, environmentValue(key, value));
  }
  for (const [name, value] of Object.entries(record(config.headers))) {
    if (
      typeof value !== "string" ||
      /[\r\n]/.test(value) ||
      value.includes("\0") ||
      value.length > 8185
    )
      invalid();
    const bearer =
      name.toLowerCase() === "authorization" &&
      (/^Bearer(?:\s|$)/i.test(value) || placeholder.test(value));
    const key = bearer
      ? "MCP_BEARER_TOKEN"
      : `MCP_${name.toUpperCase().replace(/\W/g, "_")}`;
    const secret = bearer ? value.replace(/^Bearer(?:\s+|$)/i, "") : value;
    patch(
      ["headers", name],
      value,
      (bearer ? "Bearer " : "") + bind(secret, key),
    );
  }
  if (Array.isArray(config.args)) {
    const args = config.args;
    if (!args.every((arg): arg is string => typeof arg === "string")) invalid();
    const masked = serializedArgs(args);
    for (const [i, arg] of args.entries()) {
      const dockerEnv =
        config.command === "docker" &&
        (arg.startsWith("--env=") || ["-e", "--env"].includes(args[i - 1]));
      const assignment =
        dockerEnv && /^(--env=)?([A-Za-z_]\w*)=([\s\S]*)$/.exec(arg);
      if (assignment) {
        patch(
          ["args", i],
          arg,
          `${assignment[1] ?? ""}${assignment[2]}=${environmentValue(assignment[2], assignment[3])}`,
        );
      } else if (masked[i] !== arg) {
        const prefix = masked[i].endsWith("=********")
          ? arg.slice(0, arg.indexOf("=") + 1)
          : "";
        if (
          /^(?:[A-Za-z0-9-]+:\s*)?(?:(?:Bearer|Basic)\s+)?\$\{[A-Za-z_]\w*\}$/i.test(
            arg.slice(prefix.length),
          )
        )
          continue;
        patch(
          ["args", i],
          arg,
          prefix + bind(arg.slice(prefix.length), `MCP_ARG_${i + 1}`),
        );
      }
    }
  }
  // Client extensions are inert, but credential-shaped fields still must not be published.
  function scrub(
    value: unknown,
    path: (string | number)[],
    sensitive: boolean,
  ) {
    if (typeof value === "string" && sensitive)
      patch(path, value, bind(value, "MCP_CLIENT_SECRET"));
    else if (Array.isArray(value))
      for (const [i, child] of value.entries())
        scrub(child, [...path, i], sensitive);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value))
        scrub(
          v,
          [...path, k],
          sensitive || isSensitiveArgName(k) || k === "headers" || k === "env",
        );
    else if (sensitive && value != null && typeof value !== "boolean")
      invalid();
  }
  for (const key of ignoredFields)
    if (!["headers", "env", "args"].includes(key))
      scrub(config[key], [key], isSensitiveArgName(key));
  const secrets = Object.values(literals);
  visit(text, {
    onComment(offset, length) {
      const comment = text.slice(offset, offset + length);
      if (
        secrets.some((secret) => comment.includes(secret)) ||
        /(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S/i.test(comment)
      )
        edits.push({ offset, length, replacement: "" });
    },
  });
  for (const edit of edits.sort((a, b) => b.offset - a.offset))
    text =
      text.slice(0, edit.offset) +
      edit.replacement +
      text.slice(edit.offset + edit.length);
  // Reject a second copy in a comment, innocuous-looking field, or even an escaped JSON string.
  const sanitized = record(getNodeValue(tree(text)));
  if (hasCredentialEcho(text, sanitized, secrets)) invalid();
  return { document: text, config: sanitized, ignoredFields, literals };
}

export function hasCredentialEcho(
  text: string,
  data: unknown,
  values: readonly string[],
) {
  if (!values.some(Boolean)) return false;
  const strings: string[] = [];
  function collect(value: unknown) {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object")
      for (const [key, v] of Object.entries(value)) {
        strings.push(key);
        collect(v);
      }
  }
  collect(data);
  return values.some(
    (value) =>
      value &&
      ((value.length >= 8 &&
        (text.includes(value) || strings.some((s) => s.includes(value)))) ||
        strings.includes(value)),
  );
}

export function mcpDocumentDiff(previous: string, next: string) {
  return (
    diffLines(previous, next, { maxEditLength: 1024 })?.flatMap((part) =>
      part.added || part.removed
        ? part.value
            .trimEnd()
            .split("\n")
            .map((line) => ({
              type: part.added ? ("added" as const) : ("removed" as const),
              line,
            }))
        : [],
    ) ?? [
      ...previous
        .split("\n")
        .map((line) => ({ type: "removed" as const, line })),
      ...next.split("\n").map((line) => ({ type: "added" as const, line })),
    ]
  );
}

export type McpResolvedLock = { sourceRef: string | null; args?: string[] };
/** Only the selector and normalized argument vector belong in a lock, never credentials or runtime state. */
export function resolvedMcpLock(recipe: {
  sourceRef: string | null;
  installCfg: unknown;
}): McpResolvedLock {
  const args = record(recipe.installCfg).args;
  return {
    sourceRef: recipe.sourceRef,
    ...(Array.isArray(args) && { args: args as string[] }),
  };
}

/** Reconstruct an editable client entry, never serializing an envelope or a runtime catalog. */
export function migratedMcpDocument(dep: {
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
}) {
  const cfg = record(dep.installCfg);
  let entry: Record<string, unknown>;
  switch (dep.source) {
    case "remote":
      entry = JSON.parse(serializeMcpDeploymentConfig(dep));
      delete entry.allowUnsafeHttp;
      break;
    case "config":
      entry = {
        command: cfg.command ?? dep.sourceRef,
        args: cfg.args ?? [],
        ...(typeof cfg.cwd === "string" && { cwd: cfg.cwd }),
      };
      break;
    case "docker":
      entry = {
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          dep.sourceRef,
          ...(typeof cfg.startCommand === "string"
            ? cfg.startCommand.split(/\s+/).filter(Boolean)
            : []),
        ],
      };
      break;
    case "github":
    case "npm":
      entry = { command: "npx", args: ["-y", dep.sourceRef] };
      break;
    case "pypi":
      entry = { command: "uvx", args: [dep.sourceRef] };
      break;
    default:
      return invalid();
  }
  if (cfg.network === "none") entry.network = "none";
  const keys = [
    ...new Set([
      ...Object.keys(record(cfg.env)),
      ...(Array.isArray(cfg.requiredEnv)
        ? cfg.requiredEnv.filter(
            (key): key is string => typeof key === "string",
          )
        : []),
    ]),
  ];
  if (keys.length)
    entry.env = Object.fromEntries(keys.map((key) => [key, reference(key)]));
  return JSON.stringify(entry, null, 2);
}

export type NormalizedMcpDocument = {
  document: string;
  config: Record<string, unknown>;
  ignoredFields: string[];
  literals: Record<string, string>;
};
export type McpDocumentEntry = {
  name: string | undefined;
  text: string;
  config: Record<string, unknown>;
};

/** Rebuild all recipe fields instead of spreading stale auth, args or env bindings over an edit. */
export function deriveMcpInstallCfg(
  previous: Record<string, unknown>,
  recipe: Record<string, unknown>,
  envBindings: Record<string, string>,
  requiredEnv: string[],
) {
  const metadata = Object.fromEntries(
    ["toolCatalog", "runInAgentSandbox", "timeoutMs"]
      .filter((key) => Object.hasOwn(previous, key))
      .map((key) => [key, previous[key]]),
  );
  return {
    ...metadata,
    ...recipe,
    requiredEnv,
    ...(Object.keys(envBindings).length ? { envBindings } : {}),
  };
}
