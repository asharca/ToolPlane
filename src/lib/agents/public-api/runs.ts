import "server-only";
import { readNativeQuotaCharges } from "@/lib/a2a/quotas";
import { withLogContext } from "@/lib/observability/context";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { AgentApiPrincipal } from "@/lib/agents/public-api/auth";
import {
  AGENT_API_MAX_TIMEOUT_SECONDS,
  hashAgentApiSubject,
} from "@/lib/agents/public-api/auth";
import {
  AGENT_API_MAX_INPUT_CHARACTERS,
  AGENT_API_MAX_OUTPUT_CHARACTERS,
} from "@/lib/agents/public-api/body";
import {
  AgentApiError,
  publicErrorMessage,
  type AgentApiErrorCode,
} from "@/lib/agents/public-api/errors";
import {
  createAgentRequestId,
  createAgentResponseId,
} from "@/lib/agents/public-api/ids";
import { abortAgentApiRun } from "@/lib/agents/public-api/run-control";
import {
  takeAgentApiRateLimit,
  type AgentApiRateLimitResult,
} from "@/lib/agents/public-api/rate-limit";
import { assertPublicEndpointRuntime } from "@/lib/agents/public-api/runtime";
import type { AgentApiResponseView } from "@/lib/agents/public-api/sse";

const ACTIVE_RUN_STATUSES = ["provisioning", "running"] as const;
const MAX_CONVERSATIONS_PER_CLIENT_SUBJECT = 100;
const MAX_WORKSPACE_DAILY_OUTPUT_CHARACTERS = 500_000_000;
const MAX_WORKSPACE_STORED_CHARACTERS = 1_000_000_000;
const MAX_RESPONSE_STORAGE_RESERVATION =
  AGENT_API_MAX_INPUT_CHARACTERS + AGENT_API_MAX_OUTPUT_CHARACTERS;

export type PrepareAgentResponseInput = {
  principal: AgentApiPrincipal;
  input: string;
  endUser: string;
  conversationId?: string;
  stream: boolean;
  metadata?: Record<string, string | number | boolean | null>;
  idempotencyKey?: string | null;
  signal?: AbortSignal;
  rateLimit?: AgentApiRateLimitResult;
};

export type PreparedAgentResponse = {
  runId: string;
  responseId: string;
  requestId: string;
  endpointId: string;
  endpointPublicId: string;
  endpointRevision: number;
  clientId: string;
  subjectHash: string;
  publicConversationId: string;
  input: string;
  stream: boolean;
  timeoutSeconds: number;
  replay: boolean;
  rateLimitHeaders: Headers;
};

export type ExecuteAgentResponseOptions = {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
};

function validIdempotencyKey(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value.length > 128 || /[^\x20-\uFFFF]|\x7f/.test(value)) {
    throw new AgentApiError(
      "invalid_request",
      "Idempotency-Key must contain 1 to 128 visible characters.",
      400,
    );
  }
  return value;
}

function requestDigest(input: {
  text: string;
  conversationId?: string;
  subjectHash: string;
  metadata?: Record<string, string | number | boolean | null>;
}): string {
  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        input: input.text,
        conversation_id: input.conversationId ?? null,
        subject_hash: input.subjectHash,
        metadata,
      }),
    )
    .digest("hex");
}

function retryableAdmissionError(
  error: unknown,
  hasIdempotencyKey: boolean,
): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "P2034" || (hasIdempotencyKey && code === "P2002");
}

function subjectForRequest(
  principal: AgentApiPrincipal,
  endUser: string,
): string {
  const subjectHash = hashAgentApiSubject(
    principal.endpointId,
    principal.clientId,
    endUser,
  );
  if (principal.subjectHash && principal.subjectHash !== subjectHash) {
    throw new AgentApiError(
      "invalid_request",
      "The end_user does not match this client token.",
      400,
    );
  }
  return subjectHash;
}

