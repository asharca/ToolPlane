import 'server-only';
import { A2A_QUOTA_ERROR } from './quotas';
import { AgentCard } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { toJsonRpcError, JsonRpcRequestMalformedError, A2A_ERROR_CODE } from '@a2a-js/sdk/errors';
import { withLogContext } from '@/lib/observability/context';
import { AgentApiError } from '@/lib/agents/public-api/errors';
import { A2A_LIMITS, A2A_PROTOCOL_VERSION } from './model';
import { A2AHttpError, resolveA2AGrant, permits, type TaskGrant } from './principal';
import { buildAgentCard, NativeA2AHandler } from './handler';
import { Rpc, validateParams } from './validation';
import { ObservationLimiter } from './transport-limits';
const observations = new ObservationLimiter();

type RpcId = string | number | null;
const baseHeaders = () => new Headers({ 'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store', 'a2a-version': A2A_PROTOCOL_VERSION, 'x-content-type-options': 'nosniff' });
function response(body: unknown, headers: Headers, status = 200) { return new Response(JSON.stringify(body), { headers, status }); }
function sanitizeEnvelope<T>(envelope: T): T {
  if (envelope && typeof envelope === 'object' && 'error' in envelope) {
    const error = envelope.error;
    if (error && typeof error === 'object' && 'code' in error && error.code === -32603) {
      return { ...envelope, error: { code: -32603, message: 'Internal A2A service error.' } };
    }
  }
  return envelope;
}
function rpcError(id: RpcId, error: unknown) { return sanitizeEnvelope({ jsonrpc: '2.0', id, error: toJsonRpcError(error) }); }
async function readBody(req: Request) {
  if (Number(req.headers.get('content-length')) > A2A_LIMITS.bodyBytes) throw new A2AHttpError(413, 'Request body too large.');
  if (!req.body) return '';
  const reader = req.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > A2A_LIMITS.bodyBytes) { await reader.cancel(); throw new A2AHttpError(413, 'Request body too large.'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
export async function handleA2ACard(req: Request, endpointId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    const headers = baseHeaders();
    try {
      const { grant, rateHeaders } = await resolveA2AGrant(req, endpointId);
      rateHeaders.forEach((v, k) => headers.set(k, v));
      return response(AgentCard.toJSON(await buildAgentCard(grant)), headers);
    } catch (error) { return httpFailure(error, null, headers); }
  });
}
function httpFailure(error: unknown, id: RpcId, headers: Headers) {
  if (error instanceof A2AHttpError || error instanceof AgentApiError) {
    if (error.status === 429) headers.set('retry-after', '1');
    if (error.status === 401) headers.set('www-authenticate', 'Bearer realm="toolplane-a2a"');
    if (error instanceof AgentApiError && error.retryAfter) headers.set('retry-after', String(error.retryAfter));
    return response({ jsonrpc: '2.0', id, error: { code: -32000,
      message: error instanceof A2AHttpError ? error.message : 'Agent service request unavailable.' } }, headers, error.status);
  }
  return response(rpcError(id, error), headers);
}
export async function handleA2ARpc(req: Request, endpointId: string,
  resolve: (req: Request, id: string) => Promise<{ grant: TaskGrant; rateHeaders: Headers }> = resolveA2AGrant) {
  return withLogContext({ suppressPayload: true }, async () => {
    let id: RpcId = null; const headers = baseHeaders();
    let releaseObservation: (() => void) | undefined;
    try {
      const { grant, rateHeaders } = await resolve(req, endpointId);
      rateHeaders.forEach((v, k) => headers.set(k, v));
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new A2AHttpError(415, 'Content-Type must be application/json.');
      let raw: unknown;
      try { raw = JSON.parse(await readBody(req)); }
      catch (error) {
        if (error instanceof A2AHttpError) throw error;
        return response(rpcError(null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.PARSE_ERROR, message: 'Invalid JSON payload.' })), headers);
      }
      const parsed = Rpc.safeParse(raw);
      if (!parsed.success) return response(rpcError(null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST, message: 'Invalid JSON-RPC request.' })), headers);
      const rpc = parsed.data; id = rpc.id ?? null;
      const card = await buildAgentCard(grant);
      const requested = req.headers.get('a2a-version') ?? '';
      // Spec patch numbers do not participate in protocol negotiation.
      const version = /^\d+\.\d+(?:\.\d+)?$/.test(requested) ? requested.split('.').slice(0, 2).join('.') : requested || '0.3';
      validateVersion(version, card, 'JSONRPC');
      // JSON-RPC notifications cannot mutate tasks and do not receive RPC responses.
      if (rpc.id === undefined) return new Response(null, { status: 202, headers });
      const operation = rpc.method === 'SendMessage' || rpc.method === 'SendStreamingMessage' ? 'send'
        : rpc.method === 'CancelTask' ? 'cancel' : 'read';
      if (!permits(grant, operation)) throw new A2AHttpError(403, 'Required A2A permission is missing.');
      validateParams(rpc.method, rpc.params, card.defaultOutputModes);
      const credential = req.headers.get('authorization')?.replace(/^Bearer /i, '');
      if (credential && credential.length > 20 && JSON.stringify(rpc.params ?? {}).includes(credential)) {
        throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_PARAMS, message: 'Credentials must not be included in message content.' });
      }
      const immediate = (rpc.params as { configuration?: { returnImmediately?: boolean } } | undefined)?.configuration?.returnImmediately;
      if (rpc.method === 'SubscribeToTask' || rpc.method === 'SendStreamingMessage' || rpc.method === 'CancelTask'
        || (rpc.method === 'SendMessage' && !immediate)) releaseObservation = observations.acquire(grant.ownerKey);
      const subscription = new AbortController();
      const signal = AbortSignal.any([req.signal, subscription.signal]);
      const handler = new NativeA2AHandler(grant, card, signal);
      const result = await new JsonRpcTransportHandler(handler).handle(rpc, new ServerCallContext({ requestedVersion: version }));
      if (!(Symbol.asyncIterator in result)) {
        const quota = 'error' in result && result.error && typeof result.error === 'object'
          && 'code' in result.error && result.error.code === A2A_QUOTA_ERROR;
        if (quota) headers.set('retry-after', '60');
        return response(sanitizeEnvelope(result), headers, quota ? 429 : 200);
      }
      headers.set('content-type', 'text/event-stream'); headers.set('x-accel-buffering', 'no');
      const release = releaseObservation; releaseObservation = undefined;
      const iterator = result[Symbol.asyncIterator]();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let onAbort: (() => void) | undefined;
      const finish = () => { if (!closed) {
        closed = true; if (heartbeat) clearInterval(heartbeat);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        release?.();
      } };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            finish();
            void iterator.return?.().catch(() => undefined);
            try { controller.close(); } catch { /* The consumer may already have canceled. */ }
          };
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
          heartbeat = setInterval(() => {
            // Heartbeats must not create an unbounded queue for a slow subscriber.
            if (!closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }, 15_000);
        },
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const item = await iterator.next();
            if (closed) return;
            if (item.done) { finish(); controller.close(); return; }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(sanitizeEnvelope(item.value))}\n\n`));
          } catch (error) {
            if (closed) return;
            if (!signal.aborted) controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(rpcError(id, error))}\n\n`));
            finish(); try { controller.close(); } catch { /* Subscriber disconnected. */ }
          }
        },
        async cancel() {
          subscription.abort(); finish();
          try { await iterator.return?.(); } catch { /* Cancellation ends observation only. */ }
        },
      });
      return new Response(stream, { headers });
    } catch (error) { return httpFailure(error, id, headers); }
    finally { releaseObservation?.(); }
  });
}
