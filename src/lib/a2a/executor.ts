import "server-only";
import type { Artifact, TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import {
  isLocalGrant,
  isRemoteGrant,
  A2AHttpError,
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
/** Published legacy runtime history is retained, but its execution API is retired. */
export const executePublishedTask: TaskExecutor = async () => {
  throw new A2AHttpError(
    410,
    "Legacy published Agent execution is retired. Register a new Pi Agent capability client.",
  );
};

/** Target dispatch belongs to the native task core, never the legacy Responses lifecycle. */
export const executeTask: TaskExecutor = async (row, signal) => {
  if (isRemoteGrant(row.grant as unknown as TaskGrant)) {
    const { executeRemoteTask } = await import("./remote-executor");
    return executeRemoteTask(row, signal);
  }
  if (isLocalGrant(row.grant as unknown as TaskGrant)) {
    const { executeLocalTask } = await import("./local-executor");
    return executeLocalTask(row, signal);
  }
  return executePublishedTask(row, signal);
};
