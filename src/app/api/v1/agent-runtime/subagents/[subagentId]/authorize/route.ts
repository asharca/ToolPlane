import { z } from "zod";
import { db } from "@/lib/db";
import { agentRuntimeTokenFromRequest } from "@/lib/agents/runtime-access";
import { resolveAgentRuntimeGrant } from "@/lib/agents/runtime-grant";
import { requireAgentRevision } from "@/lib/agents/revisions";
import { assertSubagentRuntimeAccess } from "@/lib/agents/subagents";
import { PluginError } from "@/lib/plugins/catalog";
import { parseJson } from "@/lib/agents/public-api/body";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ subagentId: string }> },
) {
  if (req.headers.has("origin"))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const token = await agentRuntimeTokenFromRequest(req);
  if (!token || !(await resolveAgentRuntimeGrant(token)))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const input = await parseJson(
    req,
    z.object({ versionId: z.string().min(1).max(240) }).strict(),
    2048,
  );
  if (!input.ok)
    return Response.json({ error: "SUBAGENT_INVALID" }, { status: 400 });
  try {
    const child = await db.$transaction(async (tx) => {
      const revision = await requireAgentRevision(
        tx,
        token.agentId,
        token.agentRevisionId,
      );
      return assertSubagentRuntimeAccess(tx, {
        workspaceId: token.workspaceId,
        agentId: token.agentId,
        subagentId: (await params).subagentId,
        versionId: input.value.versionId,
        config: revision.config,
      });
    });
    return Response.json(
      { allowed: true, permissions: child.definition.permissions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof PluginError ? error.code : "SUBAGENT_REVOKED" },
      { status: 403 },
    );
  }
}
