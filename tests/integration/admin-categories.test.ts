// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { listCategories, createCategory, deleteCategory } from '@/lib/admin/categories';

const stamp = Date.now();

describe('admin categories', () => {
  it('creates, lists, and deletes an empty category', async () => {
    const c = await createCategory(`cat-${stamp}`, `Cat ${stamp}`);
    const list = await listCategories();
    expect(list.some((x) => x.id === c.id)).toBe(true);
    await deleteCategory(c.id);
    expect(await db.category.findUnique({ where: { id: c.id } })).toBeNull();
  });

  it('refuses to delete a non-empty category', async () => {
    const c = await createCategory(`catx-${stamp}`, `CatX ${stamp}`);
    await db.skill.create({ data: { slug: `cs-${stamp}`, name: 'cs', categories: { connect: { id: c.id } } } });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
  });
});
