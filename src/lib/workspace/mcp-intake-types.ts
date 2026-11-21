/**
 * Client-safe contract for the "add MCP" intake flow. The server always
 * re-analyzes the original source on creation; drafts sent to the browser are
 * display data, never trusted configuration.
 */
import type { ConnectorPresetId } from "@/lib/connectors/presets";

export type McpIntakeField = {
  /** Environment key that stores the value (`[A-Za-z_][A-Za-z0-9_]*`). */
  key: string;
  /** Display label: header name, environment name or preset label. */
  label: string;
  /** Plain text from a preset or registry record, at most 300 characters. */
  description?: string;
  secret: boolean;
  required: boolean;
  /** Non-secret default only. */
  default?: string;
  choices?: string[];
  /** HTTPS page where the user creates this credential (presets only). */
  helpUrl?: string;
};

/**
 * How ToolPlane can identify itself to the authorization server:
 * an admin-registered client, a Client ID Metadata Document, dynamic
 * registration, or none yet (an admin must register a client first).
 */
export type McpOAuthClientAvailability =
  | "registered"
  | "metadata"
  | "dynamic"
  | "missing";

export type McpIntakeAuth =
  | { type: "none" }
  | { type: "static" }
  | {
      type: "oauth";
      issuer: string | null;
      client: McpOAuthClientAvailability;
    };

export type McpIntakeOrigin =
  | "preset"
  | "registry"
  | "url"
  | "json"
  | "command"
  | "link";

export type McpIntakeReachability = "ok" | "auth" | "unreachable" | "skipped";

export type McpIntakeDraft = {
  /** Stable within one analysis result. */
  id: string;
  name: string;
  kind: "remote" | "stdio";
  /** Remote host + path, or the launch command, for display. */
  summary: string;
  origin: McpIntakeOrigin;
  presetId?: ConnectorPresetId;
  registryName?: string;
  auth: McpIntakeAuth;
  reachability: McpIntakeReachability;
  /** Only values the user still has to provide. */
  fields: McpIntakeField[];
  /** stdio only. */
  network?: "isolated" | "none";
  /**
   * Files the original launch bind-mounted from the host. Each must be supplied
   * as a runtime file at `path` (or beneath it for a directory); references to
   * `target` were rewritten to the managed runtime mount.
   */
  files?: McpIntakeFile[];
  /** Plain-HTTP remote endpoint; creation needs consent unless the admin allows HTTP. */
  insecureHttp: boolean;
  /** Canonical single-server JSON with credentials replaced by `${KEY}` references. */
  config: string;
  /** Client-only top-level fields kept in the document but not used by ToolPlane. */
  ignoredFields?: string[];
};

export type McpIntakeFile = { path: string; target: string };

/** A specific, translatable reason the source could not be imported. */
export type McpIntakeIssue = {
  code:
    | "invalidJson"
    | "invalidJsonLine"
    | "unsupportedField"
    | "unsupportedCommand"
    | "invalidDockerImage"
    | "unsupportedDockerOption"
    | "unsupportedDockerMount"
    | "unreferencedDockerMount"
    | "duplicateDockerMount";
  /** Short echo of the offending option, field, path or line (≤120 chars). */
  value?: string;
};

export type McpIntakeErrorCode =
  | "notAuthorized"
  | "empty"
  | "unrecognized"
  | "arbitraryCommandNotAllowed"
  | "invalidConfig"
  | "tooManyServers"
  | "unsupportedRegistryEntry"
  | "registryUnavailable";

export type McpIntakeResult =
  | { ok: true; drafts: McpIntakeDraft[] }
  | {
      ok: false;
      error: McpIntakeErrorCode;
      issue?: McpIntakeIssue;
      detail?: string;
    };

export type McpIntakeSource =
  | { kind: "text"; text: string }
  | { kind: "preset"; presetId: ConnectorPresetId }
  | { kind: "registry"; name: string; version: string };

export type McpRegistryItem = {
  name: string;
  version: string;
  title: string;
  description: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  kinds: Array<"remote" | "npm" | "pypi" | "oci">;
  /** False when no remote or package can be mapped to a ToolPlane recipe. */
  supported: boolean;
};

export type McpRegistrySearchResult =
  | { ok: true; items: McpRegistryItem[]; nextCursor: string | null }
  | { ok: false; error: "notAuthorized" | "registryUnavailable" };

export type McpIntakeCreateItem = {
  id: string;
  name: string;
  /** Keyed by McpIntakeField.key; blank values are ignored. */
  values: Record<string, string>;
  network?: "isolated" | "none";
  runtimeFiles?: Array<{ path: string; content: string }>;
  allowUnsafeHttp?: boolean;
  /**
   * "oauth" (only for drafts with auth.type "oauth") creates the deployment
   * unauthenticated as setup_required; when a client is available the result
   * carries an OAuth start URL. The draft's token fields are then ignored.
   */
  authMode?: "token" | "oauth";
};

export type McpIntakeCreateErrorCode =
  | McpIntakeErrorCode
  | "itemNotFound"
  | "invalidRuntimeFile"
  | "runtimeFileRequired"
  | "unsafeHttpConfirmationRequired"
  | "mcpVersionResolutionFailed"
  | "connectionCreateFailed";

export type McpIntakeCreateResult =
  | {
      ok: true;
      deployments: Array<{
        id: string;
        /** "error": the row is committed but its runtime start failed. */
        status: "provisioning" | "setup_required" | "error";
        /** Same-origin path that begins the OAuth sign-in (authMode "oauth"). */
        oauthStartUrl?: string;
      }>;
    }
  | {
      ok: false;
      error: McpIntakeCreateErrorCode;
      itemId?: string;
      issue?: McpIntakeIssue;
      detail?: string;
    };
