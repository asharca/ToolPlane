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
type Params = { params: Promise<{ workSessionId: string; path?: string[] }> };

async function proxy(req: Request, { params }: Params) {
  const { workSessionId, path = [] } = await params;
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const work = await db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    include: {
      conversation: { include: { sandbox: { include: { deployment: true } } } },
      sandbox: { include: { deployment: true } },
      agent: {
        include: {
          runtime: { include: { sandbox: { include: { deployment: true } } } },
        },
      },
    },
  });
  if (!work) return Response.json({ error: "Not found" }, { status: 404 });
  const historical =
    work.runtimeKind !== "pi-sdk" ||
    work.agent.runtimeKind !== "pi-sdk" ||
    work.agent.retiredAt ||
    work.legacyRevisionUnresolved ||
    !work.agentRevisionId ||
    work.conversation.legacyRevisionUnresolved ||
    work.conversation.agentRevisionId !== work.agentRevisionId;
  if (historical)
    return serveHistoricalSandboxFiles(
      req,
      path,
      work.conversation.sandbox ??
        work.sandbox ??
        (work.agent.runtimeKind !== "pi-sdk"
          ? work.agent.runtime?.sandbox
          : null),
    );
  try {
    await resolvePinnedAgent(work.agent, work.agentRevisionId);
  } catch {
    return Response.json(
      { error: "Session authorization is no longer available." },
      { status: 403 },
    );
  }
  return proxyConversationWorkspace(req, path, async () => {
    const current = await db.workSession.findFirst({
      where: {
        id: workSessionId,
        agentId: work.agentId,
        agentRevisionId: work.agentRevisionId,
        legacyRevisionUnresolved: false,
        conversation: {
          agentRevisionId: work.agentRevisionId,
          legacyRevisionUnresolved: false,
        },
        agent: { retiredAt: null, runtimeKind: "pi-sdk" },
        workspace: {
          status: "active",
          OR: [
            { ownerId: user.id },
            { members: { some: { userId: user.id } } },
          ],
        },
      },
    });
    if (!current) return null;
    const mapping = await findAgentConversationSandbox({
      workspaceId: work.workspaceId,
      agentId: work.agentId,
      conversationId: work.conversationId,
    });
    if (
      !mapping ||
      (current.sandboxId && current.sandboxId !== mapping.sandboxId)
    )
      return null;
    const port = livePort(mapping.deploymentId);
    return port ? { port, sandboxId: mapping.sandboxId } : null;
  });
}
const route = "/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]";
export const GET = withRequestLogging(route, proxy);
export const POST = withRequestLogging(route, proxy);
export const DELETE = withRequestLogging(route, proxy);
