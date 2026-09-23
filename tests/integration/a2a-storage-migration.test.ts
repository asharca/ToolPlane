// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';

it('backfills payload bytes without changing existing native tasks, messages or events', async () => {
  // Dedicated temporary schema, never a production migration. DDL is rolled back on success and failure.
  const schema = `a2a_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE "A2ATask" (id text PRIMARY KEY, snapshot jsonb NOT NULL, request jsonb NOT NULL, "grant" jsonb NOT NULL)');
    await client.query('CREATE TABLE "A2AEvent" ("taskId" text, payload jsonb)');
    await client.query('CREATE TABLE "A2ARequest" ("taskId" text)');
    const snapshot = { id: 'task-old', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: '中文报告' }] }] };
    await client.query('INSERT INTO "A2ATask" VALUES ($1,$2,$3,$4)', ['task-old', snapshot, { message: { messageId: 'old-message' } }, { ownerKey: 'old-owner', revisionId: 'old-revision' }]);
    await client.query('INSERT INTO "A2AEvent" VALUES ($1,$2)', ['task-old', { task: snapshot }]);
    await client.query('INSERT INTO "A2ARequest" VALUES ($1)', ['task-old']);
    const migration = readFileSync('prisma/migrations/20260923050000_a2a_storage_accounting/migration.sql', 'utf8');
    await client.query(migration);
    const row = (await client.query('SELECT * FROM "A2ATask"')).rows[0];
    expect(row.snapshot).toEqual(snapshot); expect(row.request.message.messageId).toBe('old-message');
    expect(row.grant).toEqual({ ownerKey: 'old-owner', revisionId: 'old-revision' });
    expect(row.storageBytes).toBeGreaterThan(512);
    const expected = (await client.query('SELECT octet_length(snapshot::text) + octet_length(request::text) + octet_length("grant"::text) + (SELECT sum(octet_length(payload::text)) FROM "A2AEvent") + 512 AS bytes FROM "A2ATask"')).rows[0];
    expect(row.storageBytes).toBe(Number(expected.bytes));
    await client.query('INSERT INTO "A2ATask" (id,snapshot,request,"grant") VALUES ($1,$2,$3,$4)', ['new-task', {}, {}, {}]);
    expect((await client.query('SELECT "storageBytes" FROM "A2ATask" WHERE id=$1', ['new-task'])).rows[0].storageBytes).toBe(0);
    await client.query('SAVEPOINT invalid_bytes');
    await expect(client.query('UPDATE "A2ATask" SET "storageBytes"=-1')).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT invalid_bytes');
    expect(Number((await client.query('SELECT count(*) FROM "A2AEvent"')).rows[0].count)).toBe(1);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});
