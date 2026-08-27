export const WORK_SESSION_STATUSES = [
  'idle',
  'queued',
  'running',
  'waiting_user',
  'waiting_approval',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
] as const;

export type WorkSessionStatus = (typeof WORK_SESSION_STATUSES)[number];

const TRANSITIONS: Record<WorkSessionStatus, readonly WorkSessionStatus[]> = {
  idle: ['queued'],
  queued: ['idle', 'running', 'failed'],
  running: ['idle', 'waiting_user', 'waiting_approval', 'failed', 'cancelling'],
  waiting_user: ['idle', 'queued', 'failed'],
  waiting_approval: ['running', 'failed', 'cancelling'],
  cancelling: ['idle'],
  completed: ['queued'],
  failed: ['queued'],
  cancelled: [],
};

export function isWorkSessionStatus(value: string): value is WorkSessionStatus {
  return WORK_SESSION_STATUSES.includes(value as WorkSessionStatus);
}

export function canTransitionWorkSession(
  from: WorkSessionStatus,
  to: WorkSessionStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function allowedWorkSessionSources(to: WorkSessionStatus): WorkSessionStatus[] {
  return WORK_SESSION_STATUSES.filter((from) => canTransitionWorkSession(from, to));
}
