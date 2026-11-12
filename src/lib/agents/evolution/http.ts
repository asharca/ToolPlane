import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { isSameOriginRequest } from "@/lib/http/origin";
import { ORDINARY_AGENT_FILTER } from "@/lib/agents/queries";
import {
  assertRuntimeOwner,
  runtimeCanOperate,
} from "@/lib/runtime/ownership-state";
import { parseJson } from "@/lib/agents/public-api/body";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import { EvolutionError, evolutionErrorStatus } from "./errors";
import {
  changeRollout,
  createProposal,
  createRecord,
  mutatePlaybook,
  newSkillSchema,
  ownedRecord,
  recordDto,
  reviewProposal,
  settings,
  settingsDto,
  startRollout,
  rolloutDto,
  validateScope,
  type Scope,
} from "./service";
import {
  enqueueEvaluation,
  enqueueReflection,
  tickEvolutionJobs,
} from "./jobs";
import { recordedToolSchema } from "./schemas";
import { getConsoleTaskTree } from "@/lib/a2a/console-tasks";
import { isLocalGrant, type TaskGrant } from "@/lib/a2a/principal";
const id = z.string().min(1).max(240);
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("conversation"), conversationId: id }).strict(),
  z.object({ kind: z.literal("task"), taskId: id }).strict(),
]);
const caseSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    input: z.string().min(1).max(50_000),
    expected: z.string().min(1).max(20_000),
    criterion: z.enum(["exact", "contains", "rubric"]).default("exact"),
    recordedTools: z.array(recordedToolSchema).max(100).default([]),
    requiredTools: z.array(id).max(100).default([]),
  })
  .strict();
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = await parseJson<T>(req, schema, 2_000_000);
  if (!parsed.ok) throw new EvolutionError("INVALID_REQUEST");
  return parsed.value;
}
const success = (data: unknown, extra?: Record<string, unknown>) =>
  Response.json({ data, ...extra });
