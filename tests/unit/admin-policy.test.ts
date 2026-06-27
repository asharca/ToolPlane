// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { adminEmails, isAdminEmail, adminGate, activeUserOrNull } from '@/lib/auth/admin-policy';

const orig = process.env.ADMIN_EMAILS;
afterEach(() => { process.env.ADMIN_EMAILS = orig; });

describe('adminEmails / isAdminEmail', () => {
  it('parses a comma list, trims and lowercases', () => {
    process.env.ADMIN_EMAILS = ' Alice@Example.com , bob@x.io ';
    expect(adminEmails()).toEqual(new Set(['alice@example.com', 'bob@x.io']));
    expect(isAdminEmail('ALICE@example.com')).toBe(true);
    expect(isAdminEmail('carol@x.io')).toBe(false);
  });
  it('is empty when unset', () => {
    delete process.env.ADMIN_EMAILS;
    expect(adminEmails().size).toBe(0);
    expect(isAdminEmail('a@b.c')).toBe(false);
  });
});

describe('adminGate', () => {
  it('returns login for no user', () => expect(adminGate(null)).toBe('login'));
  it('returns forbidden for non-admin', () => expect(adminGate({ role: 'user' })).toBe('forbidden'));
  it('returns ok for admin', () => expect(adminGate({ role: 'admin' })).toBe('ok'));
});

describe('activeUserOrNull', () => {
  it('drops suspended users', () => expect(activeUserOrNull({ id: '1', status: 'suspended' })).toBeNull());
  it('keeps active users', () => {
    const u = { id: '1', status: 'active' };
    expect(activeUserOrNull(u)).toBe(u);
  });
  it('passes through null', () => expect(activeUserOrNull(null)).toBeNull());
});
