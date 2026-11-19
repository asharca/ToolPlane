import { defineFailures, type FailureCodeOf } from "@/lib/errors/registry";

export const a2aFailures = defineFailures({
  BROWSER_ORIGIN_FORBIDDEN:
    "Browser origins are not supported by this A2A interface.",
  ENDPOINT_CREDENTIAL_REQUIRED:
    "A valid Agent Endpoint credential is required.",
  A2A_PERMISSION_REQUIRED: "A2A permission is required.",
  SERVICE_NOT_FOUND: "Agent service not found.",
  MISSING_CREDENTIAL: "Missing credential.",
  CREDENTIAL_EXPIRY_REQUIRED: "The credential has no expiry.",
  CONSOLE_CREDENTIAL_REQUIRED:
    "Use the console session, not an API credential.",
  SAME_ORIGIN_REQUIRED: "Same-origin request required.",
  CONSOLE_SIGN_IN_REQUIRED: "Sign in to the console.",
  WORKSPACE_UNAVAILABLE: "Workspace unavailable.",
  JSON_REQUIRED: "Expected JSON.",
  INVALID_CONSOLE_REQUEST: "Invalid A2A console request.",
  INVALID_FILE_RETRY: "Invalid file retry request.",
  INVALID_TASK_QUERY: "Invalid task query.",
  INVALID_CONTEXT_QUERY: "Invalid context query.",
  OBSERVER_LIMIT: "Too many active task observers.",
  ADMISSION_FULL: "Request admission is full.",
  REQUEST_RATE_LIMIT: "Too many A2A requests.",
  INVALID_REMOTE_URL: "Invalid remote HTTPS address.",
  REMOTE_URL_RESTRICTED:
    "Remote addresses require HTTPS without credentials, query or fragment.",
  REMOTE_ALLOWLIST_REQUIRED: "Configure the remote Agent origin allowlist.",
  REMOTE_ORIGIN_FORBIDDEN:
    "The deployment administrator has not allowed this remote origin.",
  REMOTE_ADDRESS_FORBIDDEN:
    "Private or reserved remote addresses are not allowed.",
  REMOTE_PATHS_INVALID:
    "Card and RPC addresses must be distinct paths on the same approved origin.",
  NETWORK_BLOCKED: "Remote DNS resolved to a prohibited address.",
  REMOTE_REQUEST_TOO_LARGE: "Remote request size limit exceeded.",
  INVALID_REMOTE_CREDENTIAL: "Invalid remote credential.",
  REMOTE_TARGET_CHANGED: "Remote transport target changed.",
  INVALID_REMOTE_RESPONSE:
    "Remote output is not a valid supported A2A response.",
  REMOTE_CAPACITY: "Remote connection capacity reached.",
  INVALID_FILE_URL: "Invalid file HTTPS address.",
  FILE_URL_RESTRICTED:
    "File addresses require HTTPS without credentials or fragment.",
  FILE_DOWNLOAD_REJECTED: "File download was rejected.",
  FILE_DOWNLOAD_FAILED: "File download failed.",
  INVALID_CARD_SIZE: "Invalid or oversized Agent Card.",
  INVALID_CARD_STRUCTURE: "Invalid remote Agent Card structure.",
  CARD_MIME_REQUIRED:
    "Remote Agent must declare valid input and output MIME capabilities.",
  CARD_RPC_ADDRESS_REQUIRED:
    "Card must declare the exact approved A2A 1.0 JSONRPC address.",
  CARD_EXTENSION_UNSUPPORTED: "Required remote extensions are not supported.",
  CARD_AUTH_UNSUPPORTED:
    "The remote Agent requires an unsupported authentication flow.",
  INVALID_CARD_JSON: "Remote Agent Card is not valid JSON.",
  REMOTE_PART_UNSUPPORTED: "Remote output contains an unsupported Part.",
  REMOTE_OUTPUT_LIMIT: "Remote output limit exceeded.",
  INVALID_REMOTE_MESSAGE: "Invalid remote message.",
  INVALID_REMOTE_TASK: "Invalid remote task.",
  PUBLISHED_EXECUTION_RETIRED:
    "Published legacy execution is retired; retained tasks are read-only.",
  PUBLISHED_LEASE_RETIRED:
    "Published legacy execution cannot acquire a new lease.",
  REMOTE_TASK_BINDING_CHANGED: "Remote task binding changed.",
  REMOTE_OUTPUT_MIME_UNNEGOTIATED:
    "Remote output MIME type was not negotiated.",
  REMOTE_ARTIFACT_LIMIT: "Remote artifact limit exceeded.",
  REMOTE_INPUT_MIME_UNSUPPORTED:
    "Remote Agent does not accept an input MIME type.",
  REMOTE_FILE_BINDING_CHANGED: "Remote file source binding changed.",
  OPERATION_FORBIDDEN: "A2A operation is not permitted.",
  INVALID_MCP_REQUEST: "Invalid MCP request.",
  CREDENTIALS_IN_CONTENT: "Credentials are not task content.",
  REQUEST_TOO_LARGE: "Request body too large.",
  JSON_CONTENT_TYPE_REQUIRED: "Content-Type must be application/json.",
  FILE_RETRY_GET_TASK_ONLY: "A2A-Retry-Files: true is only valid with GetTask.",
  REQUIRED_PERMISSION_MISSING: "Required A2A permission is missing.",
  AGENT_UNAVAILABLE: "Agent unavailable.",
  WORKSPACE_OWNER_OR_ADMIN_REQUIRED:
    "Workspace owner or administrator required.",
  RETIRED_AGENT_READ_ONLY: "Retired Agent execution is read-only.",
  RETAINED_ENDPOINT_UNAVAILABLE: "Retained endpoint unavailable.",
  KEY_UNAVAILABLE: "A2A key unavailable.",
  WORKSPACE_ADMIN_REQUIRED: "Workspace administrator required.",
  REMOTE_AGENT_LIMIT: "Remote Agent limit reached.",
  REMOTE_CONFIG_CHANGED:
    "Remote configuration changed. Refresh before retrying.",
  REMOTE_AUTHORIZATION_LIMIT: "Remote Agent authorization limit reached.",
  INVALID_REMOTE_REGISTRATION: "Invalid remote Agent registration.",
  SERVER_ACCOUNT_REQUIRED: "Use a server-side account credential.",
  ACCOUNT_BEARER_REQUIRED: "An account-level Bearer credential is required.",
  INVALID_LOCAL_CONFIG: "Invalid local Agent configuration.",
  ADMIN_AUTHORITY_CHANGED: "Workspace administrator authority changed.",
  CONSOLE_SESSION_REQUIRED: "Use the console session.",
  UNAUTHORIZED: "Unauthorized",
  CONVERSATION_EXECUTION_PINNED: "Conversation determines the execution.",
  LEGACY_AGENT_EXECUTION_RETIRED:
    "Legacy published Agent execution is retired. Register a new Pi Agent capability client.",
  COMMUNICATION_DISABLED: "Communication is disabled.",
  OPTIONAL_BUILTIN_DISABLED: "Optional built-in tool is not enabled.",
  REMOTE_TASK_FAILED: "The remote Agent task failed.",
  REMOTE_TASK_REJECTED: "The remote Agent rejected the task.",
  REMOTE_REQUEST_FAILED:
    "The remote Agent request could not be verified or completed.",
  CARD_RPC_AMBIGUOUS:
    "Multiple compatible RPC addresses. Specify an advanced RPC URL.",
  CARD_RPC_UNAVAILABLE:
    "Card has no compatible same-origin A2A 1.0 JSONRPC address.",
});

export type A2AReason = FailureCodeOf<typeof a2aFailures>;
