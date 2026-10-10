import "server-only";
import { LOCAL_OUTPUT_MODES } from "./model";
import { AgentCard } from "@a2a-js/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import { runtimeEnv } from "@/lib/runtime-env";
import { resolveAgentControlRequestUser } from "@/lib/auth/request-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { parseJson } from "@/lib/agents/public-api/body";
import { skillLabel } from "@/lib/workspace/skill-label";
import { writeAudit } from "@/lib/observability/audit";
import { withLogContext } from "@/lib/observability/context";
import { createLocalRootGrant, localTarget } from "./local-policy";
import { A2AHttpError, type LocalA2AGrant } from "./principal";
import { A2A_PROTOCOL_VERSION } from "./model";
import { handleA2ARpc } from "./http";
import { WindowLimiter } from "./transport-limits";
import { a2aDeploymentOrigin } from "./connection-info";
const CARD_SKILL_SELECT = {
  select: {
    id: true,
    skillId: true,
    name: true,
    slug: true,
    description: true,
    agentInvocable: true,
    skill: { select: { name: true, slug: true, description: true } },
  },
} as const;
const requests = new WindowLimiter(120, 4096);

const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
async function account(req: Request, slug: string) {
  if (req.headers.has("origin"))
    throw new A2AHttpError(403, "Use a server-side account credential.");
  const user = await resolveAgentControlRequestUser(req);
  if (!user)
    throw new A2AHttpError(
      401,
      "An account-level Bearer credential is required.",
    );
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (workspace?.status !== "active")
    throw new A2AHttpError(404, "Workspace unavailable.");
  requests.take(`${workspace.id}:${user.id}`);
  return { user, workspace };
}
export async function localAgentCard(grant: LocalA2AGrant) {
  const target = await localTarget(db, grant.workspaceId, grant.agentId);
  const agent = await db.agent.findFirstOrThrow({
    where: {
      ...ORDINARY_AGENT_FILTER,
      id: grant.agentId,
      workspaceId: grant.workspaceId,
    },
    select: {
      description: true,
      skills: { select: { installedSkill: CARD_SKILL_SELECT } },
      toolkits: {
        select: {
          toolkit: {
            select: {
              skills: { select: { installedSkill: CARD_SKILL_SELECT } },
            },
          },
        },
      },
    },
  });
  const configuredSkills = new Map(
    [
      ...agent.skills.map(({ installedSkill }) => installedSkill),
      ...agent.toolkits.flatMap(({ toolkit }) =>
        toolkit.skills.map(({ installedSkill }) => installedSkill),
      ),
    ]
      .filter((skill) => skill.agentInvocable !== false)
      .map((skill) => [skill.id, skill]),
  );
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: grant.workspaceId },
    select: { slug: true },
  });
  const origin = a2aDeploymentOrigin(
    runtimeEnv("NEXT_PUBLIC_APP_URL") || "http://localhost:3000",
  );
  const url = new URL(
    `/api/v1/workspaces/${encodeURIComponent(workspace.slug)}/agents/${encodeURIComponent(grant.agentId)}/a2a/local`,
    origin,
  ).href;
  const skills = [...configuredSkills.values()].map((skill) => {
    const label = skillLabel({
      skillId: skill.skillId,
      skill: skill.skill,
      name: skill.name,
      slug: skill.slug,
      source: null,
    });
    return {
      id: skill.id,
      name: label.name,
      description:
        skill.skill?.description?.trim() ||
        skill.description?.trim() ||
        `Use the attached ${label.name} skill.`,
      tags: [label.slug],
    };
  });
  return AgentCard.fromJSON({
    name: target.name,
    description:
      agent.description?.trim() || "Explicitly enabled workspace-local Agent.",
    version: target.binding,
    supportedInterfaces: [
      {
        url,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: LOCAL_OUTPUT_MODES,
    skills,
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "ToolPlane account token",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  });
}
export async function handleLocalA2A(
  req: Request,
  slug: string,
  agentId: string,
) {
  return withLogContext({ suppressPayload: true }, async () => {
    const resolve = async (request: Request) => {
      const { user, workspace } = await account(request, slug);
      return {
        grant: await createLocalRootGrant(workspace.id, agentId, user.id),
        rateHeaders: new Headers(),
      };
    };
    if (req.method === "POST") return handleA2ARpc(req, agentId, resolve);
    try {
      if (!["GET", "PUT"].includes(req.method))
        return reply({ error: "Method not allowed." }, 405);
      if (req.method === "GET") {
        const card = AgentCard.toJSON(
          await localAgentCard((await resolve(req)).grant),
        ) as Record<string, unknown>;
        if (!card.skills) card.skills = [];
        return reply(card);
      }
      const { user, workspace } = await account(req, slug);
      if (
        workspace.ownerId !== user.id &&
        !(await db.membership.count({
          where: { workspaceId: workspace.id, userId: user.id, role: "admin" },
        }))
      )
        throw new A2AHttpError(
          403,
          "Workspace owner or administrator required.",
        );
      if (
        req.headers.get("content-type")?.split(";")[0].toLowerCase() !==
        "application/json"
      )
        throw new A2AHttpError(415, "Expected JSON.");
      const parsed = await parseJson(
        req,
        z.object({ enabled: z.boolean() }).strict(),
        4096,
      );
      if (!parsed.ok)
        throw new A2AHttpError(400, "Invalid local Agent configuration.");
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspace.id} FOR UPDATE`;
        const authorized = await tx.workspace.count({
          where: {
            id: workspace.id,
            status: "active",
            owner: { status: "active" },
            OR: [
              { ownerId: user.id },
              {
                members: {
                  some: {
                    userId: user.id,
                    role: "admin",
                    user: { status: "active" },
                  },
                },
              },
            ],
          },
        });
        if (
          !authorized ||
          !(await tx.user.count({ where: { id: user.id, status: "active" } }))
        )
          throw new A2AHttpError(
            403,
            "Workspace administrator authority changed.",
          );
        const changed = await tx.agent.updateMany({
          where: {
            ...ORDINARY_AGENT_FILTER,
            id: agentId,
            workspaceId: workspace.id,
          },
          data: { a2aInternalEnabled: parsed.value.enabled },
        });
        if (!changed.count) throw new A2AHttpError(404, "Agent unavailable.");
        await writeAudit(tx, {
          actorId: user.id,
          workspaceId: workspace.id,
          action: "agent.a2a.local.configure",
          targetType: "Agent",
          targetId: agentId,
          changes: { enabled: parsed.value.enabled },
        });
      });
      return reply({ enabled: parsed.value.enabled });
    } catch (error) {
      return reply(
        {
          error:
            error instanceof A2AHttpError
              ? error.message
              : "Local A2A request failed.",
        },
        error instanceof A2AHttpError ? error.status : 400,
      );
    }
  });
}
