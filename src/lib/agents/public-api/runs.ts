import "server-only";
import { db } from "@/lib/db";
import {
  publicErrorMessage,
  type AgentApiErrorCode,
} from "@/lib/agents/public-api/errors";
import { abortAgentApiRun } from "@/lib/agents/public-api/run-control";
import type { AgentApiResponseView } from "@/lib/agents/public-api/sse";

const ACTIVE_RUN_STATUSES = ["provisioning", "running"] as const;

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
