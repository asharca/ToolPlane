import 'server-only';
import { runtimeRequestUnavailable, runtimeRequest, RuntimeUnavailableError } from '@/lib/runtime/ownership-state';
import { getLogContext, newRequestId, withLogContext } from './context';
import { recordEvent } from './events';

export function withRequestLogging<A extends unknown[], R extends Response | undefined>(
  route: string, handler: (req: Request, ...args: A) => R | Promise<R>,
): (req: Request, ...args: A) => Promise<Exclude<R, undefined>> {
  return (req, ...args) => runtimeRequest(route, req.method, () => withLogContext({ requestId: newRequestId(),
    secrets: [req.headers.get('authorization') ?? '', req.headers.get('authorization')?.replace(/^(Bearer|Basic)\s+/i, '') ?? '',
      req.headers.get('x-api-key') ?? '', req.headers.get('x-toolplane-runtime-token') ?? '',
      ...(req.headers.get('cookie') ?? '').split(';').map((cookie) => cookie.slice(cookie.indexOf('=') + 1).trim()).filter((value) => value.length >= 8)],
  }, async () => {
    const start = performance.now();
    const context = getLogContext()!;
    const agentRoute = /\/(?:agents|agent-runtimes?|agent-endpoints|work-sessions)(?:\/|$)/.test(route) || route.includes('/api/openai/v1/chat');
    const base = { payloadPolicy: agentRoute ? 'agent-content' as const : 'metadata-only' as const, domain: 'http' as const, eventName: 'http.request', method: req.method, path: route };
    try {
      if (runtimeRequestUnavailable(route, req.method)) return Response.json({ error: 'runtime_not_ready' }, { status: 503, headers: { 'Retry-After': '5', 'cache-control': 'no-store' } }) as Exclude<R, undefined>;
      const response = await handler(req, ...args);
      if (!response) throw new Error('Request handler did not return a response');
      // Preserve public API IDs already assigned by the admission layer.
      context.requestId = response.headers.get('x-request-id') ?? context.requestId;
      const headers = new Headers(response.headers);
      headers.set('x-request-id', context.requestId!);
      const status = response.status;
      const finish = async (error?: unknown, cancelled = false) => recordEvent({ ...base, httpStatus: status,
        outcome: cancelled ? 'cancelled' : error ? 'error' : status === 401 || status === 403 ? 'denied' : status >= 400 ? 'error' : 'success',
        durationMs: Math.round(performance.now() - start), error });
      if (!response.body || !headers.get('content-type')?.includes('text/event-stream')) {
        await finish();
        return new Response(response.body, { status, statusText: response.statusText, headers }) as Exclude<R, undefined>;
      }
      const reader = response.body.getReader();
      let ended = false;
      const finishOnce = (error?: unknown, cancelled = false) => {
        if (ended) return Promise.resolve();
        ended = true;
        return withLogContext(context, () => finish(error, cancelled));
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (ended) return;
            if (chunk.done) { await finishOnce(undefined, req.signal.aborted); reader.releaseLock(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) {
            if (ended) return;
            await finishOnce(error, req.signal.aborted); reader.releaseLock(); controller.error(error);
          }
        },
        async cancel(reason) {
          const finished = finishOnce(undefined, true);
          try { await reader.cancel(reason); } finally { await finished; reader.releaseLock(); }
        },
      });
      return new Response(body, { status, statusText: response.statusText, headers }) as Exclude<R, undefined>;
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) return Response.json({ error: 'runtime_not_ready' }, { status: 503, headers: { 'Retry-After': '5' } }) as Exclude<R, undefined>;
      const digest = error && typeof error === 'object' && 'digest' in error ? String(error.digest) : '';
      if (!digest.startsWith('NEXT_REDIRECT') && !digest.startsWith('NEXT_HTTP_ERROR_FALLBACK')) {
        await recordEvent({ ...base, error, httpStatus: 500, durationMs: Math.round(performance.now() - start) });
      }
      throw error;
    }
  }));
}
