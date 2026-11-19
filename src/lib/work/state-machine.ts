import { WorkSessionStatus } from "@prisma/client";

const statuses = Object.values(WorkSessionStatus);

export const READ_ONLY_WORK_SESSION_STATUSES: WorkSessionStatus[] = [
  "archived",
  "forking",
];

// A branch is not executable until its native session has been forked. An
// interrupted fork is archived rather than exposing incomplete native history.

const transitions: Record<WorkSessionStatus, readonly WorkSessionStatus[]> = {
  idle: ["queued"],
  queued: ["idle", "running", "failed"],
  running: ["idle", "waiting_user", "failed", "cancelling"],
  waiting_user: ["idle", "queued", "failed"],
  cancelling: ["idle"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: [],
  archived: [],
  forking: ["idle", "archived"],
};

export function isWorkSessionReadOnly(status: WorkSessionStatus) {
  return READ_ONLY_WORK_SESSION_STATUSES.includes(status);
}

export function canTransitionWorkSession(
  from: WorkSessionStatus,
  to: WorkSessionStatus,
): boolean {
  return transitions[from].includes(to);
}

export function allowedWorkSessionSources(to: WorkSessionStatus) {
  return statuses.filter((from) => canTransitionWorkSession(from, to));
}
