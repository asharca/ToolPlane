import type { ToolApprovalCard } from "./tool-approvals";
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
export type ToolApprovalDataPart = {
  type: "data-tool-approval";
  id: string;
  data: ToolApprovalCard;
};
/** Full state; starts every connection, a new task or turn, and a null observation. */
export type LiveTaskSnapshotEvent = {
  seq: number;
  output: LiveTaskOutput | null;
  dataParts?: ToolApprovalDataPart[];
};
/** Changes since the frame numbered `seq - 1` of the same connection and task turn. */
export type LiveTaskDeltaEvent = {
  seq: number;
  taskId: string;
  /** Text replaces everything from `textAt`; equal to the previous length for an append. */
  textAt?: number;
  text?: string;
  /** Added or changed activities. */
  activities?: LiveTaskActivity[];
  /** Full activity order, present only when membership or order changed. */
  activityIds?: string[];
  /** Every output field except text and activities, present only when one changed. */
  fields?: Omit<LiveTaskOutput, "text" | "activities">;
  dataParts?: ToolApprovalDataPart[];
};
export type LiveTaskSettledEvent = { taskId: string };
