import { handleAgentMemories } from "@/lib/agents/memories-api";
import { withRequestLogging } from "@/lib/observability/http";

export const runtime = "nodejs";
export const GET = withRequestLogging("/api/v1/agents/[agentId]/memories", handleAgentMemories);
export const POST = withRequestLogging("/api/v1/agents/[agentId]/memories", handleAgentMemories);