async function authorize(req: Request, agentId: string, feedback = false) {
  const user = await resolveRequestUser(req);
  if (!user) throw new EvolutionError("UNAUTHORIZED");
  const agent = await db.agent.findFirst({
    where: {
      id: agentId,
      ...ORDINARY_AGENT_FILTER,
      workspace: {
        status: "active",
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    include: {
      workspace: { include: { members: { where: { userId: user.id } } } },
    },
  });
  if (!agent) throw new EvolutionError("NOT_FOUND");
  const canReview =
    agent.workspace.ownerId === user.id ||
    agent.workspace.members.some(
      (m) => m.role === "admin" || m.role === "owner",
    );
  if (!feedback && !canReview) throw new EvolutionError("FORBIDDEN");
  if (req.method !== "GET") {
    if (!req.headers.has("authorization") && !isSameOriginRequest(req))
      throw new EvolutionError("FORBIDDEN");
    if (!feedback && !canReview) throw new EvolutionError("FORBIDDEN");
  }
  return {
    slug: agent.workspace.slug,
    scope: {
      agentId,
      workspaceId: agent.workspaceId,
      actorId: user.id,
    } satisfies Scope,
    canReview,
  };
}
function safeFailure(error: unknown) {
  const code =
    error instanceof EvolutionError
      ? error.code
      : error instanceof z.ZodError
        ? "INVALID_REQUEST"
        : error instanceof Error && /REVISION_CONFLICT/.test(error.message)
          ? "CONFLICT"
          : "EVOLUTION_FAILED";
  return Response.json(
    { error: { code, message: code } },
    { status: evolutionErrorStatus[code] },
  );
}
async function list(scope: Scope, kind: string, req: Request) {
  const cursor = new URL(req.url).searchParams.get("cursor");
  if (cursor) await ownedRecord(scope, kind, cursor);
  const rows = await db.agentEvolutionRecord.findMany({
    where: {
      agentId: scope.agentId,
      workspaceId: scope.workspaceId,
      kind,
      ...(kind === "case" ? { status: { not: "archived" } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const more = rows.length > 100;
  const items = rows.slice(0, 100);
  return { items, nextCursor: more ? (items.at(-1)?.id ?? null) : null };
}
export async function handleEvolution(
  req: Request,
  agentId: string,
  section: string,
) {
  try {
    const { scope, canReview } = await authorize(req, agentId);
    if (section === "settings") {
      if (req.method === "GET")
        return success({
          settings: await settingsDto(scope),
          permissions: {
            canReview,
            canExecute: canReview && runtimeCanOperate(),
          },
          reflections: (
            await db.agentEvolutionRecord.findMany({
              where: {
                agentId,
                workspaceId: scope.workspaceId,
                kind: "reflection",
              },
              orderBy: { createdAt: "desc" },
              take: 10,
            })
          ).map(recordDto),
        });
      const input = await body(
        req,
        z
          .object({
            enabled: z.boolean().optional(),
            reflectionEnabled: z.boolean().optional(),
            reflectionIntervalHours: z
              .number()
              .int()
              .min(1)
              .max(8760)
              .optional(),
            monthlyBudgetMicros: z
              .string()
              .regex(/^\d{1,16}$/)
              .optional(),
          })
          .strict(),
      );
      const current = await settings(scope);
      const { monthlyBudgetMicros, ...settingsInput } = input;
      await db.agentEvolutionSettings.update({
        where: { agentId },
        data: {
          ...settingsInput,
          ...(monthlyBudgetMicros !== undefined
            ? { monthlyBudgetMicros: BigInt(monthlyBudgetMicros) }
            : {}),
          actorId: scope.actorId,
          nextReflectionAt:
            (input.reflectionEnabled ?? current.reflectionEnabled) &&
            (input.enabled ?? current.enabled)
              ? new Date(
                  Date.now() +
                    (input.reflectionIntervalHours ??
                      current.reflectionIntervalHours) *
                      3_600_000,
                )
              : null,
        },
      });
      return success(await settingsDto(scope));
    }
    if (section === "feedback") return feedbackList(req, scope);
    if (req.method === "GET") {
      const proposalId = new URL(req.url).searchParams.get("id");
      if (section === "proposals" && proposalId !== null) {
        return success(
          recordDto(await ownedRecord(scope, "proposal", proposalId)),
        );
      }
      if (section === "rollout") {
        const row = await db.agentEvolutionRecord.findFirst({
          where: { agentId, workspaceId: scope.workspaceId, kind: "rollout" },
          orderBy: { createdAt: "desc" },
        });
        return success(row ? await rolloutDto(scope, row) : null);
      }
      const kind: Record<string, string> = {
        episodes: "episode",
        playbook: "playbook",
        proposals: "proposal",
        cases: "case",
        evaluations: "evaluation",
        reflections: "reflection",
      };
      if (!kind[section]) throw new EvolutionError("NOT_FOUND");
      const page = await list(scope, kind[section], req);
      if (section === "evaluations") {
        const items = [];
        for (const row of page.items) {
          const results = await db.agentEvolutionRecord.findMany({
            where: {
              agentId,
              workspaceId: scope.workspaceId,
              kind: "result",
              payload: { path: ["evaluationId"], equals: row.id },
            },
            orderBy: { createdAt: "asc" },
          });
          items.push({ ...recordDto(row), results: results.map(recordDto) });
        }
        return success(items, { nextCursor: page.nextCursor });
      }
      return success(page.items.map(recordDto), {
        nextCursor: page.nextCursor,
      });
    }
    if (section === "playbook") {
      if (req.method === "POST") {
        const input = await body(
          req,
          z
            .object({
              scope: scopeSchema,
              content: z.string().min(1).max(20_000),
            })
            .strict(),
        );
        await validateScope(scope, input.scope);
        return success(
          recordDto(
            await createRecord(db, scope, "playbook", {
              ...input,
              reviewedById: null,
            }),
          ),
        );
      }
      const input = await body(
        req,
        z
          .object({
            id,
            expectedVersion: z.number().int().positive(),
            status: z.enum(["approved", "rejected", "archived"]).optional(),
            content: z.string().min(1).max(20_000).optional(),
            mergeIds: z.array(id).max(20).optional(),
          })
          .strict(),
      );
      return success(recordDto(await mutatePlaybook(scope, input)));
    }
    if (section === "cases") {
      if (req.method === "POST")
        return success(
          recordDto(
            await createRecord(
              db,
              scope,
              "case",
              await body(req, caseSchema),
              "active",
            ),
          ),
        );
      if (req.method === "PATCH") {
        const input = await body(req, caseSchema.extend({ id }));
        const row = await ownedRecord(scope, "case", input.id);
        const { id: caseId, ...data } = input;
        return success(
          recordDto(
            await db.agentEvolutionRecord.update({
              where: { id: caseId, version: row.version },
              data: { payload: data, version: { increment: 1 } },
            }),
          ),
        );
      }
      const value = new URL(req.url).searchParams.get("id");
      if (!value) throw new EvolutionError("INVALID_REQUEST");
      await ownedRecord(scope, "case", value);
      await db.agentEvolutionRecord.update({
        where: { id: value },
        data: { status: "archived" },
      });
      return success({ deleted: true });
    }
    // These actions publish or execute code and must stay under the existing owner domain.
    if (!runtimeCanOperate()) throw new EvolutionError("RUNTIME_UNAVAILABLE");
    assertRuntimeOwner();
    if (section === "proposals") {
      if (req.method === "POST")
        return success(
          recordDto(
            await createProposal(
              scope,
              await body(
                req,
                z
                  .object({
                    kind: z.enum(["prompt", "skill"]),
                    title: z.string().min(1).max(240),
                    rationale: z.string().min(1).max(10_000),
                    baseRevisionId: id,
                    after: AgentRevisionConfigSchema.optional(),
                    newSkill: newSkillSchema.optional(),
                    evidence: z
                      .object({
                        episodeIds: z.array(id).max(100),
                        feedbackIds: z.array(id).max(100),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict(),
              ),
            ),
          ),
        );
      const input = await body(
        req,
        z
          .object({
            id,
            decision: z.enum(["approve", "reject"]),
            expectedBaseRevisionId: id,
          })
          .strict(),
      );
      return success(
        recordDto(
          await reviewProposal(
            scope,
            input.id,
            input.decision,
            input.expectedBaseRevisionId,
          ),
        ),
      );
    }
    if (section === "reflections") {
      await body(req, z.object({}).strict());
      const job = await enqueueReflection(scope);
      void tickEvolutionJobs();
      return success(recordDto(job));
    }
    if (section === "evaluations") {
      const input = await body(
        req,
        z
          .object({ proposalId: id, caseIds: z.array(id).min(1).max(20) })
          .strict(),
      );
      const job = await enqueueEvaluation(
        scope,
        input.proposalId,
        input.caseIds,
      );
      void tickEvolutionJobs();
      return success({ ...recordDto(job), results: [] });
    }
    if (section === "rollout") {
      if (req.method === "POST") {
        const input = await body(
          req,
          z
            .object({
              proposalId: id,
              evaluationId: id,
              percentage: z.number().int().min(1).max(100),
            })
            .strict(),
        );
        return success(
          recordDto(
            await startRollout(
              scope,
              input.proposalId,
              input.evaluationId,
              input.percentage,
            ),
          ),
        );
      }
      const input = await body(
        req,
        z
          .object({
            id,
            action: z.enum(["stop", "promote", "rollback"]),
            expectedDefaultRevisionId: id,
            acknowledgeIsolationRisk: z.boolean().optional(),
          })
          .strict(),
      );
      if (input.action === "promote" && !input.acknowledgeIsolationRisk)
        throw new EvolutionError("INVALID_REQUEST");
      return success(
        await rolloutDto(
          scope,
          await changeRollout(
            scope,
            input.id,
            input.action,
            input.expectedDefaultRevisionId,
          ),
        ),
      );
    }
    throw new EvolutionError("NOT_FOUND");
  } catch (error) {
    return safeFailure(error);
  }
}
async function feedbackList(req: Request, scope: Scope) {
  const cursor = new URL(req.url).searchParams.get("cursor");
  const where = {
    message: {
      conversation: {
        agentId: scope.agentId,
        agent: { workspaceId: scope.workspaceId },
      },
    },
  };
  if (
    cursor &&
    !(await db.agentMessageFeedback.findFirst({
      where: { id: cursor, ...where },
    }))
  )
    throw new EvolutionError("NOT_FOUND");
  const rows = await db.agentMessageFeedback.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { message: { select: { conversationId: true } } },
  });
  return success(
    rows.slice(0, 100).map((row) => ({
      ...row,
      message: undefined,
      conversationId: row.message.conversationId,
    })),
    { nextCursor: rows.length > 100 ? rows[99].id : null },
  );
}
export async function handleMessageFeedback(
  req: Request,
  agentId: string,
  conversationId: string,
  messageId: string,
) {
  try {
    const { scope, canReview, slug } = await authorize(req, agentId, true);
    const message = await db.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        role: "assistant",
        conversation: { agentId, agent: { workspaceId: scope.workspaceId } },
      },
    });
    if (!message) throw new EvolutionError("NOT_FOUND");
    if (!canReview) {
      const ownWork = await db.workSession.findFirst({
        where: {
          conversationId,
          agentId,
          workspaceId: scope.workspaceId,
          a2aActorId: scope.actorId,
        },
      });
      const binding = await db.a2AEntryBinding.findFirst({
        where: {
          sourceId: ownWork?.id ?? conversationId,
          context: { agentId, workspaceId: scope.workspaceId },
        },
        include: { lastTask: true },
      });
      const grant = binding?.lastTask.grant as unknown as TaskGrant | undefined;
      if (
        !binding ||
        !grant ||
        !isLocalGrant(grant) ||
        grant.actorId !== scope.actorId
      )
        throw new EvolutionError("NOT_FOUND");
      try {
        await getConsoleTaskTree(
          {
            workspaceId: scope.workspaceId,
            agentId,
            actorId: scope.actorId,
            slug,
          },
          binding.lastTask.rootTaskId ?? binding.lastTask.id,
        );
      } catch {
        throw new EvolutionError("NOT_FOUND");
      }
    }
    const where = {
      messageId_createdById: { messageId, createdById: scope.actorId },
    };
    if (req.method === "GET") {
      const feedback = await db.agentMessageFeedback.findUnique({ where });
      return success(feedback ? { ...feedback, conversationId } : null);
    }
    const input = await body(
      req,
      z
        .object({
          rating: z.enum(["positive", "negative"]).nullable(),
          comment: z.string().max(10_000).default(""),
        })
        .strict(),
    );
    if (input.rating === null) {
      await db.agentMessageFeedback.deleteMany({
        where: { messageId, createdById: scope.actorId },
      });
      return success(null);
    }
    const feedback = await db.agentMessageFeedback.upsert({
      where,
      create: {
        messageId,
        createdById: scope.actorId,
        rating: input.rating,
        comment: input.comment,
      },
      update: { rating: input.rating, comment: input.comment },
    });
    return success({ ...feedback, conversationId });
  } catch (error) {
    return safeFailure(error);
  }
}
