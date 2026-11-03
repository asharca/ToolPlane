import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveAgentControlRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { parseJson } from "@/lib/agents/public-api/body";
import { writeAudit } from "@/lib/observability/audit";
import { withLogContext } from "@/lib/observability/context";

const Input = z
  .object({
    enabled: z.boolean(),
    clientName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
/** Explicit owner/admin opt-in. Service credentials never authorize their own publication. */
export async function manageA2AService(
  req: Request,
  slug: string,
  agentId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    const user = await resolveAgentControlRequestUser(req);
    if (!user)
      return reply(
        { error: "An account-level Bearer credential is required." },
        401,
      );
    const workspace = await getWorkspaceForUser(slug, user.id);
    if (workspace?.status !== "active")
      return reply({ error: "Workspace not found." }, 404);
    const isAdmin =
      workspace.ownerId === user.id ||
      Boolean(
        await db.membership.count({
          where: {
            workspaceId: workspace.id,
            userId: user.id,
            role: "admin",
          },
        }),
      );
    if (!isAdmin)
      return reply(
        { error: "Workspace owner or administrator required." },
        403,
      );
    if (
      req.headers.get("content-type")?.split(";")[0].toLowerCase() !==
      "application/json"
    )
      return reply({ error: "Content-Type must be application/json." }, 415);
    const parsed = await parseJson(req, Input, 4096);
    if (!parsed.ok)
      return reply(
        { error: "Invalid A2A publication request." },
        parsed.reason === "too_large" ? 413 : 400,
      );
    const endpoint = await db.agentEndpoint.findFirst({
      where: { workspaceId: workspace.id, sourceAgentId: agentId },
      select: {
        id: true,
        publicId: true,
        status: true,
        currentRevisionId: true,
      },
    });
    if (
      !endpoint ||
      (parsed.value.enabled &&
        (endpoint.status !== "active" || !endpoint.currentRevisionId))
    )
      return reply(
        { error: "Publish an active isolated Agent service first." },
        409,
      );
    if (parsed.value.enabled) {
      return reply(
        {
          error:
            "This Agent runtime does not support public endpoint execution.",
          code: "runtime_unsupported",
        },
        409,
      );
    }
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AgentEndpoint" WHERE id=${endpoint.id} FOR UPDATE`;
        const current = await tx.agentEndpoint.findFirst({
          where: {
            id: endpoint.id,
            workspaceId: workspace.id,
          },
        });
        if (!current) throw new Error("Publication changed");
        await tx.agentEndpoint.update({
          where: { id: endpoint.id },
          data: { a2aEnabled: false },
        });
        await writeAudit(tx, {
          actorId: user.id,
          workspaceId: workspace.id,
          action: "agent.a2a.configure",
          targetType: "AgentEndpoint",
          targetId: endpoint.id,
          changes: {
            enabled: false,
          },
        });
      });
      return reply({
        enabled: false,
        endpointId: endpoint.publicId,
        rpcPath: `/api/v1/agent-endpoints/${endpoint.publicId}/a2a`,
        agentCardPath: `/api/v1/agent-endpoints/${endpoint.publicId}/a2a/.well-known/agent-card.json`,
      });
    } catch {
      return reply(
        {
          error:
            "A2A configuration could not be completed. Check the service and client list before retrying.",
        },
        409,
      );
    }
  });
}
