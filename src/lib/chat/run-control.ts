import 'server-only';
import { type UIMessageChunk } from 'ai';
import { db } from '@/lib/db';
import { beginRuntimeOperation, runtimeAbortSignal } from '@/lib/runtime/ownership-state';
import { systemLog } from '@/lib/observability/system';
import { CHAT_TURN_STALE_AFTER_MS, finishChatTurn } from './service';

export type ChatRunOutput = { stream: ReadableStream<UIMessageChunk>; turnId: string };

type ChatRun = {
  turnId: string;
  assistantMessageId: string;
  controller: AbortController;
  chunks: UIMessageChunk[];
  listeners: Set<() => void>;
  done: boolean;
};
const globals = globalThis as typeof globalThis & { __chatRuns?: Map<string, ChatRun> };
// ponytail: replay lives on the single runtime owner; use shared storage before horizontal scaling.
const runs = globals.__chatRuns ??= new Map<string, ChatRun>();

export function isChatRunActive(threadId: string) {
  const run = runs.get(threadId);
  return Boolean(run && !run.done);
}

export function startChatRun(
  scope: { threadId: string; turnId: string; assistantMessageId: string; workspaceId: string; userId: string },
  createStream: (signal: AbortSignal) => ReadableStream<UIMessageChunk>,
): ChatRunOutput {
  const release = beginRuntimeOperation();
  const controller = new AbortController();
  const ownerSignal = runtimeAbortSignal();
  const signal = ownerSignal ? AbortSignal.any([controller.signal, ownerSignal]) : controller.signal;
  const run: ChatRun = {
    turnId: scope.turnId, assistantMessageId: scope.assistantMessageId,
    controller, chunks: [], listeners: new Set(), done: false,
  };
  runs.set(scope.threadId, run);
  const notify = () => {
    for (const listener of run.listeners) listener();
    run.listeners.clear();
  };
  const deadline = setTimeout(() => controller.abort(new DOMException('Chat turn timed out.', 'TimeoutError')), CHAT_TURN_STALE_AFTER_MS);
  deadline.unref?.();
  let checking = false;
  const accessTimer = setInterval(() => {
    if (checking || signal.aborted) return;
    checking = true;
    void db.chatTurn.findFirst({
      where: {
        id: scope.turnId, threadId: scope.threadId, status: 'pending',
        thread: { workspaceId: scope.workspaceId, workspace: {
          status: 'active', OR: [{ ownerId: scope.userId }, { members: { some: { userId: scope.userId } } }],
        } },
      },
      select: { id: true },
    }).then((turn) => {
      if (!turn) controller.abort(new Error('Chat execution access was revoked.'));
    }).catch(() => controller.abort(new Error('Chat execution access could not be verified.')))
      .finally(() => { checking = false; });
  }, 5000);
  accessTimer.unref?.();

  // This reader belongs to the server, never to an HTTP response. It also drives persistence.
  void (async () => {
    const reader = createStream(signal).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        run.chunks.push(value);
        notify();
      }
    } finally { reader.releaseLock(); }
  })().catch(async (error) => {
    controller.abort(error);
    run.chunks.push({ type: 'error', errorText: 'Chat turn failed.' });
    await finishChatTurn(scope.threadId, scope.turnId, 'failed', error instanceof Error ? error.message : 'Chat turn failed', scope.assistantMessageId);
  }).catch((error) => systemLog('error', '[chat] background persistence failed', error))
    .finally(() => {
      clearTimeout(deadline);
      clearInterval(accessTimer);
      run.done = true;
      notify();
      release();
      const cleanup = setTimeout(() => {
        if (runs.get(scope.threadId) === run) runs.delete(scope.threadId);
      }, 60_000);
      cleanup.unref?.();
    });
  return subscribeChatRun(scope.threadId, scope.assistantMessageId)!;
}

// Callers must authorize the thread first; matching its active message prevents branch replay.
export function subscribeChatRun(threadId: string, assistantMessageId: string | null): ChatRunOutput | null {
  const run = runs.get(threadId);
  if (!run || run.assistantMessageId !== assistantMessageId) return null;
  let index = 0;
  let closed = false;
  let wake: (() => void) | undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      while (!closed && index === run.chunks.length && !run.done) {
        const waiting = Promise.withResolvers<void>();
        wake = waiting.resolve;
        run.listeners.add(wake);
        await waiting.promise;
      }
      if (closed) return;
      if (index < run.chunks.length) controller.enqueue(run.chunks[index++]!);
      else controller.close();
    },
    cancel() {
      closed = true;
      if (wake) { run.listeners.delete(wake); wake(); }
    },
  });
  return { stream, turnId: run.turnId };
}

export function cancelChatRun(threadId: string, turnId: string) {
  const run = runs.get(threadId);
  if (!run || run.turnId !== turnId || run.done) return false;
  run.controller.abort(new DOMException('Chat turn stopped by user.', 'AbortError'));
  return true;
}
