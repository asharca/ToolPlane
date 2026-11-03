import { createHash } from "node:crypto";
import { posix } from "node:path";

export type AgentSessionIdentity = {
  conversationId?: string;
  a2aContextId?: string;
};

/** A session keeps the complete legacy workspace layout beneath its own root. */
export function agentSessionWorkspaceRoot(
  identity: AgentSessionIdentity,
): string {
  const id = identity.conversationId ?? identity.a2aContextId;
  if (typeof id !== "string" || !id || id.length > 1_000 || id.includes("\0"))
    throw new Error("Conversation or native context is required.");
  const kind = identity.conversationId ? "conversation" : "context";
  return `/workspace/conversations/${kind}-${createHash("sha256").update(id).digest("hex")}`;
}

/** Legacy /workspace paths are session-relative; already-scoped paths stay scoped. */
export function agentSessionWorkingDirectory(
  identity: AgentSessionIdentity,
  value?: unknown,
): string {
  const root = agentSessionWorkspaceRoot(identity);
  if (value == null || value === "") return root;
  if (typeof value !== "string" || value.length > 1_000 || value.includes("\0"))
    throw new Error("Invalid sandbox working directory.");
  let input = value.trim().replace(/\\/g, "/") || ".";
  if (input === root || input.startsWith(`${root}/`)) {
    input = input.slice(root.length).replace(/^\//, "") || ".";
  } else {
    // Never reinterpret another session's absolute path as a local subdirectory.
    if (/^\/workspace\/conversations(?:\/|$)/.test(input))
      throw new Error(
        "Sandbox working directory must be under this session workspace.",
      );
    input = input.replace(/^\/workspace(?:\/|$)/, "") || ".";
    if (input.startsWith("/"))
      throw new Error(
        "Sandbox working directory must be under this session workspace.",
      );
  }
  const resolved = posix.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(`${root}/`))
    throw new Error(
      "Sandbox working directory must be under this session workspace.",
    );
  return resolved;
}
