import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import { livePort } from "@/lib/process/supervisor";
import { findAgentConversationSandbox } from "@/lib/agents/conversation-sandbox";
import { proxyConversationWorkspace } from "@/lib/agents/conversation-workspace-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workSessionId: string; path?: string[] }>;

async function resolveTarget(req: Request, workSessionId: string) {
  const user = await resolveRequestUser(req);
  if (!user) return null;
  const work = await db.workSession.findFirst({
    where: {
      id: workSessionId,
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
      sandboxId: { not: null },
    },
    select: {
      workspaceId: true,
      runtimeKind: true,
      sandboxId: true,
      conversationId: true,
      agent: {
        select: {
          id: true,
        },
      },
      sandbox: { select: { deploymentId: true } },
    },
  });
  if (!work?.sandbox || !work.sandboxId) return null;
  const mapping = await findAgentConversationSandbox({
    workspaceId: work.workspaceId,
    agentId: work.agent.id,
    conversationId: work.conversationId,
  });
  const genericSandbox =
    mapping?.sandboxId === work.sandboxId &&
    mapping.deploymentId === work.sandbox.deploymentId;
  if (!genericSandbox) return null;
  const port = livePort(work.sandbox.deploymentId);
  return port ? { port, sandboxId: work.sandboxId } : null;
}

async function proxy(req: Request, params: Params) {
  const { workSessionId, path = [] } = await params;
  return proxyConversationWorkspace(req, path, () =>
    resolveTarget(req, workSessionId),
  );
}

export const GET = withRequestLogging(
  "/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]",
  async function GET(req: Request, { params }: { params: Params }) {
    return proxy(req, params);
  },
);
export const POST = withRequestLogging(
  "/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]",
  async function POST(req: Request, { params }: { params: Params }) {
    return proxy(req, params);
  },
);
export const DELETE = withRequestLogging(
  "/api/v1/work-sessions/[workSessionId]/sandbox/[[...path]]",
  async function DELETE(req: Request, { params }: { params: Params }) {
    return proxy(req, params);
  },
);
