export const SANDBOX_MCP_TOOLS = [
  "sandbox_info",
  "list_dir",
  "read_file",
  "download_file",
  "write_file",
  "delete_file",
  "shell_exec",
  "process_exec",
] as const;
export type SandboxMcpTool = (typeof SANDBOX_MCP_TOOLS)[number];
export const SANDBOX_MCP_READ_TOOLS: SandboxMcpTool[] = [
  "sandbox_info",
  "list_dir",
  "read_file",
  "download_file",
];
export function isSandboxMcpTool(value: string): value is SandboxMcpTool {
  return (SANDBOX_MCP_TOOLS as readonly string[]).includes(value);
}
export function sandboxMcpExportable(sandbox: {
  kind: string;
  config?: unknown;
}): boolean {
  const config = sandbox.config;
  if (
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "readOnly" in config &&
    config.readOnly === true
  )
    return false;
  return (
    sandbox.kind === "docker" ||
    sandbox.kind === "connector" ||
    sandbox.kind === "ssh"
  );
}
export function normalizeSandboxMcpTools(raw: unknown): SandboxMcpTool[] {
  if (raw === undefined) return [...SANDBOX_MCP_READ_TOOLS];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > SANDBOX_MCP_TOOLS.length ||
    raw.some((name) => typeof name !== "string" || !isSandboxMcpTool(name))
  ) {
    throw new Error("Invalid sandbox MCP tool permissions.");
  }
  return [...new Set(raw)] as SandboxMcpTool[];
}
