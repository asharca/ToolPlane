import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentHarness, BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createNodeSqliteFactory, SqliteSessionRepo } from '@earendil-works/pi-session-backend-sqlite-node';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv[2] === '--self-test') {
  await selfTest();
} else {

const [directory, mode, boundary = 'settled', replay = 'never'] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
const bindingPath = join(directory, 'binding.json');
const binding = mode === 'create' ? undefined : JSON.parse(readFileSync(bindingPath, 'utf8'));
const session = binding
  ? await repository.open(binding.metadata, context)
  : await repository.create({ id: 'recovery-context' }, context);
const operationId = binding?.operationId ?? session.idGenerator.next();
if (!binding) writeFileSync(bindingPath, JSON.stringify({ metadata: session.metadata, operationId }));
const pause = (event) => {
  process.send?.({ event, operationId, sessionId: session.metadata.id });
  return new Promise(() => { setInterval(() => {}, 1000); });
};
const faux = fauxProvider({ models: [{ id: 'recovery-model' }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([async (transcript) => {
  if (!transcript.messages.some((message) => message.role === 'toolResult')) {
    return fauxAssistantMessage(fauxToolCall('count', {}, { id: 'count-call' }));
  }
  if (mode === 'create' && boundary === 'settled') return pause('settled');
  return fauxAssistantMessage('RECOVERY_COMPLETE');
}, async () => {
  if (mode === 'create' && boundary === 'settled') return pause('settled');
  return fauxAssistantMessage('RECOVERY_COMPLETE');
}]);
const tools = [{
  name: 'count', label: 'Count', description: 'Record one externally observable effect.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  replay,
  async execute() {
    appendFileSync(join(directory, 'count.txt'), 'effect\n');
    if (mode === 'create' && boundary === 'pending') return pause('pending');
    return { content: [{ type: 'text', text: 'COUNTED' }], details: {} };
  },
}];
const { harness, open } = await AgentHarness.create({ session, models, model: faux.getModel(), tools, toolExecution: 'sequential' }, context);
const lane = await harness.lane('main', context);
let outcome = await lane.getResult(operationId, context);
if (!outcome) {
  const execution = await lane.inspectExecution(context);
  if (!execution.current) {
    if (mode !== 'create') throw new Error('Recovery lost the original operation');
    const accepted = await lane.accept({ kind: 'prompt', operationId, prompt: 'Call count exactly once, then finish.' }, context);
    if (!accepted.ok) throw accepted.error;
  } else if (execution.current.id !== operationId) {
    throw new Error('Recovery changed operation identity');
  }
  if (mode === 'cancel') {
    const aborted = await lane.requestAbort(operationId, context);
    if (!aborted.ok) throw aborted.error;
  }
  const driven = await lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, context);
  if (!driven.ok) throw driven.error;
  if (driven.value.kind !== 'settled') throw new Error('Operation did not settle');
  outcome = driven.value.outcome;
}
const watch = await lane.watch(context);
const observation = { event: 'result', operationId, sessionId: session.metadata.id, outcome, open, transcript: watch.snapshot.transcript };
watch.unsubscribe();
await harness.close(context);
await repository.close(context);
process.send?.(observation);
process.disconnect?.();
}

async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'toolplane-pi-proof-'));
  const children = new Set();
  function start(directory, mode, boundary, replay) {
    const child = fork(fileURLToPath(import.meta.url), [directory, mode, boundary, replay], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exited = once(child, 'exit');
    const observed = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`PI_RECOVERY_CHECK_FAILED: ${code ?? signal}: ${stderr}`)));
    });
    return { child, exited, observed };
  }
  try {
    for (const [boundary, replay, expected] of [['settled', 'never', 1], ['pending', 'safe', 2], ['pending', 'never', 1]]) {
      const directory = await mkdtemp(join(root, 'case-'));
      const first = start(directory, 'create', boundary, replay);
      const paused = await first.observed;
      assert.equal(paused.event, boundary);
      first.child.kill('SIGKILL');
      assert.equal((await first.exited)[1], 'SIGKILL');
      const resumed = start(directory, 'resume', boundary, replay);
      const result = await resumed.observed;
      assert.equal((await resumed.exited)[0], 0);
      assert.equal(result.operationId, paused.operationId);
      assert.equal(result.outcome.status, 'completed');
      assert.equal(readFileSync(join(directory, 'count.txt'), 'utf8').trim().split('\n').length, expected);
      if (boundary === 'pending' && replay === 'never') assert.match(JSON.stringify(result.transcript), /interrupt/i);
    }
    process.stdout.write('PI_HARNESS_RECOVERY_VERIFIED\n');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    await rm(root, { recursive: true, force: true });
  }
}
