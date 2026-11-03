import { createServer } from 'node:http';

export type ChatProviderFixture = {
  baseUrl: string;
  release: () => void;
  pauseNextResponse: () => () => void;
  state: () => { calls: number; aborted: number; pending: number };
  models: () => readonly string[];
  close: () => Promise<void>;
};

/** Local OpenAI-compatible provider; generation pauses until release(), or the caller aborts. */
export async function chatProviderFixture(): Promise<ChatProviderFixture> {
  let calls = 0;
  let aborted = 0;
  const models: string[] = [];
  const pending = new Set<() => void>();
  let nextFirstOutput: Promise<void> | undefined;
  const release = () => { for (const finish of pending) finish(); };
  const server = createServer((req, res) => {
    if (req.url === '/state') { res.end(JSON.stringify({ calls, aborted, pending: pending.size })); return; }
    if (req.url === '/release') { release(); res.end('released'); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => body.push(chunk));
    req.on('end', () => { models.push(JSON.parse(Buffer.concat(body).toString()).model); });
    calls++;
    const firstOutput = nextFirstOutput;
    nextFirstOutput = undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const chunk = (delta: object, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `chat-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'chat-background-fixture',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    let started = false;
    const start = () => {
      if (started || res.destroyed) return;
      started = true;
      chunk({ role: 'assistant', content: 'Before disconnect. ' });
    };
    if (firstOutput) void firstOutput.then(start);
    else start();
    const finish = () => {
      pending.delete(finish);
      start();
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
    pauseNextResponse() {
      const gate = Promise.withResolvers<void>();
      nextFirstOutput = gate.promise;
      return gate.resolve;
    },
    state: () => ({ calls, aborted, pending: pending.size }),
    models: () => models,
    async close() {
      release();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}
