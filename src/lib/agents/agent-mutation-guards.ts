import "server-only";
import {
  isExecutableAgentRuntimeKind,
  type ExecutableAgentRuntimeKind,
} from "./runtime-kind";

export function assertNativeAgent(
  runtimeKind: string,
  retiredAt: Date | null,
): asserts runtimeKind is ExecutableAgentRuntimeKind {
  if (!isExecutableAgentRuntimeKind(runtimeKind) || retiredAt !== null) {
    throw new AgentConfigurationError(
      "Historical Agents are read-only; copy configuration to a native Pi Agent.",
    );
  }
}

export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigurationError";
  }
}
