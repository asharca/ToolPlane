import "server-only";

export const WEB_TOOL_FAILURES = {
  WEB_TOOL_INVALID_ARGUMENTS: "Web tool arguments are invalid.",
  WEB_TOOL_TIMEOUT: "The web request timed out.",
  WEB_TOOL_CANCELLED: "The web request was cancelled.",
  WEB_SEARCH_FAILED: "The web search could not be completed.",
  WEB_SEARCH_UNREADABLE_RESULT:
    "The search provider returned no readable source results.",
  WEB_FETCH_INVALID_URL:
    "A public HTTP or HTTPS URL without credentials is required.",
  WEB_FETCH_NETWORK_BLOCKED:
    "Private, loopback, link-local and reserved network addresses are not allowed.",
  WEB_FETCH_REDIRECT_LIMIT: "The page exceeded the redirect limit.",
  WEB_FETCH_RESPONSE_TOO_LARGE: "The page exceeded the response size limit.",
  WEB_FETCH_UNSUPPORTED_CONTENT:
    "The page is not a supported uncompressed text response.",
  WEB_FETCH_HTTP_ERROR: "The page returned an unsuccessful HTTP status.",
  WEB_FETCH_FAILED: "The page could not be fetched safely.",
} as const;

export class WebToolError extends Error {
  constructor(readonly reason: keyof typeof WEB_TOOL_FAILURES) {
    super(WEB_TOOL_FAILURES[reason]);
  }
}

export function isWebTool(name: string): boolean {
  return name === "web_search" || name === "web_fetch";
}
