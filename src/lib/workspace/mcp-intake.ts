import "server-only";
import { connectorPreset, CONNECTOR_PRESETS } from "@/lib/connectors/presets";
import {
  hasCredentialEcho,
  normalizeMcpDocument,
  setDocumentProperty,
  splitMcpDocument,
  variableKey,
  type NormalizedMcpDocument,
  type McpDocumentEntry,
} from "./mcp-config";
import { isAllowedRemoteMcpHeaderName } from "@/lib/remote-mcp/header-policy";
import {
  isSensitiveArgName,
  isValidRemoteMcpUrl,
  parseMcpJsonConfig,
  mcpConfigErrorDetail,
} from "./custom-mcp";
import { importDockerRun } from "./mcp-intake-docker";
import type {
  McpIntakeDraft,
  McpIntakeField,
  McpIntakeFile,
  McpIntakeIssue,
  McpIntakeOrigin,
  McpIntakeCreateItem,
  McpIntakeCreateErrorCode,
} from "./mcp-intake-types";

export class IntakeError extends Error {
  readonly issue?: McpIntakeIssue;
  readonly detail?: string;
  constructor(
    readonly code: McpIntakeCreateErrorCode,
    problem: { issue?: McpIntakeIssue; detail?: string } = {},
  ) {
    super(code);
    this.issue = problem.issue;
    this.detail = problem.detail;
  }
}
function invalid(issue?: McpIntakeIssue): never {
  throw new IntakeError("invalidConfig", { issue });
}
/** Echoed user input is bounded and stripped of control characters. */
function echo(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[\p{Cc}]/gu, "").slice(0, 120)
    : undefined;
}
/** Translatable issues for the parser's most common rejections. */
function parserIssue(
  detail: string,
  config: Record<string, unknown>,
): McpIntakeIssue | undefined {
  const field = /^unsupported field: (.+)\.$/.exec(detail)?.[1];
  if (field) return { code: "unsupportedField", value: echo(field) };
  const option = /^unsupported docker run option: (.+)\.$/.exec(detail)?.[1];
  if (option) return { code: "unsupportedDockerOption", value: echo(option) };
  if (detail.startsWith("docker args must include a valid container image"))
    return { code: "invalidDockerImage" };
  if (detail.startsWith("command must be"))
    return { code: "unsupportedCommand", value: echo(config.command) };
  return undefined;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
const ref = (key: string) => `\${${key}}`;
export type IntakeEntry = {
  draft: McpIntakeDraft;
  document: string;
  envBindings: Record<string, string>;
  publicEnv: Record<string, string>;
  literals: Record<string, string>;
  bearerKey?: string;
};

export function parseCanonical(
  config: Record<string, unknown>,
  name: string | undefined,
  options: { allowHttp: boolean; allowUnsafeHttp: boolean },
) {
  // The runtime's multi-header transport expects complete header values in env.
  // Keep the scheme in editable JSON but remove it from the reference passed to the parser.
  const headers =
    config.headers && typeof config.headers === "object"
      ? Object.entries(config.headers)
      : [];
  const document =
    headers.length > 1
      ? {
          ...config,
          headers: Object.fromEntries(
            headers.map(([key, value]) => [
              key,
              key.toLowerCase() === "authorization" && typeof value === "string"
                ? value.replace(/^Bearer /i, "")
                : value,
            ]),
          ),
        }
      : config;
  return parseMcpJsonConfig(JSON.stringify(document), name, {
    ...options,
    allowArbitraryCommand: true,
  });
}

/** This wrapper stays on the server. Only its draft may cross the action boundary. */
export function analyzeEntry(
  value: unknown,
  name: string | undefined,
  origin: McpIntakeOrigin,
  id = "0",
  originalText?: string,
): IntakeEntry {
  let normalized: NormalizedMcpDocument;
  try {
    normalized = normalizeMcpDocument(
      originalText ?? JSON.stringify(object(value), null, 2),
    );
  } catch {
    return invalid();
  }
  const { config, literals, ignoredFields } = normalized;
  for (const key of ignoredFields) delete config[key];
  const envBindings: Record<string, string> = Object.create(null);
  const publicEnv: Record<string, string> = Object.create(null);
  const fields: McpIntakeField[] = [];
  const keys = new Set<string>();
  function bind(
    key: string,
    label: string,
    rawValue: unknown,
    secret: boolean,
  ) {
    if (!variableKey(key)) invalid();
    if (
      typeof rawValue !== "string" ||
      rawValue.length > 16000 ||
      rawValue.includes("\0")
    )
      invalid();
    if (!keys.has(key) && !Object.hasOwn(literals, key))
      fields.push({ key, label, required: true, secret });
    keys.add(key);
    return ref(key);
  }
  let bearerKey: string | undefined;
  let files: McpIntakeFile[] = [];
  if (config.serverUrl !== undefined) {
    if (config.url !== undefined) invalid();
    config.url = config.serverUrl;
    delete config.serverUrl;
  }
  const remote = config.url !== undefined;
  const bindEnv = () => {
    if (config.env === undefined) return;
    config.env = Object.fromEntries(
      Object.entries(object(config.env)).map(([name, value]) => {
        if (!variableKey(name) || typeof value !== "string") invalid();
        const key =
          /^\$\{([A-Za-z_]\w*)\}$/.exec(value)?.[1] ??
          (value === "" ? name : undefined);
        if (!key) {
          publicEnv[name] = value;
          return [name, value];
        }
        if (key !== name) envBindings[name] = key;
        return [name, bind(key, name, value, isSensitiveArgName(name))];
      }),
    );
  };
  if (remote) {
    bindEnv();
    delete config.env;
    if (
      typeof config.url !== "string" ||
      !isValidRemoteMcpUrl(config.url) ||
      /[\s\\]/.test(config.url)
    )
      invalid();
    const url = new URL(config.url);
    name ||= url.hostname.replace(/^(?:mcp|api|www)\./, "").split(".")[0];
    config.type ??= url.pathname.endsWith("/sse") ? "sse" : "http";
    if (config.type === "streamable-http") config.type = "http";
    if (config.headers !== undefined) {
      const headers = Object.entries(object(config.headers));
      config.headers = Object.fromEntries(
        headers.map(([header, value]) => {
          if (
            !isAllowedRemoteMcpHeaderName(header) ||
            typeof value !== "string" ||
            /[\r\n\0]/.test(value) ||
            value.length > 8185
          )
            invalid();
          const authorization = header.toLowerCase() === "authorization";
          const bearer = authorization && /^Bearer(?:\s|$)/i.test(value);
          const token = bearer ? value.replace(/^Bearer(?:\s+|$)/i, "") : value;
          const defaultKey = bearer
            ? "MCP_BEARER_TOKEN"
            : `MCP_${header.toUpperCase().replace(/\W/g, "_")}`;
          const key = /^\$\{([A-Za-z_]\w*)\}$/.exec(token)?.[1] ?? defaultKey;
          const reference = bind(key, header, token, true);
          if (bearer) bearerKey = key;
          return [header, bearer ? `Bearer ${reference}` : reference];
        }),
      );
    }
  } else {
    if (config.type === "stdio") delete config.type;
    if (
      config.command === "docker" &&
      Array.isArray(config.args) &&
      config.args.every((value) => typeof value === "string")
    ) {
      const imported = importDockerRun(
        config.args,
        config.env === undefined ? {} : object(config.env),
        literals,
      );
      if (!imported.ok)
        invalid({ ...imported.issue, value: echo(imported.issue.value) });
      config.args = imported.args;
      if (Object.keys(imported.env).length) config.env = imported.env;
      files = imported.files;
    }
    bindEnv();
    for (const arg of Array.isArray(config.args) ? config.args : []) {
      if (typeof arg !== "string") invalid();
      for (const match of arg.matchAll(/\$\{([A-Za-z_]\w*)\}/g))
        bind(match[1], match[1], match[0], true);
    }
  }
  const canonical = JSON.stringify(config);
  try {
    const parsed = parseCanonical(config, name, {
      allowHttp: true,
      allowUnsafeHttp: false,
    });
    const cfg = parsed.installCfg;
    if (!cfg) invalid();
    return {
      document: normalized.document,
      envBindings,
      publicEnv,
      literals,
      bearerKey,
      draft: {
        id,
        name: parsed.name,
        kind: remote ? "remote" : "stdio",
        summary:
          "args" in cfg ? [cfg.command, ...cfg.args].join(" ") : parsed.ref,
        origin,
        ignoredFields,
        fields,
        auth: { type: remote && keys.size ? "static" : "none" },
        reachability: "skipped",
        insecureHttp: remote && new URL(parsed.ref).protocol === "http:",
        config: canonical,
        ...(remote
          ? {}
          : {
              network:
                "network" in cfg && cfg.network === "none"
                  ? "none"
                  : "isolated",
              ...(files.length ? { files } : {}),
            }),
      },
    };
  } catch (err) {
    if (err instanceof IntakeError) throw err;
    const detail = mcpConfigErrorDetail(err);
    const issue = detail ? parserIssue(detail, config) : undefined;
    throw new IntakeError(
      "invalidConfig",
      issue
        ? { issue }
        : detail && !/variable name:|environment variable .* must/.test(detail)
          ? { detail }
          : {},
    );
  }
}
function documentEntries(raw: string, origin: McpIntakeOrigin, name?: string) {
  let entries: McpDocumentEntry[];
  try {
    entries = splitMcpDocument(raw);
  } catch {
    return invalid({ code: "invalidJson" });
  }
  if (entries.length > 20) throw new IntakeError("tooManyServers");
  const analyzed = entries.map((entry, index) =>
    analyzeEntry(
      entry.config,
      entry.name ??
        name ??
        (typeof entry.config.name === "string" ? entry.config.name : undefined),
      origin,
      String(index),
      origin === "json" ? entry.text : undefined,
    ),
  );
  const secrets = analyzed.flatMap((entry) => Object.values(entry.literals));
  for (const entry of analyzed)
    if (hasCredentialEcho(entry.document, entry.draft, secrets)) invalid();
  return analyzed;
}

function tokenizeShellWords(text: string) {
  const words: string[] = [];
  let quote = "";
  let word = "";
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    started = true;
    if (quote && char === quote) quote = "";
    else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (
      char === "\\" &&
      quote !== "'" &&
      (!quote || /["\\$`\n]/.test(text[index + 1] ?? ""))
    ) {
      if (++index === text.length) invalid();
      if (text[index] !== "\n") word += text[index];
    } else word += char;
  }
  if (quote) invalid();
  if (started) words.push(word);
  return words;
}

function assignEnvironment(env: Record<string, string>, assignment: string) {
  const match = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(assignment);
  if (!match) invalid();
  env[match[1]] = match[2];
}

function parseLaunchCommand(
  words: string[],
  env: Record<string, string>,
  name?: string,
) {
  const [command, ...args] = words;
  if (!command) throw new IntakeError("unrecognized");
  return analyzeEntry({ command, args, env }, name, "command");
}

function parseClaudeMcpAdd(words: string[], env: Record<string, string>) {
  const headers: Record<string, string> = Object.create(null);
  let index = 0;
  let transport: string | undefined;
  while (words[index]?.startsWith("-")) {
    const flag = words[index++];
    const value = words[index++];
    if (!value) invalid();
    if (flag === "--transport" && ["http", "sse", "stdio"].includes(value))
      transport = value;
    else if (flag === "-e" || flag === "--env") assignEnvironment(env, value);
    else if (flag === "--header") {
      const separator = value.indexOf(":");
      if (separator < 1) invalid();
      headers[value.slice(0, separator).trim()] = value
        .slice(separator + 1)
        .trim();
    } else invalid();
  }
  const name = words[index++];
  if (!name) invalid();
  if (words[index] === "--") index++;
  if (/^https?:\/\//i.test(words[index])) {
    if (index + 1 !== words.length || Object.keys(env).length) invalid();
    return analyzeEntry(
      { url: words[index], type: transport, headers },
      name,
      "command",
    );
  }
  if (Object.keys(headers).length || (transport && transport !== "stdio"))
    invalid();
  return parseLaunchCommand(words.slice(index), env, name);
}

function commandEntries(text: string) {
  const words = tokenizeShellWords(text);
  const env: Record<string, string> = Object.create(null);
  let index = 0;
  while (/^[A-Za-z_]\w*=/.test(words[index] ?? ""))
    assignEnvironment(env, words[index++]);
  if (
    words[index] === "code" &&
    words[index + 1] === "--add-mcp" &&
    words.length === index + 3
  ) {
    return documentEntries(words[index + 2], "command");
  }
  if (words.slice(index, index + 3).join(" ") === "claude mcp add") {
    return [parseClaudeMcpAdd(words.slice(index + 3), env)];
  }
  return [parseLaunchCommand(words.slice(index), env)];
}

function decodeInstallLink(text: string) {
  try {
    const url = new URL(text);
    if (
      url.protocol === "cursor:" &&
      url.hostname === "anysphere.cursor-deeplink" &&
      url.pathname === "/mcp/install"
    ) {
      const document = Buffer.from(
        url.searchParams.get("config") ?? "",
        "base64",
      ).toString("utf8");
      return documentEntries(
        document,
        "link",
        url.searchParams.get("name") ?? undefined,
      );
    }
    if (
      /^vscode(?:-insiders)?:$/.test(url.protocol) &&
      url.pathname === "mcp/install"
    ) {
      return documentEntries(decodeURIComponent(url.search.slice(1)), "link");
    }
  } catch (error) {
    if (error instanceof IntakeError) throw error;
  }
  return invalid();
}

export function presetForRemoteUrl(url: string) {
  return CONNECTOR_PRESETS.find(
    (preset) => preset.remote.url.replace(/\/$/, "") === url.replace(/\/$/, ""),
  );
}

export function analyzeText(raw: string): IntakeEntry[] {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) invalid();
  const text = raw.trim();
  if (!text) throw new IntakeError("empty");
  if (/^https?:\/\//i.test(text)) {
    const preset = presetForRemoteUrl(text);
    return [
      preset
        ? analyzePreset(preset.id, "url")
        : analyzeEntry({ url: text }, undefined, "url"),
    ];
  }
  if (/^(?:cursor|vscode(?:-insiders)?):/i.test(text))
    return decodeInstallLink(text);
  if (/^[[{"]|^\/\/|^\/\*/.test(text)) return documentEntries(text, "json");
  return commandEntries(text);
}
export function analyzePreset(id: string, origin: McpIntakeOrigin = "preset") {
  const preset = connectorPreset(id);
  if (!preset) invalid();
  const token = preset.token;
  const entry = analyzeEntry(
    {
      url: preset.remote.url,
      type: preset.remote.transport,
      headers: token
        ? { Authorization: `Bearer ${ref(token.key)}` }
        : undefined,
    },
    preset.name,
    origin,
  );
  entry.draft.presetId = preset.id;
  if (preset.oauth)
    entry.draft.auth = { type: "oauth", issuer: null, client: "missing" };
  if (token)
    Object.assign(entry.draft.fields[0], {
      label: token.label,
      helpUrl: token.createUrl,
    });
  return entry;
}

/** With submitted values, restore only a field that discovery could have offered for this source. */
export function requireProbeBearer(
  entry: IntakeEntry,
  submitted?: Record<string, unknown>,
) {
  const { draft } = entry;
  if (
    draft.kind !== "remote" ||
    draft.presetId ||
    Object.keys(entry.literals).length
  )
    return;
  const config = JSON.parse(draft.config);
  if (
    Object.keys(config.headers ?? {}).some(
      (header) => header.toLowerCase() === "authorization",
    )
  ) {
    const existing = draft.fields.find(
      (field) => field.label.toLowerCase() === "authorization",
    );
    if (existing && !submitted) existing.required = true;
    return;
  }
  const key = ["MCP_BEARER_TOKEN", "MCP_AUTHORIZATION_TOKEN"].find(
    (candidate) => !draft.fields.some((field) => field.key === candidate),
  );
  if (!key) {
    if (submitted) return; // Both names already belong to explicit credential headers.
    invalid();
  }
  if (submitted) {
    const value = submitted[key];
    if (typeof value !== "string" || !value.trim()) return;
  }
  const updated = analyzeEntry(
    {
      ...config,
      headers: { ...config.headers, Authorization: `Bearer ${ref(key)}` },
    },
    draft.name,
    draft.origin,
    draft.id,
  );
  draft.config = updated.draft.config;
  entry.document = setDocumentProperty(
    entry.document,
    ["headers", "Authorization"],
    `Bearer ${ref(key)}`,
  );
  draft.fields.push(
    ...updated.draft.fields.filter((field) => field.key === key),
  );
  entry.bearerKey = key;
}

export function applyCreateItem(
  entry: IntakeEntry,
  item: McpIntakeCreateItem,
  allowHttp: boolean,
) {
  const { draft } = entry;
  if (
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.trim().length > 80
  )
    invalid();
  if (
    item.network !== undefined &&
    !["isolated", "none"].includes(item.network)
  )
    invalid();
  if (draft.insecureHttp && !allowHttp && item.allowUnsafeHttp !== true)
    throw new IntakeError("unsafeHttpConfirmationRequired");

  const values = object(item.values);
  requireProbeBearer(entry, values);
  const parsed = parseCanonical(JSON.parse(draft.config), item.name.trim(), {
    allowHttp,
    allowUnsafeHttp: item.allowUnsafeHttp === true,
  });
  const config = parsed.installCfg;
  if (!config) invalid();
  if (
    item.network &&
    "command" in config &&
    item.network !== (config.network ?? "isolated")
  )
    entry.document = setDocumentProperty(
      entry.document,
      ["network"],
      item.network,
    );
  if (item.authMode === "oauth") {
    if (!("transport" in config) || draft.auth.type !== "oauth") invalid();
    if (Object.keys(JSON.parse(draft.config).headers ?? {}).length)
      entry.document = setDocumentProperty(
        entry.document,
        ["headers"],
        undefined,
      );
    const env: Record<string, string> = {};
    return {
      ...parsed,
      status: "setup_required" as const,
      installCfg: {
        transport: config.transport,
        allowUnsafeHttp: config.allowUnsafeHttp ?? false,
        authType: "oauth" as const,
        resource: new URL(parsed.ref).href,
        issuer: draft.auth.issuer,
        env,
        requiredEnv: [],
      },
    };
  }
  if (draft.presetId && !connectorPreset(draft.presetId)?.token) invalid();
  const env = { ...entry.publicEnv, ...entry.literals };
  const requiredEnv = Object.keys(entry.literals).filter(
    (key) => !key.startsWith("MCP_CLIENT_SECRET"),
  );
  for (const field of draft.fields) {
    const submitted = Object.hasOwn(values, field.key) ? values[field.key] : "";
    if (typeof submitted !== "string") invalid();
    let value = submitted.trim() ? submitted : (field.default ?? "");
    if (field.key === entry.bearerKey)
      value = value
        .trim()
        .replace(/^Bearer(?:\s+|$)/i, "")
        .trim();
    if (value && field.choices && !field.choices.includes(value)) invalid();
    env[field.key] = value;
    if (field.required) requiredEnv.push(field.key);
  }

  if ("transport" in config) {
    if (
      entry.bearerKey &&
      config.authType === "headers" &&
      env[entry.bearerKey]
    ) {
      env[entry.bearerKey] = `Bearer ${env[entry.bearerKey]}`;
    }
    if (config.headerEnv) {
      config.headerEnv = Object.fromEntries(
        Object.entries(config.headerEnv).filter(
          ([, key]) => env[key] || requiredEnv.includes(key),
        ),
      );
      if (!Object.keys(config.headerEnv).length) {
        delete config.headerEnv;
        config.authType = "none";
      }
    }
    if (
      config.bearerEnv &&
      !env[config.bearerEnv] &&
      !requiredEnv.includes(config.bearerEnv)
    ) {
      delete config.bearerEnv;
      config.authType = "none";
    }
    for (const value of Object.values(env))
      if (value.length > 8185 || /[\r\n\0]/.test(value)) invalid();
  } else if ("command" in config && item.network !== undefined) {
    if (item.network === "none") config.network = "none";
    else delete config.network;
  }
  let size = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value.length > 16000 || value.includes("\0")) invalid();
    size += key.length + value.length;
  }
  if (size > 64000) invalid();
  const status = requiredEnv.some((key) => !env[key]?.trim())
    ? ("setup_required" as const)
    : ("provisioning" as const);
  return {
    ...parsed,
    installCfg: {
      ...config,
      env,
      requiredEnv,
      ...(Object.keys(entry.publicEnv).length && {
        documentEnvKeys: Object.keys(entry.publicEnv),
      }),
      ...(Object.keys(entry.envBindings).length && {
        envBindings: entry.envBindings,
      }),
    },
    status,
  };
}
