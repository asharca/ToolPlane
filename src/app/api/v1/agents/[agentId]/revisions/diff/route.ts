import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { getAgentForRequest } from "@/lib/agents/queries";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { buildAgentRevisionDiff } from "@/lib/revisions/config-diff";
import { withRequestLogging } from "@/lib/observability/http";
import { logSystemEvent } from "@/lib/observability/system";

export const runtime = "nodejs";
type Context = { params: Promise<{ agentId: string }> };

async function handle(req: Request, { params }: Context) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgentForRequest(agentId, user.id);
  if (!agent) return Response.json({ error: "notFound" }, { status: 404 });
  const search = new URL(req.url).searchParams;
  const toVersion = Number(search.get("toVersion"));
  const fromVersion = search.has("fromVersion")
    ? Number(search.get("fromVersion"))
    : undefined;
  if (
    !Number.isSafeInteger(toVersion) ||
    toVersion < 1 ||
    (fromVersion !== undefined &&
      (!Number.isSafeInteger(fromVersion) || fromVersion < 0))
  )
    return Response.json({ error: "invalidVersion" }, { status: 400 });
  try {
    const to = await db.agentRevision.findFirst({
      where: {
        agentId,
        version: toVersion,
        agent: { workspaceId: agent.workspaceId },
      },
    });
    if (!to) return Response.json({ error: "notFound" }, { status: 404 });
    const from =
      fromVersion === 0
        ? null
        : await db.agentRevision.findFirst({
            where: {
              agentId,
              agent: { workspaceId: agent.workspaceId },
              ...(fromVersion !== undefined
                ? { version: fromVersion }
                : to.parentRevisionId
                  ? { id: to.parentRevisionId }
                  : {
                      version: { lt: to.version },
                      purpose: { in: ["published", "rollback"] },
                    }),
            },
            orderBy: { version: "desc" },
          });
    if (fromVersion !== undefined && fromVersion !== 0 && !from)
      return Response.json({ error: "notFound" }, { status: 404 });
    return Response.json(
      {
        fromVersion: from?.version ?? null,
        toVersion: to.version,
        ...buildAgentRevisionDiff(
          from ? AgentRevisionConfigSchema.parse(from.config) : null,
          AgentRevisionConfigSchema.parse(to.config),
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    logSystemEvent("agents.revisions.diff_failed", {
      domain: "agent",
      error,
      workspaceId: agent.workspaceId,
      agentId,
      actorId: user.id,
    });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}

export const GET = withRequestLogging(
  "/api/v1/agents/[agentId]/revisions/diff",
  handle,
);