async function failRun(
  runId: string,
  code: AgentApiErrorCode,
  durationMs?: number,
  outputCharacters?: number,
) {
  await db.agentRun.updateMany({
    where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: {
      status: code === "cancelled" ? "cancelled" : "failed",
      errorCode: code,
      durationMs,
      ...(outputCharacters === undefined ? {} : { outputCharacters }),
      completedAt: new Date(),
    },
  });
}

type BudgetRow = {
  endpointOutput: bigint | number;
  clientOutput: bigint | number;
  workspaceOutput: bigint | number;
  endpointStored: bigint | number;
  clientStored: bigint | number;
  workspaceStored: bigint | number;
  endpointActive: bigint | number;
  clientActive: bigint | number;
  workspaceActive: bigint | number;
};

async function assertPublicResourceBudgets(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    endpointId: string;
    clientId: string;
    endpointDailyOutput: number;
    clientDailyOutput: number;
    endpointStored: number;
    clientStored: number;
  },
): Promise<void> {
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [row] = await tx.$queryRaw<BudgetRow[]>`
    SELECT
      (SELECT COALESCE(SUM(r."outputCharacters"), 0)
       FROM "AgentRun" r
       WHERE r."endpointId" = ${input.endpointId} AND r."createdAt" >= ${dayStart}) AS "endpointOutput",
      (SELECT COALESCE(SUM(r."outputCharacters"), 0)
       FROM "AgentRun" r
       WHERE r."clientId" = ${input.clientId} AND r."createdAt" >= ${dayStart}) AS "clientOutput",
      (SELECT COALESCE(SUM(r."outputCharacters"), 0)
       FROM "AgentRun" r
       JOIN "AgentEndpoint" e ON e."id" = r."endpointId"
       WHERE e."workspaceId" = ${input.workspaceId} AND r."createdAt" >= ${dayStart}) AS "workspaceOutput",
      (SELECT COALESCE(SUM(pc."storedCharacters"), 0)
       FROM "AgentPublicConversation" pc
       WHERE pc."endpointId" = ${input.endpointId} AND pc."deletingAt" IS NULL) AS "endpointStored",
      (SELECT COALESCE(SUM(pc."storedCharacters"), 0)
       FROM "AgentPublicConversation" pc
       WHERE pc."clientId" = ${input.clientId} AND pc."deletingAt" IS NULL) AS "clientStored",
      (SELECT COALESCE(SUM(pc."storedCharacters"), 0)
       FROM "AgentPublicConversation" pc
       JOIN "AgentEndpoint" e ON e."id" = pc."endpointId"
       WHERE e."workspaceId" = ${input.workspaceId} AND pc."deletingAt" IS NULL) AS "workspaceStored",
      (SELECT COUNT(*) FROM "AgentRun" r
       WHERE r."endpointId" = ${input.endpointId}
         AND r."status" IN ('provisioning', 'running')) AS "endpointActive",
      (SELECT COUNT(*) FROM "AgentRun" r
       WHERE r."clientId" = ${input.clientId}
         AND r."status" IN ('provisioning', 'running')) AS "clientActive",
      (SELECT COUNT(*) FROM "AgentRun" r
       JOIN "AgentEndpoint" e ON e."id" = r."endpointId"
       WHERE e."workspaceId" = ${input.workspaceId}
         AND r."status" IN ('provisioning', 'running')) AS "workspaceActive"
  `;
  if (!row)
    throw new AgentApiError(
      "internal_error",
      publicErrorMessage("internal_error"),
      500,
    );
  const native = await readNativeQuotaCharges(tx, input, now);
  const value = (field: keyof BudgetRow) =>
    Number(row[field]) +
    (field in native ? native[field as keyof typeof native] : 0);
  const exceedsOutput =
    value("endpointOutput") +
      (value("endpointActive") + 1) * AGENT_API_MAX_OUTPUT_CHARACTERS >
      input.endpointDailyOutput ||
    value("clientOutput") +
      (value("clientActive") + 1) * AGENT_API_MAX_OUTPUT_CHARACTERS >
      input.clientDailyOutput ||
    value("workspaceOutput") +
      (value("workspaceActive") + 1) * AGENT_API_MAX_OUTPUT_CHARACTERS >
      MAX_WORKSPACE_DAILY_OUTPUT_CHARACTERS;
  const exceedsStorage =
    value("endpointStored") +
      (value("endpointActive") + 1) * MAX_RESPONSE_STORAGE_RESERVATION >
      input.endpointStored ||
    value("clientStored") +
      (value("clientActive") + 1) * MAX_RESPONSE_STORAGE_RESERVATION >
      input.clientStored ||
    value("workspaceStored") +
      (value("workspaceActive") + 1) * MAX_RESPONSE_STORAGE_RESERVATION >
      MAX_WORKSPACE_STORED_CHARACTERS;
  if (exceedsOutput || exceedsStorage) {
    throw new AgentApiError(
      "resource_limit_exceeded",
      publicErrorMessage("resource_limit_exceeded"),
      429,
    );
  }
}

