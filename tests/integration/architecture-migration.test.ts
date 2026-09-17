// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

// Execute the exact migration in a disposable transactional schema, not against
// an operator's working tables. CI provides an isolated PostgreSQL service.
describe('architecture hardening migration SQL', () => {
  it('preserves a legacy token, enforces new relations, and keeps reservation bytes within the Int range', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const schema = 'migration_' + randomUUID().replaceAll('-', '');
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "User" (id TEXT PRIMARY KEY);
        CREATE TABLE "Workspace" (id TEXT PRIMARY KEY);
        CREATE TABLE "Toolkit" (id TEXT PRIMARY KEY);
        CREATE TABLE "Agent" (id TEXT PRIMARY KEY);
        CREATE TABLE "ApiToken" (id TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL);
        INSERT INTO "User" VALUES ('user'); INSERT INTO "Workspace" VALUES ('workspace');
        INSERT INTO "Toolkit" VALUES ('toolkit'); INSERT INTO "Agent" VALUES ('agent');
        INSERT INTO "ApiToken" VALUES ('legacy', 'hash-only');
      `);
      await client.query(readFileSync(path.join(process.cwd(), 'prisma/migrations/20260917000000_architecture_hardening/migration.sql'), 'utf8'));
      expect((await client.query('SELECT * FROM "ApiToken" WHERE id = $1', ['legacy'])).rows[0]).toMatchObject({ tokenHash: 'hash-only', installationId: null, expiresAt: null });
      await client.query(`INSERT INTO "ToolkitInstallation" (id, "userId", "toolkitId", client, label, "updatedAt") VALUES ('device', 'user', 'toolkit', 'codex', 'test device', now())`);
      await client.query(`INSERT INTO "ApiToken" (id, "tokenHash", "installationId") VALUES ('registered', 'another-hash', 'device')`);
      await client.query(`INSERT INTO "AgentUploadReservation" (id, "workspaceId", "agentId", "runtimeId", "storagePath", "reservedBytes", "expiresAt") VALUES ('upload', 'workspace', 'agent', 'runtime', 'attachments/inbox/data', 2000000000, now())`);
      expect((await client.query('SELECT "reservedBytes" FROM "AgentUploadReservation"')).rows[0].reservedBytes).toBe(2_000_000_000);
      await client.query(`DELETE FROM "ToolkitInstallation" WHERE id='device'`);
      expect((await client.query('SELECT id FROM "ApiToken" ORDER BY id')).rows).toEqual([{ id: 'legacy' }]);
      await client.query(`DELETE FROM "Workspace" WHERE id='workspace'`);
      expect((await client.query('SELECT count(*)::int AS n FROM "AgentUploadReservation"')).rows[0].n).toBe(0);
    } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
  });
});
