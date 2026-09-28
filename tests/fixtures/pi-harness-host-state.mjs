import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT, value, operationResult } from '@earendil-works/pi-agent-core';
import { createNodeSqliteFactory, SqliteSessionRepo } from '@earendil-works/pi-session-backend-sqlite-node';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const [action, directory, contextId, legacyStatePath, operationId] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
try {
  if (action === 'legacy' || action === 'long-legacy') {
    const manager = SessionManager.create(directory, join(directory, 'legacy-source'));
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    manager.appendMessage({ role: 'user', content: 'LEGACY_USER_ONCE', timestamp: 1 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'old-write', name: 'write', arguments: { path: join(directory, 'old-tool-must-not-run.txt'), content: 'UNSAFE_REPLAY' } }], api: 'openai-completions', provider: 'toolplane', model: 'controlled', usage, stopReason: 'toolUse', timestamp: 2 });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'old-write', toolName: 'write', content: [{ type: 'text', text: 'LEGACY_SETTLED_WRITE' }], isError: false, timestamp: 3 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'LEGACY_ASSISTANT_ONCE' }], api: 'openai-completions', provider: 'toolplane', model: 'controlled', usage, stopReason: 'stop', timestamp: 4 });
    if (action === 'long-legacy') for (let index = 0; index < 12; index++) {
      manager.appendMessage({ role: 'user', content: `HISTORY_${index} ` + 'retained conversation evidence '.repeat(400), timestamp: 5 + index * 2 });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `ANSWER_${index}` }], api: 'openai-completions', provider: 'toolplane', model: 'controlled', usage, stopReason: 'stop', timestamp: 6 + index * 2 });
    }
    await copyFile(manager.getSessionFile(), `${legacyStatePath}.jsonl`);
    process.stdout.write(JSON.stringify({ messages: manager.buildSessionContext().messages }) + '\n');
  } else {
    const metadata = (await repository.list(undefined, context)).find((entry) => entry.id === contextId);
    const session = action === 'reject-import' && !metadata
      ? await repository.create({ id: contextId }, context)
      : metadata ? await repository.open(metadata, context) : undefined;
    if (!session) throw new Error('Fixture cannot find the existing official Session');
    if (action === 'inspect') {
      const entries = await session.findEntries(undefined, context);
      const marker = await session.getValue(value('toolplane', 'legacy-import'), context);
      const branch = await session.branch('main', context);
      const main = branch ? await branch.findEntries(undefined, context) : [];
      const result = operationId ? await session.getValue(operationResult(operationId), context) : undefined;
      process.stdout.write(JSON.stringify({ metadata: session.metadata, entries, main, marker: marker ?? null, result }) + '\n');
      await session.close(context);
    } else if (action === 'reject-import' || action === 'allow-import') {
      const path = session.metadata.path;
      await session.close(context);
      const database = new DatabaseSync(path);
      try {
        if (action === 'reject-import') {
          database.exec("CREATE TRIGGER fixture_reject_import BEFORE INSERT ON scalar_values WHEN NEW.namespace = 'toolplane' AND NEW.key = 'legacy-import' BEGIN SELECT RAISE(ABORT, 'fixture rejects migration marker'); END");
        } else {
          database.exec('DROP TRIGGER fixture_reject_import');
        }
      } finally { database.close(); }
      process.stdout.write(JSON.stringify({ action }) + '\n');
    } else {
      throw new Error(`Unknown fixture action: ${action}`);
    }
  }
} finally {
  await repository.close(context);
}
