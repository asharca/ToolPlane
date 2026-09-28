import { createServer } from 'node:http';

export type ChatProviderFixture = {
  baseUrl: string;
  release: () => void;
  state: () => { calls: number; aborted: number; pending: number };
  close: () => Promise<void>;
};

/** Local OpenAI-compatible provider; generation pauses until release(), or the caller aborts. */
export async function chatProviderFixture(): Promise<ChatProviderFixture> {
  let calls = 0;
  let aborted = 0;
  const pending = new Set<() => void>();
  const release = () => { for (const finish of pending) finish(); };
  const server = createServer((req, res) => {
    if (req.url === '/state') { res.end(JSON.stringify({ calls, aborted, pending: pending.size })); return; }
    if (req.url === '/release') { release(); res.end('released'); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    req.resume();
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: object, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `chat-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'chat-background-fixture',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    chunk({ role: 'assistant', content: 'Before disconnect. ' });
    const finish = () => {
      pending.delete(finish);
      chunk({ content: 'Completed on server.' });
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
    };
    pending.add(finish);
    res.on('close', () => {
      if (pending.delete(finish)) aborted++;
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, release,
    state: () => ({ calls, aborted, pending: pending.size }),
    async close() {
      release();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}
