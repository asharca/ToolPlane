export type ExecutableAgentRuntimeKind = "pi-sdk";
export type HistoricalAgentRuntimeKind = "pi" | "omp" | "claude-code" | "dsh";
export type AgentRuntimeKind =
  | ExecutableAgentRuntimeKind
  | HistoricalAgentRuntimeKind;

export function isExecutableAgentRuntimeKind(
  value: unknown,
): value is ExecutableAgentRuntimeKind {
  return value === "pi-sdk";
}

// Control MCP deliberately exposes only an explicit creation allowlist.
export const AGENT_CONTROL_RUNTIME_KINDS = [
  "pi-sdk",
] as const satisfies readonly ExecutableAgentRuntimeKind[];

export type AgentOptionalBuiltinTool = {
  /** Stable native tool name; never accept module paths from revision data. */
  name: string;
  implementation: "sandbox-extension" | "platform";
};

/** Register only implemented, trusted tools. Optional tools are always opt-in. */
export const AGENT_OPTIONAL_BUILTIN_TOOLS: readonly AgentOptionalBuiltinTool[] =
  [
    { name: "web_search", implementation: "platform" },
    { name: "web_fetch", implementation: "platform" },
    { name: "memory_retain", implementation: "platform" },
    { name: "memory_recall", implementation: "platform" },
    { name: "memory_forget", implementation: "platform" },
    { name: "eval", implementation: "sandbox-extension" },
    { name: "task", implementation: "sandbox-extension" },
    { name: "checkpoint", implementation: "sandbox-extension" },
    { name: "rewind", implementation: "sandbox-extension" },
    { name: "context_notes", implementation: "sandbox-extension" },
    { name: "lsp", implementation: "sandbox-extension" },
    { name: "debug", implementation: "sandbox-extension" },
    { name: "browser", implementation: "sandbox-extension" },
  ];

export type AgentBuiltinFeatureId =
  | "files"
  | "shell"
  | "todo"
  | "web"
  | "browser"
  | "memory"
  | "subtasks"
  | "codeRun"
  | "codeIntel"
  | "rewind";

/**
 * User-facing switches over Pi tools. Each tool belongs to exactly one feature;
 * persisted configuration still stores tool names.
 */
export const AGENT_BUILTIN_FEATURES: readonly {
  id: AgentBuiltinFeatureId;
  tools: readonly string[];
}[] = [
  { id: "files", tools: ["read", "edit", "write", "grep", "find", "ls"] },
  { id: "shell", tools: ["bash"] },
  { id: "todo", tools: ["todo"] },
  { id: "web", tools: ["web_search", "web_fetch"] },
  { id: "browser", tools: ["browser"] },
  {
    id: "memory",
    tools: ["memory_retain", "memory_recall", "memory_forget"],
  },
  { id: "subtasks", tools: ["task"] },
  { id: "codeRun", tools: ["eval"] },
  { id: "codeIntel", tools: ["lsp", "debug"] },
  { id: "rewind", tools: ["checkpoint", "rewind", "context_notes"] },
];

export function agentBuiltinFeatureForTool(tool: string) {
  return AGENT_BUILTIN_FEATURES.find((feature) => feature.tools.includes(tool));
}

export function agentOptionalBuiltinTool(name: string) {
  return AGENT_OPTIONAL_BUILTIN_TOOLS.find((tool) => tool.name === name);
}

/** Reject rather than silently discard unknown authority requested by a caller. */
export function normalizeOptionalBuiltinTools(
  tools: readonly string[] | undefined,
): string[] {
  if (
    tools !== undefined &&
    (!Array.isArray(tools) ||
      tools.length > 1_000 ||
      tools.some(
        (name) => typeof name !== "string" || !agentOptionalBuiltinTool(name),
      ))
  )
    throw new Error("OPTIONAL_BUILTIN_TOOLS_INVALID");
  return [...new Set(tools ?? [])].sort();
}

export function agentOptionalBuiltinToolOptions(
  runtimeKind: ExecutableAgentRuntimeKind,
  enabled: readonly string[] = [],
) {
  // Retain the boundary guard for untyped callers.
  if (!isExecutableAgentRuntimeKind(runtimeKind)) return [];
  return AGENT_OPTIONAL_BUILTIN_TOOLS.map((tool) => ({
    ...tool,
    enabled: enabled.includes(tool.name),
  }));
}

/** Used only for reading historical OMP package members and revisions. */
export const HISTORICAL_OMP_BUILTIN_TOOLS: readonly string[] = [
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "web_search",
  "bash",
  "eval",
  "todo",
  "task",
  "wait",
  "ask",
];

const PI_BUILTIN_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "bash",
  "todo",
] as const;

const GENERIC_PROXY_PROVIDER_FORMATS = new Set([
  "openai",
  "openai-responses",
  "anthropic",
]);

export function agentRuntimeDisplayName(value: string): string {
  if (value === "claude-code") return "Claude Code";
  if (value === "dsh") return "DeepSeek Harness";
  if (value === "pi") return "Pi";
  if (value === "pi-sdk") return "Pi SDK";
  if (value === "omp") return "OMP";
  return value;
}

/** Default-on tools, in the order passed to the executable runtime. */
export function agentRuntimeBuiltinTools(
  runtime: ExecutableAgentRuntimeKind,
): readonly string[] {
  return isExecutableAgentRuntimeKind(runtime) ? PI_BUILTIN_TOOLS : [];
}

export function normalizeDisabledBuiltinTools(
  runtime: ExecutableAgentRuntimeKind,
  tools: readonly string[] | undefined,
): string[] {
  const available = new Set(agentRuntimeBuiltinTools(runtime));
  return [...new Set((tools ?? []).filter((tool) => available.has(tool)))];
}

export function agentRuntimeSupportsProviderFormat(
  runtime: ExecutableAgentRuntimeKind,
  format: string,
): boolean {
  return (
    isExecutableAgentRuntimeKind(runtime) &&
    (GENERIC_PROXY_PROVIDER_FORMATS.has(format) ||
      /^pi:[a-z0-9-]+$/.test(format))
  );
}
