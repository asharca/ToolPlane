/**
 * Client-safe contract for editing an MCP through its original configuration.
 * The server owns parsing, secret extraction, pinning and revisions; the
 * browser only ever sees documents whose secrets are `${KEY}` references.
 */
import type { McpIntakeIssue } from "./mcp-intake-types";

/** Where the original document came from (display and round-trip hints). */
export type McpConfigFormat =
  | "mcp-json"
  | "command"
  | "link"
  | "registry"
  | "url"
  | "preset"
  | "migrated";

export type McpRuntimeTarget = "managed" | "workspace_sandbox";

export type McpConfigVariable = {
  key: string;
  secret: boolean;
  /** A value is stored (never returned). */
  set: boolean;
  /** Referenced by the active document but empty: the MCP stays setup_required. */
  required: boolean;
};

export type McpConfigRevisionSummary = {
  id: string;
  revision: number;
  format: McpConfigFormat;
  createdAt: string;
  createdByName: string | null;
  active: boolean;
};

export type McpRuntimeSandboxOption = {
  id: string;
  name: string;
  /** docker | connector | ssh */
  kind: string;
};

export type McpConfigView = {
  deploymentId: string;
  kind: "remote" | "stdio";
  /** Active original document, pretty JSONC, secrets as `${KEY}`. */
  document: string;
  format: McpConfigFormat;
  activeRevisionId: string;
  /** Top-level fields kept in the document but not used by ToolPlane. */
  ignoredFields: string[];
  variables: McpConfigVariable[];
  /** Locked versions/digests of the active revision, for display. */
  resolved: Array<{ label: string; value: string }>;
  revisions: McpConfigRevisionSummary[];
  runtime: {
    target: McpRuntimeTarget;
    sandboxId: string | null;
    sandboxes: McpRuntimeSandboxOption[];
    /** Arbitrary commands (beyond npx/uvx/uv/docker) need manage capability. */
    canUseArbitraryCommands: boolean;
  };
  samplingEnabled: boolean;
  canManage: boolean;
};

export type McpConfigErrorCode =
  | "notAuthorized"
  | "notFound"
  | "invalidConfig"
  | "arbitraryCommandNotAllowed"
  | "sandboxUnavailable"
  | "mcpVersionResolutionFailed"
  | "kindChangeNotAllowed"
  | "saveFailed";

export type McpConfigFailure = {
  ok: false;
  error: McpConfigErrorCode;
  issue?: McpIntakeIssue;
};

export type McpConfigPreview =
  | {
      ok: true;
      /** Normalized document that will be stored (secrets replaced). */
      document: string;
      /** Keys whose literal values will move into sealed variables. */
      extractedSecrets: string[];
      ignoredFields: string[];
      /** Variables referenced but without a value after save. */
      missingVariables: string[];
      /** Line-level change summary against the active revision. */
      changes: Array<{ type: "added" | "removed"; line: string }>;
      restartRequired: boolean;
    }
  | McpConfigFailure;

export type McpConfigSaveResult =
  | {
      ok: true;
      revisionId: string;
      revision: number;
      status: "provisioning" | "setup_required" | "stopped";
    }
  | McpConfigFailure;

/*
 * Server actions (src/lib/workspace/mcp-config-actions.ts, "use server"):
 *   getMcpConfigAction({ workspace, deploymentId }): Promise<{ ok: true; view: McpConfigView } | McpConfigFailure>
 *   previewMcpConfigAction({ workspace, deploymentId, document }): Promise<McpConfigPreview>
 *   saveMcpConfigAction({ workspace, deploymentId, document, values?: Record<string, string> }): Promise<McpConfigSaveResult>
 *   setMcpVariablesAction({ workspace, deploymentId, values: Record<string, string>, remove?: string[] }): Promise<McpConfigSaveResult>
 *   rollbackMcpConfigAction({ workspace, deploymentId, revisionId }): Promise<McpConfigSaveResult>
 *   updateMcpDependenciesAction({ workspace, deploymentId }): Promise<McpConfigSaveResult>
 *   setMcpRuntimeTargetAction({ workspace, deploymentId, target, sandboxId? }): Promise<McpConfigSaveResult>
 *   setMcpSamplingAction({ workspace, deploymentId, enabled }): Promise<{ ok: true } | McpConfigFailure>
 * All mutations require "resources" capability; reads require "read".
 */
