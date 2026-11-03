#!/usr/bin/env node
/**
 * Offline, read-only OMP 18.14 configuration capture.
 * Usage: node scripts/export-omp-config.mjs --root ~/.omp/agent --output omp-import.json
 * Reads config.yml/config.yaml (legacy config.json/settings.json fallback), sibling
 * plugins/package.json + omp-plugins.lock.json, and installed dependency bytes.
 * Never loads plugin code, runs OMP, installs dependencies, or reads auth/model DBs.
 * Format evidence: upstream v18.14.0 config/config-file.ts, discovery/builtin.ts,
 * discovery/omp-extension-roots.ts and extensibility/plugins/{loader,types}.ts.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import semver from "semver";
import { resolveOmpPluginResources } from "./omp-plugin-resources.mjs";

const VERSION = "18.14.0";
const MAX_FILE = 24 * 1024 * 1024;
const MAX_BUNDLE = 96 * 1024 * 1024;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const credentialKey =
  /secret|password|credential|api[_.-]?key|authorization|(?:^|[_.-])token(?:$|[_.-])|access[_.-]?token|refresh[_.-]?token|bearer|cookie|private[_.-]?key/i;
const privatePath =
  /(?:\/home\/[^\s/"'<>]+|\/Users\/[^\s/"'<>]+|\/root(?:\/|\b)|[A-Za-z]:\\Users\\[^\s\\"']+|~\/)/;
const credentialText =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|password|secret|(?:access[_-]?)?token|authorization)["']?\s*[=:]\s*["']?(?!\$\{|process\.|os\.|env\b|undefined\b|null\b|false\b|true\b)[A-Za-z0-9+/_=-]{8,}|https?:\/\/[^\s/@]+:[^\s/@]+@|[?&](?:[^=&\s]*(?:token|key|secret|password|signature)[^=&\s]*)=(?!\$\{)[^&\s"']+/i;
const stateFile =
  /(?:^|\/)(?:\.git|\.env(?:\.[^/]*)?|auth\.[^/]*|models\.(?:ya?ml|json)|[^/]*\.(?:db|sqlite|sqlite3)(?:-[^/]*)?)(?:\/|$)/i;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const inside = (root, path) =>
  path === root || path.startsWith(`${root}${sep}`);
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const resourceId = (kind, path) => `${kind}:${hash(path)}`;
const stat = async (p) =>
  lstat(p).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });

/**
 * Returns only portable bytes; all omissions have resource-scoped issues.
 * @returns {Promise<import("../src/lib/agents/omp-import-contract.ts").OmpImportBundle>}
 */
