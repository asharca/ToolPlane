// @vitest-environment node
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('releases nested timeout signals while preserving native cancellation and HTTP aborts', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--expose-gc', '--require', resolve('scripts/abort-signal.cjs'), '-e', String.raw`
    const assert = require('node:assert/strict');
    const { setTimeout: delay } = require('node:timers/promises');
    const { createServer } = require('node:http');
    const { once } = require('node:events');
    const { promisify } = require('node:util');
    (async () => {
      const owner = new AbortController();
      const references = [];
      function compose() {
        const inner = AbortSignal.any([owner.signal, AbortSignal.timeout(5)]);
        const outer = AbortSignal.any([inner, AbortSignal.timeout(5)]);
        outer.addEventListener('abort', () => {}, { once: true });
        references.push(new WeakRef(inner));
      }
      for (let i = 0; i < 1000; i++) compose();
      await delay(30);
      for (let i = 0; i < 10; i++) { global.gc(); await delay(10); }
      assert.equal(references.filter(ref => ref.deref()).length, 0, 'completed timeout composites must be collectible');
      assert.equal(owner.signal.aborted, false);

      const reason = new Error('owner lost');
      const nested = AbortSignal.any([AbortSignal.any([owner.signal]), AbortSignal.timeout(1000)]);
      let events = 0;
      nested.addEventListener('abort', () => { events++; });
      owner.abort(reason);
      assert.equal(nested.reason, reason);
      assert.equal(events, 1);
      assert.throws(() => nested.throwIfAborted(), error => error === reason);
      assert.equal(AbortSignal.any([AbortSignal.abort(reason), AbortSignal.abort('second')]).reason, reason);
      assert.equal(AbortSignal.any([]).aborted, false);
      assert.throws(() => AbortSignal.any([{}]), TypeError);

      const server = createServer((req, res) => {
        if (req.url === '/wait') return;
        res.writeHead(200); res.write('partial');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const controller = new AbortController();
        const response = await fetch('http://127.0.0.1:' + server.address().port, {
          signal: AbortSignal.any([AbortSignal.any([controller.signal]), AbortSignal.timeout(5000)]),
        });
        const body = response.text();
        controller.abort();
        await assert.rejects(body, { name: 'AbortError' });
        await assert.rejects(fetch('http://127.0.0.1:' + server.address().port + '/wait', {
          signal: AbortSignal.any([AbortSignal.any([AbortSignal.timeout(30)])]),
        }), { name: 'TimeoutError' });
      } finally {
        server.closeAllConnections();
        await promisify(server.close.bind(server))();
      }
      console.log('retained=0; owner, timeout, and HTTP cancellation passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
  ], { timeout: 15_000 });
  expect(stdout.trim()).toBe('retained=0; owner, timeout, and HTTP cancellation passed');
}, 20_000);
