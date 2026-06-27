// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { verifyApiToken, createApiToken } from '@/lib/auth/tokens';
import { reconcileAdminRole } from '@/lib/auth/admin';

const stamp = Date.now();
let activeToken = '';
let suspendedToken = '';

beforeAll(async () => {
  const active = await db.user.create({ data: { email: `act-${stamp}@t.dev`, passwordHash: 'x' } });
  const suspended = await db.user.create({
    data: { email: `sus-${stamp}@t.dev`, passwordHash: 'x', status: 'suspended' },
  });
  activeToken = (await createApiToken(active.id, 'a')).token;
  suspendedToken = (await createApiToken(suspended.id, 's')).token;
});

describe('verifyApiToken honors suspension', () => {
  it('accepts an active user token', async () => {
    const u = await verifyApiToken(`Bearer ${activeToken}`);
    expect(u?.email).toBe(`act-${stamp}@t.dev`);
  });
  it('rejects a suspended user token', async () => {
    expect(await verifyApiToken(`Bearer ${suspendedToken}`)).toBeNull();
  });
});

describe('reconcileAdminRole', () => {
  it('promotes an allowlisted email', async () => {
    const u = await db.user.create({ data: { email: `boss-${stamp}@t.dev`, passwordHash: 'x' } });
    process.env.ADMIN_EMAILS = `boss-${stamp}@t.dev`;
    await reconcileAdminRole(u);
    const after = await db.user.findUnique({ where: { id: u.id } });
    expect(after?.role).toBe('admin');
  });
  it('leaves a non-allowlisted user as user', async () => {
    const u = await db.user.create({ data: { email: `plain-${stamp}@t.dev`, passwordHash: 'x' } });
    process.env.ADMIN_EMAILS = `someone-else@t.dev`;
    await reconcileAdminRole(u);
    const after = await db.user.findUnique({ where: { id: u.id } });
    expect(after?.role).toBe('user');
  });
});