export async function exportOmpConfig({
  root = join(homedir(), ".omp", "agent"),
} = {}) {
  root = await realpath(resolve(root));
  if (!(await lstat(root)).isDirectory())
    throw new Error("OMP_ROOT_NOT_DIRECTORY");
  const bundle = {
    schemaVersion: 1,
    kind: "omp-import",
    ompVersion: VERSION,
    settings: {},
    instructions: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    issues: [],
  };
  const secrets = new Set();
  let bytes = 0;
  const display = (p) => {
    const value = String(p)
      .split(root)
      .join("<root>")
      .split(homedir())
      .join("<home>");
    let safe = value.replace(
      /\/home\/[^\s/]+|\/Users\/[^\s/]+|\/root(?=\/|$)|[A-Za-z]:\\Users\\[^\s\\]+/g,
      "<home>",
    );
    for (const secret of secrets) safe = safe.split(secret).join("<redacted>");
    return credentialText.test(safe)
      ? "<redacted-resource>"
      : safe.slice(0, 1000);
  };
  function issue(
    path,
    code,
    message,
    resource = "settings",
    severity = "blocked",
  ) {
    if (bundle.issues.length >= 2048) throw new Error("OMP_TOO_MANY_ISSUES");
    bundle.issues.push({
      id: `issue:${bundle.issues.length + 1}`,
      path: display(path),
      code,
      message,
      severity,
      ...(resource ? { resourceId: resource } : {}),
    });
  }
  function unsafe(text) {
    return (
      privatePath.test(text) ||
      text.includes(root) ||
      credentialText.test(text) ||
      [...secrets].some((s) => text.includes(s))
    );
  }
  function remember(value, key = "") {
    if (
      typeof value === "string" &&
      credentialKey.test(key) &&
      value.length >= 4 &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    )
      secrets.add(value);
    if (record(value))
      for (const [k, v] of Object.entries(value)) remember(v, k);
    if (Array.isArray(value)) for (const v of value) remember(v, key);
  }
  async function source(path, resource, boundary = root, optional = false) {
    try {
      const resolved = await realpath(path);
      if (!inside(boundary, resolved)) {
        issue(
          path,
          "UNSAFE_LINK",
          "A link escapes its declared resource root; copy the intended resource locally before exporting.",
          resource,
        );
        return null;
      }
      const info = await lstat(resolved);
      if (!info.isFile() || info.size > MAX_FILE) {
        issue(
          path,
          "UNSUPPORTED_FILE",
          "Resource is not a regular file or exceeds the 24 MiB per-file limit.",
          resource,
        );
        return null;
      }
      bytes += info.size;
      if (bytes > MAX_BUNDLE) throw new Error("OMP_BUNDLE_TOO_LARGE");
      const data = await readFile(resolved);
      return { data, mode: info.mode & 0o111 ? 493 : 420 };
    } catch (error) {
      if (error.message === "OMP_BUNDLE_TOO_LARGE") throw error;
      if (!(optional && error.code === "ENOENT"))
        issue(
          path,
          error.code === "ENOENT" ? "RESOURCE_MISSING" : "RESOURCE_UNREADABLE",
          "Resource cannot be read; restore it before exporting.",
          resource,
        );
      return null;
    }
  }
  async function config(path, resource = "settings", boundary = root) {
    const file = await source(path, resource, boundary, true);
    if (!file) return null;
    try {
      const value = parseYaml(file.data.toString("utf8"), {
        maxAliasCount: 100,
        uniqueKeys: true,
      });
      if (!record(value)) throw new Error("shape");
      remember(value);
      return value;
    } catch {
      issue(
        path,
        "CONFIG_INVALID",
        "Configuration must be a valid JSON/YAML object. Parser details are withheld to avoid exposing credentials.",
        resource,
      );
      return null;
    }
  }
  async function entries(path, resource, boundary = root) {
    try {
      const actual = await realpath(path);
      if (!inside(boundary, actual)) {
        issue(
          path,
          "UNSAFE_LINK",
          "Directory link escapes the declared resource root.",
          resource,
        );
        return [];
      }
      return (await readdir(actual, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (e) {
      if (e.code !== "ENOENT")
        issue(
          path,
          "RESOURCE_UNREADABLE",
          "Directory cannot be read.",
          resource,
        );
      return [];
    }
  }
  async function inventory(
    directory,
    resource,
    boundary = directory,
    prefix = "",
    ancestors = new Set(),
  ) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch {
      issue(
        directory,
        "RESOURCE_MISSING",
        "Resource directory is missing.",
        resource,
      );
      return [];
    }
    if (!inside(boundary, actual) || ancestors.has(actual)) {
      issue(
        directory,
        "UNSAFE_LINK",
        "Directory link escapes the resource root or forms a cycle.",
        resource,
      );
      return [];
    }
    const next = new Set([...ancestors, actual]);
    const result = [];
    for (const entry of await entries(directory, resource, boundary)) {
      if (entry.name === "node_modules") continue; // Captured by declared dependency closure below.
      const path = join(directory, entry.name);
      const target = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (/[\\\0]/.test(target) || target.length > 1000) {
        issue(
          path,
          "RESOURCE_PATH_UNSUPPORTED",
          "Resource path cannot be represented safely in a portable bundle.",
          resource,
        );
        continue;
      }
      if (entry.name.startsWith("._")) {
        issue(
          path,
          "PRIVATE_FILE_REMOVED",
          "Filesystem metadata is not exported.",
          resource,
          "warning",
        );
        continue;
      }
      if (stateFile.test(target)) {
        issue(
          path,
          "PRIVATE_FILE_REMOVED",
          "Private state is not exported.",
          resource,
        );
        continue;
      }
      let resolvedInfo;
      try {
        resolvedInfo = await lstat(await realpath(path));
      } catch {
        issue(path, "RESOURCE_MISSING", "Broken resource link.", resource);
        continue;
      }
      if (resolvedInfo.isDirectory())
        result.push(
          ...(await inventory(path, resource, boundary, target, next)),
        );
      else {
        const file = await source(path, resource, boundary);
        if (!file) continue;
        const text = file.data.toString("utf8");
        if (unsafe(text)) {
          issue(
            path,
            "PRIVATE_CONTENT_REMOVED",
            "Resource contains credentials or local home paths; remove them locally and export again.",
            resource,
          );
          continue;
        }
        const utf8 =
          !file.data.includes(0) && Buffer.from(text).equals(file.data);
        result.push({
          path: target,
          content: utf8 ? text : file.data.toString("base64"),
          ...(utf8 ? {} : { encoding: "base64" }),
          mode: file.mode,
        });
      }
    }
    return result;
  }
  let settings = {};
  let settingsPath;
  for (const name of [
    "config.yml",
    "config.yaml",
    "config.json",
    "settings.json",
  ]) {
    if (await stat(join(root, name))) {
      settingsPath = name;
      settings = (await config(join(root, name))) ?? {};
      break;
    }
  }
  if (!settingsPath)
    issue(
      "config.yml",
      "SETTINGS_ABSENT",
      "No persisted OMP settings were found; defaults will be used.",
      "settings",
      "warning",
    );
  const versionFile = await source(
    join(root, "last-changelog-version"),
    "settings",
    root,
    true,
  );
  if (versionFile) {
    const version = versionFile.data.toString("utf8").trim().replace(/^v/, "");
    if (semver.valid(version)) bundle.ompVersion = version;
    else
      issue(
        "last-changelog-version",
        "VERSION_UNKNOWN",
        "The local version marker is invalid; compatibility with fixed OMP 18.14.0 is unverified.",
        "settings",
      );
  } else
    issue(
      "last-changelog-version",
      "VERSION_UNVERIFIED",
      "No local version marker exists; this exporter understands OMP 18.14.0 formats, not an independently verified installation.",
      "settings",
      "warning",
    );
  if (bundle.ompVersion !== VERSION)
    issue(
      "last-changelog-version",
      "VERSION_MISMATCH",
      "Source version differs from fixed OMP 18.14.0. Review resources against that runtime before importing.",
      "settings",
    );
  const defaultModel = settings.modelRoles?.default;
  if (typeof defaultModel === "string" && !unsafe(defaultModel)) {
    const slash = defaultModel.indexOf("/");
    bundle.model =
      slash > 0
        ? {
            provider: defaultModel.slice(0, slash),
            model: defaultModel.slice(slash + 1),
          }
        : { model: defaultModel };
  }
  const roleHints = Object.fromEntries(
    Object.entries(settings.modelRoles ?? {}).filter(
      ([name, value]) =>
        /^[A-Za-z0-9_-]{1,100}$/.test(name) &&
        typeof value === "string" &&
        /^@?[A-Za-z0-9_-]+(?:[./:+-][A-Za-z0-9_-]+)*$/.test(value) &&
        !unsafe(value),
    ),
  );
  if (Object.keys(roleHints).length) bundle.modelRoles = roleHints;
  const taskOverrides = settings.task?.agentModelOverrides;
  const safeTaskOverrides =
    record(taskOverrides) &&
    Object.entries(taskOverrides).every(
      ([name, value]) =>
        /^[A-Za-z0-9_-]{1,100}$/.test(name) &&
        typeof value === "string" &&
        /^@?[A-Za-z0-9_-]+(?:[./:+-][A-Za-z0-9_-]+)*$/.test(value) &&
        !unsafe(value),
    );
  if (safeTaskOverrides) bundle.taskModelOverrides = taskOverrides;
  function preferences(value, prefix = "") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (path === "task.agentModelOverrides" && safeTaskOverrides) {
        issue(
          `${settingsPath ?? "config.yml"}:${path}`,
          "ROLE_MODEL_MAPPING_REQUIRED",
          "Task role model selectors are retained as hints only; map workspace models explicitly in the import preview.",
          "settings",
          "warning",
        );
        continue;
      }
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        /model|provider|secret|password|credential|api.?key|auth|defaultThinkingLevel/i.test(
          path,
        ) ||
        /(?:^|\.)(?:access|refresh|bearer|runtime)?token(?:\.|$)/i.test(path) ||
        /^retry\.fallback|^(?:mcp|ssh|plugins|extensions|extensionPaths|customToolPaths)(?:\.|$)|^(?:browser\.relay|dev\.autoqaConsent)$/.test(
          path,
        )
      ) {
        issue(
          `${settingsPath ?? "config.yml"}:${path}`,
          "SETTING_EXTERNALIZED",
          "Routing, credentials, discovery and local execution settings require explicit platform configuration; safe model role hints are retained without authority.",
          "settings",
          /model|provider|defaultThinkingLevel|^(?:extensions|extensionPaths)$/.test(
            path,
          )
            ? "warning"
            : "blocked",
        );
      } else if (unsafe(JSON.stringify(item)))
        issue(
          `${settingsPath}:${path}`,
          "PRIVATE_SETTING_REMOVED",
          "Setting contains credentials or local paths and was removed.",
          "settings",
        );
      else out[key] = record(item) ? preferences(item, path) : item;
    }
    return out;
  }
  bundle.settings = preferences(settings);

  async function instructions(directory, prefix = "", boundary = root) {
    const files = prefix
      ? await inventory(directory, "instructions", boundary, prefix)
      : [];
    for (const file of files) {
      if (file.encoding)
        issue(
          file.path,
          "INSTRUCTION_ENCODING",
          "Instructions must be UTF-8 text.",
          "instructions",
        );
      else bundle.instructions.push({ path: file.path, content: file.content });
    }
  }
  for (const name of [
    "APPEND_SYSTEM.md",
    "SYSTEM.md",
    "RULES.md",
    "AGENTS.md",
  ]) {
    const file = await source(join(root, name), "instructions", root, true);
    if (!file) continue;
    const content = file.data.toString("utf8");
    if (unsafe(content))
      issue(
        name,
        "PRIVATE_CONTENT_REMOVED",
        "Instruction contains credentials or local home paths; remove them before exporting.",
        "instructions",
      );
    else bundle.instructions.push({ path: name, content });
  }
  if (await stat(join(root, "rules")))
    await instructions(join(root, "rules"), "rules");

  async function skills(directory, namespace = "root", boundary = root) {
    async function visit(dir, ancestors = new Set()) {
      const actual = await realpath(dir);
      if (ancestors.has(actual) || !inside(boundary, actual)) {
        issue(
          dir,
          "UNSAFE_LINK",
          "Skill directory link escapes its root or forms a cycle.",
          "settings",
        );
        return;
      }
      const next = new Set([...ancestors, actual]);
      const members = await entries(dir, "settings", boundary);
      if (members.some((v) => v.name === "SKILL.md")) {
        const id = resourceId(
          "skill",
          `${namespace}/${relative(directory, dir)}`,
        );
        const files = await inventory(dir, id, boundary);
        const main = files.find((v) => v.path === "SKILL.md");
        if (!main || main.encoding) {
          issue(
            `${namespace}/skills`,
            "SKILL_INVALID",
            "Skill entrypoint is missing or not UTF-8.",
            id,
          );
          return;
        }
        let name = basename(dir);
        try {
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
            main.content,
          );
          const fm = match ? parseYaml(match[1]) : {};
          if (typeof fm?.name === "string" && !unsafe(fm.name)) name = fm.name;
        } catch {
          issue(
            `${namespace}/skills`,
            "SKILL_FRONTMATTER_INVALID",
            "Skill YAML frontmatter is invalid.",
            id,
          );
        }
        bundle.skills.push({
          id,
          name,
          content: main.content,
          files: files
            .filter((v) => v.path !== "SKILL.md")
            .map(({ mode: _mode, ...file }) => file),
        });
        return;
      }
      for (const entry of members) {
        if (entry.name.startsWith(".")) {
          issue(
            `${namespace}/skills/${entry.name}`,
            "SKILL_RESOURCE_UNSUPPORTED",
            "Hidden skill resource was not traversed.",
            "settings",
          );
          continue;
        }
        const path = join(dir, entry.name);
        let info;
        try {
          info = await lstat(await realpath(path));
        } catch {
          issue(
            path,
            "RESOURCE_MISSING",
            "Broken skill resource link.",
            "settings",
          );
          continue;
        }
        if (info.isDirectory()) {
          const actual = await realpath(path);
          if (!inside(boundary, actual) || actual === (await realpath(dir)))
            issue(
              path,
              "UNSAFE_LINK",
              "Skill directory link escapes its root or forms a cycle.",
              "settings",
            );
          else await visit(path, next);
        } else
          issue(
            path,
            "SKILL_RESOURCE_UNRESOLVED",
            "File is outside any SKILL.md resource directory.",
            "settings",
          );
      }
    }
    if (await stat(directory)) await visit(directory);
  }
  await skills(join(root, "skills"));

  const seenMcp = new Set();
  async function mcp(path, namespace = "root", boundary = root) {
    const cfg = await config(path, "settings", boundary);
    if (!cfg) return;
    if (!record(cfg.mcpServers)) {
      issue(path, "MCP_CONFIG_INVALID", "Expected the OMP mcpServers object.");
      return;
    }
    for (const key of ["enabledServers", "disabledServers"])
      if (cfg[key] !== undefined && !Array.isArray(cfg[key]))
        issue(
          path,
          "MCP_CONFIG_INVALID",
          "MCP enabled/disabled server selectors must be arrays.",
        );
    for (const key of Object.keys(cfg))
      if (!["mcpServers", "disabledServers", "enabledServers"].includes(key))
        issue(
          path,
          "MCP_OPTION_UNSUPPORTED",
          "An unsupported MCP file option requires manual mapping.",
        );
    for (const [name, raw] of Object.entries(cfg.mcpServers)) {
      const id = resourceId("mcp", `${namespace}/${name}`);
      if (seenMcp.has(id)) {
        issue(
          path,
          "MCP_SHADOWED",
          "Duplicate MCP name is shadowed by the earlier configuration file; review the source precedence explicitly.",
          id,
          "warning",
        );
        continue;
      }
      seenMcp.add(id);
      if (!record(raw)) {
        issue(
          path,
          "MCP_CONFIG_INVALID",
          "MCP server configuration is not an object.",
          id,
        );
        continue;
      }
      if (
        (Array.isArray(cfg.disabledServers) &&
          cfg.disabledServers.includes(name)) ||
        (raw.enabled === false &&
          !(
            Array.isArray(cfg.enabledServers) &&
            cfg.enabledServers.includes(name)
          ))
      ) {
        issue(
          path,
          "MCP_DISABLED",
          "Disabled MCP server was intentionally not selected.",
          id,
          "warning",
        );
        continue;
      }
      const required = new Set();
      function placeholder(value, label) {
        const existing =
          typeof value === "string" &&
          /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}$/.exec(value);
        const env =
          existing?.[1] ?? `OMP_${hash(`${id}/${label}`).toUpperCase()}`;
        required.add(env);
        return `\${${env}}`;
      }
      function sanitize(value, label = "config", key = "") {
        if (typeof value === "string") {
          if (
            label.startsWith("config.headers.") &&
            key.toLowerCase() === "authorization" &&
            /^Bearer /i.test(value)
          )
            return `Bearer ${placeholder(value.slice(7), label)}`;
          for (const match of value.matchAll(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g,
          ))
            required.add(match[1]);
          if (
            credentialKey.test(key) ||
            label.startsWith("config.env.") ||
            label.startsWith("config.headers.")
          )
            return placeholder(value, label);
          if (unsafe(value)) {
            issue(
              path,
              "MCP_VALUE_REQUIRES_MAPPING",
              "A credential or local path was replaced; supply a portable MCP configuration explicitly.",
              id,
            );
            return placeholder(value, label);
          }
          return value;
        }
        if (Array.isArray(value))
          return value.map((v, i) => sanitize(v, `${label}.${i}`, key));
        if (record(value))
          return Object.fromEntries(
            Object.entries(value)
              .filter(
                ([k]) => !["__proto__", "prototype", "constructor"].includes(k),
              )
              .map(([k, v]) => [k, sanitize(v, `${label}.${k}`, k)]),
          );
        return value;
      }
      const mapped = sanitize(raw);
      if (mapped.type) {
        mapped.transport = mapped.type;
        delete mapped.type;
      }
      delete mapped.enabled;
      for (const key of Object.keys(mapped))
        if (
          !["command", "args", "env", "url", "transport", "headers"].includes(
            key,
          )
        )
          issue(
            path,
            "MCP_OPTION_UNSUPPORTED",
            "Server contains an OMP-specific option that needs explicit platform mapping.",
            id,
          );
      if (
        mapped.command &&
        !["npx", "uvx", "uv", "docker"].includes(mapped.command)
      )
        issue(
          path,
          "MCP_EXECUTABLE_UNRESOLVED",
          "Local stdio executable is not bundled; supply an approved sandbox command and dependencies.",
          id,
        );
      if (!mapped.command && !mapped.url)
        issue(path, "MCP_CONFIG_INVALID", "Server needs a command or URL.", id);
      bundle.mcpServers.push({
        id,
        name: unsafe(name) ? `mcp-${hash(name)}` : name,
        config: mapped,
        requiredSecrets: [...required].sort(),
      });
    }
  }
  for (const name of ["mcp.json", ".mcp.json"])
    if (await stat(join(root, name))) await mcp(join(root, name));

  async function dependencyLocation(base, name) {
    for (let current = base; ; current = dirname(current)) {
      const candidate = join(current, "node_modules", name);
      if (await stat(candidate)) return candidate;
      if (dirname(current) === current) return null;
    }
  }
  async function capturePlugin(
    directory,
    namespace,
    runtimeState = {},
    synthetic,
  ) {
    const id = resourceId("plugin", namespace);
    let boundary;
    try {
      boundary = await realpath(directory);
    } catch {
      issue(
        namespace,
        "PLUGIN_MISSING",
        "Enabled plugin is not installed locally; no dependency installation was attempted.",
        id,
      );
      return;
    }
    const metadata =
      synthetic ??
      (await config(join(directory, "package.json"), id, boundary));
    if (
      !metadata ||
      !packageName.test(metadata.name ?? "") ||
      !semver.valid(metadata.version) ||
      semver.valid(metadata.version) !== metadata.version
    ) {
      issue(
        namespace,
        "PLUGIN_MANIFEST_INVALID",
        "Plugin needs a valid package name and semantic version.",
        id,
      );
      return;
    }
    if (runtimeState.version && runtimeState.version !== metadata.version)
      issue(
        namespace,
        "PLUGIN_VERSION_MISMATCH",
        "Installed package version differs from its OMP runtime lock entry.",
        id,
      );
    if (
      (Array.isArray(metadata.os) &&
        (metadata.os.includes("!linux") ||
          (!metadata.os.includes("linux") &&
            !metadata.os.every((v) => v.startsWith("!"))))) ||
      (Array.isArray(metadata.cpu) &&
        !metadata.cpu.some((v) => ["x64", "arm64"].includes(v)))
    )
      issue(
        namespace,
        "NATIVE_PLATFORM_MISMATCH",
        "Package platform restrictions exclude supported Linux sandbox targets.",
        id,
      );
    const declaredSettings = (metadata.omp ?? metadata.pi)?.settings ?? {};
    for (const [key, schema] of Object.entries(declaredSettings)) {
      if (!schema?.secret) continue;
      for (const value of [schema.default, runtimeState.config?.[key]])
        if (typeof value === "string" && value.length) secrets.add(value);
      if (runtimeState.config?.[key] !== undefined)
        issue(
          namespace,
          "PLUGIN_CONFIG_PRIVATE",
          "A manifest-declared secret plugin setting was removed; configure it explicitly through an approved secret path.",
          id,
        );
    }
    if (
      runtimeState.enabledFeatures !== undefined &&
      runtimeState.enabledFeatures !== null &&
      (!Array.isArray(runtimeState.enabledFeatures) ||
        runtimeState.enabledFeatures.some(
          (v) => typeof v !== "string" || !v.length || v.length > 240,
        ))
    ) {
      issue(
        namespace,
        "PLUGIN_FEATURES_INVALID",
        "Enabled plugin features must be an array of names or null for defaults.",
        id,
      );
      runtimeState = { ...runtimeState, enabledFeatures: [] };
    }
    const plugin = {
      name: metadata.name,
      version: metadata.version,
      runtimeKind: "omp",
      files: [],
      hooks: [],
      extensions: [],
      tools: [],
      commands: [],
      enabledFeatures: runtimeState.enabledFeatures ?? null,
    };
    let count = 0;
    const capturedPackages = new Map();
    async function capturePackage(dir, target, meta) {
      if (++count > 512) {
        issue(
          namespace,
          "DEPENDENCY_LIMIT",
          "Dependency closure exceeds 512 packages.",
          id,
        );
        return;
      }
      const actual = await realpath(dir);
      capturedPackages.set(target, actual);
      const files = await inventory(dir, id, actual);
      for (const file of files)
        plugin.files.push({
          ...file,
          path: target ? `${target}/${file.path}` : file.path,
        });
      const dependencies = {
        ...meta.peerDependencies,
        ...meta.optionalDependencies,
        ...meta.dependencies,
      };
      for (const [name, spec] of Object.entries(dependencies)) {
        if (!packageName.test(name) || typeof spec !== "string") {
          issue(
            namespace,
            "DEPENDENCY_INVALID",
            "A dependency declaration is invalid.",
            id,
          );
          continue;
        }
        const location = await dependencyLocation(actual, name);
        if (!location) {
          issue(
            namespace,
            "DEPENDENCY_MISSING",
            "A declared dependency is not installed locally; restore the package closure before exporting.",
            id,
            Object.hasOwn(meta.optionalDependencies ?? {}, name) ||
              meta.peerDependenciesMeta?.[name]?.optional
              ? "warning"
              : "blocked",
          );
          continue;
        }
        const depActual = await realpath(location);
        let resolvedInSnapshot = false;
        for (let ancestor = target; ; ancestor = posix.dirname(ancestor)) {
          const candidate =
            ancestor && ancestor !== "."
              ? `${ancestor}/node_modules/${name}`
              : `node_modules/${name}`;
          if (capturedPackages.get(candidate) === depActual) {
            resolvedInSnapshot = true;
            break;
          }
          if (!ancestor || ancestor === ".") break;
        }
        if (resolvedInSnapshot) continue;
        const dep = await config(join(location, "package.json"), id, depActual);
        if (!dep) {
          issue(
            namespace,
            "DEPENDENCY_MANIFEST_MISSING",
            "Installed dependency has no readable package manifest.",
            id,
          );
          continue;
        }
        if (
          semver.validRange(spec) &&
          !semver.satisfies(dep.version ?? "", spec)
        )
          issue(
            namespace,
            "DEPENDENCY_VERSION_MISMATCH",
            "Installed dependency does not satisfy its declared version range.",
            id,
          );
        if (/^(?:file:|link:|workspace:|portal:)|^(?:\/|~)/.test(spec))
          issue(
            namespace,
            "DEPENDENCY_LOCAL_SOURCE",
            "Local dependency source was captured, but its declaration must be replaced with a portable version before import.",
            id,
          );
        await capturePackage(
          location,
          target ? `${target}/node_modules/${name}` : `node_modules/${name}`,
          dep,
        );
      }
    }
    await capturePackage(directory, "", metadata);
    if (synthetic) {
      plugin.files = plugin.files.filter(
        (file) => file.path !== "package.json",
      );
      plugin.files.push({
        path: "package.json",
        content: JSON.stringify(metadata),
        mode: 420,
      });
    }
    try {
      Object.assign(
        plugin,
        resolveOmpPluginResources(
          { path: "/package", manifest: metadata },
          plugin.files,
          runtimeState,
        ),
      );
    } catch {
      issue(
        namespace,
        "PLUGIN_ENTRY_UNRESOLVED",
        "An enabled feature or manifest entry cannot be resolved from the frozen package files.",
        id,
      );
    }
    const agents = plugin.files.filter((v) =>
      /^agents\/[^/]+\.md$/.test(v.path),
    );
    plugin.subagents = agents.map((v) => v.path);
    for (const file of agents)
      if (/^---\r?\n[\s\S]*?^model\s*:/m.test(file.content))
        issue(
          `${namespace}/${file.path}`,
          "ROLE_MODEL_MAPPING_REQUIRED",
          "Native role model is retained as a hint; explicitly map a workspace provider and model in the import preview.",
          id,
          "warning",
        );
    for (const file of plugin.files) {
      const data = Buffer.from(
        file.content,
        file.encoding === "base64" ? "base64" : "utf8",
      );
      const elf =
        data.length >= 20 &&
        data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
      if (elf || /\.(?:node|dll|dylib|exe)$/.test(file.path)) {
        const machine = elf && data[5] === 1 ? data.readUInt16LE(18) : 0;
        const arch = machine === 62 ? "x64" : machine === 183 ? "arm64" : null;
        if (!arch || (plugin.arch && plugin.arch !== arch))
          issue(
            `${namespace}/${file.path}`,
            "NATIVE_PLATFORM_MISMATCH",
            "Native artifact is not a single supported Linux x64/arm64 dependency closure.",
            id,
          );
        else {
          plugin.platform = "linux";
          plugin.arch = arch;
        }
      }
    }
    if (runtimeState.config)
      plugin.config = sanitizePluginConfig(
        Object.fromEntries(
          Object.entries(runtimeState.config).filter(
            ([key]) => !declaredSettings[key]?.secret,
          ),
        ),
        id,
        namespace,
      );
    if (plugin.files.length) bundle.plugins.push({ id, plugin });
    else
      issue(namespace, "PLUGIN_EMPTY", "Plugin has no exportable files.", id);
    if (!synthetic) {
      await skills(join(directory, "skills"), namespace, boundary);
      for (const name of [".mcp.json", "mcp.json"])
        if (await stat(join(directory, name)))
          await mcp(join(directory, name), namespace, boundary);
      for (const name of ["rules", "prompts"])
        if (await stat(join(directory, name)))
          issue(
            `${namespace}/${name}`,
            "PLUGIN_DISCOVERY_UNMAPPED",
            "Package rules/prompts need explicit instruction mapping; raw package files are retained but are not implicitly activated.",
            id,
          );
      for (const kind of ["hooks/pre", "hooks/post", "tools", "commands"]) {
        if (!(await stat(join(directory, kind)))) continue;
        const declared = Object.values({
          hooks: plugin.hooks,
          tools: plugin.tools,
          commands: plugin.commands,
        }).flat();
        for (const file of plugin.files.filter((v) =>
          v.path.startsWith(`${kind}/`),
        )) {
          if (!declared.includes(file.path))
            issue(
              `${namespace}/${file.path}`,
              "PLUGIN_DISCOVERY_UNMAPPED",
              "Implicit native resource is retained but not activated by the package declaration; provide a supported private declaration or explicitly exclude it.",
              id,
            );
        }
      }
    }
  }
  function sanitizePluginConfig(value, id, namespace) {
    if (
      unsafe(JSON.stringify(value)) ||
      Object.keys(value).some((k) => credentialKey.test(k))
    ) {
      issue(
        namespace,
        "PLUGIN_CONFIG_PRIVATE",
        "Plugin config contains credentials or local paths; configure it explicitly after removing private values.",
        id,
      );
      return {};
    }
    return value;
  }
  // Fixed OMP uses a sibling plugins tree, not agent/config.yml#plugins.
  const pluginsRoot =
    basename(root) === "agent"
      ? join(dirname(root), "plugins")
      : join(root, "plugins");
  if (await stat(pluginsRoot)) {
    const pluginBoundary = await realpath(pluginsRoot);
    const manifest =
      (await config(
        join(pluginsRoot, "package.json"),
        "settings",
        pluginBoundary,
      )) ?? {};
    const lock =
      (await config(
        join(pluginsRoot, "omp-plugins.lock.json"),
        "settings",
        pluginBoundary,
      )) ?? {};
    for (const name of new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(lock.plugins ?? {}),
    ])) {
      if (!packageName.test(name)) {
        issue(
          "plugins/package.json",
          "PLUGIN_NAME_INVALID",
          "Plugin declaration has an invalid package name.",
        );
        continue;
      }
      const state = {
        ...(lock.plugins?.[name] ?? {}),
        ...(record(lock.settings?.[name])
          ? { config: lock.settings[name] }
          : {}),
      };
      if (state.enabled === false) {
        issue(
          `plugins/${name}`,
          "PLUGIN_DISABLED",
          "Disabled plugin was intentionally not selected.",
          resourceId("plugin", `installed/${name}`),
          "warning",
        );
        continue;
      }
      const path = join(pluginsRoot, "node_modules", name);
      if (await stat(path)) {
        const actual = await realpath(path);
        if (!inside(pluginBoundary, actual)) {
          issue(
            `plugins/${name}`,
            "LINKED_PLUGIN_SNAPSHOT",
            "Linked plugin is captured as a private package snapshot; its local source link is not exported.",
            resourceId("plugin", `installed/${name}`),
            "warning",
          );
        }
      }
      await capturePlugin(path, `installed/${name}`, state);
    }
  }
  const configured = settings.extensions ?? settings.extensionPaths ?? [];
  for (const [index, entry] of (Array.isArray(configured)
    ? configured
    : [configured]
  ).entries()) {
    const id = resourceId("plugin", `configured/${index}`);
    if (typeof entry !== "string" || !isAbsolute(entry)) {
      issue(
        `extensions/${index}`,
        "EXTENSION_PATH_UNRESOLVED",
        "Relative extension paths depend on the original session working directory; provide an absolute package root locally before export.",
        id,
      );
      continue;
    }
    await capturePlugin(entry, `configured/${index}`);
  }
  // Ambient native resources become private package declarations, never Agent rows.
  for (const kind of ["agents", "commands", "hooks", "extensions", "tools"]) {
    const path = join(root, kind);
    if (!(await stat(path))) continue;
    const id = resourceId("plugin", `native/${kind}`);
    const files = await inventory(path, id, root);
    if (!files.length) continue;
    const declaration = {};
    if (kind === "agents")
      declaration.subagents = files
        .filter((v) => /^[^/]+\.md$/.test(v.path))
        .map((v) => `${kind}/${v.path}`);
    else
      declaration[kind] = files
        .filter((v) =>
          kind === "commands"
            ? /\.md$/.test(v.path)
            : /\.[cm]?[jt]s$/.test(v.path) &&
              !(kind === "hooks" && /^(?:pre|post)\//.test(v.path)),
        )
        .map((v) => `${kind}/${v.path}`);
    for (const file of files)
      if (!Object.values(declaration).flat().includes(`${kind}/${file.path}`))
        issue(
          `${kind}/${file.path}`,
          "NATIVE_RESOURCE_UNMAPPED",
          "Native script/support resource is retained, but cannot be declared as an executable module; shell pre/post hooks need explicit adaptation.",
          id,
        );
    // Capture only this native subtree, then rebase files and declarations.
    const metadata = {
      name: `omp-import-${kind}`,
      version: "1.0.0",
      omp: Object.fromEntries(
        Object.entries(declaration).map(([k, v]) => [
          k,
          v.map((p) => p.slice(kind.length + 1)),
        ]),
      ),
    };
    await capturePlugin(path, `native/${kind}`, {}, metadata);
    const captured = bundle.plugins.find((v) => v.id === id);
    if (captured) {
      captured.plugin.subagents =
        kind === "agents" ? metadata.omp.subagents : [];
      if (kind === "agents")
        for (const file of files)
          if (/^---\r?\n[\s\S]*?^model\s*:/m.test(file.content))
            issue(
              `${kind}/${file.path}`,
              "ROLE_MODEL_MAPPING_REQUIRED",
              "Native role model is retained as a hint; explicitly map a workspace provider and model in the import preview.",
              id,
              "warning",
            );
    }
  }
  const recognized = new Set([
    "config.yml",
    "config.yaml",
    "config.json",
    "settings.json",
    "mcp.json",
    ".mcp.json",
    "last-changelog-version",
    "APPEND_SYSTEM.md",
    "SYSTEM.md",
    "RULES.md",
    "AGENTS.md",
    "rules",
    "skills",
    "agents",
    "commands",
    "hooks",
    "extensions",
    "tools",
    "plugins",
  ]);
  for (const entry of await entries(root, "settings")) {
    if (recognized.has(entry.name)) continue;
    const privateState =
      stateFile.test(entry.name) ||
      /^(?:sessions|cache|blobs|custom-session-files|terminal-sessions|predict)$/.test(
        entry.name,
      ) ||
      entry.name.startsWith("._") ||
      /^(?:config|settings)\.(?:ya?ml|json)\.(?:bak|backup)(?:[-.].*)?$/.test(
        entry.name,
      );
    issue(
      entry.name,
      privateState ? "PRIVATE_STATE_EXCLUDED" : "RESOURCE_UNSUPPORTED",
      privateState
        ? "Local authentication, model catalogs, session/cache state, configuration backups and filesystem metadata are intentionally not read or exported."
        : "Source resource is not represented by this bundle; map it explicitly before importing.",
      "settings",
      privateState ? "warning" : "blocked",
    );
  }
  // A secret discovered in a later package/MCP config must not survive in an
  // earlier text resource. Do not rewrite executable bytes into broken code.
  const portable = (file, resource) => {
    const text = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    ).toString("utf8");
    if (!unsafe(text)) return true;
    issue(
      file.path,
      "PRIVATE_CONTENT_REMOVED",
      "Resource contains a known credential or local home path and was removed.",
      resource,
    );
    return false;
  };
  bundle.instructions = bundle.instructions.filter((file) =>
    portable(file, "instructions"),
  );
  bundle.skills = bundle.skills.filter((skill) => {
    skill.files = skill.files.filter((file) => portable(file, skill.id));
    return portable({ path: "SKILL.md", content: skill.content }, skill.id);
  });
  for (const entry of bundle.plugins) {
    entry.plugin.files = entry.plugin.files.filter((file) =>
      portable(file, entry.id),
    );
    if (entry.plugin.config && unsafe(JSON.stringify(entry.plugin.config))) {
      delete entry.plugin.config;
      issue(
        "plugins/config",
        "PLUGIN_CONFIG_PRIVATE",
        "Plugin configuration contains a known credential and was removed.",
        entry.id,
      );
    }
  }
  bundle.plugins = bundle.plugins.filter(
    (entry) => entry.plugin.files.length > 0,
  );
  for (const [key, value] of Object.entries(bundle.settings))
    if (unsafe(JSON.stringify(value))) {
      delete bundle.settings[key];
      issue(
        "config.yml",
        "PRIVATE_SETTING_REMOVED",
        "Setting contains a known credential and was removed.",
        "settings",
      );
    }
  for (const entry of bundle.mcpServers)
    if (unsafe(JSON.stringify(entry.config))) {
      entry.config = {};
      issue(
        "mcp.json",
        "MCP_VALUE_REQUIRES_MAPPING",
        "MCP configuration contains a credential discovered elsewhere; supply a clean explicit configuration.",
        entry.id,
      );
    }
  if (bundle.model && unsafe(JSON.stringify(bundle.model))) {
    delete bundle.model;
    issue(
      "config.yml",
      "MODEL_HINT_PRIVATE",
      "Default model hint contains private content and was removed.",
      "settings",
      "warning",
    );
  }
  if (
    bundle.instructions.length > 512 ||
    bundle.skills.length > 512 ||
    bundle.plugins.length > 128 ||
    bundle.mcpServers.length > 128 ||
    bundle.skills.some((skill) => skill.files.length > 512) ||
    bundle.plugins.some((entry) => entry.plugin.files.length > 20000)
  )
    throw new Error("OMP_RESOURCE_LIMIT_EXCEEDED");
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE)
    throw new Error("OMP_BUNDLE_TOO_LARGE");
  return bundle;
}

