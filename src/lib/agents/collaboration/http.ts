import { CollaborationError } from './protocol';

export async function readCollaborationJson(req: Request, maxBytes = 65_536): Promise<unknown> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CollaborationError('content_type', 'Use application/json.', 415);
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new CollaborationError('too_large', 'Request too large.', 413);
  if (!req.body) throw new CollaborationError('invalid_json', 'Request body is required.');
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0; let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CollaborationError('too_large', 'Request too large.', 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    throw new CollaborationError('invalid_json', 'Malformed JSON.');
  } finally { reader.releaseLock(); }
}
export function collaborationJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
export function collaborationHttpError(error: unknown) {
  return error instanceof CollaborationError
    ? collaborationJson({ error: error.code, message: error.message }, error.status)
    : collaborationJson({ error: 'unavailable', message: 'Collaboration service is unavailable.' }, 503);
}
