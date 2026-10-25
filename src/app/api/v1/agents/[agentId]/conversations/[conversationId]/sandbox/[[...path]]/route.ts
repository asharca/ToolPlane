import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { livePort } from "@/lib/process/supervisor";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";
import { proxyConversationWorkspace } from "@/lib/agents/conversation-workspace-proxy";
import { resolvePinnedAgent } from "@/lib/agents/revisions";
import { serveHistoricalSandboxFiles } from "@/lib/agents/historical-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = {
  params: Promise<{ agentId: string; conversationId: string; path?: string[] }>;
};

async function proxy(req: Request, { params }: Params) {
  const { agentId, conversationId, path = [] } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      conversations: {
        some: { id: conversationId, publicApiConversation: null },
      },
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    include: {
      conversations: {
        where: { id: conversationId },
        include: { sandbox: { include: { deployment: true } } },
      },
      runtime: { include: { sandbox: { include: { deployment: true } } } },
    },
  });
  const conversation = agent?.conversations[0];
  if (!agent || !conversation)
    return Response.json({ error: "Not found" }, { status: 404 });
  const historical =
    agent.runtimeKind !== "pi-sdk" ||
    agent.retiredAt ||
    conversation.legacyRevisionUnresolved ||
    !conversation.agentRevisionId;
  if (historical)
    return serveHistoricalSandboxFiles(
      req,
      path,
      conversation.sandbox ??
        (agent.runtimeKind !== "pi-sdk" ? agent.runtime?.sandbox : null),
    );
  try {
    await resolvePinnedAgent(agent, conversation.agentRevisionId);
  } catch {
    return Response.json(
      { error: "Session authorization is no longer available." },
      { status: 403 },
    );
  }
  return proxyConversationWorkspace(req, path, async () => {
    const currentUser = await resolveRequestUser(req);
    if (!currentUser || currentUser.id !== user.id) return null;
    const current = await db.conversation.findFirst({
      where: {
        id: conversationId,
        agentId,
        agentRevisionId: conversation.agentRevisionId,
        legacyRevisionUnresolved: false,
        agent: {
          retiredAt: null,
          runtimeKind: "pi-sdk",
          workspace: {
            status: "active",
            OR: [
              { ownerId: user.id },
              { members: { some: { userId: user.id } } },
            ],
          },
        },
      },
    });
    if (!current) return null;
    await resolvePinnedAgent(agent, current.agentRevisionId);
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
