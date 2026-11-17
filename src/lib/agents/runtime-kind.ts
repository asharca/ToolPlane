export const AGENT_RUNTIME_KINDS = [
  "pi",
  "pi-sdk",
  "omp",
  "claude-code",
  "dsh",
] as const;

export type AgentRuntimeKind = (typeof AGENT_RUNTIME_KINDS)[number];
export type ImplementedAgentRuntimeKind = AgentRuntimeKind;
export type SandboxHarnessRuntimeKind = Extract<
  AgentRuntimeKind,
  "claude-code" | "dsh"
>;
export type DedicatedSandboxRuntimeKind = Extract<
  AgentRuntimeKind,
  "pi" | "pi-sdk" | "omp" | "claude-code" | "dsh"
>;
export type WorkRuntimeKind = DedicatedSandboxRuntimeKind;
export type ExecutableAgentRuntimeKind = "pi-sdk";

export function isExecutableAgentRuntimeKind(
  value: unknown,
): value is ExecutableAgentRuntimeKind {
  return value === "pi-sdk";
}

// Explicit public capability inventory. Entry-point subsets are intentional:
// console support does not automatically grant creation through Control MCP.
export const AGENT_CONTROL_RUNTIME_KINDS = [
  "pi-sdk",
] as const satisfies readonly AgentRuntimeKind[];
export const AGENT_RUNTIME_CAPABILITIES = {
  pi: {
    sandbox: true,
    providerBinding: "single",
    attachments: false,
    terminal: true,
    publicEndpoint: false,
  },
  "claude-code": {
    sandbox: true,
    providerBinding: "single",
    attachments: false,
    terminal: true,
    publicEndpoint: false,
  },
  dsh: {
    sandbox: true,
    providerBinding: "single",
    attachments: false,
    terminal: true,
    publicEndpoint: false,
  },
  omp: {
    sandbox: true,
    providerBinding: "single",
    attachments: false,
    terminal: false,
    publicEndpoint: false,
  },
  "pi-sdk": {
    sandbox: true,
    providerBinding: "single",
    attachments: false,
    terminal: true,
    publicEndpoint: false,
  },
} as const satisfies Record<
  AgentRuntimeKind,
  {
    sandbox: boolean;
    providerBinding: "single" | "multiple";
    attachments: boolean;
    terminal: boolean;
    publicEndpoint: boolean;
  }
>;

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

export function agentOptionalBuiltinTools(value: unknown) {
  return isExecutableAgentRuntimeKind(value)
    ? AGENT_OPTIONAL_BUILTIN_TOOLS
    : [];
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
  runtimeKind: unknown,
  enabled: readonly string[] = [],
) {
  return agentOptionalBuiltinTools(runtimeKind).map((tool) => ({
    ...tool,
    enabled: enabled.includes(tool.name),
  }));
}

const AGENT_RUNTIME_BUILTIN_TOOLS: Record<AgentRuntimeKind, readonly string[]> =
  {
    pi: ["read", "edit", "write", "grep", "find", "ls", "bash"],
    "pi-sdk": ["read", "edit", "write", "grep", "find", "ls", "bash", "todo"],
    omp: [
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
    ],
    "claude-code": [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash",
      "Workflow",
    ],
    dsh: [
      "read",
      "read_image",
      "edit",
      "write",
      "str_replace_editor",
      "glob",
      "grep",
      "web_search",
      "bash",
      "job_output",
      "job_list",
      "job_kill",
      "todo_write",
      "skill",
      "get_goal",
      "create_goal",
      "update_goal",
      "exit_plan_mode",
      "subagent",
      "subagent_fork",
      "send_message",
      "interrupt_agent",
      "list_agents",
      "workflow",
      "ralph",
    ],
  };

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

export function implementedAgentRuntimeKind(
  value: unknown,
): ImplementedAgentRuntimeKind | null {
  return typeof value === "string" &&
    (AGENT_RUNTIME_KINDS as readonly string[]).includes(value)
    ? (value as ImplementedAgentRuntimeKind)
    : null;
}

export function agentRuntimeCapabilities(value: unknown) {
  const kind = implementedAgentRuntimeKind(value);
  return kind ? AGENT_RUNTIME_CAPABILITIES[kind] : null;
}

/** Default-on tools of a runtime, in the order passed to the runtime. */
export function agentRuntimeBuiltinTools(value: unknown): readonly string[] {
  const kind = implementedAgentRuntimeKind(value);
  return kind ? AGENT_RUNTIME_BUILTIN_TOOLS[kind] : [];
}

export function normalizeDisabledBuiltinTools(
  value: unknown,
  tools: readonly string[] | undefined,
): string[] {
  const available = new Set(agentRuntimeBuiltinTools(value));
  return [...new Set((tools ?? []).filter((tool) => available.has(tool)))];
}

export function isSandboxHarnessRuntimeKind(
  value: unknown,
): value is SandboxHarnessRuntimeKind {
  return value === "claude-code" || value === "dsh";
}

export function isDedicatedSandboxRuntimeKind(
  value: unknown,
): value is DedicatedSandboxRuntimeKind {
  return agentRuntimeCapabilities(value)?.providerBinding === "single";
}

export function isWorkRuntimeKind(value: unknown): value is WorkRuntimeKind {
  return agentRuntimeCapabilities(value)?.sandbox === true;
}

export function agentRuntimeSupportsProviderFormat(
  runtime: string,
  format: string,
): boolean {
  return (
    isExecutableAgentRuntimeKind(runtime) &&
    GENERIC_PROXY_PROVIDER_FORMATS.has(format)
  );
}
