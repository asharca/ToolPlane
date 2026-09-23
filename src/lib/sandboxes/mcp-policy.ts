export const SANDBOX_MCP_TOOLS = [
  'sandbox_info', 'list_dir', 'read_file', 'download_file',
  'write_file', 'delete_file', 'shell_exec', 'process_exec',
] as const;
export type SandboxMcpTool = typeof SANDBOX_MCP_TOOLS[number];
export const SANDBOX_MCP_READ_TOOLS: SandboxMcpTool[] = ['sandbox_info', 'list_dir', 'read_file', 'download_file'];
export function isSandboxMcpTool(value: string): value is SandboxMcpTool {
  return (SANDBOX_MCP_TOOLS as readonly string[]).includes(value);
}
export function sandboxMcpExportable(kind: string): boolean {
  // Hermes shares a credential-bearing private runtime volume; do not export
  // it until its file and process boundary is separated from that volume.
  return kind === 'docker' || kind === 'connector' || kind === 'ssh';
}
export function normalizeSandboxMcpTools(raw: unknown): SandboxMcpTool[] {
  if (raw === undefined) return [...SANDBOX_MCP_READ_TOOLS];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SANDBOX_MCP_TOOLS.length
    || raw.some((name) => typeof name !== 'string' || !isSandboxMcpTool(name))) {
    throw new Error('Invalid sandbox MCP tool permissions.');
  }
  return [...new Set(raw)] as SandboxMcpTool[];
}
