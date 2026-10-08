import 'server-only';
import type { TaskGrant } from '@/lib/a2a/principal';
import { getLogContext, withLogContext } from './context';
import { recordEvent, logHealth, a2aLogMetadataSchema } from './events';
import type { A2ALogMetadata, LogOutcome } from './events';
export type { A2ALogMetadata } from './events';

export type A2ALogBinding = {
  grant: TaskGrant;
  taskId?: string;
  contextId?: string;
  rootTaskId?: string;
  parentTaskId?: string;
};
export type A2ALogInput = {
  eventName: 'a2a.request' | 'a2a.task.started' | 'a2a.task.settled';
  binding?: A2ALogBinding;
  metadata: A2ALogMetadata;
  rpcMethod?: string;
  toolName?: string;
  method?: string;
  path?: string;
  httpStatus?: number;
  outcome: LogOutcome;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  responseKind?: 'json' | 'sse' | 'none';
  responseComplete?: boolean;
  truncated?: boolean;
  secrets?: readonly string[];
};

export function a2aTaskOutcome(state?: string): LogOutcome {
  return state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_REJECTED' ? 'error'
    : state === 'TASK_STATE_CANCELED' ? 'cancelled' : 'success';
}

export function taskStateName(state: string): string {
  return state.startsWith('TASK_STATE_') ? state : `TASK_STATE_${state}`;
}

/** The only trusted A2A payload boundary. Never changes execution suppression. */
export async function recordA2AEvent(input: A2ALogInput): Promise<void> {
  try {
    const { binding, metadata, request, response, responseKind, responseComplete, truncated, secrets, ...fields } = input;
    const grant = binding?.grant;
    const workspaceGrant = grant && 'kind' in grant;
    const identity = grant ? {
      workspaceId: grant.workspaceId,
      ...(workspaceGrant ? { actorId: grant.actorId, agentId: grant.kind === 'local' ? grant.agentId : grant.sourceAgentId } : {}),
    } : {};
    const a2a = a2aLogMetadataSchema.parse({ ...metadata,
      ...(grant ? { endpointId: workspaceGrant ? undefined : grant.endpointId,
        clientId: workspaceGrant ? undefined : grant.clientId,
        remoteAgentId: workspaceGrant && grant.kind === 'remote' ? grant.remoteAgentId : undefined } : {}),
      ...(binding ? { taskId: binding.taskId, contextId: binding.contextId,
        rootTaskId: binding.rootTaskId ?? (workspaceGrant ? grant.rootTaskId : undefined) ?? binding.taskId,
        parentTaskId: binding.parentTaskId ?? (workspaceGrant ? grant.parentTaskId : undefined) } : {}),
    });
    const current = getLogContext();
    const capture = Boolean(binding && input.outcome !== 'denied' && input.eventName !== 'a2a.task.started');
    await withLogContext({ ...identity, requestId: current?.requestId, traceId: current?.traceId,
      parentSpanId: current?.spanId, secrets: [...(current?.secrets ?? []), ...(secrets ?? [])],
    }, () => recordEvent({ ...fields, domain: 'a2a', a2a, detailTruncated: truncated,
      payloadPolicy: capture ? 'request-response' : 'metadata-only',
      ...(capture && (request !== undefined || response !== undefined || responseKind !== undefined) ? {
        detail: async () => ({ ...(request !== undefined ? { request: typeof request === 'function' ? await request() : request } : {}),
          ...(response !== undefined ? { response: typeof response === 'function' ? await response() : response } : {}),
          responseKind: responseKind ?? (response === undefined ? 'none' : 'json'), responseComplete: responseComplete ?? false }),
      } : {}),
    }), true);
  } catch { logHealth.failures += 1; }
}
