// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
it('preserves affected old records, defaults actors to unbound, and enforces approval/receipt constraints', async () => {
  // Minimal prior shapes of the affected tables, isolated and always rolled back.
  // This validates these DDL changes, not the whole production upgrade or PostgreSQL concurrency.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `approval_migration_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE "User" (id text PRIMARY KEY);
      CREATE TABLE "WorkSession" (id text PRIMARY KEY, payload jsonb);
      CREATE TABLE "AgentChannelConnection" (id text PRIMARY KEY, payload jsonb);
      CREATE TABLE "A2AContext" (id text PRIMARY KEY);
      CREATE TABLE "A2ATask" (id text PRIMARY KEY, snapshot jsonb);
      INSERT INTO "User" VALUES ('human');
      INSERT INTO "WorkSession" VALUES ('work', '{"old":"work"}');
      INSERT INTO "AgentChannelConnection" VALUES ('channel', '{"old":"channel"}');
      INSERT INTO "A2AContext" VALUES ('context');
      INSERT INTO "A2ATask" VALUES ('task', '{"old":"artifact"}');`);
    for (const migration of ['20260923110000_a2a_tool_approvals', '20260923113000_a2a_entry_bindings']) {
      await client.query(readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    }
    for (const table of ['WorkSession', 'AgentChannelConnection']) {
      const row = (await client.query(`SELECT * FROM "${table}"`)).rows[0];
      expect(row.a2aActorId).toBeNull(); expect(row.payload.old).toBeTruthy();
    }
    expect((await client.query('SELECT snapshot,"approvalReadyLease" FROM "A2ATask"')).rows[0])
      .toEqual({ snapshot: { old: 'artifact' }, approvalReadyLease: null });
    await client.query(`INSERT INTO "A2AToolApproval" (id,"taskId","leaseToken","callId","toolName",input,"inputHash","expiresAt")
      VALUES ('approval','task','lease','call','bash','{}','hash',CURRENT_TIMESTAMP + interval '1 minute');
      INSERT INTO "A2AEntryBinding" (id,"ownerKey",kind,"sourceId","contextId","lastTaskId") VALUES ('binding','owner','work','work','context','task');
      INSERT INTO "A2AEntryReceipt" (id,"bindingId","messageId","inputHash","taskId") VALUES ('receipt','binding','message','digest','task');`);
    expect((await client.query('SELECT status FROM "A2AToolApproval"')).rows[0].status).toBe('pending');
    for (const [sql, code] of [
      ['UPDATE "A2AToolApproval" SET status=\'allow_forever\'', '23514'],
      ['UPDATE "A2AEntryBinding" SET kind=\'arbitrary_source\'', '23514'],
      ['UPDATE "WorkSession" SET "a2aActorId"=\'missing_user\'', '23503'],
      [`INSERT INTO "A2AEntryReceipt" (id,"bindingId","messageId","inputHash","taskId") VALUES ('duplicate','binding','message','digest','task')`, '23505'],
    ]) {
      await client.query('SAVEPOINT invalid_write');
      await expect(client.query(sql)).rejects.toMatchObject({ code });
      await client.query('ROLLBACK TO SAVEPOINT invalid_write');
    }
    await client.query(`UPDATE "WorkSession" SET "a2aActorId"='human'; DELETE FROM "User" WHERE id='human'`);
    expect((await client.query('SELECT "a2aActorId" FROM "WorkSession"')).rows[0].a2aActorId).toBeNull();
    await client.query(`DELETE FROM "A2ATask" WHERE id='task'`);
    for (const table of ['A2AToolApproval', 'A2AEntryBinding', 'A2AEntryReceipt']) {
      expect(Number((await client.query(`SELECT count(*) FROM "${table}"`)).rows[0].count)).toBe(0);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined); await client.end();
  }
});
