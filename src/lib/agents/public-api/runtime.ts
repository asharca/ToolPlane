import "server-only";
import { agentRuntimeCapabilities } from "@/lib/agents/runtime-kind";
import { AgentApiError, publicErrorMessage } from "./errors";

/** Console runtime support never implicitly grants public execution. */
export function assertPublicEndpointRuntime(runtimeKind: unknown): void {
  if (!agentRuntimeCapabilities(runtimeKind)?.publicEndpoint) {
    throw new AgentApiError(
      "runtime_unsupported",
      publicErrorMessage("runtime_unsupported"),
      409,
    );
  }
}
