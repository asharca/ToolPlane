import 'server-only';
export class RequestBodyError extends Error {
  constructor(public status: number) { super('Invalid request body.'); }
}
export async function readSandboxJson(req: Request, maxBytes = 16_384): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestBodyError(415);
  if (Number(req.headers.get('content-length')) > maxBytes) throw new RequestBodyError(413);
  const reader = req.body?.getReader();
  if (!reader) throw new RequestBodyError(400);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError(413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400);
  } finally { reader.releaseLock(); }
}
export const PRIVATE_HEADERS = { 'cache-control': 'private, no-store' };
export function privateJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}
