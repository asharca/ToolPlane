import { resolveRequestUser } from '@/lib/auth/request-user';
import {
  AGENT_API_SSE_HEADERS,
  encodeSseDone,
  encodeSseEvent,
  encodeSseHeartbeat,
} from '@/lib/agents/public-api/sse';
import {
  subscribeWorkOutput,
  type WorkOutputActivity,
  type WorkOutputSnapshot,
} from '@/lib/work/run-control';
import { getWorkSessionForUser } from '@/lib/work/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIVE_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'cancelling']);

function completedOutput(messages: Array<{ role: string; parts: unknown }>): WorkOutputSnapshot {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUser = index;
      break;
    }
  }
  const text: string[] = [];
  const activities = new Map<string, WorkOutputActivity>();
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const [index, part] of message.parts.entries()) {
      if (!part || typeof part !== 'object' || !('type' in part)) continue;
      const value = part as Record<string, unknown>;
      if (value.type === 'text' && typeof value.text === 'string') text.push(value.text);
      if (value.type === 'reasoning' && typeof value.text === 'string') {
        activities.set('reasoning', {
          id: 'reasoning',
          type: 'reasoning',
          status: 'completed',
          text: value.text,
        });
      }
      if (value.type === 'work-runtime' && typeof value.runtimeKind === 'string') {
        activities.set('runtime', {
          id: 'runtime',
          type: 'runtime',
          status: value.status === 'failed' ? 'failed' : value.status === 'cancelled' ? 'cancelled' : 'completed',
          runtimeKind: value.runtimeKind,
        });
      }
      if (value.type === 'work-tool') {
        const toolCallId = typeof value.toolCallId === 'string' ? value.toolCallId : `history-${index}`;
        const isError = value.isError === true || value.status === 'failed';
        activities.set(`tool:${toolCallId}`, {
          id: `tool:${toolCallId}`,
          type: 'tool',
          status: isError ? 'failed' : value.status === 'running' ? 'running' : value.status === 'cancelled' ? 'cancelled' : 'completed',
          toolCallId,
          toolName: typeof value.toolName === 'string' ? value.toolName : 'Tool',
          input: value.input,
          output: value.output,
          isError,
        });
      }
    }
  }
  return { text: text.join('\n'), activities: [...activities.values()], active: false, done: true };
}

function outputData(snapshot: WorkOutputSnapshot, delta?: string, activity?: WorkOutputActivity) {
  return {
    ...snapshot,
    ...(delta === undefined ? {} : { delta }),
    ...(activity === undefined ? {} : { activity }),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ workSessionId: string }> },
) {
  const user = await resolveRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { workSessionId } = await params;
  const work = await getWorkSessionForUser(user.id, workSessionId);
  if (!work) return Response.json({ error: 'Not found' }, { status: 404 });

  if (!LIVE_STATUSES.has(work.status)) {
    const snapshot = completedOutput(work.conversation.messages);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeSseEvent('snapshot', snapshot));
        controller.enqueue(encodeSseEvent('done', snapshot));
        controller.enqueue(encodeSseDone());
        controller.close();
      },
    }), { headers: AGENT_API_SSE_HEADERS });
  }

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };
      const onAbort = () => close();
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener('abort', onAbort);
        try { controller.close(); } catch { /* the client already disconnected */ }
      }

      const heartbeat = setInterval(() => enqueue(encodeSseHeartbeat()), 15_000);
      heartbeat.unref?.();
      const subscription = subscribeWorkOutput(workSessionId, (event) => {
        enqueue(encodeSseEvent(
          event.type,
          outputData(
            event.snapshot,
            event.type === 'delta' ? event.delta : undefined,
            event.type === 'activity' ? event.activity : undefined,
          ),
        ));
        if (event.type === 'done') {
          enqueue(encodeSseDone());
          close();
        }
      });
      unsubscribe = subscription.unsubscribe;
      cleanup = close;
      req.signal.addEventListener('abort', onAbort, { once: true });
      enqueue(encodeSseEvent('snapshot', subscription.snapshot));
      if (subscription.snapshot.done) {
        enqueue(encodeSseEvent('done', subscription.snapshot));
        enqueue(encodeSseDone());
        close();
        return;
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: AGENT_API_SSE_HEADERS });
}
