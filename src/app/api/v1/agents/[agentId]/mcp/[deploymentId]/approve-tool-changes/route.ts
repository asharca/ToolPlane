import { z } from "zod";
import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import {
  AgentConfigurationError,
  approveAgentMcpToolChanges,
} from "@/lib/agents/mutations";

export const runtime = "nodejs";

const BodySchema = z.object({
  toolNames: z.array(z.string().min(1).max(256)).max(1_000).optional(),
});

export const POST = withRequestLogging(
  "/api/v1/agents/[agentId]/mcp/[deploymentId]/approve-tool-changes",
  async function POST(
    req: Request,
    { params }: { params: Promise<{ agentId: string; deploymentId: string }> },
  ) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { agentId, deploymentId } = await params;
    const agent = await getAgentForRequest(agentId, user.id);
    if (!agent)
      return Response.json({ error: "Agent not found" }, { status: 404 });
    let raw: unknown = {};
    const text = await req.text();
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
      }
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    try {
      const result = await approveAgentMcpToolChanges(
        agent.workspaceId,
        agentId,
        deploymentId,
        parsed.data.toolNames,
      );
      return Response.json(result);
    } catch (error) {
      return error instanceof AgentConfigurationError
        ? Response.json({ error: error.message }, { status: 409 })
        : Response.json({ error: "Agent request failed" }, { status: 500 });
    }
  },
);
