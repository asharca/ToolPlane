import 'server-only';
import { db } from '@/lib/db';

type Subscription = { workspaceId: string; userId: string; close: () => void };
const accessGlobal = globalThis as typeof globalThis & { __workspaceAccessStreams?: Set<Subscription> };
const subscriptions = accessGlobal.__workspaceAccessStreams ??= new Set<Subscription>();

export function revokeWorkspaceStreams(workspaceId: string, userId?: string) {
  for (const subscription of subscriptions) {
    if (subscription.workspaceId === workspaceId && (!userId || subscription.userId === userId)) subscription.close();
  }
}

export function workspaceAccessResponse(response: Response, workspaceId: string, userId: string, signal: AbortSignal) {
  return response.body ? new Response(workspaceAccessStream(response.body, workspaceId, userId, signal), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  }) : response;
}

// Same-process revocation is immediate; recheck every five seconds for removals
// made by another server process. A failed authorization check closes the stream.
export function workspaceAccessStream(body: ReadableStream<Uint8Array>, workspaceId: string, userId: string, signal: AbortSignal) {
  const reader = body.getReader();
  let close = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let checking = false;
      const subscription = { workspaceId, userId, close: () => close() };
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        subscriptions.delete(subscription);
        signal.removeEventListener('abort', close);
        void reader.cancel().catch(() => {});
        try { controller.close(); } catch { /* already cancelled downstream */ }
      };
      async function check() {
        if (closed || checking) return;
        checking = true;
        try {
          const accessible = await db.workspace.findFirst({
            where: { id: workspaceId, status: 'active', OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
            select: { id: true },
          });
          if (!accessible) close();
        } catch { close(); }
        finally { checking = false; }
      }
      subscriptions.add(subscription);
      signal.addEventListener('abort', close, { once: true });
      const timer = setInterval(() => { void check(); }, 5000);
      timer.unref?.();
      if (signal.aborted) close();
      void (async () => {
        await check();
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!closed) controller.enqueue(value);
        }
      })().catch(() => {}).finally(close);
    },
    cancel() { close(); },
  });
}
