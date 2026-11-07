import { readCapabilities } from "./capabilities";

export const pluginResourceKinds = [
  "skills",
  "prompts",
  "extensions",
  "themes",
  "hooks",
  "tools",
  "commands",
  "subagents",
] as const;

export type PluginResourceKind = (typeof pluginResourceKinds)[number];

export type PluginReleaseContents = {
  counts: Array<{ kind: PluginResourceKind; count: number }>;
  mcp: number;
  omp: boolean;
};

/** Release summaries are stored JSON; read only the fields list views show. */
export function releaseContents(summary: unknown): PluginReleaseContents {
  const record =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)
      : {};
  const resources =
    record.resources &&
    typeof record.resources === "object" &&
    !Array.isArray(record.resources)
      ? (record.resources as Record<string, unknown>)
      : {};
  const runtime =
    record.runtime &&
    typeof record.runtime === "object" &&
    !Array.isArray(record.runtime)
      ? (record.runtime as Record<string, unknown>)
      : {};
  return {
    counts: pluginResourceKinds.flatMap((kind) => {
      const items = resources[kind];
      return Array.isArray(items) && items.length
        ? [{ kind, count: items.length }]
        : [];
    }),
    mcp: readCapabilities(summary)?.mcp.length ?? 0,
    omp: runtime.kind === "omp",
  };
}
