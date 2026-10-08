import 'server-only';
import { A2A_QUOTA_ERROR } from './quotas';
import { AgentCard } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { toJsonRpcError, JsonRpcRequestMalformedError, A2A_ERROR_CODE } from '@a2a-js/sdk/errors';
import { enrichLogContext, getLogContext, newRequestId, withLogContext } from '@/lib/observability/context';
import { recordA2AEvent, a2aTaskOutcome, type A2ALogBinding, type A2ALogMetadata } from '@/lib/observability/a2a-log';
import { a2aLogMetadataSchema, logHealth, type LogOutcome } from '@/lib/observability/events';
import { sanitizeLog } from '@/lib/observability/redaction';
import { MAX_DIAGNOSTIC_BYTES } from '@/lib/observability/payload';
import { AgentApiError } from '@/lib/agents/public-api/errors';
import { A2A_LIMITS, A2A_PROTOCOL_VERSION } from './model';
import { A2AHttpError, resolveA2AGrant, permits, type TaskGrant } from './principal';
import { buildAgentCard, NativeA2AHandler } from './handler';
import { Rpc, validateParams } from './validation';
import { ObservationLimiter } from './transport-limits';
import { getTaskRow } from './store';
const observations = new ObservationLimiter();

type RpcId = string | number | null;
const rpcMethods: Record<string, true> = { SendMessage: true, SendStreamingMessage: true, GetTask: true, ListTasks: true,
  CancelTask: true, SubscribeToTask: true, CreateTaskPushNotificationConfig: true, GetTaskPushNotificationConfig: true,
  ListTaskPushNotificationConfigs: true, DeleteTaskPushNotificationConfig: true, GetExtendedAgentCard: true };
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function envelopeInfo(envelope: unknown, method: string) {
  const body = object(envelope);
  const error = object(body?.error);
  const result = object(body?.result);
  const task = method === 'SendMessage' || method === 'SendStreamingMessage' || method === 'SubscribeToTask'
    ? object(result?.task) : method === 'GetTask' || method === 'CancelTask' ? result : undefined;
  const update = method === 'SendStreamingMessage' || method === 'SubscribeToTask'
    ? object(result?.statusUpdate) ?? object(result?.artifactUpdate) : undefined;
  const state = a2aLogMetadataSchema.shape.taskState.safeParse(object(task?.status ?? update?.status)?.state);
  return {
    taskId: typeof task?.id === 'string' ? task.id : typeof update?.taskId === 'string' ? update.taskId : undefined,
    contextId: typeof task?.contextId === 'string' ? task.contextId : typeof update?.contextId === 'string' ? update.contextId : undefined,
    taskState: state.success ? state.data : undefined,
    rpcErrorCode: typeof error?.code === 'number' && Number.isSafeInteger(error.code) ? error.code : undefined,
    hasError: Boolean(error),
  };
}
function failureOutcome(error: unknown): LogOutcome | undefined {
  if ((error instanceof A2AHttpError || error instanceof AgentApiError) && (error.status === 401 || error.status === 403)) return 'denied';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return undefined;
}
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
    } catch (error) {
      const failure = httpFailure(error, null, headers);
      return response(failure.body, headers, failure.status);
    }
  });
}
function httpFailure(error: unknown, id: RpcId, headers: Headers) {
  if (error instanceof A2AHttpError || error instanceof AgentApiError) {
    if (error.status === 429) headers.set('retry-after', '1');
    if (error.status === 401) headers.set('www-authenticate', 'Bearer realm="toolplane-a2a"');
    if (error instanceof AgentApiError && error.retryAfter) headers.set('retry-after', String(error.retryAfter));
    return { body: { jsonrpc: '2.0', id, error: { code: -32000,
      message: error instanceof A2AHttpError ? error.message : 'Agent service request unavailable.' } }, status: error.status };
  }
  return { body: rpcError(id, error), status: 200 };
}
export async function handleA2ARpc(req: Request, endpointId: string,
  resolve: (req: Request, id: string) => Promise<{ grant: TaskGrant; rateHeaders: Headers }> = resolveA2AGrant) {
  return withLogContext({ suppressPayload: true }, async () => {
    const started = performance.now();
    const currentContext = getLogContext()!;
    const savedContext = { ...currentContext, requestId: currentContext.requestId ?? newRequestId(), secrets: [...(currentContext.secrets ?? [])] };
    enrichLogContext({ requestId: savedContext.requestId });
    const credential = req.headers.get('authorization')?.replace(/^Bearer /i, '');
    const secrets = [...savedContext.secrets, ...(credential ? [credential] : [])];
    let id: RpcId = null; const headers = baseHeaders();
    let binding: A2ALogBinding | undefined;
    let rpcMethod = 'unknown', requestPayload: unknown;
    let taskState: A2ALogMetadata['taskState'], rpcErrorCode: number | undefined;
    let rpcFailed = false, logged = false, truncated = false;
    let streamEventCount: number | undefined;
    let handlerError: unknown;
    let releaseObservation: (() => void) | undefined;
    const observeEnvelope = (body: unknown) => {
      try {
        const info = envelopeInfo(body, rpcMethod);
        if (binding && info.taskId) { binding.taskId = info.taskId; binding.contextId = info.contextId ?? binding.contextId; }
        if (info.taskState) taskState = info.taskState;
        if (info.rpcErrorCode !== undefined) rpcErrorCode = info.rpcErrorCode;
        rpcFailed ||= info.hasError;
      } catch { logHealth.failures += 1; }
    };
    const logFinish = async (kind: 'json' | 'sse' | 'none', body: unknown, status: number, complete: boolean,
      error?: unknown, forcedOutcome?: LogOutcome) => {
      if (logged) return;
      logged = true;
      const durationMs = performance.now() - started;
      try {
        if (kind === 'json') observeEnvelope(body);
        const outcome = status === 401 || status === 403 ? 'denied' : forcedOutcome ?? failureOutcome(error)
          ?? (status >= 400 || rpcFailed ? 'error' : a2aTaskOutcome(taskState));
        if (binding?.taskId) {
          try {
            const row = await getTaskRow(binding.grant, binding.taskId);
            binding.contextId = row.contextId;
            binding.rootTaskId = row.rootTaskId ?? row.id;
            binding.parentTaskId = row.parentTaskId ?? undefined;
          } catch { /* The authorized response still identifies its task even if its row has expired. */ }
        }
        if (kind === 'sse' && binding && outcome !== 'denied') {
          const safe = sanitizeLog({ workspaceMcpPayload: false, payload: {
            request: requestPayload, response: body, responseKind: kind, responseComplete: complete && !truncated,
          } }, secrets, MAX_DIAGNOSTIC_BYTES, 16);
          truncated ||= safe.truncated;
          const payload = object(object(safe.data)?.payload);
          requestPayload = payload?.request;
          body = payload?.response;
        }
        await withLogContext(savedContext, () => recordA2AEvent({ eventName: 'a2a.request', binding,
          metadata: { direction: 'inbound', transport: 'jsonrpc', taskState, rpcErrorCode, streamEventCount },
          rpcMethod, method: req.method, httpStatus: status, outcome, durationMs,
          ...(binding && outcome !== 'denied' ? { request: requestPayload, response: body,
            responseKind: kind, responseComplete: complete && !truncated, truncated } : {}), secrets,
        }), true);
      } catch { logHealth.failures += 1; }
    };
    const reply = async (body: unknown, status = 200, error?: unknown) => {
      await logFinish(body === undefined ? 'none' : 'json', body, status, true, error);
      return body === undefined ? new Response(null, { status, headers }) : response(body, headers, status);
    };
    try {
      const { grant, rateHeaders } = await resolve(req, endpointId);
      binding = { grant };
      enrichLogContext({ workspaceId: grant.workspaceId, ...('kind' in grant ? {
        actorId: grant.actorId, agentId: grant.kind === 'local' ? grant.agentId : grant.sourceAgentId,
      } : {}) });
      rateHeaders.forEach((v, k) => headers.set(k, v));
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new A2AHttpError(415, 'Content-Type must be application/json.');
      let raw: unknown, text: string | undefined;
      try { text = await readBody(req); raw = JSON.parse(text); requestPayload = raw; }
      catch (error) {
        if (error instanceof A2AHttpError) throw error;
        if (text !== undefined) requestPayload = { rawText: text };
        return reply(rpcError(null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.PARSE_ERROR, message: 'Invalid JSON payload.' })), 200, error);
      }
      const parsed = Rpc.safeParse(raw);
      if (!parsed.success) return reply(rpcError(null, new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST, message: 'Invalid JSON-RPC request.' })));
      const rpc = parsed.data; id = rpc.id ?? null;
      rpcMethod = Object.hasOwn(rpcMethods, rpc.method) ? rpc.method : 'unknown';
      const card = await buildAgentCard(grant);
      const requested = req.headers.get('a2a-version') ?? '';
      // Spec patch numbers do not participate in protocol negotiation.
      const version = /^\d+\.\d+(?:\.\d+)?$/.test(requested) ? requested.split('.').slice(0, 2).join('.') : requested || '0.3';
      validateVersion(version, card, 'JSONRPC');
      // JSON-RPC notifications cannot mutate tasks and do not receive RPC responses.
      if (rpc.id === undefined) return reply(undefined, 202);
      const operation = rpc.method === 'SendMessage' || rpc.method === 'SendStreamingMessage' ? 'send'
        : rpc.method === 'CancelTask' ? 'cancel' : 'read';
      if (!permits(grant, operation)) throw new A2AHttpError(403, 'Required A2A permission is missing.');
      validateParams(rpc.method, rpc.params, card.defaultOutputModes);
      if (credential && credential.length > 20 && JSON.stringify(rpc.params ?? {}).includes(credential)) {
        throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_PARAMS, message: 'Credentials must not be included in message content.' });
      }
      const immediate = (rpc.params as { configuration?: { returnImmediately?: boolean } } | undefined)?.configuration?.returnImmediately;
      if (rpc.method === 'SubscribeToTask' || rpc.method === 'SendStreamingMessage' || rpc.method === 'CancelTask'
        || (rpc.method === 'SendMessage' && !immediate)) releaseObservation = observations.acquire(grant.ownerKey);
      const subscription = new AbortController();
      const signal = AbortSignal.any([req.signal, subscription.signal]);
      // Observe original errors before the SDK maps them to RPC errors; never change its wire response.
      const handler = new Proxy(new NativeA2AHandler(grant, card, signal), {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            try {
              const result = Reflect.apply(value, target, args);
              return result instanceof Promise ? result.catch((error: unknown) => { handlerError = error; throw error; }) : result;
            } catch (error) { handlerError = error; throw error; }
          };
        },
      });
      const result = await new JsonRpcTransportHandler(handler).handle(rpc, new ServerCallContext({ requestedVersion: version }));
      if (!(Symbol.asyncIterator in result)) {
        const quota = 'error' in result && result.error && typeof result.error === 'object'
          && 'code' in result.error && result.error.code === A2A_QUOTA_ERROR;
        if (quota) headers.set('retry-after', '60');
        return reply(sanitizeEnvelope(result), quota ? 429 : 200, handlerError);
      }
      headers.set('content-type', 'text/event-stream'); headers.set('x-accel-buffering', 'no');
      const release = releaseObservation; releaseObservation = undefined;
      const iterator = result[Symbol.asyncIterator]();
      const events: unknown[] = [];
      let streamBytes = MAX_DIAGNOSTIC_BYTES, collectionStopped = false;
      streamEventCount = 0;
      try {
        const safe = sanitizeLog(requestPayload, secrets, MAX_DIAGNOSTIC_BYTES - 512, 16);
        requestPayload = safe.data; truncated ||= safe.truncated;
        streamBytes = Buffer.byteLength(JSON.stringify({ workspaceMcpPayload: false, payload: {
          request: requestPayload, response: { events }, responseKind: 'sse', responseComplete: false,
        } }));
      } catch { truncated = true; collectionStopped = true; logHealth.failures += 1; }
      const collect = (envelope: unknown) => {
        streamEventCount! += 1;
        observeEnvelope(envelope);
        if (collectionStopped) return;
        try {
          const remaining = MAX_DIAGNOSTIC_BYTES - streamBytes - (events.length ? 1 : 0);
          if (remaining < 64 || events.length >= 100) { truncated = true; collectionStopped = true; return; }
          const safe = sanitizeLog(envelope, secrets, remaining, 16);
          streamBytes += Buffer.byteLength(JSON.stringify(safe.data)) + (events.length ? 1 : 0);
          events.push(safe.data);
          if (safe.truncated) { truncated = true; collectionStopped = true; }
        } catch { truncated = true; collectionStopped = true; logHealth.failures += 1; }
      };
      let heartbeat: NodeJS.Timeout | undefined;
      let closed = false;
      let onAbort: (() => void) | undefined;
      const finish = async (complete: boolean, error?: unknown, outcome?: LogOutcome) => {
        if (closed) return;
        closed = true; clearInterval(heartbeat);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        release?.();
        await logFinish('sse', { events }, 200, complete, error, outcome);
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            void finish(false, signal.reason, failureOutcome(signal.reason) ?? 'cancelled');
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
            if (item.done) { await finish(true); controller.close(); return; }
            const envelope = sanitizeEnvelope(item.value);
            collect(envelope);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
          } catch (error) {
            if (closed) return;
            if (!signal.aborted) {
              const envelope = rpcError(id, error);
              collect(envelope);
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(envelope)}\n\n`));
            }
            await finish(false, error, signal.aborted ? failureOutcome(signal.reason) ?? 'cancelled' : undefined);
            try { controller.close(); } catch { /* Subscriber disconnected. */ }
          }
        },
        async cancel() {
          const logging = finish(false, undefined, 'cancelled');
          subscription.abort();
          await logging;
          try { await iterator.return?.(); } catch { /* Cancellation ends observation only. */ }
        },
      });
      return new Response(stream, { headers });
    } catch (error) {
      const failure = httpFailure(error, id, headers);
      return reply(failure.body, failure.status, error);
    }
    finally { releaseObservation?.(); }
  });
}
