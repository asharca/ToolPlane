import 'server-only';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';

type McpOperationResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };

const operationGlobal = globalThis as typeof globalThis & {
  __mcpWorkspaceOperationQueues?: Map<string, Promise<void>>;
};

function queues(): Map<string, Promise<void>> {
  return operationGlobal.__mcpWorkspaceOperationQueues ??= new Map();
}

// Serialize configuration writes and lifecycle actions for one deployment,
// while also participating in workspace teardown draining. Holding this lock
// through startProcess/killProcess closes the gap between reading required env
// values and enqueuing the corresponding supervisor operation.
export async function runMcpDeploymentOperation<T>(
  workspaceId: string,
  deploymentId: string,
  operation: () => Promise<T>,
): Promise<McpOperationResult<T>> {
  const releaseWorkspaceOperation = beginWorkspaceOperation(workspaceId);
  if (!releaseWorkspaceOperation) return { accepted: false };

  const entries = queues();
  const previous = entries.get(deploymentId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  entries.set(deploymentId, tail);

  try {
    return { accepted: true, value: await result };
  } finally {
    if (entries.get(deploymentId) === tail) entries.delete(deploymentId);
    releaseWorkspaceOperation();
  }
}
