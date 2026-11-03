import { withRequestLogging } from "@/lib/observability/http";
import { z } from "zod";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import {
  AgentSessionRequestError,
  resolveAgentRequestSession,
} from "@/lib/agents/request-session";
import {
  listAgentSessionPrompts,
  resolveAgentSessionPrompt,
} from "@/lib/agents/session-resources";
import { McpPromptRequestError } from "@/lib/process/mcp-prompts";

export const runtime = "nodejs";
const PromptRequestSchema = z
  .object({
    deploymentId: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
    arguments: z
      .record(z.string().min(1).max(240), z.string().max(20_000))
      .default({}),
  })
  .strict();
type Params = { params: Promise<{ agentId: string }> };

async function handle(req: Request, { params }: Params) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const liveAgent = await getAgentForRequest((await params).agentId, user.id);
  if (!liveAgent)
    return Response.json({ error: "Agent not found." }, { status: 404 });
  try {
    const query = new URL(req.url).searchParams;
    const { agent, mcpContext } = await resolveAgentRequestSession(liveAgent, {
      conversationId: query.get("conversationId"),
      workSessionId: query.get("workSessionId"),
    });
    const deploymentIds = agent.servers.map((grant) => grant.deploymentId);
    if (req.method === "GET")
      return Response.json({
        prompts: await listAgentSessionPrompts(mcpContext, deploymentIds),
      });
    const parsed = PromptRequestSchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success)
      return Response.json(
        { error: "Invalid MCP prompt request." },
        { status: 400 },
      );
    return Response.json(
      await resolveAgentSessionPrompt(mcpContext, deploymentIds, parsed.data),
    );
  } catch (error) {
    if (
      error instanceof AgentSessionRequestError ||
      error instanceof McpPromptRequestError
    )
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Session MCP prompt is unavailable." },
      { status: 403 },
    );
  }
}
const route = "/api/v1/agents/[agentId]/prompts";
export const GET = withRequestLogging(route, handle);
export const POST = withRequestLogging(route, handle);
