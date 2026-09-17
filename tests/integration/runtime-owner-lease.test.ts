// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeOwnerLease } from '@/lib/runtime/owner';
import { db } from '@/lib/db';
// PGlite multiplexes a single backend; it cannot validate session lock ownership.
describe.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('runtime ownership against separate real PostgreSQL sessions', () => {
  it('admits only one session, and releases the lock and clean marker together', async () => {
    const domain = 'owner-fixture-' + randomUUID();
    const first = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL }), domain);
    const second = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL }), domain);
    const third = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL }), domain);
    try {
      await first.acquire(); await expect(second.acquire()).rejects.toThrow('Another ToolPlane'); await second.release(false);
      await first.release(true); await third.acquire(); await third.release(true);
      expect(await db.systemSetting.findUnique({ where: { key: first.markerKey } })).toBeNull();
    } finally { await Promise.all([first.release(false), second.release(false), third.release(false)]); await db.systemSetting.deleteMany({ where: { key: first.markerKey } }); }
  });
  it('a killed owner connection signals loss and requires explicit recovery acknowledgement', async () => {
    const domain = 'owner-fixture-' + randomUUID(); const lost = vi.fn();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const first = new RuntimeOwnerLease(client, domain, undefined, lost);
    const refused = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL }), domain);
    const replacement = new RuntimeOwnerLease(new Client({ connectionString: process.env.DATABASE_URL }), domain, first.id);
    try {
      await first.acquire(); const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`; await vi.waitFor(() => expect(lost).toHaveBeenCalled());
      await first.release(false); await expect(refused.acquire()).rejects.toThrow('Unclean runtime shutdown'); await refused.release(false);
      await replacement.acquire(); await replacement.release(true);
    } finally { await Promise.all([first.release(false), refused.release(false), replacement.release(false)]); await db.systemSetting.deleteMany({ where: { key: first.markerKey } }); }
  });
});