/**
 * Atomically reserves endpoint, client, and conversation concurrency before
 * provisioning a public runtime. The durable AgentRun row is the cross-worker
 * lease; row locks serialize competing admissions.
 */
export async function prepareAgentResponse(
  input: PrepareAgentResponseInput,
): Promise<PreparedAgentResponse> {
  const requestStartedAt = Date.now();
  const subjectHash = subjectForRequest(input.principal, input.endUser);
  const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
  const requestHash = requestDigest({
    text: input.input,
    conversationId: input.conversationId,
    subjectHash,
    metadata: input.metadata,
  });

  const endpoint = await db.agentEndpoint.findFirst({
    where: {
      id: input.principal.endpointId,
      publicId: input.principal.endpointPublicId,
      status: "active",
      currentRevisionId: { not: null },
    },
    include: {
      currentRevision: true,
      sourceAgent: { select: { runtimeKind: true } },
      clients: {
        where: { id: input.principal.clientId, status: "active" },
        take: 1,
      },
    },
  });
  const client = endpoint?.clients[0];
  if (!endpoint?.currentRevision || !client) {
    throw new AgentApiError(
      "invalid_api_key",
      publicErrorMessage("invalid_api_key"),
      401,
    );
  }

  const rate =
    input.rateLimit ??
    (await takeAgentApiRateLimit({
      endpointId: endpoint.id,
      clientId: client.id,
      endpointRpm: endpoint.rpmLimit,
      clientRpm: client.rpmLimit,
      endpointDaily: endpoint.dailyRequestLimit,
      clientDaily: client.dailyRequestLimit,
    }));

  const now = new Date();
  const expiredRuns = await db.$queryRaw<Array<{ publicId: string }>>`
    WITH candidates AS (
      SELECT "id"
      FROM "AgentRun"
      WHERE ("endpointId" = ${endpoint.id} OR "clientId" = ${client.id})
        AND "status" IN ('provisioning', 'running')
        AND "deadlineAt" < ${now}
      ORDER BY "deadlineAt" ASC
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AgentRun" r
    SET "status" = CASE
          WHEN r."cancelRequestedAt" IS NULL THEN 'failed'
          ELSE 'cancelled'
        END,
        "errorCode" = CASE
          WHEN r."cancelRequestedAt" IS NULL THEN 'request_timeout'
          ELSE 'cancelled'
        END,
        "cancelRequestedAt" = COALESCE(r."cancelRequestedAt", ${now}),
        "completedAt" = ${now},
        "updatedAt" = ${now}
    FROM candidates
    WHERE r."id" = candidates."id"
      AND r."status" IN ('provisioning', 'running')
    RETURNING r."publicId"
  `;
  for (const expired of expiredRuns) abortAgentApiRun(expired.publicId);
  const admit = () =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${endpoint.workspaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "AgentEndpoint" WHERE "id" = ${endpoint.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "AgentApiClient" WHERE "id" = ${client.id} FOR UPDATE`;
        const lockedEndpoint = await tx.agentEndpoint.findUnique({
          where: { id: endpoint.id },
          select: {
            status: true,
            isolationMode: true,
            maxConcurrent: true,
            timeoutSeconds: true,
            dailyOutputCharacterLimit: true,
            maxStoredCharacters: true,
            currentRevision: { select: { id: true, version: true } },
          },
        });
        if (
          lockedEndpoint?.status !== "active" ||
          !lockedEndpoint.currentRevision
        ) {
          throw new AgentApiError(
            "endpoint_disabled",
            publicErrorMessage("endpoint_disabled"),
            403,
          );
        }
        const lockedClient = await tx.agentApiClient.findUnique({
          where: { id: client.id },
          select: {
            endpointId: true,
            status: true,
            maxConcurrent: true,
            dailyOutputCharacterLimit: true,
            maxStoredCharacters: true,
          },
        });
        if (
          !lockedClient ||
          lockedClient.endpointId !== endpoint.id ||
          lockedClient.status !== "active"
        ) {
          throw new AgentApiError(
            "invalid_api_key",
            publicErrorMessage("invalid_api_key"),
            401,
          );
        }

        if (idempotencyKey) {
          const existing = await tx.agentRun.findUnique({
            where: {
              clientId_idempotencyKey: { clientId: client.id, idempotencyKey },
            },
            include: {
              revision: { select: { version: true } },
              publicConversation: { select: { publicId: true } },
            },
          });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new AgentApiError(
                "idempotency_conflict",
                publicErrorMessage("idempotency_conflict"),
                409,
              );
            }
            return { existing } as const;
          }
        }
        assertPublicEndpointRuntime(endpoint.sourceAgent.runtimeKind);

        await assertPublicResourceBudgets(tx, {
          workspaceId: endpoint.workspaceId,
          endpointId: endpoint.id,
          clientId: client.id,
          endpointDailyOutput: lockedEndpoint.dailyOutputCharacterLimit,
          clientDailyOutput: lockedClient.dailyOutputCharacterLimit,
          endpointStored: lockedEndpoint.maxStoredCharacters,
          clientStored: lockedClient.maxStoredCharacters,
        });

        const [
          endpointActive,
          clientActive,
          a2aEndpointActive,
          a2aClientActive,
        ] = await Promise.all([
          tx.agentRun.count({
            where: {
              endpointId: endpoint.id,
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
          }),
          tx.agentRun.count({
            where: {
              clientId: client.id,
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
          }),
          tx.a2ATask.count({
            where: {
              context: { endpointId: endpoint.id },
              state: { in: [1, 2] },
            },
          }),
          tx.a2ATask.count({
            where: { context: { clientId: client.id }, state: { in: [1, 2] } },
          }),
        ]);
        if (
          endpointActive + a2aEndpointActive >= lockedEndpoint.maxConcurrent ||
          clientActive + a2aClientActive >= lockedClient.maxConcurrent
        ) {
          throw new AgentApiError(
            "concurrency_limit_exceeded",
            publicErrorMessage("concurrency_limit_exceeded"),
            429,
            1,
          );
        }

        let publicConversation: null | {
          id: string;
          publicId: string;
          revisionId: string;
          runtimeAllocationId: string;
          runtimeAllocation: { subjectHash: string };
          revision: { version: number };
        } = null;
        if (input.conversationId) {
          publicConversation = await tx.agentPublicConversation.findFirst({
            where: {
              publicId: input.conversationId,
              endpointId: endpoint.id,
              clientId: client.id,
              subjectHash,
              deletingAt: null,
            },
            select: {
              id: true,
              publicId: true,
              revisionId: true,
              runtimeAllocationId: true,
              runtimeAllocation: { select: { subjectHash: true } },
              revision: { select: { version: true } },
            },
          });
          if (!publicConversation) {
            throw new AgentApiError(
              "conversation_not_found",
              publicErrorMessage("conversation_not_found"),
              404,
            );
          }
          await tx.$queryRaw`SELECT "id" FROM "AgentPublicConversation" WHERE "id" = ${publicConversation.id} FOR UPDATE`;
          const stillAvailable = await tx.agentPublicConversation.findFirst({
            where: { id: publicConversation.id, deletingAt: null },
            select: { id: true },
          });
          if (!stillAvailable) {
            throw new AgentApiError(
              "conversation_not_found",
              publicErrorMessage("conversation_not_found"),
              404,
            );
          }
          const busy = await tx.agentRun.count({
            where: {
              publicConversationId: publicConversation.id,
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
          });
          if (busy > 0) {
            throw new AgentApiError(
              "conversation_busy",
              publicErrorMessage("conversation_busy"),
              409,
              1,
            );
          }
        } else {
          const conversationCount = await tx.agentPublicConversation.count({
            where: {
              endpointId: endpoint.id,
              clientId: client.id,
              subjectHash,
              deletingAt: null,
            },
          });
          if (conversationCount >= MAX_CONVERSATIONS_PER_CLIENT_SUBJECT) {
            throw new AgentApiError(
              "resource_limit_exceeded",
              publicErrorMessage("resource_limit_exceeded"),
              429,
            );
          }
        }

        const revisionId =
          publicConversation?.revisionId ?? lockedEndpoint.currentRevision.id;
        const revisionVersion =
          publicConversation?.revision.version ??
          lockedEndpoint.currentRevision.version;
        const timeoutSeconds = Math.min(
          lockedEndpoint.timeoutSeconds,
          AGENT_API_MAX_TIMEOUT_SECONDS,
        );
        const run = await tx.agentRun.create({
          data: {
            publicId: createAgentResponseId(),
            requestId: createAgentRequestId(),
            endpointId: endpoint.id,
            revisionId,
            clientId: client.id,
            subjectHash,
            publicConversationId: publicConversation?.id ?? null,
            runtimeAllocationId:
              publicConversation?.runtimeAllocationId ?? null,
            idempotencyKey,
            requestHash,
            status: "provisioning",
            stream: input.stream,
            inputCharacters: input.input.length,
            deadlineAt: new Date(requestStartedAt + timeoutSeconds * 1_000),
          },
        });
        return {
          run,
          publicConversation,
          revisionVersion,
          timeoutSeconds,
          allocationSubjectHash:
            publicConversation?.runtimeAllocation.subjectHash ??
            (lockedEndpoint.isolationMode === "shared"
              ? "shared"
              : subjectHash),
        } as const;
      },
      { isolationLevel: "Serializable" },
    );
  let admission: Awaited<ReturnType<typeof admit>> | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      admission = await admit();
      break;
    } catch (error) {
      if (
        !retryableAdmissionError(error, Boolean(idempotencyKey)) ||
        attempt === 4
      )
        throw error;
    }
  }
  if (!admission) {
    throw new AgentApiError(
      "internal_error",
      publicErrorMessage("internal_error"),
      500,
    );
  }

  if ("existing" in admission && admission.existing) {
    const existing = admission.existing;
    return {
      runId: existing.id,
      responseId: existing.publicId,
      requestId: existing.requestId,
      endpointId: endpoint.id,
      endpointPublicId: endpoint.publicId,
      endpointRevision: existing.revision.version,
      clientId: client.id,
      subjectHash,
      publicConversationId: existing.publicConversation?.publicId ?? "",
      input: input.input,
      stream: input.stream,
      timeoutSeconds: Math.min(
        endpoint.timeoutSeconds,
        AGENT_API_MAX_TIMEOUT_SECONDS,
      ),
      replay: true,
      rateLimitHeaders: rate.headers,
    };
  }

  await failRun(admission.run.id, "runtime_unsupported");
  throw new AgentApiError(
    "runtime_unsupported",
    publicErrorMessage("runtime_unsupported"),
    409,
  );
}

export async function executePreparedAgentResponse(
  prepared: PreparedAgentResponse,
  options: ExecuteAgentResponseOptions = {},
): Promise<AgentApiResponseView> {
  return withLogContext(
    {
      runId: prepared.runId,
      requestId: prepared.requestId,
      suppressPayload: true,
    },
    () => executeObservedResponse(prepared, options),
  );
}

async function executeObservedResponse(
  prepared: PreparedAgentResponse,
  _options: ExecuteAgentResponseOptions,
): Promise<AgentApiResponseView> {
  if (prepared.replay) {
    const replay = await getAgentResponseForPrincipal({
      endpointPublicId: prepared.endpointPublicId,
      responseId: prepared.responseId,
      clientId: prepared.clientId,
      subjectHash: prepared.subjectHash,
    });
    if (!replay)
      throw new AgentApiError(
        "not_found",
        publicErrorMessage("not_found"),
        404,
      );
    return replay;
  }

  await failRun(prepared.runId, "runtime_unsupported");
  throw new AgentApiError(
    "runtime_unsupported",
    publicErrorMessage("runtime_unsupported"),
    409,
  );
}

type ResponseLookup = {
  endpointPublicId: string;
  responseId: string;
  clientId: string;
  subjectHash?: string | null;
};

export async function getAgentResponseForPrincipal(
  input: ResponseLookup,
): Promise<AgentApiResponseView | null> {
  const run = await db.agentRun.findFirst({
    where: {
      publicId: input.responseId,
      clientId: input.clientId,
      endpoint: { publicId: input.endpointPublicId },
      ...(input.subjectHash ? { subjectHash: input.subjectHash } : {}),
    },
    include: {
      endpoint: { select: { publicId: true } },
      revision: { select: { version: true } },
      publicConversation: { select: { publicId: true } },
    },
  });
  return run ? agentRunResponseView(run) : null;
}

export async function requestAgentResponseCancellation(
  input: ResponseLookup,
): Promise<
  (AgentApiResponseView & { cancellation_requested: boolean }) | null
> {
  const run = await db.agentRun.findFirst({
    where: {
      publicId: input.responseId,
      clientId: input.clientId,
      endpoint: { publicId: input.endpointPublicId },
      ...(input.subjectHash ? { subjectHash: input.subjectHash } : {}),
    },
    include: {
      endpoint: { select: { publicId: true } },
      revision: { select: { version: true } },
      publicConversation: { select: { publicId: true } },
    },
  });
  if (!run) return null;
  const active = (ACTIVE_RUN_STATUSES as readonly string[]).includes(
    run.status,
  );
  let cancellationRequested = false;
  if (active) {
    const cancelledAt = new Date();
    const cancelled = await db.agentRun.updateMany({
      where: {
        id: run.id,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        cancelRequestedAt: null,
      },
      data: {
        status: "cancelled",
        errorCode: "cancelled",
        cancelRequestedAt: cancelledAt,
        completedAt: cancelledAt,
      },
    });
    cancellationRequested = cancelled.count === 1;
    if (cancellationRequested) abortAgentApiRun(run.publicId);
  }
  const latest = active
    ? await db.agentRun.findUnique({
        where: { id: run.id },
        include: {
          endpoint: { select: { publicId: true } },
          revision: { select: { version: true } },
          publicConversation: { select: { publicId: true } },
        },
      })
    : run;
  return {
    ...agentRunResponseView(latest ?? run),
    cancellation_requested: cancellationRequested,
  };
}

export function agentRunResponseView(run: {
  publicId: string;
  requestId: string;
  status: string;
  errorCode: string | null;
  inputCharacters: number;
  outputCharacters: number;
  durationMs: number | null;
  outputText: string | null;
  createdAt: Date;
  endpoint: { publicId: string };
  revision: { version: number };
  publicConversation: { publicId: string } | null;
}): AgentApiResponseView {
  const text = run.outputText ?? "";
  const errorCode = run.errorCode as AgentApiErrorCode | null;
  return {
    id: run.publicId,
    object: "agent.response",
    created_at: Math.floor(run.createdAt.getTime() / 1_000),
    endpoint_id: run.endpoint.publicId,
    endpoint_revision: run.revision.version,
    conversation_id: run.publicConversation?.publicId ?? null,
    status: run.status,
    output: text
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ]
      : [],
    output_text: text,
    usage: {
      input_characters: run.inputCharacters,
      output_characters: run.outputCharacters,
      duration_ms: run.durationMs ?? 0,
    },
    request_id: run.requestId,
    ...(errorCode
      ? { error: { code: errorCode, message: publicErrorMessage(errorCode) } }
      : {}),
  };
}
