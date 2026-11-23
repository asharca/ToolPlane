import "server-only";
import type { Prisma, WorkSessionStatus } from "@prisma/client";
import { recordSystemFailureFeedback } from "@/lib/feedback/service";
import { workFailures, type WorkFailureCode } from "./failures";
import { allowedWorkSessionSources } from "./state-machine";

type WorkSessionWriter = Pick<Prisma.TransactionClient, "workSession"> &
  Partial<Pick<Prisma.TransactionClient, "feedback" | "feedbackOccurrence">>;

export function insertWorkSession(
  writer: WorkSessionWriter,
  status: Extract<WorkSessionStatus, "queued" | "forking">,
  data: Omit<Prisma.WorkSessionUncheckedCreateInput, "status" | "error">,
) {
  return writer.workSession.create({
    data: { ...data, status },
    omit: { uiProjection: true, uiLease: true },
    include: { conversation: true, sandbox: { include: { deployment: true } } },
  });
}

type TransitionFields = Pick<
  Prisma.WorkSessionUncheckedUpdateManyInput,
  | "a2aActorId"
  | "artifacts"
  | "cancelRequestedAt"
  | "completedAt"
  | "result"
  | "startedAt"
  | "uiLease"
  | "uiProjection"
  | "waitingQuestion"
>;
type Transition = TransitionFields &
  (
    | { status: "failed"; error: WorkFailureCode }
    | { status: Exclude<WorkSessionStatus, "failed">; error?: null }
  );

/** Compare and set, intersecting the caller's scope with the legal source states. */
export function updateWorkSessionStatus(
  writer: WorkSessionWriter,
  where: Prisma.WorkSessionWhereInput,
  transition: Transition,
) {
  if (transition.status === "failed" && !workFailures.is(transition.error)) {
    throw new Error("Unregistered Work failure code");
  }
  const matchWhere: Prisma.WorkSessionWhereInput = {
    AND: [
      where,
      { status: { in: allowedWorkSessionSources(transition.status) } },
    ],
  };
  if (transition.status !== "failed") {
    return writer.workSession.updateMany({
      where: matchWhere,
      data: transition,
    });
  }
  return (async () => {
    const canRecordFeedback = Boolean(
      writer.feedback && writer.feedbackOccurrence,
    );
    const sessions = canRecordFeedback
      ? await writer.workSession
          .findMany({
            where: matchWhere,
            select: {
              id: true,
              workspaceId: true,
              agentId: true,
              conversationId: true,
              runtimeKind: true,
            },
            take: 10,
          })
          .catch(() => [])
      : [];
    const updated = await writer.workSession.updateMany({
      where: matchWhere,
      data: transition,
    });
    if (updated.count > 0 && canRecordFeedback && sessions.length > 0) {
      try {
        for (const session of sessions) {
          await recordSystemFailureFeedback(
            writer as Prisma.TransactionClient,
            {
              code: transition.error,
              stage: "work",
              runtimeKind: session.runtimeKind,
              sourceKind: "work",
              sourceId: session.id,
              workspaceId: session.workspaceId,
              agentId: session.agentId,
              conversationId: session.conversationId,
              workSessionId: session.id,
            },
          );
        }
      } catch {
        // Feedback recording must never alter WorkSession settlement.
      }
    }
    return updated;
  })();
}