export const HELP = `Export an optional, workspace-private OMP import bundle (offline).

Usage: node scripts/export-omp-config.mjs [--root ~/.omp/agent] [--output omp-import.json]
       node scripts/export-omp-config.mjs --help

--root    OMP agent configuration directory; default ~/.omp/agent.
--output  New output file; default stdout. Existing files are never overwritten.
--help    Print this help without reading local configuration.

Understands fixed OMP 18.14.0 config.yml/config.yaml and legacy JSON settings,
sibling plugins/omp-plugins.lock.json, enabled feature declarations, and installed
dependency closure. Secrets become MCP requiredSecrets references or explicit
resource blockers. No auth/model databases, uploads, code execution, dependency
installation, install hooks, or local configuration mutation. Review all issues
before import; version markers do not prove runtime compatibility.\n`;

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      process.stdout.write(HELP);
      return;
    }
    if (
      !["--root", "--output"].includes(arg) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error("OMP_ARGUMENTS_INVALID: use --help");
    const key = arg.slice(2);
    if (options[key] !== undefined) throw new Error("OMP_ARGUMENTS_DUPLICATE");
    options[key] = argv[++i];
  }
  const bundle = await exportOmpConfig(options);
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (options.output) {
    // O_EXCL prevents overwriting config or following an output symlink.
    const output = await open(
      resolve(options.output),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await output.writeFile(json);
    } finally {
      await output.close();
    }
  } else process.stdout.write(json);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write(
      "OMP export failed. Check arguments, source permissions and output-file availability; use --help. No configuration was changed.\n",
    );
    process.exitCode = 1;
  });
}
