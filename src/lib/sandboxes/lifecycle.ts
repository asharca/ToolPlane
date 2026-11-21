import "server-only";
import { db } from "@/lib/db";
import type { Deployment, Sandbox } from "@prisma/client";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { trackRuntimeOperation } from "@/lib/runtime/ownership-state";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";
import {
  effectiveStatus,
  killProcess,
  startProcess,
  stopProcess,
} from "@/lib/process/supervisor";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { stopDockerSandboxContainer } from "./runtime";
import { frozenSandboxes, sandboxAccesses } from "./activity";

const root = globalThis as typeof globalThis & {
  __sandboxOperationQueues?: Map<string, Promise<void>>;
};

export function enqueueSandboxOperation<T>(
  workspaceId: string,
  sandboxId: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const release = beginWorkspaceOperation(workspaceId);
  if (!release) return Promise.resolve(undefined);
  root.__sandboxOperationQueues ??= new Map();
  const queues = root.__sandboxOperationQueues;
  const previous = queues.get(sandboxId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() =>
      trackRuntimeOperation(() =>
        withSandboxExecutionLease(sandboxId, async () => {
          if (sandboxAccesses.get(sandboxId)?.active)
            throw new Error("Sandbox has active file or terminal access.");
          frozenSandboxes.add(sandboxId);
          try {
            return await operation();
          } finally {
            frozenSandboxes.delete(sandboxId);
          }
        }),
      ),
    );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(sandboxId, tail);
  return result.finally(() => {
    if (queues.get(sandboxId) === tail) queues.delete(sandboxId);
    release();
  });
}

// Caller holds the sandbox lifecycle lease. Join in-flight MCP launches and
// release their exec streams before stopping, deleting, or replacing the target.
export async function stopWorkspaceSandboxMcps(
  workspaceId: string,
  sandboxId: string,
) {
  const consumers = await db.deployment.findMany({
    where: {
      workspaceId,
      runtimeTarget: "workspace_sandbox",
      runtimeSandboxId: sandboxId,
    },
    select: { id: true },
  });
  await Promise.all(consumers.map(({ id }) => stopProcess(id)));
}

export async function quiesceDockerSandbox<T>(
  sandbox: Sandbox & { deployment: Deployment },
  operation: (control: { preventResume: () => void }) => Promise<T>,
  options: { quiescedStatus?: string } = {},
): Promise<T> {
  const status = effectiveStatus(
    sandbox.deploymentId,
    sandbox.deployment.status,
  );
  if (
    [
      "provisioning",
      "copying",
      "copy_failed",
      "restoring",
      "restore_cleanup_required",
      "upgrading",
      "deleting",
    ].includes(status)
  )
    throw new Error("Wait for the sandbox data operation to finish.");
  const shouldResume = status === "running";
  let resumeAllowed = true;
  await stopWorkspaceSandboxMcps(sandbox.workspaceId, sandbox.id);
  await killProcess(
    sandbox.deploymentId,
    options.quiescedStatus ? { finalStatus: options.quiescedStatus } : {},
  );
  try {
    await stopDockerSandboxContainer(sandbox.id);
    return await operation({
      preventResume: () => {
        resumeAllowed = false;
      },
    });
  } finally {
    if (shouldResume && resumeAllowed)
      await startProcess(
        sandbox.deploymentId,
        resolveSpawnSpec(sandbox.deployment),
        { awaitReady: false, workspaceId: sandbox.workspaceId },
      );
  }
}
