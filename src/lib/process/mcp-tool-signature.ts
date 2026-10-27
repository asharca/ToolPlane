import { createHash } from "node:crypto";
import type { McpToolDefinition } from "./mcp-tool-catalog";

/** The content fields that define a tool's behavior; `name` identifies the
 * tool slot itself (a name change is handled as delete+new elsewhere), so it
 * is intentionally excluded from the signature. */
export type McpToolSignatureSnapshot = Pick<
  McpToolDefinition,
  "description" | "inputSchema" | "outputSchema" | "annotations"
>;

function snapshotOf(tool: McpToolSignatureSnapshot): McpToolSignatureSnapshot {
  return {
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

/** Stable hash over the fields that matter for "has this tool's contract
 * changed since it was approved". Excludes `name` by design. */
export function mcpToolSignature(tool: McpToolSignatureSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(snapshotOf(tool)))
    .digest("hex");
}

export type PendingMcpToolChange = {
  previousSignature: string;
  currentSignature: string;
  previous: McpToolSignatureSnapshot;
  current: McpToolSignatureSnapshot;
  detectedAt: string;
};

export type ApprovedToolSignatures = Record<string, string>;
export type PendingToolChanges = Record<string, PendingMcpToolChange>;

function isApprovedToolSignatures(
  value: unknown,
): value is ApprovedToolSignatures {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseApprovedToolSignatures(
  value: unknown,
): ApprovedToolSignatures {
  if (!isApprovedToolSignatures(value)) return {};
  const result: ApprovedToolSignatures = {};
  for (const [name, signature] of Object.entries(value))
    if (typeof signature === "string") result[name] = signature;
  return result;
}

function isPendingMcpToolChange(value: unknown): value is PendingMcpToolChange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.previousSignature === "string" &&
    typeof candidate.currentSignature === "string" &&
    typeof candidate.detectedAt === "string" &&
    typeof candidate.previous === "object" &&
    candidate.previous !== null &&
    typeof candidate.current === "object" &&
    candidate.current !== null
  );
}

export function parsePendingToolChanges(value: unknown): PendingToolChanges {
  if (!isApprovedToolSignatures(value)) return {};
  const result: PendingToolChanges = {};
  for (const [name, change] of Object.entries(value))
    if (isPendingMcpToolChange(change)) result[name] = change;
  return result;
}

/** Compute the next `{approvedToolSignatures, pendingToolChanges}` pair for one
 * grant row given its live tool catalog. Pure: callers persist the result.
 * - First-time approvals (no stored signature yet) are baselined silently.
 * - A live signature that regresses back to the approved baseline clears any
 *   pending flag.
 * - Otherwise a drift is recorded in `pendingToolChanges` and the approved
 *   baseline is left untouched until explicit re-approval. */
export function reconcileMcpToolApproval(input: {
  allowedToolNames: readonly string[];
  liveTools: ReadonlyMap<string, McpToolDefinition>;
  previousTools: ReadonlyMap<string, McpToolDefinition>;
  approvedToolSignatures: unknown;
  pendingToolChanges: unknown;
  now?: Date;
}): {
  changed: boolean;
  approvedToolSignatures: ApprovedToolSignatures;
  pendingToolChanges: PendingToolChanges;
} {
  const approved = {
    ...parseApprovedToolSignatures(input.approvedToolSignatures),
  };
  const pending = { ...parsePendingToolChanges(input.pendingToolChanges) };
  let changed = false;
  const nowIso = (input.now ?? new Date()).toISOString();
  for (const toolName of input.allowedToolNames) {
    const liveTool = input.liveTools.get(toolName);
    if (!liveTool) continue; // deletion is handled by the allowlist/live-name check elsewhere
    const currentSignature = mcpToolSignature(liveTool);
    const approvedSignature = approved[toolName];
    if (approvedSignature === undefined) {
      approved[toolName] = currentSignature;
      if (pending[toolName]) {
        delete pending[toolName];
      }
      changed = true;
      continue;
    }
    if (approvedSignature === currentSignature) {
      if (pending[toolName]) {
        delete pending[toolName];
        changed = true;
      }
      continue;
    }
    const existing = pending[toolName];
    if (
      existing &&
      existing.previousSignature === approvedSignature &&
      existing.currentSignature === currentSignature
    )
      continue; // already recorded exactly this drift
    const previousTool = input.previousTools.get(toolName) ?? liveTool;
    pending[toolName] = {
      previousSignature: approvedSignature,
      currentSignature,
      previous: existing?.previous ?? snapshotOf(previousTool),
      current: snapshotOf(liveTool),
      detectedAt: existing?.detectedAt ?? nowIso,
    };
    changed = true;
  }
  return {
    changed,
    approvedToolSignatures: approved,
    pendingToolChanges: pending,
  };
}
