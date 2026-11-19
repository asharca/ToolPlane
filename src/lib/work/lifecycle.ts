import "server-only";
import type { Prisma, WorkSessionStatus } from "@prisma/client";
import { workFailures, type WorkFailureCode } from "./failures";
import { allowedWorkSessionSources } from "./state-machine";

type WorkSessionWriter = Pick<Prisma.TransactionClient, "workSession">;

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
  return writer.workSession.updateMany({
    where: {
      AND: [
        where,
        { status: { in: allowedWorkSessionSources(transition.status) } },
      ],
    },
    data: transition,
  });
}
