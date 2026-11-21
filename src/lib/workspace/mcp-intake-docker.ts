import "server-only";
import path from "node:path";
import type { McpIntakeFile, McpIntakeIssue } from "./mcp-intake-types";
import { RUNTIME_FILE_MOUNT_PATH, safeRuntimeFilePath } from "./runtime-files";

export type DockerRunImport =
  | {
      ok: true;
      args: string[];
      env: Record<string, unknown>;
      files: McpIntakeFile[];
    }
  | { ok: false; issue: McpIntakeIssue };

const VALUE_OPTIONS = new Set([
  "-e",
  "--env",
  "-v",
  "--volume",
  "--mount",
  "--tmpfs",
  "--cap-drop",
  "--security-opt",
]);

function issue(
  code: McpIntakeIssue["code"],
  value?: string,
): { ok: false; issue: McpIntakeIssue } {
  return { ok: false, issue: { code, ...(value ? { value } : {}) } };
}

function containerPath(value: string | undefined) {
  if (!value?.startsWith("/") || value === "/" || /[\0\\]/.test(value))
    return null;
  const normalized = path.posix.normalize(value).replace(/\/$/, "");
  return normalized === value.replace(/\/$/, "") ? normalized : null;
}

/** Host bind mounts only: their content can become a ToolPlane runtime file. */
function bindTarget(option: string, value: string) {
  if (option === "--mount") {
    const fields = new Map(
      value.split(",").map((pair) => {
        const separator = pair.indexOf("=");
        return separator < 0
          ? [pair, "true"]
          : [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
    );
    if (fields.get("type") !== "bind") return null;
    return containerPath(
      fields.get("target") ?? fields.get("dst") ?? fields.get("destination"),
    );
  }
  const [source, target] = value.split(":");
  if (!/^(?:[/~.]|\$\{)/.test(source ?? "")) return null;
  return containerPath(target);
}

/**
 * Translate the hardening and host-file options that MCP clients commonly
 * use with `docker run` into ToolPlane's runtime model: the sandbox already
 * enforces a read-only root, a /tmp tmpfs and dropped capabilities; `-e`
 * becomes the deployment environment; host bind mounts become runtime files
 * under the managed mount, with references in arguments and environment
 * values rewritten. Anything else stays for the strict runtime parser.
 */
export function importDockerRun(
  args: readonly string[],
  env: Record<string, unknown>,
  literals: Record<string, string> = {},
): DockerRunImport {
  if (args[0] !== "run") return { ok: true, args: [...args], env, files: [] };
  const kept = ["run"];
  const imported: Record<string, unknown> = Object.create(null);
  const targets: string[] = [];
  let index = 1;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      kept.push(arg);
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) break;
    if (arg === "--read-only") continue;
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const option = separator > 0 ? arg.slice(0, separator) : arg;
    if (!VALUE_OPTIONS.has(option)) {
      kept.push(arg);
      continue;
    }
    const value = separator > 0 ? arg.slice(separator + 1) : args[++index];
    if (value === undefined) return issue("unsupportedDockerOption", option);
    switch (option) {
      case "-e":
      case "--env": {
        const assignment = value.indexOf("=");
        imported[assignment < 0 ? value : value.slice(0, assignment)] =
          assignment < 0 ? "" : value.slice(assignment + 1);
        break;
      }
      case "--tmpfs":
        if (value.split(":")[0] !== "/tmp")
          return issue("unsupportedDockerOption", option);
        break;
      case "--cap-drop":
        break;
      case "--security-opt":
        if (!/^no-new-privileges(?:[:=]true)?$/.test(value))
          return issue("unsupportedDockerOption", option);
        break;
      default: {
        const target = bindTarget(option, value);
        if (!target) return issue("unsupportedDockerMount", option);
        targets.push(target);
      }
    }
  }

  const files: McpIntakeFile[] = [];
  const names = new Set<string>();
  for (const target of targets) {
    const name = path.posix.basename(target);
    if (!safeRuntimeFilePath(name) || names.has(name.toLowerCase()))
      return issue("duplicateDockerMount", target);
    names.add(name.toLowerCase());
    files.push({ path: name, target });
  }
  const referenced = new Set<string>();
  const rewrite = (value: string) => {
    const assignment = value.indexOf("=");
    const prefix = assignment > 0 ? value.slice(0, assignment + 1) : "";
    for (const candidate of prefix
      ? [value, value.slice(prefix.length)]
      : [value]) {
      for (const file of files) {
        if (
          candidate === file.target ||
          candidate.startsWith(`${file.target}/`)
        ) {
          referenced.add(file.target);
          const mounted = `${RUNTIME_FILE_MOUNT_PATH}/${file.path}${candidate.slice(file.target.length)}`;
          return candidate === value ? mounted : `${prefix}${mounted}`;
        }
      }
    }
    return value;
  };
  const merged = { ...imported, ...env };
  let opaqueReference = false;
  const rewrittenEnv = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      const binding = /^\$\{([A-Za-z_]\w*)\}$/.exec(value)?.[1];
      if (!binding) return [key, rewrite(value)];
      if (Object.hasOwn(literals, binding))
        literals[binding] = rewrite(literals[binding]);
      else opaqueReference = true; // The sealed variable may name this runtime file.
      return [key, value];
    }),
  );
  const rest = args.slice(index);
  const rewrittenArgs = [
    ...kept,
    ...rest.slice(0, 1),
    ...rest.slice(1).map(rewrite),
  ];
  const unreferenced = files.find((file) => !referenced.has(file.target));
  if (unreferenced && !opaqueReference)
    return issue("unreferencedDockerMount", unreferenced.target);
  return { ok: true, args: rewrittenArgs, env: rewrittenEnv, files };
}
