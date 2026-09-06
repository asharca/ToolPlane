import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// The CLI stays alive between turns, like Cherry's SDK query. No model keys or database access.
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const socketPath = `/tmp/toolplane-runtime-${createHash('sha256').update(input.statePath).digest('hex').slice(0, 32)}.sock`;

if (process.argv[3] === 'serve') await serve();
else await request();

async function request() {
  let launched = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let connected = false;
      let restart = false;
      let output = '';
      socket.once('connect', () => { connected = true; socket.write(JSON.stringify(input) + '\n'); });
      socket.on('data', (data) => {
        output += data;
        let index;
        while ((index = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, index); output = output.slice(index + 1);
          if (JSON.parse(line).type === 'toolplane_session_restart') restart = true;
          else process.stdout.write(line + '\n');
        }
      });
      socket.once('error', (error) => {
        if (connected) reject(error);
        else if (error.code === 'ECONNREFUSED') void unlink(socketPath).catch(() => {}).then(() => resolve('missing'));
        else resolve('missing');
      });
      socket.once('end', () => resolve(restart ? 'restart' : 'done'));
      const abort = () => { socket.destroy(); process.exit(1); };
      process.once('SIGTERM', abort);
      socket.once('close', () => process.removeListener('SIGTERM', abort));
    });
    if (result === 'done') return;
    if (result === 'restart') { launched = false; await new Promise((resolve) => setTimeout(resolve, 100)); }
    if (!launched) {
      const child = spawn(process.execPath, [process.argv[1], inputPath, 'serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      launched = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Native runtime session did not start.');
}

async function serve() {
  const startedAt = Date.now();
  let child;
  let active;
  let init;
  let commands;
  let buffer = '';
  let stderr = '';
  let idle;
  let stopping = false;
  let state = await readFile(input.statePath, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return { id: randomUUID(), seeded: false };
  });
  const send = (event) => active?.write(JSON.stringify(event) + '\n');
  const fail = (text) => send({ type: 'toolplane_command_result', isError: true, text });
  const server = createServer((socket) => {
    let requestBuffer = '';
    socket.on('error', () => {});
    socket.on('data', async (data) => {
      requestBuffer += data;
      const newline = requestBuffer.indexOf('\n');
      if (newline < 0) return;
      socket.removeAllListeners('data');
      try {
        const job = JSON.parse(requestBuffer.slice(0, newline));
        if (active) { socket.end(JSON.stringify({ type: 'toolplane_command_result', isError: true, text: 'This native session is busy.' }) + '\n'); return; }
        active = socket;
        clearTimeout(idle);
        if (job.signature !== input.signature || Date.now() - startedAt > 20 * 60_000) { send({ type: 'toolplane_session_restart' }); await stop(); return; }
        if (!child) await start(job);
        if (init) send(init);
        if (commands) send(commands);
        const text = job.command || (state.seeded ? job.message : job.prompt);
        if (input.kind === 'pi') {
          const args = job.command?.match(/^\/compact(?:\s+([\s\S]*))?$/i);
          child.stdin.write(JSON.stringify(args ? { id: 'turn', type: 'compact', customInstructions: args[1] } : { id: 'turn', type: 'prompt', message: text }) + '\n');
        } else child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: state.id }) + '\n');
      } catch (error) { fail(error.message); await stop(); }
    });
    socket.on('close', () => { if (active === socket) void stop(); });
  });

  async function save() {
    await mkdir(dirname(input.statePath), { recursive: true });
    await writeFile(input.statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
    await rename(input.statePath + '.tmp', input.statePath);
  }

  async function start(job) {
    const args = [...input.args];
    if (input.kind === 'pi') {
      const sessionPath = input.statePath + '.jsonl';
      if (state.seeded && !existsSync(sessionPath) && job.history.length) throw new Error('Native session history is missing. Start a new conversation or restore the sandbox data.');
      if (!existsSync(sessionPath) && job.history.length) {
        const { SessionManager } = await import(pathToFileURL(`${input.packageRoot}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`).href);
        const manager = SessionManager.open(sessionPath, undefined, process.cwd());
        for (const message of job.history) manager.appendMessage(message.role === 'assistant'
          ? { role: 'assistant', content: [{ type: 'text', text: message.text }], api: input.api, provider: 'toolplane', model: input.model,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }
          : { role: 'user', content: message.text, timestamp: Date.now() });
        state.seeded = existsSync(sessionPath);
      }
      args.push('--session', sessionPath);
    } else {
      const sessionPath = `${process.env.CLAUDE_CONFIG_DIR}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${state.id}.jsonl`;
      if (state.seeded && !existsSync(sessionPath) && job.history.length) throw new Error('Native session history is missing. Start a new conversation or restore the sandbox data.');
      if (!existsSync(sessionPath) && job.history.length && !state.seeded) {
        // One-time import of pre-native history into the pinned CLI's resume format; subsequent writes are CLI-owned.
        await mkdir(dirname(sessionPath), { recursive: true });
        let parentUuid = null;
        const rows = job.history.map((message) => {
          const uuid = randomUUID();
          const row = { type: message.role === 'assistant' ? 'assistant' : 'user', parentUuid, uuid, sessionId: state.id, cwd: process.cwd(), version: '2.1.245', isSidechain: false, userType: 'external', timestamp: new Date().toISOString(),
            message: message.role === 'assistant' ? { role: 'assistant', content: [{ type: 'text', text: message.text }], model: input.model, id: randomUUID(), type: 'message', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
              : { role: 'user', content: message.text } };
          parentUuid = uuid;
          return JSON.stringify(row);
        });
        await writeFile(sessionPath, rows.join('\n') + '\n', { mode: 0o600 });
        state.seeded = true;
      }
      args.push(existsSync(sessionPath) ? '--resume' : '--session-id', state.id);
    }
    child = spawn(input.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'system' && event.subtype === 'init') init = event;
        if (event.type === 'system' && event.subtype === 'commands_changed') commands = event;
        if (input.kind === 'claude-code' && typeof event.session_id === 'string') state.id = event.session_id;
        send(event);
        if (input.kind === 'pi' && event.type === 'agent_end') setTimeout(() => child?.stdin.write(JSON.stringify({ type: 'get_state', id: 'settled' }) + '\n'), 50);
        if (input.kind === 'pi' && event.type === 'response' && event.id === 'settled' && (event.data?.isStreaming || event.data?.isCompacting || event.data?.isRetrying)) {
          setTimeout(() => child?.stdin.write(JSON.stringify({ type: 'get_state', id: 'settled' }) + '\n'), 50);
          continue;
        }
        const done = input.kind === 'pi' ? event.type === 'response' && (event.id === 'settled' || (event.id === 'turn' && (event.command !== 'prompt' || !event.success))) : event.type === 'result';
        if (done) {
          if (event.type === 'response' && event.command === 'compact') send({ type: 'toolplane_command_result', isError: !event.success, text: event.success ? 'Conversation compacted.' : event.error });
          else if (event.type === 'response' && !event.success) fail(event.error || 'Pi command failed.');
          const socket = active;
          state.seeded = true;
          void save().then(() => { if (active === socket) active = undefined; socket?.end(); idle = setTimeout(stop, 120_000); }, (error) => { fail(error.message); void stop(); });
        }
      }
    });
    child.once('error', (error) => { fail(error.message); void stop(); });
    child.once('exit', () => { if (!stopping) fail(stderr || 'Native runtime exited before completing the command.'); void stop(); });
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    active?.end(); active = undefined;
    server.close();
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  }
  server.on('error', (error) => { if (error.code === 'EADDRINUSE') process.exit(0); else throw error; });
  server.listen(socketPath, () => { void chmod(socketPath, 0o600); });
  process.on('SIGTERM', stop);
  // Runtime proxy tokens expire after 55 minutes; do not reuse a CLI beyond their lifetime.
  setTimeout(() => { if (!active) void stop(); }, 45 * 60_000).unref();
}
