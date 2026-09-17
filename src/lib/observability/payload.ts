export type PayloadPolicy = 'metadata-only' | 'diagnostic' | 'agent-content' | 'forbidden';
export const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

export async function boundedResponseText(response: Response): Promise<string | null> {
  if (!response.body || response.headers.get('content-type')?.includes('text/event-stream')) return null;
  const copy = response.clone();
  const reader = copy.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Diagnostic read timeout')), 200);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DIAGNOSTIC_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch { return null; }
  finally {
    if (timer) clearTimeout(timer);
    // Do not await tee cancellation: the actual response may not be consumed yet.
    void reader.cancel().catch(() => undefined);
  }
}
