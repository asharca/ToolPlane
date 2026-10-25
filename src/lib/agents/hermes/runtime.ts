import "server-only";
import { db } from "@/lib/db";
import { killProcess, stopProcess } from "@/lib/process/supervisor";
import {
  removeDockerSandboxRuntimeStrict,
  sandboxVolumeName,
  stopDockerSandboxContainer,
} from "@/lib/sandboxes/runtime";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { HERMES_ARCHIVE_IMPORT_TIMEOUT_MS } from "./archive-limits";

const blockedLifecycle: Record<string, true> = {
  copying: true,
  copy_failed: true,
  restoring: true,
  restore_failed: true,
  restore_cleanup_required: true,
  upgrading: true,
  deleting: true,
};
const globalRuntime = globalThis as unknown as {
  __hermesOperationQueues?: Map<string, Promise<void>>;
};

/** Only bound stop/delete operations remain; retired runtimes are never booted. */
function enqueueHermesCleanup<T>(
  workspaceId: string,
  agentId: string,
  rejected: T,
  operation: () => Promise<T>,
): Promise<T> {
  const release = beginWorkspaceOperation(workspaceId);
  if (!release) return Promise.resolve(rejected);
  globalRuntime.__hermesOperationQueues ??= new Map();
  const queues = globalRuntime.__hermesOperationQueues;
  const key = `${workspaceId}:${agentId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  return result.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
    release();
  });
}

export async function stopHermesRuntime(
  workspaceId: string,
  agentId: string,
): Promise<void> {
  await enqueueHermesCleanup(workspaceId, agentId, undefined, async () => {
    const runtime = await db.agentRuntime.findFirst({
      where: { workspaceId, agentId, kind: "hermes" },
      include: { sandbox: { include: { deployment: true } } },
    });
    if (!runtime || blockedLifecycle[runtime.sandbox.deployment.status]) return;
    try {
      await stopProcess(runtime.sandbox.deploymentId);
      await stopDockerSandboxContainer(runtime.sandboxId);
      await db.agentRuntime.updateMany({
        where: { id: runtime.id, workspaceId },
        data: { status: "stopped", lastError: null },
      });
    } catch (error) {
      const message =
        `Could not stop the Hermes runtime: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        );
      await Promise.all([
        db.agentRuntime
          .updateMany({
            where: { id: runtime.id, workspaceId },
            data: { status: "error", lastError: message },
          })
          .catch(() => undefined),
        db.deployment
          .updateMany({
            where: {
              id: runtime.sandbox.deploymentId,
              workspaceId,
              source: "sandbox",
            },
            data: { status: "error" },
          })
          .catch(() => undefined),
      ]);
      throw new Error(message, { cause: error });
    }
  });
}

/** Explicit deletion only; normal stop preserves every retained workspace volume. */
export async function cleanupHermesRuntime(
  workspaceId: string,
  agentId: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  return enqueueHermesCleanup(workspaceId, agentId, false, async () => {
    const runtime = await db.agentRuntime.findFirst({
      where: { workspaceId, agentId, kind: "hermes" },
      include: { sandbox: true },
    });
    if (!runtime) return true;
    await killProcess(runtime.sandbox.deploymentId, {
      preventRestart: true,
      finalStatus: "deleting",
    });
    await db.deployment.updateMany({
      where: {
        id: runtime.sandbox.deploymentId,
        workspaceId,
        source: "sandbox",
      },
      data: { status: "deleting" },
    });
    await removeDockerSandboxRuntimeStrict(
      runtime.sandboxId,
      sandboxVolumeName(runtime.sandboxId),
      { timeoutMs: options.timeoutMs ?? HERMES_ARCHIVE_IMPORT_TIMEOUT_MS },
    );
    return true;
  });
}
