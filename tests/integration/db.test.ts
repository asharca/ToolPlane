import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/db';

describe('db client', () => {
  afterAll(async () => { await db.$disconnect(); });

  it('connects and counts servers', async () => {
    const count = await db.server.count();
    expect(typeof count).toBe('number');
  });
});
