#!/usr/bin/env node
import { readFileSync } from "node:fs";
// Personal account token stays in the process environment, not command argv.
const raw = process.argv.slice(2);
const args = raw.filter((item) => !item.startsWith("--"));
const [command, id, second, third] = args;
const base = new URL(process.env.TOOLPLANE_URL || "http://127.0.0.1:3000");
if (!["https:", "http:"].includes(base.protocol))
  throw new Error("Use an explicit HTTP or HTTPS ToolPlane origin.");
if (base.protocol === "http:")
  console.error(
    "Warning: HTTP sends your account token and sandbox content without encryption. Use only a trusted debugging network.",
  );
if (base.username || base.password || base.search || base.hash)
  throw new Error("Use an origin without credentials or query parameters.");
const token = process.env.TOOLPLANE_API_TOKEN;
if (!token)
  throw new Error("Set TOOLPLANE_API_TOKEN to a personal account API token.");
const enc = (value) => {
  if (!value) throw new Error("A required ID or argument is missing.");
  return encodeURIComponent(value);
};
let method = "GET",
  route,
  body;
switch (command) {
  case "host-keys":
    route = `/api/v1/workspaces/${enc(id)}/sandboxes/ssh/host-keys`;
    method = "POST";
    body = { host: second, port: third ? Number(third) : 22 };
    break;
  case "create-ssh":
    if (!raw.includes("--acknowledge-host-access"))
      throw new Error(
        "Add --acknowledge-host-access only after reviewing the SSH account permissions.",
      );
    route = `/api/v1/workspaces/${enc(id)}/sandboxes/ssh`;
    method = "POST";
    // Credentials come from a local JSON file, never from argv.
    if (!second) throw new Error("A server JSON file is required.");
    body = {
      ...JSON.parse(readFileSync(second, "utf8")),
      acknowledgeHostAccess: true,
    };
    break;
  case "issue-token": {
    route = `/api/v1/sandboxes/${enc(id)}/mcp-tokens`;
    method = "POST";
    const execute = raw.includes("--execute");
    body = {
      name: second || "External agent",
      expiresInDays: 7,
      allowedTools: [
        "sandbox_info",
        "list_dir",
        "read_file",
        "download_file",
        ...(raw.includes("--write") ? ["write_file", "delete_file"] : []),
        ...(execute ? ["shell_exec", "process_exec"] : []),
      ],
      acknowledgeExecutionAccess: execute,
    };
    break;
  }
  case "tokens":
    route = `/api/v1/sandboxes/${enc(id)}/mcp-tokens`;
    break;
  case "revoke":
    route = `/api/v1/sandboxes/${enc(id)}/mcp-tokens/${enc(second)}`;
    method = "DELETE";
    break;
  default:
    throw new Error(
      "Usage: host-keys WORKSPACE_ID HOST [PORT] | create-ssh WORKSPACE_ID SERVER_JSON_FILE --acknowledge-host-access | issue-token SANDBOX_ID NAME [--write] [--execute] | tokens SANDBOX_ID | revoke SANDBOX_ID TOKEN_ID",
    );
}
const response = await fetch(new URL(route, base), {
  method,
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(body ? { "content-type": "application/json" } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(30000),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
