import type {
  WorkOutputActivity,
  WorkOutputSnapshot,
} from "@/lib/work/run-control";

/** Read-only execution projection. Never includes native dialog requests or grants. */
export type LiveTaskOutput = WorkOutputSnapshot & {
  taskId: string;
  truncated?: boolean;
};
export type LiveTaskActivity = WorkOutputActivity;
export type LiveTaskSnapshotEvent = { output: LiveTaskOutput | null };
export type LiveTaskSettledEvent = { taskId: string };
