import "server-only";
import type { Artifact, TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import {
  assertLiveGrant,
  isLocalGrant,
  isRemoteGrant,
  type A2AGrant,
  type TaskGrant,
} from "./principal";

export type ExecutionResult = {
  state: TaskState;
  message?: string;
  artifact?: Artifact;
  deferred?: true;
  nativeOperationId?: string;
};
export type TaskExecutor = (
  task: A2ATask,
  signal: AbortSignal,
) => Promise<ExecutionResult>;
/** Published execution is unavailable; local and remote collaboration remain independent. */
export const executePublishedTask: TaskExecutor = async (row, signal) => {
  if (
    isLocalGrant(row.grant as unknown as TaskGrant) ||
    isRemoteGrant(row.grant as unknown as TaskGrant)
  )
    throw new Error("Published executor requires a published target.");
  const grant = row.grant as unknown as A2AGrant;
  await assertLiveGrant(grant, "send");
  signal.throwIfAborted();
  throw new UnsupportedOperationError(
    "This Agent runtime does not support public endpoint execution.",
  );
};

/** Target dispatch belongs to the native task core, never the legacy Responses lifecycle. */
export const executeTask: TaskExecutor = async (row, signal) => {
  if (isRemoteGrant(row.grant as unknown as TaskGrant)) {
    const { executeRemoteTask } = await import("./remote-executor");
    return executeRemoteTask(row, signal);
  }
  const { isLocalGrant } = await import("./principal");
  if (isLocalGrant(row.grant as unknown as import("./principal").TaskGrant)) {
    const { executeLocalTask } = await import("./local-executor");
    return executeLocalTask(row, signal);
  }
  return executePublishedTask(row, signal);
};
