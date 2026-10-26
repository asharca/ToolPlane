import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import {
  archiveWorkSession,
  getWorkSessionForUser,
  workSessionWorkingDirectory,
} from "@/lib/work/sessions";
import { effectiveStatus } from "@/lib/process/supervisor";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { isWorkSessionTitlePending } from "@/lib/work/coordinator";
import { getConversationWorkspaceSandbox } from "@/lib/agents/conversation-workspace";

type Params = { params: Promise<{ workSessionId: string }> };

export const GET = withRequestLogging(
  "/api/v1/work-sessions/[workSessionId]",
  async function GET(req: Request, { params }: Params) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { workSessionId } = await params;
    const titlePending = isWorkSessionTitlePending(workSessionId);
    const work = await getWorkSessionForUser(user.id, workSessionId);
    if (!work) return Response.json({ error: "Not found" }, { status: 404 });
    const { conversation, sandbox: assignedSandbox, ...view } = work;
    const sandbox = await getConversationWorkspaceSandbox({
      workspaceId: work.workspaceId,
      agentId: work.agentId,
      conversationId: work.conversationId,
    });
    return Response.json({
      ...view,
      sandboxId: sandbox?.id ?? null,
      titlePending,
      reasoningEffort:
        normalizeReasoningEffort(conversation.reasoningEffort) ?? null,
      workingDirectory: workSessionWorkingDirectory(work.runtimeSnapshot),
      messages: conversation.messages,
      sandbox: sandbox
        ? {
            id: sandbox.id,
            name: sandbox.name,
            kind: sandbox.kind,
            deploymentId: sandbox.deploymentId,
            status: sandbox.deployment.status,
            running:
              effectiveStatus(
                sandbox.deploymentId,
                sandbox.deployment.status,
              ) === "running",
          }
        : null,
    });
  },
);

export const DELETE = withRequestLogging(
  "/api/v1/work-sessions/[workSessionId]",
  async function DELETE(req: Request, { params }: Params) {
    const user = await resolveRequestUser(req);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { workSessionId } = await params;
    const work = await getWorkSessionForUser(user.id, workSessionId);
    if (!work) return Response.json({ error: "Not found" }, { status: 404 });
    return (await archiveWorkSession(work.workspaceId, work.id))
      ? new Response(null, { status: 204 })
      : Response.json(
          { error: "Only finished work can be archived" },
          { status: 409 },
        );
  },
);
