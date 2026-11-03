import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

// Pi 0.87.1's static semantics, kept local because Pi exposes no safe parser
// subpath export. Do not import its executable index into the web process.
function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const end = normalized.startsWith("---")
    ? normalized.indexOf("\n---", 3)
    : -1;
  if (end === -1) return { frontmatter: {}, body: normalized };
  const yaml = normalized.slice(4, end);
  if (!yaml) return { frontmatter: {}, body: normalized };
  return {
    frontmatter: parseYaml(yaml) ?? {},
    body: normalized.slice(end + 4).trim(),
  };
}

function parseCommandArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: string[]): string {
  const all = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      target: string,
      fallback: string,
      start: string,
      length: string,
      simple: string,
    ) => {
      if (target)
        return (
          (target === "@" || target === "ARGUMENTS"
            ? all
            : args[Number.parseInt(target, 10) - 1]) || fallback
        );
      if (start) {
        const index = Math.max(0, Number.parseInt(start, 10) - 1);
        return args
          .slice(
            index,
            length ? index + Number.parseInt(length, 10) : undefined,
          )
          .join(" ");
      }
      return simple === "@" || simple === "ARGUMENTS"
        ? all
        : (args[Number.parseInt(simple, 10) - 1] ?? "");
    },
  );
}

export type PromptTemplateSource = {
  /** Immutable release/content identity, not a workspace resource ID. */
  identity: string;
  path: string;
  version?: string | null;
  checksum?: string;
};
export type PromptTemplateRequirements = {
  skills?: string[];
  extensions?: string[];
  commands?: string[];
  localFiles?: string[];
  shell?: boolean;
};
export type ParsedPromptTemplate = {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  metadata: Record<string, unknown>;
  source: PromptTemplateSource & { checksum: string };
  requirements: PromptTemplateRequirements;
  assistantCompatible: boolean;
  incompatibilities: string[];
};

/** Parse immutable Markdown with Pi 0.87.1 frontmatter/name/description semantics.
 * Dependencies are explicit `toolplane.requires` frontmatter (or supplied requirements),
 * never inferred from prose. Invalid/unknown required semantics fail closed.
 */
export function parsePromptTemplate(
  markdown: string,
  source: PromptTemplateSource,
  requirements?: PromptTemplateRequirements,
): ParsedPromptTemplate {
  if (
    !source.identity ||
    !source.path.endsWith(".md") ||
    source.path.startsWith("/") ||
    source.path.split("/").some((part) => part === ".." || !part) ||
    source.path.includes("\\")
  )
    throw new Error("prompt_source_invalid");
  const checksum = createHash("sha256").update(markdown).digest("hex");
  if (source.checksum && source.checksum !== checksum)
    throw new Error("prompt_checksum_mismatch");
  const { frontmatter: metadata, body } = parseFrontmatter(markdown);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("prompt_frontmatter_invalid");
  const toolplane = metadata.toolplane;
  if (
    toolplane !== undefined &&
    (!toolplane || typeof toolplane !== "object" || Array.isArray(toolplane))
  )
    throw new Error("prompt_requirements_invalid");
  const declared =
    (toolplane as { requires?: unknown } | undefined)?.requires ?? {};
  const incompatibilities: string[] = [];
  const combined: PromptTemplateRequirements = {};
  for (const value of [declared, requirements ?? {}]) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("prompt_requirements_invalid");
    for (const [key, requirement] of Object.entries(value)) {
      if (key === "shell") {
        if (typeof requirement !== "boolean")
          throw new Error("prompt_requirements_invalid");
        combined.shell ||= requirement;
      } else if (
        ["skills", "extensions", "commands", "localFiles"].includes(key)
      ) {
        if (
          !Array.isArray(requirement) ||
          requirement.some((item) => typeof item !== "string" || !item)
        )
          throw new Error("prompt_requirements_invalid");
        const name = key as "skills" | "extensions" | "commands" | "localFiles";
        combined[name] = [
          ...new Set([...(combined[name] ?? []), ...requirement]),
        ];
      } else incompatibilities.push(`Unsupported requirement: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(combined))
    if (value === true || (Array.isArray(value) && value.length))
      incompatibilities.push(`Requires Agent capability: ${key}`);
  const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
  const description =
    typeof metadata.description === "string" && metadata.description
      ? metadata.description
      : firstLine.slice(0, 60) + (firstLine.length > 60 ? "..." : "");
  return {
    name: posix.basename(source.path).replace(/\.md$/, ""),
    description,
    ...(typeof metadata["argument-hint"] === "string" &&
    metadata["argument-hint"]
      ? { argumentHint: metadata["argument-hint"] }
      : {}),
    content: body,
    metadata,
    source: { ...source, checksum },
    requirements: combined,
    assistantCompatible: incompatibilities.length === 0,
    incompatibilities,
  };
}

/** Expand a selected template once using native Pi quoting, positional/default/slice
 * semantics. `args` is raw command arguments or already tokenized arguments.
 * Returns user-input text only; never evaluates shell, JS, environment or files.
 */
export function expandPromptTemplate(
  template: ParsedPromptTemplate,
  args: string | readonly string[],
): string {
  return substituteArgs(
    template.content,
    typeof args === "string" ? parseCommandArgs(args) : [...args],
  );
}
