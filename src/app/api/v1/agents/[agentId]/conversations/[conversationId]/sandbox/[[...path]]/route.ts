import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { livePort } from "@/lib/process/supervisor";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";
import { proxyConversationWorkspace } from "@/lib/agents/conversation-workspace-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = {
  params: Promise<{ agentId: string; conversationId: string; path?: string[] }>;
};

async function proxy(req: Request, { params }: Params) {
  const { agentId, conversationId, path = [] } = await params;
  return proxyConversationWorkspace(req, path, async () => {
    const user = await resolveRequestUser(req);
    if (!user) return null;
    const agent = await db.agent.findFirst({
      where: {
        id: agentId,
        conversations: {
          some: { id: conversationId, publicApiConversation: null },
        },
        workspace: {
          status: "active",
          OR: [
            { ownerId: user.id },
            { members: { some: { userId: user.id } } },
          ],
        },
      },
      select: { workspaceId: true },
    });
    if (!agent) return null;
    const mapping = await findAgentConversationSandbox({
      workspaceId: agent.workspaceId,
      agentId,
      conversationId,
    });
    if (!mapping) return null;
    const port = livePort(mapping.deploymentId);
    return port ? { port, sandboxId: mapping.sandboxId } : null;
  });
}

const route =
  "/api/v1/agents/[agentId]/conversations/[conversationId]/sandbox/[[...path]]";
export const GET = withRequestLogging(route, proxy);
export const POST = withRequestLogging(route, proxy);
export const DELETE = withRequestLogging(route, proxy);
