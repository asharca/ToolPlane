// @vitest-environment node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
it('preserves old tasks and enforces distinct remote targets and workspace foreign keys', async () => {
  const schema = `remote_migration_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE "Workspace" (id text PRIMARY KEY)');
    await client.query('CREATE TABLE "A2AContext" (id text PRIMARY KEY, "workspaceId" text NOT NULL, "targetKind" text NOT NULL, "agentId" text, "targetBinding" text, "endpointId" text, "revisionId" text, "clientId" text, "runtimeAllocationId" text)');
    await client.query('ALTER TABLE "A2AContext" ADD CONSTRAINT "A2AContext_target_shape" CHECK ("targetKind" IN (\'local\',\'published\'))');
    await client.query('CREATE TABLE "A2ATask" (id text PRIMARY KEY, phase text, snapshot jsonb, "storageBytes" bigint)');
    await client.query('INSERT INTO "Workspace" VALUES (\'workspace\'),(\'other\')');
    await client.query(`INSERT INTO "A2AContext" (id,"workspaceId","targetKind","endpointId","revisionId","clientId") VALUES ('existing','workspace','published','endpoint','revision','client')`);
    const snapshot = { id: 'old-task', status: { state: 'TASK_STATE_COMPLETED' }, metadata: { retained: true } };
    await client.query('INSERT INTO "A2ATask" VALUES ($1,$2,$3,$4)', ['old-task', 'done', snapshot, 777]);
    await client.query(readFileSync('prisma/migrations/20260923060000_a2a_remote_agents/migration.sql', 'utf8'));
    const old = (await client.query('SELECT * FROM "A2ATask"')).rows[0]; expect(old.snapshot).toEqual(snapshot); expect(Number(old.storageBytes)).toBe(777); expect(old.remotePollFailures).toBe(0);
    const original = (await client.query('SELECT * FROM "A2AContext" WHERE id=\'existing\'')).rows[0];
    expect(original).toMatchObject({ endpointId: 'endpoint', revisionId: 'revision', clientId: 'client', remoteAgentId: null });
    await client.query(`INSERT INTO "RemoteA2AAgent" (id,"workspaceId",name,"cardUrl","rpcUrl",card,"updatedAt") VALUES ('remote','workspace','Remote','https://remote.example/card','https://remote.example/rpc','{}',NOW())`);
    expect((await client.query('SELECT * FROM "RemoteA2AAgent"')).rows[0]).toMatchObject({ enabled: false, revision: 1, allowedAgentIds: [] });
    await client.query(`INSERT INTO "A2AContext" (id,"workspaceId","targetKind","targetBinding","remoteAgentId") VALUES ('remote-context','workspace','remote','binding','remote')`);
    await client.query('SAVEPOINT invalid');
    await expect(client.query(`INSERT INTO "A2AContext" (id,"workspaceId","targetKind","targetBinding","remoteAgentId") VALUES ('cross-workspace','other','remote','binding','remote')`)).rejects.toMatchObject({ code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT invalid');
    await expect(client.query(`UPDATE "A2AContext" SET "agentId"='fake-agent' WHERE id='remote-context'`)).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT invalid');
    await expect(client.query('UPDATE "A2ATask" SET "remotePollFailures"=-1')).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT invalid');
    await client.query(`DELETE FROM "RemoteA2AAgent" WHERE id='remote'`);
    expect(Number((await client.query('SELECT count(*) FROM "A2AContext"')).rows[0].count)).toBe(1);
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
});
